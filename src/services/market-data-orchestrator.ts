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
import type {
  GlobalSignalDoc,
  UnitResearchCandidateDoc,
  UnitCompetitionCandidateDoc,
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
  /** Sep 9 2026 (Karo), operator-requested RESEARCH-ONLY ATR-timeframe
   *  comparison. TWO fully independent shadow-tracker instances (one
   *  per candidate UNIT, 3m and 5m) + TWO fully independent
   *  ResearchCheckpointTracker instances (custom [30s,1m,3m,5m,15m,30m]
   *  offsets, per the operator's own explicit spec, via the new,
   *  optional `offsets` constructor parameter -- the EXISTING
   *  `this.researchCheckpoints` instance above is completely untouched,
   *  still using its own DEFAULT offsets). Fed via new, ADDITIVE calls
   *  in start()'s own liquidation/bookTicker handlers, always AFTER the
   *  existing production v5.onLiquidation()/v5.onTick() calls -- never
   *  before, never read by anything else. See
   *  unit-research-shadow.service.ts's own doc comment for the full
   *  isolation guarantee. */
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
  /** Sep 10 2026 (Karo), operator-requested LIVE 3-way ATR-unit
   *  "dragon" competition -- COMPLETELY SEPARATE state from
   *  shadow3m/shadow5m above (which serve the EARLIER unitResearch
   *  experiment). THREE independent shadow instances (1m/3m/5m, all
   *  three -- unlike the earlier experiment, "1m" here is ALSO run as
   *  its own, genuinely independent shadow, never reading production's
   *  own live-mutating watch, for a true, symmetric 3-way comparison).
   *  Fed via new, ADDITIVE calls in start()'s own handlers, always
   *  AFTER production -- see feedUnitResearchShadowAfter()/
   *  tickUnitResearchShadow() below, extended to also drive these. */
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
  /** Sep 10 2026 (Karo), operator-requested MAIN-only Telegram research
   *  lifecycle for the dragon competition. `competitionCandidateStatus`
   *  tracks each candidate's own latest-known status per episode
   *  (signalId), purely so the ENTRY message's own "Candidates:" block
   *  can show what every candidate is doing AT winner-declaration time
   *  -- read-only bookkeeping, never influences the competition or
   *  production in any way. `competitionWinners` tracks the ONE open
   *  hypothetical winner-position per episode, watched on every
   *  subsequent tick purely to detect a TP/SL touch for the CLOSE
   *  message -- a plain price-comparison, structurally identical in
   *  spirit to (but completely separate state from) MAIN's own
   *  onPriceTickForTrades() canonical-close check. */
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
  private readonly rawLiquidationEventRepo: RawLiquidationEventRepository;
  /** Sep 8 2026 (Karo) -- NEW, MAIN/GLOBAL-only same-symbol lock. See
   *  this class's own module doc comment for the full rationale. Keyed
   *  by symbol alone (not symbol+side -- one canonical signal per
   *  symbol, either side, at a time, matching the operator's own
   *  framing: "XRP MAIN OPEN blocks another MAIN XRP signal", not
   *  "XRP-LONG blocks only XRP-LONG"). */
  private readonly mainSymbolLocks = new Set<string>();
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
    /** Sep 8 2026 (Karo) -- broadcasts to every enabled-telegram user.
     *  Used ONLY for the liq-feed-dead alert (a genuine system-wide
     *  event affecting every user's own data equally). NOT used for
     *  MAIN close anymore -- see mainTelegram below for that. */
    broadcastTelegram: {
      sendMessage: (text: string) => Promise<unknown>;
    } | null = null,
    /** Sep 8 2026 (Karo) -- CRITICAL FIX, operator-corrected
     *  architecture: MAIN's own ENTRY/CLOSE must use ONLY MAIN's own
     *  dedicated Telegram configuration (the "main" user's own
     *  telegram.chatIds), never a broadcast to every user. MAIN's own
     *  ENTRY already achieved this correctly (SignalDistributor's own
     *  per-user notifyUser() loop naturally uses each user's own
     *  config, "main" included) -- this parameter fixes the ONE place
     *  that didn't: handleMainTradeClose() used to reuse the generic
     *  broadcastTelegram (every enabled user), incorrectly turning
     *  MAIN's own close into a de facto broadcast. A user's own
     *  telegram.chatIds MAY intentionally list multiple chat ids
     *  (fan-out for THAT one runtime) -- that is a property of the
     *  "main" user's own config, not of this mechanism. */
    mainTelegram: {
      sendMessage: (text: string) => Promise<unknown>;
    } | null = null,
  ) {
    this.liquidationStats = new LiquidationStatsService(liquidationStatsConfig);
    this.wallTracker = new WallTrackerService(wallTrackerConfig);
    this.liqFeedWatchdog = new LiqFeedWatchdogService(log, broadcastTelegram);
    this.oiTracker = new OiTrackerService(symbols);
    this.globalSignalRepo = new GlobalSignalRepository(mongo);
    this.rawLiquidationEventRepo = new RawLiquidationEventRepository(mongo);
    this.mainTelegram = mainTelegram;
  }

  async ensureIndexes(): Promise<void> {
    await this.rawLiquidationEventRepo.ensureIndexes();
  }

  /** Sep 8 2026 (Karo) -- NEW. Call once at startup, BEFORE
   *  orchestrator.start() (ws ticks must never race this), so the
   *  same-symbol MAIN lock survives a restart. Queries every
   *  status="SIGNAL" (open) GlobalSignalDoc, locks that symbol, and
   *  reconstructs V5WaveService's own in-memory activeTrades entry via
   *  hydrateActiveTrade() so onPriceTickForTrades() can detect a
   *  future close for it. Known, accepted limitation (documented, not
   *  silently omitted): does NOT replay historical candles to check
   *  "did this already cross TP/SL during the downtime" -- if price is
   *  STILL beyond the TP/SL boundary once ticks resume, the very next
   *  relevant tick closes it correctly (onPriceTickForTrades checks
   *  the boundary unconditionally, not just "did it just cross"); the
   *  only unrecovered edge case is price touching TP/SL DURING
   *  downtime and moving back inside the range before the process
   *  restarts -- accepted as rare and out of scope for this pass. */
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

  start(): void {
    this.ws.subscribe({
      symbols: this.symbols,
      // Sep 9 2026 (Karo), operator-requested RESEARCH-ONLY ATR-
      // timeframe comparison -- "3m" ADDED to the live WS-kline
      // subscription so ATRTrackerService can maintain a continuously-
      // warm ATR(3m), exclusively for the shadow unit-research service
      // (unit-research-shadow.service.ts). Adding a NEW stream here
      // cannot alter behavior for any EXISTING interval's own data --
      // each (symbol, interval) pair is independently keyed throughout
      // this codebase.
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
      if (this.mainSymbolLocks.has(l.symbol)) return;
      const victimForShadow: Side = l.side === "SELL" ? "LONG" : "SHORT";
      const wasTrackedBeforeProduction = this.wasProductionWatchTracked(
        l.symbol,
        victimForShadow,
      );
      const outcomes = this.v5.onLiquidation(l);
      for (const outcome of outcomes) void this.handleTickOutcome(outcome);
      this.feedUnitResearchShadowAfter(l, wasTrackedBeforeProduction);
    });

    this.ws.on("bookTicker", (b) => {
      const mid = (b.bid + b.ask) / 2;
      const outcomes = this.v5.onTick(b.symbol, mid, b.timestamp);
      for (const outcome of outcomes) void this.handleTickOutcome(outcome);
      const closes = this.v5.onPriceTickForTrades(b.symbol, mid, b.timestamp);
      for (const close of closes) void this.handleMainTradeClose(close);
      void this.reconciliation.onTick(b.symbol, b.timestamp);
      this.tickResearchCheckpoints(b.symbol, mid, b.timestamp);
      this.tickUnitResearchShadow(b.symbol, mid, b.timestamp);
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

  /** Sep 9 2026 (Karo) -- companion to feedUnitResearchShadow(), called
   *  BEFORE this.v5.onLiquidation() runs (captures whether a watch
   *  already existed) so the AFTER-side can tell "new episode" from
   *  "existing episode, accumulate". Kept as two small methods rather
   *  than one, matching exactly where each must run relative to the
   *  production call. */
  private wasProductionWatchTracked(symbol: string, victim: Side): boolean {
    return this.v5.getWatch(symbol, victim) !== null;
  }

  private feedUnitResearchShadowAfter(
    l: Liquidation,
    wasTrackedBefore: boolean,
  ): void {
    const victim: Side = l.side === "SELL" ? "LONG" : "SHORT";
    if (!wasTrackedBefore) {
      const newWatch = this.v5.getWatch(l.symbol, victim);
      if (!newWatch) return; // production itself declined to track this event (e.g. BTC EXCLUDE mode) -- shadow mirrors that by doing nothing too
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
      // Sep 10 2026 (Karo), operator-requested LIVE 3-way ATR-unit
      // "dragon" competition -- COMPLETELY SEPARATE instances, started
      // in lockstep with the SAME production Wave1-start moment, "1m"
      // included this time (a genuinely independent shadow, unlike the
      // earlier unitResearch experiment which treated 1m as production
      // itself).
      const compUnit1m = this.atrTracker.getATR(l.symbol, "1m");
      if (compUnit1m !== null && compUnit1m > 0) {
        this.competitionShadow1m.startEpisode(
          l.symbol,
          victim,
          newWatch.signalId,
          compUnit1m,
          l.price,
          l.timestamp,
          l.quoteQty,
          l.timestamp,
        );
      }
      if (unit3m !== null && unit3m > 0) {
        this.competitionShadow3m.startEpisode(
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
      if (unit5m !== null && unit5m > 0) {
        this.competitionShadow5m.startEpisode(
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
      return;
    }
    this.shadow3m.onLiquidation(l, victim);
    this.shadow5m.onLiquidation(l, victim);
    this.competitionShadow1m.onLiquidation(l, victim);
    this.competitionShadow3m.onLiquidation(l, victim);
    this.competitionShadow5m.onLiquidation(l, victim);
  }

  /** Sep 9 2026 (Karo), operator-requested RESEARCH-ONLY ATR-timeframe
   *  comparison. Called ONCE per bookTicker tick, ALWAYS AFTER
   *  this.v5.onTick() has already run. Ticks BOTH shadow candidates,
   *  for BOTH victims -- their own onTick() is a complete no-op for any
   *  symbol/victim pair with no active shadow episode, so this is cheap
   *  and side-effect-free for the vast majority of ticks. Persists a
   *  terminal (entry or no-entry) event the moment one occurs, and
   *  registers the shadow's own MFE/MAE checkpoint-watch on entry --
   *  reusing the EXACT SAME ResearchCheckpointTracker/GlobalSignalRepository
   *  machinery production's own researchCheckpoints already uses, via a
   *  SEPARATE tracker instance and a SEPARATE persisted field
   *  (unitResearch), never touching researchCheckpoints itself. */
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
        void this.globalSignalRepo.appendUnitCompetitionCheckpoint(
          c.signalId,
          label,
          c.checkpoint,
        );
    }
    this.checkCompetitionWinnerTouch(symbol, mid, ts);
  }

  /** Sep 10 2026 (Karo), operator-requested LIVE 3-way ATR-unit
   *  "dragon" competition. Called once per (candidate, victim) per
   *  bookTicker tick -- a complete no-op when no competition-episode is
   *  active for this symbol/victim/candidate. On a terminal shadow
   *  event: STRUCTURAL_CANCEL is persisted immediately for a no-entry
   *  event; for an entry-ready event, runs evaluateDragon() (the NEW,
   *  standalone formula -- see unit-competition-dragon.ts's own doc
   *  comment -- NEVER deriveLiquidationPhysicsTradePlan(), no
   *  exhaustion/absorption/ATR15m/clamp), persists the FULL result
   *  (every attempted RR, not just the winner), and registers an
   *  MFE/MAE checkpoint-watch ONLY when verdict=PASS. Crucially: a
   *  candidate reaching PASS or FAIL here NEVER stops any OTHER
   *  candidate -- each of the three UnitResearchShadowService instances
   *  is fully independent (see this class's own module doc comment),
   *  so all three always run their own path to completion. */
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

      const doc: UnitCompetitionCandidateDoc = {
        candidate: label === "atr1m" ? "1m" : label === "atr3m" ? "3m" : "5m",
        frozenUnitAbs: entry.unitAbs,
        frozenAtrPct,
        episodeStartTs: entry.episodeStartTs,
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
        verdict: dragon.verdict,
        hypotheticalEntry: entry.entryPrice,
        hypotheticalTp,
        hypotheticalSl,
        checkpoints: [],
      };
      void this.globalSignalRepo.setUnitCompetitionCandidate(
        entry.signalId,
        label,
        doc,
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
      const doc: UnitCompetitionCandidateDoc = {
        candidate: label === "atr1m" ? "1m" : label === "atr3m" ? "3m" : "5m",
        frozenUnitAbs: noEntry.unitAbs,
        frozenAtrPct:
          noEntry.w1 && noEntry.w1.anchorPrice > 0
            ? noEntry.unitAbs / noEntry.w1.anchorPrice
            : 0,
        episodeStartTs: noEntry.episodeStartTs,
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
        verdict: "STRUCTURAL_CANCEL",
        hypotheticalEntry: null,
        hypotheticalTp: null,
        hypotheticalSl: null,
        checkpoints: [],
      };
      void this.globalSignalRepo.setUnitCompetitionCandidate(
        noEntry.signalId,
        label,
        doc,
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

  /** Sep 10 2026 (Karo), operator-requested MAIN-only Telegram research
   *  lifecycle. Declares the WINNER exactly once per episode (signalId)
   *  -- a no-op if a winner already exists, guaranteeing "FIRST PASS
   *  wins, never reassigned" exactly as specified. Sends the ONE
   *  RESEARCH ENTRY message via this.mainTelegram ONLY -- never
   *  user-runtime fan-out, never Binance, never the production
   *  signal-distributor. Registers the winner's own hypothetical
   *  position for later TP/SL-touch monitoring (checkCompetitionWinnerTouch()). */
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
    if (this.competitionWinners.has(signalId)) return; // already has a winner -- never reassigned
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
    void this.globalSignalRepo.setUnitCompetitionWinner(
      signalId,
      candidate,
      entryTs,
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

  /** Sep 10 2026 (Karo), operator-requested MAIN-only Telegram research
   *  lifecycle. Called once per bookTicker tick for the symbol -- a
   *  no-op if no open winner exists for this symbol. Pure price
   *  comparison against the winner's own already-persisted TP/SL,
   *  structurally identical in spirit to (never sharing state with)
   *  MAIN's own onPriceTickForTrades() canonical-close check. Sends
   *  the ONE RESEARCH CLOSE message via this.mainTelegram ONLY. */
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
      void this.globalSignalRepo.setUnitCompetitionWinnerResult(
        signalId,
        result,
      );

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
      const prodEntryTs: number | null = null; // production's own entry price/time is not observable from a released/consumed watch here -- delay is computed downstream from the persisted signalTs instead, at report time
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
      void prodWatch; // reserved for future delay-vs-production wiring; not required for this pass's own core comparison
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

      // Sep 9 2026 (Karo), operator-requested diagnostics/research-
      // only context -- REUSES getVictimStatsSnapshot() as-is (see its
      // own doc comment). Computed here, once, for BOTH victim sides
      // -- never fed back into event/plan/qualification, which were
      // already fully decided before this line runs.
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
        createdAt: Date.now(),
      };

      await this.distributor.distribute(globalSignal, this.mongo);

      if (
        hasRealPlan &&
        globalSignal.entry !== null &&
        globalSignal.sl !== null
      ) {
        this.mainSymbolLocks.add(event.symbol);

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
