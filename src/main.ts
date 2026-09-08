import "dotenv/config";
import * as path from "path";
import { childLogger } from "./infrastructure/logging/logger";
import { loadBinanceConfig } from "./infrastructure/config/binance.config";
import { loadSymbolsConfig } from "./infrastructure/config/symbols.config";
import { loadObservabilityConfig } from "./infrastructure/config/observability.config";
import { loadUsersConfig } from "./infrastructure/config/users.config.loader";
import { MongoClientWrapper, type MongoDetectorConfig } from "./infrastructure/mongo/mongo.client";
import { BinanceWsClient } from "./infrastructure/binance/binanceWs.client";
import { V5WaveService } from "./strategy/v5/v5-wave.service";
import { v5IndividualEventP95 } from "./strategy/v5/v5-liq-stats";
import { buildUserRuntime, type UserRuntime } from "./services/user-runtime";
import { SignalDistributor } from "./services/signal-distributor";
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

  const usersConfigPath = process.env.USERS_CONFIG_PATH ?? path.join(process.cwd(), "users.config.json");
  const users = loadUsersConfig(usersConfigPath);

  const userRuntimes: UserRuntime[] = users.map((u) => buildUserRuntime(u, mongo));
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
      await new UserSignalRepository(mongo, runtime.config.userId).ensureIndexes();
      if (runtime.executionRecords) await runtime.executionRecords.ensureIndexes();
      if (runtime.executionClaims) await runtime.executionClaims.ensureIndexes();
    }
    log.info("all Mongo indexes ensured");
  } else {
    log.warn("MONGO_URI not set -- skipping index validation, persistence disabled");
  }

  // V5's own strategy engine -- SINGLE, global instance. Callback
  // wiring below is the SAME pattern app.ts used (ATR/OI/baseline/P95/
  // walls/flow all read from the SAME domain market-data stores this
  // orchestrator itself owns).
  const orchestratorPlaceholder: { instance: MarketDataOrchestrator | null } = { instance: null };

  const v5 = new V5WaveService(
    (symbol, referencePrice) => {
      const atrPct = orchestratorPlaceholder.instance?.atrTracker.getATR(symbol, "15m") ?? null;
      return atrPct ? atrPct * referencePrice : 0;
    },
    (symbol) => orchestratorPlaceholder.instance?.oiTracker.getCachedOI(symbol) ?? null,
    (symbol) => orchestratorPlaceholder.instance?.liquidationStats.rollingMedianLiqNotionalPerMin(symbol, 60) ?? 0,
    (symbol) => (orchestratorPlaceholder.instance ? v5IndividualEventP95(orchestratorPlaceholder.instance.liquidationStats, symbol) : 0),
    null,
    null,
  );

  const distributor = new SignalDistributor(mongo, userRuntimes);
  const reconciliation = new ReconciliationManager(mongo, userRuntimes);

  const ws = new BinanceWsClient(binanceConfig);
  const orchestrator = new MarketDataOrchestrator(
    ws,
    symbols,
    v5,
    distributor,
    reconciliation,
    mongo,
    observabilityConfig,
    observabilityConfig,
  );
  orchestratorPlaceholder.instance = orchestrator;

  orchestrator.start();
  log.info(`liquidation-detector started -- ${symbols.length} symbols, ${userRuntimes.filter((r) => r.config.enabled).length} enabled user(s)`);

  process.on("SIGINT", async () => {
    log.info("shutting down (SIGINT)");
    await mongo.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    log.info("shutting down (SIGTERM)");
    await mongo.close();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, "[FATAL_STARTUP_ERROR]");
  process.exit(1);
});
