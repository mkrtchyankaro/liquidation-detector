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
import { checkRealReadiness } from "./execution/readiness";
import { V9LiveService, type V9UserRef } from "./strategy/v9/v9-live.service";
import { V9MongoFeed } from "./strategy/v9/v9-feed";
import { DEFAULT_V9_ENGINE_SETTINGS } from "./strategy/v9/v9-causal-engine";
import { V9Repository } from "./strategy/v9/v9-repository";

const log = childLogger({ mod: "main" });

/**
 * liquidation-detector -- V9 bot.
 *
 *   MarketCollector   Binance liquidations + OI (1/s) -> MongoDB
 *   ContextCollector  long/short ratios (5m) + funding/premium (1m) -> MongoDB (research only)
 *   V9LiveService     every minute: V9 engine -> signals -> PAPER / REAL trades
 *                     -> Binance orders -> close detection -> Telegram
 *
 * Who trades what is decided ONLY by users.config.json.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadAppConfig(env.usersConfigPath, env.symbols);
  const users = config.users.filter((u) => u.enabled);
  log.info(`config: symbols=${env.symbols.join(",")} users=${users.map((u) => u.userId).join(",")} realOrdersEnabled=${config.realOrdersEnabled}`);

  const mongo = new Mongo(env.mongoUri, env.mongoDb);
  await mongo.connect();
  const liqRepo = new RawLiquidationEventRepository(mongo.db);
  const oiRepo = new OiSecondObservationRepository(mongo.db);
  await liqRepo.ensureIndexes();
  await oiRepo.ensureIndexes();

  const telegramOf = (u: UserConfig): TelegramClient | null =>
    u.telegram ? new TelegramClient({ enabled: true, botToken: u.telegram.botToken, chatIds: u.telegram.chatIds, parseMode: "none", disableNotification: false }) : null;
  const restOf = (u: UserConfig): BinanceRestClient | null =>
    u.binance ? new BinanceRestClient({ restBaseUrl: "https://fapi.binance.com", wsBaseUrl: "wss://fstream.binance.com", apiKey: u.binance.apiKey, apiSecret: u.binance.apiSecret, testnet: false, recvWindowMs: 5_000 }) : null;

  // ── V9 users: REAL only if every gate agrees AND the account proves it can trade ──
  const v9Users: V9UserRef[] = [];
  for (const u of users) {
    const requested = config.v9.enabled ? config.v9.userModes.get(u.userId) ?? "OFF" : "OFF";
    if (requested === "OFF") continue;
    const telegram = telegramOf(u);
    let mode: "PAPER" | "REAL" = "PAPER";
    let rest: BinanceRestClient | null = null;
    if (requested === "REAL") {
      rest = restOf(u);
      const why = !config.realOrdersEnabled ? "realOrdersEnabled=false" : rest === null ? "binance.enabled is not true" : null;
      if (why) {
        log.error(`[REAL_DOWNGRADED] userId=${u.userId} ${why} -- runs PAPER`);
      } else {
        const ready = await checkRealReadiness(u.userId, rest!);
        if (ready.ok) mode = "REAL";
        else {
          log.error(`[REAL_NOT_READY] userId=${u.userId} ${ready.reason} -- runs PAPER until restart`);
          await telegram?.sendMessage(`⚠️ REAL trading NOT active for ${u.userId}\nReason: ${ready.reason}\nYou will receive PAPER signals until this is fixed and the bot is restarted.`).catch(() => undefined);
        }
      }
    }
    v9Users.push({
      userId: u.userId, mode, riskUsd: u.riskUsd, binanceRest: mode === "REAL" ? rest : null,
      leverage: u.binance?.leverage, marginMode: u.binance?.marginMode, telegram,
    });
  }
  log.warn(`[V9_USER_MODE] enabled=${config.v9.enabled} ${v9Users.map((u) => `${u.userId}=${u.mode}($${u.riskUsd})`).join(" ") || "(no users)"}`);

  // System alerts (e.g. feed silent) go to every user with Telegram.
  const alertAll = async (text: string): Promise<void> => {
    await Promise.all(users.map((u) => telegramOf(u)?.sendMessage(text).catch(() => undefined)));
  };

  const collector = new MarketCollector(env.symbols, loadBinanceConfig(), liqRepo, oiRepo, alertAll);
  collector.start();
  // Research context (long/short ratios, funding/premium) -- never affects trading.
  const context = new ContextCollector(env.symbols, mongo.db);
  await context.ensureIndexes();
  context.start();

  const v9 = config.v9.enabled
    ? new V9LiveService(config.v9, () => v9Users, new V9MongoFeed(mongo.db), new V9Repository(mongo.db),
        { ...DEFAULT_V9_ENGINE_SETTINGS, minSlFraction: config.v9.minSlPct / 100 })
    : null;
  if (v9) void v9.start().catch((err) => log.error(`[V9_START_FAILED] ${err instanceof Error ? err.message : String(err)} -- V9 is NOT running`));

  setInterval(() => {
    const m = process.memoryUsage();
    log.info({ rssMb: Math.round(m.rss / 1048576), heapUsedMb: Math.round(m.heapUsed / 1048576) }, "[MEMORY_USAGE]");
  }, 5 * 60_000).unref();

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`shutting down (${signal})`);
    v9?.stop();
    context.stop();
    await collector.stop();
    await mongo.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  log.info("liquidation-detector (V9) started");
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.stack : String(err) }, "startup failed");
  process.exit(1);
});
