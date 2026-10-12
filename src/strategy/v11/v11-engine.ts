/**
 * V11 ENGINE -- "squeeze wick" (Johnny, Oct 12 2026). Pure functions, closed 1H candles only (causal, no lookahead).
 * The same rules as the research test (25 coins x 14 days, Binance 1h price + Binance OI 5m at the hour edges + our
 * liquidations), written for the SHORT and mirrored for the LONG (side "LONG": a fall instead of a rally, long
 * liquidations, a new low, ...). Every threshold is relative to the coin itself.
 *
 *  1. RALLY at the close of hour k: the price rose over the last `rallyHours` (6) hours by >= `rallyX` (2) x the coin's
 *     median |6h move| of the previous `normHours` (72) hours. The rally's start s = the lowest close of hours k-6..k.
 *  2. RALLY TYPE: OI from s to k vs the mean |hourly OI change| of the previous `oiNormHours` (24) hours:
 *       T1 = OI fell by more than `oiX` (1) x that (shorts closed / squeezed -- the best one in the test)
 *       T2 = OI rose by more than that (new money) · FLAT = otherwise
 *  3. WICK, within `watchHours` (12) hours after the rally close k (the FIRST one of that rally):
 *       a new high since s · short liquidations of the hour >= the coin's `liqPct` (85th) percentile of the 72 h before k
 *       (and >= $1) · the candle closes in its lower half · our liquidation data complete for that hour and the 3 before
 *     "meaningful" liquidations (only shown / an optional filter): >= minLiqUsd ($30K) AND >= minLiqX (2) x that percentile
 *  4. CONFIRMATION, the next `confirmCandles` (2) candles, each decided at its close:
 *       a high above the wick's high (above every high since the wick) -> CANCELLED
 *       OI rose in the candle (close > open) AND the candle's price change < +maxConfirmMovePct (0.3 %) -> CONFIRMED
 *       otherwise (OI fell / a strong green candle) -> wait for the next candle (none left = no trade)
 *  5. TRADE: SHORT at the open of the next hour · SL = the wick's high · TP = entry - R x (SL - entry)
 */
export const H = 3_600_000;

export type V11Side = "SHORT" | "LONG";
export type V11RallyType = "T1" | "T2" | "FLAT";

/** one closed 1H candle. t = the hour's open (ms, UTC). OI in coins. Liquidations in $ (short = shorts liquidated). */
export interface V11Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** OI at the hour's open / close (Binance openInterestHist 5m at t and t + 1h) */
  oo: number;
  oc: number;
  shortLiq: number;
  longLiq: number;
  /** our liquidation data for this hour is complete (enough minute rows written) */
  liqOk: boolean;
}

export interface V11Rule {
  rallyHours: number;
  rallyX: number;
  normHours: number;
  oiNormHours: number;
  oiX: number;
  watchHours: number;
  /** 0.85 = the 85th percentile */
  liqPct: number;
  minLiqUsd: number;
  minLiqX: number;
  confirmCandles: 1 | 2;
  maxConfirmMovePct: number;
}

/** the values tested (Oct 12) */
export const DEFAULT_V11_RULE: V11Rule = {
  rallyHours: 6, rallyX: 2, normHours: 72, oiNormHours: 24, oiX: 1, watchHours: 12,
  liqPct: 0.85, minLiqUsd: 30_000, minLiqX: 2, confirmCandles: 2, maxConfirmMovePct: 0.3,
};

export interface V11Rally {
  /** the rally's close = the end of hour k (ms) */
  t: number;
  /** the start s: the lowest (LONG: highest) close of the rally hours -- its hour's close time and price */
  startT: number;
  startPrice: number;
  closePrice: number;
  /** price change start -> k close, % (signed) */
  movePct: number;
  /** the coin's median |6h move| of the 72 h before, % */
  normPct: number;
  /** OI start -> k close, coins and % */
  oiChange: number;
  oiPct: number;
  /** the coin's mean |hourly OI change| of the 24 h before, coins */
  oiNorm: number;
  type: V11RallyType;
}

export interface V11Wick {
  /** the wick hour's open (ms) */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** liquidations of the squeezed side in the hour, $ */
  liqUsd: number;
  /** the coin's percentile of that side (72 h before the rally close), $ */
  liqNorm: number;
  meaningful: boolean;
  oiPct: number;
  rally: V11Rally;
}

export interface V11Confirm {
  /** the confirmation hour's open (ms) */
  t: number;
  /** 1 or 2: which candle after the wick */
  n: number;
  oiPct: number;
  pricePct: number;
}

export interface V11Signal {
  side: V11Side;
  wick: V11Wick;
  confirm: V11Confirm;
  /** the entry hour's open (ms) = the confirmation candle's close */
  entryT: number;
  /** the SL price = the wick's high (LONG: low) */
  stop: number;
}

export type V11Decision =
  | { kind: "SIGNAL"; signal: V11Signal }
  /** a wick was found at the candle that just closed -- confirmation is awaited */
  | { kind: "WICK"; wick: V11Wick }
  | { kind: "CANCELLED"; wick: V11Wick; t: number; why: string }
  /** a wick whose confirmation window ended without a confirmation */
  | { kind: "EXPIRED"; wick: V11Wick };

/** the research's quantile: the sorted value at index floor(p x n) (capped) */
export function quantile(v: readonly number[], p: number): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

const sgn = (side: V11Side): 1 | -1 => (side === "SHORT" ? 1 : -1);
const pct = (a: number, b: number): number => (100 * (b - a)) / a;

/** every bar in [from, to] exists */
function have(bars: ReadonlyArray<V11Bar | null>, from: number, to: number): boolean {
  if (from < 0 || to >= bars.length) return false;
  for (let i = from; i <= to; i++) if (!bars[i]) return false;
  return true;
}

/**
 * The rally (LONG: decline) at the close of hour k, or null. `bars` = consecutive hours (index i = one hour later than
 * i - 1; a missing hour is null).
 */
export function rallyAt(bars: ReadonlyArray<V11Bar | null>, k: number, side: V11Side, r: V11Rule = DEFAULT_V11_RULE): V11Rally | null {
  const d = sgn(side), N = r.normHours, R = r.rallyHours;
  if (!have(bars, k - N - R, k)) return null;
  const B = bars as ReadonlyArray<V11Bar>;
  const moves: number[] = [];
  for (let i = k - N; i < k; i++) moves.push(Math.abs(B[i].c / B[i - R].c - 1));
  const m6 = quantile(moves, 0.5);
  let s = k - R;
  for (let i = k - R + 1; i <= k; i++) if (d * B[i].c < d * B[s].c) s = i;   // the first one on a tie
  const mv = d * (B[k].c / B[s].c - 1);
  if (s === k || mv < r.rallyX * m6) return null;
  let sum = 0;
  for (let i = k - r.oiNormHours; i < k; i++) sum += Math.abs(B[i].oc - B[i].oo);
  const mabs = sum / r.oiNormHours;
  const doi = B[k].oc - B[s].oc;
  const type: V11RallyType = doi < -r.oiX * mabs ? "T1" : doi > r.oiX * mabs ? "T2" : "FLAT";
  return {
    t: B[k].t + H, startT: B[s].t + H, startPrice: B[s].c, closePrice: B[k].c, movePct: pct(B[s].c, B[k].c), normPct: 100 * m6,
    oiChange: doi, oiPct: pct(B[s].oc, B[k].oc), oiNorm: mabs, type,
  };
}

const liqOf = (b: V11Bar, side: V11Side): number => (side === "SHORT" ? b.shortLiq : b.longLiq);

/** is hour j a wick of the rally at k (the conditions only, not "the first one") */
function wickCond(B: ReadonlyArray<V11Bar>, k: number, s: number, j: number, side: V11Side, norm: number): boolean {
  const d = sgn(side), x = B[j];
  let top = -Infinity;                                  // d x (the extreme since s, before j)
  for (let i = s; i < j; i++) top = Math.max(top, d * (d > 0 ? B[i].h : B[i].l));
  const ext = d > 0 ? x.h : x.l;
  const newTop = d * ext > top;
  const liqOk = B[j - 3].liqOk && B[j - 2].liqOk && B[j - 1].liqOk && x.liqOk;
  const lowerHalf = d * (x.c - (x.h + x.l) / 2) < 0;
  return liqOk && newTop && liqOf(x, side) >= Math.max(norm, 1) && lowerHalf;
}

/**
 * Is the candle at index w a wick (the FIRST one after some rally of the last `watchHours` hours)? When several rallies
 * qualify, the one reported is the best type -- T1, else T2, else FLAT (the earliest of that type) -- exactly as the
 * research list was made (checked: the same 112 wicks, types and "meaningful" flags, the same 44 entries and results).
 */
export function wickAt(bars: ReadonlyArray<V11Bar | null>, w: number, side: V11Side, r: V11Rule = DEFAULT_V11_RULE): V11Wick | null {
  const all = wicksAt(bars, w, side, r);
  if (!all.length) return null;
  const rank = { T1: 0, T2: 1, FLAT: 2 } as const;
  return all.reduce((a, b) => (rank[b.rally.type] < rank[a.rally.type] ? b : a));
}

/** every rally of the last `watchHours` hours whose FIRST wick is the candle at w (earliest rally first) */
export function wicksAt(bars: ReadonlyArray<V11Bar | null>, w: number, side: V11Side, r: V11Rule = DEFAULT_V11_RULE): V11Wick[] {
  const found: V11Wick[] = [];
  for (let k = w - r.watchHours; k <= w - 1; k++) {
    const rally = rallyAt(bars, k, side, r);
    if (!rally || !have(bars, k, w) || w - 3 < 0 || !have(bars, w - 3, w)) continue;
    const B = bars as ReadonlyArray<V11Bar>;
    const s = B.findIndex((b) => b && b.t + H === rally.startT);
    const norm = quantile(B.slice(k - r.normHours, k).map((b) => liqOf(b, side)), r.liqPct);
    if (!wickCond(B, k, s, w, side, norm)) continue;
    // the FIRST wick of this rally only
    let earlier = false;
    for (let j = k + 1; j < w && !earlier; j++) if (j - 3 >= 0 && have(bars, j - 3, j) && wickCond(B, k, s, j, side, norm)) earlier = true;
    if (earlier) continue;
    const x = B[w], liq = liqOf(x, side);
    found.push({
      t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, liqUsd: liq, liqNorm: norm,
      meaningful: liq >= r.minLiqUsd && liq >= r.minLiqX * norm, oiPct: pct(x.oo, x.oc), rally,
    });
  }
  return found;
}

/**
 * Everything decided at the close of candle i (the last closed one): a signal (enter at the next hour's open), a new
 * wick waiting for its confirmation, a cancelled / expired one. At most one SIGNAL per call.
 */
export function decideAt(bars: ReadonlyArray<V11Bar | null>, i: number, side: V11Side, r: V11Rule = DEFAULT_V11_RULE): V11Decision[] {
  const d = sgn(side), out: V11Decision[] = [];
  const ext = (b: V11Bar): number => d * (d > 0 ? b.h : b.l);
  const confirms = (b: V11Bar): boolean => b.oc > b.oo && d * (b.c / b.o - 1) < r.maxConfirmMovePct / 100;
  for (let n = r.confirmCandles; n >= 1; n--) {
    const w = i - n;
    if (w < 0 || !have(bars, w, i)) continue;
    const wick = wickAt(bars, w, side, r);
    if (!wick) continue;
    const B = bars as ReadonlyArray<V11Bar>;
    // the candles after the wick, up to i: each one first checked for a new extreme, then for the confirmation
    let top = ext(B[w]), state: "WAIT" | "DONE" = "WAIT";
    for (let m = 1; m <= n && state === "WAIT"; m++) {
      const y = B[w + m];
      if (ext(y) > top) {
        if (m === n) out.push({ kind: "CANCELLED", wick, t: y.t, why: `${d > 0 ? "a new high" : "a new low"} ${d > 0 ? y.h : y.l} beyond the wick's ${d > 0 ? wick.h : wick.l}` });
        state = "DONE";
        break;
      }
      top = Math.max(top, ext(y));
      if (confirms(y)) {
        if (m === n) out.push({ kind: "SIGNAL", signal: { side, wick, confirm: { t: y.t, n: m, oiPct: pct(y.oo, y.oc), pricePct: pct(y.o, y.c) }, entryT: y.t + H, stop: d > 0 ? wick.h : wick.l } });
        state = "DONE";
      }
    }
    if (state === "WAIT" && n === r.confirmCandles) out.push({ kind: "EXPIRED", wick });
  }
  const now = wickAt(bars, i, side, r);
  if (now) out.push({ kind: "WICK", wick: now });
  return out;
}

/** TP price for R (the reward in risks) from the entry and the SL */
export function tpFor(side: V11Side, entry: number, stop: number, rr: number): number {
  // SHORT: stop above -> TP below; LONG: stop below -> TP above. Both: entry - R x (stop - entry)
  void side;
  return entry - rr * (stop - entry);
}
