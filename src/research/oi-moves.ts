/**
 * PRICE + OI MOVES (Johnny, Sep 30 2026) -- step 1: only FIND the moves, no trading. 1h candles, UTC.
 * No % thresholds anywhere:
 *
 * 1. PRICE MOVE: the 1h candle BODIES step one way -- UP: every body's low is at or above the previous body's low;
 *    DOWN: every body's high is at or below the previous one. "Every next candle raises" -> at least 3 candles.
 * 2. REAL MOVE, not noise: the move (first open -> last close) must be BIGGER than the whole range (highest high -
 *    lowest low) the market was swinging in during the same number of candles right before it, and it must end
 *    outside that range.
 * 3. OI inside the move: from the move's start the OI goes to its peak (or its low) -- that is where the OI
 *    "stops". So a move is split in two phases:
 *      start -> OI peak : PRICE UP + OI UP   (or PRICE DOWN + OI UP)   -- positions being built
 *      OI peak -> end   : PRICE UP + OI DOWN (or PRICE DOWN + OI DOWN) -- positions closing while the move goes on
 *    If the OI only fell from the start, the whole move is one "OI DOWN" phase.
 */
export interface MvHour { t: number; open: number; high: number; low: number; close: number; oi: number; oiOpen: number } // oi at close
export type MvKind = "PRICE UP + OI UP" | "PRICE DOWN + OI UP" | "PRICE UP + OI DOWN" | "PRICE DOWN + OI DOWN";
export interface MvPhase {
  kind: MvKind; from: number; to: number; hours: number;       // from = first candle OPEN, to = last candle CLOSE (UTC ms)
  priceFrom: number; priceTo: number; pricePct: number; high: number; low: number;
  oiFrom: number; oiTo: number; oiPct: number;
}
export interface Move { dir: "UP" | "DOWN"; s: number; e: number; startPrice: number; phases: MvPhase[] }

const H = 3_600_000;
const pct = (a: number, b: number): number => (100 * (b - a)) / a;
const bl = (c: MvHour): number => Math.min(c.open, c.close), bh = (c: MvHour): number => Math.max(c.open, c.close);

function phase(h: readonly MvHour[], a: number, b: number, up: boolean, oiUp: boolean, priceFrom = h[a].open): MvPhase {
  const seg = h.slice(a, b + 1);
  const kind = `PRICE ${up ? "UP" : "DOWN"} + OI ${oiUp ? "UP" : "DOWN"}` as MvKind;
  return {
    kind, from: h[a].t, to: h[b].t + H, hours: b - a + 1,
    priceFrom, priceTo: h[b].close, pricePct: pct(priceFrom, h[b].close),
    high: Math.max(...seg.map((c) => c.high)), low: Math.min(...seg.map((c) => c.low)),
    oiFrom: h[a].oiOpen, oiTo: h[b].oi, oiPct: pct(h[a].oiOpen, h[b].oi),
  };
}

export function findMoves(h: readonly MvHour[], minCandles = 3): Move[] {
  const out: Move[] = [];
  for (const dir of ["UP", "DOWN"] as const) {
    const up = dir === "UP";
    let s = 0;
    for (let i = 1; i <= h.length; i++) {
      const cont = i < h.length && (up ? bl(h[i]) >= bl(h[i - 1]) : bh(h[i]) <= bh(h[i - 1]));
      if (cont) continue;
      const e = i - 1, len = e - s + 1;
      if (len >= minCandles && s - len >= 0 && h[s].oiOpen > 0) {
        const before = h.slice(s - len, s), seg = h.slice(s, e + 1);
        const bHi = Math.max(...before.map((c) => c.high)), bLo = Math.min(...before.map((c) => c.low));
        const p0 = up ? bl(h[s]) : bh(h[s]); // the move starts at the first candle's body bottom (UP) / top (DOWN)
        const size = up ? h[e].close - p0 : p0 - h[e].close;
        const outside = up ? h[e].close > bHi : h[e].close < bLo;
        void seg;
        if (size > bHi - bLo && outside) {
          // OI: from the start to its peak = building; after the peak = closing
          let pk = s;
          for (let j = s; j <= e; j++) if (h[j].oi > h[pk].oi) pk = j;
          const phases: MvPhase[] = [];
          if (h[pk].oi > h[s].oiOpen) {
            phases.push(phase(h, s, pk, up, true, p0));
            if (pk < e) phases.push(phase(h, pk + 1, e, up, false));
          } else phases.push(phase(h, s, e, up, false, p0));
          out.push({ dir, s, e, startPrice: p0, phases });
        }
      }
      s = i;
    }
  }
  return out.sort((a, b) => a.s - b.s);
}

/**
 * The OI part of a move counts only if it is a real accumulation, again without % numbers:
 *   - the price really moved the move's way while the OI grew (not a 1-candle "move" that went nowhere), and
 *   - the OI grew MORE than the whole range the OI was swinging in during the same number of hours before the move.
 * `ongoing` = the OI peak is the last closed candle -> it may still grow, the end is not known yet.
 */
export function accumulation(h: readonly MvHour[], m: Move): { ok: boolean; ongoing: boolean } {
  const p = m.phases[0];
  if (!p.kind.endsWith("OI UP")) return { ok: false, ongoing: false };
  const priceOk = m.dir === "UP" ? p.priceTo > p.priceFrom : p.priceTo < p.priceFrom;
  const before = h.slice(Math.max(0, m.s - p.hours), m.s).flatMap((c) => [c.oiOpen, c.oi]).filter((x) => x > 0);
  const oiRange = before.length ? Math.max(...before) - Math.min(...before) : Infinity;
  const ongoing = p.to === h[h.length - 1].t + H;
  return { ok: priceOk && p.oiTo - p.oiFrom > oiRange, ongoing };
}

/** a small step (5m) with the OI at its close */
export interface MvBar { t: number; open: number; close: number; oi: number }
export interface MvFlow { newLong: number; newShort: number; longOut: number; shortOut: number }

/**
 * Who opened / who got closed between `from` and `to` (coins), from the small steps:
 *   OI up + price up -> new longs        OI up + price down -> new shorts
 *   OI down + price up -> shorts out (short stops / liquidations = the OI "tails" while the price rises)
 *   OI down + price down -> longs out (long stops / liquidations)
 * An estimate: OI does not say who closed, the price direction of that step does.
 * With `moveDir` (Johnny): inside a move the OI can only fall by the side the move is hurting -- while the price
 * RISES every OI drop is SHORTS closing (whatever the wick of that minute), while it FALLS every OI drop is LONGS.
 */
export function flowBetween(bars: readonly MvBar[], from: number, to: number, moveDir?: "UP" | "DOWN"): MvFlow {
  const f: MvFlow = { newLong: 0, newShort: 0, longOut: 0, shortOut: 0 };
  let prev = NaN;
  for (const b of bars) {
    if (b.t >= to) break;
    if (b.t >= from && prev > 0 && b.oi > 0) {
      const d = b.oi - prev, up = b.close >= b.open;
      if (d > 0) { if (up) f.newLong += d; else f.newShort += d; }
      else if (d < 0) { if ((moveDir ?? (up ? "UP" : "DOWN")) === "UP") f.shortOut -= d; else f.longOut -= d; }
    }
    if (b.oi > 0) prev = b.oi;
  }
  return f;
}
