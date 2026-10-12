/**
 * OI ZIGZAG -- the Open Interest line cut into alternating waves
 * (research only, never trades). Idea agreed with Johnny, Sep 25 2026.
 *
 *   A wave ends when OI has moved back from its extreme by more than R
 *   (a % of OI, set per coin from its own normal OI movement). Smaller
 *   moves are noise and never cut a wave -- so every wave is >= R and waves
 *   strictly alternate DOWN / UP / DOWN ...
 *
 *   DOWN wave with victim liquidations and price moving against them =
 *     CLEANING (positions closed: liquidations + stops + TPs + manual)
 *   UP wave right after it = ACCUMULATION (new positions in the zone)
 *   next DOWN wave = RESOLUTION (the new positions closing)
 *
 * All sizes in COINS (OI is reported in the coin), never USD, so a price
 * change does not distort them.
 *
 * Hypothesis to test: depth = price move / coins closed in the cleaning;
 * expected move = depth x coins opened in the accumulation; compare with the
 * real price move of the resolution wave.
 */
export interface ZBar { ts: number; high: number; low: number; close: number; oi: number; longLiq: number; shortLiq: number }

export interface Pivot { idx: number; ts: number; oi: number; kind: "HIGH" | "LOW"; confirmedIdx: number; confirmedTs: number }

export type WaveKind = "LONG_CLEANING" | "SHORT_CLEANING" | "OI_DOWN" | "OI_UP";

export interface Wave {
  from: Pivot; to: Pivot; kind: WaveKind; confirmed: boolean;
  minutes: number;
  oiStart: number; oiEnd: number; coins: number;      // coins = |OI change|
  oiChangePct: number;
  priceStart: number; priceEnd: number; priceLow: number; priceHigh: number;
  longLiqUsd: number; shortLiqUsd: number;
}

/** Reversal threshold per bar: a fixed % or, for honest (no look-ahead)
 *  work, a per-bar array built only from data up to that bar. */
export type Threshold = number | readonly number[];
const at = (t: Threshold, i: number): number => (typeof t === "number" ? t : t[i]);

/** Classic zigzag on OI with a relative reversal threshold rPct (% of OI). */
/** `topConfirmFactor` < 1: the END of an UP wave (the accumulation top) is
 *  confirmed by a smaller pull-back (e.g. 0.5 x R) -- earlier entries; all
 *  other turns still need the full R. */
export function oiPivots(bars: readonly ZBar[], rPct: Threshold, topConfirmFactor = 1): { pivots: Pivot[]; lastExtreme: Pivot | null } {
  const pivots: Pivot[] = [];
  const i0 = bars.findIndex((b) => b.oi > 0);
  if (i0 < 0) return { pivots, lastExtreme: null };
  let trend: 1 | -1 | 0 = 0;
  let hi = bars[i0].oi, hiIdx = i0, lo = bars[i0].oi, loIdx = i0;
  const mk = (idx: number, kind: Pivot["kind"], conf: number): Pivot => ({ idx, ts: bars[idx].ts, oi: bars[idx].oi, kind, confirmedIdx: conf, confirmedTs: bars[conf].ts });
  for (let i = i0 + 1; i < bars.length; i++) {
    const v = bars[i].oi;
    const r = at(rPct, i) / 100;
    if (!(v > 0) || !(r > 0)) { if (v > hi) { hi = v; hiIdx = i; } if (v > 0 && v < lo) { lo = v; loIdx = i; } continue; }
    if (v > hi) { hi = v; hiIdx = i; }
    if (v < lo) { lo = v; loIdx = i; }
    const rTop = trend === 1 ? r * topConfirmFactor : r;
    if (trend >= 0 && v <= hi * (1 - rTop) && hiIdx < i) {
      if (trend === 0 && hiIdx > i0) pivots.push(mk(i0, "LOW", i)); // the data start is the first wave's start
      pivots.push(mk(hiIdx, "HIGH", i));
      trend = -1; lo = v; loIdx = i;
    } else if (trend <= 0 && v >= lo * (1 + r) && loIdx < i) {
      if (trend === 0 && loIdx > i0) pivots.push(mk(i0, "HIGH", i));
      pivots.push(mk(loIdx, "LOW", i));
      trend = 1; hi = v; hiIdx = i;
    }
  }
  const clean = pivots;
  const last = trend === 1 ? mk(hiIdx, "HIGH", bars.length - 1) : trend === -1 ? mk(loIdx, "LOW", bars.length - 1) : null;
  return { pivots: clean, lastExtreme: last };
}

export function buildWaves(bars: readonly ZBar[], rPct: Threshold, topConfirmFactor = 1): Wave[] {
  const { pivots, lastExtreme } = oiPivots(bars, rPct, topConfirmFactor);
  const pts = lastExtreme && pivots.length && lastExtreme.idx > pivots[pivots.length - 1].idx ? [...pivots, lastExtreme] : pivots;
  const waves: Wave[] = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    let lo = Infinity, hi = -Infinity, ll = 0, sl = 0;
    for (let i = a.idx + 1; i <= b.idx; i++) { lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high); ll += bars[i].longLiq; sl += bars[i].shortLiq; }
    const down = b.oi < a.oi;
    const pStart = bars[a.idx].close, pEnd = bars[b.idx].close;
    let kind: WaveKind = down ? "OI_DOWN" : "OI_UP";
    if (down) {
      // price moved against the side that got liquidated more
      if (ll > sl && ll > 0 && lo < pStart) kind = "LONG_CLEANING";
      else if (sl > ll && sl > 0 && hi > pStart) kind = "SHORT_CLEANING";
    }
    waves.push({
      from: a, to: b, kind, confirmed: !(lastExtreme && b === lastExtreme), minutes: b.idx - a.idx,
      oiStart: a.oi, oiEnd: b.oi, coins: Math.abs(b.oi - a.oi), oiChangePct: ((b.oi - a.oi) / a.oi) * 100,
      priceStart: pStart, priceEnd: pEnd, priceLow: lo, priceHigh: hi, longLiqUsd: ll, shortLiqUsd: sl,
    });
  }
  return waves;
}

/** Quality of a cleaning wave, each measure relative to the coin's normal:
 *  speed      OI drop per minute (over the active 10%-90% part of the drop)
 *             / the coin's normal OI change per minute
 *  forced     victim liquidations $ / OI drop $  (how much of it was forced)
 *  pushAtr    price move / ATR(14 x 15-min candles) BEFORE the wave
 *  grade      A: speed >= 10, forced >= 10%, push >= 3 ATR
 *             B: speed >= 5,  forced >= 3%,  push >= 2 ATR      else C */
export interface Quality { speed: number; forcedPct: number; pushAtr: number; atr: number; grade: "A" | "B" | "C" }

export interface ChainTrade {
  /** when the accumulation's end became KNOWN (OI dropped R from its top) */
  decidedTs: number; entry: number;
  /** price already moved from the accumulation end to the decision moment */
  alreadyMoved: number; remaining: number;
  side: "LONG" | "SHORT" | null; skipReason: string | null;
  result: "TP" | "SL" | "OPEN" | null; netR: number | null; minutes: number | null;
  slPrice: number | null; tpPrice: number | null; exitTs: number | null; exitPrice: number | null;
  /** minutes from the OI top (so far) to the decision -- how late we are */
  lateMin: number;
  /** expected move used for this decision (early modes: from the coins opened SO FAR) */
  expected: number;
}

/** WHEN to enter after a cleaning (the waves themselves always use the full R):
 *   TOP       (default, live) the accumulation top confirmed by an R pull-back
 *   GIVEBACK  OI gave back `share` (e.g. 0.2) of its rise since the cleaning bottom
 *   STALL     OI made no new high for `min` minutes
 *   BREAKOUT  OI no new high for `stallMin` minutes AND the price closed
 *             outside the accumulation zone (its low/high since the bottom)
 *  Early modes look minute by minute from the moment the cleaning bottom is
 *  known until the full-R top is confirmed, using only data up to that
 *  minute; the first minute that meets the rule AND shows a direction
 *  (price moved >= 0.05% from the OI top) is the decision. If nothing fires
 *  before the R pull-back confirms the top, the normal TOP decision is used
 *  -- so an early mode is never later than live. */
export type EntryMode = { kind: "TOP" } | { kind: "GIVEBACK"; share: number } | { kind: "STALL"; min: number } | { kind: "BREAKOUT"; stallMin: number };

export interface Chain {
  cleaning: Wave; accumulation: Wave | null; resolution: Wave | null;
  quality: Quality;
  /** price move of the cleaning (to its extreme), absolute, in quote currency */
  cleaningMove: number;
  /** price move per 1,000 coins closed */
  depthPer1k: number;
  expectedMove: number | null;
  /** CALIBRATED mode: the coin's learned depth (ATR per 1% OI) and how many waves it came from */
  calibration: { atrPerOiPct: number; waves: number } | null;
  /** resolution wave, measured from the accumulation's end price */
  actualUp: number | null; actualDown: number | null;
  trade: ChainTrade | null;
}

/** Stop / target:
 *   TARGET (default, Johnny): TP = tpShare (default 100%) of the remaining expected
 *     move (expected minus what the price already did) -- a reserve so a
 *     move that falls just short still pays; SL = remaining / rr. Skipped when that SL
 *     would be closer than minSlPct (fees would eat it).
 *   STRUCTURE: SL just beyond the last extreme since the OI top
 *     (the swing the price made before turning) + atrBuffer x ATR(15m),
 *     never closer than minSlPct (fees); TP = rr x that risk.
 *   PCT: fixed slPct / tpPct.
 *  maxConfirmDelayMin: skip when the OI top became known too long after it
 *  happened (the move is gone). The expected move is capped at the
 *  cleaning's own move (new positions > closed ones would give absurd targets). */
export interface ChainParams {
  noise15Pct: Threshold; horizonMin: number;
  slMode: "TARGET" | "STRUCTURE" | "PCT"; slPct: number; tpPct: number;
  rr: number; atrBuffer: number; minSlPct: number; maxConfirmDelayMin: number;
  /** TARGET mode: TP is placed at this share of the remaining move (a reserve,
   *  so a move that falls just short still pays); SL stays remaining / rr. */
  tpShare: number;
  /** How the expected move is estimated:
   *   CLEANING   (default) depth = this cleaning's price move / coins it closed
   *   CALIBRATED (Johnny's "ZZ-ATR" idea) depth learned from ALL waves of the
   *              coin that completed in the last 24h: median(price move in ATR
   *              per 1% OI change); expected = depth x accumulation OI% x ATR now.
   *              Falls back to CLEANING with fewer than minCalibWaves waves. */
  depthMode: "CLEANING" | "CALIBRATED";
  minCalibWaves: number;
  /** when to enter (default TOP = live behaviour) */
  entryMode?: EntryMode;
}
export const DEFAULT_CHAIN_PARAMS: Omit<ChainParams, "noise15Pct"> = {
  horizonMin: 24 * 60, slMode: "TARGET", slPct: 0.3, tpPct: 0.7, rr: 2.2, atrBuffer: 0.25, minSlPct: 0.3, maxConfirmDelayMin: 20, tpShare: 1, depthMode: "CLEANING", minCalibWaves: 8,
};
const TAKER = 0.05, MAKER = 0.02; // % of notional

/** ATR of 14 fifteen-minute candles ending at bar index `end` (exclusive). */
export function atr15Before(bars: readonly ZBar[], end: number): number {
  const trs: number[] = [];
  let prevClose = NaN;
  for (let c = end - 15 * 15; c + 15 <= end; c += 15) {
    if (c < 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let i = c; i < c + 15; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    const tr = Number.isFinite(prevClose) ? Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose)) : hi - lo;
    if (Number.isFinite(prevClose)) trs.push(tr);
    prevClose = bars[c + 14].close;
  }
  const last = trs.slice(-14);
  return last.length ? last.reduce((a, b) => a + b, 0) / last.length : NaN;
}

export function quality(bars: readonly ZBar[], w: Wave, move: number, noise15Pct: number): Quality {
  // Speed over the ACTIVE part (10% -> 90% of the OI drop): a wave's start
  // pivot can sit on a long flat OI stretch before the real drop.
  const drop = w.oiStart - w.oiEnd;
  let i10 = w.from.idx, i90 = w.to.idx;
  for (let i = w.from.idx; i <= w.to.idx; i++) if (bars[i].oi <= w.oiStart - 0.1 * drop) { i10 = i; break; }
  for (let i = i10; i <= w.to.idx; i++) if (bars[i].oi <= w.oiStart - 0.9 * drop) { i90 = i; break; }
  const perMin = (0.8 * Math.abs(w.oiChangePct)) / Math.max(1, i90 - i10);
  const speed = perMin / (noise15Pct / 15);
  const victim = w.kind === "SHORT_CLEANING" ? w.shortLiqUsd : w.longLiqUsd;
  const oiUsd = w.coins * ((w.priceStart + w.priceEnd) / 2);
  const forcedPct = oiUsd > 0 ? (100 * victim) / oiUsd : 0;
  const atr = atr15Before(bars, i10);
  const pushAtr = atr > 0 ? move / atr : NaN;
  const grade = speed >= 10 && forcedPct >= 10 && pushAtr >= 3 ? "A" : speed >= 5 && forcedPct >= 3 && pushAtr >= 2 ? "B" : "C";
  return { speed, forcedPct, pushAtr, atr, grade };
}

/** The coin's normal OI move BEFORE the wave; if the wave starts before
 *  enough history exists, the first value known by the wave's end. */
function normalAt(t: Threshold, w: Wave): number {
  const v = at(t, w.from.idx);
  return Number.isFinite(v) ? v : at(t, w.to.idx);
}

/** Cleaning -> accumulation -> resolution sequences, graded, with the
 *  late-entry test: at the moment the accumulation's end is KNOWN, the price
 *  has already moved some way -- that shows the direction and is subtracted
 *  from the expected move; trade only if what remains >= the TP distance. */
export function buildChains(waves: readonly Wave[], bars: readonly ZBar[], p: ChainParams): Chain[] {
  const out: Chain[] = [];
  const atrCache = new Map<number, number>();
  const atrAt = (i: number): number => { if (!atrCache.has(i)) atrCache.set(i, atr15Before(bars, i)); return atrCache.get(i)!; };
  for (let k = 0; k < waves.length; k++) {
    const w = waves[k];
    if (w.kind !== "LONG_CLEANING" && w.kind !== "SHORT_CLEANING") continue;
    const cleaningMove = w.kind === "LONG_CLEANING" ? w.priceStart - w.priceLow : w.priceHigh - w.priceStart;
    const depthPer1k = w.coins > 0 ? cleaningMove / (w.coins / 1000) : NaN;
    const acc = waves[k + 1] ?? null;
    const res = waves[k + 2] ?? null;
    let expectedMove: number | null = acc ? Math.min(cleaningMove, depthPer1k * (acc.coins / 1000)) : null;
    let calib: Chain["calibration"] = null;
    if (acc && p.depthMode === "CALIBRATED") {
      calib = calibrate(waves, bars, acc.to.confirmedIdx, atrAt, p.minCalibWaves);
      const atrNow = atrAt(acc.to.confirmedIdx + 1);
      if (calib && atrNow > 0) expectedMove = Math.min(cleaningMove, calib.atrPerOiPct * Math.abs(acc.oiChangePct) * atrNow);
    }
    const base = acc ? acc.priceEnd : NaN;
    out.push({
      cleaning: w, accumulation: acc, resolution: res, quality: quality(bars, w, cleaningMove, normalAt(p.noise15Pct, w)),
      cleaningMove, depthPer1k, expectedMove, calibration: calib,
      actualUp: res ? Math.max(0, res.priceHigh - base) : null,
      actualDown: res ? Math.max(0, base - res.priceLow) : null,
      trade: !acc || expectedMove === null ? null
        : (p.entryMode?.kind ?? "TOP") === "TOP" ? (acc.confirmed ? lateEntry(bars, acc, expectedMove, p) : null)
        : earlyEntry(bars, w, acc, cleaningMove, depthPer1k, p),
    });
  }
  return out;
}

/** Live runs ONE trade per symbol at a time (A/B only). Research must do the
 *  same, or overlapping trades are counted that live would never open.
 *  A later A/B trade decided while an earlier one is still open becomes
 *  "another trade still open". C-grade trades are not traded and ignored. */
export function oneTradeAtATime(chains: readonly Chain[]): Chain[] {
  let busyUntil = -Infinity;
  return [...chains].sort((a, b) => (a.trade?.decidedTs ?? 0) - (b.trade?.decidedTs ?? 0)).map((c) => {
    const t = c.trade;
    if (!t || c.quality.grade === "C" || !t.result) return c;
    if (t.decidedTs < busyUntil) return { ...c, trade: { ...t, result: null, netR: null, exitTs: null, exitPrice: null, minutes: null, skipReason: "another trade still open" } };
    busyUntil = t.result === "OPEN" ? Infinity : t.exitTs ?? Infinity;
    return c;
  });
}

/** The coin's own "depth" from every wave that was COMPLETE (its end known)
 *  by `decisionIdx` and ended in the 24h before it: price move (largest
 *  excursion from the wave start, in ATR at the wave start) per 1% OI change.
 *  Median, so one odd wave cannot dominate. No look-ahead. */
export function calibrate(waves: readonly Wave[], bars: readonly ZBar[], decisionIdx: number, atrAt: (i: number) => number, minWaves: number): { atrPerOiPct: number; waves: number } | null {
  const from = bars[decisionIdx].ts - 24 * 3_600_000;
  const r: number[] = [];
  for (const w of waves) {
    if (!w.confirmed || w.to.confirmedIdx > decisionIdx || w.to.ts < from) continue;
    const atr = atrAt(w.from.idx);
    const oiPct = Math.abs(w.oiChangePct);
    if (!(atr > 0) || !(oiPct > 0)) continue;
    const move = Math.max(w.priceHigh - w.priceStart, w.priceStart - w.priceLow);
    r.push(move / atr / oiPct);
  }
  if (r.length < minWaves) return null;
  r.sort((a, b) => a - b);
  return { atrPerOiPct: r[r.length >> 1], waves: r.length };
}

function lateEntry(bars: readonly ZBar[], acc: Wave, expected: number, p: ChainParams): ChainTrade {
  return entryAt(bars, acc.to.confirmedIdx, acc.to.idx, expected, p);
}

const MIN_DIRECTION = 0.0005; // price must have moved >= 0.05% from the OI top to show a direction

/** Early entry modes (see EntryMode). No look-ahead: at minute i only bars <= i are used. */
function earlyEntry(bars: readonly ZBar[], cleaning: Wave, acc: Wave, cleaningMove: number, depthPer1k: number, p: ChainParams): ChainTrade | null {
  const mode = p.entryMode!;
  const b0 = cleaning.to.idx, bottomOi = cleaning.to.oi;
  const start = cleaning.to.confirmedIdx; // the cleaning bottom is known from here
  const end = acc.confirmed ? acc.to.confirmedIdx : bars.length - 1;
  let peak = bottomOi, peakIdx = b0;
  let zLo = bars[b0].low, zHi = bars[b0].high;
  for (let i = b0 + 1; i <= end; i++) {
    const b = bars[i];
    if (b.oi > peak) { peak = b.oi; peakIdx = i; }
    if (i >= start && i > peakIdx) {
      const rise = peak - bottomOi;
      const stalled = i - peakIdx;
      const fire = mode.kind === "GIVEBACK" ? rise > 0 && b.oi <= peak - mode.share * rise
        : mode.kind === "STALL" ? stalled >= mode.min
        : mode.kind === "BREAKOUT" ? stalled >= mode.stallMin && (b.close > zHi || b.close < zLo)
        : false;
      if (fire && Math.abs(b.close - bars[peakIdx].close) >= b.close * MIN_DIRECTION) {
        const expected = Math.min(cleaningMove, depthPer1k * (rise / 1000));
        return entryAt(bars, i, peakIdx, expected, p);
      }
    }
    // the zone is updated AFTER the check: a breakout compares with the range known before this minute
    zLo = Math.min(zLo, b.low); zHi = Math.max(zHi, b.high);
  }
  if (!acc.confirmed) return null; // still running, nothing yet
  // no early signal: the normal decision when the R pull-back confirms the top (never LATER than live)
  return lateEntry(bars, acc, Math.min(cleaningMove, depthPer1k * (acc.coins / 1000)), p);
}

/** Decision at bar i0; the OI top (so far) was at topIdx. */
function entryAt(bars: readonly ZBar[], i0: number, topIdx: number, expected: number, p: ChainParams): ChainTrade {
  const entry = bars[i0].close;
  const alreadyMoved = entry - bars[topIdx].close;
  const remaining = expected - Math.abs(alreadyMoved);
  const delay = i0 - topIdx;
  const t: ChainTrade = { decidedTs: bars[i0].ts, entry, alreadyMoved, remaining, side: null, skipReason: null, result: null, netR: null, minutes: null, slPrice: null, tpPrice: null, exitTs: null, exitPrice: null, lateMin: delay, expected };
  if (delay > p.maxConfirmDelayMin) return { ...t, skipReason: `OI top known ${delay}m late` };
  if (Math.abs(alreadyMoved) < entry * MIN_DIRECTION) return { ...t, skipReason: "no direction yet" };
  const long = alreadyMoved > 0;
  const side = long ? "LONG" : "SHORT";
  let sl: number, tp: number;
  if (p.slMode === "TARGET") {
    if (!(remaining > 0)) return { ...t, side, skipReason: "nothing left of the expected move" };
    const slDist = remaining / p.rr;
    tp = long ? entry + p.tpShare * remaining : entry - p.tpShare * remaining;
    sl = long ? entry - slDist : entry + slDist;
    // skipped, but the would-be levels are kept so the message can show them
    if (slDist < entry * (p.minSlPct / 100)) return { ...t, side, slPrice: sl, tpPrice: tp, skipReason: `SL would be ${((100 * slDist) / entry).toFixed(3)}% < ${p.minSlPct}% (fees)` };
  } else if (p.slMode === "PCT") {
    sl = long ? entry * (1 - p.slPct / 100) : entry * (1 + p.slPct / 100);
    tp = long ? entry * (1 + p.tpPct / 100) : entry * (1 - p.tpPct / 100);
  } else {
    // last extreme on the other side since the OI top, known at decision time
    let ext = long ? Infinity : -Infinity;
    for (let i = topIdx; i <= i0; i++) ext = long ? Math.min(ext, bars[i].low) : Math.max(ext, bars[i].high);
    const atr = atr15Before(bars, i0 + 1);
    const buf = Number.isFinite(atr) ? p.atrBuffer * atr : 0;
    sl = long ? ext - buf : ext + buf;
    const minDist = entry * (p.minSlPct / 100);
    if (Math.abs(entry - sl) < minDist) sl = long ? entry - minDist : entry + minDist;
    const risk = Math.abs(entry - sl);
    tp = long ? entry + p.rr * risk : entry - p.rr * risk;
  }
  const risk = Math.abs(entry - sl), slPct = (100 * risk) / entry, rr = Math.abs(tp - entry) / risk;
  // tolerance: in TARGET mode TP distance == remaining; float rounding must not skip it
  if (remaining < Math.abs(tp - entry) - entry * 1e-9) return { ...t, side, slPrice: sl, tpPrice: tp, skipReason: "remaining < TP" };
  const at = { ...t, side, slPrice: sl, tpPrice: tp } as const;
  for (let i = i0 + 1; i < bars.length && i - i0 <= p.horizonMin; i++) {
    const b = bars[i];
    const hitSl = long ? b.low <= sl : b.high >= sl;
    const hitTp = long ? b.high >= tp : b.low <= tp;
    // SL first when both are touched in the same minute (conservative)
    if (hitSl) return { ...at, result: "SL", netR: -1 - (2 * TAKER) / slPct, minutes: i - i0, exitTs: b.ts, exitPrice: sl };
    if (hitTp) return { ...at, result: "TP", netR: rr - (TAKER + MAKER) / slPct, minutes: i - i0, exitTs: b.ts, exitPrice: tp };
  }
  return { ...at, result: "OPEN", netR: 0, minutes: null };
}

/** NO LOOK-AHEAD version of medianOi15mPct: for every bar, the median
 *  |15-min OI change| over the `lookbackMin` minutes BEFORE it (recomputed
 *  every 15 minutes). NaN until `minHistoryMin` of history exists.
 *  `quantile` 0.5 = median (the coin's normal move); 0.9 = P90 (a move
 *  bigger than 90% of the coin's 15-minute OI moves). */
export function trailingOiNoise(bars: readonly ZBar[], lookbackMin = 2 * 1440, minHistoryMin = 240, quantile = 0.5): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  let cur = NaN;
  for (let i = 0; i < bars.length; i++) {
    if (i % 15 === 0 && i >= minHistoryMin) {
      const v: number[] = [];
      for (let j = Math.max(15, i - lookbackMin); j <= i; j += 5) {
        const a = bars[j - 15].oi, b = bars[j].oi;
        if (a > 0 && b > 0) v.push((Math.abs(b - a) / a) * 100);
      }
      v.sort((x, y) => x - y);
      cur = v.length ? v[Math.min(v.length - 1, Math.floor(quantile * v.length))] : NaN;
    }
    out[i] = cur;
  }
  return out;
}

/** Coin's normal OI noise: median |OI change| over 15 minutes, in %
 *  (whole period -- descriptive only; decisions use trailingOiNoise). */
export function medianOi15mPct(bars: readonly ZBar[]): number {
  const v: number[] = [];
  for (let i = 15; i < bars.length; i += 5) {
    const a = bars[i - 15].oi, b = bars[i].oi;
    if (a > 0 && b > 0) v.push((Math.abs(b - a) / a) * 100);
  }
  v.sort((x, y) => x - y);
  return v.length ? v[v.length >> 1] : NaN;
}
