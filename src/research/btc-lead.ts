/**
 * BTC LEADS, THE COIN THAT FOLLOWS IT IS TRADED (Johnny, Oct 1 2026) -- research only, LIVE-SAFE (never looks ahead),
 * no % anywhere -- every decision compares the episode with itself:
 *
 * 1. START: a closed 1h BTC candle where the OI grew and the price moved (UP: close > open, DOWN: close < open).
 * 2. WATCH the next hour as four 15-minute candles. At each 15m close: if the OI FELL more (in coins) than the biggest
 *    15m OI RISE of this whole episode so far, the force that was opening positions has lost -> the cleaning started ->
 *    SIGNAL at that close (BTC UP -> SHORT, DOWN -> LONG). Smaller falls are just noise.
 * 3. No signal in that hour: its four 15m candles make a 1h candle again. If over that hour the OI still grew and the price
 *    still went the episode's way, the episode goes on (watch the next hour the same way); otherwise it is over without a
 *    signal and that hour may start a new episode.
 * Then the coin that followed BTC best in the hours before is chosen, and we look how far it went in the next 1h / 4h.
 */
import type { MvHour } from "./oi-moves";
import { blameOf, type BlameBar } from "./v9-btc-blame";
import { betaOf } from "./v9-own-move";

const H = 3_600_000, Q = 15 * 60_000;
export interface Q15 { t: number; open: number; high: number; low: number; close: number; oiFrom: number; oiTo: number }
export interface LeadSignal {
  ts: number; dir: "UP" | "DOWN"; side: "LONG" | "SHORT";
  moveStart: number; moveHours: number; pricePct: number; oiPct: number; // episode start -> the signal
  fall: number; maxRise: number;                                           // the signal candle's OI fall vs the biggest 15m rise (coins)
  built: number;                                                           // OI added since the episode start, before the fall (coins)
  btcEntry: number;
}

export function leadSignals(h: readonly MvHour[], q15: readonly Q15[]): LeadSignal[] {
  const out: LeadSignal[] = [];
  const qs = new Map(q15.map((q) => [q.t, q]));
  const quarters = (hourT: number): Q15[] => [0, 1, 2, 3].map((i) => qs.get(hourT + i * Q)).filter((q): q is Q15 => !!q && q.oiFrom > 0 && q.oiTo > 0);
  const startsAt = (c: MvHour): "UP" | "DOWN" | null => (!(c.oi > c.oiOpen) || !(c.oiOpen > 0) ? null : c.close > c.open ? "UP" : c.close < c.open ? "DOWN" : null);
  let ep: { dir: "UP" | "DOWN"; i0: number; maxRise: number } | null = null;
  for (let i = 0; i < h.length; i++) {
    if (!ep) {
      const dir = startsAt(h[i]);
      if (dir) ep = { dir, i0: i, maxRise: Math.max(0, ...quarters(h[i].t).map((q) => q.oiTo - q.oiFrom)) };
      continue;
    }
    // watching hour i (the episode's closed hours are i0 .. i-1)
    let signalled = false;
    for (const q of quarters(h[i].t)) {
      const ch = q.oiTo - q.oiFrom;
      if (-ch > ep.maxRise && ep.maxRise > 0) {
        const s0 = h[ep.i0], start = s0.open;
        out.push({
          ts: q.t + Q, dir: ep.dir, side: ep.dir === "UP" ? "SHORT" : "LONG", moveStart: s0.t, moveHours: (q.t + Q - s0.t) / H,
          pricePct: (100 * (q.close - start)) / start, oiPct: (100 * (q.oiTo - s0.oiOpen)) / s0.oiOpen,
          fall: -ch, maxRise: ep.maxRise, built: q.oiFrom - s0.oiOpen, btcEntry: q.close,
        });
        signalled = true;
        break;
      }
      ep.maxRise = Math.max(ep.maxRise, ch);
    }
    if (signalled) { ep = null; continue; }
    const c = h[i], goesOn = c.oi > c.oiOpen && (ep.dir === "UP" ? c.close > c.open : c.close < c.open);
    if (!goesOn) {
      ep = null;
      const dir = startsAt(c); // this hour may start a new episode
      if (dir) ep = { dir, i0: i, maxRise: Math.max(0, ...quarters(c.t).map((q) => q.oiTo - q.oiFrom)) };
    }
  }
  return out;
}

export interface CoinPick { symbol: string; r2: number; beta: number }
/** coins ranked by how much of their 5-minute moves BTC explained in [ts - hours, ts) */
export function rankCoins(btc: readonly BlameBar[], coins: ReadonlyMap<string, readonly BlameBar[]>, ts: number, hours: number): CoinPick[] {
  const from = ts - hours * H, out: CoinPick[] = [];
  for (const [symbol, bars] of coins) {
    const b = blameOf("LONG", bars, btc, from, ts - 1), beta = betaOf(bars as never, btc as never, from, ts);
    if (b && b.r2 !== null) out.push({ symbol, r2: b.r2, beta: beta ?? NaN });
  }
  return out.sort((a, z) => z.r2 - a.r2);
}

export interface After { h: number; best: number; worst: number; close: number | null } // % in the trade's direction
export interface PBar { t: number; high: number; low: number; close: number }
/** from the bar that closes at ts: best / worst / last % in the trade's direction within each window */
export function afterOf(bars: readonly PBar[], ts: number, side: "LONG" | "SHORT", windows: readonly number[]): { entry: number; after: After[] } | null {
  const step = bars.length > 1 ? bars[1].t - bars[0].t : 5 * 60_000;
  const e = bars.find((b) => b.t + step === ts);
  if (!e) return null;
  const sg = side === "LONG" ? 1 : -1, pc = (x: number): number => (sg * 100 * (x - e.close)) / e.close;
  return {
    entry: e.close,
    after: windows.map((w) => {
      const seg = bars.filter((b) => b.t >= ts && b.t + step <= ts + w * H);
      if (!seg.length) return { h: w, best: NaN, worst: NaN, close: null };
      const fav = seg.map((b) => pc(side === "LONG" ? b.high : b.low)), adv = seg.map((b) => pc(side === "LONG" ? b.low : b.high));
      const full = seg[seg.length - 1].t + step === ts + w * H;
      return { h: w, best: Math.max(...fav), worst: Math.min(...adv), close: full ? pc(seg[seg.length - 1].close) : null };
    }),
  };
}
