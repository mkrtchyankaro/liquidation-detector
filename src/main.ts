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
    // Sep 8 2026 (Karo), operator-designed minimal-cascade model --
    // NEW, ATR(1m)-based structural UNIT, completely separate from
    // the ATR15m callback above (which still ONLY sizes the trade-
    // plan's own TP/SL). See V5WatchState.unitAtStart's own doc
    // comment.
    (symbol, referencePrice) => {
      const atr1mPct =
        orchestratorPlaceholder.instance?.atrTracker.getATR(symbol, "1m") ??
        null;
      return atr1mPct ? atr1mPct * referencePrice : 0;
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
    // Sep 8 2026 (Karo) -- CRITICAL FIX, found during a full manual
    // audit: this was `null`, meaning EVERY trade-plan was computed
    // with NO_WALLS (all zeros) -- the wall-cap-on-TP step in
    // deriveLiquidityTradePlan() was therefore structurally NEVER
    // active, a real trading-behavior difference from the old bot,
    // not just a missing diagnostic. Restored, byte-identical logic
    // to liqwatch-bot's own app.ts V5WaveService construction (same
    // wall-tracker method calls, same ctx shape, same atAnchor=atEntry
    // choice -- confirmed the ORIGINAL itself used the identical
    // snapshot for both, not a new approximation).
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
    // Sep 8 2026 (Karo) -- CRITICAL FIX, same audit: this was `null`,
    // meaning every wave's own takerBuyUsd/takerSellUsd/takerImbalance
    // forensic field was silently always null (AggressiveFlowService
    // itself was never even constructed anywhere -- fixed in
    // market-data-orchestrator.ts).
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
    // Sep 8 2026 (Karo) -- CRITICAL FIX, operator-corrected
    // architecture: MAIN's own CLOSE notification must use ONLY
    // MAIN's own dedicated telegram config (the "main" user's own
    // runtime.telegram), never a broadcast to karo/artak too. Found
    // via a real production trace that confirmed the rest of the
    // architecture (MAIN lock, restart-hydration, user-close
    // isolation) was already correct -- this was the one remaining
    // gap. `null` if no "main" user exists or has telegram disabled
    // -- MAIN close is then simply not sent anywhere, matching how
    // every other missing-config case in this project degrades.
    userRuntimes.find((r) => r.config.userId === "main")?.telegram ?? null,
  );
  orchestratorPlaceholder.instance = orchestrator;

  // Sep 8 2026 (Karo) -- ensures the new liq_raw_events TTL/symbol
  // indexes (RawLiquidationEventRepository, wrapped by the
  // orchestrator's own ensureIndexes()).
  await orchestrator.ensureIndexes();

  // Sep 8 2026 (Karo) -- NEW, restart-survivability for the MAIN
  // same-symbol lock (see MarketDataOrchestrator.hydrateMainLocks()'s
  // own doc comment). MUST run before any WS ticks flow -- otherwise a
  // liquidation event for an already-open MAIN symbol could slip
  // through and start a second, duplicate watch before hydration
  // finishes.
  await orchestrator.hydrateMainLocks();

  // Sep 8 2026 (Karo) -- CRITICAL FIX, ported from liqwatch-bot's own
  // app.ts "Restart safety — Phase A: ATR bootstrap from REST history"
  // (found NEVER called anywhere in this project during a full manual
  // audit -- atr-bootstrap.ts was copied but never wired). Without
  // this, ATRTrackerService starts completely empty at every restart
  // -- getAtrAbs() returns 0 for every symbol until enough LIVE 15m/5m
  // candles close naturally (up to 15-20+ minutes), during which
  // V5's own extremeDistanceAtr math (which DIVIDES by this value) is
  // either NaN/Infinity or otherwise meaningless -- directly affects
  // whether/how signals fire after every single restart. Pulls 100
  // closed candles per (symbol, interval) via REST, runs BEFORE
  // orchestrator.start() (which itself calls ws.subscribe()) so no
  // live kline ever races the bootstrap -- identical ordering to the
  // original.
  // Sep 8 2026 (Karo) -- "1m" ADDED to the bootstrap pairs alongside
  // 15m/5m. Previously 1m was research-only (fine to warm up
  // naturally); now it is ALSO the new minimal-cascade model's own
  // UNIT (V5WatchState.unitAtStart) -- without bootstrapping it, the
  // new engine would be unable to evaluate ANY recovery/completion
  // decision (onTick's own `if (watch.unitAtStart <= 0) continue`
  // guard) until enough live 1m candles closed naturally.
  const bootstrapPairs = pairsFor(symbols, ["15m", "5m", "1m"], 100);
  await bootstrapAtrFromRest(
    new BinanceRestClient(binanceConfig),
    orchestrator.atrTracker,
    bootstrapPairs,
  );

  // Sep 8 2026 (Karo) -- CRITICAL FIX, ported from liqwatch-bot's own
  // "Step E" LiqAggregateOrchestrator, found NEVER wired anywhere in
  // this project during a full manual audit (only the repository was
  // copied, not the orchestrator that actually calls it). Without
  // this, TWO things were silently broken: (1) no boot-time P95/
  // percentile warm-up from historical data -- every restart started
  // cold; (2) no ongoing writes to the SHARED liq_minute_aggregates
  // collection -- contradicting the operator's own explicit
  // requirement to keep writing to it. The old MARKET_DATA_WRITER
  // gate (avoiding duplicate writers across THREE processes) does not
  // apply -- this is the only process here, unconditionally the sole
  // writer.
  const persistenceConfig = loadPersistenceConfig();
  const liqAggregateRepo = new LiqAggregateRepository(mongo, persistenceConfig);
  const liqAggregateOrchestrator = new LiqAggregateOrchestrator(
    persistenceConfig,
    liqAggregateRepo,
    orchestrator.liquidationStats,
    symbols,
  );
  await liqAggregateOrchestrator.warmup();

  // Sep 8 2026 (Karo) -- CRITICAL FIX, same class of gap as above --
  // WallAggregateOrchestrator was never wired either. No warmup for
  // this one by design (walls are pure live-state, see the original
  // class's own doc comment), but the periodic flush to the SHARED
  // wall_minute_aggregates collection was equally silently missing.
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
  // Sep 8 2026 (Karo) -- starts the 60s flush timer, AFTER ws.start()
  // (matching old app.ts's own ordering exactly -- "runs after WS so
  // live data flow is never blocked by Mongo index creation").
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
