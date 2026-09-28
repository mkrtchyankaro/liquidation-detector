/**
 * V9 SIGNAL + CROWD STOP POOL (Johnny, Sep 29 2026). Pure, no I/O.
 * Did the V9 cleaning sweep a crowd stop pool (src/research/crowd-traps.ts) -- and are those signals better?
 *
 * For one signal:
 *   - the pools are built from the 1h candles FINISHED before the hour in which the episode started (UTC),
 *     so nothing after the start is used
 *   - the cleaning's extreme = the lowest low (longs flushed, we BUY) / highest high (shorts flushed, we SELL)
 *     of the 1m candles from the episode start to the confirmation
 *   - a pool is SWEPT if the cleaning went through it: BUY -> a SELL_STOPS pool (the longs' stops) between the
 *     price at the start and the extreme; SELL -> a BUY_STOPS pool between the start price and the high
 */
import { poolsAt, type Candle, type Pool } from "./crowd-traps";

export interface SweepCheck { startPrice: number; extreme: number; swept: Pool[]; nearest: Pool | null; nearestDistPct: number }

export function checkSweep(h1: readonly Candle[], m1: readonly Candle[], long: boolean, episodeStart: number, confirmTs: number): SweepCheck | null {
  const hourStart = Math.floor(episodeStart / 3_600_000) * 3_600_000;
  let i = h1.findIndex((c) => c.ts >= hourStart);
  if (i < 0) i = h1.length; // every stored hour is before the episode
  if (i < 81) return null;
  const win = m1.filter((c) => c.ts >= Math.floor(episodeStart / 60_000) * 60_000 && c.ts <= confirmTs);
  if (!win.length) return null;
  const startPrice = win[0].open;
  const extreme = long ? Math.min(...win.map((c) => c.low)) : Math.max(...win.map((c) => c.high));
  const pools = poolsAt(h1, i).filter((q) => q.side === (long ? "SELL_STOPS" : "BUY_STOPS"));
  // poolsAt keeps the pools on the right side of the last hourly close; the minute start price may differ a bit
  const swept = pools.filter((q) => (long ? q.price <= startPrice && q.price >= extreme : q.price >= startPrice && q.price <= extreme));
  const beyond = pools.filter((q) => !swept.includes(q)).map((q) => ({ q, d: Math.abs(q.price - extreme) / extreme * 100 })).sort((a, b) => a.d - b.d);
  return { startPrice, extreme, swept, nearest: beyond[0]?.q ?? null, nearestDistPct: beyond[0]?.d ?? NaN };
}
