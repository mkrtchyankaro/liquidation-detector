import "dotenv/config";
import { loadEnv } from "./config/env";
import { loadAppConfig, type UserConfig } from "./config/users-config";
import { loadBinanceConfig } from "./infrastructure/config/binance.config";
import { BinanceRestClient } from "./infrastructure/binance/binanceRest.client";
import { TelegramClient } from "./infrastructure/telegram/telegram.client";
import { Mongo } from "./infrastructure/mongo/mongo";
import { RawLiquidationEventRepository } from "./infrastructure/mongo/raw-liquidation-event.repository";
import { OiSecondObservationRepository } from "./infrastructure/mongo/oi-second-observation.repository";
import { childLogger } from "./infrastructure/logging/logger";
import { MarketCollector } from "./collector/market-collector";
import { ContextCollector } from "./collector/context-collector";
import {
  ensureMinuteBarIndexes,
  MinuteBarWriter,
} from "./collector/minute-bars";
import { checkRealReadiness } from "./execution/readiness";
import {
  mongoMinuteLoader,
  OaPaperService,
  type OaUserRef,
} from "./strategy/oa/oa-paper.service";
import {
  mongoV10Loader,
  V10LiveService,
  type V10UserRef,
} from "./strategy/v10/v10-live.service";
import { V10BookRecorder } from "./strategy/v10/v10-book";
import { BinanceMongoWallSource } from "./strategy/v10/wall-data";
import { V10ZoneFinder } from "./strategy/v10/v10-zone";
import { V10Repository } from "./strategy/v10/v10-repository";
import { V11LiveService, type V11UserRef } from "./strategy/v11/v11-live.service";
import { BinanceMongoV11Source } from "./strategy/v11/v11-data";
import { V11Repository } from "./strategy/v11/v11-repository";
import { mongoMinBarLoader } from "./strategy/shared/minute-loader";

const log = childLogger({ mod: "main" });

/**
 * liquidation-detector -- V10 + V11 bot (Oct 12 2026: V9 was removed).
 *
 *   MarketCollector   Binance liquidations + OI (1/s) -> MongoDB
 *   ContextCollector  long/short ratios (5m) + funding/premium (1m) -> MongoDB (research only)
 *   OaPaperService    OI-accumulation strategy (1h), PAPER only: Telegram messages to the "oa" users, never orders
 *   MinuteBarWriter   1 row per symbol per minute (price, OI, liquidations), kept 365 days (research only)
 *   V10LiveService    every 15m candle: BTC top / bottom (DC + OI rule, RANK 1) -> the alts that moved most with BTC
 *                     -> PAPER / REAL trades with fixed % SL / TP (own settings "v10", own collections)
 *   V11LiveService    every 1h candle: rally -> short-liquidation wick -> OI confirmation (squeeze wick)
 *                     -> PAPER / REAL trades, SL = the wick's high, TP = R x risk (own settings "v11", own collections)
 *
 * Who trades what is decided ONLY by users.config.json.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadAppConfig(env.usersConfigPath, env.symbols);
  const users = config.users.filter((u) => u.enabled);
  log.info(
    `config: symbols=${env.symbols.join(",")} users=${users.map((u) => u.userId).join(",")} realOrdersEnabled=${config.realOrdersEnabled}`,
  );

  const mongo = new Mongo(env.mongoUri, env.mongoDb);
  await mongo.connect();
  const liqRepo = new RawLiquidationEventRepository(mongo.db);
  const oiRepo = new OiSecondObservationRepository(mongo.db);
  await liqRepo.ensureIndexes();
  await oiRepo.ensureIndexes();

  const telegramOf = (u: UserConfig): TelegramClient | null =>
    u.telegram
      ? new TelegramClient({
          enabled: true,
          botToken: u.telegram.botToken,
          chatIds: u.telegram.chatIds,
          parseMode: "none",
          disableNotification: false,
        })
      : null;
  const restOf = (u: UserConfig): BinanceRestClient | null =>
    u.binance
      ? new BinanceRestClient({
          restBaseUrl: "https://fapi.binance.com",
          wsBaseUrl: "wss://fstream.binance.com",
          apiKey: u.binance.apiKey,
          apiSecret: u.binance.apiSecret,
          testnet: false,
          recvWindowMs: 5_000,
        })
      : null;

  if (config.legacyBlocks.length)
    log.warn(
      `[LEGACY_CONFIG_IGNORED] users.config.json still has ${config.legacyBlocks.map((b) => `"${b}"`).join(", ")} -- V9 / ZZ were removed, the block is ignored (it can be deleted)`,
    );

  // ── REAL only if every gate agrees AND the account proves it can trade (checked once per user, shared by V10 / V11) ──
  const readiness = new Map<
    string,
    Promise<{ mode: "PAPER" | "REAL"; rest: BinanceRestClient | null }>
  >();
  const resolveMode = (
    u: UserConfig,
    requested: "PAPER" | "REAL",
    strategy: string,
  ): Promise<{ mode: "PAPER" | "REAL"; rest: BinanceRestClient | null }> => {
    if (requested === "PAPER")
      return Promise.resolve({ mode: "PAPER", rest: null });
    const cached = readiness.get(u.userId);
    if (cached) return cached;
    const p = (async () => {
      const rest = restOf(u);
      const why = !config.realOrdersEnabled
        ? "realOrdersEnabled=false"
        : rest === null
          ? "binance.enabled is not true"
          : null;
      if (why) {
        log.error(
          `[REAL_DOWNGRADED] userId=${u.userId} (${strategy}) ${why} -- runs PAPER`,
        );
        return { mode: "PAPER" as const, rest: null };
      }
      const ready = await checkRealReadiness(u.userId, rest!);
      if (ready.ok) return { mode: "REAL" as const, rest };
      log.error(
        `[REAL_NOT_READY] userId=${u.userId} ${ready.reason} -- runs PAPER until restart`,
      );
      await telegramOf(u)
        ?.sendMessage(
          `⚠️ REAL trading NOT active for ${u.userId}\nReason: ${ready.reason}\nYou will receive PAPER signals until this is fixed and the bot is restarted.`,
        )
        .catch(() => undefined);
      return { mode: "PAPER" as const, rest: null };
    })();
    readiness.set(u.userId, p);
    return p;
  };

  // ── V10 users (same REAL gates) ──
  // OFF users with Binance keys are listed too (mode OFF: no new trades) so a REAL V10 trade they still have open keeps
  // being watched and settled after the user was switched off.
  const v10Users: V10UserRef[] = [];
  for (const u of users) {
    const requested = config.v10.enabled
      ? (config.v10.userModes.get(u.userId) ?? "OFF")
      : "OFF";
    if (requested === "OFF" && !u.binance) continue;
    const { mode, rest } =
      requested === "OFF"
        ? { mode: "OFF" as const, rest: null }
        : await resolveMode(u, requested, "V10");
    v10Users.push({
      userId: u.userId,
      mode,
      riskUsd: u.riskUsd,
      binanceRest: mode === "REAL" ? rest : null,
      monitorRest: rest ?? restOf(u),
      leverage: u.binance?.leverage,
      marginMode: u.binance?.marginMode,
      telegram: telegramOf(u),
    });
  }
  log.warn(
    `[V10_USER_MODE] enabled=${config.v10.enabled} ${v10Users.map((u) => `${u.userId}=${u.mode}($${u.riskUsd})`).join(" ") || "(no users)"}`,
  );

  // ── V11 users (same REAL gates, same rule: OFF users with Binance keys are listed to watch their open REAL trades) ──
  const v11Users: V11UserRef[] = [];
  for (const u of users) {
    const requested = config.v11.enabled
      ? (config.v11.userModes.get(u.userId) ?? "OFF")
      : "OFF";
    if (requested === "OFF" && !u.binance) continue;
    const { mode, rest } =
      requested === "OFF"
        ? { mode: "OFF" as const, rest: null }
        : await resolveMode(u, requested, "V11");
    v11Users.push({
      userId: u.userId,
      mode,
      riskUsd: u.riskUsd,
      binanceRest: mode === "REAL" ? rest : null,
      monitorRest: rest ?? restOf(u),
      leverage: u.binance?.leverage,
      marginMode: u.binance?.marginMode,
      telegram: telegramOf(u),
    });
  }
  log.warn(
    `[V11_USER_MODE] enabled=${config.v11.enabled} ${v11Users.map((u) => `${u.userId}=${u.mode}($${config.v11.perUser.get(u.userId)?.riskUsd ?? config.v11.riskUsd ?? u.riskUsd})`).join(" ") || "(no users)"}`,
  );

  // System alerts (e.g. feed silent) go to every user with Telegram.
  const alertAll = async (text: string): Promise<void> => {
    await Promise.all(
      users.map((u) =>
        telegramOf(u)
          ?.sendMessage(text)
          .catch(() => undefined),
      ),
    );
  };

  const collector = new MarketCollector(
    env.symbols,
    loadBinanceConfig(),
    liqRepo,
    oiRepo,
    alertAll,
  );
  collector.start();
  // Research context (long/short ratios, funding/premium) -- never affects trading.
  const context = new ContextCollector(env.symbols, mongo.db);
  await context.ensureIndexes();
  context.start();
  // Long-term minute history (price, OI, liquidations) for episode research.
  await ensureMinuteBarIndexes(mongo.db);
  const minuteBars = new MinuteBarWriter(env.symbols, mongo.db);
  minuteBars.start();

  // OI-accumulation strategy (1h): PAPER only (never places orders).
  const oaUsers: OaUserRef[] = config.oa.users
    .map((id) => users.find((u) => u.userId === id))
    .filter((u): u is UserConfig => !!u)
    .map((u) => ({
      userId: u.userId,
      riskUsd: u.riskUsd,
      telegram: telegramOf(u),
    }));
  const oa = config.oa.enabled
    ? new OaPaperService(
        config.oa,
        () => oaUsers,
        mongoMinuteLoader(mongo.db),
        mongo.db,
      )
    : null;
  if (oa)
    void oa
      .start()
      .catch((err) =>
        log.error(
          `[OA_START_FAILED] ${err instanceof Error ? err.message : String(err)} -- OA PAPER not running, V10 / V11 unaffected`,
        ),
      );

  // BTC-led alts: own settings, collections, messages; its failure never stops V11.
  // V10 disabled but users with Binance keys -> it still runs to WATCH any REAL V10 trade left open (no new signals).
  const v10 =
    config.v10.enabled || v10Users.length > 0
      ? new V10LiveService(
          config.v10,
          () => v10Users,
          mongoV10Loader(mongo.db),
          new V10Repository(mongo.db),
          Date.now,
          new V10BookRecorder(mongo.db),
          new V10ZoneFinder(),
          new BinanceMongoWallSource(mongo.db),
        )
      : null;
  if (v10)
    void v10
      .start()
      .catch((err) =>
        log.error(
          `[V10_START_FAILED] ${err instanceof Error ? err.message : String(err)} -- V10 not running, V11 unaffected`,
        ),
      );

  // Squeeze wick (1h): own settings, collections, messages; its failure never stops V10.
  // V11 disabled but users with Binance keys -> it still runs to WATCH any REAL V11 trade left open (no new signals).
  const v11 =
    config.v11.enabled || v11Users.length > 0
      ? new V11LiveService(
          config.v11,
          () => v11Users,
          new BinanceMongoV11Source(mongo.db),
          mongoMinBarLoader(mongo.db),
          new V11Repository(mongo.db),
        )
      : null;
  if (v11)
    void v11
      .start()
      .catch((err) =>
        log.error(
          `[V11_START_FAILED] ${err instanceof Error ? err.message : String(err)} -- V11 not running, V10 unaffected`,
        ),
      );

  // V9 was removed (Oct 12 2026): a REAL V9 trade still open would no longer be watched by the bot -> say it loudly.
  void (async () => {
    const db = await mongo.db();
    const n = db ? await db.collection("v9_trades").countDocuments({ state: "OPEN", mode: "REAL" }) : 0;
    if (n > 0) {
      log.error(`[V9_REAL_TRADES_LEFT_OPEN] ${n} REAL V9 trade(s) are still OPEN in v9_trades -- V9 was removed, nobody watches them: check them on Binance`);
      await alertAll(`⚠️ ${n} REAL V9 trade(s) are still marked OPEN. V9 was removed from the bot -- please check them on Binance by hand.`);
    }
  })().catch(() => undefined);

  setInterval(() => {
    const m = process.memoryUsage();
    log.info(
      {
        rssMb: Math.round(m.rss / 1048576),
        heapUsedMb: Math.round(m.heapUsed / 1048576),
      },
      "[MEMORY_USAGE]",
    );
  }, 5 * 60_000).unref();

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`shutting down (${signal})`);
    v11?.stop();
    oa?.stop();
    v10?.stop();
    context.stop();
    minuteBars.stop();
    await collector.stop();
    await mongo.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  log.info("liquidation-detector (V10 + V11) started");
}

main().catch((err) => {
  log.fatal(
    { err: err instanceof Error ? err.stack : String(err) },
    "startup failed",
  );
  process.exit(1);
});
