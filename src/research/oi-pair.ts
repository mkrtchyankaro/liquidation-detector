/**
 * TWO COINS, SAME EPISODES? (Johnny, Oct 1 2026) -- research only. For one coin's hourly candles + OI, every
 * accumulation episode of oi-moves.ts (price + OI growing together, no % thresholds) with:
 *   start -> OI PEAK (followed while the OI keeps growing, like oi-story) -> the OI DROP after it (the hours in a
 *   row whose OI closes lower), with the % of OI built and taken away and the price at each point.
 * pairEpisodes() matches the episodes of a base coin (BTC) with a coin's episodes that overlap in time and reports
 * how many hours later (+) or earlier (-) the coin started, peaked and finished its drop.
 */
import { accumulation, findMoves, type MvHour } from "./oi-moves";

const H = 3_600_000;
export interface Episode {
  dir: "UP" | "DOWN";
  start: number;
  peak: number;
  dropEnd: number;
  priceStart: number;
  pricePeak: number;
  priceDropEnd: number;
  oiStart: number;
  oiPeak: number;
  oiDropEnd: number;
  built: number;
  takenPct: number;
  ongoing: boolean;
}

export function episodes(h: readonly MvHour[]): Episode[] {
  const out: Episode[] = [];
  for (const m of findMoves(h)) {
    if (!accumulation(h, m).ok) continue;
    let pk = m.s + m.phases[0].hours - 1;
    while (pk + 1 < h.length && h[pk + 1].oi > 0 && h[pk + 1].oi >= h[pk].oi)
      pk++;
    let e = pk;
    while (e + 1 < h.length && h[e + 1].oi > 0 && h[e + 1].oi < h[e].oi) e++;
    const oiStart = h[m.s].oiOpen,
      built = h[pk].oi - oiStart;
    out.push({
      dir: m.dir,
      start: h[m.s].t,
      peak: h[pk].t + H,
      dropEnd: h[e].t + H,
      priceStart: m.startPrice,
      pricePeak: h[pk].close,
      priceDropEnd: h[e].close,
      oiStart,
      oiPeak: h[pk].oi,
      oiDropEnd: h[e].oi,
      built,
      takenPct: built > 0 ? (100 * (h[pk].oi - h[e].oi)) / built : NaN,
      ongoing: e === h.length - 1,
    });
  }
  return out;
}

export interface Pair {
  base: Episode;
  coin: Episode | null;
  startLagH: number | null;
  peakLagH: number | null;
  dropEndLagH: number | null;
}
/** for each base episode: the coin episode in the SAME price direction whose [start, dropEnd] overlaps it most */
export function pairEpisodes(
  base: readonly Episode[],
  coin: readonly Episode[],
): Pair[] {
  return base.map((b) => {
    let best: Episode | null = null,
      bestOv = 0;
    for (const c of coin) {
      if (c.dir !== b.dir) continue;
      const ov = Math.min(b.dropEnd, c.dropEnd) - Math.max(b.start, c.start);
      if (ov > bestOv) {
        bestOv = ov;
        best = c;
      }
    }
    return best
      ? {
          base: b,
          coin: best,
          startLagH: (best.start - b.start) / H,
          peakLagH: (best.peak - b.peak) / H,
          dropEndLagH: (best.dropEnd - b.dropEnd) / H,
        }
      : {
          base: b,
          coin: null,
          startLagH: null,
          peakLagH: null,
          dropEndLagH: null,
        };
  });
}
