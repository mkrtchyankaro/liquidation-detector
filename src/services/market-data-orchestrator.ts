import { randomUUID } from "crypto";
import { BinanceWsClient } from "../infrastructure/binance/binanceWs.client";
import {
  V5WaveService,
  type V5TickOutcome,
  type V5TradeCloseEvent,
} from "../strategy/v5/v5-wave.service";
import { OiTrackerService } from "../domain/liquidation/oi-tracker.service";
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
import {
  CascadeCandidateService,
  type CascadeSignalReadyEvent,
  type CascadeCancelEvent,
} from "../domain/cascade/cascade-candidate.service";
import { CascadeRegistry } from "../domain/cascade/cascade-registry";
import { CascadeRepository } from "../infrastructure/mongo/cascade.repository";
import type { CascadeCandidateStateDoc } from "../domain/cascade/cascade.model";
import type {
  GlobalSignalDoc,
  UnitResearchCandidateDoc,
  CommonHorizonCandidateDoc,
} from "../domain/signal/global-signal.model";
import type { Side, Liquidation } from "../shared/common.types";
import { deriveLiquidationPhysicsTradePlan } from "../domain/trading/liquidation-physics-trade-plan";
import { evaluateDragon } from "../domain/research/unit-competition-dragon";
import type { V5Wave } from "../strategy/v5/v5-wave.model";
import type { SignalDistributor } from "./signal-distributor";
import type { ReconciliationManager } from "./reconciliation-manager";
import type { MongoClientWrapper } from "../infrastructure/mongo/mongo.client";
import { GlobalSignalRepository } from "../infrastructure/mongo/global-signal.repository";
import { RawLiquidationEventRepository } from "../infrastructure/mongo/raw-liquidation-event.repository";
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
  readonly wallTracker: WallTrackerService;
  readonly candleStore = new CandleStore();
  readonly tradeStore = new TradeStore();
  readonly orderbookStore = new OrderbookStore();
  readonly atrTracker = new ATRTrackerService();
  readonly oiTracker: OiTrackerService;
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
  private readonly cascadeCandidate3m = new CascadeCandidateService();
  private readonly cascadeCandidate5m = new CascadeCandidateService();
  private readonly cascadeRegistry = new CascadeRegistry(
    this.cascadeCandidate1m,
    this.cascadeCandidate3m,
    this.cascadeCandidate5m,
  );
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
    private readonly productionSignalsEnabled: boolean = true,
  ) {
    this.liquidationStats = new LiquidationStatsService(liquidationStatsConfig);
    this.wallTracker = new WallTrackerService(wallTrackerConfig);
    this.liqFeedWatchdog = new LiqFeedWatchdogService(log, broadcastTelegram);
    this.oiTracker = new OiTrackerService(symbols);
    this.globalSignalRepo = new GlobalSignalRepository(mongo);
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
  }

  async ensureIndexes(): Promise<void> {
    await this.rawLiquidationEventRepo.ensureIndexes();
    // Sep 10 2026 (Karo), operator-reported CRITICAL FIX -- unique
    // index on cascadeId, see CascadeRepository.ensureIndexes()'s own
    // doc comment for the duplicate-cascade-document race it fixes.
    await this.cascadeRepo.ensureIndexes();
  }

  async hydrateMainLocks(): Promise<void> {
    const openDocs = await this.globalSignalRepo.findOpenMainSignals();
    let hydrated = 0;
    for (const doc of openDocs) {
      if (doc.entry === null || doc.tp === null || doc.sl === null) continue;
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
      });
      hydrated++;
    }
    log.info(
      `[MAIN_LOCKS_HYDRATED] ${hydrated} open MAIN signal(s) restored from Mongo, symbols locked: [${[...this.mainSymbolLocks].join(", ")}]`,
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
      this.cascadeRegistry.restoreOwnership(
        doc.symbol,
        doc.cascadeId,
        doc.startedAt,
        doc.victimSide,
      );
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

  start(): void {
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
    });

    this.ws.on("liquidation", (l) => {
      this.liqFeedWatchdog.recordEvent(l.symbol);
      this.liquidationStore.ingest(l);
      this.liquidationStats.ingest(l);
      void this.rawLiquidationEventRepo.insert({
        symbol: l.symbol,
        victim: l.side === "SELL" ? "LONG" : "SHORT",
        price: l.price,
        quoteQty: l.quoteQty,
        timestamp: l.timestamp,
      });
      const victimForShadow: Side = l.side === "SELL" ? "LONG" : "SHORT";
      // Sep 10 2026 (Karo), operator-requested production V5 multi-
      // timeframe cascade lifecycle -- PURELY ADDITIVE call, placed
      // BEFORE the mainSymbolLocks early-return below so cascade-
      // tracking for THIS symbol is never paused just because MAIN
      // happens to already hold a real, open position for it (e.g.
      // from an earlier-signaling candidate) -- mainSymbolLocks itself
      // is completely untouched by this call; it continues to gate
      // ONLY the real-position-creation step inside
      // handleCascadeSignalReady() below, exactly as it already does
      // for the existing V5 signal path.
      void this.feedCascade(l, victimForShadow);
      if (this.mainSymbolLocks.has(l.symbol)) return;
      const wasTrackedBeforeProduction = this.wasProductionWatchTracked(
        l.symbol,
        victimForShadow,
      );
      const outcomes = this.v5.onLiquidation(l);
      for (const outcome of outcomes) void this.handleTickOutcome(outcome);
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
      // persist new results. The NEW cascade engine (feedCascade()
      // above) is now the ONLY 1m/3m/5m candidate lifecycle receiving
      // live liquidation events for this purpose.
      // this.feedUnitResearchShadowAfter(l, wasTrackedBeforeProduction);
    });

    this.ws.on("bookTicker", (b) => {
      const mid = (b.bid + b.ask) / 2;
      const outcomes = this.v5.onTick(b.symbol, mid, b.timestamp);
      for (const outcome of outcomes) void this.handleTickOutcome(outcome);
      const closes = this.v5.onPriceTickForTrades(b.symbol, mid, b.timestamp);
      for (const close of closes) void this.handleMainTradeClose(close);
      void this.reconciliation.onTick(b.symbol, b.timestamp);
      this.tickResearchCheckpoints(b.symbol, mid, b.timestamp);
      // Sep 10 2026 (Karo), operator-requested: DISCONNECTED, same
      // rationale as feedUnitResearchShadowAfter() above -- this call
      // fed live bookTicker ticks into the old research state machine
      // (wave-completion checks, dragon evaluation, winner-touch
      // checks, research Telegram). Left commented, not deleted.
      // this.tickUnitResearchShadow(b.symbol, mid, b.timestamp);
      // Sep 10 2026 (Karo), operator-requested production V5 multi-
      // timeframe cascade lifecycle -- PURELY ADDITIVE.
      this.tickCascade(b.symbol, mid, b.timestamp);
    });

    this.ws.on("orderbook", (snap) => {
      this.wallTracker.ingest(snap);
      this.orderbookStore.setDepth(snap);
    });

    this.ws.on("aggTrade", (t) => {
      this.tradeStore.ingest(t);
      this.aggressiveFlow.ingest(t);
    });

    this.ws.start();
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
  private async persistActiveCandidateSnapshot(
    symbol: string,
    victim: Side,
    candidate: CascadeCandidateService,
    timeframe: "1m" | "3m" | "5m",
    now: number,
  ): Promise<void> {
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
      signalId: null,
      lastUpdatedTs: now,
    };
    await this.cascadeRepo.upsertCandidateState(
      state.cascadeId,
      symbol,
      victim,
      state.createdAt,
      doc,
      now,
    );
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
    const resolved = this.cascadeRegistry.resolve(
      l.symbol,
      victim,
      l.timestamp,
      randomUUID,
    );

    if (resolved.action === "ignore") return;

    if (resolved.action === "route") {
      this.cascadeCandidate1m.onLiquidation(l, victim);
      this.cascadeCandidate3m.onLiquidation(l, victim);
      this.cascadeCandidate5m.onLiquidation(l, victim);
      await this.persistActiveCandidateSnapshot(
        l.symbol,
        victim,
        this.cascadeCandidate1m,
        "1m",
        l.timestamp,
      );
      await this.persistActiveCandidateSnapshot(
        l.symbol,
        victim,
        this.cascadeCandidate3m,
        "3m",
        l.timestamp,
      );
      await this.persistActiveCandidateSnapshot(
        l.symbol,
        victim,
        this.cascadeCandidate5m,
        "5m",
        l.timestamp,
      );
      return;
    }

    if (!this.commonHorizonAtrReady(l.symbol)) return;
    const unit1m = this.atrTracker.getWilderATR(
      l.symbol,
      "1m",
      COMMON_HORIZON_PERIODS.atr1m,
    );
    const unit3m = this.atrTracker.getWilderATR(
      l.symbol,
      "3m",
      COMMON_HORIZON_PERIODS.atr3m,
    );
    const unit5m = this.atrTracker.getWilderATR(
      l.symbol,
      "5m",
      COMMON_HORIZON_PERIODS.atr5m,
    );
    if (unit1m !== null && unit1m > 0) {
      this.cascadeCandidate1m.startCascade(
        l.symbol,
        victim,
        resolved.cascadeId,
        "1m",
        unit1m,
        l.price,
        resolved.cascadeStartTs,
        l.quoteQty,
        resolved.cascadeStartTs,
      );
      await this.persistActiveCandidateSnapshot(
        l.symbol,
        victim,
        this.cascadeCandidate1m,
        "1m",
        l.timestamp,
      );
    }
    if (unit3m !== null && unit3m > 0) {
      this.cascadeCandidate3m.startCascade(
        l.symbol,
        victim,
        resolved.cascadeId,
        "3m",
        unit3m,
        l.price,
        resolved.cascadeStartTs,
        l.quoteQty,
        resolved.cascadeStartTs,
      );
      await this.persistActiveCandidateSnapshot(
        l.symbol,
        victim,
        this.cascadeCandidate3m,
        "3m",
        l.timestamp,
      );
    }
    if (unit5m !== null && unit5m > 0) {
      this.cascadeCandidate5m.startCascade(
        l.symbol,
        victim,
        resolved.cascadeId,
        "5m",
        unit5m,
        l.price,
        resolved.cascadeStartTs,
        l.quoteQty,
        resolved.cascadeStartTs,
      );
      await this.persistActiveCandidateSnapshot(
        l.symbol,
        victim,
        this.cascadeCandidate5m,
        "5m",
        l.timestamp,
      );
    }
  }

  /** Sep 10 2026 (Karo), operator-requested production V5 multi-
   *  timeframe cascade lifecycle. Called on EVERY bookTicker tick,
   *  PURELY ADDITIVE. Ticks all three candidates for BOTH victims --
   *  each candidate's own onTick() is a complete no-op when it has no
   *  active watch for that symbol/victim, so this is cheap for the
   *  vast majority of ticks. A signal-ready result flows into the
   *  EXISTING V5 signal path (handleCascadeSignalReady()); a cancel
   *  result is diagnostic-only (logged, no further action). */
  private tickCascade(symbol: string, mid: number, ts: number): void {
    for (const victim of ["LONG", "SHORT"] as const) {
      this.handleCascadeTick(
        "1m",
        this.cascadeCandidate1m,
        symbol,
        victim,
        mid,
        ts,
      );
      this.handleCascadeTick(
        "3m",
        this.cascadeCandidate3m,
        symbol,
        victim,
        mid,
        ts,
      );
      this.handleCascadeTick(
        "5m",
        this.cascadeCandidate5m,
        symbol,
        victim,
        mid,
        ts,
      );
    }
  }

  /** Sep 10 2026 (Karo), operator-requested restart-safe persistence.
   *  Tracks the last-persisted (waveCount, extremePrice) per candidate
   *  watch, so persistActiveCandidateSnapshot() is only actually called
   *  (a real Mongo write) when something meaningful has changed since
   *  the last tick -- avoids writing on every single bookTicker tick
   *  for a symbol with an active cascade. */
  private readonly cascadeLastPersistedSnapshot = new Map<
    string,
    { waveCount: number; extremePrice: number }
  >();

  private handleCascadeTick(
    timeframe: "1m" | "3m" | "5m",
    candidate: CascadeCandidateService,
    symbol: string,
    victim: Side,
    mid: number,
    ts: number,
  ): void {
    const result = candidate.onTick(symbol, victim, mid, ts);
    if (!result) {
      const state = candidate.exportState(symbol, victim);
      if (state) {
        const currentWave = state.waves[state.waves.length - 1]!;
        const snapKey = `${state.cascadeId}:${timeframe}`;
        const last = this.cascadeLastPersistedSnapshot.get(snapKey);
        if (
          !last ||
          last.waveCount !== state.waves.length ||
          last.extremePrice !== currentWave.extremePrice
        ) {
          this.cascadeLastPersistedSnapshot.set(snapKey, {
            waveCount: state.waves.length,
            extremePrice: currentWave.extremePrice,
          });
          this.persistActiveCandidateSnapshot(
            symbol,
            victim,
            candidate,
            timeframe,
            ts,
          );
        }
      }
      return;
    }
    if ("entryPrice" in result) {
      void this.handleCascadeSignalReady(result as CascadeSignalReadyEvent);
    } else {
      const cancel = result as CascadeCancelEvent;
      log.info(
        `[CASCADE_CANDIDATE_CANCEL] ${cancel.symbol} ${cancel.victim} timeframe=${cancel.timeframe} cascadeId=${cancel.cascadeId} waves=${cancel.waveHistory.length} reason=${cancel.reason}`,
      );
      const finalWave = cancel.waveHistory[cancel.waveHistory.length - 1];
      const doc: CascadeCandidateStateDoc = {
        timeframe: cancel.timeframe,
        phase: "TERMINAL_CANCEL",
        frozenUnitAbs: null,
        currentWaveNumber: finalWave?.waveNumber ?? null,
        // Every wave in a terminal event's own waveHistory has, by
        // construction, already completed (the terminal condition
        // itself is only ever evaluated once the final wave has
        // reached COMPLETED) -- safe to map unconditionally.
        waveHistory: cancel.waveHistory.map((w) => ({
          ...w,
          state: "COMPLETED" as const,
        })),
        currentExtreme: finalWave?.extremePrice ?? null,
        terminalStatus: "CANCEL",
        terminalReason: cancel.reason,
        signalId: null,
        lastUpdatedTs: ts,
      };
      void this.cascadeRepo.markCandidateTerminal(
        cancel.cascadeId,
        cancel.symbol,
        cancel.victim,
        cancel.cascadeStartTs,
        doc,
        ts,
      );
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
  private async handleCascadeSignalReady(
    event: CascadeSignalReadyEvent,
  ): Promise<void> {
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
      const firstWave = event.waveHistory[0]!; // the TRUE episode-start wave -- used ONLY for qualifyingEvent* below, never for the formula inputs

      const plan = deriveLiquidationPhysicsTradePlan({
        entry: event.entryPrice,
        side: event.side,
        w1AnchorPrice: previousWave.anchorPrice,
        w1ExtremePrice: previousWave.extremePrice,
        w1LiqUsd: previousWave.liqUsd,
        w2LiqUsd: triggerWave.liqUsd,
        atr15mAbs: this.atrTracker.getATR(event.symbol, "15m") ?? 0,
        p95: this.liquidationStats.notionalPercentile(
          event.symbol,
          event.victim,
          95,
        ),
        dailyLiqPerMinBaseline:
          this.liquidationStats.rollingMedianLiqNotionalPerMin(
            event.symbol,
            60,
          ) ?? 0,
      });

      const signalId = randomUUID();
      const totalLiq = event.waveHistory.reduce((sum, w) => sum + w.liqUsd, 0);

      const globalSignal: GlobalSignalDoc = {
        signalId,
        symbol: event.symbol,
        side: event.side,
        victim: event.victim,
        signalTs: event.entryTs,
        entryPrice: event.entryPrice,
        entryWaveNumber: triggerWave.waveNumber,
        waveHistory: [],
        w1Diagnostics: null,
        totalEpisodePressure: totalLiq,
        dominantLayerLiqUsd: null,
        dominantLayerWaveNumber: null,
        exhaustionLayerLiqUsd: triggerWave.liqUsd,
        exhaustionLayerWaveNumber: triggerWave.waveNumber,
        unitAtStart: event.unitAbs,
        p95AtEntry: this.liquidationStats.notionalPercentile(
          event.symbol,
          event.victim,
          95,
        ),
        dailyLiqPerMinBaselineAtEntry:
          this.liquidationStats.rollingMedianLiqNotionalPerMin(
            event.symbol,
            60,
          ) ?? 0,
        atr15mAtEntry: this.atrTracker.getATR(event.symbol, "15m") ?? 0,
        qualifyingEventUsd: firstWave.liqUsd,
        qualifyingEventTs: firstWave.anchorTs,
        p95AtQualification: this.liquidationStats.notionalPercentile(
          event.symbol,
          event.victim,
          95,
        ),
        physics: null,
        btcContext: null,
        liq24hContext: null,
        wallContext: null,
        entry: plan.ok ? plan.entry : null,
        tp: plan.ok ? plan.tp : null,
        sl: plan.ok ? plan.sl : null,
        rr: plan.ok ? plan.rr : null,
        btcSafetyStatus: "UNKNOWN",
        btcIntendedSideAtSignalTime: null,
        rejectionReason: plan.ok ? null : plan.cancelReason,
        planDiagnostics: null,
        status: plan.ok ? "SIGNAL" : "REJECTED_PLAN",
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
        createdAt: Date.now(),
      };

      await this.globalSignalRepo.insert(globalSignal);
      log.info(
        `[CASCADE_CANDIDATE_SIGNAL] ${event.symbol} ${event.side} timeframe=${event.timeframe} cascadeId=${event.cascadeId} signalId=${signalId} waves=${event.waveHistory.length} plan=${plan.ok ? "ok" : `rejected:${plan.cancelReason}`}`,
      );

      // Sep 10 2026 (Karo), operator-requested restart-safe persistence
      // -- this candidate is now terminal (SIGNAL-READY was reached,
      // regardless of whether the TP/SL plan itself was accepted or
      // rejected -- either way this candidate does not retry or resume
      // after a restart), so mark it terminal in v5_active_cascades
      // immediately, and check whether the parent cascade is now fully
      // closed.
      const terminalDoc: CascadeCandidateStateDoc = {
        timeframe: event.timeframe,
        phase: "TERMINAL_SIGNAL",
        frozenUnitAbs: event.unitAbs,
        currentWaveNumber: triggerWave.waveNumber,
        waveHistory: event.waveHistory.map((w) => ({
          ...w,
          state: "COMPLETED" as const,
        })),
        currentExtreme: triggerWave.extremePrice,
        terminalStatus: "SIGNAL",
        terminalReason: null,
        signalId,
        lastUpdatedTs: event.entryTs,
      };
      void this.cascadeRepo.markCandidateTerminal(
        event.cascadeId,
        event.symbol,
        event.victim,
        event.cascadeStartTs,
        terminalDoc,
        event.entryTs,
      );

      if (!plan.ok || globalSignal.entry === null || globalSignal.sl === null)
        return;

      // mainSymbolLocks -- the EXISTING, UNCHANGED real-position lock.
      // Never held/released by this new cascade path directly; only
      // ever read here, to decide whether a REAL distribution
      // (Telegram/Binance) is safe. If MAIN already has an open
      // position for this symbol, this candidate's own result stays
      // persisted (above) for comparison, but is never distributed --
      // guaranteeing MAIN can never hold two simultaneous real
      // positions on the same symbol.
      if (this.mainSymbolLocks.has(event.symbol)) return;
      await this.distributor.distribute(globalSignal, this.mongo);
      this.mainSymbolLocks.add(event.symbol);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, cascadeId: event.cascadeId, timeframe: event.timeframe },
        "[CASCADE_SIGNAL_READY_UNHANDLED_ERROR]",
      );
    }
  }

  private commonHorizonAtrReady(symbol: string): boolean {
    return (
      this.atrTracker.getWilderATR(
        symbol,
        "1m",
        COMMON_HORIZON_PERIODS.atr1m,
      ) !== null &&
      this.atrTracker.getWilderATR(
        symbol,
        "3m",
        COMMON_HORIZON_PERIODS.atr3m,
      ) !== null &&
      this.atrTracker.getWilderATR(
        symbol,
        "5m",
        COMMON_HORIZON_PERIODS.atr5m,
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
        symbol: event.symbol,
        side: event.side,
        victim: event.victim,
        cascadeId: null,
        timeframe: null,
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
        btcContext: event.btcContext,
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
