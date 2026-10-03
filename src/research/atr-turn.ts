/**
 * V10 "ATR" ENTRY (Johnny, Oct 3 2026) -- pure, live-safe. The 15m directional change (src/research/dc15.ts turns) with
 * ONLY Johnny's OI case:
 *   1  the move was built with OI UP (new positions): OI at the extreme > OI at the move's start
 *   2  the move is RANK 1: its |OI change| is bigger than every accepted move of the `windowH` hours before it (prior > 0)
 *   3  a 15m candle CLOSES at least 1 ATR back from the move's extreme, and in that candle OI FALLS -> entry at its close
 *      (top -> SHORT; the mirror: a fall built with OI up, then the candle closes 1 ATR up with OI down -> LONG)
 * The 1 ATR distance protects from the wiggles inside the rise (Johnny). Variants (TurnOpts):
 *   atr "live" = the ATR before the candle · "frozen" = the ATR when the move began · red = the candle must be red / green
 * Returns the same shape as src/research/oi-peak.ts so the engine, the messages and the tools treat both alike.
 */
import { label, pastRank, turns, type Candle, type TurnOpts } from "./dc15";
import type { PeakSignal } from "./oi-peak";

export interface AtrSignal extends PeakSignal {
  /** the ATR used for the 1 ATR distance, and how far the close came back from the extreme (% of the extreme) */
  atr: number; backPct: number;
  /** the end of the alts' window (part 1 picks): the extreme candle's close */
  windowEndT: number;
}

export function atrSignals(c: readonly Candle[], k: number, n: number, windowH: number, opts: TurnOpts = {}): AtrSignal[] {
  const W = c.length ? c[0].end - c[0].t : 0;
  const idx = new Map(c.map((x, i) => [x.t, i]));
  const out: AtrSignal[] = [];
  for (const r of pastRank(turns(c, k, n, true, opts), windowH)) {
    const t = r.turn;
    if (r.rank !== 1 || r.prior === 0 || !(t.moveOiPct > 0) || !(t.candleOiPct < 0)) continue;
    const s = idx.get(t.moveStartT), e = idx.get(t.extremeT), i = idx.get(t.t - W);
    if (s === undefined || e === undefined || i === undefined) continue;
    let p = s;   // the OI peak inside the move (for the story's point 2)
    for (let j = s; j < i; j++) if (c[j].oi1 > c[p].oi1) p = j;
    const x = c[i];
    out.push({
      t: t.t, side: t.newDir === "DOWN" ? "SHORT" : "LONG", price: t.price,
      startT: t.moveStartT, startPrice: c[s].close, peakT: c[e].end, buildOiPct: t.moveOiPct,
      extreme: t.extreme, extremeT: t.extremeT, movePct: t.movePct,
      fromPeakOiPct: (100 * (x.oi1 - c[p].oi1)) / c[p].oi1,
      candleOiPct: t.candleOiPct, label: label(x), prior: r.prior,
      atr: t.atr, backPct: (100 * Math.abs(t.extreme - t.price)) / t.extreme, windowEndT: c[e].end,
    });
  }
  return out;
}
