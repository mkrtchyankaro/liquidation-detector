/**
 * OI FLOWS (Johnny, Oct 2 2026). Pure, no DB, live-safe.
 *
 * Inside one candle OI can both come in and go out (+8M then -7M = net +1M hides the -7M). So nothing here uses
 * a candle's net change: every MINUTE's OI change is split into
 *   IN  = OI that came in  (minute rises, new positions)
 *   OUT = OI that went out (minute falls, closes / liquidations)
 * and per `tf`-minute window both are summed. Two ATRs (Wilder, `n` windows, only windows finished BEFORE now):
 *   up-ATR   = normal IN  per window
 *   down-ATR = normal OUT per window
 * Every window feeds both.
 *
 * Legs come from the minute OI path (no candles): a leg ends when OI comes back from its extreme by `rev` normal
 * windows of the other kind (rise -> up-ATR, fall -> down-ATR). Sizes are GROSS flows in ATRs:
 *   rising leg  : IN  inside it / up-ATR    ("how many normal windows of new positions")
 *   falling leg : OUT inside it / down-ATR  ("how many normal windows of closing")
 *
 * Signal = the minute a falling leg is first known (OI fell `rev` down-ATRs from the peak of a rising leg),
 * with one side liquidated more since that peak. Trade WITH the move: longs liquidated -> SHORT (the rest of the
 * longs are next), shorts liquidated -> LONG. SL at the price extreme since the peak (min `minSlPct`).
 *   CONT = every such signal (Johnny's 2nd idea: accumulation -> liquidation -> it continues)
 *   REV  = only when the falling leg BEFORE the rise liquidated the OTHER side (the V9 3-phase story)
 */

export interface FlowMinute {
  t: number;
  oi: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  longLiq: number;
  shortLiq: number;
}
export type Side = "LONG" | "SHORT";
export type Prior = "OTHER_SIDE" | "SAME_SIDE" | "NO_LIQ" | "NONE";
export interface FlowSignal {
  symbol: string;
  t: number;
  side: Side;
  entry: number;
  sl: number;
  slPct: number;
  accStart: number;
  peak: number;
  accIn: number;
  accNet: number;
  accMinutes: number; // rising leg: gross IN / up-ATR, net rise / up-ATR
  prior: Prior;
  priorOut: number; // the falling leg before the rise (gross OUT / down-ATR)
  dropOut: number;
  victim: Side; // since the peak: gross OUT / down-ATR, who was liquidated
}
export interface FlowOpts {
  tf: number;
  n: number;
  rev: number;
  minSlPct: number;
  maxGapMin: number;
}
export const DEFAULT_FLOW_OPTS: FlowOpts = {
  tf: 5,
  n: 14,
  rev: 1,
  minSlPct: 0.33,
  maxGapMin: 15,
};

const MIN = 60_000;

interface Pt {
  t: number;
  oi: number;
  inF: number;
  outF: number;
  high: number;
  low: number;
  close: number;
  longLiq: number;
  shortLiq: number;
  up: number;
  down: number;
}

/** minute rows -> points with IN/OUT of that minute and the ATRs known before it */
export function flowPoints(
  rows: readonly FlowMinute[],
  tf: number,
  n: number,
): Pt[] {
  const out: Pt[] = [];
  const w = tf * MIN;
  const atr = {
    up: { v: NaN, seed: [] as number[] },
    down: { v: NaN, seed: [] as number[] },
  };
  const feed = (s: { v: number; seed: number[] }, x: number): void => {
    if (Number.isFinite(s.v)) {
      s.v += (x - s.v) / n;
      return;
    }
    s.seed.push(x);
    if (s.seed.length === n) s.v = s.seed.reduce((a, y) => a + y, 0) / n;
  };
  let win = -1,
    wIn = 0,
    wOut = 0,
    prev: { t: number; oi: number } | null = null;
  for (const r of [...rows].sort((a, b) => a.t - b.t)) {
    if (!(r.oi! > 0 && r.close! > 0 && r.high! > 0 && r.low! > 0)) continue;
    const k = Math.floor(r.t / w);
    if (k !== win) {
      if (win >= 0 && k === win + 1) {
        feed(atr.up, wIn);
        feed(atr.down, wOut);
      } // only whole, back-to-back windows
      win = k;
      wIn = 0;
      wOut = 0;
    }
    const contiguous = prev !== null && r.t - prev.t === MIN;
    const d = contiguous ? r.oi! - prev!.oi : 0;
    const inF = d > 0 ? d : 0,
      outF = d < 0 ? -d : 0;
    out.push({
      t: r.t,
      oi: r.oi!,
      inF,
      outF,
      high: r.high!,
      low: r.low!,
      close: r.close!,
      longLiq: r.longLiq,
      shortLiq: r.shortLiq,
      up: atr.up.v,
      down: atr.down.v,
    });
    wIn += inF;
    wOut += outF;
    prev = { t: r.t, oi: r.oi! };
  }
  return out;
}

const sum = (
  p: readonly Pt[],
  from: number,
  to: number,
  f: (x: Pt) => number,
): number => {
  let s = 0;
  for (let i = from; i <= to; i++) s += f(p[i]);
  return s;
};
const victim = (p: readonly Pt[], from: number, to: number): Side | null => {
  const l = sum(p, from, to, (x) => x.longLiq),
    s = sum(p, from, to, (x) => x.shortLiq);
  return l > s ? "LONG" : s > l ? "SHORT" : null;
};

export function flowSignals(
  symbol: string,
  rows: readonly FlowMinute[],
  o: FlowOpts = DEFAULT_FLOW_OPTS,
): FlowSignal[] {
  const p = flowPoints(rows, o.tf, o.n);
  const res: FlowSignal[] = [];
  let dir: "UP" | "DOWN" | null = null,
    s = -1,
    ext = -1,
    hi = -1,
    lo = -1;
  let lastDown: { s: number; e: number } | null = null;
  for (let i = 0; i < p.length; i++) {
    const x = p[i];
    if (i > 0 && x.t - p[i - 1].t > o.maxGapMin * MIN) {
      dir = null;
      lastDown = null;
      hi = lo = -1;
    }
    if (!(x.up > 0 && x.down > 0)) {
      hi = lo = -1;
      continue;
    }
    if (dir === null) {
      if (hi < 0 || x.oi > p[hi].oi) hi = i;
      if (lo < 0 || x.oi < p[lo].oi) lo = i;
      if (x.oi - p[lo].oi >= o.rev * x.up) {
        dir = "UP";
        s = lo;
        ext = i;
      } else if (p[hi].oi - x.oi >= o.rev * x.down) {
        dir = "DOWN";
        s = hi;
        ext = i;
      }
      continue;
    }
    if (dir === "DOWN") {
      if (x.oi < p[ext].oi) ext = i;
      else if (x.oi - p[ext].oi >= o.rev * x.up) {
        lastDown = { s, e: ext };
        dir = "UP";
        s = ext;
        ext = i;
      }
      continue;
    }
    if (x.oi > p[ext].oi) {
      ext = i;
      continue;
    }
    if (p[ext].oi - x.oi < o.rev * x.down) continue;
    // the rise (s..peak) is over: OI has fallen `rev` normal windows of OUT from the peak -- known now, at minute i
    const bottom = s,
      peak = ext,
      before = lastDown;
    dir = "DOWN";
    s = peak;
    ext = i;
    if (peak >= i || bottom >= peak) continue;
    const v = victim(p, peak + 1, i);
    if (!v) continue;
    const side: Side = v === "LONG" ? "SHORT" : "LONG";
    let ex = side === "LONG" ? Infinity : -Infinity;
    for (let j = peak; j <= i; j++)
      ex = side === "LONG" ? Math.min(ex, p[j].low) : Math.max(ex, p[j].high);
    const entry = x.close,
      minD = (entry * o.minSlPct) / 100;
    const sl =
      side === "LONG" ? Math.min(ex, entry - minD) : Math.max(ex, entry + minD);
    const a = p[bottom + 1 < p.length ? bottom + 1 : bottom];
    let prior: Prior = "NONE",
      priorOut = NaN;
    if (before && before.e === bottom && before.s < before.e) {
      const pv = victim(p, before.s + 1, before.e);
      prior = pv === null ? "NO_LIQ" : pv === v ? "SAME_SIDE" : "OTHER_SIDE";
      priorOut =
        sum(p, before.s + 1, before.e, (q) => q.outF) / p[before.s + 1].down;
    }
    res.push({
      symbol,
      t: x.t + MIN,
      side,
      entry,
      sl,
      slPct: (100 * Math.abs(entry - sl)) / entry,
      accStart: p[bottom].t,
      peak: p[peak].t,
      accIn: sum(p, bottom + 1, peak, (q) => q.inF) / a.up,
      accNet: (p[peak].oi - p[bottom].oi) / a.up,
      accMinutes: Math.round((p[peak].t - p[bottom].t) / MIN),
      prior,
      priorOut,
      dropOut: sum(p, peak + 1, i, (q) => q.outF) / p[peak + 1].down,
      victim: v,
    });
  }
  return res;
}

export function sizeBucket(v: number): string {
  if (!Number.isFinite(v)) return "?";
  return v < 1
    ? "<1"
    : v < 2
      ? "1-2"
      : v < 3
        ? "2-3"
        : v < 5
          ? "3-5"
          : v < 10
            ? "5-10"
            : "10+";
}
export const SIZE_BUCKETS = ["<1", "1-2", "2-3", "3-5", "5-10", "10+"];
