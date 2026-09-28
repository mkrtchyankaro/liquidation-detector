/**
 * THE 4h FRAME (Johnny, Sep 28 2026) -- trade only at the edge of the market's current frame.
 *
 * From the 4h candles of the last 7 days that finished BEFORE the episode started:
 *   PEAK came last   (went up, turned down): TOP zone = the peak candle's wick (body top -> high);
 *                    BOTTOM zone = the lowest candle after the peak, once the price turned up from it
 *                    (both neighbours have higher lows) -- its wick (low -> body bottom)
 *   BOTTOM came last (went down, turned up): mirrored
 *   the other side not formed yet = NO FRAME
 * A signal is IN_ZONE when the cleaning pushed the price into our zone: BUY -> the episode low reached the
 * bottom zone (<= its body bottom; under the wick = "pierced", still counted); SELL -> the episode high
 * reached the top zone. Otherwise MIDDLE (pos: 0 = frame bottom, 100 = frame top).
 *
 * Backtest (Sep 22-28, research/v9-frame): 17 real signals IN_ZONE 5 TP / 2 SL vs MIDDLE 3/5; all 416
 * confirmed episodes IN_ZONE +0.50R avg vs MIDDLE -0.19R; the episodes V9 did not select, IN_ZONE +0.39R.
 */
export interface K { ts: number; open: number; high: number; low: number; close: number }
export interface Zone { lo: number; hi: number; ts: number; touches?: number }
export interface Frame { last: "PEAK" | "BOTTOM"; top: Zone | null; bottom: Zone | null }
export type Verdict = "IN_ZONE" | "MIDDLE" | "NO_FRAME";

/** What the live engine stores and shows for a signal. */
export interface V9FrameInfo {
  verdict: Verdict;
  pierced: boolean;
  /** Where the tested price sits in the frame, 0 = bottom, 100 = top (NaN without a frame). */
  pos: number;
  /** Episode low (BUY) / high (SELL) from Binance 1m candles. */
  tested: number;
  last: "PEAK" | "BOTTOM" | null;
  top: { lo: number; hi: number } | null;
  bottom: { lo: number; hi: number } | null;
}

export const FRAME_LOOK_MS = 7 * 24 * 3_600_000;
export const H4_MS = 4 * 3_600_000;

const topZone = (c: K): Zone => ({ lo: Math.max(c.open, c.close), hi: c.high, ts: c.ts });
const bottomZone = (c: K): Zone => ({ lo: c.low, hi: Math.min(c.open, c.close), ts: c.ts });

/** The frame from 4h candles (oldest first, all finished). null = too few candles. */
export function frameOf(c: readonly K[]): Frame | null {
  if (c.length < 3) return null;
  let iH = 0, iL = 0;
  for (let i = 0; i < c.length; i++) { if (c[i].high >= c[iH].high) iH = i; if (c[i].low <= c[iL].low) iL = i; }
  if (iH > iL) {
    let j = -1;
    for (let i = iH + 1; i < c.length; i++) if (j < 0 || c[i].low <= c[j].low) j = i;
    const turned = j > 0 && j < c.length - 1 && c[j + 1].low > c[j].low && c[j - 1].low > c[j].low;
    return { last: "PEAK", top: topZone(c[iH]), bottom: turned ? bottomZone(c[j]) : null };
  }
  let j = -1;
  for (let i = iL + 1; i < c.length; i++) if (j < 0 || c[i].high >= c[j].high) j = i;
  const turned = j > 0 && j < c.length - 1 && c[j + 1].high < c[j].high && c[j - 1].high < c[j].high;
  return { last: "BOTTOM", bottom: bottomZone(c[iL]), top: turned ? topZone(c[j]) : null };
}

/** Where the cleaning pushed the price (tested = episode low for a BUY, high for a SELL) vs the frame. */
export function verdictOf(f: Frame | null, long: boolean, tested: number): { verdict: Verdict; pierced: boolean; pos: number } {
  if (!f || !f.top || !f.bottom || !Number.isFinite(tested)) return { verdict: "NO_FRAME", pierced: false, pos: NaN };
  const pos = (100 * (tested - f.bottom.lo)) / (f.top.hi - f.bottom.lo);
  if (long) return tested <= f.bottom.hi ? { verdict: "IN_ZONE", pierced: tested < f.bottom.lo, pos } : { verdict: "MIDDLE", pierced: false, pos };
  return tested >= f.top.lo ? { verdict: "IN_ZONE", pierced: tested > f.top.hi, pos } : { verdict: "MIDDLE", pierced: false, pos };
}

/**
 * The whole check for one signal. c4 = 4h candles (any range; only those finished before the episode start
 * and not older than 7 days are used), m1 = 1m candles covering the episode (start -> decision).
 */
export function checkFrame(c4: readonly K[], m1: readonly K[], long: boolean, episodeStart: number, decisionTs: number): V9FrameInfo {
  const w4 = c4.filter((k) => k.ts >= episodeStart - FRAME_LOOK_MS && k.ts + H4_MS <= episodeStart);
  const f = frameOf(w4);
  const ep = m1.filter((k) => k.ts >= Math.floor(episodeStart / 60_000) * 60_000 && k.ts <= decisionTs);
  const tested = ep.length ? (long ? Math.min(...ep.map((k) => k.low)) : Math.max(...ep.map((k) => k.high))) : NaN;
  const v = verdictOf(f, long, tested);
  const z = (x: Zone | null | undefined): { lo: number; hi: number } | null => (x ? { lo: x.lo, hi: x.hi } : null);
  return { ...v, tested, last: f?.last ?? null, top: z(f?.top), bottom: z(f?.bottom) };
}
