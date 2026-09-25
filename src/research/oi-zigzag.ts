/**
 * OI ZIGZAG -- the Open Interest line cut into alternating waves
 * (research only, never trades). Idea agreed with Johnny, Sep 25 2026.
 *
 *   A wave ends when OI has moved back from its extreme by more than R
 *   (a % of OI, set per coin from its own normal OI movement). Smaller
 *   moves are noise and never cut a wave -- so every wave is >= R and waves
 *   strictly alternate DOWN / UP / DOWN ...
 *
 *   DOWN wave with victim liquidations and price moving against them =
 *     CLEANING (positions closed: liquidations + stops + TPs + manual)
 *   UP wave right after it = ACCUMULATION (new positions in the zone)
 *   next DOWN wave = RESOLUTION (the new positions closing)
 *
 * All sizes in COINS (OI is reported in the coin), never USD, so a price
 * change does not distort them.
 *
 * Hypothesis to test: depth = price move / coins closed in the cleaning;
 * expected move = depth x coins opened in the accumulation; compare with the
 * real price move of the resolution wave.
 */
export interface ZBar { ts: number; high: number; low: number; close: number; oi: number; longLiq: number; shortLiq: number }

export interface Pivot { idx: number; ts: number; oi: number; kind: "HIGH" | "LOW"; confirmedIdx: number; confirmedTs: number }

export type WaveKind = "LONG_CLEANING" | "SHORT_CLEANING" | "OI_DOWN" | "OI_UP";

export interface Wave {
  from: Pivot; to: Pivot; kind: WaveKind; confirmed: boolean;
  minutes: number;
  oiStart: number; oiEnd: number; coins: number;      // coins = |OI change|
  oiChangePct: number;
  priceStart: number; priceEnd: number; priceLow: number; priceHigh: number;
  longLiqUsd: number; shortLiqUsd: number;
}

/** Classic zigzag on OI with a relative reversal threshold rPct (% of OI). */
export function oiPivots(bars: readonly ZBar[], rPct: number): { pivots: Pivot[]; lastExtreme: Pivot | null } {
  const r = rPct / 100;
  const pivots: Pivot[] = [];
  const i0 = bars.findIndex((b) => b.oi > 0);
  if (i0 < 0) return { pivots, lastExtreme: null };
  let trend: 1 | -1 | 0 = 0;
  let hi = bars[i0].oi, hiIdx = i0, lo = bars[i0].oi, loIdx = i0;
  const mk = (idx: number, kind: Pivot["kind"], conf: number): Pivot => ({ idx, ts: bars[idx].ts, oi: bars[idx].oi, kind, confirmedIdx: conf, confirmedTs: bars[conf].ts });
  for (let i = i0 + 1; i < bars.length; i++) {
    const v = bars[i].oi;
    if (!(v > 0)) continue;
    if (v > hi) { hi = v; hiIdx = i; }
    if (v < lo) { lo = v; loIdx = i; }
    if (trend >= 0 && v <= hi * (1 - r) && hiIdx < i) {
      if (trend === 0 && hiIdx > i0) pivots.push(mk(i0, "LOW", i)); // the data start is the first wave's start
      pivots.push(mk(hiIdx, "HIGH", i));
      trend = -1; lo = v; loIdx = i;
    } else if (trend <= 0 && v >= lo * (1 + r) && loIdx < i) {
      if (trend === 0 && loIdx > i0) pivots.push(mk(i0, "HIGH", i));
      pivots.push(mk(loIdx, "LOW", i));
      trend = 1; hi = v; hiIdx = i;
    }
  }
  const clean = pivots;
  const last = trend === 1 ? mk(hiIdx, "HIGH", bars.length - 1) : trend === -1 ? mk(loIdx, "LOW", bars.length - 1) : null;
  return { pivots: clean, lastExtreme: last };
}

export function buildWaves(bars: readonly ZBar[], rPct: number): Wave[] {
  const { pivots, lastExtreme } = oiPivots(bars, rPct);
  const pts = lastExtreme && pivots.length && lastExtreme.idx > pivots[pivots.length - 1].idx ? [...pivots, lastExtreme] : pivots;
  const waves: Wave[] = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    let lo = Infinity, hi = -Infinity, ll = 0, sl = 0;
    for (let i = a.idx + 1; i <= b.idx; i++) { lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high); ll += bars[i].longLiq; sl += bars[i].shortLiq; }
    const down = b.oi < a.oi;
    const pStart = bars[a.idx].close, pEnd = bars[b.idx].close;
    let kind: WaveKind = down ? "OI_DOWN" : "OI_UP";
    if (down) {
      // price moved against the side that got liquidated more
      if (ll > sl && ll > 0 && lo < pStart) kind = "LONG_CLEANING";
      else if (sl > ll && sl > 0 && hi > pStart) kind = "SHORT_CLEANING";
    }
    waves.push({
      from: a, to: b, kind, confirmed: !(lastExtreme && b === lastExtreme), minutes: b.idx - a.idx,
      oiStart: a.oi, oiEnd: b.oi, coins: Math.abs(b.oi - a.oi), oiChangePct: ((b.oi - a.oi) / a.oi) * 100,
      priceStart: pStart, priceEnd: pEnd, priceLow: lo, priceHigh: hi, longLiqUsd: ll, shortLiqUsd: sl,
    });
  }
  return waves;
}

export interface Chain {
  cleaning: Wave; accumulation: Wave | null; resolution: Wave | null;
  /** price move of the cleaning (to its extreme), absolute, in quote currency */
  cleaningMove: number;
  /** price move per 1,000 coins closed */
  depthPer1k: number;
  expectedMove: number | null;
  /** resolution wave, measured from the accumulation's end price */
  actualUp: number | null; actualDown: number | null;
}

/** Cleaning -> accumulation -> resolution sequences. */
export function buildChains(waves: readonly Wave[]): Chain[] {
  const out: Chain[] = [];
  for (let k = 0; k < waves.length; k++) {
    const w = waves[k];
    if (w.kind !== "LONG_CLEANING" && w.kind !== "SHORT_CLEANING") continue;
    const cleaningMove = w.kind === "LONG_CLEANING" ? w.priceStart - w.priceLow : w.priceHigh - w.priceStart;
    const depthPer1k = w.coins > 0 ? cleaningMove / (w.coins / 1000) : NaN;
    const acc = waves[k + 1] ?? null;
    const res = waves[k + 2] ?? null;
    const expectedMove = acc ? depthPer1k * (acc.coins / 1000) : null;
    const base = acc ? acc.priceEnd : NaN;
    out.push({
      cleaning: w, accumulation: acc, resolution: res, cleaningMove, depthPer1k, expectedMove,
      actualUp: res ? Math.max(0, res.priceHigh - base) : null,
      actualDown: res ? Math.max(0, base - res.priceLow) : null,
    });
  }
  return out;
}

/** Coin's normal OI noise: median |OI change| over 15 minutes, in %. */
export function medianOi15mPct(bars: readonly ZBar[]): number {
  const v: number[] = [];
  for (let i = 15; i < bars.length; i += 5) {
    const a = bars[i - 15].oi, b = bars[i].oi;
    if (a > 0 && b > 0) v.push((Math.abs(b - a) / a) * 100);
  }
  v.sort((x, y) => x - y);
  return v.length ? v[v.length >> 1] : NaN;
}
