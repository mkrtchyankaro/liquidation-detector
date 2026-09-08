// Pure math helpers. No state. No side effects.

export function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

/**
 * Linear-interpolation percentile (type 7 / Excel-style).
 * Returns 0 for empty arrays.
 * p is in 0..100.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0]!;
  const sorted = [...values].sort((a, b) => a - b);
  const pct = clamp(p, 0, 100) / 100;
  const idx = pct * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let sq = 0;
  for (const v of values) sq += (v - m) ** 2;
  return Math.sqrt(sq / (values.length - 1));
}

export function roundTo(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

export function safeDiv(a: number, b: number, fallback = 0): number {
  if (b === 0 || !Number.isFinite(b)) return fallback;
  return a / b;
}
