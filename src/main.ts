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
import { BinanceRestClient } from "./infrastructure/binance/binanceRest.client";
import { V5WaveService } from "./strategy/v5/v5-wave.service";
import { v5IndividualEventP95 } from "./strategy/v5/v5-liq-stats";
import { buildUserRuntime, type UserRuntime } from "./services/user-runtime";
import { SignalDistributor } from "./services/signal-distributor";
import { runStartupSafetyChecks } from "./services/startup-safety";
import { ReconciliationManager } from "./services/reconciliation-manager";
import { MarketDataOrchestrator } from "./services/market-data-orchestrator";
import { GlobalSignalRepository } from "./infrastructure/mongo/global-signal.repository";
import { UserSignalRepository } from "./infrastructure/mongo/user-signal.repository";
import { bootstrapAtrFromRest, pairsFor } from "./domain/market/atr-bootstrap";
import { loadPersistenceConfig } from "./infrastructure/config/persistence.config";
import { loadWallPersistenceConfig } from "./infrastructure/config/wall-persistence.config";
import { LiqAggregateRepository } from "./infrastructure/mongo/liq-aggregate.repository";
import { LiqAggregateOrchestrator } from "./infrastructure/mongo/liq-aggregate-persistence.orchestrator";
import { WallAggregateRepository } from "./infrastructure/mongo/wall-aggregate.repository";
import { WallAggregateOrchestrator } from "./infrastructure/mongo/wall-aggregate-persistence.orchestrator";

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
    (symbol, _side) => {
      const wallTracker = orchestratorPlaceholder.instance?.wallTracker;
      const bidWall = wallTracker?.getLargestPersistentWall(symbol, "BID");
      const askWall = wallTracker?.getLargestPersistentWall(symbol, "ASK");
      const ctx = {
        topBidNotional: bidWall?.currentNotional ?? 0,
        topAskNotional: askWall?.currentNotional ?? 0,
        topBidPrice: bidWall?.representativePrice ?? 0,
        topAskPrice: askWall?.representativePrice ?? 0,
        imbalance:
          bidWall && askWall
            ? (bidWall.currentNotional - askWall.currentNotional) /
              (bidWall.currentNotional + askWall.currentNotional || 1)
            : 0,
        topBidPersistent: bidWall?.isPersistent ?? false,
        topAskPersistent: askWall?.isPersistent ?? false,
      };
      return { atEntry: ctx, atAnchor: ctx, atSweepStart: null };
    },
    (symbol, lookbackMs, now) =>
      orchestratorPlaceholder.instance?.aggressiveFlow.getRecentFlow(
        symbol,
        lookbackMs,
        now,
      ) ?? null,
  );

  const distributor = new SignalDistributor(mongo, userRuntimes);
  const reconciliation = new ReconciliationManager(mongo, userRuntimes);

  const ws = new BinanceWsClient(binanceConfig);
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

  await orchestrator.ensureIndexes();

  // Sep 8 2026 (Karo) -- NEW, restart-survivability for the MAIN
  // same-symbol lock (see MarketDataOrchestrator.hydrateMainLocks()'s
  // own doc comment). MUST run before any WS ticks flow -- otherwise a
  // liquidation event for an already-open MAIN symbol could slip
  // through and start a second, duplicate watch before hydration
  // finishes.
  await orchestrator.hydrateMainLocks();

  const bootstrapPairs = pairsFor(symbols, ["15m", "5m"], 100);
  await bootstrapAtrFromRest(
    new BinanceRestClient(binanceConfig),
    orchestrator.atrTracker,
    bootstrapPairs,
  );

  const persistenceConfig = loadPersistenceConfig();
  const liqAggregateRepo = new LiqAggregateRepository(mongo, persistenceConfig);
  const liqAggregateOrchestrator = new LiqAggregateOrchestrator(
    persistenceConfig,
    liqAggregateRepo,
    orchestrator.liquidationStats,
    symbols,
  );
  await liqAggregateOrchestrator.warmup();

  const wallPersistenceConfig = loadWallPersistenceConfig();
  const wallAggregateRepo = new WallAggregateRepository(
    mongo,
    wallPersistenceConfig,
  );
  const wallAggregateOrchestrator = new WallAggregateOrchestrator(
    wallPersistenceConfig,
    wallAggregateRepo,
    orchestrator.wallTracker,
    symbols,
  );
  await wallAggregateOrchestrator.ensureIndexes();

  await runStartupSafetyChecks(userRuntimes, mongo, symbols);

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
  liqAggregateOrchestrator.start();
  wallAggregateOrchestrator.start();
  log.info(
    `liquidation-detector started -- ${symbols.length} symbols, ${userRuntimes.filter((r) => r.config.enabled).length} enabled user(s)`,
  );

  process.on("SIGINT", async () => {
    log.info("shutting down (SIGINT)");
    reconciliation.stop();
    await liqAggregateOrchestrator.stop();
    await wallAggregateOrchestrator.stop();
    await mongo.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    log.info("shutting down (SIGTERM)");
    reconciliation.stop();
    await liqAggregateOrchestrator.stop();
    await wallAggregateOrchestrator.stop();
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
