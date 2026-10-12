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

/** the highest high (SHORT) / lowest low (LONG) of the minutes in [from, to) -- the move's extreme, known at `to` */
export function extremeIn(
  bars: readonly MinBar[],
  from: number,
  to: number,
  dir: Dir,
): number {
  let e = NaN;
  for (const b of bars) {
    if (b.t < from) continue;
    if (b.t >= to) break;
    const v = dir === "DOWN" ? b.high : b.low;
    if (!Number.isFinite(e) || (dir === "DOWN" ? v > e : v < e)) e = v;
  }
  return e;
}

/** SL never closer than 1 x ATR from the entry (the same k = 1 that the DC uses to call a turn: closer is noise) */
export function stopFor(
  entry: number,
  extreme: number,
  atr: number,
  dir: Dir,
): number {
  const a = Number.isFinite(atr) && atr > 0 ? atr : 0;
  return dir === "DOWN"
    ? Math.max(extreme, entry + a)
    : Math.min(extreme, entry - a);
}

/**
 * A, two steps (Johnny, Oct 2): BTC's top ARMS an alt; the entry is the alt's OWN accepted turn the same way
 * (its 15m DC + OI rule), at or after BTC's signal and before BTC's next accepted turn. First one only.
 */
export function armedTurn<
  T extends { t: number; newDir: Dir; accepted: boolean },
>(
  altTurns: readonly T[],
  dir: Dir,
  from: number,
  until: number,
): T | undefined {
  return altTurns.find(
    (x) => x.accepted && x.newDir === dir && x.t >= from && x.t < until,
  );
}
