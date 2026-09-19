import "dotenv/config";
import * as path from "path";
import { childLogger } from "./infrastructure/logging/logger";
import { loadBinanceConfig } from "./infrastructure/config/binance.config";
import { loadSymbolsConfig } from "./infrastructure/config/symbols.config";
import { loadObservabilityConfig } from "./infrastructure/config/observability.config";
import { loadUsersConfig } from "./infrastructure/config/users.config.loader";
import { MongoClientWrapper, type MongoDetectorConfig } from "./infrastructure/mongo/mongo.client";
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
import { bootstrapCandleAndDirectionalAtrFromRest } from "./domain/market/candle-directional-atr-bootstrap";
import { LiquidationOiRuntimeOrchestrator } from "./services/liquidation-oi-runtime-orchestrator";
import { LiquidationOiGlobalSignalRepository } from "./infrastructure/mongo/liquidation-oi-global-signal.repository";
import { LiquidationOiWaitStateRepository } from "./infrastructure/mongo/liquidation-oi-wait-state.repository";
import { StrategyOrderRepository } from "./infrastructure/mongo/strategy-order.repository";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "./domain/liquidation-oi-strategy/config";
import { DEFAULT_CAPACITY_MODEL_COEFFICIENTS } from "./domain/liquidation-oi-strategy/initial-capacity-model";
import { loadPersistenceConfig } from "./infrastructure/config/persistence.config";
import { loadWallPersistenceConfig } from "./infrastructure/config/wall-persistence.config";
import { LiqAggregateRepository } from "./infrastructure/mongo/liq-aggregate.repository";
import { LiqAggregateOrchestrator } from "./infrastructure/mongo/liq-aggregate-persistence.orchestrator";
import { WallAggregateRepository } from "./infrastructure/mongo/wall-aggregate.repository";
import { WallAggregateOrchestrator } from "./infrastructure/mongo/wall-aggregate-persistence.orchestrator";
import { EpisodePercentileService } from "./domain/research/episode-percentile.service";
import { LiquidationOiPositionLifecycleService } from "./services/liquidation-oi-position-lifecycle.service";
import { LiquidationOiActiveMainRuntime } from "./services/liquidation-oi-active-main-runtime.service";
import { LoxPercentileRefreshLifecycle } from "./services/lox-percentile-refresh-lifecycle";
import { recoverLoxOnRestart } from "./services/liquidation-oi-restart-recovery";
import { DEFAULT_ACTIVE_LIFECYCLE_CONFIG } from "./domain/liquidation-oi-strategy/active-lifecycle-config";
import { BinanceSpotWsClient } from "./infrastructure/binance/binanceSpotWs.client";
import { loadBinanceSpotWsConfig } from "./infrastructure/config/binance.config";
import { RecoveryFlowTracker } from "./domain/liquidation-oi-strategy/recovery-flow-tracker";
import { MarketSnapshotCache } from "./domain/liquidation-oi-strategy/market-snapshot-cache";
import { EpisodeResearchRecorder } from "./domain/liquidation-oi-strategy/episode-research-recorder";
import { EpisodeResearchRepository } from "./infrastructure/mongo/episode-research.repository";
import { formatEpisodeResearchSummary } from "./domain/liquidation-oi-strategy/episode-research-summary-formatter";

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
    // Sep 8 2026 (Karo), operator-designed minimal-cascade model --
    // NEW, ATR(1m)-based structural UNIT, completely separate from
    // the ATR15m callback above (which still ONLY sizes the trade-
    // plan's own TP/SL). See V5WatchState.unitAtStart's own doc
    // comment.
    (symbol, referencePrice) => {
      const atr1mPct = orchestratorPlaceholder.instance?.atrTracker.getATR(symbol, "1m") ?? null;
      return atr1mPct ? atr1mPct * referencePrice : 0;
    },
    (symbol) => orchestratorPlaceholder.instance?.oiTracker.getCachedOI(symbol) ?? null,
    // Sep 9 2026 (Karo), operator-requested RESTORE -- REVERTS to the
    // ORIGINAL, production-proven combined LONG+SHORT rolling median
    // (bucketsLong[i]+bucketsShort[i], last 60 sealed activity
    // buckets), matching the OLD liqwatch-bot's own
    // rollingMedianLiqNotionalPerMin() exactly (confirmed byte-
    // identical via direct old-code trace). The victim-specific regime
    // (rollingMedianLiqNotionalPerMinForVictim(), added later) is KEPT,
    // fully intact, for diagnostics/research (see
    // GlobalSignalDoc.liquidationStatsContext) -- it is simply no
    // longer called from here, so it can never influence the trade-
    // plan. Real production evidence (XRPUSDT, signalId
    // 313f105e-43da-41fb-8275-78c6b534174e): the victim-specific
    // SHORT-only median collapsed to $8.1 vs the combined $1064.6
    // (131x smaller) over the same 60 real buckets, purely because
    // LONG-side liquidations dominated that window -- a median over a
    // systematically rarer side is not a safe strategy input.
    (symbol) => orchestratorPlaceholder.instance?.liquidationStats.rollingMedianLiqNotionalPerMin(symbol, 60) ?? 0,
    (symbol, victim) => (orchestratorPlaceholder.instance ? v5IndividualEventP95(orchestratorPlaceholder.instance.liquidationStats, symbol, victim) : 0),
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
        imbalance: bidWall && askWall ? (bidWall.currentNotional - askWall.currentNotional) / (bidWall.currentNotional + askWall.currentNotional || 1) : 0,
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
    (symbol, lookbackMs, now) => orchestratorPlaceholder.instance?.aggressiveFlow.getRecentFlow(symbol, lookbackMs, now) ?? null,
  );

  const distributor = new SignalDistributor(mongo, userRuntimes);
  // Sep 16 2026 (Karo), operator-approved -- constructed here (no I/O
  // in its own constructor) so it can be threaded into
  // ReconciliationManager for the signal-CLOSE refresh hook. Its
  // actual warmup is triggered later, fire-and-forget, AFTER
  // orchestrator.start() -- see that call site's own comment.
  const episodePercentileService = new EpisodePercentileService(symbols);
  // Sep 16 2026 (Karo), operator-approved architecture -- Liquidation+OI
  // Exhaustion strategy runtime wiring. observationEnabled=true so the
  // full data path (real liquidation events, real bookTicker price,
  // existing OI/ATR state) is genuinely live and inspectable.
  // executionEnabled is explicitly false here -- this is the ONE place
  // that would need to change (to `true`) to allow real Binance orders
  // for this new strategy. No environment variable; this exact line is
  // the single source of truth.
  const liquidationOiGlobalSignalRepo = new LiquidationOiGlobalSignalRepository(mongo);
  const liquidationOiStrategyOrderRepo = new StrategyOrderRepository(mongo);
  // Sep 17 2026 (Karo), operator-requested fix -- these repositories' own
  // ensureIndexes() methods existed (uniqueness on globalSignalId, on
  // userId+globalSignalId) but were never called anywhere -- a real
  // source-audit finding. Runs only when Mongo is enabled, matching the
  // existing pattern above; each ensureIndexes() is a safe no-op if its
  // own collection accessor returns null.
  if (mongoCfg.enabled) {
    await liquidationOiGlobalSignalRepo.ensureIndexes();
    await liquidationOiStrategyOrderRepo.ensureIndexes();
    log.info("LOX Mongo indexes ensured");
  }
  const liquidationOiForensicLogger = childLogger({ mod: "lox-forensic" });
  // Sep 19 2026 (Karo), operator-requested Episode Research capture --
  // constructed here (before the sink below, which needs to reference
  // it) so EVERY episode termination (entry or no-entry alike) can be
  // finalized and persisted the moment its own EPISODE_TERMINAL
  // forensic event fires -- the cleanest available hook, since that
  // event already carries symbol/episodeId/ts/reason exactly as
  // needed, with zero changes to watch-manager.ts's own pure logic.
  const marketSnapshotCache = new MarketSnapshotCache();
  const episodeResearchRecorder = new EpisodeResearchRecorder(marketSnapshotCache);
  const episodeResearchRepo = new EpisodeResearchRepository(mongo);
  if (mongoCfg.enabled) {
    await episodeResearchRepo.ensureIndexes();
  }
  const liquidationOiForensicSink = (event: import("./domain/liquidation-oi-strategy/forensic-events").ForensicEvent): void => {
    liquidationOiForensicLogger.info({ ...event }, `[LOX_FORENSIC_${event.type}]`);
    if (event.type === "EPISODE_TERMINAL") {
      const finalRecord = episodeResearchRecorder.onEpisodeTerminal(event.symbol, event.ts, event.reason);
      if (finalRecord !== null) {
        void episodeResearchRepo.insert(finalRecord);
        liquidationOiForensicLogger.info(`[EPISODE_RESEARCH_SUMMARY]\n${formatEpisodeResearchSummary(finalRecord)}`);
      }
      episodeResearchRecorder.clear(event.symbol);
    }
  };
  // Sep 17 2026 (Karo), operator-approved final capacity architecture,
  // Section 31 -- restart-safe WAIT persistence.
  const liquidationOiWaitStateRepo = new LiquidationOiWaitStateRepository(mongo);
  if (mongoCfg.enabled) {
    await liquidationOiWaitStateRepo.ensureIndexes();
  }
  // Sep 19 2026 (Karo), operator-requested Recovery Flow (final
  // extreme -> confirmed entry window) -- OBSERVATIONAL ONLY, see
  // recovery-flow-tracker.ts's own doc comment. Constructed here
  // (before the WS clients below) so it can be threaded into both the
  // LOX orchestrator (for reading frozen stats at ENTRY_READY) and the
  // Futures/Spot aggTrade listeners further down.
  const recoveryFlowTracker = new RecoveryFlowTracker();
  const liquidationOiOrchestrator = new LiquidationOiRuntimeOrchestrator(
    DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
    DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
    liquidationOiGlobalSignalRepo,
    liquidationOiStrategyOrderRepo,
    () => userRuntimes.filter((r) => r.config.enabled).map((r) => ({ userId: r.config.userId, riskUsd: r.config.risk.riskUsd, liquidationOiExecutionEnabled: r.config.liquidationOiExecutionEnabled, binanceRest: r.binanceRest, telegram: r.telegram })),
    true,  // observationEnabled
    false, // executionEnabled -- MUST be explicitly changed to true here to allow real orders
    undefined,
    // Sep 16 2026 (Karo), operator-requested forensic observability --
    // structured, event-driven (not per-tick spam), so the live bot's
    // own logs are as diagnosable as the replay tool without needing
    // a restart or a code change to add logging later.
    liquidationOiForensicSink,
    undefined, // activeMainRuntime -- set late below via setActiveMainRuntime()
    undefined, // activeLifecycleConfig -- default (DEFAULT_ACTIVE_LIFECYCLE_CONFIG)
    liquidationOiWaitStateRepo,
    recoveryFlowTracker,
    episodeResearchRecorder,
    episodeResearchRepo,
  );
  // Sep 17 2026 (Karo), operator-requested production-completion pass --
  // Sections L/M/O (termination detection, mandatory cleanup, multi-user
  // global close) and J/K (ACTIVE MAIN monitoring, dynamic TP). Both reuse
  // the SAME userRuntimes accessor and the orchestrator's OWN watchManager
  // (late-bound below, breaking the circular construction dependency).
  const liquidationOiPositionLifecycle = new LiquidationOiPositionLifecycleService(
    liquidationOiGlobalSignalRepo, liquidationOiStrategyOrderRepo, liquidationOiOrchestrator.getWatchManager(),
    () => userRuntimes.filter((r) => r.config.enabled).map((r) => ({ userId: r.config.userId, riskUsd: r.config.risk.riskUsd, liquidationOiExecutionEnabled: r.config.liquidationOiExecutionEnabled, binanceRest: r.binanceRest, telegram: r.telegram })),
    DEFAULT_ACTIVE_LIFECYCLE_CONFIG.positionReconciliationIntervalMs,
    liquidationOiForensicSink,
  );
  const liquidationOiActiveMainRuntime = new LiquidationOiActiveMainRuntime(
    liquidationOiGlobalSignalRepo, liquidationOiStrategyOrderRepo, liquidationOiPositionLifecycle,
    () => userRuntimes.filter((r) => r.config.enabled).map((r) => ({ userId: r.config.userId, riskUsd: r.config.risk.riskUsd, liquidationOiExecutionEnabled: r.config.liquidationOiExecutionEnabled, binanceRest: r.binanceRest, telegram: r.telegram })),
    DEFAULT_ACTIVE_LIFECYCLE_CONFIG, liquidationOiForensicSink,
  );
  liquidationOiOrchestrator.setActiveMainRuntime(liquidationOiActiveMainRuntime);
  // Section C -- LOX-owned percentile refresh, independent of V3/V5 close events.
  const loxPercentileRefreshLifecycle = new LoxPercentileRefreshLifecycle(episodePercentileService, symbols, DEFAULT_ACTIVE_LIFECYCLE_CONFIG.percentileRefreshIntervalMs);
  const reconciliation = new ReconciliationManager(mongo, userRuntimes, episodePercentileService);

  const ws = new BinanceWsClient(binanceConfig);
  // Sep 19 2026 (Karo), operator-requested Spot-vs-Futures order-flow
  // observation -- an ADDITIONAL listener on the SAME already-existing
  // Futures aggTrade stream (market-data-orchestrator.ts's own
  // ws.on("aggTrade", ...) handler is untouched; EventEmitter supports
  // multiple independent listeners on the same event). No new Futures
  // subscription.
  ws.on("aggTrade", (t) => {
    recoveryFlowTracker.ingestFuturesTrade(t);
    episodeResearchRecorder.ingestFuturesTrade(t);
  });
  // Sep 19 2026 (Karo), operator-requested Episode Research capture --
  // ANOTHER additional listener on the SAME already-subscribed Futures
  // bookTicker stream (market-data-orchestrator.ts's own bookTicker
  // handling, which drives onTick(), is completely untouched -- this
  // is purely an extra observer). Feeds MarketSnapshotCache's
  // "latest Futures bid/ask" side, read by EpisodeResearchRecorder at
  // arbitrary moments (episode start, each liquidation event, each
  // new extreme, episode end, entry).
  ws.on("bookTicker", (bt) => marketSnapshotCache.ingestFuturesBookTicker(bt));
  // Sep 19 2026 (Karo), operator-requested Spot-vs-Futures order-flow
  // observation -- a genuinely SEPARATE WebSocket connection (Binance
  // Spot's own base URL), since no Spot market-data infrastructure
  // existed in this project before this feature. Consumers:
  // recoveryFlowTracker (aggTrade only) and episodeResearchRecorder +
  // marketSnapshotCache (aggTrade + bookTicker).
  const spotWs = new BinanceSpotWsClient(loadBinanceSpotWsConfig().wsBaseUrl, symbols);
  spotWs.on("aggTrade", (t) => {
    recoveryFlowTracker.ingestSpotTrade(t);
    episodeResearchRecorder.ingestSpotTrade(t);
  });
  spotWs.on("bookTicker", (bt) => marketSnapshotCache.ingestSpotBookTicker(bt));
  spotWs.on("error", (err) => log.warn(`[SPOT_WS_ERROR] ${err.message} -- order-flow observation only, never affects trading`));
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
          log.error({ err: msg, userId: runtime.config.userId }, "[LIQ_FEED_ALERT_SEND_FAILED] -- isolated");
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
    // Sep 10 2026 (Karo), operator-requested -- production V5 signal
    // creation (Telegram ENTRY, Binance execution, GlobalSignalDoc
    // status=SIGNAL persistence) is temporarily disabled. V5WaveService's
    // own state machine keeps running unchanged (required for the
    // common-horizon-4h-v1 research's own episode-start detection).
    // Controlled by V5_PRODUCTION_SIGNALS_ENABLED -- defaults to false
    // (disabled) per the operator's own current, explicit intent; set
    // to "true" in the environment to re-enable production signals
    // again later without any code change.
    process.env.V5_PRODUCTION_SIGNALS_ENABLED === "true",
    liquidationOiOrchestrator,
    episodePercentileService,
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
  // Sep 10 2026 (Karo), operator-requested restart-safe persistence for
  // the production V5 multi-timeframe cascade lifecycle -- MUST also
  // run before any WS ticks flow, same ordering requirement as
  // hydrateMainLocks() above.
  await orchestrator.hydrateActiveCascades();

  // Sep 17 2026 (Karo), operator-requested Section N -- LOX restart/crash
  // recovery. Same ordering requirement as hydrateMainLocks()/
  // hydrateActiveCascades() above: MUST run before any WS ticks flow, so a
  // real liquidation event can never race ahead of reconciling whatever
  // pre-restart state exists. Only runs meaningfully when Mongo is enabled
  // (findOpenSignals() etc. are safe no-ops otherwise).
  if (mongoCfg.enabled) {
    await recoverLoxOnRestart(liquidationOiGlobalSignalRepo, liquidationOiStrategyOrderRepo, liquidationOiPositionLifecycle, liquidationOiOrchestrator.getWatchManager(), () => userRuntimes.filter((r) => r.config.enabled).map((r) => ({ userId: r.config.userId, riskUsd: r.config.risk.riskUsd, liquidationOiExecutionEnabled: r.config.liquidationOiExecutionEnabled, binanceRest: r.binanceRest, telegram: r.telegram })), liquidationOiForensicSink, Date.now());
    // Sep 17 2026 (Karo), operator-approved final capacity architecture,
    // Section 31 -- restores pre-ENTRY_READY WAIT state. Runs AFTER
    // recoverLoxOnRestart() (which only restores ACTIVE) so the two
    // never race on the same symbol; restoreWaitLifecycle() itself is
    // a no-op for any symbol recoverLoxOnRestart() already locked.
    await liquidationOiOrchestrator.hydrateWaitStates(Date.now());
  }

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
  // Sep 9 2026 (Karo), operator-requested RESEARCH-ONLY ATR-timeframe
  // comparison -- "3m" added, matching the operator's own "~67 periods"
  // spec (67 x 3min ~= 201min lookback, roughly matching 1m(100min)/
  // 5m(100min)'s own already-existing bootstrap depth). Exclusively
  // consumed by the shadow unit-research service; no existing
  // production code path reads ATR(3m) at all.
  // Sep 10 2026 (Karo), operator-requested RESEARCH-ONLY common-horizon
  // Wilder-ATR experiment ("common-horizon-4h-v1") -- "1m" needs its
  // own, LARGER bootstrap (250 candles, matching
  // RESEARCH_HISTORY_BUFFER_SIZE) so getWilderATR(symbol,"1m",240) can
  // warm up immediately on restart instead of needing ~4h of live
  // candles first. The EXISTING 100-candle bootstrap for 15m/5m/3m/1m
  // (still used by getATR(14) and the earlier 3m/5m research
  // experiment) is completely unchanged -- this is a SECOND, additive
  // bootstrap call for "1m" alone, both writing into the SAME
  // onCandle() hook (dedup-safe by openTime), so the existing 1m
  // ATR(14) buffer is unaffected by the extra history now also being
  // fed into the separate research buffer.
  const bootstrapPairs = pairsFor(symbols, ["15m", "5m", "3m", "1m"], 100);
  const research1mBootstrapPairs = pairsFor(symbols, ["1m"], 250);
  await bootstrapAtrFromRest(new BinanceRestClient(binanceConfig), orchestrator.atrTracker, [...bootstrapPairs, ...research1mBootstrapPairs]);
  // Sep 16 2026 (Karo), operator-approved -- restart/redeploy candle +
  // directional-ATR warmup. Standard ATR bootstrap above is UNCHANGED.
  // This closes the narrower gap it left: candleStore and
  // directionalAtr{,3m,5m} had no REST bootstrap at all before this.
  // Awaited HERE, before orchestrator.start() below -- the same call
  // that opens the WS connection carrying both klines and forceOrder
  // (liquidation) events -- so no liquidation event can possibly
  // arrive before this completes. See candle-directional-atr-
  // bootstrap.ts's own header for the full sequencing rationale.
  await bootstrapCandleAndDirectionalAtrFromRest(new BinanceRestClient(binanceConfig), { candleStore: orchestrator.candleStore, directionalAtr1m: orchestrator.directionalAtr, directionalAtr3m: orchestrator.directionalAtr3m, directionalAtr5m: orchestrator.directionalAtr5m }, symbols);

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
  // Sep 17 2026 (Karo), operator-reported CRITICAL FIX -- TTL/index
  // correctness must never depend on LIQ_PERSIST_ENABLED. Previously
  // liqAggregateRepo.ensureIndexes() was ONLY ever reached from inside
  // warmup(), which returns immediately (before calling ensureIndexes
  // at all) if persistence is disabled -- coupling "should we do a
  // historical warmup read" with "should the TTL index be correct" is
  // two different concerns that should never have been tied together.
  // Called here, unconditionally, BEFORE warmup() -- idempotent
  // (ensureIndexes() has its own indexesEnsured guard), so warmup()'s
  // own internal call (when enabled) is simply a harmless no-op repeat.
  const liqAggregateIndexesOk = await liqAggregateRepo.ensureIndexes();
  if (liqAggregateIndexesOk) {
    const liqRetentionSeconds = persistenceConfig.retentionDays * 24 * 3600;
    log.info(`[TTL] liq_minute_aggregates createdAt = ${liqRetentionSeconds}s (${persistenceConfig.retentionDays}d)`);
  }
  const liqAggregateOrchestrator = new LiqAggregateOrchestrator(persistenceConfig, liqAggregateRepo, orchestrator.liquidationStats, symbols);
  await liqAggregateOrchestrator.warmup();

  // Sep 8 2026 (Karo) -- CRITICAL FIX, same class of gap as above --
  // WallAggregateOrchestrator was never wired either. No warmup for
  // this one by design (walls are pure live-state, see the original
  // class's own doc comment), but the periodic flush to the SHARED
  // wall_minute_aggregates collection was equally silently missing.
  const wallPersistenceConfig = loadWallPersistenceConfig();
  const wallAggregateRepo = new WallAggregateRepository(mongo, wallPersistenceConfig);
  const wallAggregateOrchestrator = new WallAggregateOrchestrator(wallPersistenceConfig, wallAggregateRepo, orchestrator.wallTracker, symbols);
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
    const userSignalRepo = new UserSignalRepository(mongo, runtime.config.userId);
    await runtime.dailyLossLimit.initializeFromDb((startMs, endMs) => userSignalRepo.sumClosedNetPnlInRange(runtime.config.userId, startMs, endMs));
  }

  await reconciliation.start();
  orchestrator.start();
  spotWs.start(); // Sep 19 2026 (Karo), order-flow observation -- Spot WS lifecycle
  // Sep 16 2026 (Karo), operator-approved -- historical
  // DISPLACEMENT_BALANCED episode-size percentile cache warmup.
  // Deliberately NOT awaited: a full 10-symbol, 3-day, 3-timeframe
  // warmup can take real wall-clock time (verified Binance weight
  // cost: ~50 weight/symbol, ~500 total -- safe against the 2400/min
  // budget, but still real time across controlled concurrency), and
  // live liquidation detection must never wait on it. Each symbol's
  // cache entry starts NOT_READY (getThresholds() returns null) and
  // becomes READY as its own warmup completes. The service instance
  // itself was already constructed earlier (see its own comment there)
  // so ReconciliationManager could be wired to it for the signal-CLOSE
  // refresh hook.
  // Sep 17 2026 (Karo), CORRECTION to a stale comment found during the
  // Sep 17 source audit: WATCH qualification (qualifyWatch(), via
  // market-data-orchestrator.ts's own bookTicker hook) DOES read from
  // this service's getThresholds() output -- that integration has been
  // live since the Phase 5-7 pass, not a future step.
  void episodePercentileService.warmupAll().catch((err) => log.error(`[PERCENTILES] warmupAll failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`));
  // Sep 17 2026 (Karo), operator-requested Section C -- LOX's OWN
  // low-frequency percentile refresh, independent of V3/V5 close events.
  loxPercentileRefreshLifecycle.start();
  // Sep 17 2026 (Karo), operator-requested Sections L/M/O -- periodic
  // position-lifecycle reconciliation (termination detection + mandatory
  // cleanup + multi-user global close), reusing each user's own existing
  // Binance client, no new stream.
  liquidationOiPositionLifecycle.start();
  // Sep 8 2026 (Karo) -- starts the 60s flush timer, AFTER ws.start()
  // (matching old app.ts's own ordering exactly -- "runs after WS so
  // live data flow is never blocked by Mongo index creation").
  liqAggregateOrchestrator.start();
  wallAggregateOrchestrator.start();
  log.info(`liquidation-detector started -- ${symbols.length} symbols, ${userRuntimes.filter((r) => r.config.enabled).length} enabled user(s)`);

  process.on("SIGINT", async () => {
    log.info("shutting down (SIGINT)");
    reconciliation.stop();
    orchestrator.stop();
    spotWs.stop();
    loxPercentileRefreshLifecycle.stop();
    liquidationOiPositionLifecycle.stop();
    await liqAggregateOrchestrator.stop();
    await wallAggregateOrchestrator.stop();
    await mongo.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    log.info("shutting down (SIGTERM)");
    reconciliation.stop();
    orchestrator.stop();
    spotWs.stop();
    loxPercentileRefreshLifecycle.stop();
    liquidationOiPositionLifecycle.stop();
    await liqAggregateOrchestrator.stop();
    await wallAggregateOrchestrator.stop();
    await mongo.close();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, "[FATAL_STARTUP_ERROR]");
  process.exit(1);
});
