import type { Candle } from './common.types';

/**
 * Exponential moving average over a price series.
 *
 * Returns an array of the same length as input. The first `period - 1`
 * values are padded with the SMA of the first `period` samples (i.e. we don't
 * return NaN for the warmup region — callers can read values[values.length - 1]
 * unconditionally once `values.length >= period`).
 *
 * k = 2 / (period + 1), EMA_t = close_t * k + EMA_{t-1} * (1 - k)
 */
export function ema(values: readonly number[], period: number): number[] {
  const n = values.length;
  if (n === 0 || period <= 0) return [];
  const out = new Array<number>(n);
  const k = 2 / (period + 1);

  if (n < period) {
    // Degenerate: fall back to running SMA so the last value is still meaningful.
    let acc = 0;
    for (let i = 0; i < n; i += 1) {
      acc += values[i]!;
      out[i] = acc / (i + 1);
    }
    return out;
  }

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i]!;
  const sma = sum / period;
  for (let i = 0; i < period; i += 1) out[i] = sma;

  // Roll EMA forward
  for (let i = period; i < n; i += 1) {
    out[i] = values[i]! * k + out[i - 1]! * (1 - k);
  }
  return out;
}

/**
 * Wilder-style ATR over the provided candles.
 * `period` is typically 14. Returns 0 if insufficient data.
 */
export function atr(candles: readonly Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  // True Range series
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const hl = c.high - c.low;
    const hc = Math.abs(c.high - prev.close);
    const lc = Math.abs(c.low - prev.close);
    trs.push(Math.max(hl, hc, lc));
  }
  // Wilder smoothing: seed with SMA of first `period`, then roll.
  let atrValue = 0;
  for (let i = 0; i < period; i++) atrValue += trs[i]!;
  atrValue /= period;
  for (let i = period; i < trs.length; i++) {
    atrValue = (atrValue * (period - 1) + trs[i]!) / period;
  }
  return atrValue;
}

/**
 * Mean of candle quote volume over last `lookback` closed candles.
 */
export function avgQuoteVolume(candles: readonly Candle[], lookback = 20): number {
  if (candles.length === 0) return 0;
  const slice = candles.slice(-lookback);
  let sum = 0;
  for (const c of slice) sum += c.quoteVolume;
  return sum / slice.length;
}

/**
 * Ratio of candle body to total range. 0 for doji, 1 for marubozu.
 */
export function bodyRatio(c: Candle): number {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return Math.abs(c.close - c.open) / range;
}

/**
 * For a bullish candle: how close is the close to the high?
 * Returns 0..1 where 1 means closed exactly at the high.
 * For bearish candles: returns closeness to low.
 */
export function closeLocation(c: Candle): number {
  const range = c.high - c.low;
  if (range <= 0) return 0.5;
  const isBull = c.close >= c.open;
  return isBull ? (c.close - c.low) / range : (c.high - c.close) / range;
}

/**
 * Find the most recent pivot low in `candles`.
 * A pivot low at index i requires `left` lower bars on the left and `right` on the right.
 * Returns the low value (number) or null.
 */
export function lastPivotLow(candles: readonly Candle[], left = 2, right = 2): number | null {
  for (let i = candles.length - 1 - right; i >= left; i--) {
    const pivot = candles[i]!.low;
    let ok = true;
    for (let j = 1; j <= left; j++) {
      if (candles[i - j]!.low <= pivot) { ok = false; break; }
    }
    if (!ok) continue;
    for (let j = 1; j <= right; j++) {
      if (candles[i + j]!.low <= pivot) { ok = false; break; }
    }
    if (ok) return pivot;
  }
  return null;
}

export function lastPivotHigh(candles: readonly Candle[], left = 2, right = 2): number | null {
  for (let i = candles.length - 1 - right; i >= left; i--) {
    const pivot = candles[i]!.high;
    let ok = true;
    for (let j = 1; j <= left; j++) {
      if (candles[i - j]!.high >= pivot) { ok = false; break; }
    }
    if (!ok) continue;
    for (let j = 1; j <= right; j++) {
      if (candles[i + j]!.high >= pivot) { ok = false; break; }
    }
    if (ok) return pivot;
  }
  return null;
}

/**
 * Collect all pivot lows in `candles`, oldest to newest.
 */
export function pivotLows(candles: readonly Candle[], left = 2, right = 2): number[] {
  const out: number[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const pivot = candles[i]!.low;
    let ok = true;
    for (let j = 1; j <= left && ok; j++) if (candles[i - j]!.low <= pivot) ok = false;
    for (let j = 1; j <= right && ok; j++) if (candles[i + j]!.low <= pivot) ok = false;
    if (ok) out.push(pivot);
  }
  return out;
}

export function pivotHighs(candles: readonly Candle[], left = 2, right = 2): number[] {
  const out: number[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const pivot = candles[i]!.high;
    let ok = true;
    for (let j = 1; j <= left && ok; j++) if (candles[i - j]!.high >= pivot) ok = false;
    for (let j = 1; j <= right && ok; j++) if (candles[i + j]!.high >= pivot) ok = false;
    if (ok) out.push(pivot);
  }
  return out;
}
