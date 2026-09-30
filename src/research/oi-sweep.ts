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
export interface SweepSignal { symbol: string; dir: "UP" | "DOWN"; moveStart: number; moveHours: number; candle: MvHour; prev: MvHour; sweep: Sweep; entryTs: number; entry: number; oiDrop: number }
export interface SweepTrade extends SweepSignal { side: "LONG" | "SHORT"; tp: number; sl: number; result: "TP" | "SL" | "OPEN"; exitTs: number | null; pnlPct: number; taken: boolean }

/**
 * The sweep INSIDE the candle itself (Johnny): which wick is the sweep -- the upper one (it went up, took the
 * stops/liquidations there and came back) or the lower one. The sweep wick must be longer than the other wick and
 * longer than the candle's body, otherwise the candle simply moved and there is no sweep.
 * mode "prev" = the older reading: the wick also had to go beyond the previous candle's high / low and close back.
 */
export function sweepOf(c: MvHour, p: MvHour, mode: "candle" | "prev" = "candle"): Sweep | null {
  const upper = c.high - Math.max(c.open, c.close), lower = Math.min(c.open, c.close) - c.low, body = Math.abs(c.close - c.open);
  if (mode === "prev") {
    if (c.high > p.high && c.close < p.high && upper > lower) return "TOP";
    if (c.low < p.low && c.close > p.low && lower > upper) return "BOTTOM";
    return null;
  }
  if (upper > lower && upper > body) return "TOP";
  if (lower > upper && lower > body) return "BOTTOM";
  return null;
}

export function sweepSignals(symbol: string, h: readonly MvHour[], mode: "candle" | "prev" = "candle"): SweepSignal[] {
  const out: SweepSignal[] = [], used = new Set<string>();
  for (let k = 1; k < h.length; k++) {
    const c = h[k], p = h[k - 1];
    if (!(c.oi > 0 && p.oi > 0 && c.oi < p.oi)) continue;
    const hs = h.slice(0, k);
    for (const m of findMoves(hs).filter((x) => x.e === k - 1 && accumulation(hs, x).ok)) {
      const key = `${m.dir}-${h[m.s].t}`;
      if (used.has(key)) continue;
      used.add(key);                                   // only the FIRST OI-drop candle of the move counts
      const sweep = sweepOf(c, p, mode);
      if (sweep) out.push({ symbol, dir: m.dir, moveStart: h[m.s].t, moveHours: m.e - m.s + 1, candle: c, prev: p, sweep, entryTs: c.t + H, entry: c.close, oiDrop: p.oi - c.oi });
    }
  }
  return out;
}

export interface Exit { side: "LONG" | "SHORT"; tp: number; sl: number; result: "TP" | "SL" | "OPEN"; exitTs: number | null; pnlPct: number }
type Entry = { symbol: string; entryTs: number; entry: number };

export function tradeOf<T extends Entry>(s: T, side: "LONG" | "SHORT", path: readonly Minute[], tpPct = 1, slPct = 1): T & Exit {
  const long = side === "LONG";
  const tp = s.entry * (1 + (long ? tpPct : -tpPct) / 100), sl = s.entry * (1 - (long ? slPct : -slPct) / 100);
  let lo = 0, hi = path.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (path[m].t < s.entryTs) lo = m + 1; else hi = m; }
  for (let i = lo; i < path.length; i++) {
    const x = path[i];
    if (long ? x.low <= sl : x.high >= sl) return { ...s, side, tp, sl, result: "SL", exitTs: x.t + 60_000, pnlPct: -slPct };
    if (long ? x.high >= tp : x.low <= tp) return { ...s, side, tp, sl, result: "TP", exitTs: x.t + 60_000, pnlPct: tpPct };
  }
  return { ...s, side, tp, sl, result: "OPEN", exitTs: null, pnlPct: 0 };
}

/** at most maxOpen trades at the same time, in time order; the rest are skipped */
export function portfolio<T extends Entry & Exit>(trades: readonly T[], maxOpen = 2): Array<T & { taken: boolean }> {
  const sorted = [...trades].sort((a, b) => a.entryTs - b.entryTs || a.symbol.localeCompare(b.symbol));
  const open: T[] = [], out: Array<T & { taken: boolean }> = [];
  for (const t of sorted) {
    for (let i = open.length - 1; i >= 0; i--) { const e = open[i].exitTs; if (e !== null && e <= t.entryTs) open.splice(i, 1); }
    const taken = open.length < maxOpen && !open.some((o) => o.symbol === t.symbol);
    if (taken) open.push(t);
    out.push({ ...t, taken });
  }
  return out;
}

/**
 * CONFIRMATION AFTER THE OI DROP (Johnny, Sep 30 2026) -- enter later, live, no numbers except TP/SL:
 *   the first OI-drop 1h candle of a move is only the warning -- we skip it and watch the next 1h candles:
 *     LONG candle:  green, closes above the previous candle's close and makes a higher high than it
 *     SHORT candle: red, closes below the previous candle's close and makes a lower low (sweeps lower) than it
 *   need 1: the first of the next TWO candles that is a LONG or SHORT candle -> enter at its close
 *   need 2: the next candle shows a direction AND the one after confirms the same direction -> enter at the 2nd close
 *   nothing within two candles -> no trade.
 */
export type Dir = "LONG" | "SHORT";
export function candleDir(c: MvHour, p: MvHour): Dir | null {
  if (c.close > c.open && c.close > p.close && c.high > p.high) return "LONG";
  if (c.close < c.open && c.close < p.close && c.low < p.low) return "SHORT";
  return null;
}
export interface ConfirmSignal { symbol: string; dir: "UP" | "DOWN"; moveStart: number; moveHours: number; drop: MvHour; confirm: MvHour[]; side: Dir; entryTs: number; entry: number }

export function confirmSignals(symbol: string, h: readonly MvHour[], need: 1 | 2): ConfirmSignal[] {
  const out: ConfirmSignal[] = [], used = new Set<string>();
  for (let k = 1; k + 1 < h.length; k++) {
    const c = h[k], p = h[k - 1];
    if (!(c.oi > 0 && p.oi > 0 && c.oi < p.oi)) continue;
    const hs = h.slice(0, k);
    for (const m of findMoves(hs).filter((x) => x.e === k - 1 && accumulation(hs, x).ok)) {
      const key = `${m.dir}-${h[m.s].t}`;
      if (used.has(key)) continue;
      used.add(key);
      const d1 = candleDir(h[k + 1], h[k]), d2 = k + 2 < h.length ? candleDir(h[k + 2], h[k + 1]) : null;
      let side: Dir | null = null, at = -1;
      if (need === 1) { if (d1) { side = d1; at = k + 1; } else if (d2) { side = d2; at = k + 2; } }
      else if (d1 && d1 === d2) { side = d1; at = k + 2; }
      if (!side) continue;
      out.push({ symbol, dir: m.dir, moveStart: h[m.s].t, moveHours: m.e - m.s + 1, drop: c, confirm: h.slice(k + 1, at + 1), side, entryTs: h[at].t + H, entry: h[at].close });
    }
  }
  return out;
}
