/**
 * V10 "ATR" ENTRY (Johnny, Oct 3 2026) -- pure, live-safe. At each 15m candle CLOSE (top = SHORT; the mirror for a
 * bottom = LONG, every step mirrored):
 *   1  GROWTH: in the current move OI went up from its low to a peak while the price went up (the build-up), and that
 *      build-up is RANK 1 (bigger than every accepted move's |OI change| of the `windowH` hours before it)
 *   2  DECLINE: OI is now below that peak (it may have started falling before the top -- take-profits on the way up --
 *      it does not have to fall inside the entry candle)
 *   3  ENTRY: the candle closes at least 1 ATR below the move's high, and that high was made by an EARLIER candle
 *      (a candle that makes the high itself and closes 1 ATR below it is not the entry -- wait for the next candle)
 * The moves (where a move starts, the accepted moves for RANK 1) = the 15m directional change with the OI rule, as
 * src/research/oi-peak.ts, except that the candle that made the top itself never ends the move (the next one may). One entry per move. ATR "live" = before the candle · "frozen" = when the move began.
 */
import { atrBefore, label, type Candle } from "./dc15";
import type { PeakSignal } from "./oi-peak";

export interface AtrSignal extends PeakSignal {
  /** the ATR used for the 1 ATR distance, and how far (%) the close came back from the extreme */
  atr: number; backPct: number;
}

export function atrSignals(c: readonly Candle[], k: number, n: number, windowH: number, opts: { atr?: "live" | "frozen" } = {}): AtrSignal[] {
  const atr = atrBefore(c, n), out: AtrSignal[] = [];
  const accepted: Array<{ t: number; oi: number }> = [];
  let dir: "UP" | "DOWN" | null = null, ext = -1, start = -1, low = -1, peak = -1, signaled = false;
  for (let i = 0; i < c.length; i++) {
    if (!(atr[i] > 0)) continue;
    const x = c[i];
    if (dir === null) { dir = x.close >= x.open ? "UP" : "DOWN"; ext = start = low = peak = i; continue; }
    const fz = atr[Math.min(start + 1, i)];
    const a = opts.atr === "frozen" && fz > 0 ? fz : atr[i];
    const top: boolean = dir === "UP";
    const makesExtreme = top ? x.high >= c[ext].high : x.low <= c[ext].low;          // for the moves (as oi-peak.ts)
    const newTop = top ? x.high > c[ext].high : x.low < c[ext].low;                   // this candle made a higher top

    // ── the entry, at this candle's close ──
    if (!signaled && !newTop && peak > low && ext >= low) {
      const lowOi = c[low].oi1, peakOi = c[peak].oi1;
      const build = (100 * (peakOi - lowOi)) / lowOi;
      const priceMoved = top ? c[peak].close > c[low].close : c[peak].close < c[low].close;
      const back = top ? c[ext].high - x.close : x.close - c[ext].low;
      if (build > 0 && priceMoved && x.oi1 < peakOi && back >= k * a) {
        const before = accepted.filter((p) => p.t < x.end && p.t >= x.end - windowH * 3_600_000);
        if (before.length > 0 && before.every((p) => p.oi < build)) {
          const extreme = top ? c[ext].high : c[ext].low;
          out.push({
            t: x.end, side: top ? "SHORT" : "LONG", price: x.close,
            startT: c[low].end, startPrice: c[low].close, peakT: c[peak].end, buildOiPct: build,
            extreme, extremeT: c[ext].t, movePct: (100 * (extreme - c[low].close)) / c[low].close,
            fromPeakOiPct: (100 * (x.oi1 - peakOi)) / peakOi,
            candleOiPct: (100 * (x.oi1 - x.oi0)) / x.oi0, label: label(x), prior: before.length,
            atr: a, backPct: (100 * back) / extreme,
          });
          signaled = true;
        }
      }
    }

    // ── OI's low and the peak after it, inside the current move (as src/research/oi-peak.ts) ──
    if (x.oi1 < c[low].oi1) { low = i; peak = i; }
    else if (x.oi1 > c[peak].oi1) peak = i;
    // ── the moves: the 15m directional change with the OI rule (as src/research/oi-peak.ts) ──
    if (makesExtreme) ext = i;
    // Johnny: the candle that made the top itself does not end the move -- wait for the next candle
    if (newTop) continue;
    const back = top ? c[ext].high - x.close : x.close - c[ext].low;
    if (back < k * a) continue;
    const moveOi = (ext === i ? x.oi0 : c[ext].oi1) - c[start].oi1, candleOi = x.oi1 - x.oi0;
    if (!(moveOi === 0 || (candleOi !== 0 && Math.sign(candleOi) === -Math.sign(moveOi)))) continue;
    accepted.push({ t: x.end, oi: Math.abs((100 * moveOi) / c[start].oi1) });
    start = ext; ext = i; dir = top ? "DOWN" : "UP"; signaled = false;
    low = Math.max(0, start - 1); peak = low;
    for (let j = low; j <= i; j++) { if (c[j].oi1 < c[low].oi1) { low = j; peak = j; } else if (c[j].oi1 > c[peak].oi1) peak = j; }
  }
  return out;
}
