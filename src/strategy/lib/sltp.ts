/**
 * ONE TRADE WITH SL / TP ON MINUTE BARS (Johnny, Oct 2 2026). Pure, live-safe.
 * Entry at the signal (the reversal candle's close), from the next minute on:
 *   SHORT: SL hit when a minute's high >= SL, TP hit when its low <= TP
 *   LONG:  SL hit when low <= SL, TP hit when high >= TP
 * Both inside the same minute -> SL (we cannot know the order: the careful side).
 * No exit by the end of the data -> OPEN, valued at the last close.
 */
import type { Dir, MinBar } from "./dc15";

export interface Trade {
  exit: "TP" | "SL" | "OPEN";
  exitT: number;
  r: number;
}

export function simTrade(
  bars: readonly MinBar[],
  t: number,
  entry: number,
  sl: number,
  rr: number,
  dir: Dir,
): Trade {
  const risk = Math.abs(sl - entry),
    sg = dir === "UP" ? 1 : -1;
  const tp = entry + sg * rr * risk;
  let i = 0,
    lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].t < t) lo = m + 1;
    else hi = m;
  }
  for (i = lo; i < bars.length; i++) {
    const b = bars[i];
    const slHit = dir === "DOWN" ? b.high >= sl : b.low <= sl;
    const tpHit = dir === "DOWN" ? b.low <= tp : b.high >= tp;
    if (slHit) return { exit: "SL", exitT: b.t + 60_000, r: -1 };
    if (tpHit) return { exit: "TP", exitT: b.t + 60_000, r: rr };
  }
  const last = bars[bars.length - 1];
  return {
    exit: "OPEN",
    exitT: last ? last.t + 60_000 : t,
    r: last && risk > 0 ? (sg * (last.close - entry)) / risk : 0,
  };
}
