/**
 * OI ACCUMULATION -> FULL CLEANUP (Johnny, Sep 30 2026). Research only, 1h candles, looks back only.
 *
 * 1. ACCUMULATION: open interest grows from a low L to a peak P (small dips inside do not matter).
 *    The price direction of the accumulation = price at P vs price at L (UP / DOWN).
 * 2. FULL CLEANUP: the first hour whose OI closes back at L or lower -- everything that was built is gone
 *    (or even more). Who got liquidated does not matter, only the OI.
 * 3. WHERE the cleanup happened = price at the cleanup hour vs price at the peak:
 *      the same way as the accumulation (UP went further up / DOWN went further down) -> REVERSAL
 *      (trade against the accumulation); the other way -> CONTINUATION (trade with the accumulation).
 * 4. CONFIRMATION: the next 1h candle has the trade's colour and closes beyond the cleanup hour's close.
 *    Entry = its close. No SL / TP here: we only measure what the price did afterwards.
 */
export interface CuHour {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  oi: number;
} // oi = at the hour's close
export type CuKind = "REVERSAL" | "CONTINUATION";
export interface CuAfter {
  mfe24: number;
  mae24: number;
  mfe48: number;
  mae48: number;
  close48: number;
  hit: Record<string, { hours: number; maeBefore: number } | null>;
}
export interface CuEvent {
  accDir: "UP" | "DOWN";
  kind: CuKind;
  side: "LONG" | "SHORT";
  startTs: number;
  peakTs: number;
  cleanTs: number; // candle OPEN times (UTC)
  oiStart: number;
  oiPeak: number;
  oiClean: number;
  accPct: number;
  cleanedPct: number;
  priceStart: number;
  pricePeak: number;
  priceClean: number;
  accMovePct: number;
  cleanMovePct: number;
  confirmTs: number | null;
  confirmed: boolean;
  entryTs: number | null;
  entry: number | null;
  after: CuAfter | null;
}
export const CU_TARGETS = [1, 1.5, 2];
const H = 3_600_000;
const pct = (a: number, b: number): number => (100 * (b - a)) / a;

export function cuAfter(
  h: readonly CuHour[],
  i0: number,
  side: "LONG" | "SHORT",
  entry: number,
): CuAfter | null {
  if (i0 >= h.length) return null;
  const fav = (k: CuHour): number =>
    side === "LONG" ? pct(entry, k.high) : -pct(entry, k.low);
  const adv = (k: CuHour): number =>
    side === "LONG" ? -pct(entry, k.low) : pct(entry, k.high);
  const res: CuAfter = {
    mfe24: 0,
    mae24: 0,
    mfe48: 0,
    mae48: 0,
    close48: NaN,
    hit: {},
  };
  let mae = 0;
  for (let j = i0; j < Math.min(h.length, i0 + 48); j++) {
    const n = j - i0 + 1;
    mae = Math.max(mae, adv(h[j]));
    if (n <= 24) {
      res.mfe24 = Math.max(res.mfe24, fav(h[j]));
      res.mae24 = Math.max(res.mae24, adv(h[j]));
    }
    res.mfe48 = Math.max(res.mfe48, fav(h[j]));
    res.mae48 = Math.max(res.mae48, adv(h[j]));
    for (const x of CU_TARGETS)
      if (!(String(x) in res.hit) && fav(h[j]) >= x)
        res.hit[String(x)] = { hours: n, maeBefore: mae };
  }
  for (const x of CU_TARGETS)
    if (!(String(x) in res.hit)) res.hit[String(x)] = null;
  if (i0 + 47 < h.length)
    res.close48 =
      side === "LONG"
        ? pct(entry, h[i0 + 47].close)
        : -pct(entry, h[i0 + 47].close);
  return res;
}

/** simple exit for comparing: +tp% when reached within 48h, else the 48h close (null = not 48h old yet) */
export function tpOr48(a: CuAfter | null, tp: number): number | null {
  if (!a) return null;
  if (!CU_TARGETS.includes(tp))
    throw new Error(`tp must be one of ${CU_TARGETS.join(", ")}`);
  if (a.hit[String(tp)]) return tp;
  return Number.isFinite(a.close48) ? a.close48 : null;
}

/** the same exit from EVERY hour's close, both sides -- what "no signal at all" gives on this coin */
export function cuBaseline(
  h: readonly CuHour[],
  tp: number,
): { LONG: number[]; SHORT: number[] } {
  const out = { LONG: [] as number[], SHORT: [] as number[] };
  for (let j = 0; j + 48 < h.length; j++)
    for (const side of ["LONG", "SHORT"] as const) {
      const r = tpOr48(cuAfter(h, j + 1, side, h[j].close), tp);
      if (r !== null) out[side].push(r);
    }
  return out;
}

/**
 * every accumulation (>= minAccPct) that was fully cleaned, oldest first.
 * A peak = an hour whose OI has not been exceeded since. Its accumulation start = the lowest OI between the
 * last HIGHER OI before it and the peak (at most maxAccH hours back) -- so the result does not depend on where
 * the data window starts. The peak is fully cleaned at the first hour whose OI is back at that start or lower
 * (within maxAccH hours after the peak). If several peaks are cleaned in the same hour, the biggest one counts.
 */
export function findCleanups(
  h: readonly CuHour[],
  minAccPct: number,
  maxAccH = 48,
): CuEvent[] {
  const out: CuEvent[] = [];
  const stack: Array<{ p: number; l: number; used: boolean }> = []; // open peaks, OI strictly decreasing
  for (let i = 0; i < h.length; i++) {
    if (!(h[i].oi > 0)) continue;
    // 1. cleanups in this hour
    let best: { p: number; l: number; acc: number } | null = null;
    for (const e of stack) {
      if (e.used || i - e.p > maxAccH || e.l === e.p || h[i].oi > h[e.l].oi)
        continue;
      e.used = true;
      const acc = pct(h[e.l].oi, h[e.p].oi);
      if (acc >= minAccPct && (!best || acc > best.acc))
        best = { p: e.p, l: e.l, acc };
    }
    if (best) {
      const L = h[best.l],
        P = h[best.p],
        C = h[i];
      const accDir = P.close >= L.close ? "UP" : "DOWN";
      const cleanUp = C.close >= P.close;
      const kind: CuKind =
        (accDir === "UP") === cleanUp ? "REVERSAL" : "CONTINUATION";
      const side =
        kind === "REVERSAL"
          ? accDir === "UP"
            ? "SHORT"
            : "LONG"
          : accDir === "UP"
            ? "LONG"
            : "SHORT";
      const k = h[i + 1];
      const confirmed =
        !!k &&
        (side === "LONG"
          ? k.close > k.open && k.close > C.close
          : k.close < k.open && k.close < C.close);
      out.push({
        accDir,
        kind,
        side,
        startTs: L.t,
        peakTs: P.t,
        cleanTs: C.t,
        oiStart: L.oi,
        oiPeak: P.oi,
        oiClean: C.oi,
        accPct: best.acc,
        cleanedPct: (100 * (P.oi - C.oi)) / (P.oi - L.oi),
        priceStart: L.close,
        pricePeak: P.close,
        priceClean: C.close,
        accMovePct: pct(L.close, P.close),
        cleanMovePct: pct(P.close, C.close),
        confirmTs: k ? k.t : null,
        confirmed,
        entryTs: confirmed ? k.t + H : null,
        entry: confirmed ? k.close : null,
        after: confirmed ? cuAfter(h, i + 2, side, k.close) : null,
      });
    }
    // 2. this hour as a new peak
    while (stack.length && h[stack[stack.length - 1].p].oi <= h[i].oi)
      stack.pop();
    const higher = stack.length ? stack[stack.length - 1].p : -1;
    let l = i;
    for (let j = i - 1; j > higher && j >= i - maxAccH; j--)
      if (h[j].oi > 0 && h[j].oi < h[l].oi) l = j;
    stack.push({ p: i, l, used: false });
  }
  return out;
}
