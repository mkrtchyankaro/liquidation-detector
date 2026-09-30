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
 * After an event the counting restarts from the cleanup hour's OI.
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

function after(
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
  const res: CuAfter = { mfe24: 0, mae24: 0, mfe48: 0, mae48: 0, hit: {} };
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
  return res;
}

/** every accumulation (>= minAccPct) that was fully cleaned, oldest first */
export function findCleanups(
  h: readonly CuHour[],
  minAccPct: number,
): CuEvent[] {
  const out: CuEvent[] = [];
  let iL = -1,
    iP = -1;
  for (let i = 0; i < h.length; i++) {
    if (!(h[i].oi > 0)) continue;
    if (iL < 0) {
      iL = iP = i;
      continue;
    }
    if (h[i].oi > h[iP].oi) {
      iP = i;
      continue;
    }
    if (h[i].oi > h[iL].oi) continue;
    // back at (or below) the start
    const acc = pct(h[iL].oi, h[iP].oi);
    if (iP > iL && acc >= minAccPct) {
      const L = h[iL],
        P = h[iP],
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
        accPct: acc,
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
        after: confirmed ? after(h, i + 2, side, k.close) : null,
      });
    }
    iL = iP = i; // restart from here
  }
  return out;
}
