import { randomUUID } from "crypto";
import type { Liquidation } from '../../shared/common.types';
import type { Side } from '../../shared/common.types';
import type { V5Wave, V5WatchState, V5ActiveTrade, V5TerminalReason, V5Wave1Diagnostics } from "./v5-wave.model";
import { V5_TRACKED_SYMBOLS, v5EpisodeInactivityMs, v5EpisodeSafetyTimeoutMs, v5MinMeaningfulExtremeAtr, v5MinWave1LiqEvents, v5LongEnabled, v5ShortEnabled, v5BtcMode } from "./v5.config";
import { deriveV5TradePlan } from "./v5-trade-plan";
import { evaluateBtcOpposingWatchSafe } from './btc-opposing-watch';
import type { WallSnapshots } from '../../domain/trading/trade-plan';
import { childLogger } from '../../infrastructure/logging/logger';

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
const NO_WALLS: WallSnapshots = { atEntry: NO_WALL, atAnchor: NO_WALL, atSweepStart: null };

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
  } | null;
  rejectionReason: string | null;
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

  private readonly liq24hHistory = new Map<string, Array<{ ts: number; notional: number }>>();
  private static readonly DAY_MS = 24 * 60 * 60_000;

  constructor(
    private readonly getAtrAbs: (symbol: string, referencePrice: number) => number,
    private readonly getOi: (symbol: string) => { contracts: number; ts: number } | null,
    private readonly getBaseline: (symbol: string) => number,
    private readonly getIndividualP95: (symbol: string) => number,
    private readonly getWallContext: ((symbol: string, side: Side) => WallSnapshots) | null = null,
    private readonly getFlow:
      | ((symbol: string, lookbackMs: number, now: number) => { buyUsd: number; sellUsd: number } | null)
      | null = null,
  ) {}

  private get24hStats(symbol: string, nowTs: number): { dayLiqTotalUsd: number; dayLiqEvents: number } {
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
    return [...this.activeTrades.values()].filter((t) => t.symbol === symbol && t.isLive);
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

  private computeRecoveryPct(wave: V5Wave, victim: Side): number | null {
    if (victim === "LONG") {
      const range = wave.anchorPrice - wave.extremePrice;
      return range > 0 ? ((wave.maxRecoveryPrice - wave.extremePrice) / range) * 100 : null;
    } else {
      const range = wave.extremePrice - wave.anchorPrice;
      return range > 0 ? ((wave.extremePrice - wave.maxRecoveryPrice) / range) * 100 : null;
    }
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
  private validateWaveChronology(wave: V5Wave): string | null {
    if (wave.anchorTs > wave.extremeTs) {
      return `anchorTs(${wave.anchorTs}) > extremeTs(${wave.extremeTs})`;
    }
    if (wave.reclaimTs !== null && wave.extremeTs > wave.reclaimTs) {
      return `extremeTs(${wave.extremeTs}) > reclaimTs(${wave.reclaimTs})`;
    }
    if (wave.recovery50AtTs !== null) {
      if (wave.recovery50AtTs < wave.extremeTs) {
        return `recovery50AtTs(${wave.recovery50AtTs}) < extremeTs(${wave.extremeTs})`;
      }
      if (wave.reclaimTs !== null && wave.recovery50AtTs > wave.reclaimTs) {
        return `recovery50AtTs(${wave.recovery50AtTs}) > reclaimTs(${wave.reclaimTs})`;
      }
    }
    if (wave.recovery75AtTs !== null) {
      if (wave.recovery75AtTs < wave.extremeTs) {
        return `recovery75AtTs(${wave.recovery75AtTs}) < extremeTs(${wave.extremeTs})`;
      }
      if (wave.reclaimTs !== null && wave.recovery75AtTs > wave.reclaimTs) {
        return `recovery75AtTs(${wave.recovery75AtTs}) > reclaimTs(${wave.reclaimTs})`;
      }
    }
    return null;
  }

  private newWave(waveNumber: number, price: number, ts: number, liqUsd: number, oiStart: number | null): V5Wave {
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

  /** Sep 7 2026, operator-approved (Karo) -- the meaningful-extreme
   *  gate + dynamic 50%/100% recovery target, validated via historical
   *  replay before activation (see v5_task_a_verification.ts).
   *  Recomputes extremeDistanceAtr/isMeaningful/selectedRecoveryPct/
   *  recoveryTargetPrice IN PLACE on the wave, using ONLY the wave's
   *  own current anchor/extreme -- called every time the extreme
   *  extends, guaranteeing no lookahead (nothing here ever reads a
   *  later tick's data). Monotonic: isMeaningful can only go false->
   *  true within one wave's life (distance only grows as extreme
   *  deepens), matching the explicit "dynamic, re-evaluated every
   *  tick, never retroactive" requirement.
   *
   *  Sep 7 2026, operator-caught structural-correctness fix (Karo) --
   *  CRITICAL. hasTarget was previously `waveNumber >= 2 ||
   *  isMeaningful` -- a wave-number SHORTCUT that incorrectly assumed
   *  "this is Wave2+" implied "real displacement has already
   *  happened". It does not: a freshly-superseded wave starts with
   *  anchorPrice === extremePrice (zero displacement, by
   *  construction), and that shortcut let it get an IMMEDIATELY
   *  satisfied 100% target (target === anchor === extreme) before
   *  price had moved even one tick in the liquidation direction --
   *  confirmed live (SOL signal 08028d90-09f8-4022-ac3b-7efd776cc112:
   *  W2 anchor=extreme=103.750, distanceATR=0.0000, entry fired
   *  immediately, SL in 53 sec). Fixed: hasTarget now requires REAL
   *  displacement (anchorPrice !== extremePrice) for Wave2+, not a
   *  wave-number proxy for it. Wave 1's own gate is UNCHANGED
   *  (isMeaningful already structurally implies displacement, since a
   *  positive ATR threshold can never be satisfied by zero distance --
   *  this fix does not alter Wave1's behavior at all). Once Wave2+ has
   *  genuine displacement, the EXISTING hybrid logic below is
   *  unchanged: 50% if meaningful, 100% if not -- this fix only gates
   *  WHEN a target exists at all, never how it's chosen once it does. */
  private recomputeRecoveryTarget(wave: V5Wave, victim: Side, atrAtStart: number): void {
    wave.extremeDistanceAtr = atrAtStart > 0 ? Math.abs(wave.anchorPrice - wave.extremePrice) / atrAtStart : 0;
    wave.isMeaningful = wave.extremeDistanceAtr >= v5MinMeaningfulExtremeAtr();

    const hasDisplacement = wave.anchorPrice !== wave.extremePrice;
    const hasTarget = wave.waveNumber === 1 ? wave.isMeaningful : hasDisplacement;
    if (!hasTarget) {
      wave.selectedRecoveryPct = null;
      wave.recoveryTargetPrice = null;
      return;
    }
    if (wave.isMeaningful) {
      wave.selectedRecoveryPct = 50;
      wave.recoveryTargetPrice =
        victim === "LONG"
          ? wave.anchorPrice - 0.5 * (wave.anchorPrice - wave.extremePrice)
          : wave.anchorPrice + 0.5 * (wave.extremePrice - wave.anchorPrice);
    } else {
      wave.selectedRecoveryPct = 100;
      wave.recoveryTargetPrice = wave.anchorPrice;
    }
  }

  /** Sep 7 2026, operator-requested (Karo) -- builds Wave 1's own
   *  complete diagnostic snapshot. MEASUREMENT ONLY -- reads existing
   *  wave/watch fields, writes nothing back into any decision-relevant
   *  field. Callers are responsible for only calling this once per
   *  watch (guarded by `watch.w1Diagnostics === null` at every call
   *  site) so the FIRST time Wave 1 concludes is what gets persisted,
   *  never overwritten by a later, unrelated event. */
  private buildW1Diagnostics(
    watch: V5WatchState,
    wave1: V5Wave,
    victim: Side,
    concludedTs: number,
    concludedReason: V5Wave1Diagnostics["concludedReason"],
  ): V5Wave1Diagnostics {
    const anchorToExtremeMs = wave1.extremeTs - wave1.anchorTs;
    const speedAtrPerMinute = anchorToExtremeMs > 0 ? wave1.extremeDistanceAtr / (anchorToExtremeMs / 60_000) : null;
    const continuationLiqUsd = wave1.liqNotionalUsd - watch.qualifyingEventUsd;
    const continuationRatio = watch.qualifyingEventUsd > 0 ? continuationLiqUsd / watch.qualifyingEventUsd : 0;
    const distancePct = wave1.anchorPrice > 0 ? Math.abs(wave1.anchorPrice - wave1.extremePrice) / wave1.anchorPrice : 0;
    const priceImpactPer1M = wave1.liqNotionalUsd > 0 ? (distancePct * 100) / (wave1.liqNotionalUsd / 1_000_000) : null;
    const recoveryPctAtEntry = this.computeRecoveryPct(wave1, victim);

    return {
      qualifyingEventUsd: watch.qualifyingEventUsd,
      p95AtQualification: watch.p95AtQualification,
      qualifyingEventToP95Ratio: watch.p95AtQualification > 0 ? watch.qualifyingEventUsd / watch.p95AtQualification : 0,
      anchorPrice: wave1.anchorPrice,
      anchorTs: wave1.anchorTs,
      extremePrice: wave1.extremePrice,
      extremeTs: wave1.extremeTs,
      extremeDistanceAtr: wave1.extremeDistanceAtr,
      anchorToExtremeMs,
      speedAtrPerMinute,
      w1TotalLiqUsd: wave1.liqNotionalUsd,
      w1LiqEvents: wave1.liqEvents,
      continuationLiqUsd,
      continuationRatio,
      priceImpactPer1M,
      takerBuyUsd: wave1.takerBuyUsd,
      takerSellUsd: wave1.takerSellUsd,
      takerImbalance: wave1.takerImbalance,
      oiStart: wave1.oiStart,
      oiEnd: wave1.oiEnd,
      oiDeltaPct: wave1.oiDeltaPct,
      concludedReason,
      concludedTs,
      extremeToRecoveryMs: concludedTs - wave1.extremeTs,
      recoveryPctAtEntry,
    };
  }

  onLiquidation(liq: Liquidation): V5TickOutcome[] {
    const outcomes: V5TickOutcome[] = [];
    try {
      if (!V5_TRACKED_SYMBOLS.has(liq.symbol)) return outcomes;
      // Sep 7 2026, operator-approved (Karo) -- BTC EXCLUDE mode: BTC
      // is treated as entirely untracked, exactly like a symbol never
      // in V5_TRACKED_SYMBOLS at all. See v5BtcMode()'s own doc comment.
      if (liq.symbol === "BTCUSDT" && v5BtcMode() === "EXCLUDE") return outcomes;

      // Sep 7 2026 (Karo) -- 24h history recorded UNCONDITIONALLY,
      // before qualification, mirroring V4's own independent tracking.
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
        // Sep 7 2026, operator-requested (Karo) -- manual directional
        // kill-switch, checked ONLY here (fresh-watch qualification) --
        // see v5LongEnabled()/v5ShortEnabled()'s own doc comment. An
        // already-running watch is never affected by a mid-day flip.
        if (victim === "LONG" && !v5LongEnabled()) return outcomes;
        if (victim === "SHORT" && !v5ShortEnabled()) return outcomes;

        // Sep 8 2026, operator-corrected (Karo) -- REMOVED. This used
        // to block ANY-direction watch-qualification for non-BTC
        // symbols whenever BTC had ANY active watch. The operator
        // explicitly clarified this was NOT the intended semantics --
        // see v5BtcBlockAllowed()'s own doc comment for the correct,
        // same-side, entry-time check that replaces this. Watch
        // qualification for non-BTC symbols is now completely
        // unaffected by BTC's state; only the ALT's own final entry
        // decision (in app.ts) is gated.

        // Sep 7 2026, operator-approved (Karo) -- PURE P95 qualification,
        // no tier-floor blend (see v5-liq-stats.ts's own doc comment).
        // Only a qualifying individual event can start a watch at all.
        const p95 = this.getIndividualP95(liq.symbol);
        if (p95 <= 0 || liq.quoteQty < p95) return outcomes; // not enough warm data, or genuinely sub-threshold
        const signalId = randomUUID();
        const wave1 = this.newWave(1, liq.price, liq.timestamp, liq.quoteQty, this.getOi(liq.symbol)?.contracts ?? null);
        const watch: V5WatchState = {
          symbol: liq.symbol,
          side: victim,
          victim,
          signalId,
          createdAt: liq.timestamp,
          atrAtStart: this.getAtrAbs(liq.symbol, liq.price),
          waves: [wave1],
          totalEpisodePressure: liq.quoteQty,
          qualifyingEventUsd: liq.quoteQty,
          qualifyingEventTs: liq.timestamp,
          p95AtQualification: p95,
          lastLiquidationTs: liq.timestamp,
          signalIssued: false,
          tradeActive: false,
          w1Diagnostics: null,
          dominantLayerLiqUsd: null,
          dominantLayerWaveNumber: null,
          dominantLayerPriceEfficiency: null,
        };
        this.recomputeRecoveryTarget(wave1, victim, watch.atrAtStart);
        this.watches.set(key, watch);
        log.info(
          `[V5_WATCH_CREATED] ${liq.symbol} ${victim} signalId=${signalId} ` +
            `qualifyingEventUsd=${liq.quoteQty} p95=${p95} anchorPrice=${liq.price}`,
        );
        return outcomes;
      }

      // Existing watch: liquidation always counts toward the never-
      // reset episode total, regardless of which wave it lands in.
      existing.totalEpisodePressure += liq.quoteQty;
      existing.lastLiquidationTs = liq.timestamp;

      const currentWave = existing.waves[existing.waves.length - 1]!;

      // Sep 7 2026, operator-approved (Karo) -- LIQUIDATION-LAYER
      // architecture. The current wave can be non-ACTIVE here for
      // exactly one reason now: it reached its own recoveryTargetPrice
      // via price movement alone (onTick's own reclaim-check) and
      // turned out to be dominant/growing -- WAITING_FOR_NEXT_LAYER.
      // (A wave that fired real ENTRY instead has its whole watch
      // released immediately by app.ts, so this code can never observe
      // that case -- existing.watches.get(key) would already be
      // undefined.) This liquidation event is a CANDIDATE for the
      // "next real layer" the watch has been waiting for.
      //
      // Sep 7 2026, operator-caught fix (Karo) -- CRITICAL. This
      // candidate must clear the SAME pure-P95 bar Wave1's own
      // qualification uses -- reusing the existing, already-validated
      // getIndividualP95() callback, never a new/arbitrary threshold.
      // Without this, an unrelated, tiny liquidation arriving long
      // after a genuine layer completed could start a fake "next
      // layer" of its own -- and because a tiny wave naturally has a
      // tiny liqUsd, it would almost always be weaker than whatever
      // dominant layer was already established, routing it STRAIGHT to
      // exhaustion-candidate and firing entry off pure noise. This is
      // the exact SUIUSDT ($747)/SOL ($2.8k) bug class, now confirmed
      // to still reach this specific code path. A sub-P95 event here
      // is genuinely ignored -- it already contributed to
      // totalEpisodePressure above (unconditional, diagnostic), but it
      // does NOT get to start a new layer; the watch stays in
      // WAITING_FOR_NEXT_LAYER exactly as before, waiting for a
      // genuinely qualifying event.
      if (currentWave.state !== "ACTIVE") {
        const p95ForNextLayer = this.getIndividualP95(liq.symbol);
        if (p95ForNextLayer <= 0 || liq.quoteQty < p95ForNextLayer) {
          log.info(
            `[V5_NEXT_LAYER_CANDIDATE_TOO_SMALL] ${liq.symbol} ${victim} signalId=${existing.signalId} ` +
              `eventUsd=${liq.quoteQty} p95=${p95ForNextLayer} — ignored as noise, still WAITING_FOR_NEXT_LAYER`,
          );
          return outcomes;
        }
        const nextWave = this.newWave(
          currentWave.waveNumber + 1,
          liq.price,
          liq.timestamp,
          liq.quoteQty,
          this.getOi(liq.symbol)?.contracts ?? null,
        );
        this.recomputeRecoveryTarget(nextWave, victim, existing.atrAtStart);
        existing.waves.push(nextWave);
        log.info(
          `[V5_LAYER_STARTED] ${liq.symbol} ${victim} signalId=${existing.signalId} ` +
            `waveNumber=${nextWave.waveNumber} anchorPrice=${liq.price} — the awaited next layer has arrived`,
        );
        return outcomes;
      }

      const lastPrice = this.lastPriceAt.get(liq.symbol) ?? liq.price;
      const hasRecoveredFromExtreme =
        victim === "LONG" ? lastPrice > currentWave.extremePrice : lastPrice < currentWave.extremePrice;

      if (hasRecoveredFromExtreme) {
        // Sep 7 2026, operator-caught fix (Karo) -- SAME pure-P95 gate
        // as the WAITING_FOR_NEXT_LAYER branch above, applied here too
        // -- this is the OTHER path a new wave can be created through
        // (a liquidation arriving while price has ALREADY partially
        // recovered from the CURRENT wave's own extreme, even before
        // that wave ever reached its own target). A sub-P95 event here
        // must NOT be allowed to supersede a still-developing wave --
        // it's ignored as noise (still counted in totalEpisodePressure
        // above, diagnostic-only); the current wave's own extreme/
        // target keep tracking exactly as before, completely untouched.
        const p95ForSupersede = this.getIndividualP95(liq.symbol);
        if (p95ForSupersede <= 0 || liq.quoteQty < p95ForSupersede) {
          log.info(
            `[V5_SUPERSEDE_CANDIDATE_TOO_SMALL] ${liq.symbol} ${victim} signalId=${existing.signalId} ` +
              `eventUsd=${liq.quoteQty} p95=${p95ForSupersede} waveNumber=${currentWave.waveNumber} — ignored as noise, wave stays ACTIVE`,
          );
          return outcomes;
        }

        // Sep 7 2026, operator-approved (Karo) -- Wave 1's own
        // meaningful-extreme gate. If Wave 1 was NEVER meaningful up
        // to the exact moment it's about to be superseded, the ENTIRE
        // episode is discarded here -- no entry, no 100% fallback, no
        // Wave 2 continuation. Persisted with its own terminal reason
        // (W1_EXTREME_TOO_SMALL), never silently dropped.
        if (currentWave.waveNumber === 1 && !currentWave.isMeaningful) {
          if (existing.w1Diagnostics === null) {
            existing.w1Diagnostics = this.buildW1Diagnostics(existing, currentWave, victim, liq.timestamp, "DISCARDED_TOO_SMALL");
          }
          const waveHistory = [{ ...currentWave }];
          outcomes.push({ kind: "TERMINAL_NON_SIGNAL", event: { watch: existing, reason: "W1_EXTREME_TOO_SMALL", waveHistory } });
          this.watches.delete(key);
          log.info(
            `[V5_W1_EXTREME_TOO_SMALL] ${liq.symbol} ${victim} signalId=${existing.signalId} ` +
              `extremeDistanceAtr=${currentWave.extremeDistanceAtr.toFixed(4)} (threshold=${v5MinMeaningfulExtremeAtr()}) — entire episode discarded`,
          );
          return outcomes;
        }

        // Genuinely new push: this liquidation event's own price becomes
        // the next wave's anchor. The current wave is now permanently
        // un-reclaimable (SUPERSEDED), per the validated offline logic.
        currentWave.state = "SUPERSEDED";
        currentWave.recoveryPct = this.computeRecoveryPct(currentWave, victim);
        if (currentWave.waveNumber === 1 && existing.w1Diagnostics === null) {
          existing.w1Diagnostics = this.buildW1Diagnostics(existing, currentWave, victim, liq.timestamp, "SUPERSEDED_TO_W2");
        }
        const nextWave = this.newWave(
          currentWave.waveNumber + 1,
          liq.price,
          liq.timestamp,
          liq.quoteQty,
          this.getOi(liq.symbol)?.contracts ?? null,
        );
        this.recomputeRecoveryTarget(nextWave, victim, existing.atrAtStart);
        existing.waves.push(nextWave);
        log.info(
          `[V5_WAVE_STARTED] ${liq.symbol} ${victim} signalId=${existing.signalId} ` +
            `waveNumber=${nextWave.waveNumber} anchorPrice=${liq.price} — previous wave superseded, recoveryPct=${currentWave.recoveryPct?.toFixed(1) ?? "n/a"}`,
        );
      } else {
        currentWave.liqNotionalUsd += liq.quoteQty;
        currentWave.liqEvents += 1;
        currentWave.maxSingleEventUsd = Math.max(currentWave.maxSingleEventUsd, liq.quoteQty);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ symbol: liq.symbol, err: msg }, "[V5_ERROR] onLiquidation failed, isolated from production");
    }
    return outcomes;
  }

  onTick(symbol: string, mid: number, ts: number): V5TickOutcome[] {
    const outcomes: V5TickOutcome[] = [];
    try {
      if (symbol === "BTCUSDT") this.lastBtcPrice = mid;
      this.lastPriceAt.set(symbol, mid);

      for (const victim of ["LONG", "SHORT"] as const) {
        const key = this.key(symbol, victim);
        const watch = this.watches.get(key);
        if (!watch) continue;

        // Sep 7 2026 (Karo) -- large, diagnostic-only safety valves.
        // NEVER a wave-completion decision -- see v5.config.ts.
        if (ts - watch.lastLiquidationTs >= v5EpisodeInactivityMs()) {
          if (watch.w1Diagnostics === null) {
            watch.w1Diagnostics = this.buildW1Diagnostics(watch, watch.waves[0]!, victim, ts, "STILL_ACTIVE_AT_EPISODE_TIMEOUT");
          }
          const waveHistory = watch.waves.map((w) => ({ ...w }));
          outcomes.push({ kind: "TERMINAL_NON_SIGNAL", event: { watch, reason: "EPISODE_EXPIRED_INACTIVITY", waveHistory } });
          this.watches.delete(key);
          log.info(`[V5_EPISODE_EXPIRED_INACTIVITY] ${symbol} ${victim} signalId=${watch.signalId} waveCount=${watch.waves.length}`);
          continue;
        }
        if (ts - watch.createdAt >= v5EpisodeSafetyTimeoutMs()) {
          if (watch.w1Diagnostics === null) {
            watch.w1Diagnostics = this.buildW1Diagnostics(watch, watch.waves[0]!, victim, ts, "STILL_ACTIVE_AT_EPISODE_TIMEOUT");
          }
          const waveHistory = watch.waves.map((w) => ({ ...w }));
          outcomes.push({ kind: "TERMINAL_NON_SIGNAL", event: { watch, reason: "EPISODE_EXPIRED_SAFETY_TIMEOUT", waveHistory } });
          this.watches.delete(key);
          log.info(`[V5_EPISODE_EXPIRED_SAFETY_TIMEOUT] ${symbol} ${victim} signalId=${watch.signalId} waveCount=${watch.waves.length}`);
          continue;
        }

        const currentWave = watch.waves[watch.waves.length - 1]!;
        if (currentWave.state !== "ACTIVE") continue;

        // Extend the wave's own extreme; reset the recovery tracker to
        // this new, deeper extreme (per explicit operator instruction --
        // recovery is always measured from the LATEST extreme). Then
        // recompute the meaningful-extreme gate + dynamic 50%/100%
        // target IN PLACE, using ONLY this wave's own current anchor/
        // extreme -- no lookahead (see recomputeRecoveryTarget()'s own
        // doc comment).
        //
        // Sep 7 2026, operator-caught bug fix (Karo) -- CRITICAL. The
        // recovery50AtTs/recovery75AtTs shadow-diagnostic milestones
        // (below) were NEVER reset here, meaning a milestone recorded
        // against an early, SHALLOW extreme stayed permanently locked
        // in even after the wave's TRUE extreme deepened much further
        // afterward -- producing the exact "recovery50AtTs BEFORE
        // extremeTs" anomaly the operator found in two live signals
        // (AVAXUSDT, ADAUSDT). Confirmed this bug is ISOLATED to these
        // two diagnostic fields alone -- see the module-level audit
        // note below this method for the full verification that the
        // actual ENTRY decision (recoveryTargetPrice) was NEVER
        // affected, since recomputeRecoveryTarget() already correctly
        // recalculates the entry target itself on every extension.
        const extendsExtreme = victim === "LONG" ? mid < currentWave.extremePrice : mid > currentWave.extremePrice;
        if (extendsExtreme) {
          currentWave.extremePrice = mid;
          currentWave.extremeTs = ts;
          currentWave.maxRecoveryPrice = mid;
          currentWave.recovery50AtTs = null;
          currentWave.recovery50AtPrice = null;
          currentWave.recovery75AtTs = null;
          currentWave.recovery75AtPrice = null;
          this.recomputeRecoveryTarget(currentWave, victim, watch.atrAtStart);
        }

        // Track the best price reached toward anchor since the latest
        // extreme -- SAME price reference (mid) as the reclaim check
        // below, structurally avoiding the wick-vs-close bug class
        // found during offline validation.
        if (victim === "LONG" && mid > currentWave.maxRecoveryPrice) currentWave.maxRecoveryPrice = mid;
        if (victim === "SHORT" && mid < currentWave.maxRecoveryPrice) currentWave.maxRecoveryPrice = mid;

        // Sep 7 2026, operator-approved (Karo) -- shadow diagnostics
        // ONLY, always measured toward the FULL anchor (100%),
        // independent of the wave's own dynamic 50%/100% entry target
        // below. Recorded so a later offline pass can compare
        // milestones; NEVER read by the entry decision itself.
        const recoveryPctNow = this.computeRecoveryPct(currentWave, victim);
        if (recoveryPctNow !== null) {
          if (recoveryPctNow >= 50 && currentWave.recovery50AtTs === null) {
            currentWave.recovery50AtTs = ts;
            currentWave.recovery50AtPrice = mid;
          }
          if (recoveryPctNow >= 75 && currentWave.recovery75AtTs === null) {
            currentWave.recovery75AtTs = ts;
            currentWave.recovery75AtPrice = mid;
          }
        }

        // Sep 7 2026, operator-approved (Karo) -- THE entry trigger:
        // the wave's own DYNAMIC target (recoveryTargetPrice), 50% or
        // 100% depending on isMeaningful, recomputed above on every
        // extreme extension. Wave 1 has NO target (recoveryTargetPrice
        // stays null) while !isMeaningful -- no reclaim check happens
        // for it at all until either it becomes meaningful, or it gets
        // superseded (handled in onLiquidation()'s own gate).
        if (currentWave.recoveryTargetPrice === null) continue;
        const reclaimed = victim === "LONG" ? mid >= currentWave.recoveryTargetPrice : mid <= currentWave.recoveryTargetPrice;
        if (!reclaimed) continue;

        // Sep 7 2026, operator-approved (Karo) -- REVISED per explicit
        // operator instruction. Previously this suppressed entry but
        // left the wave ACTIVE, waiting for a confirming event -- the
        // operator found this let a later, UNRELATED, tiny liquidation
        // resurrect a stale single-event Wave1 as a fake "Wave 2"
        // (the exact SUIUSDT case: a $13.8k lone event + an unrelated
        // $747 event much later, wrongly chained together). Now: the
        // ENTIRE episode is terminated the INSTANT Wave1 reaches its
        // own recovery/entry trigger with only one liquidation event
        // -- regardless of that event's size, displacement, P95 ratio,
        // or speed (operator explicitly does not care about any of
        // those here). A later liquidation on this symbol+victim
        // starts a genuinely NEW episode (fresh anchor, fresh
        // totalEpisodePressure) -- it can NEVER become "Wave 2" of
        // this terminated one, since the watch itself is deleted here.
        if (currentWave.waveNumber === 1 && currentWave.liqEvents < v5MinWave1LiqEvents()) {
          if (watch.w1Diagnostics === null) {
            watch.w1Diagnostics = this.buildW1Diagnostics(watch, currentWave, victim, ts, "TERMINATED_SINGLE_EVENT");
          }
          log.info(
            `[V5_W1_SINGLE_EVENT_ONLY] ${symbol} ${victim} signalId=${watch.signalId} ` +
              `liqEvents=${currentWave.liqEvents} (min=${v5MinWave1LiqEvents()}) — entire episode terminated, watch released`,
          );
          const waveHistory = watch.waves.map((w) => ({ ...w }));
          outcomes.push({ kind: "TERMINAL_NON_SIGNAL", event: { watch, reason: "W1_SINGLE_EVENT_ONLY", waveHistory } });
          this.watches.delete(key);
          continue;
        }

        // Sep 7 2026, operator-approved (Karo) -- LIQUIDATION-LAYER
        // architecture, confirmed design "B". Reaching this wave's own
        // recoveryTargetPrice is now "LAYER COMPLETE", not automatic
        // entry. Compute this layer's own priceEfficiency
        // (extremeDistanceAtr already IS this wave's own INCREMENTAL
        // ATR progress, by construction -- each wave's anchor starts
        // exactly where the previous one left off) and compare its own
        // liquidation total against the STRONGEST layer seen so far
        // (dominantLayerLiqUsd). Ratios are persisted for EVERY
        // completed layer regardless of outcome -- measurement-first,
        // per explicit operator instruction: "any decrease" is the
        // TEMPORARY production gate for this phase, to be tightened
        // later from real live distributions, never a magnitude
        // threshold invented now.
        const priceEfficiency = currentWave.liqNotionalUsd > 0 ? currentWave.extremeDistanceAtr / currentWave.liqNotionalUsd : null;
        const priorDominantLiqUsd = watch.dominantLayerLiqUsd;
        const priorDominantPriceEfficiency = watch.dominantLayerPriceEfficiency;
        currentWave.priceEfficiency = priceEfficiency;
        currentWave.liquidationRatioVsDominant =
          priorDominantLiqUsd !== null && priorDominantLiqUsd > 0 ? currentWave.liqNotionalUsd / priorDominantLiqUsd : null;
        currentWave.priceEfficiencyRatioVsDominant =
          priorDominantPriceEfficiency !== null && priorDominantPriceEfficiency > 0 && priceEfficiency !== null
            ? priceEfficiency / priorDominantPriceEfficiency
            : null;

        // Sep 7 2026, operator-caught structural fix (Karo) -- a
        // NON-meaningful wave (< v5MinMeaningfulExtremeAtr, i.e. small
        // own displacement) can NEVER become the new dominant OVER AN
        // EXISTING dominant, no matter how large its own liqUsd
        // happens to be. Physically: "not meaningful" already IS a
        // low-price-efficiency signature (large-or-small liquidation
        // pressure that produced very little price progress) --
        // exactly the exhaustion physics the operator described, not a
        // candidate for "strength". Without this, a large-liqUsd-but-
        // tiny-displacement wave could wrongly win dominance by raw
        // dollar size alone, while a small-liqUsd meaningful wave
        // correctly loses to it -- backwards from the intended physics.
        //
        // EXCEPTION, also operator-caught: if NO dominant has EVER been
        // established yet (priorDominantLiqUsd === null -- can happen
        // when an earlier wave was superseded via partial-recovery
        // BEFORE ever reaching its own target, so it never competed at
        // all), this wave still becomes dominant regardless of its own
        // meaningfulness. Without this exception, a weak, non-
        // meaningful wave that happens to be the FIRST one to ever
        // complete would fall straight through to "exhaustion" and
        // fire an immediate, completely unconfirmed entry -- exactly
        // the isolated-print problem this whole architecture exists to
        // prevent. Establishing SOME reference first is required
        // before "weaker than X" can mean anything at all. W1 is
        // unaffected either way: it only ever has a target while
        // isMeaningful is already true, and it is always the first
        // wave, so priorDominantLiqUsd is always null for it.
        const isDominantOrGrowing =
          priorDominantLiqUsd === null ||
          (currentWave.isMeaningful && currentWave.liqNotionalUsd >= priorDominantLiqUsd);

        if (isDominantOrGrowing) {
          // CONTINUATION: this layer becomes (or remains) the new
          // dominant/reference layer. NO ENTRY -- the watch stays
          // alive, WAITING_FOR_NEXT_LAYER (this wave is marked
          // SUPERSEDED, exactly like the existing new-liquidation-
          // triggered supersession path -- onLiquidation()'s own
          // "state !== ACTIVE" branch will start the next layer fresh
          // the moment a genuinely new liquidation event arrives).
          watch.dominantLayerLiqUsd = currentWave.liqNotionalUsd;
          watch.dominantLayerWaveNumber = currentWave.waveNumber;
          watch.dominantLayerPriceEfficiency = priceEfficiency;
          currentWave.state = "SUPERSEDED";
          currentWave.recoveryPct = this.computeRecoveryPct(currentWave, victim);
          if (currentWave.waveNumber === 1 && watch.w1Diagnostics === null) {
            watch.w1Diagnostics = this.buildW1Diagnostics(watch, currentWave, victim, ts, "COMPLETED_AS_DOMINANT");
          }
          log.info(
            `[V5_LAYER_CONTINUATION] ${symbol} ${victim} signalId=${watch.signalId} ` +
              `waveNumber=${currentWave.waveNumber} liqUsd=${currentWave.liqNotionalUsd.toFixed(0)} — new dominant layer, waiting for next layer`,
          );
          continue;
        }

        // EXHAUSTION CANDIDATE -- this layer is genuinely weaker than
        // the established dominant. Proceed with the EXISTING,
        // unmodified recovery-confirmation/entry mechanism below --
        // the target has ALREADY been reached this exact tick (that's
        // what triggered layer-completion in the first place), so
        // entry fires immediately at `mid`, same as before this
        // migration.
        log.info(
          `[V5_LAYER_EXHAUSTION_CANDIDATE] ${symbol} ${victim} signalId=${watch.signalId} ` +
            `waveNumber=${currentWave.waveNumber} liqUsd=${currentWave.liqNotionalUsd.toFixed(0)} vs dominant=${priorDominantLiqUsd?.toFixed(0)} — proceeding to entry`,
        );

        {
          currentWave.state = "COMPLETED";
          currentWave.reclaimPrice = mid;
          currentWave.reclaimTs = ts;
          currentWave.recoveryPct = this.computeRecoveryPct(currentWave, victim);

          // Sep 7 2026, operator-requested (Karo) -- hard chronology
          // guard, checked BEFORE this wave is ever turned into a
          // SIGNAL_CANDIDATE. If the invariant fails, persistence/
          // entry is REFUSED (TERMINAL_NON_SIGNAL, not SIGNAL_CANDIDATE)
          // rather than trusting a wave with corrupted timestamps.
          const chronologyError = this.validateWaveChronology(currentWave);
          if (chronologyError !== null) {
            log.error(
              `[V5_WAVE_CHRONOLOGY_INVALID] ${symbol} ${victim} signalId=${watch.signalId} ` +
                `waveNumber=${currentWave.waveNumber} reason="${chronologyError}" — entry REFUSED, episode discarded`,
            );
            const waveHistory = watch.waves.map((w) => ({ ...w }));
            outcomes.push({ kind: "TERMINAL_NON_SIGNAL", event: { watch, reason: "WAVE_CHRONOLOGY_INVALID", waveHistory } });
            this.watches.delete(this.key(symbol, victim));
            continue;
          }

          const oiSnap = this.getOi(symbol);
          currentWave.oiEnd = oiSnap?.contracts ?? null;
          if (currentWave.oiStart !== null && currentWave.oiStart > 0 && currentWave.oiEnd !== null) {
            currentWave.oiDeltaPct = ((currentWave.oiEnd - currentWave.oiStart) / currentWave.oiStart) * 100;
          }
          if (this.getFlow) {
            const flow = this.getFlow(symbol, ts - currentWave.anchorTs, ts);
            if (flow) {
              currentWave.takerBuyUsd = flow.buyUsd;
              currentWave.takerSellUsd = flow.sellUsd;
              const total = flow.buyUsd + flow.sellUsd;
              currentWave.takerImbalance = total > 0 ? (flow.buyUsd - flow.sellUsd) / total : null;
            }
          }

          if (currentWave.waveNumber === 1 && watch.w1Diagnostics === null) {
            watch.w1Diagnostics = this.buildW1Diagnostics(watch, currentWave, victim, ts, "RECLAIMED_AS_ENTRY");
          }

          log.info(
            `[V5_ENTRY] ${symbol} ${victim} signalId=${watch.signalId} ` +
              `waveNumber=${currentWave.waveNumber} trigger=${currentWave.selectedRecoveryPct}% entryPrice=${mid} ` +
              `extremeDistanceAtr=${currentWave.extremeDistanceAtr.toFixed(4)} totalEpisodePressure=${watch.totalEpisodePressure.toFixed(0)}`,
          );
          outcomes.push({ kind: "SIGNAL_CANDIDATE", watch, entryWave: currentWave });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ symbol, err: msg }, "[V5_ERROR] onTick failed, isolated from production");
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
  evaluateSignal(watch: V5WatchState, entryWave: V5Wave, entryPrice: number, entryTs: number): V5SignalEvent | null {
    if (watch.signalIssued) {
      log.warn(
        `[V5_SIGNAL_ALREADY_ISSUED] ${watch.symbol} ${watch.side} signalId=${watch.signalId} ` +
          `— evaluateSignal() called again for a watch that already issued its one signal; refusing, no-op`,
      );
      return null;
    }
    watch.signalIssued = true;

    const btcVictim = this.getBtcWatchVictim();
    const btcEval = evaluateBtcOpposingWatchSafe(watch.symbol, watch.side, () => btcVictim);
    const btcOiSnap = this.getOi("BTCUSDT");
    const btcContext = { priceAtSignal: this.lastBtcPrice, oiAtSignal: btcOiSnap?.contracts ?? null };
    const liq24hContext = this.get24hStats(watch.symbol, entryTs);
    const wallContext = this.getWallContext ? this.getWallContext(watch.symbol, watch.side) : NO_WALLS;

    let plan: V5SignalEvent["plan"] = null;
    let rejectionReason: string | null = null;

    if (watch.atrAtStart <= 0) {
      rejectionReason = "episode-missing-atr";
    } else {
      const baseline = this.getBaseline(watch.symbol);
      const atr15mPct = watch.atrAtStart / entryPrice;
      const result = deriveV5TradePlan({
        episodeTotalLiqUsd: watch.totalEpisodePressure,
        atr15mPct,
        liqBaseline: baseline,
        entry: entryPrice,
        side: watch.side,
        walls: wallContext,
      });
      if (result.ok) {
        plan = {
          entry: entryPrice,
          tp: result.tp,
          sl: result.sl,
          rr: result.rr,
          liqStrengthRaw: result.intensityRaw,
          liqStrength: result.intensity,
          liqBaseline: baseline,
          physicsTPPct: result.rawTpPct,
          wallAdjustedTpPct: result.wallAdjustedTpPct,
          wallApplied: result.wallApplied,
          rrCandidate: result.rrCandidate,
          slCapApplied: result.slCapApplied,
          slCapValue: result.slCapValue,
          finalTpPct: result.finalTpPct,
          finalSlPct: result.finalSlPct,
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
  onPriceTickForTrades(symbol: string, mid: number, ts: number): V5TradeCloseEvent[] {
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
          if (mid >= trade.tp) closes.push(this.closeTrade(trade, "TP", mid, ts));
          else if (mid <= trade.sl) closes.push(this.closeTrade(trade, "SL", mid, ts));
        } else {
          if (mid < trade.bestPrice) trade.bestPrice = mid;
          if (mid > trade.worstPrice) trade.worstPrice = mid;
          if (trade.isLive) continue;
          if (mid <= trade.tp) closes.push(this.closeTrade(trade, "TP", mid, ts));
          else if (mid >= trade.sl) closes.push(this.closeTrade(trade, "SL", mid, ts));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ symbol, err: msg }, "[V5_ERROR] onPriceTickForTrades failed, isolated from production");
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
  closeTradeConfirmed(signalId: string, outcome: "TP" | "SL", closePrice: number, closeTs: number): V5TradeCloseEvent | null {
    const trade = this.activeTrades.get(signalId);
    if (!trade) return null;
    return this.closeTrade(trade, outcome, closePrice, closeTs);
  }

  private closeTrade(trade: V5ActiveTrade, outcome: "TP" | "SL", closePrice: number, closeTs: number): V5TradeCloseEvent {
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
