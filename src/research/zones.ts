/**
 * ZONES OF INTEREST ON HIGHER TIMEFRAME CANDLES (Johnny's friend, Oct 4 2026). Pure, no look-ahead.
 *
 *   1. turning points: the same 1-ATR rule as V10 -- a move ends when a close comes k x ATR(n) back from the move's
 *      extreme. The extreme is measured on the candle BODIES (Johnny: "body to body"): a top = the highest body top
 *      (max(open, close)), a bottom = the lowest body bottom (min(open, close)). The wicks are kept beside.
 *   2. zones: turning points whose body levels are close to each other (within tol x ATR, chained) form one zone;
 *      zone = [the lowest, the highest] body level of its points; the wicks around it are shown, not part of it.
 *   3. a zone with tops AND bottoms changed its role (a flip): resistance from below, then support from above (or
 *      the other way) -- the strongest kind.
 */
export interface ZCandle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface Pivot {
  kind: "TOP" | "BOTTOM";
  i: number;
  t: number;
  body: number;
  wick: number;
}
export interface Zone {
  lo: number;
  hi: number;
  wickLo: number;
  wickHi: number;
  pivots: Pivot[];
  tops: number;
  bottoms: number;
  /** UP = was resistance, now support (the latest point is a bottom, there was a top) / DOWN = the other way / null */
  flip: "UP" | "DOWN" | null;
  lastT: number;
}

export function atrSeries(c: readonly ZCandle[], n: number): number[] {
  const out: number[] = [];
  let atr = NaN;
  const seed: number[] = [];
  for (let i = 0; i < c.length; i++) {
    const p = i > 0 ? c[i - 1].close : c[i].open;
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - p),
      Math.abs(c[i].low - p),
    );
    if (Number.isFinite(atr)) atr += (tr - atr) / n;
    else {
      seed.push(tr);
      if (seed.length === n) atr = seed.reduce((a, b) => a + b, 0) / n;
    }
    out.push(atr);
  }
  return out;
}

const bodyTop = (x: ZCandle): number => Math.max(x.open, x.close);
const bodyBot = (x: ZCandle): number => Math.min(x.open, x.close);

/** the turning points (each known only when the 1-ATR close against it came) */
export function pivots(c: readonly ZCandle[], k = 1, n = 14): Pivot[] {
  const atr = atrSeries(c, n),
    out: Pivot[] = [];
  let dir: "UP" | "DOWN" | null = null,
    ext = -1;
  for (let i = 0; i < c.length; i++) {
    if (!(atr[i] > 0)) continue;
    const x = c[i];
    if (dir === null) {
      dir = x.close >= x.open ? "UP" : "DOWN";
      ext = i;
      continue;
    }
    if (
      dir === "UP"
        ? bodyTop(x) >= bodyTop(c[ext])
        : bodyBot(x) <= bodyBot(c[ext])
    )
      ext = i;
    const back =
      dir === "UP" ? bodyTop(c[ext]) - x.close : x.close - bodyBot(c[ext]);
    if (back < k * atr[i]) continue;
    const e = c[ext];
    out.push(
      dir === "UP"
        ? { kind: "TOP", i: ext, t: e.t, body: bodyTop(e), wick: e.high }
        : { kind: "BOTTOM", i: ext, t: e.t, body: bodyBot(e), wick: e.low },
    );
    dir = dir === "UP" ? "DOWN" : "UP";
    ext = i;
  }
  return out;
}

/** turning points close in price -> zones (tol in ATR: the last ATR of the data) */
export function zones(
  ps: readonly Pivot[],
  atr: number,
  tol = 0.5,
  minPivots = 2,
): Zone[] {
  const sorted = [...ps].sort((a, b) => a.body - b.body),
    groups: Pivot[][] = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    if (g && p.body - g[g.length - 1].body <= tol * atr) g.push(p);
    else groups.push([p]);
  }
  return groups
    .filter((g) => g.length >= minPivots)
    .map((g) => {
      const byT = [...g].sort((a, b) => a.t - b.t),
        last = byT[byT.length - 1];
      // UP flip: it was resistance (a top) and is now support (the latest point a bottom); DOWN: the other way
      const flip =
        last.kind === "BOTTOM" && byT.some((p) => p.kind === "TOP")
          ? "UP"
          : last.kind === "TOP" && byT.some((p) => p.kind === "BOTTOM")
            ? "DOWN"
            : null;
      return {
        lo: g[0].body,
        hi: g[g.length - 1].body,
        wickLo: Math.min(
          ...g.map((p) => (p.kind === "BOTTOM" ? p.wick : p.body)),
        ),
        wickHi: Math.max(...g.map((p) => (p.kind === "TOP" ? p.wick : p.body))),
        pivots: byT,
        tops: g.filter((p) => p.kind === "TOP").length,
        bottoms: g.filter((p) => p.kind === "BOTTOM").length,
        flip,
        lastT: byT[byT.length - 1].t,
      };
    });
}
