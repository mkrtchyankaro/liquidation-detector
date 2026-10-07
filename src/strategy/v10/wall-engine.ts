/**
 * V10 · WALL -- the walls and the 1h exit rule (Johnny, Oct 7 2026). PURE: no I/O, no clock.
 * The SAME code runs the research test (src/tools/wall-trade-test.ts --h1) and the live bot (v10-live.service.ts), so
 * the live signals are exactly the tested ones.
 *
 * THE FIELD at time t: back from t on CLOSED 4h candles while their closes stay inside K x the daily ATR(14) (daily
 *   candles closed before t), at most MAX_FIELD_DAYS -- the price range the market is in now; older history is another
 *   market and is not used.
 * THE WALLS at t, from the field's CLOSED 15m candles and our liquidations (liq_raw_events) before t, in price bands of
 *   BIN x the 4h ATR(14):
 *   the MODE   = the band where the 15m closes spent the most time
 *   LOWER wall = below the mode: the band with the most LONGS liquidated, widened to its neighbours while they hold
 *                >= 2/3 of that (never into the mode band)
 *   UPPER wall = above the mode: the same with SHORTS liquidated
 * THE RULE, once per CLOSED 1h candle (built from its four 15m candles; the walls are those known at the hour's START):
 *   a 1h candle touches a wall -> later a 1h candle closes outside it on the room side:
 *     WICK = the whole candle outside (the live rule) · BODY = open and close outside (tested, weaker)
 *   -> back into the room: from the upper wall SHORT, from the lower wall LONG, at that close
 *     stop = the far edge of that wall · take profit = tpPct % from the entry
 *     no trade if the TP lies beyond the other wall's far edge, or if (entry -> the other wall's far edge) is less than
 *     roomRatio x (entry -> stop), or if the stop is more than maxStopPct % away
 *   a wall "touched" is forgotten when the walls change, after a skip on that side, and after a trade on the coin.
 */

export interface WCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}
export interface WLiq {
  t: number;
  long: boolean;
  usd: number;
  p: number;
}
export interface Wall {
  lo: number;
  hi: number;
}
export interface Walls {
  lower: Wall | null;
  upper: Wall | null;
  mode: number;
  fs: number;
}
export interface WallData {
  d1: readonly WCandle[];
  h4: readonly WCandle[];
  q15: readonly WCandle[];
  liqs: readonly WLiq[];
}

export const WALL_K = 2.5;
export const WALL_BIN = 0.25;
export const MAX_FIELD_DAYS = 30;
export const H = 3_600_000;
export const D = 24 * H;
export const Q15 = 15 * 60_000;

export const firstIdx = (arr: readonly { t: number }[], t: number): number => {
  let a = 0,
    b = arr.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (arr[m].t < t) a = m + 1;
    else b = m;
  }
  return a;
};
export const atrOf = (k: readonly WCandle[], n = 14): number => {
  let s = 0,
    c = 0;
  for (let i = Math.max(1, k.length - n); i < k.length; i++) {
    s += Math.max(
      k[i].h - k[i].l,
      Math.abs(k[i].h - k[i - 1].c),
      Math.abs(k[i].l - k[i - 1].c),
    );
    c++;
  }
  return c ? s / c : NaN;
};

/** the walls known at t (only candles closed by t and liquidations before t); null = not enough data */
export function wallsAt(data: WallData, t: number): Walls | null {
  const { d1, h4, q15: q, liqs } = data;
  const dd = d1.filter((x) => x.t + D <= t).slice(-15),
    hh = h4.filter((x) => x.t + 4 * H <= t);
  if (dd.length < 15 || hh.length < 15) return null;
  const atrD = atrOf(dd),
    atr4 = atrOf(hh.slice(-15)),
    w = WALL_BIN * atr4;
  if (!(w > 0)) return null;
  let lo = Infinity,
    hi = -Infinity,
    i = hh.length - 1;
  for (; i >= 0 && hh[i].t >= t - MAX_FIELD_DAYS * D; i--) {
    const nlo = Math.min(lo, hh[i].c),
      nhi = Math.max(hi, hh[i].c);
    if (nhi - nlo > WALL_K * atrD) break;
    lo = nlo;
    hi = nhi;
  }
  const fs = hh[Math.min(hh.length - 1, i + 1)].t;
  const time = new Map<number, number>(),
    lL = new Map<number, number>(),
    lS = new Map<number, number>();
  for (let j = firstIdx(q, fs); j < q.length && q[j].t + Q15 <= t; j++) {
    const b = Math.floor(q[j].c / w);
    time.set(b, (time.get(b) ?? 0) + 1);
  }
  for (let j = firstIdx(liqs, fs); j < liqs.length && liqs[j].t < t; j++) {
    const b = Math.floor(liqs[j].p / w),
      m = liqs[j].long ? lL : lS;
    m.set(b, (m.get(b) ?? 0) + liqs[j].usd);
  }
  if (!time.size) return null;
  let mode = 0,
    mt = -1;
  for (const [b, v] of time)
    if (v > mt) {
      mt = v;
      mode = b;
    }
  const grow = (m: Map<number, number>, below: boolean): Wall | null => {
    let pk = NaN,
      pv = 0;
    for (const [b, v] of m)
      if ((below ? b < mode : b > mode) && v > pv) {
        pv = v;
        pk = b;
      }
    if (!(pv > 0)) return null;
    let a = pk,
      z = pk;
    while ((m.get(a - 1) ?? 0) >= (2 / 3) * pv && (below || a - 1 > mode)) a--;
    while ((m.get(z + 1) ?? 0) >= (2 / 3) * pv && (!below || z + 1 < mode)) z++;
    return { lo: a * w, hi: (z + 1) * w };
  };
  return { lower: grow(lL, true), upper: grow(lS, false), mode: mode * w, fs };
}

/** the 1h candle that STARTS at hs, from its four 15m candles; null when one of them is missing */
export function hourCandle(
  q15: readonly WCandle[],
  hs: number,
): WCandle | null {
  const k0 = firstIdx(q15, hs);
  const four = q15.slice(k0, k0 + 4);
  if (four.length < 4 || four[0].t !== hs || four[3].t !== hs + 3 * Q15)
    return null;
  return {
    t: hs,
    o: four[0].o,
    h: Math.max(...four.map((y) => y.h)),
    l: Math.min(...four.map((y) => y.l)),
    c: four[3].c,
  };
}

export interface WallParams {
  kind: "WICK" | "BODY";
  tpPct: number;
  roomRatio: number;
  maxStopPct: number;
  /** research (Oct 7): the TP at this many times the SL distance instead of tpPct (absent = tpPct, the live rule) */
  tpR?: number;
}
export interface WallSignal {
  side: "LONG" | "SHORT";
  /** the 1h candle that closed outside the wall: its start / close time and close price (= the entry) */
  hs: number;
  candleEnd: number;
  entry: number;
  stop: number;
  tp: number;
  riskPct: number;
  /** entry -> the other wall's far edge, in multiples of entry -> stop */
  roomX: number;
  /** when the price first touched this wall (since the last reset) */
  touchedAt: number;
  walls: { lower: Wall; upper: Wall; mode: number; fs: number };
}
export interface WallSkip {
  side: "LONG" | "SHORT";
  why: "TP_BEYOND_WALL" | "ROOM";
  detail: string;
}
export interface WallStep {
  signal: WallSignal | null;
  skips: WallSkip[];
}

const wallKey = (W: Walls): string =>
  `${W.lower?.lo}|${W.lower?.hi}|${W.upper?.lo}|${W.upper?.hi}`;

/** one coin's touch memory. step() once per closed 1h candle while no trade is open on the coin; reset() after a trade. */
export class WallTracker {
  touched = { lower: false, upper: false };
  since = { lower: NaN, upper: NaN };
  prevKey = "";

  reset(): void {
    this.touched = { lower: false, upper: false };
    this.since = { lower: NaN, upper: NaN };
  }

  step(c: WCandle, W: Walls | null, p: WallParams): WallStep {
    const out: WallStep = { signal: null, skips: [] };
    if (!W || !W.lower || !W.upper) return out;
    const key = wallKey(W);
    if (key !== this.prevKey) {
      this.reset();
      this.prevKey = key;
    }
    const lw = W.lower,
      uw = W.upper,
      hs = c.t;
    const inU = c.h >= uw.lo && c.l <= uw.hi,
      inL = c.l <= lw.hi && c.h >= lw.lo;
    const outU =
      p.kind === "BODY"
        ? Math.max(c.o, c.c) < uw.lo && (this.touched.upper || inU)
        : c.h < uw.lo && this.touched.upper;
    const outL =
      p.kind === "BODY"
        ? Math.min(c.o, c.c) > lw.hi && (this.touched.lower || inL)
        : c.l > lw.hi && this.touched.lower;
    if (inU && !this.touched.upper) {
      this.touched.upper = true;
      this.since.upper = hs;
    }
    if (inL && !this.touched.lower) {
      this.touched.lower = true;
      this.since.lower = hs;
    }
    for (const short of [true, false]) {
      if (short ? !outU : !outL) continue;
      const side = short ? "upper" : "lower";
      const entry = c.c,
        stop = short ? uw.hi : lw.lo;
      const tp =
        p.tpR !== undefined
          ? short
            ? entry - p.tpR * (stop - entry)
            : entry + p.tpR * (entry - stop)
          : short
            ? entry * (1 - p.tpPct / 100)
            : entry * (1 + p.tpPct / 100);
      const riskPct = (100 * Math.abs(stop - entry)) / entry;
      const drop = (): void => {
        this.touched[side] = false;
        this.since[side] = NaN;
      };
      const dir = short ? "SHORT" : "LONG";
      if (short ? tp < lw.lo : tp > uw.hi) {
        drop();
        out.skips.push({
          side: dir,
          why: "TP_BEYOND_WALL",
          detail: `TP ${+tp.toPrecision(6)} beyond the ${short ? "lower wall's bottom" : "upper wall's top"} ${+(short ? lw.lo : uw.hi).toPrecision(6)}`,
        });
        continue;
      }
      const roomDist = short ? entry - lw.lo : uw.hi - entry,
        roomX = roomDist / Math.abs(stop - entry);
      if (
        riskPct > p.maxStopPct ||
        roomDist < p.roomRatio * Math.abs(stop - entry)
      ) {
        drop();
        out.skips.push({
          side: dir,
          why: "ROOM",
          detail: `room ${roomX.toFixed(2)}x the stop (needs ${p.roomRatio}x), stop ${riskPct.toFixed(2)}%${riskPct > p.maxStopPct ? ` > ${p.maxStopPct}%` : ""}`,
        });
        continue;
      }
      out.signal = {
        side: dir,
        hs,
        candleEnd: hs + H,
        entry,
        stop,
        tp,
        riskPct,
        roomX,
        touchedAt: Number.isFinite(this.since[side]) ? this.since[side] : hs,
        walls: { lower: lw, upper: uw, mode: W.mode, fs: W.fs },
      };
      break;
    }
    return out;
  }
}
