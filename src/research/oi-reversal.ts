/**
 * REVERSAL AFTER AN OI ACCUMULATION (Johnny, Sep 30 2026) -- research, no fixed numbers at all.
 *
 * On the moves of oi-moves.ts (price + OI growing together):
 *   1. the accumulation ends where the OI stops growing (followed past the price move if the OI keeps growing);
 *   2. the next 1h candle(s) whose OI keeps falling are split into their 15-minute candles;
 *   3. the first 15m candle in which the OI FELL and the candle turned AGAINST the move
 *      (after a rise: red, closed lower; after a fall: green, closed higher) is the reversal signal.
 *      A 15m candle whose OI grew does not count.
 *   4. entry = that 15m candle's close (the next 15m opens there), against the move;
 *      SL = the move's extreme up to the signal (after a rise: its highest high -> SHORT; after a fall: lowest low -> LONG);
 *      TP = 2R. SL first when both are touched in the same minute. No time limit (OPEN while neither is hit).
 */
import { accumulation, type Move, type MvHour } from "./oi-moves";

const H = 3_600_000, M15 = 15 * 60_000;
export interface Q15 { t: number; open: number; high: number; low: number; close: number; oiOpen: number; oiClose: number }
export interface Minute { t: number; high: number; low: number; close: number }
export interface RevTrade {
  side: "LONG" | "SHORT"; signal: Q15; entryTs: number; entry: number; sl: number; tp: number; riskPct: number;
  result: "TP" | "SL" | "OPEN"; exitTs: number | null; r: number;             // r = gross R (OPEN: 0)
}
export interface RevCheck { peakTs: number; dropFrom: number | null; dropTo: number | null; trade: RevTrade | null; note: string }

export function reversal(m: Move, h: readonly MvHour[], q15: readonly Q15[], path: readonly Minute[]): RevCheck {
  let pk = m.s + m.phases[0].hours - 1;
  while (pk + 1 < h.length && h[pk + 1].oi > 0 && h[pk + 1].oi >= h[pk].oi) pk++;
  const peakTs = h[pk].t + H;
  if (!accumulation(h, m).ok) return { peakTs, dropFrom: null, dropTo: null, trade: null, note: "not an accumulation" };
  if (pk + 1 >= h.length) return { peakTs, dropFrom: null, dropTo: null, trade: null, note: "OI still growing -- no drop yet" };
  let e = pk + 1;
  while (e + 1 < h.length && h[e + 1].oi > 0 && h[e + 1].oi < h[e].oi) e++;
  const dropFrom = h[pk + 1].t, dropTo = h[e].t + H, up = m.dir === "UP";
  const sig = q15.find((q) => q.t >= dropFrom && q.t < dropTo && q.oiClose < q.oiOpen && (up ? q.close < q.open : q.close > q.open));
  if (!sig) return { peakTs, dropFrom, dropTo, trade: null, note: e + 1 >= h.length ? "OI still falling, no reversal 15m yet" : "no reversal 15m in the OI-drop hours" };
  const moveQ = q15.filter((q) => q.t >= h[m.s].t && q.t <= sig.t);
  const sl = up ? Math.max(...moveQ.map((q) => q.high)) : Math.min(...moveQ.map((q) => q.low));
  const entry = sig.close, risk = Math.abs(sl - entry), side = up ? "SHORT" : "LONG";
  const tp = up ? entry - 2 * risk : entry + 2 * risk, entryTs = sig.t + M15;
  const base = { side, signal: sig, entryTs, entry, sl, tp, riskPct: (100 * risk) / entry } as const;
  if (!(risk > 0)) return { peakTs, dropFrom, dropTo, trade: null, note: "SL at the entry price -- skipped" };
  for (const p of path) {
    if (p.t < entryTs) continue;
    if (up ? p.high >= sl : p.low <= sl) return { peakTs, dropFrom, dropTo, note: "", trade: { ...base, result: "SL", exitTs: p.t, r: -1 } };
    if (up ? p.low <= tp : p.high >= tp) return { peakTs, dropFrom, dropTo, note: "", trade: { ...base, result: "TP", exitTs: p.t, r: 2 } };
  }
  return { peakTs, dropFrom, dropTo, note: "", trade: { ...base, result: "OPEN", exitTs: null, r: 0 } };
}
