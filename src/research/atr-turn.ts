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
import { atrBefore, label, pastRank, turns, type Candle } from "./dc15";
import type { PeakSignal } from "./oi-peak";

export interface AtrSignal extends PeakSignal {
  /** the ATR used for the 1 ATR distance, and how far (%) the close came back from the extreme */
  atr: number;
  backPct: number;
}

export function atrSignals(
  c: readonly Candle[],
  k: number,
  n: number,
  windowH: number,
  opts: {
    atr?: "live" | "frozen";
    growth?: "afterLow" | "biggest";
    topCandleOi?: boolean;
    redAfterTop?: boolean;
    selfTop?: boolean;
    far?: "close" | "high" | "body";
    why?: (t: number, reason: string) => void;
  } = {},
): AtrSignal[] {
  // growth "afterLow" (default): the OI rise after OI's lowest point in the move · "biggest" (Johnny Oct 3, SUI): the
  // biggest OI rise anywhere in the move during which the price also went the move's way -- OI may fall to a new low
  // later (shorts liquidated on the way up), the growth that happened still counts
  const big = opts.growth === "biggest";
  // Johnny Oct 3: the candle that MADE the top and already closed 1 ATR below it must have OI FALLING inside it (the
  // shorts' liquidity collected at the very top); else that top gives no entry. The entry is still the next candle.
  const topOi = opts.topCandleOi !== false;
  // Johnny Oct 3: after such a top candle (closed 1 ATR back, OI down) the entry candle must close RED (green at a bottom)
  const redAfter = opts.redAfterTop !== false;
  let wick = -1,
    wickOiUp = false; // the top candle that closed 1 ATR back, and whether its OI went up
  const atr = atrBefore(c, n),
    out: AtrSignal[] = [];
  const accepted: Array<{ t: number; oi: number }> = [];
  let dir: "UP" | "DOWN" | null = null,
    ext = -1,
    start = -1,
    low = -1,
    peak = -1,
    signaled = false;
  // far "high" / "body": the move may end (its close 1 ATR back) before the high / body is 1 ATR away -> the top stays
  // PENDING and later candles are checked against it, until one qualifies or the price goes beyond that top
  const farOf = (x: Candle, up: boolean): number =>
    opts.far === "high"
      ? up
        ? x.high
        : x.low
      : opts.far === "body"
        ? up
          ? Math.max(x.open, x.close)
          : Math.min(x.open, x.close)
        : x.close;
  let pending: {
    up: boolean;
    E: number;
    L: number;
    P: number;
    build: number;
    prior: number;
  } | null = null;
  let mn = -1,
    bl = -1,
    bp = -1; // "biggest": OI's low so far, and the biggest rise (its low -> its peak)
  const grow = (j: number, up: boolean): void => {
    if (c[j].oi1 < c[mn].oi1) {
      mn = j;
      return;
    }
    const ok = up ? c[j].close > c[mn].close : c[j].close < c[mn].close;
    if (ok && c[j].oi1 - c[mn].oi1 > (bp >= 0 ? c[bp].oi1 - c[bl].oi1 : 0)) {
      bl = mn;
      bp = j;
    }
  };
  for (let i = 0; i < c.length; i++) {
    if (!(atr[i] > 0)) continue;
    const x = c[i];
    if (dir === null) {
      dir = x.close >= x.open ? "UP" : "DOWN";
      ext = start = low = peak = mn = i;
      continue;
    }
    // ── a pending top from the move that just ended (far mode) ──
    if (pending) {
      const pu = pending.up,
        ex = pu ? c[pending.E].high : c[pending.E].low;
      if (pu ? x.high > ex : x.low < ex)
        pending = null; // the price went beyond that top
      else {
        const pb = pu ? ex - farOf(x, pu) : farOf(x, pu) - ex,
          peakOi = c[pending.P].oi1;
        if (pb >= k * atr[i] && x.oi1 < peakOi) {
          out.push({
            t: x.end,
            side: pu ? "SHORT" : "LONG",
            price: x.close,
            startT: c[pending.L].end,
            startPrice: c[pending.L].close,
            peakT: c[pending.P].end,
            buildOiPct: pending.build,
            extreme: ex,
            extremeT: c[pending.E].t,
            movePct: (100 * (ex - c[pending.L].close)) / c[pending.L].close,
            fromPeakOiPct: (100 * (x.oi1 - peakOi)) / peakOi,
            candleOiPct: (100 * (x.oi1 - x.oi0)) / x.oi0,
            label: label(x),
            prior: pending.prior,
            atr: atr[i],
            backPct: (100 * Math.abs(ex - x.close)) / ex,
          });
          pending = null;
        }
      }
    }
    const L = big ? bl : low,
      P = big ? bp : peak;
    const fz = atr[Math.min(start + 1, i)];
    const a = opts.atr === "frozen" && fz > 0 ? fz : atr[i];
    const top: boolean = dir === "UP";
    const makesExtreme = top ? x.high >= c[ext].high : x.low <= c[ext].low; // for the moves (as oi-peak.ts)
    const newTop = top ? x.high > c[ext].high : x.low < c[ext].low; // this candle made a higher top
    const turnColour = top ? x.close < x.open : x.close > x.open;
    // selfTop (Johnny Oct 3, 1h candles -- waiting a whole candle is too long): the candle that MADE the top is itself
    // the entry when it closes RED at least 1 ATR below its own high
    const selfOk =
      !!opts.selfTop &&
      newTop &&
      turnColour &&
      (top ? x.high - x.close : x.close - x.low) >= k * a;
    const E = selfOk ? i : ext; // the top the entry measures from

    // ── the entry, at this candle's close (why: the story tool's "why no entry", nothing else) ──
    const why = (m: string): void => opts.why?.(x.end, m);
    const W = top ? "the top" : "the bottom";
    if (signaled) why("already entered in this move");
    else if (newTop && !selfOk)
      why(`this candle made ${W} -> wait for the next one`);
    else if (!selfOk && topOi && wick === ext && wickOiUp)
      why(
        `the candle that made ${W} closed 1 ATR back but its OI went UP -> no entry from this ${top ? "top" : "bottom"}`,
      );
    else if (!(P > L && L >= 0)) why("no OI growth in this move yet");
    else if (E < L) why(`${W} came before the OI growth`);
    if (
      !signaled &&
      !newTop &&
      !(topOi && wick === ext && wickOiUp) &&
      redAfter &&
      wick === ext &&
      !turnColour
    )
      why(
        `the candle that made ${W} closed 1 ATR back -> the entry candle must close ${top ? "red" : "green"}`,
      );
    const gate =
      selfOk ||
      (!newTop &&
        !(topOi && wick === ext && wickOiUp) &&
        !(redAfter && wick === ext && !turnColour));
    if (!signaled && gate && L >= 0 && P > L && E >= L) {
      const lowOi = c[L].oi1,
        peakOi = c[P].oi1;
      const build = (100 * (peakOi - lowOi)) / lowOi;
      const priceMoved = top
        ? c[P].close > c[L].close
        : c[P].close < c[L].close;
      // far (Johnny Oct 3): what must be 1 ATR away from the top -- the close (default), the candle's high with its wick
      // ("high"), or the top of its body ("body"); mirrored for a bottom
      const near = farOf(x, top);
      const back = top ? c[E].high - near : near - c[E].low;
      const pc = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
      if (!(build > 0)) why("no OI growth in this move yet");
      else if (!priceMoved)
        why(
          `OI grew ${pc(build)} but the price did not go ${top ? "up" : "down"} with it`,
        );
      else if (!(x.oi1 < peakOi))
        why(`OI is not below its peak (growth ${pc(build)})`);
      else if (!(back >= k * a))
        why(
          `only ${pc((100 * back) / (top ? c[E].high : c[E].low))} back from ${W}, 1 ATR = ${pc((100 * a) / x.close)}`,
        );
      if (build > 0 && priceMoved && x.oi1 < peakOi && back >= k * a) {
        const before = accepted.filter(
          (p) => p.t < x.end && p.t >= x.end - windowH * 3_600_000,
        );
        if (before.length === 0)
          why(`no earlier move in ${windowH}h to compare (RANK 1)`);
        else if (!before.every((p) => p.oi < build))
          why(
            `not RANK 1: OI growth ${pc(build)}, an earlier move had ${pc(Math.max(...before.map((p) => p.oi)))} in ${windowH}h`,
          );
        if (before.length > 0 && before.every((p) => p.oi < build)) {
          const extreme = top ? c[E].high : c[E].low;
          out.push({
            t: x.end,
            side: top ? "SHORT" : "LONG",
            price: x.close,
            startT: c[L].end,
            startPrice: c[L].close,
            peakT: c[P].end,
            buildOiPct: build,
            extreme,
            extremeT: c[E].t,
            movePct: (100 * (extreme - c[L].close)) / c[L].close,
            fromPeakOiPct: (100 * (x.oi1 - peakOi)) / peakOi,
            candleOiPct: (100 * (x.oi1 - x.oi0)) / x.oi0,
            label: label(x),
            prior: before.length,
            atr: a,
            backPct: (100 * back) / extreme,
          });
          signaled = true;
        }
      }
    }

    // ── OI's low and the peak after it, inside the current move (as src/research/oi-peak.ts) ──
    if (x.oi1 < c[low].oi1) {
      low = i;
      peak = i;
    } else if (x.oi1 > c[peak].oi1) peak = i;
    grow(i, top);
    // ── the moves: the 15m directional change with the OI rule (as src/research/oi-peak.ts) ──
    if (makesExtreme) {
      ext = i;
      const self = top ? x.high - x.close : x.close - x.low; // this candle's close back from its own top
      wick = self >= k * a ? i : -1;
      wickOiUp = x.oi1 >= x.oi0;
    }
    // Johnny: the candle that made the top itself does not end the move -- wait for the next candle
    if (newTop) continue;
    // ... nor does a candle of the wrong colour right after a top candle that closed 1 ATR back (the entry waits for red)
    if (redAfter && wick === ext && ext !== i && !turnColour) continue;
    const back = top ? c[ext].high - x.close : x.close - c[ext].low;
    if (back < k * a) continue;
    const moveOi = (ext === i ? x.oi0 : c[ext].oi1) - c[start].oi1,
      candleOi = x.oi1 - x.oi0;
    if (
      !(
        moveOi === 0 ||
        (candleOi !== 0 && Math.sign(candleOi) === -Math.sign(moveOi))
      )
    )
      continue;
    // far mode: the top of the move that ends here had no entry yet -> keep it pending (all but the distance were met)
    if (
      !signaled &&
      opts.far &&
      opts.far !== "close" &&
      L >= 0 &&
      P > L &&
      ext >= L
    ) {
      const build = (100 * (c[P].oi1 - c[L].oi1)) / c[L].oi1;
      const priceMoved = top
        ? c[P].close > c[L].close
        : c[P].close < c[L].close;
      const before = accepted.filter(
        (p) => p.t < x.end && p.t >= x.end - windowH * 3_600_000,
      );
      if (
        build > 0 &&
        priceMoved &&
        before.length > 0 &&
        before.every((p) => p.oi < build)
      )
        pending = { up: top, E: ext, L, P, build, prior: before.length };
    }
    accepted.push({ t: x.end, oi: Math.abs((100 * moveOi) / c[start].oi1) });
    start = ext;
    ext = i;
    dir = top ? "DOWN" : "UP";
    signaled = false;
    wick = -1;
    low = Math.max(0, start - 1);
    peak = low;
    for (let j = low; j <= i; j++) {
      if (c[j].oi1 < c[low].oi1) {
        low = j;
        peak = j;
      } else if (c[j].oi1 > c[peak].oi1) peak = j;
    }
    mn = Math.max(0, start - 1);
    bl = bp = -1;
    for (let j = mn; j <= i; j++) grow(j, dir === "UP");
  }
  return out;
}

/**
 * V10 "STORY" ENTRY (Johnny, Oct 3 2026, final wording) -- pure, live-safe. Top = SHORT; a bottom = LONG, mirrored:
 *   1  GROWTH: the biggest OI rise in the move while the price also goes up (new positions) -- RANK 1; it stays even
 *      if OI later falls below where it started
 *   2  DECLINE: then OI falls from that peak while the price still goes up (shorts liquidated / closing) -- this must
 *      happen BEFORE the top or IN the top candle itself (the OI peak is an earlier close than the top candle's)
 *   3  the top candle: no condition on its OI (it may rise a little if OI already fell before)
 *   4  ENTRY: the first RED candle after the top that closes at least 1 ATR below it (a green one -> wait; a new high ->
 *      it is the new top and all is checked again)
 * The moves (start, the RANK 1 comparison) = the 15m directional change with the OI rule; the candle that made the top
 * never ends the move, nor does a candle of the wrong colour. One entry per move. ATR "live" / "frozen" as atrSignals.
 */
export interface StorySignal extends AtrSignal {
  /** 1: the price change while OI grew (close at OI's low -> close at OI's peak) */
  buildPricePct: number;
  /** 2: OI from its peak to its lowest before / in the top candle, and the price from the OI peak's close to the top */
  declineOiPct: number;
  declinePricePct: number;
  /** the top candle's close */
  topT: number;
}

export function atrStorySignals(
  c: readonly Candle[],
  k: number,
  n: number,
  windowH: number,
  opts: {
    atr?: "live" | "frozen";
    why?: (t: number, reason: string) => void;
  } = {},
): StorySignal[] {
  const atr = atrBefore(c, n),
    out: StorySignal[] = [];
  const accepted: Array<{ t: number; oi: number }> = [];
  let dir: "UP" | "DOWN" | null = null,
    ext = -1,
    start = -1,
    signaled = false;
  // 1 = the BIGGEST OI rise in the move during which the price went the move's way (low -> peak). It is kept even if
  // OI later falls below where it started (SUI Oct 3: OI +0.5% with the price, then -4.9% while the price ran +5.9%).
  let mn = -1,
    low = -1,
    peak = -1;
  const grow = (j: number, up: boolean): void => {
    if (mn < 0 || c[j].oi1 < c[mn].oi1) {
      mn = j;
      return;
    }
    const ok = up ? c[j].close > c[mn].close : c[j].close < c[mn].close;
    if (
      ok &&
      c[j].oi1 - c[mn].oi1 > (peak >= 0 ? c[peak].oi1 - c[low].oi1 : 0)
    ) {
      low = mn;
      peak = j;
    }
  };
  const pc = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  for (let i = 0; i < c.length; i++) {
    if (!(atr[i] > 0)) continue;
    const x = c[i];
    if (dir === null) {
      dir = x.close >= x.open ? "UP" : "DOWN";
      ext = start = mn = i;
      continue;
    }
    const fz = atr[Math.min(start + 1, i)];
    const a = opts.atr === "frozen" && fz > 0 ? fz : atr[i];
    const top: boolean = dir === "UP";
    const makesExtreme = top ? x.high >= c[ext].high : x.low <= c[ext].low;
    const newTop = top ? x.high > c[ext].high : x.low < c[ext].low;
    const colour = top ? x.close < x.open : x.close > x.open; // red after a top / green after a bottom
    const why = (m: string): void => opts.why?.(x.end, m);
    const W = top ? "the top" : "the bottom";

    // ── the entry, at this candle's close ──
    if (signaled) why("already entered in this move");
    else if (newTop) why(`this candle made ${W} -> wait for the next one`);
    else if (!(peak >= 0 && peak > low))
      why("1: no OI growth with the price in this move yet");
    else if (!(peak < ext))
      why(
        `2: OI's peak is not before ${W} -- no OI decline before / in the ${top ? "top" : "bottom"} candle`,
      );
    else if (!colour)
      why(`4: the candle is not ${top ? "red" : "green"} -> wait`);
    else {
      const lowOi = c[low].oi1,
        peakOi = c[peak].oi1,
        build = (100 * (peakOi - lowOi)) / lowOi;
      let dmin = peak + 1;
      for (let j = peak + 1; j <= ext; j++)
        if (c[j].oi1 < c[dmin].oi1) dmin = j;
      const decline = (100 * (c[dmin].oi1 - peakOi)) / peakOi;
      const extreme = top ? c[ext].high : c[ext].low;
      const priceMoved = true; // by construction of the growth pair
      const priceOn = top ? extreme > c[peak].close : extreme < c[peak].close;
      const back = top ? extreme - x.close : x.close - extreme;
      if (!(build > 0)) why("1: no OI growth in this move yet");
      else if (!priceMoved)
        why(
          `1: OI grew ${pc(build)} but the price did not go ${top ? "up" : "down"} with it`,
        );
      else if (!(decline < 0)) why("2: OI did not fall after its peak");
      else if (!priceOn)
        why(
          `2: the price did not go further ${top ? "up" : "down"} while OI fell`,
        );
      else if (!(back >= k * a))
        why(
          `4: only ${pc((100 * back) / extreme)} back from ${W}, 1 ATR = ${pc((100 * a) / x.close)}`,
        );
      else {
        const before = accepted.filter(
          (p) => p.t < x.end && p.t >= x.end - windowH * 3_600_000,
        );
        if (before.length === 0)
          why(`no earlier move in ${windowH}h to compare (RANK 1)`);
        else if (!before.every((p) => p.oi < build))
          why(
            `not RANK 1: OI growth ${pc(build)}, an earlier move had ${pc(Math.max(...before.map((p) => p.oi)))} in ${windowH}h`,
          );
        else {
          out.push({
            t: x.end,
            side: top ? "SHORT" : "LONG",
            price: x.close,
            startT: c[low].end,
            startPrice: c[low].close,
            peakT: c[peak].end,
            buildOiPct: build,
            extreme,
            extremeT: c[ext].t,
            movePct: (100 * (extreme - c[low].close)) / c[low].close,
            fromPeakOiPct: (100 * (x.oi1 - peakOi)) / peakOi,
            candleOiPct: (100 * (x.oi1 - x.oi0)) / x.oi0,
            label: label(x),
            prior: before.length,
            atr: a,
            backPct: (100 * back) / extreme,
            buildPricePct:
              (100 * (c[peak].close - c[low].close)) / c[low].close,
            declineOiPct: decline,
            declinePricePct: (100 * (extreme - c[peak].close)) / c[peak].close,
            topT: c[ext].end,
          });
          signaled = true;
        }
      }
    }

    // ── the growth (a new, bigger growth after the top = its peak is after the top -> no entry from that top) ──
    grow(i, top);
    // ── the moves ──
    if (makesExtreme) ext = i;
    if (newTop) continue; // the candle that made the top never ends the move
    if (!colour) continue; // nor does a candle of the wrong colour (the entry waits for red)
    const back = top ? c[ext].high - x.close : x.close - c[ext].low;
    if (back < k * a) continue;
    const moveOi = (ext === i ? x.oi0 : c[ext].oi1) - c[start].oi1,
      candleOi = x.oi1 - x.oi0;
    if (
      !(
        moveOi === 0 ||
        (candleOi !== 0 && Math.sign(candleOi) === -Math.sign(moveOi))
      )
    )
      continue;
    accepted.push({ t: x.end, oi: Math.abs((100 * moveOi) / c[start].oi1) });
    start = ext;
    ext = i;
    dir = top ? "DOWN" : "UP";
    signaled = false;
    mn = low = peak = -1;
    for (let j = Math.max(0, start - 1); j <= i; j++) grow(j, dir === "UP");
  }
  return out;
}

/**
 * THE 1-HOUR CONTEXT (Johnny, Oct 3 2026): the move is followed on 1h candles -- OI grows while the price goes up --
 * and the entry itself is found inside it on 15m candles (the existing 15m rules). For each 1h candle CLOSE: the 1h
 * move's direction (the same directional change with the OI rule, on 1h) and the biggest OI rise in that move during
 * which the price went the move's way (> 0 = "OI grew with the price on 1h"). A 15m signal at time t is "in a 1h
 * growth" when the last 1h candle closed by t is in a move of the signal's direction with such a growth. Live-safe:
 * only closed 1h candles.
 */
export interface H1State {
  end: number;
  dir: "UP" | "DOWN";
  growthOiPct: number;
  growthPricePct: number;
  startT: number;
}
export function h1Context(
  c: readonly Candle[],
  k: number,
  n: number,
): H1State[] {
  const atr = atrBefore(c, n),
    out: H1State[] = [];
  let dir: "UP" | "DOWN" | null = null,
    ext = -1,
    start = -1,
    mn = -1,
    low = -1,
    peak = -1;
  const grow = (j: number, up: boolean): void => {
    if (mn < 0 || c[j].oi1 < c[mn].oi1) {
      mn = j;
      return;
    }
    const ok = up ? c[j].close > c[mn].close : c[j].close < c[mn].close;
    if (
      ok &&
      c[j].oi1 - c[mn].oi1 > (peak >= 0 ? c[peak].oi1 - c[low].oi1 : 0)
    ) {
      low = mn;
      peak = j;
    }
  };
  for (let i = 0; i < c.length; i++) {
    if (!(atr[i] > 0)) continue;
    const x = c[i];
    if (dir === null) {
      dir = x.close >= x.open ? "UP" : "DOWN";
      ext = start = mn = i;
      continue;
    }
    const top: boolean = dir === "UP";
    grow(i, top);
    if (top ? x.high >= c[ext].high : x.low <= c[ext].low) ext = i;
    const back = top ? c[ext].high - x.close : x.close - c[ext].low;
    if (back >= k * atr[i]) {
      const moveOi = (ext === i ? x.oi0 : c[ext].oi1) - c[start].oi1,
        candleOi = x.oi1 - x.oi0;
      if (
        moveOi === 0 ||
        (candleOi !== 0 && Math.sign(candleOi) === -Math.sign(moveOi))
      ) {
        start = ext;
        ext = i;
        dir = top ? "DOWN" : "UP";
        mn = low = peak = -1;
        for (let j = Math.max(0, start - 1); j <= i; j++) grow(j, dir === "UP");
      }
    }
    const g = peak >= 0 ? (100 * (c[peak].oi1 - c[low].oi1)) / c[low].oi1 : 0;
    const gp =
      peak >= 0 ? (100 * (c[peak].close - c[low].close)) / c[low].close : 0;
    out.push({
      end: x.end,
      dir,
      growthOiPct: g,
      growthPricePct: gp,
      startT: c[Math.max(0, start)].t,
    });
  }
  return out;
}
/** the 1h state known at time t (the last 1h candle closed by t), or null */
export function h1At(states: readonly H1State[], t: number): H1State | null {
  let lo = 0,
    hi = states.length - 1,
    r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (states[m].end <= t) {
      r = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return r >= 0 ? states[r] : null;
}
/** is a 15m signal (side) at t inside a 1h move of its direction in which OI grew with the price? */
export function inH1Growth(
  states: readonly H1State[],
  t: number,
  side: "SHORT" | "LONG",
): boolean {
  const s = h1At(states, t);
  return (
    !!s && s.dir === (side === "SHORT" ? "UP" : "DOWN") && s.growthOiPct > 0
  );
}

/**
 * "FLUSH" LONG (Johnny, Oct 3 2026) -- NOT the mirror of the SHORT. A fall in which OI FALLS (longs liquidated /
 * stopped / closing: the market deleverages), then at the bottom OI starts to RISE (new positions) and a 15m candle
 * CLOSES at least 1 ATR above the low -> LONG at its close. This is exactly the directional change with the OI rule
 * (src/research/dc15.ts turns): a move built with OI DOWN ends only on a candle whose OI goes UP.
 *   rank  (default true)  the fall's |OI change| is bigger than every accepted move's of the `windowH` hours before
 *   green (default false) the turn candle must also be green
 * The mirror for SHORT (a rise with OI falling = shorts squeezed, then OI rising at the top) is the same with side
 * "SHORT"; only LONG is asked for now.
 */
export function flushSignals(
  c: readonly Candle[],
  k: number,
  n: number,
  windowH: number,
  opts: { rank?: boolean; green?: boolean; side?: "LONG" | "SHORT" } = {},
): PeakSignal[] {
  const want = opts.side ?? "LONG",
    rank = opts.rank !== false;
  const W = c.length > 0 ? c[0].end - c[0].t : 0;
  const idx = new Map(c.map((x, i) => [x.t, i]));
  const out: PeakSignal[] = [];
  for (const r of pastRank(turns(c, k, n, true), windowH)) {
    const t = r.turn;
    const side = t.newDir === "UP" ? "LONG" : "SHORT";
    if (side !== want || !(t.moveOiPct < 0) || !(t.candleOiPct > 0)) continue; // built with OI down, the turn with OI up
    if (rank && (r.rank !== 1 || r.prior === 0)) continue;
    const i = idx.get(t.t - W),
      s = idx.get(t.moveStartT),
      e = idx.get(t.extremeT);
    if (i === undefined || s === undefined || e === undefined) continue;
    const x = c[i];
    if (opts.green && !(side === "LONG" ? x.close > x.open : x.close < x.open))
      continue;
    out.push({
      t: t.t,
      side,
      price: t.price,
      startT: t.moveStartT,
      startPrice: c[s].close,
      peakT: c[e].end,
      buildOiPct: t.moveOiPct,
      extreme: t.extreme,
      extremeT: t.extremeT,
      movePct: t.movePct,
      fromPeakOiPct: t.candleOiPct,
      candleOiPct: t.candleOiPct,
      label: t.label,
      prior: r.prior,
    });
  }
  return out;
}
