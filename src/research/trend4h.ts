/**
 * 4h DIRECTION AT THE MOMENT OF A SIGNAL (Johnny, Sep 29 2026). Pure, no I/O.
 * Only 4h candles CLOSED at the signal time are used (closeTime <= t); the running candle is ignored.
 * Four definitions, measured side by side (no filter, only a label):
 *   1C     last closed candle vs the one before: higher high AND higher low -> UP; lower high AND lower low -> DOWN; else FLAT
 *   3C     the last 3 closed candles: both steps HH+HL -> UP; both steps LH+LL -> DOWN; else FLAT
 *   SWING  Phase 1 structure (src/research/structure4h.ts, defaults): BULL -> UP, BEAR -> DOWN, NEUTRAL -> FLAT
 *   24H    close of the last closed candle vs the close 24h earlier (6 candles on 4h, 24 on 1h): higher -> UP, lower -> DOWN
 * Works on any candle size (4h or 1h); SWING uses only the pivots/trend part of the engine (zones are not used here).
 */
import { runStructure, DEFAULT_STRUCTURE, type Candle4h } from "./structure4h";

export type Dir = "UP" | "DOWN" | "FLAT";
export const DEFINITIONS = ["1C", "3C", "SWING", "24H"] as const;
export type Definition = (typeof DEFINITIONS)[number];
export type Fit = "WITH" | "AGAINST" | "NEUTRAL";

/** index of the last candle closed at t, or -1 */
export function lastClosed(c: readonly Candle4h[], t: number): number {
  let lo = 0,
    hi = c.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (c[m].closeTime <= t) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

const step = (a: Candle4h, b: Candle4h): Dir =>
  b.high > a.high && b.low > a.low
    ? "UP"
    : b.high < a.high && b.low < a.low
      ? "DOWN"
      : "FLAT";

/** direction by each definition at time t; `c` must be one symbol's consecutive 4h candles (warm-up included) */
export function directionsAt(
  c: readonly Candle4h[],
  t: number,
  back24 = 6,
): { k: number; dir: Record<Definition, Dir | null> } {
  const k = lastClosed(c, t);
  const dir: Record<Definition, Dir | null> = {
    "1C": null,
    "3C": null,
    SWING: null,
    "24H": null,
  };
  if (k >= 1) dir["1C"] = step(c[k - 1], c[k]);
  if (k >= 2) {
    const a = step(c[k - 2], c[k - 1]),
      b = step(c[k - 1], c[k]);
    dir["3C"] = a === b && a !== "FLAT" ? a : "FLAT";
  }
  if (k >= back24)
    dir["24H"] =
      c[k].close > c[k - back24].close
        ? "UP"
        : c[k].close < c[k - back24].close
          ? "DOWN"
          : "FLAT";
  if (k >= 40) {
    const tr = runStructure("X", c.slice(0, k + 1), DEFAULT_STRUCTURE).trend;
    dir.SWING = tr === "BULL" ? "UP" : tr === "BEAR" ? "DOWN" : "FLAT";
  }
  return { k, dir };
}

export function fit(side: "LONG" | "SHORT", d: Dir): Fit {
  if (d === "FLAT") return "NEUTRAL";
  return (d === "UP") === (side === "LONG") ? "WITH" : "AGAINST";
}
