/**
 * OI MOVE -> SWEEP (Johnny, Sep 30 2026) -- live, decided at the close of a 1h candle, nothing from the future.
 *
 *   1. a move is running on the closed 1h candles (price + OI together, oi-moves.ts rules);
 *   2. the next 1h candle is the FIRST whose OI falls -> look at the sweep inside that candle (no numbers):
 *        TOP sweep:    its upper wick is longer than its lower wick and longer than its body
 *        BOTTOM sweep: its lower wick is longer than its upper wick and longer than its body
 *      no sweep -> no signal;   (--sweep prev: the older reading against the previous candle's high / low)
 *   3. entry at that candle's close, TP +1%, SL -1% (Johnny's numbers). Checked on 1-minute candles, SL first
 *      when both are hit in the same minute.
 *   Side: "sweep" reading = a top sweep -> SHORT, a bottom sweep -> LONG (the market turns after taking the stops);
 *         "long"  reading = both -> LONG (as first written);
 *         "opposite" = a top sweep -> LONG, a bottom sweep -> SHORT (the move goes on after the stops are taken).
 *         All three are reported.
 *   4. portfolio: at most `maxOpen` trades open at the same time across all coins (Johnny: 2); a signal that comes
 *      while that many are open is skipped, good or bad.
 */
import { accumulation, findMoves, type MvHour } from "./oi-moves";
import type { Minute } from "./oi-reversal";

const H = 3_600_000;
export type Sweep = "TOP" | "BOTTOM";
export interface SweepSignal {
  symbol: string;
  dir: "UP" | "DOWN";
  moveStart: number;
  moveHours: number;
  candle: MvHour;
  prev: MvHour;
  sweep: Sweep;
  entryTs: number;
  entry: number;
  oiDrop: number;
}
export interface SweepTrade extends SweepSignal {
  side: "LONG" | "SHORT";
  tp: number;
  sl: number;
  result: "TP" | "SL" | "OPEN";
  exitTs: number | null;
  pnlPct: number;
  taken: boolean;
}

/**
 * The sweep INSIDE the candle itself (Johnny): which wick is the sweep -- the upper one (it went up, took the
 * stops/liquidations there and came back) or the lower one. The sweep wick must be longer than the other wick and
 * longer than the candle's body, otherwise the candle simply moved and there is no sweep.
 * mode "prev" = the older reading: the wick also had to go beyond the previous candle's high / low and close back.
 */
export function sweepOf(
  c: MvHour,
  p: MvHour,
  mode: "candle" | "prev" = "candle",
): Sweep | null {
  const upper = c.high - Math.max(c.open, c.close),
    lower = Math.min(c.open, c.close) - c.low,
    body = Math.abs(c.close - c.open);
  if (mode === "prev") {
    if (c.high > p.high && c.close < p.high && upper > lower) return "TOP";
    if (c.low < p.low && c.close > p.low && lower > upper) return "BOTTOM";
    return null;
  }
  if (upper > lower && upper > body) return "TOP";
  if (lower > upper && lower > body) return "BOTTOM";
  return null;
}

export function sweepSignals(
  symbol: string,
  h: readonly MvHour[],
  mode: "candle" | "prev" = "candle",
): SweepSignal[] {
  const out: SweepSignal[] = [],
    used = new Set<string>();
  for (let k = 1; k < h.length; k++) {
    const c = h[k],
      p = h[k - 1];
    if (!(c.oi > 0 && p.oi > 0 && c.oi < p.oi)) continue;
    const hs = h.slice(0, k);
    for (const m of findMoves(hs).filter(
      (x) => x.e === k - 1 && accumulation(hs, x).ok,
    )) {
      const key = `${m.dir}-${h[m.s].t}`;
      if (used.has(key)) continue;
      used.add(key); // only the FIRST OI-drop candle of the move counts
      const sweep = sweepOf(c, p, mode);
      if (sweep)
        out.push({
          symbol,
          dir: m.dir,
          moveStart: h[m.s].t,
          moveHours: m.e - m.s + 1,
          candle: c,
          prev: p,
          sweep,
          entryTs: c.t + H,
          entry: c.close,
          oiDrop: p.oi - c.oi,
        });
    }
  }
  return out;
}

export function tradeOf(
  s: SweepSignal,
  side: "LONG" | "SHORT",
  path: readonly Minute[],
  tpPct = 1,
  slPct = 1,
): Omit<SweepTrade, "taken"> {
  const long = side === "LONG";
  const tp = s.entry * (1 + (long ? tpPct : -tpPct) / 100),
    sl = s.entry * (1 - (long ? slPct : -slPct) / 100);
  let lo = 0,
    hi = path.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (path[m].t < s.entryTs) lo = m + 1;
    else hi = m;
  }
  for (let i = lo; i < path.length; i++) {
    const x = path[i];
    if (long ? x.low <= sl : x.high >= sl)
      return {
        ...s,
        side,
        tp,
        sl,
        result: "SL",
        exitTs: x.t + 60_000,
        pnlPct: -slPct,
      };
    if (long ? x.high >= tp : x.low <= tp)
      return {
        ...s,
        side,
        tp,
        sl,
        result: "TP",
        exitTs: x.t + 60_000,
        pnlPct: tpPct,
      };
  }
  return { ...s, side, tp, sl, result: "OPEN", exitTs: null, pnlPct: 0 };
}

/** at most maxOpen trades at the same time, in time order; the rest are skipped */
export function portfolio(
  trades: ReadonlyArray<Omit<SweepTrade, "taken">>,
  maxOpen = 2,
): SweepTrade[] {
  const sorted = [...trades].sort(
    (a, b) => a.entryTs - b.entryTs || a.symbol.localeCompare(b.symbol),
  );
  const open: Array<Omit<SweepTrade, "taken">> = [],
    out: SweepTrade[] = [];
  for (const t of sorted) {
    for (let i = open.length - 1; i >= 0; i--) {
      const e = open[i].exitTs;
      if (e !== null && e <= t.entryTs) open.splice(i, 1);
    }
    const taken =
      open.length < maxOpen && !open.some((o) => o.symbol === t.symbol);
    if (taken) open.push(t);
    out.push({ ...t, taken });
  }
  return out;
}
