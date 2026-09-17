import { randomUUID } from "crypto";
import { BinanceWsClient } from "../infrastructure/binance/binanceWs.client";
import {
  V5WaveService,
  type V5TickOutcome,
  type V5TradeCloseEvent,
} from "../strategy/v5/v5-wave.service";
import { OiTrackerService } from "../domain/liquidation/oi-tracker.service";
import { OiSecondObservationRepository, OI_SECOND_OBSERVATION_TTL_SECONDS } from "../infrastructure/mongo/oi-second-observation.repository";
import { LiquidationOiRuntimeOrchestrator } from "./liquidation-oi-runtime-orchestrator";
import { buildPercentileContext } from "../domain/liquidation-oi-strategy/percentile-rank-approximation";
import { FundingStatsService } from "../domain/liquidation/funding-stats.service";
import { FundingRateService } from "../domain/liquidation/funding-rate.service";
import { LiquidationStore } from "../domain/liquidation/liquidation.store";
import { LiquidationStatsService } from "../domain/liquidation/liquidation-stats.service";
import { LiqFeedWatchdogService } from "../domain/liquidation/liq-feed-watchdog.service";
import { WallTrackerService } from "../domain/liquidation/wall-tracker.service";
import { CandleStore } from "../domain/market/candle.store";
import { TradeStore } from "../domain/market/trade.store";
import { OrderbookStore } from "../domain/market/orderbook.store";
import { ATRTrackerService } from "../domain/market/atr-tracker.service";
import { AggressiveFlowService } from "../domain/liquidation/aggressive-flow.service";
import { ResearchCheckpointTracker } from "../domain/signal/research-checkpoint-tracker";
import {
  UnitResearchShadowService,
  type ShadowEntryEvent,
  type ShadowNoEntryEvent,
} from "../domain/research/unit-research-shadow.service";
import { CommonHorizonEpisodeRegistry } from "../domain/research/common-horizon-episode-registry";
import { CascadeCandidateService, type CascadeSignalReadyEvent, type CascadeCancelEvent, type WaveSummary } from "../domain/cascade/cascade-candidate.service";
import { CascadeRegistry } from "../domain/cascade/cascade-registry";
import { CascadeRepository } from "../infrastructure/mongo/cascade.repository";
import type { CascadeCandidateStateDoc } from "../domain/cascade/cascade.model";
import { terminalReasonText } from "../domain/cascade/cascade.model";
import type {
  GlobalSignalDoc,
  UnitResearchCandidateDoc,
  CommonHorizonCandidateDoc,
} from "../domain/signal/global-signal.model";
import type { Side, Liquidation } from "../shared/common.types";
import { deriveLiquidationPhysicsTradePlan } from "../domain/trading/liquidation-physics-trade-plan";
import { deriveEpisodeDisplacementTradePlan } from "../domain/trading/episode-displacement-trade-plan";
import { computeWaveEfficiencyAnalysis } from "../domain/trading/wave-efficiency-analysis";
import { deriveLastTwoWaveTradePlan } from "../domain/trading/last-two-wave-trade-plan";
import { CandlePhysicsEngine, type CompletedWaveSummary } from "../domain/cascade/candle-physics-engine";
import { evaluateDragon } from "../domain/research/unit-competition-dragon";
import type { V5Wave } from "../strategy/v5/v5-wave.model";
import { DirectionalAtrTracker } from "../strategy/v5/directional-atr";
import { v5EntryMode, v5RotationSlPct, v5RotationTpPct } from "../strategy/v5/v5.config";
import type { SignalDistributor } from "./signal-distributor";
import type { ReconciliationManager } from "./reconciliation-manager";
import type { MongoClientWrapper } from "../infrastructure/mongo/mongo.client";
import { GlobalSignalRepository } from "../infrastructure/mongo/global-signal.repository";
import { RotationEpisodeHistoryRepository } from "../infrastructure/mongo/rotation-episode-history.repository";
import { RawLiquidationEventRepository } from "../infrastructure/mongo/raw-liquidation-event.repository";
import { buildMarketSnapshot } from "../domain/liquidation/liquidation-market-snapshot.builder";
import { formatV5CloseMessage } from "../infrastructure/telegram/signal.formatter";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "market-data-orchestrator" });

/**
 * Sep 8 2026 (Karo). WS subscribe options and per-stream routing are
 * REUSED, identical, from liqwatch-bot's own app.ts ws.subscribe()/
 * ws.on(...) block: kline[15m,5m] -> ATRTrackerService, aggTrade ->
 * aggressive-flow, bookTicker -> V5WaveService.onTick() +
 * ReconciliationManager.onTick(), liquidation -> LiquidationStore +
 * LiquidationStatsService + V5WaveService.onLiquidation(), orderbook ->
 * WallTrackerService.
 *
 * Sep 8 2026 (Karo) -- MAIN/GLOBAL canonical lifecycle, restored + new
 * feature (see the operator-requested audit this was built from,
 * confirmed precisely what the old bot did vs never did):
 *   1. RESTORED: V5WaveService.onPriceTickForTrades() is wired into
 *      the bookTicker flow -- this is MAIN's OWN market-price-based
 *      TP/SL close detection, confirmed present in the old app.ts
 *      (handleV5Tick -> onPriceTickForTrades -> handleV5TradeClose ->
 *      v5Repo.finalize(...) + telegram.sendMessage(...)) but NEVER
 *      wired anywhere in this project until now -- meaning
 *      GlobalSignalDoc.status stayed "SIGNAL" forever, for every
 *      signal, permanently. Completely independent of any user's own
 *      Binance reconciliation: this class never calls
 *      V5WaveService.markTradeLive() on the shared instance, so
 *      onPriceTickForTrades()'s own `if (trade.isLive) continue`
 *      guard never skips a MAIN close for this reason -- confirmed via
 *      that method's own source. MAIN's own close notification uses
 *      ONLY mainTelegram (the "main" user's own dedicated telegram
 *      config), NEVER a broadcast to every user -- operator-corrected
 *      invariant: "USER CLOSE != MAIN CLOSE, MAIN CLOSE != USER
 *      CLOSE", confirmed via a real production trace that user-side
 *      closes already correctly never touched MAIN's own record.
 *   2. NEW FEATURE (confirmed the old bot never had this either, per
 *      the same audit): mainSymbolLocks blocks a NEW canonical watch
 *      from starting for a symbol that already has an OPEN MAIN
 *      signal. Scoped ENTIRELY to this class's own in-memory state --
 *      never reads or is affected by any UserSignalDoc (karo/artak's
 *      own OPEN/CLOSED state never unlocks or blocks MAIN; see
 *      reconcile-user-position.usecase.ts, which has no reference to
 *      this class or to GlobalSignalRepository at all).
 */
/** Sep 10 2026 (Karo), operator-requested common-horizon-4h-v1 research.
 *  Wilder ATR periods chosen so all three candidates represent roughly
 *  the SAME ~4h volatility horizon (period x interval-minutes ~= 240min
 *  for every candidate): 1m x240=240min, 3m x80=240min, 5m x48=240min. */
const COMMON_HORIZON_PERIODS = { atr1m: 240, atr3m: 80, atr5m: 48 } as const;

export class MarketDataOrchestrator {
  readonly liquidationStore = new LiquidationStore();
  readonly liquidationStats: LiquidationStatsService;
  readonly liqFeedWatchdog: LiqFeedWatchdogService;
  /** Sep 17 2026 (Karo), operator-reported CRITICAL FIX -- the
   *  bookTicker handler below calls liquidationOiOrchestrator.onTick()
   *  with `void` (fire-and-forget), and onTick()/onActiveTick() does
   *  multiple sequential Mongo round-trips. During a fast price move,
   *  bookTicker ticks for the SAME symbol can arrive faster than one
   *  full onTick() cycle completes, so MULTIPLE overlapping calls for
   *  the same symbol were racing each other -- confirmed as the
   *  mechanism behind two live production symptoms: a strategy-
   *  invalidation exit firing far past the actual crossing price (an
   *  intermediate tick's result got overwritten by a
   *  later-arriving-but-earlier-finishing call), and some users'
   *  CLOSE Telegram silently missing (two concurrent
   *  requestGlobalMarketExit() fan-outs for the same signal racing on
   *  the same user rows, one losing a write and throwing into the
   *  per-user try/catch that isolates other users). Per-symbol
   *  serialization: a new LOX tick for a symbol is DROPPED (never
   *  queued) if a previous one for that same symbol is still in
   *  flight -- correct for a live tick feed, since only the freshest
   *  price matters and a queued backlog would itself cause the same
   *  kind of staleness this is meant to prevent. */
  private readonly loxTickInFlight = new Set<string>();
  readonly wallTracker: WallTrackerService;
  readonly candleStore = new CandleStore();
  readonly tradeStore = new TradeStore();
  readonly orderbookStore = new OrderbookStore();
  readonly atrTracker = new ATRTrackerService();
  readonly oiTracker: OiTrackerService;
  /** Sep 16 2026 (Karo), operator-requested -- data collection only.
   *  See oi-second-observation.repository.ts's own module doc
   *  comment. */
  readonly oiSecondObservationRepo: OiSecondObservationRepository;
  /** Sep 15 2026 (Karo), operator-requested -- discovered during this
   *  wiring that neither FundingStatsService nor FundingRateService
   *  was actually instantiated anywhere in the running bot despite
   *  both classes being fully built (research-only, shadow telemetry,
   *  per their own doc comments). Wired here for the first time,
   *  following the exact same construction pattern as oiTracker
   *  above. FundingRateService self-starts its own timer in its
   *  constructor (matching OiTrackerService); FundingStatsService
   *  requires an explicit start() call, issued in this.start() below. */
  private readonly fundingStats: FundingStatsService;
  private readonly fundingRate: FundingRateService;
  readonly aggressiveFlow = new AggressiveFlowService();
  readonly researchCheckpoints = new ResearchCheckpointTracker();
  private readonly shadow3m = new UnitResearchShadowService((symbol, victim) =>
    this.liquidationStats.notionalPercentile(symbol, victim, 95),
  );
  private readonly shadow5m = new UnitResearchShadowService((symbol, victim) =>
    this.liquidationStats.notionalPercentile(symbol, victim, 95),
  );
  private readonly shadowCheckpoints3m = new ResearchCheckpointTracker([
    { label: "30s", ms: 30_000 },
    { label: "1m", ms: 60_000 },
    { label: "3m", ms: 3 * 60_000 },
    { label: "5m", ms: 5 * 60_000 },
    { label: "15m", ms: 15 * 60_000 },
    { label: "30m", ms: 30 * 60_000 },
  ]);
  private readonly shadowCheckpoints5m = new ResearchCheckpointTracker([
    { label: "30s", ms: 30_000 },
    { label: "1m", ms: 60_000 },
    { label: "3m", ms: 3 * 60_000 },
    { label: "5m", ms: 5 * 60_000 },
    { label: "15m", ms: 15 * 60_000 },
    { label: "30m", ms: 30 * 60_000 },
  ]);
  private readonly competitionShadow1m = new UnitResearchShadowService(
    (symbol, victim) =>
      this.liquidationStats.notionalPercentile(symbol, victim, 95),
  );
  private readonly competitionShadow3m = new UnitResearchShadowService(
    (symbol, victim) =>
      this.liquidationStats.notionalPercentile(symbol, victim, 95),
  );
  private readonly competitionShadow5m = new UnitResearchShadowService(
    (symbol, victim) =>
      this.liquidationStats.notionalPercentile(symbol, victim, 95),
  );
  private readonly competitionCheckpoints1m = new ResearchCheckpointTracker([
    { label: "30s", ms: 30_000 },
    { label: "1m", ms: 60_000 },
    { label: "3m", ms: 3 * 60_000 },
    { label: "5m", ms: 5 * 60_000 },
    { label: "15m", ms: 15 * 60_000 },
    { label: "30m", ms: 30 * 60_000 },
  ]);
  private readonly competitionCheckpoints3m = new ResearchCheckpointTracker([
    { label: "30s", ms: 30_000 },
    { label: "1m", ms: 60_000 },
    { label: "3m", ms: 3 * 60_000 },
    { label: "5m", ms: 5 * 60_000 },
    { label: "15m", ms: 15 * 60_000 },
    { label: "30m", ms: 30 * 60_000 },
  ]);
  private readonly competitionCheckpoints5m = new ResearchCheckpointTracker([
    { label: "30s", ms: 30_000 },
    { label: "1m", ms: 60_000 },
    { label: "3m", ms: 3 * 60_000 },
    { label: "5m", ms: 5 * 60_000 },
    { label: "15m", ms: 15 * 60_000 },
    { label: "30m", ms: 30 * 60_000 },
  ]);
  private readonly competitionCandidateStatus = new Map<
    string,
    Map<
      "atr1m" | "atr3m" | "atr5m",
      { status: "TRACKING" | "PASS" | "FAIL" | "CANCEL"; detail?: string }
    >
  >();
  private readonly competitionWinners = new Map<
    string,
    {
      signalId: string;
      symbol: string;
      side: Side;
      candidate: "atr1m" | "atr3m" | "atr5m";
      entry: number;
      tp: number;
      sl: number;
      rr: number;
      entryTs: number;
      maxFavorable: number;
      maxAdverse: number;
    }
  >();
  private readonly globalSignalRepo: GlobalSignalRepository;
  private readonly rotationEpisodeHistoryRepo: RotationEpisodeHistoryRepository;
  private readonly cascadeRepo: CascadeRepository;
  private readonly rawLiquidationEventRepo: RawLiquidationEventRepository;
  private readonly mainSymbolLocks = new Set<string>();
  /** Sep 10 2026 (Karo), operator-requested production V5 multi-
   *  timeframe cascade lifecycle. PURELY ADDITIVE -- three independent
   *  candidate state machines (1m/3m/5m, frozen common-horizon UNITs)
   *  + a symbol-level registry gating "one active cascade per symbol".
   *  Fed via feedCascade() below, called ADDITIVELY from the SAME
   *  liquidation handler that already exists in start() -- nothing
   *  existing is removed or rewired. Each candidate's own signal-ready
   *  result flows into the EXISTING V5 production signal path
   *  (handleTickOutcome-adjacent persistence/distribute/
   *  mainSymbolLocks, all UNCHANGED) via handleCascadeSignalReady()
   *  below -- mainSymbolLocks itself (above) is never touched by this
   *  addition; it continues to mean exactly what it always has (real
   *  MAIN Binance-position-overlap safety), completely independent of
   *  cascadeRegistry (which only governs whether a new COMPARISON
   *  cascade may start, never whether MAIN may hold a real position). */
  private readonly cascadeCandidate1m = new CascadeCandidateService();
  /** Sep 11 2026 (Karo), operator-requested -- THE production wave-
   *  decision path. cascadeCandidate1m/3m/5m above (and the OLD
   *  feedCascade()/tickCascade() call-sites) are no longer invoked
   *  from any live handler -- left in place, unused, per the
   *  operator's own "do not delete" convention. This is the ONLY
   *  engine that can now produce a live ENTRY. */
  private readonly candlePhysics = new CandlePhysicsEngine();
  /** Sep 14 2026 (Karo), operator-approved -- V5 ROTATION mode.
   *  Self-instantiated, mirroring candlePhysics's own pattern above --
   *  fed at the existing closed-1m-candle site in the kline handler
   *  (see this.ws.on("kline", ...)), read by V5WaveService via a
   *  small adapter (see main.ts's own wiring, matching the existing
   *  orchestratorPlaceholder pattern every other V5 callback uses).
   *  Genuinely separate state from atrTracker; a no-op cost if
   *  V5_ENTRY_MODE is never "ROTATION". */
  readonly directionalAtr = new DirectionalAtrTracker();
  /** Sep 15 2026 (Karo), operator-requested -- liquidation-snapshot
   *  enrichment's 3m/5m directional ATR. Genuinely separate state
   *  from `directionalAtr` above (the 1m instance, which continues
   *  to serve V5 ROTATION unchanged) -- fed at the existing 3m/5m
   *  kline-close sites already present in this.ws.on("kline", ...)
   *  for the standard (non-directional) ATR; no new subscription. */
  /** Sep 16 2026 (Karo), operator-approved -- made readonly (public),
   *  matching directionalAtr's own visibility above, so the restart/
   *  redeploy candle bootstrap can seed these from REST at startup the
   *  same way it already reaches candleStore/atrTracker/directionalAtr.
   *  No behavior change to either tracker -- visibility only. */
  readonly directionalAtr3m = new DirectionalAtrTracker();
  readonly directionalAtr5m = new DirectionalAtrTracker();
  private readonly cascadeCandidate3m = new CascadeCandidateService();
  private readonly cascadeCandidate5m = new CascadeCandidateService();
  private readonly cascadeRegistry = new CascadeRegistry(this.cascadeCandidate1m, this.cascadeCandidate3m, this.cascadeCandidate5m);
  private readonly mainTelegram: {
    sendMessage: (text: string) => Promise<unknown>;
  } | null;

  constructor(
    private readonly ws: BinanceWsClient,
    private readonly symbols: string[],
    private readonly v5: V5WaveService,
    private readonly distributor: SignalDistributor,
    private readonly reconciliation: ReconciliationManager,
    private readonly mongo: MongoClientWrapper,
    liquidationStatsConfig: ConstructorParameters<
      typeof LiquidationStatsService
    >[0],
    wallTrackerConfig: ConstructorParameters<typeof WallTrackerService>[0],
    broadcastTelegram: {
      sendMessage: (text: string) => Promise<unknown>;
    } | null = null,
    mainTelegram: {
      sendMessage: (text: string) => Promise<unknown>;
    } | null = null,
    // Sep 17 2026 (Karo), operator-reported CRITICAL SAFETY FIX -- this
    // previously defaulted to `true` (FAIL-OPEN): if this constructor
    // parameter were ever omitted or dropped by a positional-argument
    // mismatch, V5 production signals would silently re-enable.
    // Confirmed by source audit that main.ts's actual call correctly
    // passes process.env.V5_PRODUCTION_SIGNALS_ENABLED === "true"
    // (which is false unless that env var is literally the string
    // "true") at this exact position -- the WIRING itself is correct.
    // This default change is defense-in-depth (FAIL-CLOSED), not a fix
    // to a wiring bug. NOTE: this audit was performed against a local
    // clone with no live Mongo/.env access -- it cannot confirm what
    // V5_PRODUCTION_SIGNALS_ENABLED is actually set to in the deployed
    // VPS environment, nor query live V5 Mongo collections for
    // existing ACTIVE signals/positions. That must be checked directly
    // on the VPS.
    private readonly productionSignalsEnabled: boolean = false,
    /** Sep 16 2026 (Karo), operator-approved architecture --
     *  Liquidation+OI Exhaustion strategy. Both null by default,
     *  meaning the strategy is completely inert unless main.ts
     *  explicitly constructs and passes both. When
     *  liquidationOiOrchestrator is provided, its OWN internal
     *  observationEnabled/executionEnabled flags (constructed
     *  separately, executionEnabled defaulting false) govern whether
     *  it does anything and whether it can ever reach Binance -- this
     *  orchestrator never checks or overrides those flags itself, it
     *  only forwards real events/ticks when the reference is non-null. */
    private readonly liquidationOiOrchestrator: LiquidationOiRuntimeOrchestrator | null = null,
    private readonly episodePercentileServiceForLox: { getThresholds(symbol: string): { long: { p90: number | null; p95: number | null; p99: number | null; sampleCount: number }; short: { p90: number | null; p95: number | null; p99: number | null; sampleCount: number } } | null } | null = null,
  ) {
    this.liquidationStats = new LiquidationStatsService(liquidationStatsConfig);
    this.wallTracker = new WallTrackerService(wallTrackerConfig);
    this.liqFeedWatchdog = new LiqFeedWatchdogService(log, broadcastTelegram);
    this.oiSecondObservationRepo = new OiSecondObservationRepository(mongo);
    this.oiTracker = new OiTrackerService(
      symbols,
      (obs) => this.oiSecondObservationRepo.bufferedInsert({
        symbol: obs.symbol,
        timestamp: new Date(obs.fetchedAt),
        oiUpdatedAt: obs.oiUpdatedAtMs !== null ? new Date(obs.oiUpdatedAtMs) : null,
        openInterest: obs.contracts,
        openInterestUsd: obs.price !== null ? obs.contracts * obs.price : null,
        price: obs.price,
      }),
      (symbol) => this.orderbookStore.midPrice(symbol),
    );
    this.fundingStats = new FundingStatsService(symbols);
    this.fundingRate = new FundingRateService(symbols);
    log.info(
      { symbols: symbols.length },
      "[market-snapshot] enrichment components initialized -- taker-flow history(5m), order-book+price history(5m), OI tracker, funding-rate tracker, directional ATR 1m/3m/5m, enriched liquidation snapshot enabled",
    );
    this.globalSignalRepo = new GlobalSignalRepository(mongo);
    this.rotationEpisodeHistoryRepo = new RotationEpisodeHistoryRepository(mongo);
    this.cascadeRepo = new CascadeRepository(mongo);
    this.rawLiquidationEventRepo = new RawLiquidationEventRepository(mongo);
    this.mainTelegram = mainTelegram;
    // Sep 10 2026 (Karo), operator-requested: feedUnitResearchShadowAfter()
    // and tickUnitResearchShadow() are DISCONNECTED from live event
    // processing (their own call-sites in start() are commented out) --
    // neither method is deleted, per the operator's own explicit
    // instruction. This line exists ONLY to satisfy the unused-method
    // typecheck without calling either method or removing any code.
    void this.feedUnitResearchShadowAfter;
    void this.tickUnitResearchShadow;
    // Sep 11 2026 (Karo), operator-requested -- the OLD 1x-UNIT-
    // recovery cascade engine's own entry points are disconnected too
    // (see candlePhysics, the new production path, above); neither
    // method is deleted, per the operator's own explicit instruction.
    void this.feedCascade;
    void this.tickCascade;
  }

  async ensureIndexes(): Promise<void> {
    await this.rawLiquidationEventRepo.ensureIndexes();
    // Sep 10 2026 (Karo), operator-reported CRITICAL FIX -- unique
    // index on cascadeId, see CascadeRepository.ensureIndexes()'s own
    // doc comment for the duplicate-cascade-document race it fixes.
    await this.cascadeRepo.ensureIndexes();
    // Sep 16 2026 (Karo), operator-requested -- data collection only.
    const oiIndexesOk = await this.oiSecondObservationRepo.ensureIndexes();
    if (oiIndexesOk) log.info(`[TTL] oi_second_observations timestamp = ${OI_SECOND_OBSERVATION_TTL_SECONDS}s (${OI_SECOND_OBSERVATION_TTL_SECONDS / 86400}d)`);
  }

  async hydrateMainLocks(): Promise<void> {
    const openDocs = await this.globalSignalRepo.findOpenMainSignals();
    let hydrated = 0;
    let skippedComparisonOnly = 0;
    for (const doc of openDocs) {
      if (doc.entry === null || doc.tp === null || doc.sl === null) continue;
      // Sep 10 2026 (Karo), operator-requested production lifecycle
      // stabilization -- a single cascade can leave MULTIPLE
      // status="SIGNAL" documents (1m/3m/5m each independently
      // reaching SIGNAL_READY), but only ONE of them (isMainExecuted)
      // is MAIN's own real, executed position; the others are
      // Sep 10 2026 (Karo), operator-reported CRITICAL FIX -- root
      // cause of the "DOGE 3m CLOSE with no 3m ENTER" class of bug.
      // The earlier version of this filter treated ANY doc with
      // isMainExecuted===undefined as "genuinely executed" for
      // backward compatibility -- correct for a LEGACY, non-cascade
      // signal (cascadeId===null, where every status="SIGNAL" doc
      // truly was the real, executed one), but WRONG for an OLD
      // CASCADE signal (cascadeId!==null) persisted before this field
      // existed: such a doc could easily have been a comparison-only
      // signal that correctly never got an ENTER Telegram (mainSymbolLocks
      // was already held by another candidate at the time), yet the old
      // filter would still hydrate it into activeTrades on the next
      // restart -- eventually producing a CLOSE notification for a
      // signal that never had a matching ENTER. For a cascade signal,
      // ONLY an EXPLICIT isMainExecuted===true is hydrated; undefined
      // is now treated the SAME as false (skip) for cascade signals
      // specifically -- the safe direction to err in, since a wrongly-
      // skipped real trade is far less harmful than a phantom
      // CLOSE-without-ENTER. Legacy (cascadeId===null) signals keep the
      // ORIGINAL, still-correct undefined-means-executed behavior.
      const isCascadeSignal = doc.cascadeId !== null;
      const shouldSkip = isCascadeSignal ? doc.isMainExecuted !== true : doc.isMainExecuted === false;
      if (shouldSkip) {
        skippedComparisonOnly++;
        continue;
      }
      this.mainSymbolLocks.add(doc.symbol);
      this.v5.hydrateActiveTrade({
        signalId: doc.signalId,
        symbol: doc.symbol,
        victim: doc.victim,
        side: doc.side,
        entry: doc.entry,
        tp: doc.tp,
        sl: doc.sl,
        openedAt: doc.signalTs,
        bestPrice: doc.entry,
        worstPrice: doc.entry,
        entryWaveNumber: doc.entryWaveNumber,
        isLive: false,
        binanceSlOrderId: null,
        binanceTpOrderId: null,
        positionQty: null,
        notional: null,
        riskUsd: null,
        timeframe: doc.timeframe,
      });
      hydrated++;
    }
    log.info(
      `[MAIN_LOCKS_HYDRATED] ${hydrated} open MAIN signal(s) restored from Mongo (${skippedComparisonOnly} comparison-only cascade signal(s) correctly skipped), symbols locked: [${[...this.mainSymbolLocks].join(", ")}]`,
    );
  }

  /** Sep 10 2026 (Karo), operator-requested restart-safe persistence
   *  for the production V5 multi-timeframe cascade lifecycle. Call
   *  once at startup, BEFORE orchestrator.start() (same ordering
   *  requirement as hydrateMainLocks() -- WS ticks must never race
   *  this). Loads every persisted status="ACTIVE" cascade document and
   *  rebuilds CascadeRegistry's own ownership + each candidate's own
   *  exact internal state (frozen UNIT, full wave history including
   *  each wave's own ACTIVE/COMPLETED state, current extreme, current
   *  phase) via restoreWatch() -- a candidate whose own persisted
   *  phase is already TERMINAL_SIGNAL/TERMINAL_CANCEL is intentionally
   *  NOT restored into the live state machine (it produced its own
   *  final result already; there is nothing to resume), but its own
   *  terminal fact is what keeps the OTHER, still-active candidates'
   *  own cascade correctly blocked from a fresh start until they too
   *  finish. */
  async hydrateActiveCascades(): Promise<void> {
    const activeCascades = await this.cascadeRepo.findActiveCascades();
    let restoredCandidates = 0;
    for (const doc of activeCascades) {
      this.cascadeRegistry.restoreOwnership(doc.symbol, doc.cascadeId, doc.startedAt, doc.victimSide);
      for (const [timeframe, service] of [
        ["1m", this.cascadeCandidate1m],
        ["3m", this.cascadeCandidate3m],
        ["5m", this.cascadeCandidate5m],
      ] as const) {
        const candidateDoc = doc.candidates[timeframe];
        if (candidateDoc.phase !== "ACTIVE") continue;
        if (candidateDoc.frozenUnitAbs === null) continue;
        service.restoreWatch(doc.symbol, doc.victimSide, {
          cascadeId: doc.cascadeId,
          timeframe,
          unitAbs: candidateDoc.frozenUnitAbs,
          waves: candidateDoc.waveHistory,
          createdAt: doc.startedAt,
        });
        restoredCandidates++;
      }
    }
    log.info(
      `[CASCADES_HYDRATED] ${activeCascades.length} active cascade(s), ${restoredCandidates} candidate(s) resumed from Mongo, symbols locked: [${activeCascades.map((c) => c.symbol).join(", ")}]`,
    );
  }

  /** Sep 14 2026 (Karo), operator-reported CRITICAL FIX -- see
   *  V5WaveService.getSymbolsWithNonLiveActiveTrades()'s own doc
   *  comment for the full root-cause writeup. Updated on EVERY
   *  bookTicker tick this orchestrator sees (mirroring
   *  ReconciliationManager's own identical lastKnownPrice pattern),
   *  so the fallback timer below always has the freshest price
   *  available even for a symbol whose own ticks have gone quiet. */
  private readonly lastKnownPriceForMain = new Map<string, number>();
  /** Same interval as ReconciliationManager's own FALLBACK_RECONCILE_MS
   *  -- no reason for these two, structurally-identical safety nets to
   *  disagree on cadence. */
  private static readonly MAIN_CLOSE_FALLBACK_MS = 3_000;

  /** Sep 15 2026 (Karo), operator-requested -- graceful shutdown for
   *  the REST-polling services this class owns. Discovered while
   *  wiring fundingStats/fundingRate that oiTracker's own timer was
   *  ALREADY never explicitly stopped anywhere (main.ts's SIGINT/
   *  SIGTERM handlers call process.exit(0) immediately after, which
   *  does kill pending timers regardless -- so this was never a
   *  functional hang -- but it's inconsistent with the explicit
   *  .stop() pattern every other lifecycle-owning service in main.ts
   *  already follows). Call from main.ts's shutdown handlers,
   *  alongside reconciliation.stop()/liqAggregateOrchestrator.stop().
   *  FundingRateService (like oiTracker) has no async work to await --
   *  stop() on all three is synchronous, clearing their own timers. */
  stop(): void {
    this.oiTracker.stop();
    this.oiSecondObservationRepo.stop();
    this.fundingStats.stop();
    this.fundingRate.stop();
  }

  start(): void {
    // Sep 15 2026 (Karo), operator-requested -- see this.fundingStats's
    // own field doc comment for why this call is new. FundingRateService
    // needs no equivalent call -- it self-starts in its constructor.
    this.fundingStats.start();
    this.ws.subscribe({
      symbols: this.symbols,
      intervals: ["15m", "5m", "3m", "1m"],
      aggTrade: true,
      bookTicker: true,
      depth: true,
      forceOrder: true,
    });

    this.ws.on("open", () => log.info("[ws] streams connected"));
    this.ws.on("close", (code) => log.warn({ code }, "[ws] streams closed"));
    this.ws.on("error", (err) => log.error({ err: err.message }, "[ws] error"));

    this.ws.on("kline", (c) => {
      this.atrTracker.onCandle(c);
      this.candleStore.ingest(c);
      // Sep 15 2026 (Karo), operator-requested -- liquidation-snapshot
      // enrichment's 3m/5m directional ATR. Fed here, at the SAME
      // kline-close event already driving atrTracker.onCandle() above
      // -- no new subscription. onCandle() itself rejects any candle
      // that is not fully closed, so this is a no-op for forming
      // candles regardless of the isClosed check below.
      if (c.interval === "3m" && c.isClosed) this.directionalAtr3m.onCandle(c);
      if (c.interval === "5m" && c.isClosed) this.directionalAtr5m.onCandle(c);
      // Sep 11 2026 (Karo), operator-requested -- THE production wave
      // engine now runs on CLOSED 1m candles only, for both victim
      // sides of this symbol. onClosedCandle() is a cheap no-op for
      // any (symbol,victim) with no active watch.
      if (c.interval === "1m" && c.isClosed) {
        // Sep 14 2026 (Karo), operator-approved -- V5 ROTATION mode.
        // Fed at the SAME closed-1m-candle site as candlePhysics above
        // -- no new candle subscription, no new pipeline. Genuinely
        // separate state from atrTracker/candlePhysics; a no-op if
        // ROTATION mode is never enabled (this.directionalAtr is
        // still constructed unconditionally, cheap, isolated).
        this.directionalAtr.onCandle(c);
        for (const victim of ["LONG", "SHORT"] as const) {
          const currentP95 = this.liquidationStats.notionalPercentile(c.symbol, victim, 95);
          // Sep 14 2026 (Karo), operator-approved -- ROTATION mode.
          // Only bother computing these when the watch is actually a
          // ROTATION watch (peekWatch is a cheap synchronous map read)
          // -- zero extra cost for WAVE-mode watches, which is the
          // overwhelming majority of traffic today.
          const existingWatch = this.candlePhysics.peekWatch(c.symbol, victim);
          let rotDownAtr: number | null = null, rotUpAtr: number | null = null, rotDownSlope: number | null = null, rotUpSlope: number | null = null;
          if (existingWatch?.mode === "ROTATION") {
            rotDownAtr = this.directionalAtr.getDownAtr(c.symbol);
            rotUpAtr = this.directionalAtr.getUpAtr(c.symbol);
            if (existingWatch.preLiqDownAtr !== null) rotDownSlope = this.directionalAtr.getDownSlopeNormalized(c.symbol, 2, existingWatch.preLiqDownAtr);
            if (existingWatch.preLiqUpAtr !== null) rotUpSlope = this.directionalAtr.getUpSlopeNormalized(c.symbol, 2, existingWatch.preLiqUpAtr);
          }
          const result = this.candlePhysics.onClosedCandle(c.symbol, victim, c.openTime, c.open, c.high, c.low, c.close, currentP95, rotDownAtr, rotUpAtr, rotDownSlope, rotUpSlope);
          if (result?.kind === "ENTRY") void this.handleCandlePhysicsEntry(result);
          else if (result?.kind === "CANCEL") void this.handleCandlePhysicsCancel(result);
          else if (result?.kind === "PRE_W1_DISCARD") this.handleCandlePhysicsPreW1Discard(result);
        }
      }
    });

    this.ws.on("liquidation", (l) => {
      this.liqFeedWatchdog.recordEvent(l.symbol);
      this.liquidationStore.ingest(l);
      this.liquidationStats.ingest(l);
      // Sep 15 2026 (Karo), operator-requested -- market-state
      // enrichment. Computed AFTER liquidationStore.ingest(l) above so
      // the rolling liquidation-context windows correctly include this
      // very event (matching the "cumulative includes current event"
      // convention this whole research thread has used throughout).
      // Wrapped defensively: buildMarketSnapshot() is pure/synchronous
      // and should never throw, but a second line of defense here
      // guarantees the base liquidation write (below) NEVER fails or
      // blocks because of anything in the enrichment path.
      let marketSnapshot: Record<string, unknown> | undefined;
      try {
        marketSnapshot = buildMarketSnapshot(
          {
            aggressiveFlow: this.aggressiveFlow, oiTracker: this.oiTracker, orderbookStore: this.orderbookStore,
            wallTracker: this.wallTracker, candleStore: this.candleStore, liquidationStore: this.liquidationStore,
            atrTracker: this.atrTracker, directionalAtr1m: this.directionalAtr, directionalAtr3m: this.directionalAtr3m, directionalAtr5m: this.directionalAtr5m,
            fundingStats: this.fundingStats, fundingRate: this.fundingRate,
          },
          l, l.timestamp,
        );
        const ms = marketSnapshot as { openInterest: { oiAgeMs: number | null }; positioning: { positioningAgeMs: number | null }; funding: { fundingAgeMs: number | null } };
        log.debug(
          { symbol: l.symbol, victim: l.side === "SELL" ? "LONG" : "SHORT", quoteQty: l.quoteQty, oiAgeMs: ms.openInterest.oiAgeMs, positioningAgeMs: ms.positioning.positioningAgeMs, fundingAgeMs: ms.funding.fundingAgeMs },
          "[market-snapshot] enriched liquidation event saved",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, symbol: l.symbol }, "[MARKET_SNAPSHOT_BUILD_FAILED] -- base liquidation write proceeds without enrichment");
        marketSnapshot = undefined;
      }
      void this.rawLiquidationEventRepo.insert({
        symbol: l.symbol,
        victim: l.side === "SELL" ? "LONG" : "SHORT",
        price: l.price,
        quoteQty: l.quoteQty,
        timestamp: l.timestamp,
        ...(marketSnapshot !== undefined ? { marketSnapshot } : {}),
      });
      const victimForShadow: Side = l.side === "SELL" ? "LONG" : "SHORT";
      // Sep 16 2026 (Karo), operator-approved architecture --
      // Liquidation+OI Exhaustion strategy. Fed regardless of
      // mainSymbolLocks (same convention as candlePhysics.onLiquidation
      // above) -- this strategy's OWN symbol ownership
      // (SymbolOwnershipRegistry, inside LiquidationOiWatchManager) is
      // completely independent of mainSymbolLocks. No-op entirely when
      // liquidationOiOrchestrator is null (default) or its own
      // observationEnabled is false.
      if (this.liquidationOiOrchestrator !== null) {
        const oiSnap = this.oiTracker.getCachedOI(l.symbol);
        this.liquidationOiOrchestrator.onLiquidationEvent(
          { symbol: l.symbol, victim: victimForShadow, timestamp: l.timestamp, price: l.price, quoteQty: l.quoteQty },
          oiSnap !== null ? { quantity: oiSnap.contracts, timestamp: oiSnap.ts } : null,
        );
      }
      // Sep 11 2026 (Karo), operator-requested -- THE production wave
      // engine. Replaces the OLD feedCascade() call entirely (removed
      // below, left commented per the operator's own "do not delete"
      // convention). Fed regardless of mainSymbolLocks, same
      // convention as before -- willExecuteAsMain is decided inside
      // handleCandlePhysicsEntry() at the moment of entry, not here.
      const unit1m = this.commonHorizonAtrReady(l.symbol) ? this.atrTracker.getWilderATR(l.symbol, "1m", COMMON_HORIZON_PERIODS.atr1m) : null;
      if (unit1m !== null && unit1m > 0) {
        // Sep 14 2026 (Karo), operator-approved -- ROTATION mode.
        // Mode is read fresh here but only matters for a NEW watch
        // (frozen thereafter inside the engine itself -- see
        // Watch.mode's own doc comment). preLiq baselines are only
        // read/used when this liquidation is about to open a brand
        // new watch in ROTATION mode; harmless (and unread) otherwise.
        const entryMode = v5EntryMode();
        const preLiqDownAtr = entryMode === "ROTATION" ? this.directionalAtr.getDownAtr(l.symbol) : null;
        const preLiqUpAtr = entryMode === "ROTATION" ? this.directionalAtr.getUpAtr(l.symbol) : null;
        const isNewWatch = entryMode === "ROTATION" && this.candlePhysics.peekWatch(l.symbol, victimForShadow) === null;
        this.candlePhysics.onLiquidation(l.symbol, victimForShadow, l, unit1m, l.price, l.timestamp, entryMode, preLiqDownAtr, preLiqUpAtr);
        // Sep 14 2026 (Karo), operator-approved -- ROTATION mode.
        // Fire-and-forget causal P95 lookup, kicked off exactly once
        // per new watch (checked BEFORE onLiquidation() creates it,
        // above). Writes onto the SAME watch via setRotationCausalP95()
        // once resolved -- a harmless no-op if the watch has since
        // expired/entered. onLiquidation()/onClosedCandle() stay
        // synchronous; this never blocks either.
        if (isNewWatch) {
          this.getRotationCausalP95(l.symbol, victimForShadow, l.timestamp)
            .then((res) => this.candlePhysics.setRotationCausalP95(l.symbol, victimForShadow, res.p95, res.sampleCount))
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              log.error({ symbol: l.symbol, victim: victimForShadow, err: msg }, "[ROTATION_P95_LOOKUP_FAILED]");
            });
        }
      }
      // OLD 1x-UNIT-recovery cascade engine -- DISCONNECTED, no longer
      // the production decision path. Left in place, unused, per the
      // operator's own "do not delete" convention (see
      // cascadeCandidate1m/3m/5m field declarations above).
      // void this.feedCascade(l, victimForShadow);
      if (this.mainSymbolLocks.has(l.symbol)) return;
      const wasTrackedBeforeProduction = this.wasProductionWatchTracked(
        l.symbol,
        victimForShadow,
      );
      // Sep 12 2026 (Karo), operator-requested CLEANUP -- the OLD,
      // legacy 1x-UNIT-recovery V5WaveService signal-GENERATION path
      // (this.v5.onLiquidation(), which builds/tracks its own separate
      // `watches` state and can emit TERMINAL_NON_SIGNAL outcomes like
      // CANCEL_NO_SECOND_WAVE/CASCADE_NOT_SERIOUS via handleTickOutcome()
      // -> persistTerminalNonSignal()) is DISCONNECTED here, matching
      // this project's own established "do not delete, just stop
      // calling" convention (see feedCascade/feedUnitResearchShadowAfter
      // immediately below, disconnected the exact same way). Audited
      // and confirmed safe before this change: this.v5's OWN SEPARATE
      // `activeTrades` map (hydrateActiveTrade()/onPriceTickForTrades(),
      // MAIN's own real trade CLOSE-tracking) is a COMPLETELY DIFFERENT
      // data structure, never touched by onLiquidation() or this
      // disconnection -- MAIN's own TP/SL close-detection is entirely
      // unaffected. this.v5.onTick() (bookTicker handler, below) keeps
      // running unchanged, but becomes a guaranteed no-op for its own
      // signal-generation side (its `watches` map can never be
      // populated again) since onLiquidation() no longer creates any
      // new watch -- it is left connected rather than also disconnected,
      // since its own harmless side effects (lastBtcPrice/lastPriceAt,
      // confirmed never read by anything else) are cheaper to leave
      // alone than to risk touching. getBtcWatchVictim() (used only
      // inside the old evaluateSignal(), itself only reachable from a
      // SIGNAL_CANDIDATE outcome that can now never occur) and
      // persistTerminalNonSignal() become naturally unreachable dead
      // code paths as a result -- neither needed to be touched directly.
      // const outcomes = this.v5.onLiquidation(l);
      // for (const outcome of outcomes) void this.handleTickOutcome(outcome);
      void wasTrackedBeforeProduction; // no longer consumed -- its only reader (feedUnitResearchShadowAfter) is disconnected below; kept computed, untouched, not deleted
      // Sep 10 2026 (Karo), operator-requested: old research (unitResearch
      // shadow3m/shadow5m + the earlier dragon competition) DISCONNECTED
      // from live liquidation processing -- this call, which fed live
      // events into that state machine, is intentionally never made
      // anymore. The methods/classes/fields themselves are left
      // completely untouched (per the operator's own explicit "do not
      // delete now" instruction) -- simply never invoked, so old
      // research can no longer create/update state, influence signal
      // decisions, send its own Telegram messages, declare winners, or
      // persist new results.
      // this.feedUnitResearchShadowAfter(l, wasTrackedBeforeProduction);
    });

    this.ws.on("bookTicker", (b) => {
      // Sep 15 2026 (Karo), operator-reported -- ROOT CAUSE of the
      // second causality gap: this handler was feeding v5.onTick /
      // reconciliation.onTick / etc (all unchanged below) but NEVER
      // fed orderbookStore itself -- setDepth() below (in the
      // "orderbook" handler) WAS wired, setBookTicker() never was.
      // That's why depth-derived fields (bookImbalanceChangeVs30sAgo,
      // orderBookUpdatedAt) were populated while bestBid/bestAsk/
      // midPrice/priceChange*Pct were always null: OrderbookStore's
      // causal ring/accessors were already correct (see
      // orderbook.store.ts), they simply never received any data to
      // serve. Single missing call, not a design gap.
      this.orderbookStore.setBookTicker(b);
      const mid = (b.bid + b.ask) / 2;
      this.lastKnownPriceForMain.set(b.symbol, mid);
      const outcomes = this.v5.onTick(b.symbol, mid, b.timestamp);
      for (const outcome of outcomes) void this.handleTickOutcome(outcome);
      const closes = this.v5.onPriceTickForTrades(b.symbol, mid, b.timestamp);
      for (const close of closes) void this.handleMainTradeClose(close);
      void this.reconciliation.onTick(b.symbol, mid, b.timestamp);
      this.tickResearchCheckpoints(b.symbol, mid, b.timestamp);
      // Sep 16 2026 (Karo), operator-approved architecture --
      // Liquidation+OI Exhaustion strategy. Only bothers gathering
      // percentile/ATR/OI-history context for a symbol that ALREADY
      // has a tracked lifecycle (cheap peek first) -- avoids wasted
      // work on every symbol on every single bookTicker tick. Reuses
      // the EXISTING oiTracker.getOiHistory() RAM ring (no second
      // polling loop) and the EXISTING atrTracker (already
      // bootstrapped at startup, unchanged). No-op entirely when
      // liquidationOiOrchestrator is null (default) or its own
      // observationEnabled is false.
      if (this.liquidationOiOrchestrator !== null && this.liquidationOiOrchestrator.getWatchManager().getLifecycle(b.symbol) !== null) {
        if (this.loxTickInFlight.has(b.symbol)) {
          // A previous tick for this symbol is still being processed --
          // drop this one rather than queue it (queueing would only
          // reintroduce the same staleness this guard exists to prevent).
          // The NEXT bookTicker tick, once the in-flight call completes,
          // will carry a price at least as fresh as this dropped one.
        } else {
          const lastClosed3m = this.candleStore.lastClosed(b.symbol, "3m");
          const atr3m = this.atrTracker.getWilderATRAtOrBefore(b.symbol, "3m", 14, b.timestamp);
          const atr3mAgeMs = lastClosed3m !== null ? b.timestamp - lastClosed3m.closeTime : null;
          const oiHistory = this.oiTracker.getOiHistory(b.symbol).map((s) => ({ contracts: s.contracts, fetchedAt: s.fetchedAt }));
          const lifecycle = this.liquidationOiOrchestrator.getWatchManager().getLifecycle(b.symbol)!;
          const thresholds = this.episodePercentileServiceForLox?.getThresholds(b.symbol) ?? null;
          const dir = lifecycle.episode.victim === "LONG" ? thresholds?.long : thresholds?.short;
          const percentileContext = buildPercentileContext(dir?.sampleCount ?? null, dir?.p90 ?? null, dir?.p95 ?? null, dir?.p99 ?? null, lifecycle.episode.sameDirectionLiqUsd);
          this.loxTickInFlight.add(b.symbol);
          this.liquidationOiOrchestrator.onTick(b.symbol, percentileContext, oiHistory, mid, atr3m, atr3mAgeMs, b.timestamp, b.bid, b.ask, this.wallTracker,
            this.candleStore.closedAfter(b.symbol, "1m", lifecycle.episodeEndDetection?.lastProcessed1mCloseTime ?? lifecycle.episode.firstLiqTs),
            this.candleStore.getClosed(b.symbol, "3m"),
            { get: (interval, atMs) => this.atrTracker.getWilderATRAtOrBefore(b.symbol, interval, 14, atMs) })
            .catch((err) => { log.error({ symbol: b.symbol, err: err instanceof Error ? err.message : String(err) }, "[LOX_ON_TICK_UNEXPECTED_ERROR]"); })
            .finally(() => { this.loxTickInFlight.delete(b.symbol); });
        }
      }
      // Sep 10 2026 (Karo), operator-requested: DISCONNECTED, same
      // rationale as feedUnitResearchShadowAfter() above -- this call
      // fed live bookTicker ticks into the old research state machine
      // (wave-completion checks, dragon evaluation, winner-touch
      // checks, research Telegram). Left commented, not deleted.
      // this.tickUnitResearchShadow(b.symbol, mid, b.timestamp);
      // Sep 11 2026 (Karo), operator-requested -- the OLD 1x-UNIT-
      // recovery cascade engine's own tick-driven evaluation is no
      // longer the production decision path (see candlePhysics
      // above, driven by closed candles instead). Left commented, not
      // deleted, per the operator's own convention.
      // this.tickCascade(b.symbol, mid, b.timestamp);
    });

    this.ws.on("orderbook", (snap) => {
      this.wallTracker.ingest(snap);
      this.orderbookStore.setDepth(snap);
    });

    this.ws.on("aggTrade", (t) => {
      this.tradeStore.ingest(t);
      this.aggressiveFlow.ingest(t);
    });

    // Sep 14 2026 (Karo), operator-reported CRITICAL FIX -- see
    // V5WaveService.getSymbolsWithNonLiveActiveTrades()'s own doc
    // comment for the full root-cause writeup this closes.
    setInterval(() => {
      this.runMainCloseFallback();
    }, MarketDataOrchestrator.MAIN_CLOSE_FALLBACK_MS);

    this.ws.start();
  }

  /** Sep 14 2026 (Karo), operator-reported CRITICAL FIX. Deterministic
   *  fallback for MAIN's own (isLive===false) paper-trade CLOSE
   *  detection, independent of any specific symbol's own bookTicker
   *  tick frequency -- structurally the EXACT SAME fix already proven
   *  for the live-Binance reconciliation path (see
   *  ReconciliationManager.runFallbackReconciliation()'s own doc
   *  comment), just applied to the completely separate paper-trade
   *  price-crossing-simulation path, which had no equivalent safety
   *  net until now. Root cause: onPriceTickForTrades() only runs
   *  inside the bookTicker handler above -- for a symbol with sparse
   *  ticks, or any span where that symbol's own ticks are delayed, a
   *  paper trade that already crossed its own TP/SL in price could sit
   *  undetected far longer than the fast (tick-driven) path implies,
   *  since MAIN has no live Binance position to reconcile against as
   *  a backstop. Reuses the SAME onPriceTickForTrades()/
   *  handleMainTradeClose() call shape the tick path already uses --
   *  a no-op for any symbol with zero active non-live trades, and
   *  naturally idempotent (onPriceTickForTrades() itself is a safe,
   *  repeatable no-op once a trade has already closed and been
   *  removed from activeTrades). */
  private runMainCloseFallback(): void {
    const now = Date.now();
    for (const symbol of this.v5.getSymbolsWithNonLiveActiveTrades()) {
      const price = this.lastKnownPriceForMain.get(symbol);
      if (price === undefined) continue; // no tick ever seen for this symbol yet -- nothing to re-check against
      const closes = this.v5.onPriceTickForTrades(symbol, price, now);
      for (const close of closes) void this.handleMainTradeClose(close);
    }
  }

  private tickResearchCheckpoints(
    symbol: string,
    price: number,
    now: number,
  ): void {
    const completed = this.researchCheckpoints.onTick(symbol, price, now);
    for (const c of completed) {
      void this.globalSignalRepo.appendCheckpoint(c.signalId, c.group);
    }
  }

  private wasProductionWatchTracked(symbol: string, victim: Side): boolean {
    return this.v5.getWatch(symbol, victim) !== null;
  }

  /** Sep 10 2026 (Karo), operator-requested production V5 multi-
   *  timeframe cascade lifecycle. Called on EVERY liquidation event,
   *  PURELY ADDITIVE, completely decoupled from V5's own watch-
   *  lifecycle and from mainSymbolLocks. Delegates the "is there
   *  already an active cascade for this symbol" ownership decision to
   *  cascadeRegistry (see cascade-registry.ts's own doc comment) --
   *  routes into the three EXISTING candidates if one is active under
   *  the SAME victim, ignores an opposite-victim event while one is
   *  active, or starts a genuinely fresh cascade (all three frozen
   *  common-horizon UNITs) if none is active. */
  /** Sep 10 2026 (Karo), operator-requested restart-safe persistence.
   *  Exports the given candidate's own current, still-ACTIVE state and
   *  upserts it into v5_active_cascades -- called after every
   *  meaningful state transition (cascade start, a wave starting/
   *  completing, an extreme deepening). A complete no-op if the
   *  candidate has no active watch (never started, or already
   *  terminal -- terminal persistence is handled separately by
   *  persistTerminalCandidate() below). */
  /** Sep 10 2026 (Karo), operator-reported CRITICAL FIX -- now async
   *  and AWAITED by feedCascade() below (was previously a fire-and-
   *  forget `void` call). Root-cause fix for the duplicate-cascade-
   *  document race condition: when a cascade first starts, all three
   *  candidates' own FIRST upsertCandidateState() call for that
   *  cascadeId is a genuine Mongo insert (via $setOnInsert) -- firing
   *  all three concurrently let them race each other's own check-then-
   *  insert, occasionally producing two separate documents for the
   *  SAME cascadeId. Returning a Promise here lets feedCascade() await
   *  each candidate's own write SEQUENTIALLY instead, so only the
   *  FIRST call ever performs the actual insert; the second and third
   *  always see an already-existing document and cleanly $set their
   *  own candidate sub-field on it. Combined with the new unique index
   *  on cascadeId (see CascadeRepository.ensureIndexes()) as a second,
   *  data-layer defense. */
  private async persistActiveCandidateSnapshot(symbol: string, victim: Side, candidate: CascadeCandidateService, timeframe: "1m" | "3m" | "5m", now: number): Promise<void> {
    const state = candidate.exportState(symbol, victim);
    if (!state) return;
    const currentWave = state.waves[state.waves.length - 1];
    const doc: CascadeCandidateStateDoc = {
      timeframe,
      phase: "ACTIVE",
      frozenUnitAbs: state.unitAbs,
      currentWaveNumber: currentWave?.waveNumber ?? null,
      waveHistory: state.waves,
      currentExtreme: currentWave?.extremePrice ?? null,
      terminalStatus: null,
      terminalReason: null,
      terminalReasonText: null,
      cancelPrice: null,
      recoveryDistance: null,
      recoveryUnits: null,
      signalId: null,
      terminalAt: null,
      lastUpdatedTs: now,
    };
    await this.cascadeRepo.upsertCandidateState(state.cascadeId, symbol, victim, state.createdAt, doc, now);
  }

  /** Sep 10 2026 (Karo), operator-reported CRITICAL FIX -- now async;
   *  every persistActiveCandidateSnapshot() call below is AWAITED
   *  SEQUENTIALLY (1m, then 3m, then 5m), never fired concurrently, to
   *  eliminate the duplicate-cascade-document race at its source. See
   *  persistActiveCandidateSnapshot()'s own doc comment above for the
   *  full root-cause explanation. Called via `void this.feedCascade(...)`
   *  at its own call-site in start()'s liquidation handler -- fire-and-
   *  forget from THAT caller's perspective (matching this project's
   *  own established convention for Mongo-write-triggering handlers),
   *  but internally fully sequential. */
  private async feedCascade(l: Liquidation, victim: Side): Promise<void> {
    const resolved = this.cascadeRegistry.resolve(l.symbol, victim, l.timestamp, randomUUID);

    if (resolved.action === "ignore") return;

    if (resolved.action === "route") {
      this.cascadeCandidate1m.onLiquidation(l, victim);
      await this.persistActiveCandidateSnapshot(l.symbol, victim, this.cascadeCandidate1m, "1m", l.timestamp);
      return;
    }

    // Sep 10 2026 (Karo), operator-requested production simplification --
    // ONLY the 1m candidate is created/run in live execution now. 3m/5m
    // are removed from this path entirely (CascadeRegistry itself is
    // still constructed with 3m/5m CascadeCandidateService instances --
    // see this class's own field declarations -- solely because
    // isCascadeStillActive()'s own ownership-release logic reads all
    // three; those two instances simply never receive startCascade()/
    // onLiquidation()/onTick() calls anymore, so they stay permanently
    // empty and inert).
    if (!this.commonHorizonAtrReady(l.symbol)) return;
    const unit1m = this.atrTracker.getWilderATR(l.symbol, "1m", COMMON_HORIZON_PERIODS.atr1m);
    if (unit1m !== null && unit1m > 0) {
      this.cascadeCandidate1m.startCascade(l.symbol, victim, resolved.cascadeId, "1m", unit1m, l.price, resolved.cascadeStartTs, l.quoteQty, resolved.cascadeStartTs);
      await this.persistActiveCandidateSnapshot(l.symbol, victim, this.cascadeCandidate1m, "1m", l.timestamp);
    }
  }

  /** Sep 10 2026 (Karo), operator-requested production simplification --
   *  ticks ONLY the 1m candidate now. Called on EVERY bookTicker tick,
   *  PURELY ADDITIVE. onTick() is a complete no-op when there is no
   *  active watch for that symbol/victim, so this is cheap for the vast
   *  majority of ticks. A signal-ready result flows into the EXISTING
   *  V5 signal path (handleCascadeSignalReady()); a cancel result is
   *  diagnostic-only (logged, no further action). */
  private tickCascade(symbol: string, mid: number, ts: number): void {
    for (const victim of ["LONG", "SHORT"] as const) {
      this.handleCascadeTick("1m", this.cascadeCandidate1m, symbol, victim, mid, ts);
    }
  }

  /** Sep 10 2026 (Karo), operator-requested restart-safe persistence.
   *  Tracks the last-persisted (waveCount, extremePrice) per candidate
   *  watch, so persistActiveCandidateSnapshot() is only actually called
   *  (a real Mongo write) when something meaningful has changed since
   *  the last tick -- avoids writing on every single bookTicker tick
   *  for a symbol with an active cascade. */
  private readonly cascadeLastPersistedSnapshot = new Map<string, { waveCount: number; extremePrice: number }>();

  private handleCascadeTick(timeframe: "1m" | "3m" | "5m", candidate: CascadeCandidateService, symbol: string, victim: Side, mid: number, ts: number): void {
    const result = candidate.onTick(symbol, victim, mid, ts);
    if (!result) {
      const state = candidate.exportState(symbol, victim);
      if (state) {
        const currentWave = state.waves[state.waves.length - 1]!;
        const snapKey = `${state.cascadeId}:${timeframe}`;
        const last = this.cascadeLastPersistedSnapshot.get(snapKey);
        if (!last || last.waveCount !== state.waves.length || last.extremePrice !== currentWave.extremePrice) {
          this.cascadeLastPersistedSnapshot.set(snapKey, { waveCount: state.waves.length, extremePrice: currentWave.extremePrice });
          this.persistActiveCandidateSnapshot(symbol, victim, candidate, timeframe, ts);
        }
      }
      return;
    }
    if ("entryPrice" in result) {
      void this.handleCascadeSignalReady(result as CascadeSignalReadyEvent);
    } else {
      const cancel = result as CascadeCancelEvent;
      const finalWave = cancel.waveHistory[cancel.waveHistory.length - 1];
      const reasonText = terminalReasonText(cancel.reason, cancel.recoveryUnits);
      log.info(
        `[CASCADE_CANDIDATE_CANCEL] ${cancel.symbol} ${cancel.victim} timeframe=${cancel.timeframe} cascadeId=${cancel.cascadeId} waves=${cancel.waveHistory.length} reason=${cancel.reason} (${reasonText}) waveExtreme=${cancel.waveExtreme} cancelPrice=${cancel.cancelPrice} recoveryUnits=${cancel.recoveryUnits.toFixed(3)}`,
      );
      const doc: CascadeCandidateStateDoc = {
        timeframe: cancel.timeframe,
        phase: "TERMINAL_CANCEL",
        frozenUnitAbs: cancel.frozenUnitAbs,
        currentWaveNumber: finalWave?.waveNumber ?? cancel.lastCompletedWaveNumber,
        // Every wave in a terminal event's own waveHistory has, by
        // construction, already completed (the terminal condition
        // itself is only ever evaluated once the final wave has
        // reached COMPLETED) -- safe to map unconditionally.
        waveHistory: cancel.waveHistory.map((w) => ({ ...w, state: "COMPLETED" as const })),
        currentExtreme: cancel.waveExtreme,
        terminalStatus: "CANCEL",
        terminalReason: cancel.reason,
        terminalReasonText: reasonText,
        cancelPrice: cancel.cancelPrice,
        recoveryDistance: cancel.recoveryDistance,
        recoveryUnits: cancel.recoveryUnits,
        signalId: null,
        terminalAt: cancel.cancelTs,
        lastUpdatedTs: ts,
      };
      void this.cascadeRepo.markCandidateTerminal(cancel.cascadeId, cancel.symbol, cancel.victim, cancel.cascadeStartTs, doc, ts);
    }
  }

  /** Sep 10 2026 (Karo), operator-requested production V5 multi-
   *  timeframe cascade lifecycle. Connects a candidate's own signal-
   *  ready result into the EXISTING, UNCHANGED V5 production signal
   *  path: the SAME deriveLiquidationPhysicsTradePlan() TP/SL formula
   *  (no redesign, per the operator's own explicit instruction), the
   *  SAME GlobalSignalDoc shape (plus the two new, additive cascadeId/
   *  timeframe fields), the SAME distributor.distribute() fan-out. The
   *  candidate's own final (signal-triggering) wave and its own first
   *  wave feed the SAME w1/w2 formula-inputs the existing V5 signal
   *  path already uses -- this is a mapping choice for THIS pass only
   *  (TP/SL redesign is explicitly out of scope here).
   *
   *  mainSymbolLocks (the EXISTING, UNCHANGED same-symbol real-position
   *  lock) is respected EXACTLY as the existing V5 signal path already
   *  respects it: the candidate's own signal doc is ALWAYS persisted
   *  (so every candidate's own result is available for later
   *  comparison, per the operator's own explicit requirement), but
   *  distribute() -- the ONLY step that can trigger a real Binance
   *  order or a Telegram ENTRY -- is skipped entirely if MAIN already
   *  holds an open real position for this symbol. This guarantees MAIN
   *  can NEVER hold two simultaneous real positions on the same
   *  symbol, regardless of how many candidates independently reach
   *  signal-ready. */
  /** Sep 10 2026 (Karo), operator-reported CRITICAL FIX -- root-cause
   *  fix for the malformed cascade-signal Telegram message ("Wave 2 of
   *  0", "Dominant layer: $0 (Wave null)", "Plan rejected: unknown").
   *  formatV5EntryMessage() (via toV5SignalEventShape()) reads
   *  event.waveHistory as V5Wave[], a RICHER shape than this project's
   *  own CascadeWaveState. Converts genuinely, deriving every field
   *  that has a real, honest cascade equivalent:
   *    - waveNumber/state/anchorPrice/anchorTs/extremePrice/extremeTs/
   *      liqNotionalUsd/liqEvents: direct, 1:1 from the cascade wave.
   *    - reclaimPrice/reclaimTs: for a COMPLETED wave, the price/time
   *      at which it actually completed -- extremePrice +/- unitAbs
   *      (the exact 1x-UNIT-recovery threshold that closed it), at
   *      extremeTs; for an ACTIVE wave (only ever the LAST one), null
   *      (matches V5Wave's own doc comment: "set only when state ->
   *      COMPLETED").
   *    - extremeDistanceAtr: |anchor-extreme| / atr15mAbs -- the SAME
   *      normalization deriveLiquidationPhysicsTradePlan() itself
   *      already uses for w1DisplacementAtr, applied per-wave here.
   *  Every OTHER V5Wave field (maxSingleEventUsd, maxRecoveryPrice,
   *  recoveryPct, priceEfficiency, liquidationRatioVsDominant,
   *  priceEfficiencyRatioVsDominant, isMeaningful, selectedRecoveryPct,
   *  recoveryTargetPrice, recovery50/75AtTs/Price, taker*, oi*) has NO
   *  natural cascade equivalent -- the cascade model's own wave-
   *  completion rule (exactly 1x UNIT recovery, always) has no
   *  "50%/75%/100% of anchor-extreme range" concept at all, and this
   *  project never tracks per-wave taker-flow/OI for cascade
   *  candidates. These are explicitly left at their own neutral/null
   *  "not tracked" value (0/false/null) rather than a fabricated
   *  number -- NONE of them are read by formatV5EntryMessage() (
   *  confirmed: the formatter only ever reads waveNumber, anchorPrice,
   *  extremePrice, reclaimPrice, liqNotionalUsd, and, for the entry
   *  wave specifically, selectedRecoveryPct/extremeDistanceAtr), so
   *  this is a type-compatibility requirement, never a display fake. */
  private cascadeWavesToV5Waves(waves: readonly WaveSummary[], unitAbs: number, victim: Side, atr15mAbs: number): V5Wave[] {
    return waves.map((w, i): V5Wave => {
      const isLast = i === waves.length - 1;
      const isCompleted = !isLast; // every wave before the last one has, by construction, already completed (the next wave only ever starts after the previous one reached COMPLETED)
      const reclaimPrice = isCompleted ? (victim === "LONG" ? w.extremePrice + unitAbs : w.extremePrice - unitAbs) : null;
      return {
        waveNumber: w.waveNumber,
        state: isCompleted ? "COMPLETED" : "ACTIVE",
        anchorPrice: w.anchorPrice,
        anchorTs: w.anchorTs,
        extremePrice: w.extremePrice,
        extremeTs: w.extremeTs,
        reclaimPrice,
        reclaimTs: isCompleted ? w.extremeTs : null,
        liqNotionalUsd: w.liqUsd,
        liqEvents: w.liqEvents,
        // Not tracked by the cascade model -- see this method's own doc comment.
        maxSingleEventUsd: 0,
        maxRecoveryPrice: w.extremePrice,
        recoveryPct: null,
        priceEfficiency: null,
        liquidationRatioVsDominant: null,
        priceEfficiencyRatioVsDominant: null,
        extremeDistanceAtr: atr15mAbs > 0 ? Math.abs(w.anchorPrice - w.extremePrice) / atr15mAbs : 0,
        isMeaningful: true,
        selectedRecoveryPct: null,
        recoveryTargetPrice: null,
        recovery50AtTs: null,
        recovery50AtPrice: null,
        recovery75AtTs: null,
        recovery75AtPrice: null,
        takerBuyUsd: null,
        takerSellUsd: null,
        takerImbalance: null,
        oiStart: null,
        oiEnd: null,
        oiDeltaPct: null,
        liqRateUsdPerMin: null,
        eventRatePerMin: null,
        priceSpeedAtrPerMin: null,
      };
    });
  }

  /** Sep 11 2026 (Karo), operator-requested -- maps the NEW candle-
   *  physics engine's own CompletedWaveSummary[] into the SAME V5Wave[]
   *  shape used for persistence/display everywhere else in this
   *  project, so existing Telegram formatting and downstream tooling
   *  keep working unchanged. anchorPrice is reverse-derived from
   *  extreme/totalExtensionUnits (this wave's own price displacement),
   *  since the candle-physics engine tracks displacement directly
   *  rather than a literal anchor price -- a reasonable, documented
   *  approximation for DISPLAY purposes only; it never feeds back into
   *  SL/TP (last-two-wave-trade-plan.ts uses extreme values directly). */
  private candlePhysicsWavesToV5Waves(waves: readonly CompletedWaveSummary[], unitAbs: number, victim: Side, atr15mAbs: number): V5Wave[] {
    return waves.map((w, i): V5Wave => {
      const isLast = i === waves.length - 1;
      const isCompleted = !isLast;
      const anchorPrice = victim === "LONG" ? w.extreme + w.totalExtensionUnits * unitAbs : w.extreme - w.totalExtensionUnits * unitAbs;
      const reclaimPrice = isCompleted ? (victim === "LONG" ? w.extreme + unitAbs : w.extreme - unitAbs) : null;
      const extremeDistanceAtr = atr15mAbs > 0 ? Math.abs(anchorPrice - w.extreme) / atr15mAbs : 0;
      const durationMin = (w.endTime - w.startTime) / 60000;
      return {
        waveNumber: w.waveNumber,
        state: isCompleted ? "COMPLETED" : "ACTIVE",
        anchorPrice,
        anchorTs: w.startTime,
        extremePrice: w.extreme,
        extremeTs: w.endTime,
        reclaimPrice,
        reclaimTs: isCompleted ? w.endTime : null,
        liqNotionalUsd: w.totalLiqUsd,
        liqEvents: w.totalEvents,
        maxSingleEventUsd: w.maxEvent,
        maxRecoveryPrice: w.extreme,
        recoveryPct: null,
        priceEfficiency: w.efficiency,
        liquidationRatioVsDominant: null,
        priceEfficiencyRatioVsDominant: null,
        extremeDistanceAtr,
        isMeaningful: true,
        selectedRecoveryPct: null,
        recoveryTargetPrice: null,
        recovery50AtTs: null,
        recovery50AtPrice: null,
        recovery75AtTs: null,
        recovery75AtPrice: null,
        takerBuyUsd: null,
        takerSellUsd: null,
        takerImbalance: null,
        oiStart: null,
        oiEnd: null,
        oiDeltaPct: null,
        liqRateUsdPerMin: durationMin > 0 ? w.totalLiqUsd / durationMin : null,
        eventRatePerMin: durationMin > 0 ? w.totalEvents / durationMin : null,
        priceSpeedAtrPerMin: durationMin > 0 ? extremeDistanceAtr / durationMin : null,
      };
    });
  }

  /** Sep 11 2026 (Karo), operator-requested -- the ONLY live production
   *  entry point for a real trade decision now. Mirrors
   *  handleCascadeSignalReady()'s own structure/persistence/
   *  distribution pattern exactly, substituting the NEW last-two-wave
   *  SL/TP formula and the NEW engine's own wave shape. */
  private async handleCandlePhysicsEntry(event: import("../domain/cascade/candle-physics-engine").CandlePhysicsEntryEvent): Promise<void> {
    try {
      // Sep 11 2026 (Karo), operator-requested -- the OLD final-entry
      // P95 gate (which compared event.maxIndividualEventUsd against a
      // FRESH P95 read at ENTRY time, and could still reject ENTRY
      // even after physics decided it) is REMOVED. It is now
      // structurally redundant: the candle-physics engine itself
      // (candle-physics-engine.ts) already guarantees that a
      // meaningful W1 can only ever be established when its own
      // largest individual event reached the REAL, live P95 available
      // at THAT wave's own completion moment (see
      // event.p95AtW1Qualification / event.maxIndividualEventUsdAtW1
      // below) -- ENTRY is structurally impossible without a
      // legitimately-qualified W1 already existing (dominantWave is
      // never null at ENTRY). A second, independent P95 check here
      // would be double-gating the SAME underlying rule at a
      // different point in time, which the operator explicitly does
      // not want. This is now purely an informational log.
      log.info(
        {
          symbol: event.symbol,
          victim: event.victim,
          p95AtW1Qualification: event.p95AtW1Qualification,
          maxIndividualEventUsdAtW1: event.maxIndividualEventUsdAtW1,
          w1QualificationTs: event.w1QualificationTs,
          episodeTotalLiqUsd: event.allWaves.reduce((s, w) => s + w.totalLiqUsd, 0),
          waveCount: event.allWaves.length,
          eventCount: event.allWaves.reduce((s, w) => s + w.totalEvents, 0),
        },
        "[W1_P95_QUALIFICATION]",
      );

      const atr15mAbs = this.atrTracker.getATR(event.symbol, "15m") ?? 0;
      const baseline = this.liquidationStats.rollingMedianLiqNotionalPerMin(event.symbol, 60) ?? 0;

      // Sep 11 2026 (Karo), operator-requested simplification -- the
      // last-two-wave structural SL is kept ONLY as a diagnostic
      // computation below (logged via [LAST_TWO_WAVE_STRUCTURAL_
      // DIAGNOSTICS_ONLY_NOT_EXECUTABLE]); it NEVER determines the
      // executable stopLoss/takeProfit anymore. No rejection, no
      // clamping to any range based on this value.
      const previousExtreme = event.dominantWave.extreme;
      const finalExtreme = event.signalWave.extreme;
      const structuralDiagnostics = deriveLastTwoWaveTradePlan({
        entryPrice: event.entryPrice,
        direction: event.victim,
        previousExtreme,
        finalExtreme,
      });
      log.info(
        {
          symbol: event.symbol,
          direction: event.victim,
          entryPrice: structuralDiagnostics.entryPrice,
          previousExtreme: structuralDiagnostics.previousExtreme,
          finalExtreme: structuralDiagnostics.finalExtreme,
          lastLegExtension: structuralDiagnostics.lastLegExtension,
          naturalSL: structuralDiagnostics.naturalSL,
          naturalRiskPct: structuralDiagnostics.naturalRiskPct,
          diagnosticExecutionRiskPct: structuralDiagnostics.executionRiskPct,
          diagnosticSlAdjustment: structuralDiagnostics.slAdjustment,
          diagnosticStopLoss: structuralDiagnostics.stopLoss,
        },
        "[LAST_TWO_WAVE_STRUCTURAL_DIAGNOSTICS_ONLY_NOT_EXECUTABLE]",
      );

      // Sep 11 2026 (Karo), operator-requested -- THE executable SL/TP.
      // WAVE mode: fixed 0.30% risk, 2.2R reward, unchanged -- still
      // hardcoded here, untouched by the Sep 14 2026 ROTATION work.
      // ROTATION mode (Sep 14 2026, operator-approved): reads its own
      // SL%/TP% from v5.config.ts's v5RotationSlPct()/v5RotationTpPct()
      // -- the single source of truth also used inside
      // candle-physics-engine.ts's own entry-condition thresholds, so
      // there is exactly one place these values are ever defined.
      // Neither mode's SL/TP is ever derived from wave structure or
      // clamped/rejected based on it.
      const isRotation = event.rotationDiagnostics !== null;
      const entry = event.entryPrice;
      const FIXED_SL_PCT = isRotation ? v5RotationSlPct() : 0.003;
      const sl = event.victim === "LONG" ? entry * (1 - FIXED_SL_PCT) : entry * (1 + FIXED_SL_PCT);
      const riskDistance = Math.abs(entry - sl);
      // ROTATION: TP is the DIRECT percentage from config (matching
      // entry*(1+tpPct)/entry*(1-tpPct) exactly). WAVE: unchanged,
      // still RR-derived from riskDistance*2.2.
      const REWARD_RISK_RATIO = isRotation ? v5RotationTpPct() / FIXED_SL_PCT : 2.2;
      const rewardDistance = isRotation ? entry * v5RotationTpPct() : riskDistance * REWARD_RISK_RATIO;
      const tp = event.victim === "LONG" ? entry + rewardDistance : entry - rewardDistance;
      const plan = { ok: true as const, entry, sl, tp, slPct: FIXED_SL_PCT, tpPct: entry > 0 ? rewardDistance / entry : 0, rr: REWARD_RISK_RATIO };

      log.info(
        { symbol: event.symbol, direction: event.victim, entryPrice: entry, stopLoss: sl, riskDistance, rewardDistance, takeProfit: tp, rewardRiskRatio: REWARD_RISK_RATIO, entryMode: isRotation ? "ROTATION" : "WAVE" },
        "[FIXED_RISK_TRADE_PLAN]",
      );

      const signalId = randomUUID();
      const totalLiq = event.allWaves.reduce((sum, w) => sum + w.totalLiqUsd, 0);

      // Sep 11 2026 (Karo), operator-reported CRITICAL FIX -- the
      // candle-physics engine's own entry point never evaluated the
      // EXISTING, intended V5_BTC_BLOCK mechanism at all: BTC's own
      // signals could actually execute (contradicting "BTC never
      // trades when V5_BTC_BLOCK=true"), ALT signals were never
      // blocked even with an active same-side BTC setup, and the
      // Telegram diagnostic line was a disconnected hardcode (always
      // "YES, unconditionally" for BTCUSDT, always "NO" for every ALT
      // since btcIntendedSideAtSignalTime was hardcoded null). This
      // reuses the EXISTING, already-correct mechanism the legacy V5
      // path already has (this.v5.getBtcWatchVictim() +
      // Sep 11 2026 (Karo), operator-instructed REVERT -- BTC_BLOCK
      // execution-gating/diagnostic-wiring (isMainBtcBlocked(),
      // evaluateBtcOpposingWatchSafe(), real btcSafetyStatus/
      // btcIntendedSideAtSignalTime) was NEVER deployed to production
      // and the operator explicitly does not want it implemented yet
      // (their own desired future change is Telegram-diagnostic-only,
      // with zero execution impact, and they have not asked for it to
      // be implemented). Reverted back to the ORIGINAL, pre-BTC_BLOCK-
      // work state so this file matches what is ACTUALLY deployed.
      const willExecuteAsMain = !this.mainSymbolLocks.has(event.symbol);
      const v5Waves = this.candlePhysicsWavesToV5Waves(event.allWaves, event.unitAbs, event.victim, atr15mAbs);

      // Sep 12 2026 (Karo), operator-requested research-persistence
      // audit -- REAL, live, ENTRY-TIME-ONLY snapshots from the
      // ALREADY-RUNNING AggressiveFlowService/OiTrackerService/
      // candleStore (confirmed instantiated and fed live data
      // elsewhere in this class -- see this.aggressiveFlow,
      // this.oiTracker, this.candleStore). Purely observational reads;
      // never influences any wave/entry/execution decision above.
      const flowSnap = this.aggressiveFlow.getRecentFlow(event.symbol, 30_000, event.entryTs);
      const oiSnap = this.oiTracker.getCachedOI(event.symbol);
      const btcCandle = this.candleStore.lastClosed("BTCUSDT", "1m");
      const btcOiSnap = this.oiTracker.getCachedOI("BTCUSDT");

      // Sep 12 2026 (Karo), operator-requested BTC_BLOCK redesign --
      // the LIVE, CURRENT serious BTC candle-physics episode at the
      // exact moment THIS ALT signal fires. Never the last BTC ENTRY
      // signal, never a stale cached direction -- a synchronous,
      // in-memory read of CandlePhysicsEngine's own live watch state
      // (see getSeriousEpisodeContext()'s own doc comment). Checks
      // BOTH BTC victim sides; btcIntendedSideAtSignalTime is set ONLY
      // to whichever side (if any) is both "active" (not NO_WAVE/
      // TERMINAL_CANCELLED) and "serious" (dominantWave !== null,
      // reusing the EXISTING W1-qualification result, never
      // recomputed here) AND in a still-unresolved phase (ACTIVE/
      // EXHAUSTING/WAIT_NEXT_PRESSURE). N/A_BTC for BTC's own signal
      // (self-comparison is meaningless); CLEAN when no side matches.
      const btcLongCtx = event.symbol !== "BTCUSDT" ? this.candlePhysics.getSeriousEpisodeContext("BTCUSDT", "LONG") : null;
      const btcShortCtx = event.symbol !== "BTCUSDT" ? this.candlePhysics.getSeriousEpisodeContext("BTCUSDT", "SHORT") : null;
      function isBlocking(ctx: import("../domain/cascade/candle-physics-engine").SeriousEpisodeContext | null): boolean {
        return ctx !== null && ctx.active && ctx.serious && (["ACTIVE", "EXHAUSTING", "WAIT_NEXT_PRESSURE"] as const).includes(ctx.phase as "ACTIVE" | "EXHAUSTING" | "WAIT_NEXT_PRESSURE");
      }
      const btcLongBlocking = isBlocking(btcLongCtx);
      const btcShortBlocking = isBlocking(btcShortCtx);
      // If BOTH sides are simultaneously serious/active (rare), the
      // side that actually matches THIS ALT's own side (event.victim)
      // takes precedence for the block decision -- an ALT can only
      // ever be blocked by the SAME-side BTC episode, never both at
      // once from this field's own single-side perspective.
      let btcIntendedSideAtSignalTime: import("../shared/common.types").Side | null = null;
      if (event.symbol !== "BTCUSDT") {
        if (event.victim === "LONG" && btcLongBlocking) btcIntendedSideAtSignalTime = "LONG";
        else if (event.victim === "SHORT" && btcShortBlocking) btcIntendedSideAtSignalTime = "SHORT";
        else if (btcLongBlocking) btcIntendedSideAtSignalTime = "LONG";
        else if (btcShortBlocking) btcIntendedSideAtSignalTime = "SHORT";
      }
      const btcSafetyStatus: "CLEAN" | "WOULD_BLOCK" | "UNKNOWN" | "N/A_BTC" =
        event.symbol === "BTCUSDT" ? "N/A_BTC" : btcIntendedSideAtSignalTime === event.victim ? "WOULD_BLOCK" : "CLEAN";
      // The SAME-side-as-this-ALT context is what's persisted for
      // research reconstruction (see GlobalSignalDoc.btcContext's own
      // doc comment) -- whichever BTC side matches this ALT's own
      // side, regardless of whether it ended up blocking or not.
      const sameSideCtx = event.victim === "LONG" ? btcLongCtx : btcShortCtx;
      const btcActiveCascadeSide: import("../shared/common.types").Side | null = btcLongBlocking ? "LONG" : btcShortBlocking ? "SHORT" : null;

      const globalSignal: GlobalSignalDoc = {
        signalId,
        symbol: event.symbol,
        side: event.victim,
        victim: event.victim,
        signalTs: event.entryTs,
        entryPrice: event.entryPrice,
        entryWaveNumber: event.signalWave.waveNumber,
        waveHistory: v5Waves,
        w1Diagnostics: null,
        rotationDiagnostics: event.rotationDiagnostics,
        totalEpisodePressure: totalLiq,
        dominantLayerLiqUsd: event.dominantWave.totalLiqUsd,
        dominantLayerWaveNumber: event.dominantWave.waveNumber,
        exhaustionLayerLiqUsd: event.signalWave.totalLiqUsd,
        exhaustionLayerWaveNumber: event.signalWave.waveNumber,
        unitAtStart: event.unitAbs,
        p95AtEntry: this.liquidationStats.notionalPercentile(event.symbol, event.victim, 95),
        dailyLiqPerMinBaselineAtEntry: baseline,
        atr15mAtEntry: atr15mAbs,
        qualifyingEventUsd: event.allWaves[0]?.totalLiqUsd ?? 0,
        qualifyingEventTs: event.allWaves[0]?.startTime ?? event.episodeStartTs,
        p95AtQualification: this.liquidationStats.notionalPercentile(event.symbol, event.victim, 95),
        physics: {
          cumLiqUsd: totalLiq,
          atrPct: atr15mAbs,
          liqBaseline: baseline,
          liqStrengthRaw: 0,
          liqStrength: 0,
          physicsTPPct: plan.tpPct,
          wallAdjustedTpPct: plan.tpPct,
          wallApplied: false,
          rrCandidate: plan.rr,
          slCapApplied: false,
          slCapValue: 0,
          finalTpPct: plan.tpPct,
          finalSlPct: plan.slPct,
          actualRR: plan.rr,
          structuralSoftExitPrice: 0,
          structuralRiskPct: 0,
          sizingRiskPct: 0,
          hardStopRiskPct: 0,
          liquidityStrengthP95: 0,
          liquidityStrength24h: 0,
          liquidityStrength: 0,
          w2ToW1Ratio: event.dominantWave.totalLiqUsd > 0 ? event.signalWave.totalLiqUsd / event.dominantWave.totalLiqUsd : 0,
          exhaustionScore: 0,
          w1DisplacementAtr: 0,
          absorptionRaw: 0,
          absorptionScore: 0,
          dynamicPhysicsScore: 0,
          selectedRR: plan.rr,
          tpMultiplier: 0,
          slDeterminedBy: isRotation ? "rotation-fixed" : "physics",
        },
        btcContext: {
          priceAtSignal: btcCandle?.close ?? null,
          oiAtSignal: btcOiSnap?.contracts ?? null,
          btcSeriousEpisodePhase: sameSideCtx?.phase ?? null,
          btcSeriousEpisodeP95AtQualification: sameSideCtx?.p95AtQualification ?? null,
          btcSeriousEpisodeMaxIndividualEventUsd: sameSideCtx?.maxIndividualEventUsd ?? null,
          btcSeriousEpisodeQualificationTs: sameSideCtx?.w1QualificationTs ?? null,
          btcActiveCascadeSide,
        },
        marketContextAtEntry: {
          takerFlowLast30sBuyUsd: flowSnap?.buyUsd ?? null,
          takerFlowLast30sSellUsd: flowSnap?.sellUsd ?? null,
          takerFlowLast30sImbalance: flowSnap && flowSnap.buyUsd + flowSnap.sellUsd > 0 ? (flowSnap.buyUsd - flowSnap.sellUsd) / (flowSnap.buyUsd + flowSnap.sellUsd) : null,
          takerVolumeRollingMedianPerMinUsd: this.aggressiveFlow.getRollingMedianTakerVolume(event.symbol, 60),
          oiCurrentContracts: oiSnap?.contracts ?? null,
          oiRollingMedianChangeContracts: this.oiTracker.getRollingMedianOiChange(event.symbol),
        },
        liq24hContext: null,
        wallContext: null,
        entry: plan.entry,
        tp: plan.tp,
        sl: plan.sl,
        rr: plan.rr,
        btcSafetyStatus: btcSafetyStatus,
        btcIntendedSideAtSignalTime: btcIntendedSideAtSignalTime,
        rejectionReason: null,
        planDiagnostics: null,
        status: "SIGNAL",
        closedAt: null,
        closePrice: null,
        maxFavorableR: null,
        maxAdverseR: null,
        liquidationStatsContext: null,
        researchCheckpoints: [],
        unitResearch: null,
        unitCompetitionResearch: null,
        commonHorizonResearch: null,
        cascadeId: null,
        timeframe: "1m",
        isMainExecuted: willExecuteAsMain,
        episodePlan: null,
        waveEfficiencyAnalysis: null,
        p95AtW1Qualification: event.p95AtW1Qualification,
        maxIndividualEventUsdAtW1: event.maxIndividualEventUsdAtW1,
        w1QualificationTs: event.w1QualificationTs,
        createdAt: Date.now(),
      };

      await this.globalSignalRepo.insert(globalSignal);
      log.info(
        `[CANDLE_PHYSICS_ENTRY] ${event.symbol} ${event.victim} signalId=${signalId} waves=${event.allWaves.length} entry=${plan.entry} sl=${plan.sl} tp=${plan.tp} rr=${plan.rr.toFixed(2)} willExecuteAsMain=${willExecuteAsMain}`,
      );

      this.candlePhysics.clearTerminal(event.symbol, event.victim);

      if (!willExecuteAsMain) return;
      const { mainTelegramSent } = await this.distributor.distribute(globalSignal, this.mongo);
      if (!mainTelegramSent) {
        log.error(`[CANDLE_PHYSICS_MAIN_ENTRY_TELEGRAM_MISSING] ${event.symbol} ${event.victim} signalId=${signalId} -- MAIN's own ENTRY notification FAILED to send, but this trade IS still being installed into active TP/SL tracking`);
      }
      this.mainSymbolLocks.add(event.symbol);
      this.v5.hydrateActiveTrade({
        signalId,
        symbol: event.symbol,
        victim: event.victim,
        side: event.victim,
        entry: plan.entry,
        tp: plan.tp,
        sl: plan.sl,
        openedAt: event.entryTs,
        bestPrice: plan.entry,
        worstPrice: plan.entry,
        entryWaveNumber: event.signalWave.waveNumber,
        isLive: false,
        binanceSlOrderId: null,
        binanceTpOrderId: null,
        positionQty: null,
        notional: null,
        riskUsd: null,
        timeframe: "1m",
      });

      const denom = Math.abs(plan.entry - plan.sl);
      const dirMul = event.victim === "LONG" ? 1 : -1;
      this.researchCheckpoints.registerWatch(signalId, event.symbol, "SIGNAL", event.entryTs, plan.entry, { kind: "R", dirMul, denom });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, symbol: event.symbol, victim: event.victim }, "[CANDLE_PHYSICS_ENTRY_UNHANDLED_ERROR]");
    }
  }

  /** Sep 11 2026 (Karo), operator-requested lifecycle timeouts --
   *  diagnostic-only (logged), never itself creating any state change
   *  beyond what CandlePhysicsEngine already did internally (the watch
   *  is already TERMINAL_CANCELLED by the time this is called; this
   *  just makes the reason visible and releases the engine's own map
   *  entry so a fresh episode can start immediately).
   *
   *  Sep 14 2026 (Karo), operator-approved -- ROTATION mode ADDITIVE
   *  persistence. WAVE-mode cancels remain log-only, completely
   *  unchanged. A ROTATION-mode cancel gets ONE small, additive
   *  GlobalSignal insert -- a historical/statistical terminal record
   *  only (no Telegram, no execution, no hydrateActiveTrade), so
   *  findCompletedRotationEpisodeTotals() has a durable, DB-backed
   *  sample of this completed-without-entry episode for future causal
   *  P95 history. peekWatch() is called BEFORE clearTerminal() below
   *  (which deletes the watch), so the watch's own final state is
   *  still readable here. */
  private async handleCandlePhysicsCancel(event: import("../domain/cascade/candle-physics-engine").CandlePhysicsCancelEvent): Promise<void> {
    log.info(
      `[CANDLE_PHYSICS_CANCEL] ${event.symbol} ${event.victim} reason=${event.reason} episodeStartTs=${event.episodeStartTs} cancelTs=${event.cancelTs} completedWaves=${event.allWaves.length}`,
    );

    const watch = this.candlePhysics.peekWatch(event.symbol, event.victim);
    if (watch?.mode === "ROTATION") {
      try {
        const doc: GlobalSignalDoc = {
          signalId: randomUUID(),
          symbol: event.symbol,
          side: event.victim,
          cascadeId: null,
          timeframe: null,
          episodePlan: null,
          waveEfficiencyAnalysis: null,
          p95AtW1Qualification: null,
          maxIndividualEventUsdAtW1: null,
          w1QualificationTs: null,
          isMainExecuted: false,
          victim: event.victim,
          signalTs: watch.episodeStartTs,
          entryPrice: 0,
          entryWaveNumber: 0,
          waveHistory: [],
          w1Diagnostics: null,
          rotationDiagnostics: {
            entryMode: "ROTATION",
            causalP95Threshold: watch.rotationCausalP95,
            priorEpisodeSampleCount: watch.rotationPriorSampleCount,
            cumulativeSameSideLiqUsd: watch.cumulativeSameSideLiqUsd,
            preLiqDownAtr: watch.preLiqDownAtr,
            preLiqUpAtr: watch.preLiqUpAtr,
            currentDownAtr: null,
            currentUpAtr: null,
            theta: null,
            rotationDeg: null,
            downSlope2m: null,
            upSlope2m: null,
            liqDecay: null,
            recRise: null,
            rotationForce: null,
            shockAtr: null,
            adverseExtremePrice: watch.episodeExtreme,
            adverseExtremeTs: watch.adverseExtremeTs,
            timeFromExtremeMin: (event.cancelTs - watch.adverseExtremeTs) / 60000,
            lastSameSideLiquidationTs: watch.lastSameSideLiquidationTs,
            secondsSinceLastSameSideLiq: (event.cancelTs - watch.lastSameSideLiquidationTs) / 1000,
            watchCreatedAt: watch.episodeStartTs,
          },
          totalEpisodePressure: watch.cumulativeSameSideLiqUsd,
          dominantLayerLiqUsd: null,
          dominantLayerWaveNumber: null,
          exhaustionLayerLiqUsd: null,
          exhaustionLayerWaveNumber: null,
          unitAtStart: watch.unitAbs,
          p95AtEntry: 0,
          dailyLiqPerMinBaselineAtEntry: 0,
          atr15mAtEntry: 0,
          qualifyingEventUsd: 0,
          qualifyingEventTs: watch.episodeStartTs,
          p95AtQualification: 0,
          physics: null,
          btcContext: null,
          marketContextAtEntry: null,
          liq24hContext: null,
          wallContext: null,
          entry: null,
          tp: null,
          sl: null,
          rr: null,
          btcSafetyStatus: "UNKNOWN",
          btcIntendedSideAtSignalTime: null,
          rejectionReason: event.reason,
          planDiagnostics: null,
          status: event.reason as GlobalSignalDoc["status"],
          closedAt: null,
          closePrice: null,
          maxFavorableR: null,
          maxAdverseR: null,
          liquidationStatsContext: null,
          researchCheckpoints: [],
          unitResearch: null,
          unitCompetitionResearch: null,
          commonHorizonResearch: null,
          createdAt: Date.now(),
        };
        await this.globalSignalRepo.insert(doc);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ symbol: event.symbol, victim: event.victim, err: msg }, "[ROTATION_CANCEL_PERSIST_FAILED]");
      }
    }

    this.candlePhysics.clearTerminal(event.symbol, event.victim);
  }

  /** Sep 11 2026 (Karo), operator-requested -- diagnostic-only log for
   *  every completed candidate discarded BEFORE a meaningful W1 exists
   *  (either single-event, or multi-event but below the live P95).
   *  Never itself changes any state -- the engine already reset the
   *  watch to NO_WAVE/WAIT_NEXT_PRESSURE internally; this call exists
   *  purely so the operator's own explicit per-candidate diagnostic
   *  requirement (symbol, victim, start/end, eventCount, totalLiqUsd,
   *  maxIndividualEventUsd, current P95, result) is visible in logs. */
  private handleCandlePhysicsPreW1Discard(event: import("../domain/cascade/candle-physics-engine").CandlePhysicsPreW1DiscardEvent): void {
    log.info(
      {
        symbol: event.symbol,
        victim: event.victim,
        candidateStartTs: event.candidateStartTs,
        candidateEndTs: event.candidateEndTs,
        eventCount: event.eventCount,
        totalLiqUsd: event.totalLiqUsd,
        maxIndividualEventUsd: event.maxIndividualEventUsd,
        p95AtCheck: event.p95AtCheck,
        result: event.reason,
      },
      "[PRE_W1_DISCARD]",
    );
  }

  private async handleCascadeSignalReady(event: CascadeSignalReadyEvent): Promise<void> {
    try {
      // Sep 10 2026 (Karo), operator-corrected mapping -- the TWO waves
      // that actually caused THIS signal decision (previous completed
      // wave -> w1 input, the weakening/triggering wave -> w2 input),
      // NOT waveHistory[0]/waveHistory[last] unconditionally. For a
      // normal W1->W2 signal these are the same thing (W1, W2); for a
      // longer cascade (e.g. W1 100k, W2 150k, W3 220k, W4 180k ->
      // SIGNAL_READY at W4), the pair fed into the UNCHANGED formula is
      // W3 (w1 input) and W4 (w2 input) -- the local strong-wave/
      // weakening-wave pair, not the episode's own very first wave.
      const triggerWave = event.waveHistory[event.waveHistory.length - 1]!;
      const previousWave = event.waveHistory[event.waveHistory.length - 2]!;
      const firstWave = event.waveHistory[0]!; // the TRUE episode-start wave -- used ONLY for qualifyingEvent* below
      const atr15mAbs = this.atrTracker.getATR(event.symbol, "15m") ?? 0;
      const baseline = this.liquidationStats.rollingMedianLiqNotionalPerMin(event.symbol, 60) ?? 0;
      const dominantWave = event.waveHistory.reduce((best, w) => (w.liqUsd > best.liqUsd ? w : best), event.waveHistory[0]!);

      // Sep 11 2026 (Karo), operator-requested -- REPLACES the constant
      // SL=0.30%/TP=0.70% observation-phase values with the
      // deterministic, episode-displacement-derived structural SL/TP
      // (episode-displacement-trade-plan.ts). Wave detection itself
      // (W1/W2, entry conditions, liquidation thresholds, the 1m ATR/
      // UNIT calculation) is completely unchanged -- this ONLY replaces
      // how SL/TP is computed once a signal is already ready.
      //
      // finalExtremePrice: the operator's own explicit definition --
      // "the final structural extreme across ALL waves that occurred
      // before entry", NOT necessarily Wave 1's own extreme. Computed
      // generically across the full waveHistory (currently always
      // exactly W1+W2, but this reduce() makes no assumption about
      // wave count) -- the LOWEST extreme for a LONG-victim episode,
      // the HIGHEST for a SHORT-victim episode.
      const firstAnchorPrice = event.waveHistory[0]!.anchorPrice;
      const finalExtremePrice = event.waveHistory.reduce(
        (best, w) => (event.side === "LONG" ? Math.min(best, w.extremePrice) : Math.max(best, w.extremePrice)),
        event.waveHistory[0]!.extremePrice,
      );
      const episodePlanCalc = deriveEpisodeDisplacementTradePlan({
        entryPrice: event.entryPrice,
        direction: event.side,
        firstAnchorPrice,
        finalExtremePrice,
        unitAbs: event.unitAbs,
      });
      const entry = episodePlanCalc.entryPrice;
      const sl = episodePlanCalc.stopLoss;
      const tp = episodePlanCalc.takeProfit;
      const slPct = episodePlanCalc.executionRiskPct;
      const tpPct = entry > 0 ? episodePlanCalc.rewardDistance / entry : 0;
      const rr = episodePlanCalc.rewardRiskRatio;
      const plan = { ok: true as const, entry, sl, tp, slPct, tpPct, rr };

      // Required logging (operator's own explicit field list, plus the
      // Sep 11 2026 UNIT-relative additions -- observational/analytical
      // only, never fed back into the SL/TP calculation above).
      log.info(
        {
          signalId: event.cascadeId,
          symbol: event.symbol,
          direction: event.side,
          unitAbs: episodePlanCalc.unitAbs,
          unitPctAtEntry: episodePlanCalc.unitPctAtEntry,
          entryPrice: episodePlanCalc.entryPrice,
          firstAnchorPrice: episodePlanCalc.firstAnchorPrice,
          finalExtremePrice: episodePlanCalc.finalExtremePrice,
          episodeDisplacement: episodePlanCalc.episodeDisplacement,
          episodeDisplacementPct: episodePlanCalc.episodeDisplacementPct,
          actualRecoveryDistance: episodePlanCalc.actualRecoveryDistance,
          actualRecoveryPct: episodePlanCalc.actualRecoveryPct,
          actualRecoveryUnits: episodePlanCalc.actualRecoveryUnits,
          naturalSL: episodePlanCalc.naturalSL,
          naturalRiskPct: episodePlanCalc.naturalRiskPct,
          executionRiskPct: episodePlanCalc.executionRiskPct,
          slAdjustment: episodePlanCalc.slAdjustment,
          stopLoss: episodePlanCalc.stopLoss,
          riskDistance: episodePlanCalc.riskDistance,
          stopDistanceUnits: episodePlanCalc.stopDistanceUnits,
          rewardRiskRatio: episodePlanCalc.rewardRiskRatio,
          takeProfit: episodePlanCalc.takeProfit,
          rewardDistance: episodePlanCalc.rewardDistance,
          takeProfitDistanceUnits: episodePlanCalc.takeProfitDistanceUnits,
        },
        "[EPISODE_DISPLACEMENT_TRADE_PLAN]",
      );

      // Sep 11 2026 (Karo), operator-requested -- OBSERVATIONAL/
      // ANALYTICAL LOGGING ONLY. dominantWave/signalWave liquidation-
      // efficiency comparison, computed and logged for every signal,
      // never influencing wave lifecycle, entry decisions, UNIT, or
      // SL/TP. triggerWave IS the signal-triggering wave here (see this
      // method's own earlier comment on triggerWave/previousWave).
      const waveEfficiencyAnalysis = computeWaveEfficiencyAnalysis(event.waveHistory, triggerWave.waveNumber, event.unitAbs, event.victim);
      if (waveEfficiencyAnalysis) {
        log.info(
          {
            signalId: event.cascadeId,
            symbol: event.symbol,
            dominantWaveNumber: waveEfficiencyAnalysis.dominant.waveNumber,
            dominantWaveLiqUsd: waveEfficiencyAnalysis.dominant.liqUsd,
            dominantWaveAnchorPrice: waveEfficiencyAnalysis.dominant.anchorPrice,
            dominantWaveExtremePrice: waveEfficiencyAnalysis.dominant.extremePrice,
            dominantWaveProgressUnits: waveEfficiencyAnalysis.dominant.progressUnits,
            dominantWaveEfficiency: waveEfficiencyAnalysis.dominant.efficiency,
            signalWaveNumber: waveEfficiencyAnalysis.signal.waveNumber,
            signalWaveLiqUsd: waveEfficiencyAnalysis.signal.liqUsd,
            signalWaveAnchorPrice: waveEfficiencyAnalysis.signal.anchorPrice,
            signalWaveExtremePrice: waveEfficiencyAnalysis.signal.extremePrice,
            signalWaveProgressUnits: waveEfficiencyAnalysis.signal.progressUnits,
            signalWaveEfficiency: waveEfficiencyAnalysis.signal.efficiency,
            liqRatio: waveEfficiencyAnalysis.liqRatio,
            efficiencyRatio: waveEfficiencyAnalysis.efficiencyRatio,
            exhaustion: waveEfficiencyAnalysis.exhaustion,
            exhaustionPct: waveEfficiencyAnalysis.exhaustionPct,
            previousEpisodeExtreme: waveEfficiencyAnalysis.previousEpisodeExtreme,
            newExtremeExtension: waveEfficiencyAnalysis.newExtremeExtension,
            newExtremeExtensionUnits: waveEfficiencyAnalysis.newExtremeExtensionUnits,
            unitAbs: waveEfficiencyAnalysis.unitAbs,
          },
          "[WAVE_EFFICIENCY_ANALYSIS]",
        );
      }

      const signalId = randomUUID();
      const totalLiq = event.waveHistory.reduce((sum, w) => sum + w.liqUsd, 0);

      // Sep 10 2026 (Karo), operator-requested production lifecycle
      // stabilization -- decided HERE, ONCE, BEFORE the doc is built,
      // and reused for BOTH the persisted isMainExecuted field AND the
      // actual distribute()/lock/activeTrade-install decision below,
      // so there is never a race between "what we said we'd do" and
      // "what we actually did".
      const willExecuteAsMain = !this.mainSymbolLocks.has(event.symbol);

      const globalSignal: GlobalSignalDoc = {
        signalId,
        symbol: event.symbol,
        side: event.side,
        victim: event.victim,
        signalTs: event.entryTs,
        entryPrice: event.entryPrice,
        entryWaveNumber: triggerWave.waveNumber,
        waveHistory: this.cascadeWavesToV5Waves(event.waveHistory, event.unitAbs, event.victim, atr15mAbs),
        w1Diagnostics: null,
        totalEpisodePressure: totalLiq,
        dominantLayerLiqUsd: dominantWave.liqUsd,
        dominantLayerWaveNumber: dominantWave.waveNumber,
        exhaustionLayerLiqUsd: triggerWave.liqUsd,
        exhaustionLayerWaveNumber: triggerWave.waveNumber,
        unitAtStart: event.unitAbs,
        p95AtEntry: this.liquidationStats.notionalPercentile(event.symbol, event.victim, 95),
        dailyLiqPerMinBaselineAtEntry: baseline,
        atr15mAtEntry: atr15mAbs,
        qualifyingEventUsd: firstWave.liqUsd,
        qualifyingEventTs: firstWave.anchorTs,
        p95AtQualification: this.liquidationStats.notionalPercentile(event.symbol, event.victim, 95),
        physics: {
          // Sep 10 2026 (Karo), operator-requested production
          // stabilization -- constant-TP/SL phase. Only the fields
          // that are GENUINELY meaningful under a fixed SL/TP are
          // populated with real values (finalTpPct/finalSlPct/actualRR,
          // cumLiqUsd/atrPct/liqBaseline -- these are simple, real
          // context, not physics-derived). Every OLD-physics-formula-
          // specific diagnostic (liqStrength, exhaustionScore,
          // absorptionScore, dynamicPhysicsScore, w2ToW1Ratio, etc.) is
          // explicitly 0/false -- NOT faked, NOT computed in this
          // phase, and the Telegram formatter's own "Physics
          // (episode-total-based)" line is suppressed for cascade
          // signals (see signal.formatter.ts) so these zeros are never
          // displayed as if they were real.
          cumLiqUsd: totalLiq,
          atrPct: atr15mAbs,
          liqBaseline: baseline,
          liqStrengthRaw: 0,
          liqStrength: 0,
          physicsTPPct: plan.tpPct,
          wallAdjustedTpPct: plan.tpPct,
          wallApplied: false,
          rrCandidate: plan.rr,
          slCapApplied: false,
          slCapValue: 0,
          finalTpPct: plan.tpPct,
          finalSlPct: plan.slPct,
          actualRR: plan.rr,
          structuralSoftExitPrice: 0,
          structuralRiskPct: 0,
          sizingRiskPct: 0,
          hardStopRiskPct: 0,
          liquidityStrengthP95: 0,
          liquidityStrength24h: 0,
          liquidityStrength: 0,
          w2ToW1Ratio: previousWave.liqUsd > 0 ? triggerWave.liqUsd / previousWave.liqUsd : 0,
          exhaustionScore: 0,
          w1DisplacementAtr: 0,
          absorptionRaw: 0,
          absorptionScore: 0,
          dynamicPhysicsScore: 0,
          selectedRR: plan.rr,
          tpMultiplier: 0,
          slDeterminedBy: "physics",
        },
        btcContext: null,
        marketContextAtEntry: null,
        liq24hContext: null,
        wallContext: null,
        entry: plan.entry,
        tp: plan.tp,
        sl: plan.sl,
        rr: plan.rr,
        btcSafetyStatus: "UNKNOWN",
        btcIntendedSideAtSignalTime: null,
        rejectionReason: null,
        planDiagnostics: null,
        status: "SIGNAL",
        closedAt: null,
        closePrice: null,
        maxFavorableR: null,
        maxAdverseR: null,
        liquidationStatsContext: null,
        researchCheckpoints: [],
        unitResearch: null,
        unitCompetitionResearch: null,
        commonHorizonResearch: null,
        cascadeId: event.cascadeId,
        timeframe: event.timeframe,
        isMainExecuted: willExecuteAsMain,
        episodePlan: episodePlanCalc,
        waveEfficiencyAnalysis,
        p95AtW1Qualification: null,
        maxIndividualEventUsdAtW1: null,
        w1QualificationTs: null,
        createdAt: Date.now(),
      };

      await this.globalSignalRepo.insert(globalSignal);
      log.info(
        `[CASCADE_CANDIDATE_SIGNAL] ${event.symbol} ${event.side} timeframe=${event.timeframe} cascadeId=${event.cascadeId} signalId=${signalId} waves=${event.waveHistory.length} entry=${plan.entry} sl=${plan.sl} tp=${plan.tp} rr=${plan.rr.toFixed(2)} willExecuteAsMain=${willExecuteAsMain}`,
      );

      const terminalDoc: CascadeCandidateStateDoc = {
        timeframe: event.timeframe,
        phase: "TERMINAL_SIGNAL",
        frozenUnitAbs: event.unitAbs,
        currentWaveNumber: triggerWave.waveNumber,
        waveHistory: event.waveHistory.map((w) => ({ ...w, state: "COMPLETED" as const })),
        currentExtreme: triggerWave.extremePrice,
        terminalStatus: "SIGNAL",
        terminalReason: null,
        terminalReasonText: null,
        cancelPrice: null,
        recoveryDistance: null,
        recoveryUnits: null,
        signalId,
        terminalAt: event.entryTs,
        lastUpdatedTs: event.entryTs,
      };
      void this.cascadeRepo.markCandidateTerminal(event.cascadeId, event.symbol, event.victim, event.cascadeStartTs, terminalDoc, event.entryTs);

      // Sep 10 2026 (Karo), operator-requested production lifecycle
      // stabilization. mainSymbolLocks continues to gate the ENTIRE
      // distribute() call, exactly as before this fix -- if MAIN
      // already holds an open real position for this symbol, this
      // candidate's own comparison record stays persisted (above,
      // always), but distribute() is skipped entirely (no per-user
      // Telegram/execution fan-out at all for this candidate), the
      // SAME conservative behavior as before. This deliberately avoids
      // a NEW, unverified risk: karo/artak/friend's own independent
      // execution is unrelated to mainSymbolLocks, so distributing a
      // comparison-only cascade-signal to them would open THEIR own
      // real positions too, for a candidate that was never meant to be
      // executable -- out of scope for this fix, not requested.
      //
      // THE ROOT-CAUSE FIX for cascade-signals staying stuck in
      // status="SIGNAL" forever: a cascade-produced trade was NEVER
      // previously installed into V5WaveService's own activeTrades map
      // at all, so onPriceTickForTrades() (MAIN's own canonical TP/SL-
      // touch detector) never knew it existed, so it could never
      // close, ever. hydrateActiveTrade() -- the SAME method restart-
      // hydration already uses -- is reused here to install it live,
      // the moment it becomes MAIN's own real, executed position.
      if (!willExecuteAsMain) return;
      // Sep 10 2026 (Karo), operator-reported CRITICAL FIX -- mainTelegramSent
      // is now checked and PROMINENTLY logged if false, so a silent MAIN
      // ENTRY-Telegram failure (network blip, Telegram API outage) is
      // never invisible again -- this is exactly the second, previously-
      // undetected source of the "CLOSE exists but ENTER was never seen"
      // class of bug (the first, restart-hydration-filter source, was
      // already fixed separately -- see hydrateMainLocks() above). The
      // trade is STILL installed/tracked below regardless (a real,
      // executing position must never go untracked just because its own
      // notification failed) -- this fix restores VISIBILITY, it does
      // not change execution behavior.
      const { mainTelegramSent } = await this.distributor.distribute(globalSignal, this.mongo);
      if (!mainTelegramSent) {
        log.error(
          `[CASCADE_MAIN_ENTRY_TELEGRAM_MISSING] ${event.symbol} ${event.side} timeframe=${event.timeframe} cascadeId=${event.cascadeId} signalId=${signalId} -- MAIN's own ENTRY notification FAILED to send, but this trade IS still being installed into active TP/SL tracking below and WILL eventually produce a CLOSE notification -- manual awareness needed for this signalId`,
        );
      }
      this.mainSymbolLocks.add(event.symbol);
      this.v5.hydrateActiveTrade({
        signalId,
        symbol: event.symbol,
        victim: event.victim,
        side: event.side,
        entry: plan.entry,
        tp: plan.tp,
        sl: plan.sl,
        openedAt: event.entryTs,
        bestPrice: plan.entry,
        worstPrice: plan.entry,
        entryWaveNumber: triggerWave.waveNumber,
        isLive: false,
        binanceSlOrderId: null,
        binanceTpOrderId: null,
        positionQty: null,
        notional: null,
        riskUsd: null,
        timeframe: event.timeframe,
      });

      const denom = Math.abs(plan.entry - plan.sl);
      const dirMul = event.side === "LONG" ? 1 : -1;
      this.researchCheckpoints.registerWatch(signalId, event.symbol, "SIGNAL", event.entryTs, plan.entry, { kind: "R", dirMul, denom });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, cascadeId: event.cascadeId, timeframe: event.timeframe }, "[CASCADE_SIGNAL_READY_UNHANDLED_ERROR]");
    }
  }

  /** Sep 10 2026 (Karo), operator-requested production simplification --
   *  gates ONLY on 1m ATR readiness now. Never waits for 3m/5m
   *  confirmation -- those timeframes are no longer part of live
   *  cascade creation at all. */
  private commonHorizonAtrReady(symbol: string): boolean {
    return (
      this.atrTracker.getWilderATR(
        symbol,
        "1m",
        COMMON_HORIZON_PERIODS.atr1m,
      ) !== null
    );
  }

  private feedUnitResearchShadowAfter(
    l: Liquidation,
    wasTrackedBefore: boolean,
  ): void {
    const victim: Side = l.side === "SELL" ? "LONG" : "SHORT";
    if (!wasTrackedBefore) {
      const newWatch = this.v5.getWatch(l.symbol, victim);
      if (!newWatch) return;
      const unit3m = this.atrTracker.getATR(l.symbol, "3m");
      if (unit3m !== null && unit3m > 0) {
        this.shadow3m.startEpisode(
          l.symbol,
          victim,
          newWatch.signalId,
          unit3m,
          l.price,
          l.timestamp,
          l.quoteQty,
          l.timestamp,
        );
      }
      const unit5m = this.atrTracker.getATR(l.symbol, "5m");
      if (unit5m !== null && unit5m > 0) {
        this.shadow5m.startEpisode(
          l.symbol,
          victim,
          newWatch.signalId,
          unit5m,
          l.price,
          l.timestamp,
          l.quoteQty,
          l.timestamp,
        );
      }
    } else {
      this.shadow3m.onLiquidation(l, victim);
      this.shadow5m.onLiquidation(l, victim);
    }

    this.feedCommonHorizonCompetition(l, victim);
  }

  private readonly commonHorizonEpisodes = new CommonHorizonEpisodeRegistry(
    this.competitionShadow1m,
    this.competitionShadow3m,
    this.competitionShadow5m,
    (signalId: string) => this.competitionWinners.has(signalId),
  );

  private feedCommonHorizonCompetition(l: Liquidation, victim: Side): void {
    const resolved = this.commonHorizonEpisodes.resolve(
      l.symbol,
      victim,
      l.timestamp,
      randomUUID,
    );

    if (resolved.action === "ignore") {
      return;
    }

    if (resolved.action === "route") {
      this.competitionShadow1m.onLiquidation(l, victim);
      this.competitionShadow3m.onLiquidation(l, victim);
      this.competitionShadow5m.onLiquidation(l, victim);
      return;
    }

    if (!this.commonHorizonAtrReady(l.symbol)) return;

    const chUnit1m = this.atrTracker.getWilderATR(
      l.symbol,
      "1m",
      COMMON_HORIZON_PERIODS.atr1m,
    );
    const chUnit3m = this.atrTracker.getWilderATR(
      l.symbol,
      "3m",
      COMMON_HORIZON_PERIODS.atr3m,
    );
    const chUnit5m = this.atrTracker.getWilderATR(
      l.symbol,
      "5m",
      COMMON_HORIZON_PERIODS.atr5m,
    );
    if (chUnit1m !== null && chUnit1m > 0)
      this.competitionShadow1m.startEpisode(
        l.symbol,
        victim,
        resolved.signalId,
        chUnit1m,
        l.price,
        resolved.episodeStartTs,
        l.quoteQty,
        resolved.episodeStartTs,
      );
    if (chUnit3m !== null && chUnit3m > 0)
      this.competitionShadow3m.startEpisode(
        l.symbol,
        victim,
        resolved.signalId,
        chUnit3m,
        l.price,
        resolved.episodeStartTs,
        l.quoteQty,
        resolved.episodeStartTs,
      );
    if (chUnit5m !== null && chUnit5m > 0)
      this.competitionShadow5m.startEpisode(
        l.symbol,
        victim,
        resolved.signalId,
        chUnit5m,
        l.price,
        resolved.episodeStartTs,
        l.quoteQty,
        resolved.episodeStartTs,
      );
  }

  private tickUnitResearchShadow(
    symbol: string,
    mid: number,
    ts: number,
  ): void {
    for (const victim of ["LONG", "SHORT"] as const) {
      this.handleShadowTick(
        "atr3m",
        this.shadow3m,
        this.shadowCheckpoints3m,
        symbol,
        victim,
        mid,
        ts,
      );
      this.handleShadowTick(
        "atr5m",
        this.shadow5m,
        this.shadowCheckpoints5m,
        symbol,
        victim,
        mid,
        ts,
      );
      this.handleCompetitionTick(
        "atr1m",
        this.competitionShadow1m,
        this.competitionCheckpoints1m,
        symbol,
        victim,
        mid,
        ts,
      );
      this.handleCompetitionTick(
        "atr3m",
        this.competitionShadow3m,
        this.competitionCheckpoints3m,
        symbol,
        victim,
        mid,
        ts,
      );
      this.handleCompetitionTick(
        "atr5m",
        this.competitionShadow5m,
        this.competitionCheckpoints5m,
        symbol,
        victim,
        mid,
        ts,
      );
      this.snapshotCommonHorizonPhase(
        "atr1m",
        this.competitionShadow1m,
        symbol,
        victim,
        mid,
        ts,
      );
      this.snapshotCommonHorizonPhase(
        "atr3m",
        this.competitionShadow3m,
        symbol,
        victim,
        mid,
        ts,
      );
      this.snapshotCommonHorizonPhase(
        "atr5m",
        this.competitionShadow5m,
        symbol,
        victim,
        mid,
        ts,
      );
    }
    const completed3m = this.shadowCheckpoints3m.onTick(symbol, mid, ts);
    for (const c of completed3m)
      void this.globalSignalRepo.appendUnitResearchCheckpoint(
        c.signalId,
        "atr3m",
        c.checkpoint,
      );
    const completed5m = this.shadowCheckpoints5m.onTick(symbol, mid, ts);
    for (const c of completed5m)
      void this.globalSignalRepo.appendUnitResearchCheckpoint(
        c.signalId,
        "atr5m",
        c.checkpoint,
      );
    for (const label of ["atr1m", "atr3m", "atr5m"] as const) {
      const tracker =
        label === "atr1m"
          ? this.competitionCheckpoints1m
          : label === "atr3m"
            ? this.competitionCheckpoints3m
            : this.competitionCheckpoints5m;
      const completed = tracker.onTick(symbol, mid, ts);
      for (const c of completed)
        void this.globalSignalRepo.appendCommonHorizonCheckpoint(
          c.signalId,
          label,
          c.checkpoint,
        );
    }
    this.checkCompetitionWinnerTouch(symbol, mid, ts);
  }

  private readonly commonHorizonLastSnapshot = new Map<
    string,
    { phase: string; ts: number }
  >();

  private snapshotCommonHorizonPhase(
    label: "atr1m" | "atr3m" | "atr5m",
    shadow: UnitResearchShadowService,
    symbol: string,
    victim: Side,
    mid: number,
    ts: number,
  ): void {
    const peek = shadow.peekWatch(symbol, victim);
    if (!peek) return;
    const owner = this.commonHorizonEpisodes.current(symbol);
    if (!owner || owner.victim !== victim) return;
    const ownerSignalId = owner.signalId;
    const snapKey = `${ownerSignalId}:${label}`;
    const last = this.commonHorizonLastSnapshot.get(snapKey);
    if (last && last.phase === peek.phase && ts - last.ts < 15_000) return;
    this.commonHorizonLastSnapshot.set(snapKey, { phase: peek.phase, ts });

    const period =
      label === "atr1m"
        ? COMMON_HORIZON_PERIODS.atr1m
        : label === "atr3m"
          ? COMMON_HORIZON_PERIODS.atr3m
          : COMMON_HORIZON_PERIODS.atr5m;
    const doc: CommonHorizonCandidateDoc = {
      candidate: this.candidateLabelShort(label) as "1m" | "3m" | "5m",
      atrPeriod: period,
      episodeStartTs: peek.episodeStartTs,
      frozenUnitAbs: peek.unitAbs,
      frozenAtrPct: peek.w1 ? peek.unitAbs / peek.w1.anchorPrice : 0,
      state: "TRACKING",
      phase: peek.phase,
      w1: peek.w1,
      w2: peek.w2,
      currentPrice: mid,
      nextTargetPrice: peek.nextTargetPrice,
      nextTargetDescription: peek.nextTargetDescription,
      lastUpdatedTs: ts,
      terminalReason: null,
      w1CompleteTs: null,
      w2StartTs: null,
      entryReadyTs: null,
      durationMs: null,
      episodeLiqUsdAtEntry: null,
      liqBaselineAtEntry: null,
      relativePressure: null,
      pressureFactor: null,
      rawTpPct: null,
      rrAttempts: [],
      selectedRR: null,
      rawSlPct: null,
      hypotheticalEntry: null,
      hypotheticalTp: null,
      hypotheticalSl: null,
      checkpoints: [],
    };
    void this.globalSignalRepo.setCommonHorizonCandidate(
      ownerSignalId,
      label,
      doc,
      { symbol, side: victim, signalTs: peek.episodeStartTs },
    );
  }

  private handleCompetitionTick(
    label: "atr1m" | "atr3m" | "atr5m",
    shadow: UnitResearchShadowService,
    checkpoints: ResearchCheckpointTracker,
    symbol: string,
    victim: Side,
    mid: number,
    ts: number,
  ): void {
    const result = shadow.onTick(symbol, victim, mid, ts);
    if (!result) return;
    const period =
      label === "atr1m"
        ? COMMON_HORIZON_PERIODS.atr1m
        : label === "atr3m"
          ? COMMON_HORIZON_PERIODS.atr3m
          : COMMON_HORIZON_PERIODS.atr5m;

    if ("entryPrice" in result) {
      const entry = result as ShadowEntryEvent;
      const frozenAtrPct = entry.unitAbs / entry.entryPrice;
      const episodeLiqUsdAtEntry = entry.w1.liqUsd + entry.w2.liqUsd;
      const liqBaselineAtEntry =
        this.liquidationStats.rollingMedianLiqNotionalPerMin(symbol, 60) ?? 0;
      const dragon = evaluateDragon(
        frozenAtrPct,
        episodeLiqUsdAtEntry,
        liqBaselineAtEntry,
      );

      let hypotheticalTp: number | null = null;
      let hypotheticalSl: number | null = null;
      if (dragon.verdict === "PASS" && dragon.rawSlPct !== null) {
        hypotheticalTp =
          entry.side === "LONG"
            ? entry.entryPrice * (1 + dragon.rawTpPct)
            : entry.entryPrice * (1 - dragon.rawTpPct);
        hypotheticalSl =
          entry.side === "LONG"
            ? entry.entryPrice * (1 - dragon.rawSlPct)
            : entry.entryPrice * (1 + dragon.rawSlPct);
      }

      const doc: CommonHorizonCandidateDoc = {
        candidate: label === "atr1m" ? "1m" : label === "atr3m" ? "3m" : "5m",
        atrPeriod: period,
        frozenUnitAbs: entry.unitAbs,
        frozenAtrPct,
        episodeStartTs: entry.episodeStartTs,
        state: dragon.verdict,
        phase: null,
        w1: {
          anchorPrice: entry.w1.anchorPrice,
          anchorTs: entry.w1.anchorTs,
          extremePrice: entry.w1.extremePrice,
          extremeTs: entry.w1.extremeTs,
          liqUsd: entry.w1.liqUsd,
          liqEvents: entry.w1.liqEvents,
        },
        w2: {
          anchorPrice: entry.w2.anchorPrice,
          anchorTs: entry.w2.anchorTs,
          extremePrice: entry.w2.extremePrice,
          extremeTs: entry.w2.extremeTs,
          liqUsd: entry.w2.liqUsd,
          liqEvents: entry.w2.liqEvents,
        },
        currentPrice: entry.entryPrice,
        nextTargetPrice: null,
        nextTargetDescription: null,
        lastUpdatedTs: ts,
        terminalReason:
          dragon.verdict === "PASS" ? null : this.dragonFailDetail(dragon),
        w1CompleteTs: entry.w1.completedTs,
        w2StartTs: entry.w2.startedTs,
        entryReadyTs: entry.entryTs,
        durationMs: entry.entryTs - entry.episodeStartTs,
        episodeLiqUsdAtEntry,
        liqBaselineAtEntry,
        relativePressure: dragon.relativePressure,
        pressureFactor: dragon.pressureFactor,
        rawTpPct: dragon.rawTpPct,
        rrAttempts: dragon.rrAttempts,
        selectedRR: dragon.selectedRR,
        rawSlPct: dragon.rawSlPct,
        hypotheticalEntry: entry.entryPrice,
        hypotheticalTp,
        hypotheticalSl,
        checkpoints: [],
      };
      void this.globalSignalRepo.setCommonHorizonCandidate(
        entry.signalId,
        label,
        doc,
        { symbol, side: entry.side, signalTs: entry.episodeStartTs },
      );
      this.setCompetitionCandidateStatus(
        entry.signalId,
        label,
        dragon.verdict === "PASS"
          ? { status: "PASS" }
          : { status: "FAIL", detail: this.dragonFailDetail(dragon) },
      );

      if (
        dragon.verdict === "PASS" &&
        dragon.rawSlPct !== null &&
        hypotheticalTp !== null &&
        hypotheticalSl !== null
      ) {
        checkpoints.registerWatch(
          `${entry.signalId}:comp:${label}`,
          symbol,
          "SIGNAL",
          entry.entryTs,
          entry.entryPrice,
          {
            kind: "R",
            dirMul: entry.side === "LONG" ? 1 : -1,
            denom: dragon.rawSlPct * entry.entryPrice,
          },
        );
        this.declareWinnerIfNone(
          entry.signalId,
          symbol,
          entry.side,
          label,
          entry.entryPrice,
          hypotheticalTp,
          hypotheticalSl,
          dragon.selectedRR ?? 0,
          entry.entryTs,
          frozenAtrPct,
          episodeLiqUsdAtEntry,
          liqBaselineAtEntry,
          dragon,
          entry.entryTs - entry.episodeStartTs,
        );
      }
    } else {
      const noEntry = result as ShadowNoEntryEvent;
      const doc: CommonHorizonCandidateDoc = {
        candidate: label === "atr1m" ? "1m" : label === "atr3m" ? "3m" : "5m",
        atrPeriod: period,
        frozenUnitAbs: noEntry.unitAbs,
        frozenAtrPct:
          noEntry.w1 && noEntry.w1.anchorPrice > 0
            ? noEntry.unitAbs / noEntry.w1.anchorPrice
            : 0,
        episodeStartTs: noEntry.episodeStartTs,
        state: "STRUCTURAL_CANCEL",
        phase: null,
        w1: noEntry.w1
          ? {
              anchorPrice: noEntry.w1.anchorPrice,
              anchorTs: noEntry.w1.anchorTs,
              extremePrice: noEntry.w1.extremePrice,
              extremeTs: noEntry.w1.extremeTs,
              liqUsd: noEntry.w1.liqUsd,
              liqEvents: noEntry.w1.liqEvents,
            }
          : null,
        w2: null,
        currentPrice: mid,
        nextTargetPrice: null,
        nextTargetDescription: null,
        lastUpdatedTs: ts,
        terminalReason: noEntry.reason,
        w1CompleteTs: null,
        w2StartTs: null,
        entryReadyTs: null,
        durationMs: null,
        episodeLiqUsdAtEntry: null,
        liqBaselineAtEntry: null,
        relativePressure: null,
        pressureFactor: null,
        rawTpPct: null,
        rrAttempts: [],
        selectedRR: null,
        rawSlPct: null,
        hypotheticalEntry: null,
        hypotheticalTp: null,
        hypotheticalSl: null,
        checkpoints: [],
      };
      void this.globalSignalRepo.setCommonHorizonCandidate(
        noEntry.signalId,
        label,
        doc,
        { symbol, side: victim, signalTs: noEntry.episodeStartTs },
      );
      this.setCompetitionCandidateStatus(noEntry.signalId, label, {
        status: "CANCEL",
        detail: noEntry.reason,
      });
    }
  }

  private setCompetitionCandidateStatus(
    signalId: string,
    label: "atr1m" | "atr3m" | "atr5m",
    entry: { status: "TRACKING" | "PASS" | "FAIL" | "CANCEL"; detail?: string },
  ): void {
    let byCandidate = this.competitionCandidateStatus.get(signalId);
    if (!byCandidate) {
      byCandidate = new Map();
      this.competitionCandidateStatus.set(signalId, byCandidate);
    }
    byCandidate.set(label, entry);
  }

  private dragonFailDetail(dragon: {
    rawSlPct: number | null;
    rrAttempts: readonly { slPct: number }[];
  }): string {
    if (dragon.rrAttempts.length === 0) return "no data";
    const maxSl = Math.max(...dragon.rrAttempts.map((a) => a.slPct));
    if (maxSl < 0.002) return "SL too small";
    const minSl = Math.min(...dragon.rrAttempts.map((a) => a.slPct));
    if (minSl > 0.005) return "SL too large";
    return "no valid RR";
  }

  private formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  private candidateLabelShort(label: "atr1m" | "atr3m" | "atr5m"): string {
    return label === "atr1m" ? "1m" : label === "atr3m" ? "3m" : "5m";
  }

  private declareWinnerIfNone(
    signalId: string,
    symbol: string,
    side: Side,
    candidate: "atr1m" | "atr3m" | "atr5m",
    entry: number,
    tp: number,
    sl: number,
    rr: number,
    entryTs: number,
    frozenAtrPct: number,
    episodeLiqUsdAtEntry: number,
    liqBaselineAtEntry: number,
    dragon: { relativePressure: number },
    durationMs: number,
  ): void {
    if (this.competitionWinners.has(signalId)) return;
    this.competitionWinners.set(signalId, {
      signalId,
      symbol,
      side,
      candidate,
      entry,
      tp,
      sl,
      rr,
      entryTs,
      maxFavorable: entry,
      maxAdverse: entry,
    });
    void this.globalSignalRepo.setCommonHorizonWinner(
      signalId,
      candidate,
      entryTs,
      { symbol, side, signalTs: entryTs - durationMs },
    );

    if (!this.mainTelegram) return;
    const tpPct = side === "LONG" ? (tp - entry) / entry : (entry - tp) / entry;
    const slPct = side === "LONG" ? (entry - sl) / entry : (sl - entry) / entry;
    const statusByCandidate = this.competitionCandidateStatus.get(signalId);
    const lines: string[] = [];
    for (const label of ["atr1m", "atr3m", "atr5m"] as const) {
      const short = this.candidateLabelShort(label);
      if (label === candidate) {
        lines.push(`${short} \u{1F3C6} PASS \u2014 WINNER`);
        continue;
      }
      const entryStatus = statusByCandidate?.get(label);
      if (!entryStatus || entryStatus.status === "TRACKING") {
        lines.push(`${short} \u23F3 TRACKING`);
      } else if (entryStatus.status === "PASS") {
        lines.push(`${short} \u2705 PASS`);
      } else if (entryStatus.status === "CANCEL") {
        lines.push(
          `${short} \u26A0\uFE0F CANCEL \u2014 ${entryStatus.detail ?? "structural"}`,
        );
      } else {
        lines.push(
          `${short} \u274C FAIL \u2014 ${entryStatus.detail ?? "no valid RR"}`,
        );
      }
    }
    const winnerShort = this.candidateLabelShort(candidate).toUpperCase();
    const message =
      `\u{1F9EA} RESEARCH ENTRY \u2014 ${symbol} ${side}\n\n` +
      `Winner: \u{1F3C6} ATR${winnerShort}\n\n` +
      `Entry: ${entry}\n` +
      `TP: ${tp.toFixed(6)} (+${(tpPct * 100).toFixed(2)}%)\n` +
      `SL: ${sl.toFixed(6)} (-${(slPct * 100).toFixed(2)}%)\n` +
      `RR: ${rr}\n\n` +
      `ATR${winnerShort}: ${(frozenAtrPct * 100).toFixed(2)}%\n` +
      `Episode Liq: $${(episodeLiqUsdAtEntry / 1000).toFixed(0)}k\n` +
      `Baseline: $${liqBaselineAtEntry.toFixed(0)}/min\n` +
      `Pressure: ${dragon.relativePressure.toFixed(2)}\n` +
      `Duration: ${this.formatDuration(durationMs)}\n\n` +
      `Candidates:\n${lines.join("\n")}`;
    void this.mainTelegram.sendMessage(message).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId },
        "[RESEARCH_ENTRY_TELEGRAM_FAILED] -- non-fatal",
      );
    });
  }

  private checkCompetitionWinnerTouch(
    symbol: string,
    mid: number,
    ts: number,
  ): void {
    for (const [signalId, w] of this.competitionWinners) {
      if (w.symbol !== symbol) continue;
      if (w.side === "LONG") {
        if (mid > w.maxFavorable) w.maxFavorable = mid;
        if (mid < w.maxAdverse) w.maxAdverse = mid;
      } else {
        if (mid < w.maxFavorable) w.maxFavorable = mid;
        if (mid > w.maxAdverse) w.maxAdverse = mid;
      }

      const hitTp = w.side === "LONG" ? mid >= w.tp : mid <= w.tp;
      const hitSl = w.side === "LONG" ? mid <= w.sl : mid >= w.sl;
      if (!hitTp && !hitSl) continue;

      const result: "TP" | "SL" = hitTp ? "TP" : "SL";
      this.competitionWinners.delete(signalId);
      void this.globalSignalRepo.setCommonHorizonWinnerResult(signalId, result);

      if (this.mainTelegram) {
        const slDistance = Math.abs(w.entry - w.sl);
        const mfeR =
          slDistance > 0
            ? (w.side === "LONG"
                ? w.maxFavorable - w.entry
                : w.entry - w.maxFavorable) / slDistance
            : 0;
        const maeR =
          slDistance > 0
            ? (w.side === "LONG"
                ? w.entry - w.maxAdverse
                : w.maxAdverse - w.entry) / slDistance
            : 0;
        const winnerShort = this.candidateLabelShort(w.candidate).toUpperCase();
        const message =
          `\u{1F9EA} RESEARCH CLOSE \u2014 ${symbol} ${w.side}\n\n` +
          `Result: ${result === "TP" ? "\u2705 TP" : "\u274C SL"}\n` +
          `Winner: \u{1F3C6} ATR${winnerShort}\n\n` +
          `Entry: ${w.entry}\n` +
          `TP: ${w.tp.toFixed(6)}\n` +
          `SL: ${w.sl.toFixed(6)}\n` +
          `RR: ${w.rr}\n\n` +
          `MFE: +${mfeR.toFixed(2)}R\n` +
          `MAE: -${Math.max(0, maeR).toFixed(2)}R\n` +
          `Duration: ${this.formatDuration(ts - w.entryTs)}`;
        void this.mainTelegram.sendMessage(message).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            { err: msg, signalId },
            "[RESEARCH_CLOSE_TELEGRAM_FAILED] -- non-fatal",
          );
        });
      }
    }
  }

  private handleShadowTick(
    label: "atr3m" | "atr5m",
    shadow: UnitResearchShadowService,
    checkpoints: ResearchCheckpointTracker,
    symbol: string,
    victim: Side,
    mid: number,
    ts: number,
  ): void {
    const result = shadow.onTick(symbol, victim, mid, ts);
    if (!result) return;
    if ("entryPrice" in result) {
      const entry = result as ShadowEntryEvent;
      const prodWatch = this.v5.getWatch(symbol, victim);
      const prodEntryTs: number | null = null;
      const planResult = deriveLiquidationPhysicsTradePlan({
        entry: entry.entryPrice,
        side: entry.side,
        w1AnchorPrice: entry.w1.anchorPrice,
        w1ExtremePrice: entry.w1.extremePrice,
        w1LiqUsd: entry.w1.liqUsd,
        w2LiqUsd: entry.w2.liqUsd,
        atr15mAbs: this.atrTracker.getATR(symbol, "15m") ?? 0,
        p95: this.liquidationStats.notionalPercentile(symbol, victim, 95),
        dailyLiqPerMinBaseline: 0,
      });
      const doc: UnitResearchCandidateDoc = {
        unitAbs: entry.unitAbs,
        entered: true,
        entryPrice: entry.entryPrice,
        entryTs: entry.entryTs,
        delayVsProductionMs:
          prodEntryTs !== null ? entry.entryTs - prodEntryTs : null,
        noEntryReason: null,
        w1: entry.w1,
        w2: entry.w2,
        planSlPct: planResult.ok ? planResult.slPct : null,
        planTpPct: planResult.ok ? planResult.tpPct : null,
        planRr: planResult.ok ? planResult.rr : null,
        checkpoints: [],
      };
      void this.globalSignalRepo.setUnitResearchCandidate(
        entry.signalId,
        label,
        doc,
      );
      const denom = planResult.ok
        ? planResult.slPct * entry.entryPrice
        : entry.unitAbs;
      checkpoints.registerWatch(
        `${entry.signalId}:${label}`,
        symbol,
        "SIGNAL",
        entry.entryTs,
        entry.entryPrice,
        {
          kind: "R",
          dirMul: entry.side === "LONG" ? 1 : -1,
          denom: denom > 0 ? denom : entry.unitAbs,
        },
      );
      void prodWatch;
    } else {
      const noEntry = result as ShadowNoEntryEvent;
      const doc: UnitResearchCandidateDoc = {
        unitAbs: noEntry.unitAbs,
        entered: false,
        entryPrice: null,
        entryTs: null,
        delayVsProductionMs: null,
        noEntryReason: noEntry.reason,
        w1: noEntry.w1,
        w2: null,
        planSlPct: null,
        planTpPct: null,
        planRr: null,
        checkpoints: [],
      };
      void this.globalSignalRepo.setUnitResearchCandidate(
        noEntry.signalId,
        label,
        doc,
      );
    }
  }

  private atrAbsFor(symbol: string, referencePrice: number): number | null {
    const atrPct = this.atrTracker.getATR(symbol, "15m");
    if (!atrPct || !(atrPct > 0)) return null;
    return atrPct * referencePrice;
  }

  /** Sep 14 2026 (Karo), operator-approved -- V5 ROTATION mode. Causal
   *  cumulative-episode-total P95, computed from the existing
   *  GlobalSignal persistence via findCompletedRotationEpisodeTotals()
   *  (reads only records with createdAt < beforeTs -- no future
   *  leakage). Linear-interpolated P95 over the returned totals,
   *  matching the research thread's own percentile() convention.
   *  Public so main.ts's placeholder-indirection callback (matching
   *  every other V5 dependency's own wiring pattern) can reach it. */
  /** Sep 14 2026 (Karo), operator-requested -- reads causal ROTATION
   *  episode history from BOTH sources and combines them into one
   *  population before computing the percentile: the offline backfill
   *  (rotation_episode_history, reconstructed from historical raw
   *  liquidation + candle data) and any live-observed ROTATION
   *  episodes already persisted to v5_global_signals (unchanged from
   *  before this backfill work). Neither source alone is sufficient
   *  once the backfill exists -- combining them is what lets a new
   *  live watch see the FULL causal population (backfilled +
   *  previously-live) immediately, with no 20-live-episode warmup. */
  async getRotationCausalP95(symbol: string, victim: "LONG" | "SHORT", beforeTs: number): Promise<{ p95: number | null; sampleCount: number }> {
    const [liveRows, historyRows] = await Promise.all([
      this.globalSignalRepo.findCompletedRotationEpisodeTotals(symbol, victim, beforeTs),
      this.rotationEpisodeHistoryRepo.findCausalPriorEpisodes(symbol, victim, beforeTs),
    ]);
    const sorted = [...liveRows, ...historyRows].map((r) => r.totalUsd).sort((a, b) => a - b);
    if (sorted.length === 0) return { p95: null, sampleCount: 0 };
    const idx = 0.95 * (sorted.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    const p95 = lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
    return { p95, sampleCount: sorted.length };
  }

  private async handleMainTradeClose(close: V5TradeCloseEvent): Promise<void> {
    try {
      const maxFavorableR =
        close.trade.side === "LONG"
          ? (close.trade.bestPrice - close.trade.entry) /
            (close.trade.entry - close.trade.sl)
          : (close.trade.entry - close.trade.bestPrice) /
            (close.trade.sl - close.trade.entry);
      const maxAdverseR =
        close.trade.side === "LONG"
          ? (close.trade.worstPrice - close.trade.entry) /
            (close.trade.entry - close.trade.sl)
          : (close.trade.entry - close.trade.worstPrice) /
            (close.trade.sl - close.trade.entry);

      await this.globalSignalRepo.finalizeMainClose(close.trade.signalId, {
        status: close.outcome === "TP" ? "CLOSED_TP" : "CLOSED_SL",
        closedAt: close.closeTs,
        closePrice: close.closePrice,
        maxFavorableR,
        maxAdverseR,
      });

      this.mainSymbolLocks.delete(close.trade.symbol);
      log.info(
        `[MAIN_TRADE_CLOSED_${close.outcome}] ${close.trade.symbol} ${close.trade.side} signalId=${close.trade.signalId} entry=${close.trade.entry} close=${close.closePrice} -- symbol lock released`,
      );

      if (this.mainTelegram) {
        try {
          const message = formatV5CloseMessage(
            close.trade.symbol,
            close.trade.side,
            close.outcome,
            close.trade.entry,
            close.closePrice,
            close.trade.entryWaveNumber,
            close.trade.timeframe,
            close.trade.signalId,
            close.closeTs - close.trade.openedAt,
          );
          await this.mainTelegram.sendMessage(message);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            { err: msg, signalId: close.trade.signalId },
            "[MAIN_CLOSE_TELEGRAM_FAILED]",
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId: close.trade.signalId },
        "[MAIN_TRADE_CLOSE_UNHANDLED_ERROR]",
      );
    }
  }

  private async handleTickOutcome(outcome: V5TickOutcome): Promise<void> {
    try {
      if (outcome.kind === "TERMINAL_NON_SIGNAL") {
        await this.persistTerminalNonSignal(
          outcome.event.watch.symbol,
          outcome.event.reason,
          outcome.event.watch,
          outcome.event.waveHistory,
        );
        return;
      }

      const anchorPrice =
        outcome.entryWave.reclaimPrice ?? outcome.entryWave.anchorPrice;
      const event = this.v5.evaluateSignal(
        outcome.watch,
        outcome.entryWave,
        anchorPrice,
        Date.now(),
      );

      if (!event) {
        const atrAbs = this.atrAbsFor(outcome.watch.symbol, anchorPrice);
        if (atrAbs !== null) {
          const dirMul = outcome.watch.side === "LONG" ? 1 : -1;
          this.researchCheckpoints.registerWatch(
            outcome.watch.signalId,
            outcome.watch.symbol,
            "EXHAUSTION_CANDIDATE",
            Date.now(),
            anchorPrice,
            { kind: "ATR", dirMul, denom: atrAbs },
          );
        }
        return;
      }

      const hasRealPlan = event.plan !== null;

      const liquidationStatsContext = {
        currentVictim: event.victim,
        long: this.liquidationStats.getVictimStatsSnapshot(
          event.symbol,
          "LONG",
        ),
        short: this.liquidationStats.getVictimStatsSnapshot(
          event.symbol,
          "SHORT",
        ),
      };

      const globalSignal: GlobalSignalDoc = {
        signalId: event.signalId,
        cascadeId: null,
        timeframe: null,
        episodePlan: null,
        waveEfficiencyAnalysis: null,
        p95AtW1Qualification: null,
        maxIndividualEventUsdAtW1: null,
        w1QualificationTs: null,
        isMainExecuted: true,
        symbol: event.symbol,
        side: event.side,
        victim: event.victim,
        signalTs: event.signalTs,
        entryPrice: event.entryPrice,
        entryWaveNumber: event.entryWaveNumber,
        waveHistory: event.waveHistory,
        w1Diagnostics: event.w1Diagnostics,
        totalEpisodePressure: event.totalEpisodePressure,
        dominantLayerLiqUsd: event.dominantLayerLiqUsd,
        dominantLayerWaveNumber: event.dominantLayerWaveNumber,
        exhaustionLayerLiqUsd: event.exhaustionLayerLiqUsd,
        exhaustionLayerWaveNumber: event.exhaustionLayerWaveNumber,
        unitAtStart: event.unitAtStart,
        p95AtEntry: event.p95AtEntry,
        dailyLiqPerMinBaselineAtEntry: event.dailyLiqPerMinBaselineAtEntry,
        atr15mAtEntry: event.atr15mAtEntry,
        qualifyingEventUsd: event.qualifyingEventUsd,
        qualifyingEventTs: event.qualifyingEventTs,
        p95AtQualification: event.p95AtQualification,
        physics: event.plan
          ? {
              cumLiqUsd: event.totalEpisodePressure,
              atrPct: this.atrTracker.getATR(event.symbol, "15m") ?? 0,
              liqBaseline: event.plan.liqBaseline,
              liqStrengthRaw: event.plan.liqStrengthRaw,
              liqStrength: event.plan.liqStrength,
              physicsTPPct: event.plan.physicsTPPct,
              wallAdjustedTpPct: event.plan.wallAdjustedTpPct,
              wallApplied: event.plan.wallApplied,
              rrCandidate: event.plan.rrCandidate,
              slCapApplied: event.plan.slCapApplied,
              slCapValue: event.plan.slCapValue,
              finalTpPct: event.plan.finalTpPct,
              finalSlPct: event.plan.finalSlPct,
              actualRR: event.plan.rr,
              structuralSoftExitPrice: event.plan.structuralSoftExitPrice,
              structuralRiskPct: event.plan.structuralRiskPct,
              sizingRiskPct: event.plan.sizingRiskPct,
              hardStopRiskPct: event.plan.hardStopRiskPct,
              liquidityStrengthP95: event.plan.liquidityStrengthP95,
              liquidityStrength24h: event.plan.liquidityStrength24h,
              liquidityStrength: event.plan.liquidityStrength,
              w2ToW1Ratio: event.plan.w2ToW1Ratio,
              exhaustionScore: event.plan.exhaustionScore,
              w1DisplacementAtr: event.plan.w1DisplacementAtr,
              absorptionRaw: event.plan.absorptionRaw,
              absorptionScore: event.plan.absorptionScore,
              dynamicPhysicsScore: event.plan.dynamicPhysicsScore,
              selectedRR: event.plan.selectedRR,
              tpMultiplier: event.plan.tpMultiplier,
              slDeterminedBy: event.plan.slDeterminedBy,
            }
          : null,
        btcContext: event.btcContext ? { ...event.btcContext, btcSeriousEpisodePhase: null, btcSeriousEpisodeP95AtQualification: null, btcSeriousEpisodeMaxIndividualEventUsd: null, btcSeriousEpisodeQualificationTs: null, btcActiveCascadeSide: null } : null,
        marketContextAtEntry: null,
        liq24hContext: event.liq24hContext,
        wallContext: event.wallContext,
        entry: event.plan?.entry ?? null,
        tp: event.plan?.tp ?? null,
        sl: event.plan?.sl ?? null,
        rr: event.plan?.rr ?? null,
        btcSafetyStatus: event.btcSafetyStatus,
        btcIntendedSideAtSignalTime: event.btcIntendedSideAtSignalTime,
        rejectionReason: event.plan ? null : event.rejectionReason,
        planDiagnostics: event.planDiagnostics,
        status: hasRealPlan ? "SIGNAL" : "REJECTED_PLAN",
        closedAt: null,
        closePrice: null,
        maxFavorableR: null,
        maxAdverseR: null,
        liquidationStatsContext,
        researchCheckpoints: [],
        unitResearch: null,
        unitCompetitionResearch: null,
        commonHorizonResearch: null,
        createdAt: Date.now(),
      };

      if (this.productionSignalsEnabled) {
        await this.distributor.distribute(globalSignal, this.mongo);
        if (
          hasRealPlan &&
          globalSignal.entry !== null &&
          globalSignal.sl !== null
        ) {
          this.mainSymbolLocks.add(event.symbol);
        }
      }

      if (
        hasRealPlan &&
        globalSignal.entry !== null &&
        globalSignal.sl !== null
      ) {
        const denom = Math.abs(globalSignal.entry - globalSignal.sl);
        const dirMul = event.side === "LONG" ? 1 : -1;
        this.researchCheckpoints.registerWatch(
          event.signalId,
          event.symbol,
          "SIGNAL",
          event.signalTs,
          globalSignal.entry,
          { kind: "R", dirMul, denom },
        );
      } else {
        const atrAbs = this.atrAbsFor(event.symbol, anchorPrice);
        if (atrAbs !== null) {
          const dirMul = event.side === "LONG" ? 1 : -1;
          this.researchCheckpoints.registerWatch(
            event.signalId,
            event.symbol,
            "EXHAUSTION_CANDIDATE",
            event.signalTs,
            anchorPrice,
            { kind: "ATR", dirMul, denom: atrAbs },
          );
        }
      }

      this.v5.releaseWatch(outcome.watch.symbol, outcome.watch.victim);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg },
        "[MARKET_DATA_ORCHESTRATOR_TICK_OUTCOME_UNHANDLED_ERROR]",
      );
    }
  }

  private async persistTerminalNonSignal(
    symbol: string,
    reason: string,
    watch: {
      symbol: string;
      side: "LONG" | "SHORT";
      victim: "LONG" | "SHORT";
      signalId: string;
      createdAt: number;
      totalEpisodePressure: number;
      qualifyingEventUsd: number;
      qualifyingEventTs: number;
      p95AtQualification: number;
    },
    waveHistory: unknown,
  ): Promise<void> {
    const doc: GlobalSignalDoc = {
      signalId: watch.signalId ?? randomUUID(),
      symbol,
      side: watch.side,
      cascadeId: null,
      timeframe: null,
      episodePlan: null,
      waveEfficiencyAnalysis: null,
      p95AtW1Qualification: null,
      maxIndividualEventUsdAtW1: null,
      w1QualificationTs: null,
      isMainExecuted: false,
      victim: watch.victim,
      signalTs: watch.createdAt,
      entryPrice: 0,
      entryWaveNumber: 0,
      waveHistory: waveHistory as GlobalSignalDoc["waveHistory"],
      w1Diagnostics: null,
      totalEpisodePressure: watch.totalEpisodePressure,
      dominantLayerLiqUsd: null,
      dominantLayerWaveNumber: null,
      exhaustionLayerLiqUsd: null,
      exhaustionLayerWaveNumber: null,
      unitAtStart: 0,
      p95AtEntry: 0,
      dailyLiqPerMinBaselineAtEntry: 0,
      atr15mAtEntry: 0,
      qualifyingEventUsd: watch.qualifyingEventUsd,
      qualifyingEventTs: watch.qualifyingEventTs,
      p95AtQualification: watch.p95AtQualification,
      physics: null,
      btcContext: null,
      marketContextAtEntry: null,
      liq24hContext: null,
      wallContext: null,
      entry: null,
      tp: null,
      sl: null,
      rr: null,
      btcSafetyStatus: "UNKNOWN",
      btcIntendedSideAtSignalTime: null,
      rejectionReason: reason,
      planDiagnostics: null,
      status: reason as GlobalSignalDoc["status"],
      closedAt: null,
      closePrice: null,
      maxFavorableR: null,
      maxAdverseR: null,
      liquidationStatsContext: null,
      researchCheckpoints: [],
      unitResearch: null,
      unitCompetitionResearch: null,
      commonHorizonResearch: null,
      createdAt: Date.now(),
    };
    await this.globalSignalRepo.insert(doc);

    const waves = doc.waveHistory as V5Wave[];
    const lastWave = waves.length > 0 ? waves[waves.length - 1] : null;
    if (lastWave) {
      const atrAbs = this.atrAbsFor(symbol, lastWave.extremePrice);
      if (atrAbs !== null) {
        const dirMul = watch.side === "LONG" ? 1 : -1;
        this.researchCheckpoints.registerWatch(
          doc.signalId,
          symbol,
          "EPISODE_END",
          Date.now(),
          lastWave.extremePrice,
          { kind: "ATR", dirMul, denom: atrAbs },
        );
      }
    }
  }
}
