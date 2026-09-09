import { randomUUID } from "crypto";
import type { Liquidation } from "../../shared/common.types";
import type { Side } from "../../shared/common.types";
import type {
  V5Wave,
  V5WatchState,
  V5ActiveTrade,
  V5TerminalReason,
  V5Wave1Diagnostics,
} from "./v5-wave.model";
import {
  V5_TRACKED_SYMBOLS,
  v5EpisodeInactivityMs,
  v5EpisodeSafetyTimeoutMs,
  v5LongEnabled,
  v5ShortEnabled,
  v5BtcMode,
} from "./v5.config";
import { deriveStructuralTradePlan } from "../../domain/trading/structural-trade-plan";
import { INTENSITY_MAX } from "../../domain/trading/trade-plan";
import { evaluateBtcOpposingWatchSafe } from "./btc-opposing-watch";
import type { WallSnapshots } from "../../domain/trading/trade-plan";
import { childLogger } from "../../infrastructure/logging/logger";

const log = childLogger({ mod: "v5-wave" });

const NO_WALL = {
  topBidNotional: 0,
  topAskNotional: 0,
  topBidPrice: 0,
  topAskPrice: 0,
  imbalance: 0,
  topBidPersistent: false,
  topAskPersistent: false,
};
const NO_WALLS: WallSnapshots = {
  atEntry: NO_WALL,
  atAnchor: NO_WALL,
  atSweepStart: null,
};

export interface V5SignalEvent {
  signalId: string;
  symbol: string;
  side: Side;
  victim: Side;
  signalTs: number;
  entryPrice: number;
  entryWaveNumber: number;
  waveHistory: V5Wave[];
  w1Diagnostics: V5Wave1Diagnostics | null;
  dominantLayerLiqUsd: number | null;
  dominantLayerWaveNumber: number | null;
  exhaustionLayerLiqUsd: number | null;
  exhaustionLayerWaveNumber: number | null;
  /** Sep 9 2026 (Karo), operator-designed structural SL/TP -- frozen
   *  UNIT (absolute price units, watch.unitAtStart), persisted so
   *  BinanceExecutionService's own post-fill replan (a real, later,
   *  separate process with no access to the live V5WatchState) can
   *  re-derive the SAME structural plan at the actual fill price,
   *  never falling back to the old liquidation-intensity formula. */
  unitAtStart: number;
  totalEpisodePressure: number;
  qualifyingEventUsd: number;
  qualifyingEventTs: number;
  p95AtQualification: number;
  btcSafetyStatus: "CLEAN" | "WOULD_BLOCK" | "UNKNOWN" | "N/A_BTC";
  /** Sep 8 2026, operator-approved (Karo) -- see this field's own
   *  assignment site in evaluateSignal() for the full doc comment.
   *  BTC's own currently-active watch side (if any), captured at
   *  signal time -- purely informational, always populated regardless
   *  of v5BtcBlockEnabled(). */
  btcIntendedSideAtSignalTime: Side | null;
  plan: {
    entry: number;
    tp: number;
    sl: number;
    rr: number;
    liqStrengthRaw: number;
    liqStrength: number;
    liqBaseline: number;
    physicsTPPct: number;
    wallAdjustedTpPct: number;
    wallApplied: boolean;
    rrCandidate: number;
    slCapApplied: boolean;
    slCapValue: number;
    finalTpPct: number;
    finalSlPct: number;
    /** Sep 9 2026 (Karo), operator-designed structural SL/TP -- see
     *  structural-trade-plan.ts's own doc comment for the full design.
     *  `sl` above is the HARD-STOP price (max(structuralRiskPct,
     *  0.20%) from entry) -- this is what position-sizing and the real
     *  exchange order use, unchanged from every existing consumer's
     *  own perspective. `structuralSoftExitPrice` is the TIGHTER,
     *  app-side invalidation price (W2extreme +/- 0.4xUNIT) -- live
     *  monitoring/exiting there is a separate, future concern; this
     *  field only exposes the correct price. liqStrength/liqStrengthRaw/
     *  liqBaseline above remain purely informational (setup
     *  confidence) -- they no longer feed sl/tp/rr at all. */
    structuralSoftExitPrice: number;
    structuralRiskPct: number;
    sizingRiskPct: number;
    hardStopRiskPct: number;
  } | null;
  rejectionReason: string | null;
  /** Sep 9 2026 (Karo), operator-requested diagnostics-only fix --
   *  REUSES (never reimplements) the SAME StructuralTradePlanForensics
   *  deriveStructuralTradePlan() already returns on BOTH its ok=true
   *  and ok=false branches (see structural-trade-plan.ts's own
   *  StructuralTradePlanResult union) -- these numbers already existed
   *  as local variables and were previously discarded on rejection.
   *  Populated whenever deriveStructuralTradePlan() was actually
   *  called (i.e. NOT for the earlier "episode-missing-atr" early-exit,
   *  where no plan computation ever ran at all -- null there).
   *  liqBaseline is the caller's own input to that call, included
   *  alongside for
   *  completeness since the operator explicitly asked for it too. */
  planDiagnostics: {
    intensityRaw: number;
    intensity: number;
    atr15mPct: number;
    liqBaseline: number;
    rawTpPct: number;
    wallAdjustedTpPct: number;
    wallApplied: boolean;
    rrCandidate: number;
    slCapApplied: boolean;
    slCapValue: number;
    finalTpPct: number;
    finalSlPct: number;
    structuralSoftExitPrice: number;
    structuralRiskPct: number;
    sizingRiskPct: number;
    hardStopRiskPct: number;
  } | null;
  btcContext: { priceAtSignal: number | null; oiAtSignal: number | null };
  liq24hContext: { dayLiqTotalUsd: number; dayLiqEvents: number } | null;
  wallContext: {
    topBidNotional: number;
    topAskNotional: number;
    topBidPrice: number;
    topAskPrice: number;
    imbalance: number;
  };
}

export interface V5TradeCloseEvent {
  trade: V5ActiveTrade;
  outcome: "TP" | "SL";
  closePrice: number;
  closeTs: number;
}

export interface V5NonSignalTerminalEvent {
  watch: V5WatchState;
  reason: Exclude<V5TerminalReason, "ANCHOR_RECLAIMED">;
  waveHistory: V5Wave[];
}

export type V5TickOutcome =
  | { kind: "SIGNAL_CANDIDATE"; watch: V5WatchState; entryWave: V5Wave }
  | { kind: "TERMINAL_NON_SIGNAL"; event: V5NonSignalTerminalEvent };

/**
 * V5's own, isolated, live event-driven wave-chain engine.
 *
 * See v5-wave.model.ts's own header for the complete, locked lifecycle
 * spec (validated via offline replay, v5_wave_reclaim_experiment.ts).
 *
 * Live architecture note: unlike the offline replay (which walked
 * fixed 1-minute klines, using candle high/low/close as separate
 * price references), live operation has exactly ONE continuous price
 * stream (bookTicker mid, via onTick) plus a separate liquidation
 * event stream (via onLiquidation) -- there is no wick-vs-close
 * distinction to worry about here at all, which structurally avoids
 * the exact bug class found and fixed during offline validation.
 * Wave-transition decisions (does a new liquidation event start a
 * fresh wave, or continue the current one) need to know "the current
 * price at the moment this liquidation arrived" -- tracked via
 * lastPriceAt, updated on every onTick() call, read (never written)
 * from onLiquidation().
 *
 * A failure inside this class must never propagate into the caller's
 * own tick/liquidation loop -- every public method catches internally
 * and logs.
 */
export class V5WaveService {
  private readonly watches = new Map<string, V5WatchState>();
  private readonly activeTrades = new Map<string, V5ActiveTrade>(); // keyed by signalId
  private readonly lastPriceAt = new Map<string, number>();
  private lastBtcPrice: number | null = null;

  private readonly liq24hHistory = new Map<
    string,
    Array<{ ts: number; notional: number }>
  >();
  private static readonly DAY_MS = 24 * 60 * 60_000;

  constructor(
    private readonly getAtrAbs: (
      symbol: string,
      referencePrice: number,
    ) => number,
    /** Sep 8 2026 (Karo), operator-designed minimal-cascade model --
     *  ATR(1m)-based structural UNIT, absolute price units. Frozen
     *  once per watch (at creation), stored as V5WatchState.unitAtStart.
     *  Completely separate from getAtrAbs above (ATR15m, still ONLY
     *  used for trade-plan TP/SL sizing). */
    private readonly getUnit1mAbs: (
      symbol: string,
      referencePrice: number,
    ) => number,
    private readonly getOi: (
      symbol: string,
    ) => { contracts: number; ts: number } | null,
    private readonly getBaseline: (symbol: string, victim: Side) => number,
    private readonly getIndividualP95: (symbol: string, victim: Side) => number,
    private readonly getWallContext:
      | ((symbol: string, side: Side) => WallSnapshots)
      | null = null,
    private readonly getFlow:
      | ((
          symbol: string,
          lookbackMs: number,
          now: number,
        ) => { buyUsd: number; sellUsd: number } | null)
      | null = null,
  ) {}

  private get24hStats(
    symbol: string,
    nowTs: number,
  ): { dayLiqTotalUsd: number; dayLiqEvents: number } {
    const arr = this.liq24hHistory.get(symbol);
    if (!arr) return { dayLiqTotalUsd: 0, dayLiqEvents: 0 };
    const cutoff = nowTs - V5WaveService.DAY_MS;
    let total = 0;
    let count = 0;
    for (const e of arr) {
      if (e.ts >= cutoff) {
        total += e.notional;
        count += 1;
      }
    }
    return { dayLiqTotalUsd: total, dayLiqEvents: count };
  }

  getWatch(symbol: string, victim: Side): V5WatchState | null {
    return this.watches.get(this.key(symbol, victim)) ?? null;
  }

  getActiveTrade(signalId: string): V5ActiveTrade | null {
    return this.activeTrades.get(signalId) ?? null;
  }

  /** Sep 7 2026, operator-approved (Karo) -- lists currently-LIVE
   *  active trades for one symbol, for app.ts's own Binance
   *  reconciliation poll (see handleV5Tick's own doc comment).
   *  Shadow/paper trades (isLive=false) are excluded -- those close
   *  via the existing price-crossing simulation in
   *  onPriceTickForTrades(), unaffected by this. */
  getLiveActiveTradesForSymbol(symbol: string): V5ActiveTrade[] {
    return [...this.activeTrades.values()].filter(
      (t) => t.symbol === symbol && t.isLive,
    );
  }

  /** Sep 7 2026, operator-approved (Karo) -- called by app.ts AFTER a
   *  real Binance order has been confirmed for an ALREADY-installed
   *  trade (evaluateSignal() always installs the trade first, for
   *  shadow/paper monitoring, exactly as before this feature -- this
   *  is a secondary, additive step). If the real order fails/aborts,
   *  this is simply never called -- the trade stays a normal shadow
   *  trade, monitored exactly as always. Safe no-op if the signalId
   *  is no longer active (e.g. already closed by the time execution
   *  confirmation arrived).
   *
   *  Updates entry/tp/sl to the ACTUAL, Binance-confirmed values (post-
   *  fill replan, per ExecutionResult's own SUCCESS shape) -- a live
   *  fill can differ from the originally-planned entry due to
   *  slippage, and BinanceExecutionService already replans sl/tp
   *  against the real fill (matching V3's own post-fill RR validation
   *  design) -- V5's own shadow tracking must follow the SAME real
   *  numbers from this point on, not the stale original plan.
   *  best/worstPrice reset to the real entry, so MFE/MAE is measured
   *  from where the position actually opened. */
  markTradeLive(
    signalId: string,
    actualEntry: number,
    actualSl: number,
    actualTp: number,
    slOrderId: number,
    tpOrderId: number,
    positionQty: number,
    notional: number,
    riskUsd: number,
  ): void {
    const trade = this.activeTrades.get(signalId);
    if (!trade) return;
    trade.isLive = true;
    trade.entry = actualEntry;
    trade.sl = actualSl;
    trade.tp = actualTp;
    trade.bestPrice = actualEntry;
    trade.worstPrice = actualEntry;
    trade.binanceSlOrderId = slOrderId;
    trade.binanceTpOrderId = tpOrderId;
    trade.positionQty = positionQty;
    trade.notional = notional;
    trade.riskUsd = riskUsd;
  }

  /** Sep 7 2026, operator-caught bug fix (Karo) -- REPLACES the old
   *  V3-borrowed BTC-safety data source. Since V3 is disabled
   *  (v3Enabled=false in this deployment), the original
   *  `v3Service?.getBtcWatchVictim() ?? null` callback ALWAYS returned
   *  null, meaning BTC Safety in every signal ALWAYS reported "CLEAN"
   *  regardless of real market conditions -- a meaningless, always-
   *  true placeholder, exactly as the operator suspected from reading
   *  the live message. V5 already tracks BTCUSDT itself (LONG and
   *  SHORT victim watches, same as every other tracked symbol) -- this
   *  reads that REAL, live state directly, with zero new tracking
   *  machinery. If BOTH victims happen to have an active watch
   *  simultaneously (rare but structurally possible), LONG is reported
   *  first -- matching the original function's own Side|null shape
   *  (a single side, not both). */
  getBtcWatchVictim(): Side | null {
    if (this.watches.has(this.key("BTCUSDT", "LONG"))) return "LONG";
    if (this.watches.has(this.key("BTCUSDT", "SHORT"))) return "SHORT";
    return null;
  }

  /** Sep 8 2026, operator-corrected (Karo) -- REMOVED, no longer used.
   *  See v5BtcBlockEnabled()'s own doc comment for the replacement,
   *  same-side check (getBtcWatchVictim() already provides everything
   *  needed -- no separate boolean helper required). */

  private key(symbol: string, victim: Side): string {
    return `${symbol}:${victim}`;
  }

  private newWave(
    waveNumber: number,
    price: number,
    ts: number,
    liqUsd: number,
    oiStart: number | null,
  ): V5Wave {
    return {
      waveNumber,
      state: "ACTIVE",
      anchorPrice: price,
      anchorTs: ts,
      extremePrice: price,
      extremeTs: ts,
      reclaimPrice: null,
      reclaimTs: null,
      liqNotionalUsd: liqUsd,
      liqEvents: 1,
      maxSingleEventUsd: liqUsd,
      maxRecoveryPrice: price,
      recoveryPct: null,
      priceEfficiency: null,
      liquidationRatioVsDominant: null,
      priceEfficiencyRatioVsDominant: null,
      extremeDistanceAtr: 0,
      isMeaningful: false,
      selectedRecoveryPct: null,
      recoveryTargetPrice: null,
      recovery50AtTs: null,
      recovery50AtPrice: null,
      recovery75AtTs: null,
      recovery75AtPrice: null,
      takerBuyUsd: null,
      takerSellUsd: null,
      takerImbalance: null,
      oiStart,
      oiEnd: null,
      oiDeltaPct: null,
    };
  }

  /** Sep 7 2026, operator-requested (Karo) -- hard runtime invariant
   *  guard, checked at the exact moment a wave reclaims (before it is
   *  ever turned into a SIGNAL_CANDIDATE outcome). Chronology MUST
   *  hold:
   *    anchorTs <= extremeTs <= reclaimTs
   *    (if set) extremeTs <= recovery50AtTs <= reclaimTs
   *    (if set) extremeTs <= recovery75AtTs <= reclaimTs
   *  Returns a short, specific description of the FIRST violation
   *  found, or null if every check passes. Called defensively -- after
   *  the Sep 7 2026 recovery50/75AtTs reset fix, this should never
   *  actually fire in production, but persistence/entry must refuse
   *  to trust a wave whose own timestamps are internally inconsistent
   *  rather than silently persisting/trading on corrupted chronology. */

  /**
   * Sep 8 2026 (Karo), operator-designed minimal-cascade model
   * (REPLACES the previous W1/W2/W3 SUPERSEDE wave-chain -- see
   * git history / MIGRATION_NOTES.md for the removed logic). One
   * continuous cascade per (symbol, victim): any liquidation event
   * starts/continues tracking (NO P95 gate at episode-start -- a real
   * cascade may begin small and grow, per explicit operator
   * instruction). Liquidation pressure accumulates into ONE
   * cumulative total; the running extreme deepens continuously
   * (via both liquidation events here AND price ticks in onTick()
   * below) for as long as price keeps making progress in the
   * liquidation direction. There is no wave-numbering, no SUPERSEDE
   * state, no per-wave recovery-target -- completion is decided
   * entirely by onTick()'s own UNIT-based recovery check.
   */
  onLiquidation(liq: Liquidation): V5TickOutcome[] {
    const outcomes: V5TickOutcome[] = [];
    try {
      if (!V5_TRACKED_SYMBOLS.has(liq.symbol)) return outcomes;
      if (liq.symbol === "BTCUSDT" && v5BtcMode() === "EXCLUDE")
        return outcomes;

      let hist = this.liq24hHistory.get(liq.symbol);
      if (!hist) {
        hist = [];
        this.liq24hHistory.set(liq.symbol, hist);
      }
      hist.push({ ts: liq.timestamp, notional: liq.quoteQty });
      const cutoff = liq.timestamp - V5WaveService.DAY_MS;
      while (hist.length > 0 && hist[0]!.ts < cutoff) hist.shift();

      const victim: Side = liq.side === "SELL" ? "LONG" : "SHORT";
      const key = this.key(liq.symbol, victim);
      const existing = this.watches.get(key);

      if (!existing) {
        if (victim === "LONG" && !v5LongEnabled()) return outcomes;
        if (victim === "SHORT" && !v5ShortEnabled()) return outcomes;

        const signalId = randomUUID();
        const cascade = this.newWave(
          1,
          liq.price,
          liq.timestamp,
          liq.quoteQty,
          this.getOi(liq.symbol)?.contracts ?? null,
        );
        const p95AtStart = this.getIndividualP95(liq.symbol, victim);
        const watch: V5WatchState = {
          symbol: liq.symbol,
          side: victim,
          victim,
          signalId,
          createdAt: liq.timestamp,
          atrAtStart: this.getAtrAbs(liq.symbol, liq.price),
          unitAtStart: this.getUnit1mAbs(liq.symbol, liq.price),
          waves: [cascade],
          totalEpisodePressure: liq.quoteQty,
          qualifyingEventUsd: liq.quoteQty,
          qualifyingEventTs: liq.timestamp,
          p95AtQualification: p95AtStart,
          // Sep 8 2026 (Karo), operator-corrected -- checked against
          // THIS event's own arrival, using P95 AT THAT MOMENT (same
          // convention as every subsequent event's own check below).
          hasP95Event: p95AtStart > 0 && liq.quoteQty >= p95AtStart,
          lastLiquidationTs: liq.timestamp,
          signalIssued: false,
          tradeActive: false,
          w1Diagnostics: null,
          dominantLayerLiqUsd: null,
          dominantLayerWaveNumber: null,
          dominantLayerPriceEfficiency: null,
        };
        this.watches.set(key, watch);
        log.info(
          `[V5_CASCADE_STARTED] ${liq.symbol} ${victim} signalId=${signalId} ` +
            `firstEventUsd=${liq.quoteQty} anchorPrice=${liq.price} unit=${watch.unitAtStart} hasP95Event=${watch.hasP95Event}`,
        );
        return outcomes;
      }

      existing.totalEpisodePressure += liq.quoteQty;
      existing.lastLiquidationTs = liq.timestamp;

      const lastWave = existing.waves[existing.waves.length - 1]!;

      // Sep 9 2026 (Karo), operator-designed Wave1/Wave2 requirement --
      // Wave 1 has completed (1x UNIT recovery already reached, see
      // onTick()) and NO Wave 2 has started yet: THIS event is the one
      // that starts Wave 2. Mirrors the exact same fresh-start shape
      // onLiquidation()'s own watch-creation branch above uses (fresh
      // anchor at THIS event's own price, fresh liqEvents/hasP95Event
      // -- a genuinely new wave, distinct price-structure, never
      // inheriting Wave 1's own counts). totalEpisodePressure (already
      // incremented above) keeps accumulating across BOTH waves
      // unconditionally, unchanged from before -- only the PER-WAVE
      // liqEvents/hasP95Event qualification restarts.
      if (existing.waves.length === 1 && lastWave.state === "COMPLETED") {
        const wave2 = this.newWave(
          2,
          liq.price,
          liq.timestamp,
          liq.quoteQty,
          this.getOi(liq.symbol)?.contracts ?? null,
        );
        existing.waves.push(wave2);
        const p95Now = this.getIndividualP95(liq.symbol, victim);
        existing.hasP95Event = p95Now > 0 && liq.quoteQty >= p95Now;
        log.info(
          `[V5_WAVE2_STARTED] ${liq.symbol} ${victim} signalId=${existing.signalId} ` +
            `firstEventUsd=${liq.quoteQty} anchorPrice=${liq.price} hasP95Event=${existing.hasP95Event}`,
        );
        return outcomes;
      }

      // Sep 8 2026 (Karo), operator-corrected minimal-cascade model --
      // REPLACES the previous cumulative-vs-P95 comparison (removed
      // entirely). Latches true the FIRST time ANY individual event in
      // this cascade clears P95, checked against P95's value AT THIS
      // EVENT's own arrival -- never re-checked retroactively, never
      // reset to false once true.
      if (!existing.hasP95Event) {
        const p95Now = this.getIndividualP95(liq.symbol, victim);
        if (p95Now > 0 && liq.quoteQty >= p95Now) {
          existing.hasP95Event = true;
          log.info(
            `[V5_P95_EVENT_SEEN] ${liq.symbol} ${victim} signalId=${existing.signalId} eventUsd=${liq.quoteQty} p95=${p95Now}`,
          );
        }
      }

      const cascade = lastWave;
      cascade.liqNotionalUsd += liq.quoteQty;
      cascade.liqEvents += 1;
      cascade.maxSingleEventUsd = Math.max(
        cascade.maxSingleEventUsd,
        liq.quoteQty,
      );

      const isDeeper =
        victim === "LONG"
          ? liq.price < cascade.extremePrice
          : liq.price > cascade.extremePrice;
      if (isDeeper) {
        cascade.extremePrice = liq.price;
        cascade.extremeTs = liq.timestamp;
        cascade.maxRecoveryPrice = liq.price;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol: liq.symbol, err: msg },
        "[V5_ERROR] onLiquidation failed, isolated from production",
      );
    }
    return outcomes;
  }

  /**
   * Sep 8 2026 (Karo), operator-designed minimal-cascade model.
   * Extends the running extreme via price alone (liquidation events
   * ALSO extend it, in onLiquidation() above -- whichever is deeper
   * at any moment wins). Once price recovers ~1 UNIT from the LATEST
   * extreme, the cascade push is considered structurally finished --
   * seriousness (cumulative liquidation pressure vs the P95-
   * equivalent bar) is evaluated ONCE, here, deciding SIGNAL_CANDIDATE
   * vs a genuine "pushed, but never serious enough" terminal outcome.
   * No hysteresis, no separate confirm/discard thresholds -- exactly
   * the operator's own final, deliberately minimal specification.
   */
  onTick(symbol: string, mid: number, ts: number): V5TickOutcome[] {
    const outcomes: V5TickOutcome[] = [];
    try {
      if (symbol === "BTCUSDT") this.lastBtcPrice = mid;
      this.lastPriceAt.set(symbol, mid);

      for (const victim of ["LONG", "SHORT"] as const) {
        const key = this.key(symbol, victim);
        const watch = this.watches.get(key);
        if (!watch) continue;

        // Large, diagnostic-only safety valves -- NEVER a wave-
        // completion decision, unchanged from before.
        if (ts - watch.lastLiquidationTs >= v5EpisodeInactivityMs()) {
          const waveHistory = watch.waves.map((w) => ({ ...w }));
          outcomes.push({
            kind: "TERMINAL_NON_SIGNAL",
            event: { watch, reason: "EPISODE_EXPIRED_INACTIVITY", waveHistory },
          });
          this.watches.delete(key);
          log.info(
            `[V5_EPISODE_EXPIRED_INACTIVITY] ${symbol} ${victim} signalId=${watch.signalId}`,
          );
          continue;
        }
        if (ts - watch.createdAt >= v5EpisodeSafetyTimeoutMs()) {
          const waveHistory = watch.waves.map((w) => ({ ...w }));
          outcomes.push({
            kind: "TERMINAL_NON_SIGNAL",
            event: {
              watch,
              reason: "EPISODE_EXPIRED_SAFETY_TIMEOUT",
              waveHistory,
            },
          });
          this.watches.delete(key);
          log.info(
            `[V5_EPISODE_EXPIRED_SAFETY_TIMEOUT] ${symbol} ${victim} signalId=${watch.signalId}`,
          );
          continue;
        }

        const currentWave = watch.waves[watch.waves.length - 1]!;

        if (currentWave.state === "ACTIVE") {
          const isDeeper =
            victim === "LONG"
              ? mid < currentWave.extremePrice
              : mid > currentWave.extremePrice;
          if (isDeeper) {
            currentWave.extremePrice = mid;
            currentWave.extremeTs = ts;
            currentWave.maxRecoveryPrice = mid;
          }
          if (victim === "LONG" && mid > currentWave.maxRecoveryPrice)
            currentWave.maxRecoveryPrice = mid;
          if (victim === "SHORT" && mid < currentWave.maxRecoveryPrice)
            currentWave.maxRecoveryPrice = mid;

          // UNIT not warm yet -- cannot evaluate recovery. The wave
          // keeps accumulating (above); this symbol simply won't reach
          // a completion decision until ATR(1m) is available.
          if (watch.unitAtStart <= 0) continue;

          const recoveryDistance = Math.abs(mid - currentWave.extremePrice);
          if (recoveryDistance < watch.unitAtStart) continue;

          // Recovery has reached ~1 UNIT from the latest extreme: this
          // wave is structurally finished.
          currentWave.state = "COMPLETED";
          currentWave.reclaimPrice = mid;
          currentWave.reclaimTs = ts;
          currentWave.recoveryPct = 100;

          // Sep 9 2026 (Karo), operator-designed Wave1/Wave2 requirement
          // -- Wave 1 (waves.length===1) can NEVER produce a signal
          // decision here. It simply completes and waits: either a new
          // same-victim liquidation starts Wave 2 (onLiquidation(),
          // above), or price recovers a further 1x UNIT (2x UNIT total
          // from Wave 1's own, now-fixed extreme) with no Wave 2 ever
          // starting, checked in the CANCEL_NO_SECOND_WAVE branch below
          // on a LATER tick. No signal-eligibility check of any kind
          // happens for Wave 1 -- this is the entire point of the
          // requirement ("waveCount < 2 -> ENTRY IS IMPOSSIBLE").
          if (watch.waves.length === 1) {
            log.info(
              `[V5_WAVE1_COMPLETE] ${symbol} ${victim} signalId=${watch.signalId} extreme=${currentWave.extremePrice} -- no entry, awaiting Wave 2 (cancel at 2x UNIT with no Wave 2)`,
            );
            continue;
          }

          // Sep 8 2026 (Karo), operator-corrected minimal-cascade model
          // -- UNCHANGED seriousness/signal-decision logic, now simply
          // evaluated for Wave 2 (the only wave ever eligible to reach
          // this point).
          if (this.getFlow) {
            const lookbackMs = Math.max(
              1000,
              currentWave.extremeTs - currentWave.anchorTs,
            );
            const flow = this.getFlow(symbol, lookbackMs, ts);
            if (flow) {
              currentWave.takerBuyUsd = flow.buyUsd;
              currentWave.takerSellUsd = flow.sellUsd;
              const total = flow.buyUsd + flow.sellUsd;
              currentWave.takerImbalance =
                total > 0 ? (flow.buyUsd - flow.sellUsd) / total : null;
            }
          }

          if (watch.hasP95Event && currentWave.liqEvents > 1) {
            outcomes.push({
              kind: "SIGNAL_CANDIDATE",
              watch,
              entryWave: currentWave,
            });
          } else {
            const waveHistory = watch.waves.map((w) => ({ ...w }));
            outcomes.push({
              kind: "TERMINAL_NON_SIGNAL",
              event: { watch, reason: "CASCADE_NOT_SERIOUS", waveHistory },
            });
            this.watches.delete(key);
            log.info(
              `[V5_CASCADE_NOT_SERIOUS] ${symbol} ${victim} signalId=${watch.signalId} ` +
                `cumulativeLiqUsd=${currentWave.liqNotionalUsd.toFixed(0)} hasP95Event=${watch.hasP95Event} liqEvents=${currentWave.liqEvents}`,
            );
          }
          continue;
        }

        // currentWave.state === "COMPLETED" && watch.waves.length === 1:
        // Wave 1 finished, no Wave 2 has started yet. Purely price-
        // structure-based cancellation -- NO time-based timeout, per
        // explicit operator instruction. Wave 1's own extreme is fixed
        // (never extended further once completed, above) -- 2x UNIT is
        // measured from that same, fixed point.
        if (currentWave.state === "COMPLETED" && watch.waves.length === 1) {
          if (watch.unitAtStart <= 0) continue;
          const recoveryDistance = Math.abs(mid - currentWave.extremePrice);
          if (recoveryDistance < 2 * watch.unitAtStart) continue;

          const waveHistory = watch.waves.map((w) => ({ ...w }));
          outcomes.push({
            kind: "TERMINAL_NON_SIGNAL",
            event: { watch, reason: "CANCEL_NO_SECOND_WAVE", waveHistory },
          });
          this.watches.delete(key);
          log.info(
            `[V5_CANCEL_NO_SECOND_WAVE] ${symbol} ${victim} signalId=${watch.signalId} wave1Extreme=${currentWave.extremePrice} price=${mid}`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol, err: msg },
        "[V5_ERROR] onTick failed, isolated from production",
      );
    }
    return outcomes;
  }

  /** Sep 7 2026, operator-approved (Karo) -- the signal-decision glue.
   *  Called only when onTick() returns SIGNAL_CANDIDATE. cumLiq is
   *  ALWAYS watch.totalEpisodePressure (the corrected, never-reset,
   *  full-episode sum) -- never a single wave's own liqNotionalUsd.
   *  A BTC-blocked or geometry-rejected outcome still produces a full
   *  V5SignalEvent for research/Telegram purposes; it simply carries
   *  plan=null. */
  evaluateSignal(
    watch: V5WatchState,
    entryWave: V5Wave,
    entryPrice: number,
    entryTs: number,
  ): V5SignalEvent | null {
    if (watch.signalIssued) {
      log.warn(
        `[V5_SIGNAL_ALREADY_ISSUED] ${watch.symbol} ${watch.side} signalId=${watch.signalId} ` +
          `— evaluateSignal() called again for a watch that already issued its one signal; refusing, no-op`,
      );
      return null;
    }
    watch.signalIssued = true;

    const btcVictim = this.getBtcWatchVictim();
    const btcEval = evaluateBtcOpposingWatchSafe(
      watch.symbol,
      watch.side,
      () => btcVictim,
    );
    const btcOiSnap = this.getOi("BTCUSDT");
    const btcContext = {
      priceAtSignal: this.lastBtcPrice,
      oiAtSignal: btcOiSnap?.contracts ?? null,
    };
    const liq24hContext = this.get24hStats(watch.symbol, entryTs);
    const wallContext = this.getWallContext
      ? this.getWallContext(watch.symbol, watch.side)
      : NO_WALLS;

    let plan: V5SignalEvent["plan"] = null;
    let planDiagnostics: V5SignalEvent["planDiagnostics"] = null;
    let rejectionReason: string | null = null;

    if (watch.atrAtStart <= 0) {
      rejectionReason = "episode-missing-atr";
    } else {
      const baseline = this.getBaseline(watch.symbol, watch.victim);
      const atr15mPct = watch.atrAtStart / entryPrice;

      // Sep 9 2026 (Karo), operator-designed structural SL/TP --
      // REPLACES the previous liquidation-intensity/Hybrid-C-cap-
      // derived formula for actual sl/tp/rr. intensityRaw/intensity
      // are STILL computed here, unchanged formula (sqrt(cumLiq/
      // baseline), clamped to INTENSITY_MAX) -- purely informational
      // signal-confidence context now (liqStrength/liqStrengthRaw on
      // the persisted plan), never feeding sl/tp/rr. See
      // structural-trade-plan.ts's own doc comment for the full
      // design and the operator's own first-principles reasoning.
      const cumLiq = watch.totalEpisodePressure;
      const intensityRaw = baseline > 0 ? Math.sqrt(cumLiq / baseline) : 0;
      const intensity = Math.min(intensityRaw, INTENSITY_MAX);

      const result = deriveStructuralTradePlan({
        entry: entryPrice,
        side: watch.side,
        w2ExtremePrice: entryWave.extremePrice,
        unitAbs: watch.unitAtStart,
      });
      planDiagnostics = {
        intensityRaw,
        intensity,
        atr15mPct,
        liqBaseline: baseline,
        rawTpPct: 0,
        wallAdjustedTpPct: 0,
        wallApplied: false,
        rrCandidate: result.rrTarget,
        slCapApplied: false,
        slCapValue: 0,
        finalTpPct: result.ok ? result.tpPct : 0,
        finalSlPct: result.ok ? result.slPct : 0,
        structuralSoftExitPrice: result.softExitPrice,
        structuralRiskPct: result.structuralRiskPct,
        sizingRiskPct: result.ok ? result.sizingRiskPct : 0,
        hardStopRiskPct: result.ok ? result.hardStopRiskPct : 0,
      };
      if (result.ok) {
        plan = {
          entry: entryPrice,
          tp: result.tp,
          sl: result.sl,
          rr: result.rr,
          liqStrengthRaw: intensityRaw,
          liqStrength: intensity,
          liqBaseline: baseline,
          physicsTPPct: result.tpPct,
          wallAdjustedTpPct: result.tpPct,
          wallApplied: false,
          rrCandidate: result.rrTarget,
          slCapApplied: false,
          slCapValue: 0,
          finalTpPct: result.tpPct,
          finalSlPct: result.slPct,
          structuralSoftExitPrice: result.softExitPrice,
          structuralRiskPct: result.structuralRiskPct,
          sizingRiskPct: result.sizingRiskPct,
          hardStopRiskPct: result.hardStopRiskPct,
        };
      } else {
        rejectionReason = result.cancelReason;
      }
    }

    const waveHistory = watch.waves.map((w) => ({ ...w }));
    const event: V5SignalEvent = {
      signalId: watch.signalId,
      symbol: watch.symbol,
      side: watch.side,
      victim: watch.victim,
      signalTs: entryTs,
      entryPrice,
      entryWaveNumber: entryWave.waveNumber,
      waveHistory,
      w1Diagnostics: watch.w1Diagnostics,
      dominantLayerLiqUsd: watch.dominantLayerLiqUsd,
      dominantLayerWaveNumber: watch.dominantLayerWaveNumber,
      exhaustionLayerLiqUsd: entryWave.liqNotionalUsd,
      exhaustionLayerWaveNumber: entryWave.waveNumber,
      unitAtStart: watch.unitAtStart,
      totalEpisodePressure: watch.totalEpisodePressure,
      qualifyingEventUsd: watch.qualifyingEventUsd,
      qualifyingEventTs: watch.qualifyingEventTs,
      p95AtQualification: watch.p95AtQualification,
      btcSafetyStatus: btcEval.status,
      // Sep 8 2026, operator-approved (Karo) -- PURELY informational,
      // ALWAYS computed regardless of this instance's own
      // v5BtcBlockEnabled() setting -- lets MAIN's own Telegram show
      // "would BTC_BLOCK have applied here" even though MAIN itself
      // never enforces it, so the operator has visibility into what
      // BROTHER/FRIEND did/would do with the SAME signal, without
      // needing cross-instance communication. Same underlying value
      // as getBtcWatchVictim() -- see that method's own doc comment.
      btcIntendedSideAtSignalTime: btcVictim,
      plan,
      rejectionReason,
      planDiagnostics,
      btcContext,
      liq24hContext,
      wallContext: wallContext.atEntry,
    };

    log.info(
      `[V5_SIGNAL] ${watch.symbol} ${watch.side} signalId=${watch.signalId} ` +
        `entryWaveNumber=${entryWave.waveNumber} totalEpisodePressure=${watch.totalEpisodePressure.toFixed(0)} ` +
        `btcSafety=${btcEval.status} plan=${plan ? "ok" : `rejected:${rejectionReason}`}`,
    );

    if (plan) {
      watch.tradeActive = true;
      this.activeTrades.set(watch.signalId, {
        signalId: watch.signalId,
        symbol: watch.symbol,
        victim: watch.victim,
        side: watch.side,
        entry: plan.entry,
        tp: plan.tp,
        sl: plan.sl,
        openedAt: entryTs,
        bestPrice: entryPrice,
        worstPrice: entryPrice,
        entryWaveNumber: entryWave.waveNumber,
        isLive: false,
        binanceSlOrderId: null,
        binanceTpOrderId: null,
        positionQty: null,
        notional: null,
        riskUsd: null,
      });
      log.info(
        `[V5_TRADE_INSTALLED] ${watch.symbol} ${watch.side} signalId=${watch.signalId} ` +
          `entry=${plan.entry} tp=${plan.tp} sl=${plan.sl} rr=${plan.rr}`,
      );
    }

    // The watch itself is released by the caller (app.ts) once this
    // event is fully persisted -- matching the existing, proven
    // pattern (mirrors V4's own releaseWatch() call site).
    return event;
  }

  /** Paper/live TP/SL monitoring for an installed V5 trade. Never
   *  throws; a duplicate tick after the trade has already been
   *  removed from activeTrades is a safe no-op. */
  onPriceTickForTrades(
    symbol: string,
    mid: number,
    ts: number,
  ): V5TradeCloseEvent[] {
    const closes: V5TradeCloseEvent[] = [];
    try {
      for (const trade of [...this.activeTrades.values()]) {
        if (trade.symbol !== symbol) continue;
        // Sep 7 2026, operator-approved (Karo) -- for a LIVE trade,
        // best/worst-price (MFE/MAE diagnostics) still update normally,
        // but the CLOSE itself must come from app.ts's own Binance
        // reconciliation poll (real confirmed fill), never from this
        // price-crossing simulation -- a real order can fill at a
        // different price than the exact in-memory tick (slippage), or
        // fail to fill at all. Matches V3's own execution-first /
        // reconciliation-confirmed close semantics.
        if (trade.side === "LONG") {
          if (mid > trade.bestPrice) trade.bestPrice = mid;
          if (mid < trade.worstPrice) trade.worstPrice = mid;
          if (trade.isLive) continue;
          if (mid >= trade.tp)
            closes.push(this.closeTrade(trade, "TP", mid, ts));
          else if (mid <= trade.sl)
            closes.push(this.closeTrade(trade, "SL", mid, ts));
        } else {
          if (mid < trade.bestPrice) trade.bestPrice = mid;
          if (mid > trade.worstPrice) trade.worstPrice = mid;
          if (trade.isLive) continue;
          if (mid <= trade.tp)
            closes.push(this.closeTrade(trade, "TP", mid, ts));
          else if (mid >= trade.sl)
            closes.push(this.closeTrade(trade, "SL", mid, ts));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol, err: msg },
        "[V5_ERROR] onPriceTickForTrades failed, isolated from production",
      );
    }
    return closes;
  }

  /** Sep 7 2026, operator-approved (Karo) -- called by app.ts ONLY
   *  after Binance reconciliation has confirmed a LIVE trade's real
   *  close (positionAmt=0, with the real fill price/reason) -- see
   *  onPriceTickForTrades()'s own doc comment for why live trades skip
   *  the normal price-crossing simulation entirely. Returns null if
   *  the signalId is no longer active (already closed/removed) --
   *  safe no-op, matching V3's own idempotent reconciliation pattern. */
  closeTradeConfirmed(
    signalId: string,
    outcome: "TP" | "SL",
    closePrice: number,
    closeTs: number,
  ): V5TradeCloseEvent | null {
    const trade = this.activeTrades.get(signalId);
    if (!trade) return null;
    return this.closeTrade(trade, outcome, closePrice, closeTs);
  }

  private closeTrade(
    trade: V5ActiveTrade,
    outcome: "TP" | "SL",
    closePrice: number,
    closeTs: number,
  ): V5TradeCloseEvent {
    this.activeTrades.delete(trade.signalId);
    log.info(
      `[V5_TRADE_CLOSED_${outcome}] ${trade.symbol} ${trade.side} signalId=${trade.signalId} ` +
        `entry=${trade.entry} close=${closePrice}`,
    );
    return { trade, outcome, closePrice, closeTs };
  }

  /** Releases a watch entirely -- call after ANY terminal outcome is
   *  fully persisted. Only then is the symbol/victim free for a
   *  genuinely fresh watch. */
  releaseWatch(symbol: string, victim: Side): void {
    this.watches.delete(this.key(symbol, victim));
  }

  /** Sep 7 2026, operator-approved (Karo) -- restart-survivability.
   *  Reconstructs the in-memory V5ActiveTrade (so onPriceTickForTrades()
   *  resumes monitoring it) after a PM2 restart. Called ONLY by
   *  app.ts's own boot-reconciliation, and ONLY after that
   *  reconciliation has already confirmed -- via the real historical
   *  price path, not just the current price -- that this signal
   *  genuinely never crossed its own TP/SL during the downtime. Does
   *  NOT reconstruct a full watch (V5 has no post-entry wave
   *  observation in this migration) -- only trade monitoring resumes. */
  hydrateActiveTrade(p: {
    signalId: string;
    symbol: string;
    victim: Side;
    side: Side;
    entry: number;
    tp: number;
    sl: number;
    openedAt: number;
    bestPrice: number;
    worstPrice: number;
    entryWaveNumber: number;
    isLive: boolean;
    binanceSlOrderId: number | null;
    binanceTpOrderId: number | null;
    positionQty: number | null;
    notional: number | null;
    riskUsd: number | null;
  }): void {
    this.activeTrades.set(p.signalId, {
      signalId: p.signalId,
      symbol: p.symbol,
      victim: p.victim,
      side: p.side,
      entry: p.entry,
      tp: p.tp,
      sl: p.sl,
      openedAt: p.openedAt,
      bestPrice: p.bestPrice,
      worstPrice: p.worstPrice,
      entryWaveNumber: p.entryWaveNumber,
      isLive: p.isLive,
      binanceSlOrderId: p.binanceSlOrderId,
      binanceTpOrderId: p.binanceTpOrderId,
      positionQty: p.positionQty,
      notional: p.notional,
      riskUsd: p.riskUsd,
    });
    log.info(
      `[V5_TRADE_HYDRATED] ${p.symbol} ${p.side} signalId=${p.signalId} ` +
        `entry=${p.entry} tp=${p.tp} sl=${p.sl} — restart-survived, resuming live monitoring`,
    );
  }
}
