/**
 * JOHNNY'S RULE (Oct 3 2026) -- pure, live-safe. The V10 entry, without waiting for anything else:
 *
 *   1  price goes up and OI goes up (new positions) -- from OI's LOWEST point in the move to the OI PEAK after it
 *   2  at the top OI starts to fall (there may still be green candles while it falls)
 *   3  the FIRST RED 15m candle whose own OI falls (and OI is below the peak)  -> entry at its close: SHORT
 *      (the mirror for a fall built with OI up: the first GREEN candle with OI falling -> LONG)
 *
 * Kept from the tests of Oct 2:
 *   - the moves themselves (where a move starts) = the 15m directional change with the OI rule (src/research/dc15.ts,
 *     the same loop), so a move starts where the previous one ended
 *   - RANK 1: the OI build-up (OI peak - OI's low before it) is bigger than every accepted move's |OI change|
 *     of the `windowH` hours before it
 * One signal per move. Nothing else: no ATR wait before the entry, no "how much came back".
 */
import { atrBefore, label, type Candle } from "./dc15";

export interface PeakSignal {
  /** the signal candle's close = the entry time */
  t: number;
  side: "SHORT" | "LONG";
  price: number;
  /** 1: the build-up -- the moment OI was lowest (a candle close) and the price then, the moment of the OI peak, the build-up % */
  startT: number;
  startPrice: number;
  peakT: number;
  buildOiPct: number;
  /** the move's price change from the start to its extreme so far (high for an up move / low for a down move) */
  extreme: number;
  extremeT: number;
  movePct: number;
  /** 2: OI from the peak to the signal candle's close, % */
  fromPeakOiPct: number;
  /** 3: the signal candle itself */
  candleOiPct: number;
  label: string;
  /** RANK 1 against how many earlier moves */
  prior: number;
}

export function oiPeakSignals(
  c: readonly Candle[],
  k: number,
  n: number,
  windowH: number,
): PeakSignal[] {
  const atr = atrBefore(c, n),
    out: PeakSignal[] = [];
  const accepted: Array<{ t: number; oi: number }> = []; // |move OI %| of every accepted move, for RANK 1
  let dir: "UP" | "DOWN" | null = null,
    ext = -1,
    start = -1,
    low = -1,
    peak = -1,
    signaled = false;
  for (let i = 0; i < c.length; i++) {
    const a = atr[i];
    if (!(a > 0)) continue;
    const x = c[i];
    if (dir === null) {
      dir = x.close >= x.open ? "UP" : "DOWN";
      ext = start = low = peak = i;
      continue;
    }

    // ── the entry (Johnny's 3 points), checked at this candle's close, before anything else ──
    if (!signaled && peak > low) {
      const lowOi = c[low].oi1,
        peakOi = c[peak].oi1;
      const build = (100 * (peakOi - lowOi)) / lowOi;
      const top = dir === "UP";
      const turnCandle = top ? x.close < x.open : x.close > x.open; // red after a rise / green after a fall
      const oiFalls = x.oi1 < x.oi0 && x.oi1 < peakOi;
      // the price went the move's way while OI was building (from OI's low to its peak)
      const priceMoved = top
        ? c[peak].close > c[low].close
        : c[peak].close < c[low].close;
      if (build > 0 && turnCandle && oiFalls && priceMoved) {
        const before = accepted.filter(
          (p) => p.t < x.end && p.t >= x.end - windowH * 3_600_000,
        );
        if (before.length > 0 && before.every((p) => p.oi < build)) {
          let e = low;
          for (let j = low; j <= i; j++)
            if (top ? c[j].high >= c[e].high : c[j].low <= c[e].low) e = j;
          const extreme = top ? c[e].high : c[e].low;
          out.push({
            t: x.end,
            side: top ? "SHORT" : "LONG",
            price: x.close,
            startT: c[low].end,
            startPrice: c[low].close,
            peakT: c[peak].end,
            buildOiPct: build,
            extreme,
            extremeT: c[e].t,
            movePct: (100 * (extreme - c[low].close)) / c[low].close,
            fromPeakOiPct: (100 * (x.oi1 - peakOi)) / peakOi,
            candleOiPct: (100 * (x.oi1 - x.oi0)) / x.oi0,
            label: label(x),
            prior: before.length,
          });
          signaled = true;
        }
      }
    }

    // ── OI's low and the peak after it, inside the current move ──
    if (x.oi1 < c[low].oi1) {
      low = i;
      peak = i;
    } else if (x.oi1 > c[peak].oi1) peak = i;
    // ── the moves (same as src/research/dc15.ts turns): where a move ends and the next starts ──
    if (dir === "UP" ? x.high >= c[ext].high : x.low <= c[ext].low) ext = i;
    const back = dir === "UP" ? c[ext].high - x.close : x.close - c[ext].low;
    if (back < k * a) continue;
    const moveOi = (ext === i ? x.oi0 : c[ext].oi1) - c[start].oi1,
      candleOi = x.oi1 - x.oi0;
    const ok =
      moveOi === 0 ||
      (candleOi !== 0 && Math.sign(candleOi) === -Math.sign(moveOi));
    if (!ok) continue;
    accepted.push({ t: x.end, oi: Math.abs((100 * moveOi) / c[start].oi1) });
    start = ext;
    ext = i;
    dir = dir === "UP" ? "DOWN" : "UP";
    signaled = false;
    // the new move starts at the old extreme: its OI low and the peak after it are searched from there (from the close
    // BEFORE the extreme candle -- that candle's own OI change already belongs to the new move)
    low = Math.max(0, start - 1);
    peak = low;
    for (let j = low; j <= i; j++) {
      if (c[j].oi1 < c[low].oi1) {
        low = j;
        peak = j;
      } else if (c[j].oi1 > c[peak].oi1) peak = j;
    }
  }
  return out;
}
