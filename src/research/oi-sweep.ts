/**
 * OI MOVE -> SWEEP (Johnny, Sep 30 2026) -- live, decided at the close of a 1h candle, nothing from the future.
 *
 *   1. a move is running on the closed 1h candles (price + OI together, oi-moves.ts rules);
 *   2. the next 1h candle is the FIRST whose OI falls -> look at its sweep (wick), no numbers:
 *        TOP sweep:    its high went above the previous candle's high (took the stops / liquidations up there)
 *                      and it closed back below that high; its upper wick is longer than its lower wick
 *        BOTTOM sweep: its low went below the previous candle's low and it closed back above it;
 *                      its lower wick is longer than its upper wick
 *      no sweep -> no signal;
 *   3. entry at that candle's close, TP +1%, SL -1% (Johnny's numbers). Checked on 1-minute candles, SL first
 *      when both are hit in the same minute.
 *   Side: "sweep" reading = a top sweep -> SHORT, a bottom sweep -> LONG (the market turns after taking the stops);
 *         "long"  reading = both -> LONG (as first written). Both are reported.
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

export function sweepOf(c: MvHour, p: MvHour): Sweep | null {
  const upper = c.high - Math.max(c.open, c.close),
    lower = Math.min(c.open, c.close) - c.low;
  if (c.high > p.high && c.close < p.high && upper > lower) return "TOP";
  if (c.low < p.low && c.close > p.low && lower > upper) return "BOTTOM";
  return null;
}

export function sweepSignals(
  symbol: string,
  h: readonly MvHour[],
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
      const sweep = sweepOf(c, p);
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
