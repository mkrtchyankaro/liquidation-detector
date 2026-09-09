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
} from "../domain/signal/global-signal.model";
import type { Side, Liquidation } from "../shared/common.types";
import { deriveLiquidationPhysicsTradePlan } from "../domain/trading/liquidation-physics-trade-plan";
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
      return;
    }
    this.shadow3m.onLiquidation(l, victim);
    this.shadow5m.onLiquidation(l, victim);
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
