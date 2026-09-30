/**
 * REVERSAL AFTER AN OI ACCUMULATION -- LIVE, never looking ahead (Johnny, Sep 30 2026). No fixed numbers.
 *
 * At the close of EVERY 15-minute candle we only use what is known at that moment:
 *   1. the CLOSED 1h candles: is a move running right now? (oi-moves.ts rules on the closed hours only: bodies stepping
 *      one way for at least 3 candles, bigger than the range before it, the OI grew more than it was swinging before);
 *      the current hour is still open -- we do not know how it ends, so it is watched in 15m pieces;
 *   2. this 15m candle: the OI FELL inside it and it is a STRONG candle AGAINST the move
 *      (after a rise: red; after a fall: green; "strong" = its body is bigger than the average 15m body of the move);
 *   3. -> entry at its close, against the move; SL = the move's extreme so far (rise: highest high -> SHORT,
 *      fall: lowest low -> LONG); TP = 2R. SL first when both are touched in the same minute. One signal per move.
 * While the move keeps going (15m candles with the move, or the OI growing) nothing happens.
 */
import { accumulation, findMoves, type Move, type MvHour } from "./oi-moves";

const H = 3_600_000,
  M15 = 15 * 60_000;
export interface Q15 {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  oiOpen: number;
  oiClose: number;
}
export interface Minute {
  t: number;
  high: number;
  low: number;
  close: number;
}
export interface LiveSignal {
  dir: "UP" | "DOWN";
  side: "LONG" | "SHORT";
  moveStart: number;
  moveHours: number;
  moveStartPrice: number;
  signal: Q15;
  avgBody: number;
  entryTs: number;
  entry: number;
  sl: number;
  tp: number;
  riskPct: number;
  result: "TP" | "SL" | "OPEN";
  exitTs: number | null;
  r: number;
}

function exitOf(
  path: readonly Minute[],
  from: number,
  long: boolean,
  sl: number,
  tp: number,
): { result: "TP" | "SL" | "OPEN"; exitTs: number | null; r: number } {
  let i: number,
    lo = 0,
    hi = path.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (path[m].t < from) lo = m + 1;
    else hi = m;
  }
  for (i = lo; i < path.length; i++) {
    const p = path[i];
    if (long ? p.low <= sl : p.high >= sl)
      return { result: "SL", exitTs: p.t, r: -1 };
    if (long ? p.high >= tp : p.low <= tp)
      return { result: "TP", exitTs: p.t, r: 2 };
  }
  return { result: "OPEN", exitTs: null, r: 0 };
}

export function liveReversals(
  h: readonly MvHour[],
  q15: readonly Q15[],
  path: readonly Minute[],
): LiveSignal[] {
  const hourIdx = new Map(h.map((c, i) => [c.t, i]));
  const active = new Map<number, Move[]>(); // last closed hour index -> moves running at its close
  const running = (k: number): Move[] => {
    let v = active.get(k);
    if (!v) {
      const hs = h.slice(0, k + 1);
      v = findMoves(hs).filter((m) => m.e === k && accumulation(hs, m).ok);
      active.set(k, v);
    }
    return v;
  };
  const out: LiveSignal[] = [],
    used = new Set<string>();
  const firstQ = (t: number): number => {
    let lo = 0,
      hi = q15.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (q15[m].t < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  for (let qi = 0; qi < q15.length; qi++) {
    const q = q15[qi];
    const last = hourIdx.get(Math.floor(q.t / H) * H - H); // the last CLOSED hour (the current one may not exist yet)
    if (last === undefined || !(q.oiClose < q.oiOpen)) continue; // the OI must FALL in this 15m
    for (const m of running(last)) {
      const key = `${m.dir}-${h[m.s].t}`;
      if (used.has(key)) continue;
      const up = m.dir === "UP";
      if (up ? !(q.close < q.open) : !(q.close > q.open)) continue; // against the move
      const moveQ = q15.slice(firstQ(h[m.s].t), qi);
      if (!moveQ.length) continue;
      const avgBody =
        moveQ.reduce((a, x) => a + Math.abs(x.close - x.open), 0) /
        moveQ.length;
      if (!(Math.abs(q.close - q.open) > avgBody)) continue; // a strong candle
      const sl = up
        ? Math.max(q.high, ...moveQ.map((x) => x.high))
        : Math.min(q.low, ...moveQ.map((x) => x.low));
      const entry = q.close,
        risk = Math.abs(sl - entry);
      if (!(risk > 0)) continue;
      used.add(key);
      const tp = up ? entry - 2 * risk : entry + 2 * risk,
        entryTs = q.t + M15;
      out.push({
        dir: m.dir,
        side: up ? "SHORT" : "LONG",
        moveStart: h[m.s].t,
        moveHours: m.e - m.s + 1,
        moveStartPrice: m.startPrice,
        signal: q,
        avgBody,
        entryTs,
        entry,
        sl,
        tp,
        riskPct: (100 * risk) / entry,
        ...exitOf(path, entryTs, !up, sl, tp),
      });
    }
  }
  return out;
}
