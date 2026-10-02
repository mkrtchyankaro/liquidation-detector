/**
 * ON WHICH CANDLES DOES A COIN FOLLOW BTC? (Johnny, Oct 2 2026) Pure.
 * 1-minute closes are grouped into tf-minute candles (close = the last minute's close). For each tf:
 *   x BTC   BTC's candle +1% -> the coin's candle +x% (slope of coin returns on BTC returns)
 *   R2      how much of the coin's candle moves BTC explains (1 = only follows BTC)
 *   lag     the same with the coin ONE candle later than BTC (does the coin follow with a delay?)
 * No thresholds.
 */
export interface Close { t: number; close: number }
export interface TfStat { tf: number; n: number; beta: number; r2: number; lagBeta: number; lagR2: number }

/** tf-minute bucket start -> last close in it */
export function resample(bars: readonly Close[], tfMin: number): Map<number, number> {
  const w = tfMin * 60_000, out = new Map<number, number>();
  for (const b of [...bars].sort((a, z) => a.t - z.t)) if (b.close > 0) out.set(Math.floor(b.t / w) * w, b.close);
  return out;
}

function fit(x: number[], y: number[]): { beta: number; r2: number } {
  const n = x.length;
  if (n < 3) return { beta: NaN, r2: NaN };
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  if (!(sxx > 0) || !(syy > 0)) return { beta: NaN, r2: NaN };
  return { beta: sxy / sxx, r2: (sxy * sxy) / (sxx * syy) };
}

/** coin vs BTC on tf-minute candles; only candles that both have, back to back */
export function tfStat(coin: readonly Close[], btc: readonly Close[], tfMin: number): TfStat {
  const w = tfMin * 60_000, c = resample(coin, tfMin), b = resample(btc, tfMin);
  const keys = [...c.keys()].filter((k) => b.has(k)).sort((a, z) => a - z);
  const ret = new Map<number, { c: number; b: number }>();
  for (const k of keys) if (c.has(k - w) && b.has(k - w)) ret.set(k, { c: c.get(k)! / c.get(k - w)! - 1, b: b.get(k)! / b.get(k - w)! - 1 });
  const x0: number[] = [], y0: number[] = [], x1: number[] = [], y1: number[] = [];
  for (const [k, r] of ret) {
    x0.push(r.b); y0.push(r.c);
    const prev = ret.get(k - w);
    if (prev) { x1.push(prev.b); y1.push(r.c); } // coin this candle vs BTC the candle before
  }
  const f0 = fit(x0, y0), f1 = fit(x1, y1);
  return { tf: tfMin, n: x0.length, beta: f0.beta, r2: f0.r2, lagBeta: f1.beta, lagR2: f1.r2 };
}

/** the timeframe where BTC explains the coin best (only tfs with at least `minN` candles) */
export function bestTf(stats: readonly TfStat[], minN: number): TfStat | null {
  const ok = stats.filter((s) => s.n >= minN && Number.isFinite(s.r2));
  return ok.length ? ok.reduce((a, s) => (s.r2 > a.r2 ? s : a)) : null;
}
