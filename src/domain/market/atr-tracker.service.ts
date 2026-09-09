import type { Candle, KlineInterval } from "../../shared/common.types";
import { atr as wilderAtr } from "../../shared/indicators";

/**
 * ATR Tracker — Stage A foundation.
 *
 * Maintains Wilder's ATR(14) per (symbol, interval) pair from closed candles
 * received off the WS kline stream. Also exposes:
 *   - rangeBefore(): pre-cascade range queries (sweep structure target/reclaim)
 *   - getTrend15m(): short-term trend classification (Patch P — 15m trend
 *     filter to block counter-trend paper signals; replaces Patch A's 1h
 *     filter, which was too slow for fast liquidation cascades)
 *
 * Tracked intervals:
 *   5m   — primary ATR for SL placement; reclaim quality confirmation (Patch C-quality)
 *   15m  — secondary ATR + swing range for target placement; trend filter (Patch P)
 *   1h   — kept tracked for backward-compat / future analysis (no live consumer
 *          after Patch P retired the 1h trend filter)
 *
 * Hybrid warmup (per spec):
 *   - period < 0  candles → null  (no data yet)
 *   - 1..3 candles      → null  (too cold; ~5min of data)
 *   - 4..14 candles     → APPROXIMATE ATR using simple average (allowed after first 15min)
 *   - ≥15 candles       → Wilder's smoothed ATR (full warm — true Wilder requires
 *                         period+1 candles because TR uses prevClose; one extra
 *                         candle vs the period bound at length=14)
 *
 * The 15-minute floor on approximate ATR comes from "0-15 min no signals"
 * per direction. With 5m candles, 3 closed candles ≈ 15min, so we require
 * at least 4 closed candles before any ATR returns non-null. This naturally
 * gates signals during the first 15 min after restart.
 *
 * State is RAM-only — never persists. Bot restart = cold buffer; first
 * usable ATR returns after ~15-20 minutes once new candles arrive.
 *
 * Exposed methods all return null on cold-buffer to let callers skip
 * cleanly with explicit reason ("atr-cold").
 */

const ATR_PERIOD = 14;
const APPROXIMATE_MIN_CANDLES = 4; // hybrid warmup: ≥4 closed candles = approximate ATR allowed
const HISTORY_BUFFER_SIZE = 100; // keep last 100 candles per (symbol, interval) for range queries

// ── Patch P (May 2026): 15m trend classification thresholds ──
// Replaces Patch A's 1h trend filter. Liquidation cascades complete in
// 5–10 minutes; the 1h slope was too slow to reflect intraday direction
// at the moment a candidate is evaluated. The 15m × 6 = 1.5h slope is
// fast enough to reflect short-term direction while still smoothing
// single-bar noise.
/** Number of closed 15m candles to compare for trend. 6 candles = 1.5h
 *  of recent context — long enough to dampen single-bar noise, short
 *  enough that "trend" reflects the intraday move that matters for a
 *  fade decision. Lookback was 6 in Patch A on 1h candles (= 6h slope);
 *  Patch P keeps the lookback constant but applies it to 15m candles. */
const TREND_15M_LOOKBACK = 6;
/** Percentage change band that classifies as NEUTRAL. ±0.25% over 1.5h
 *  is the calibration adopted in Patch P — tighter than Patch A's
 *  ±0.5% (which was tuned for the 6h horizon and let too many signals
 *  through on intraday continuation), but not so tight that 15m noise
 *  whipsaws into BULLISH/BEARISH on every wiggle. */
const TREND_15M_NEUTRAL_BAND_PCT = 0.0025;
/** Minimum closed 15m candles required to return a non-null trend.
 *  Below this we return null and the caller treats it as "trend unknown,
 *  do not block" (graceful degradation on cold buffer / restart).
 *  4 closed 15m candles ≈ 1h of warmup post-restart. */
const TREND_15M_MIN_CANDLES = 4;

/** 15m trend classification (Patch P). null = cold buffer, treat as unknown. */
export type Trend15m = "BULLISH" | "BEARISH" | "NEUTRAL" | null;

interface ATRState {
  /** Closed candles, oldest-first. Length capped at HISTORY_BUFFER_SIZE. */
  candles: Candle[];
  /** Cached smoothed ATR value once we cross ATR_PERIOD candles. */
  smoothedAtr: number | null;
  /** Aug 21 2026, operator-requested (Karo) — MARKET BASELINE shadow
   *  telemetry. Rolling history of the smoothedAtr value AS OF each
   *  closed candle (pushed in onCandle(), right after
   *  recomputeSmoothed() below) — NOT re-derived from raw candles at
   *  read time (Wilder's smoothing is inherently sequential/cumulative,
   *  so re-deriving historical ATR at arbitrary points would require
   *  replaying from the start each time; this way it's just one extra
   *  push per already-happening candle-close event). Capped at
   *  HISTORY_BUFFER_SIZE, same as `candles` above. */
  atrHistory: number[];
}

export class ATRTrackerService {
  private readonly state = new Map<string, ATRState>();

  /** Hook called from app.ts on every kline event. Only closed candles
   *  contribute to ATR — open candles are ignored. */
  onCandle(c: Candle): void {
    if (!c.isClosed) return;
    if (!this.isTracked(c.interval)) return;

    const key = this.keyFor(c.symbol, c.interval);
    let s = this.state.get(key);
    if (!s) {
      s = { candles: [], smoothedAtr: null, atrHistory: [] };
      this.state.set(key, s);
    }

    // Avoid duplicates from re-broadcast: dedupe by openTime
    const last = s.candles[s.candles.length - 1];
    if (last && last.openTime === c.openTime) return;

    s.candles.push(c);
    if (s.candles.length > HISTORY_BUFFER_SIZE) {
      s.candles.shift();
    }

    // Update smoothed ATR once we have enough samples
    s.smoothedAtr = this.recomputeSmoothed(s.candles);
    // MARKET BASELINE shadow telemetry (Aug 21 2026, Karo) — record
    // this candle-close's ATR into the rolling history (see
    // ATRState.atrHistory's doc comment for why it's recorded here,
    // not re-derived later).
    if (s.smoothedAtr !== null) {
      s.atrHistory.push(s.smoothedAtr);
      if (s.atrHistory.length > HISTORY_BUFFER_SIZE) {
        s.atrHistory.shift();
      }
    }
  }

  /** Aug 21 2026, operator-requested (Karo) — MARKET BASELINE shadow
   *  telemetry. Rolling MEDIAN of the ATR(14) history recorded across
   *  recent candle closes (up to HISTORY_BUFFER_SIZE = 100 candles).
   *  Returns null if fewer than 5 recorded values exist yet. */
  getRollingMedianATR(symbol: string, interval: KlineInterval): number | null {
    const key = this.keyFor(symbol, interval);
    const s = this.state.get(key);
    if (!s || s.atrHistory.length < 5) return null;
    const sorted = [...s.atrHistory].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  /**
   * Returns ATR(14) for the (symbol, interval) pair, or null if buffer
   * doesn't have the minimum candle count for hybrid-warmup mode.
   *
   *   < APPROXIMATE_MIN_CANDLES (4) → null
   *   4..14 candles  → simple average of true-range over available candles
   *   ≥15 candles    → Wilder's smoothed ATR (delegated to utils/indicators.atr)
   *
   * Phase 1 (May 2026): the boundary moved from 14 → 15 because true Wilder
   * smoothing requires period+1 candles (TR_t needs candles[t] AND
   * candles[t-1].close). At exactly 14 candles we fall back to the simple
   * average path; at 15+ we get correct Wilder smoothing over the full
   * buffer history.
   */
  getATR(symbol: string, interval: KlineInterval): number | null {
    const key = this.keyFor(symbol, interval);
    const s = this.state.get(key);
    if (!s || s.candles.length < APPROXIMATE_MIN_CANDLES) return null;

    if (s.candles.length >= ATR_PERIOD + 1) {
      return s.smoothedAtr;
    }

    // Approximate path: simple mean of available true ranges
    return this.simpleAtr(s.candles);
  }

  /**
   * Returns the high / low across `lookbackCandles` candles immediately
   * BEFORE timestamp `beforeMs`. Used to find the pre-cascade range for
   * target placement in sweep structure builder.
   *
   * Returns null if fewer than 1 candle exists in the window.
   */
  rangeBefore(
    symbol: string,
    beforeMs: number,
    lookbackCandles: number,
    interval: KlineInterval,
  ): { high: number; low: number; candleCount: number } | null {
    const key = this.keyFor(symbol, interval);
    const s = this.state.get(key);
    if (!s || s.candles.length === 0) return null;

    // Find candles whose closeTime <= beforeMs, take the most recent N
    const eligible = s.candles.filter((c) => c.closeTime <= beforeMs);
    if (eligible.length === 0) return null;

    const slice = eligible.slice(-lookbackCandles);
    let high = -Infinity;
    let low = Infinity;
    for (const c of slice) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
    }
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
    return { high, low, candleCount: slice.length };
  }

  /**
   * Patch P (May 2026) — 15m trend classification.
   *
   * Compares the current 15m close to the close TREND_15M_LOOKBACK (=6)
   * candles ago, giving a 1.5h close-to-close slope.
   * Returns:
   *   BULLISH  — change > +0.25%
   *   BEARISH  — change < -0.25%
   *   NEUTRAL  — change in ±0.25% band
   *   null     — fewer than TREND_15M_MIN_CANDLES (4) closed 15m candles
   *
   * Used by paper-signal.service to skip counter-trend signals: a SHORT
   * fade into a BULLISH 15m trend is blocked, and a LONG fade into a
   * BEARISH 15m trend is blocked. NEUTRAL or null does NOT block —
   * graceful degradation when 15m data is unavailable so that counter-
   * trend signals are only blocked when we actually have evidence of a
   * trend, never blocked due to absence of data.
   *
   * Rationale for moving from 1h to 15m: liquidation cascades resolve
   * in 5–10 minutes. The previous 1h × 6 = 6h slope reflected a horizon
   * far longer than the trade itself and frequently classified as
   * NEUTRAL during clear intraday trends, letting the counter-trade
   * fade fire into the prevailing direction. The 15m × 6 = 1.5h slope
   * is the right horizon for fast liquidation trades.
   */
  getTrend15m(symbol: string): {
    trend: Trend15m;
    pctChange: number | null;
    candleCount: number;
  } {
    const key = this.keyFor(symbol, "15m");
    const s = this.state.get(key);
    if (!s || s.candles.length < TREND_15M_MIN_CANDLES) {
      return {
        trend: null,
        pctChange: null,
        candleCount: s?.candles.length ?? 0,
      };
    }

    // Use the last min(lookback, available) candles
    const slice = s.candles.slice(-TREND_15M_LOOKBACK);
    const oldClose = slice[0]!.close;
    const newClose = slice[slice.length - 1]!.close;
    if (!(oldClose > 0)) {
      return { trend: null, pctChange: null, candleCount: slice.length };
    }
    const pctChange = (newClose - oldClose) / oldClose;
    let trend: Trend15m;
    if (Math.abs(pctChange) < TREND_15M_NEUTRAL_BAND_PCT) {
      trend = "NEUTRAL";
    } else if (pctChange > 0) {
      trend = "BULLISH";
    } else {
      trend = "BEARISH";
    }
    return { trend, pctChange, candleCount: slice.length };
  }

  /**
   * Patch C-hybrid — return the most recent 1m candle that closed at or after
   * the given timestamp. Used by paper-signal.service for "1m candle close
   * past reclaim level" confirmation.
   *
   * Returns null if no closed 1m candle exists with closeTime >= afterMs.
   */
  lastClosedCandleAfter(
    symbol: string,
    afterMs: number,
    interval: KlineInterval,
  ): Candle | null {
    const key = this.keyFor(symbol, interval);
    const s = this.state.get(key);
    if (!s || s.candles.length === 0) return null;
    // Walk backwards — most recent closes are at the end
    for (let i = s.candles.length - 1; i >= 0; i -= 1) {
      const c = s.candles[i]!;
      if (c.closeTime < afterMs) break; // older candles, no use scanning further
      // We want the *first* one we hit (most recent that closed after afterMs)
      return c;
    }
    return null;
  }

  /** Diagnostic: how many candles for a given pair. */
  candleCount(symbol: string, interval: KlineInterval): number {
    const key = this.keyFor(symbol, interval);
    return this.state.get(key)?.candles.length ?? 0;
  }

  /**
   * Patch C-quality — return the most recent N CLOSED candles for a given
   * (symbol, interval), oldest-first. Empty array if cold buffer or fewer
   * than N candles available.
   *
   * Used by paper-signal.service for volume averaging in the Quality
   * Confirmation Gate: we average the volume of the prior N candles to
   * compare against the volume of the candle that confirmed reclaim.
   */
  recentClosedCandles(
    symbol: string,
    interval: KlineInterval,
    count: number,
  ): Candle[] {
    if (count <= 0) return [];
    const key = this.keyFor(symbol, interval);
    const s = this.state.get(key);
    if (!s || s.candles.length < count) return [];
    return s.candles.slice(-count);
  }

  // ── Internals ─────────────────────────────────────────────────────

  /** True-range = max(high-low, |high - prevClose|, |low - prevClose|).
   *  For the first candle there's no prev close → use high-low only. */
  private trueRange(c: Candle, prevClose: number | null): number {
    const hl = c.high - c.low;
    if (prevClose === null) return hl;
    const hpc = Math.abs(c.high - prevClose);
    const lpc = Math.abs(c.low - prevClose);
    return Math.max(hl, hpc, lpc);
  }

  /** Simple-average ATR for 4..13 candles. Used during hybrid warmup. */
  private simpleAtr(candles: Candle[]): number {
    let sum = 0;
    let prevClose: number | null = null;
    for (const c of candles) {
      sum += this.trueRange(c, prevClose);
      prevClose = c.close;
    }
    return sum / candles.length;
  }

  /**
   * Wilder's smoothed ATR over the full candle buffer. Delegates to
   * utils/indicators.atr which implements the canonical formula:
   *   - Seed = SMA of first ATR_PERIOD true ranges
   *   - Smooth = ATR_t = (ATR_{t-1} × (period-1) + TR_t) / period
   *
   * Phase 1 (May 2026): replaced an incorrect implementation that computed
   * SMA-of-TR over the LAST 14 candles only (no smoothing — comment in
   * old code acknowledged "Apply for any candles AFTER the initial 14-window
   * (none in this branch since we always take the last 14)"). True Wilder
   * uses the entire history, weighting recent TR less than a rolling SMA
   * does. Expect slightly different (typically smoother / lower-magnitude)
   * ATR values during volatility spikes; SL buffer (atr × 0.25) and target
   * fallback (atr × 1.5) shift accordingly. Recalibration of those
   * coefficients may be warranted after observation; tracked in Phase 1
   * validation plan.
   *
   * Returns null when buffer < ATR_PERIOD + 1 (utils.atr's invariant —
   * needs prevClose for the first TR).
   */
  private recomputeSmoothed(candles: Candle[]): number | null {
    if (candles.length < ATR_PERIOD + 1) return null;
    const v = wilderAtr(candles, ATR_PERIOD);
    return v > 0 ? v : null;
  }

  private isTracked(interval: KlineInterval): boolean {
    // Patch A: 1h for trend filter.
    // Patch C-quality: 5m for reclaim quality confirmation (close + body + volume).
    // 15m for swing range; 5m for ATR/structure (existing).
    // Sep 8 2026 (Karo), operator-designed minimal-cascade model --
    // "1m" ADDED. Used ONLY as the new UNIT/structural-ruler for
    // liquidation-wave recovery/completion detection (see
    // V5WatchState.unitAtStart's own doc comment) -- completely
    // separate from the EXISTING 5m/15m/1h usage (ATR15m still sizes
    // the trade-plan's own TP/SL, unchanged).
    return (
      interval === "5m" ||
      interval === "15m" ||
      interval === "1h" ||
      interval === "1m"
    );
  }

  private keyFor(symbol: string, interval: KlineInterval): string {
    return `${symbol}|${interval}`;
  }
}
