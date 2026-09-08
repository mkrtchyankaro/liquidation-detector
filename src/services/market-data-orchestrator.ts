import { randomUUID } from "crypto";
import { BinanceWsClient } from "../infrastructure/binance/binanceWs.client";
import {
  V5WaveService,
  type V5TickOutcome,
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
import type { GlobalSignalDoc } from "../domain/signal/global-signal.model";
import type { V5Wave } from "../strategy/v5/v5-wave.model";
import type { SignalDistributor } from "./signal-distributor";
import type { ReconciliationManager } from "./reconciliation-manager";
import type { MongoClientWrapper } from "../infrastructure/mongo/mongo.client";
import { GlobalSignalRepository } from "../infrastructure/mongo/global-signal.repository";
import { RawLiquidationEventRepository } from "../infrastructure/mongo/raw-liquidation-event.repository";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "market-data-orchestrator" });

/**
 * Sep 8 2026 (Karo). WS subscribe options and per-stream routing are
 * REUSED, identical, from liqwatch-bot's own app.ts ws.subscribe()/
 * ws.on(...) block (see MIGRATION_NOTES.md for exact old-file line
 * references): kline[15m,5m] -> ATRTrackerService, aggTrade ->
 * (aggressive-flow, wired the same way), bookTicker -> V5WaveService.onTick()
 * + ReconciliationManager.onTick(), liquidation -> LiquidationStore +
 * LiquidationStatsService + V5WaveService.onLiquidation(), orderbook ->
 * WallTrackerService. What's NEW: SIGNAL_CANDIDATE outcomes are mapped
 * to a GlobalSignalDoc and hand off to SignalDistributor, instead of
 * app.ts's own inline handleV5TickOutcome. ALSO NEW (Sep 8 2026,
 * research-data layer): 1m kline subscription (confirmed the old bot
 * never had this -- see the audit this was requested from), raw
 * liquidation-event archiving, and GLOBAL research-checkpoint
 * tracking. None of this changes V5's own strategy behavior -- 1m
 * candles are fed to CandleStore only, never to ATRTrackerService
 * (which only tracks 5m/15m/1h internally, confirmed by its own
 * isTracked() method -- 1m candles are silently ignored there by
 * construction, not by a new guard added here).
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
  /** Sep 8 2026 (Karo) -- REUSED, unchanged cadence/caching, from
   *  liqwatch-bot's own market-data/oi-tracker.service.ts. Unlike
   *  Funding (V3-Telegram-display-only, confirmed NEVER constructed
   *  when V3_ENABLED=false, i.e. never on the currently-live V5-only
   *  brother instance either), OI IS unconditionally constructed in
   *  the old app.ts (oiTrackerForV4, before the V3_ENABLED gate) and
   *  IS read by V5WaveService's own getOi callback -- diagnostic-only
   *  (oiEnd/oiDeltaPct/btcContext.oiAtSignal fields, confirmed no
   *  decision/gating logic branches on it), but genuinely part of
   *  V5's proven runtime, so it is reproduced here. Auto-starts its
   *  own 60s-refresh timer in its OWN constructor -- no separate
   *  .start() call exists on this class (confirmed from source). */
  readonly oiTracker: OiTrackerService;
  /** Sep 8 2026 (Karo) -- CRITICAL FIX: found NEVER constructed
   *  anywhere in this project during a full manual audit. V5WaveService's
   *  own getFlow callback (main.ts) reads from this via getRecentFlow()
   *  -- without it, every wave's own takerBuyUsd/takerSellUsd/
   *  takerImbalance forensic field was silently always null. */
  readonly aggressiveFlow = new AggressiveFlowService();
  /** Sep 8 2026 (Karo) -- GLOBAL, in-memory, research-only (see
   *  ResearchCheckpointTracker's own doc comment). Never per-user. */
  readonly researchCheckpoints = new ResearchCheckpointTracker();
  private readonly globalSignalRepo: GlobalSignalRepository;
  private readonly rawLiquidationEventRepo: RawLiquidationEventRepository;

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
    /** Sep 8 2026 (Karo) -- CRITICAL FIX: LiqFeedWatchdogService's own
     *  automatic Telegram alert ("🚨 LIQ FEED DEAD... bot likely needs
     *  restart") NEVER actually sent anything until this fix -- it
     *  previously defaulted to null (same class of bug as
     *  BinanceExecutionService's own critical-alert wiring, found in
     *  the same audit pass). System-wide event (affects every user
     *  equally, not any one user's own trade), so this is optionally
     *  a broadcast to every enabled-telegram user, not scoped to one. */
    liqFeedAlertTelegram: {
      sendMessage: (text: string) => Promise<unknown>;
    } | null = null,
  ) {
    this.liquidationStats = new LiquidationStatsService(liquidationStatsConfig);
    this.wallTracker = new WallTrackerService(wallTrackerConfig);
    this.liqFeedWatchdog = new LiqFeedWatchdogService(
      log,
      liqFeedAlertTelegram,
    );
    // Auto-starts its own refresh cycle immediately (see field's own doc comment).
    this.oiTracker = new OiTrackerService(symbols);
    this.globalSignalRepo = new GlobalSignalRepository(mongo);
    this.rawLiquidationEventRepo = new RawLiquidationEventRepository(mongo);
  }

  /** Call once at startup, alongside every other repository's own
   *  ensureIndexes(). Separate from the constructor since it's async
   *  I/O, matching this project's own convention everywhere else. */
  async ensureIndexes(): Promise<void> {
    await this.rawLiquidationEventRepo.ensureIndexes();
  }

  start(): void {
    this.ws.subscribe({
      symbols: this.symbols,
      // Sep 8 2026 (Karo) -- "1m" ADDED for the new research-data
      // layer only (raw 1-minute price structure, for later
      // liquidation-bar correlation). Confirmed via a full manual
      // audit that the old bot NEVER subscribed to this at all (only
      // REST-fetched 1m klines on-demand, once, for boot-time
      // candle-replay -- see fetchKlinesSinceV5 in the old app.ts).
      // "15m"/"5m" stay exactly as before -- V5's own ATR input is
      // UNCHANGED (ATRTrackerService.isTracked() only accepts
      // 5m/15m/1h; 1m candles reaching atrTracker.onCandle() below are
      // filtered out THERE, by that pre-existing, unmodified method --
      // not by a new guard added here).
      intervals: ["15m", "5m", "1m"],
      aggTrade: true,
      bookTicker: true,
      depth: true,
      forceOrder: true,
    });

    this.ws.on("open", () => log.info("[ws] streams connected"));
    this.ws.on("close", (code) => log.warn({ code }, "[ws] streams closed"));
    this.ws.on("error", (err) => log.error({ err: err.message }, "[ws] error"));

    this.ws.on("kline", (c) => {
      // Sep 8 2026 (Karo) -- atrTracker.onCandle() is called for EVERY
      // interval now (not just "15m" as before), matching the old
      // bot's own unconditional call shape exactly (its own
      // ws.on("kline") handler called atrTracker.onCandle(c)
      // unfiltered, relying on the SAME internal isTracked() gate this
      // project already has). candleStore.ingest() already accepted
      // any interval, unchanged.
      this.atrTracker.onCandle(c);
      this.candleStore.ingest(c);
    });

    this.ws.on("liquidation", (l) => {
      this.liqFeedWatchdog.recordEvent(l.symbol);
      this.liquidationStore.ingest(l);
      this.liquidationStats.ingest(l);
      // Sep 8 2026 (Karo) -- NEW, research-data layer. Zero derivation
      // (see RawLiquidationEventRepository's own doc comment) -- the
      // SAME victim-side convention V5WaveService itself uses.
      void this.rawLiquidationEventRepo.insert({
        symbol: l.symbol,
        victim: l.side === "SELL" ? "LONG" : "SHORT",
        price: l.price,
        quoteQty: l.quoteQty,
        timestamp: l.timestamp,
      });
      const outcomes = this.v5.onLiquidation(l);
      for (const outcome of outcomes) void this.handleTickOutcome(outcome);
    });

    this.ws.on("bookTicker", (b) => {
      const mid = (b.bid + b.ask) / 2;
      const outcomes = this.v5.onTick(b.symbol, mid, b.timestamp);
      for (const outcome of outcomes) void this.handleTickOutcome(outcome);
      void this.reconciliation.onTick(b.symbol, b.timestamp);
      this.tickResearchCheckpoints(b.symbol, mid, b.timestamp);
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

  /** Sep 8 2026 (Karo) -- advances every active GLOBAL research
   *  checkpoint watch for this symbol and persists whichever offsets
   *  just completed. Deliberately separate from any per-user path --
   *  see research-checkpoint.model.ts's own doc comment: this must
   *  never depend on, or duplicate per user. */
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

  /** Sep 8 2026 (Karo) -- atrAbs (absolute price units, not %) for
   *  ATR-normalized checkpoint watches. Returns null when ATR isn't
   *  warm yet for this symbol (registerWatch itself already refuses a
   *  <=0 denominator, so this is a safe, honest null rather than a
   *  fabricated fallback). */
  private atrAbsFor(symbol: string, referencePrice: number): number | null {
    const atrPct = this.atrTracker.getATR(symbol, "15m");
    if (!atrPct || !(atrPct > 0)) return null;
    return atrPct * referencePrice;
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
        // Sep 8 2026 (Karo) -- EXHAUSTION_CANDIDATE research checkpoint:
        // this layer reached the exhaustion-candidate moment (that's
        // what produces a SIGNAL_CANDIDATE outcome in the first place)
        // but evaluateSignal() itself rejected it (e.g.
        // WAVE_CHRONOLOGY_INVALID, or the already-issued guard). ATR-
        // normalized (no real SL exists for a rejected candidate).
        // signalId reused from the watch so this stays correlated with
        // whatever GlobalSignalDoc (if any) the episode eventually
        // produces via its OWN terminal path.
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
        return; // already-issued guard inside evaluateSignal -- safe no-op
      }

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
        qualifyingEventUsd: event.qualifyingEventUsd,
        qualifyingEventTs: event.qualifyingEventTs,
        p95AtQualification: event.p95AtQualification,
        physics: event.plan
          ? {
              cumLiqUsd: event.totalEpisodePressure,
              atrPct: 0,
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
        rejectionReason: event.plan ? null : "plan-rejected",
        status: "SIGNAL",
        researchCheckpoints: [],
        createdAt: Date.now(),
      };

      await this.distributor.distribute(globalSignal, this.mongo);

      // Sep 8 2026 (Karo) -- SIGNAL research checkpoint, R-normalized
      // against the CANONICAL entry/SL (never any one user's actual
      // fill -- see research-checkpoint.model.ts's own doc comment).
      // Only registered when a real plan exists (entry/sl both
      // non-null) -- a rejected plan ("plan-rejected") has no usable
      // SL to normalize against, so it's simply not tracked here (the
      // EXHAUSTION_CANDIDATE branch above already covers that case
      // for evaluateSignal()-level rejections; a plan-rejected SIGNAL
      // is a narrower, later-stage rejection this project accepts as
      // untracked for now, rather than inventing a third fallback
      // anchor).
      if (
        event.plan &&
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
      status: reason as GlobalSignalDoc["status"],
      researchCheckpoints: [],
      createdAt: Date.now(),
    };
    await this.globalSignalRepo.insert(doc);

    // Sep 8 2026 (Karo) -- EPISODE_END research checkpoint. This
    // episode never even reached the exhaustion-candidate moment (or
    // did, but that path already registered its own
    // EXHAUSTION_CANDIDATE watch above -- registerWatch is a no-op if
    // one already exists for this signalId, so no double-tracking).
    // Anchored at the LAST known wave's own extreme price -- the best
    // available "where did this episode actually end" reference when
    // no live tick/price is otherwise passed into this method. Skipped
    // entirely (no anchor) when waveHistory is empty (nothing to
    // anchor to) or ATR isn't warm yet.
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
