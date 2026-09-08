import "dotenv/config";
import * as path from "path";
import { childLogger } from "./infrastructure/logging/logger";
import { loadBinanceConfig } from "./infrastructure/config/binance.config";
import { loadSymbolsConfig } from "./infrastructure/config/symbols.config";
import { loadObservabilityConfig } from "./infrastructure/config/observability.config";
import { loadUsersConfig } from "./infrastructure/config/users.config.loader";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "./infrastructure/mongo/mongo.client";
import { BinanceWsClient } from "./infrastructure/binance/binanceWs.client";
import { V5WaveService } from "./strategy/v5/v5-wave.service";
import { v5IndividualEventP95 } from "./strategy/v5/v5-liq-stats";
import { buildUserRuntime, type UserRuntime } from "./services/user-runtime";
import { SignalDistributor } from "./services/signal-distributor";
import { runStartupSafetyChecks } from "./services/startup-safety";
import { ReconciliationManager } from "./services/reconciliation-manager";
import { MarketDataOrchestrator } from "./services/market-data-orchestrator";
import { GlobalSignalRepository } from "./infrastructure/mongo/global-signal.repository";
import { UserSignalRepository } from "./infrastructure/mongo/user-signal.repository";

const log = childLogger({ mod: "main" });

/**
 * Sep 8 2026 (Karo). Composition root -- deliberately small. No
 * Express/HTTP layer (background service only, per explicit operator
 * instruction). Startup order mirrors liqwatch-bot's own app.ts:
 * config -> Mongo -> market-data/domain services -> V5 strategy ->
 * per-user runtimes -> orchestrators -> WS streams.
 */
async function main(): Promise<void> {
  const binanceConfig = loadBinanceConfig();
  const symbolsConfig = loadSymbolsConfig();
  const symbols = symbolsConfig.map((s) => s.symbol);
  const observabilityConfig = loadObservabilityConfig();

  const mongoCfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  const mongo = new MongoClientWrapper(mongoCfg);

  const usersConfigPath =
    process.env.USERS_CONFIG_PATH ??
    path.join(process.cwd(), "users.config.json");
  const users = loadUsersConfig(usersConfigPath);

  const userRuntimes: UserRuntime[] = users.map((u) =>
    buildUserRuntime(u, mongo),
  );
  log.info(`built ${userRuntimes.length} user runtime(s)`);

  // Sep 8 2026 (Karo) -- startup-blocker index validation, same
  // severity as liqwatch-bot's own execution-record/execution-claim
  // ensureIndexes() (both already throw on failure; this block simply
  // ensures they're actually CALLED, plus the two new v5_global_signals/
  // v5_signals_<userId> indexes). If Mongo is disabled
  // (mongoCfg.enabled=false), every ensureIndexes() call below is a
  // safe no-op (its own collection accessor returns null first).
  if (mongoCfg.enabled) {
    await new GlobalSignalRepository(mongo).ensureIndexes();
    for (const runtime of userRuntimes) {
      if (!runtime.config.enabled) continue;
      await new UserSignalRepository(
        mongo,
        runtime.config.userId,
      ).ensureIndexes();
      if (runtime.executionRecords)
        await runtime.executionRecords.ensureIndexes();
      if (runtime.executionClaims)
        await runtime.executionClaims.ensureIndexes();
    }
    log.info("all Mongo indexes ensured");
  } else {
    log.warn(
      "MONGO_URI not set -- skipping index validation, persistence disabled",
    );
  }

  // V5's own strategy engine -- SINGLE, global instance. Callback
  // wiring below is the SAME pattern app.ts used (ATR/OI/baseline/P95/
  // walls/flow all read from the SAME domain market-data stores this
  // orchestrator itself owns).
  const orchestratorPlaceholder: { instance: MarketDataOrchestrator | null } = {
    instance: null,
  };

  const v5 = new V5WaveService(
    (symbol, referencePrice) => {
      const atrPct =
        orchestratorPlaceholder.instance?.atrTracker.getATR(symbol, "15m") ??
        null;
      return atrPct ? atrPct * referencePrice : 0;
    },
    (symbol) =>
      orchestratorPlaceholder.instance?.oiTracker.getCachedOI(symbol) ?? null,
    (symbol) =>
      orchestratorPlaceholder.instance?.liquidationStats.rollingMedianLiqNotionalPerMin(
        symbol,
        60,
      ) ?? 0,
    (symbol) =>
      orchestratorPlaceholder.instance
        ? v5IndividualEventP95(
            orchestratorPlaceholder.instance.liquidationStats,
            symbol,
          )
        : 0,
    null,
    null,
  );

  const distributor = new SignalDistributor(mongo, userRuntimes);
  const reconciliation = new ReconciliationManager(mongo, userRuntimes);

  const ws = new BinanceWsClient(binanceConfig);
  // Sep 8 2026 (Karo) -- CRITICAL FIX: broadcasts system-wide alerts
  // (currently: liq-feed-dead) to EVERY enabled-telegram user, since
  // this affects everyone's own data equally, not any one user's own
  // trade. Failures for one user's own chat never block delivery to
  // any other -- matches the same isolation principle used
  // everywhere else in this project.
  const liqFeedAlertTelegram = {
    sendMessage: async (text: string): Promise<void> => {
      for (const runtime of userRuntimes) {
        if (!runtime.telegram) continue;
        try {
          await runtime.telegram.sendMessage(text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            { err: msg, userId: runtime.config.userId },
            "[LIQ_FEED_ALERT_SEND_FAILED] -- isolated",
          );
        }
      }
    },
  };

  const orchestrator = new MarketDataOrchestrator(
    ws,
    symbols,
    v5,
    distributor,
    reconciliation,
    mongo,
    observabilityConfig,
    observabilityConfig,
    liqFeedAlertTelegram,
  );
  orchestratorPlaceholder.instance = orchestrator;

  // Sep 8 2026 (Karo) -- starts the reconciliation cache's own
  // periodic refresh (see ReconciliationManager's own doc comment for
  // the OOM-crash this fixes). Must start BEFORE orchestrator.start()
  // -- ws ticks begin flowing immediately once WS connects, and
  // onTick() should never run against an empty, never-populated cache
  // for longer than necessary.
  // Sep 8 2026 (Karo) -- CRITICAL, ported from liqwatch-bot's own
  // fail-fast startup validation + reconciliation (see
  // startup-safety.ts's own doc comment for the exact real production
  // incident this guards against). MUST run before any WS ticks flow
  // -- a live-armed user's first-ever real order must never be placed
  // before we've confirmed Binance's actual state matches what we
  // expect.
  await runStartupSafetyChecks(userRuntimes, mongo, symbols);

  // Sep 8 2026 (Karo) -- CRITICAL, ported from liqwatch-bot's own
  // initializeDailyPnlFromDb() call in app.ts. Without this, a
  // restart silently resets every user's own daily-loss counter to
  // zero even if they'd already realized losses earlier that same
  // day -- found during a full manual audit (defined, never called).
  for (const runtime of userRuntimes) {
    if (!runtime.config.enabled) continue;
    const userSignalRepo = new UserSignalRepository(
      mongo,
      runtime.config.userId,
    );
    await runtime.dailyLossLimit.initializeFromDb((startMs, endMs) =>
      userSignalRepo.sumClosedNetPnlInRange(
        runtime.config.userId,
        startMs,
        endMs,
      ),
    );
  }

  await reconciliation.start();
  orchestrator.start();
  log.info(
    `liquidation-detector started -- ${symbols.length} symbols, ${userRuntimes.filter((r) => r.config.enabled).length} enabled user(s)`,
  );

  process.on("SIGINT", async () => {
    log.info("shutting down (SIGINT)");
    reconciliation.stop();
    await mongo.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    log.info("shutting down (SIGTERM)");
    reconciliation.stop();
    await mongo.close();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "[FATAL_STARTUP_ERROR]",
  );
  process.exit(1);
});
