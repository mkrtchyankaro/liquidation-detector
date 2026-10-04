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
/** maxWidth (ATR, optional): a zone never grows taller than that -- without it, close points chain into one zone
 *  however tall (SUI Oct 4: a 35% "zone" made of a whole range) */
export function zones(
  ps: readonly Pivot[],
  atr: number,
  tol = 0.5,
  minPivots = 2,
  maxWidth = Infinity,
): Zone[] {
  const sorted = [...ps].sort((a, b) => a.body - b.body),
    groups: Pivot[][] = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    if (
      g &&
      p.body - g[g.length - 1].body <= tol * atr &&
      p.body - g[0].body <= maxWidth * atr
    )
      g.push(p);
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

/**
 * SUPPLY / DEMAND ZONES (the standard method, Oct 4 2026 -- agreed with Johnny):
 *   leg-out  1..3 decisive candles of one colour in a row (body more than half the range) whose bodies add up to
 *            at least 1 ATR (the ATR before the leg) -- a drop made of a few candles counts, not only one big candle
 *   base     the 1..maxBase candles right before it whose body is at most half their range (indecision); none ->
 *            the one candle before the leg-out
 *   supply (a strong drop out of the base):  top = the base's highest wick (distal), bottom = its lowest body (proximal)
 *   demand (a strong rise out of the base):  bottom = the lowest wick (distal), top = the highest body (proximal)
 *   a zone is BROKEN when a later candle closes beyond its distal line (above a supply's top / below a demand's bottom)
 * Each zone is known only once its leg-out candle closed (no look-ahead).
 */
export interface SDZone {
  kind: "SUPPLY" | "DEMAND";
  lo: number;
  hi: number;
  t: number;
  baseN: number;
  legT: number;
  brokenT: number | null;
  touches: number;
}

export function sdZones(
  c: readonly ZCandle[],
  opts: { n?: number; maxBase?: number; maxLeg?: number; from?: number } = {},
): SDZone[] {
  const n = opts.n ?? 14,
    maxBase = opts.maxBase ?? 5,
    maxLeg = opts.maxLeg ?? 3,
    from = opts.from ?? -Infinity;
  const atr = atrSeries(c, n),
    out: SDZone[] = [];
  const body = (x: ZCandle): number => Math.abs(x.close - x.open),
    range = (x: ZCandle): number => x.high - x.low;
  const small = (x: ZCandle): boolean =>
    range(x) > 0 && body(x) <= 0.5 * range(x);
  const decisive = (x: ZCandle): boolean =>
    range(x) > 0 && body(x) > 0.5 * range(x);
  const red = (x: ZCandle): boolean => x.close < x.open;
  for (let i = 1; i < c.length; i++) {
    // the leg-out STARTS at i: a decisive candle right after a non-decisive one or one of the other colour
    const x = c[i];
    if (x.t < from || !decisive(x) || !(atr[i - 1] > 0)) continue;
    if (decisive(c[i - 1]) && red(c[i - 1]) === red(x)) continue;
    // the leg: up to maxLeg decisive candles of the same colour in a row; it counts once their bodies add up to 1 ATR
    let e = i,
      moved = body(x);
    while (
      moved < atr[i - 1] &&
      e + 1 < c.length &&
      e + 1 - i < maxLeg &&
      decisive(c[e + 1]) &&
      red(c[e + 1]) === red(x)
    ) {
      e++;
      moved += body(c[e]);
    }
    if (moved < atr[i - 1]) continue;
    let s = i;
    while (s - 1 >= 0 && i - (s - 1) <= maxBase && small(c[s - 1])) s--;
    const base = s < i ? c.slice(s, i) : [c[i - 1]];
    const down = red(x);
    const z: SDZone = down
      ? {
          kind: "SUPPLY",
          lo: Math.min(...base.map((b) => Math.min(b.open, b.close))),
          hi: Math.max(...base.map((b) => b.high)),
          t: base[0].t,
          baseN: base.length,
          legT: c[e].t,
          brokenT: null,
          touches: 0,
        }
      : {
          kind: "DEMAND",
          lo: Math.min(...base.map((b) => b.low)),
          hi: Math.max(...base.map((b) => Math.max(b.open, b.close))),
          t: base[0].t,
          baseN: base.length,
          legT: c[e].t,
          brokenT: null,
          touches: 0,
        };
    // known once the leg's last candle closed: breaks and touches are counted after it
    const i0 = e;
    let inside = false;
    for (let j = i0 + 1; j < c.length; j++) {
      const y = c[j];
      if (z.kind === "SUPPLY" ? y.close > z.hi : y.close < z.lo) {
        z.brokenT = y.t;
        break;
      }
      const touch = z.kind === "SUPPLY" ? y.high >= z.lo : y.low <= z.hi;
      if (touch && !inside) z.touches++;
      inside = touch;
    }
    out.push(z);
  }
  return out;
}

/** how far the price went away from the zone after each of its touches (in ATR), until -- after fully leaving the
 *  zone -- it came back into it (or the data ended) */
export function reactions(
  c: readonly ZCandle[],
  z: Zone,
  atr: number,
): number[] {
  return z.pivots.map((p) => {
    let far = 0,
      left = false;
    for (let j = p.i + 1; j < c.length; j++) {
      const x = c[j];
      if (p.kind === "TOP") {
        far = Math.max(far, z.lo - x.low);
        if (x.high < z.lo) left = true;
        else if (left) break;
      } else {
        far = Math.max(far, x.high - z.hi);
        if (x.low > z.hi) left = true;
        else if (left) break;
      }
    }
    return far / atr;
  });
}

export interface ZoneQuality {
  res: number;
  sup: number;
  resD: number;
  supD: number;
  react: number;
  width: number;
  life: number;
  score: number;
}
/** the measured quality of a zone (src/tools/zone-scan.ts) */
export function zoneQuality(
  c: readonly ZCandle[],
  z: Zone,
  atr: number,
): ZoneQuality {
  const DAY = 86_400_000,
    tops = z.pivots.filter((p) => p.kind === "TOP"),
    bots = z.pivots.filter((p) => p.kind === "BOTTOM");
  const span = (l: Pivot[]): number =>
    l.length > 1 ? (l[l.length - 1].t - l[0].t) / DAY : 0;
  const r = [...reactions(c, z, atr)].sort((a, b) => a - b),
    react = r.length ? r[Math.floor(r.length / 2)] : NaN;
  return {
    res: tops.length,
    sup: bots.length,
    resD: span(tops),
    supD: span(bots),
    react,
    width: (z.hi - z.lo) / atr,
    life: (z.lastT - z.pivots[0].t) / DAY,
    score: react * Math.min(tops.length, bots.length),
  };
}

/** the main zone the way src/tools/zones.ts picks it: the zone touched last that has 3+ points */
export function mainZone(
  c: readonly ZCandle[],
  tol = 0.8,
  maxWidth = 2 * tol,
): { z: Zone; atr: number } | null {
  if (c.length < 30) return null;
  const a = atrSeries(c, 14),
    atr = a[a.length - 1];
  const zs = zones(pivots(c, 1, 14), atr, tol, 2, maxWidth);
  const z = zs
    .filter((x) => x.pivots.length >= 3)
    .sort((x, y) => y.lastT - x.lastT)[0];
  return z ? { z, atr } : null;
}
