import { MINUTE_MS, type Bucket, type Episode, type Regime, type Victim } from "./v9-core";

/**
 * "PRICE_OI" confirmation (operator's model) -- who is being closed is read
 * from PRICE DIRECTION while OI falls, not from the WebSocket liquidation side:
 *
 *   OI falling + price moving WITH the liquidation (SHORT victims: up)
 *        -> the victims are still being closed: the episode continues
 *   OI falling + price moving AGAINST it (SHORT victims: down)
 *        -> the OTHER side is being closed (stops + liquidations the feed
 *           never shows): the move is over -> CONFIRM
 *
 * Episode (victim V):
 *   START    first minute with V-dominant liquidations inside a falling-OI regime
 *   EXTEND   every later V-dominant liquidation minute (peak / extreme tracked)
 *   CONFIRM  first minute k after the peak V-liquidation minute such that
 *            k lies in a falling-OI regime (BIC-significant), and versus the
 *            minute before that regime's part after the peak ("base"):
 *            OI[k] < OI[base] and price[k] is beyond price[base] AGAINST V's move,
 *            with no V-dominant liquidation in (base, k].
 *            confirmTs = end of minute k.
 *
 * Episode measures used by the filters:
 *   priceMovePct / extremePrice   start -> extreme of the liquidation move
 *   oiDropPct                     OI cleared from start until that extreme
 * No price, size, duration or OI-magnitude threshold is used.
 */
const sideOf = (long: number, short: number): Victim => (long >= short ? "LONG" : "SHORT");

/** Optional "significant" confirmation. Both are derived from the data
 *  itself (typical one-minute noise of this symbol), never fixed numbers:
 *   minOiDrop     OI must be below the base by at least this (contracts)
 *   minReversal   price must be off the extreme by at least this (price units) */
export interface PriceOiSignificance { minOiDrop: number; minReversal: number }

/** Typical one-minute noise: median |change| between consecutive minutes. */
export function typicalMinuteNoise(buckets: readonly Bucket[]): PriceOiSignificance {
  const dOi: number[] = [], dP: number[] = [];
  for (let i = 1; i < buckets.length; i++) {
    const a = buckets[i - 1], b = buckets[i];
    if (Number.isFinite(a.oi) && Number.isFinite(b.oi) && b.oi !== a.oi) dOi.push(Math.abs(b.oi - a.oi));
    if (Number.isFinite(a.price) && Number.isFinite(b.price) && b.price !== a.price) dP.push(Math.abs(b.price - a.price));
  }
  const med = (v: number[]): number => { if (!v.length) return 0; v.sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  return { minOiDrop: med(dOi), minReversal: med(dP) };
}

export function priceOiEpisodes(buckets: readonly Bucket[], regimes: readonly Regime[], validUntil: number, significance?: PriceOiSignificance): Episode[] {
  const slopeAt = new Float64Array(buckets.length);
  const regimeStart = new Int32Array(buckets.length);
  for (const r of regimes) for (let i = r.a; i < r.b; i++) { slopeAt[i] = r.slope; regimeStart[i] = r.a; }
  const victimUsd = (b: Bucket, v: Victim): number => (v === "LONG" ? b.long : b.short);
  const dominant = (b: Bucket, v: Victim): boolean => b.count > 0 && sideOf(b.long, b.short) === v;
  const against = (v: Victim, p: number, base: number): boolean => (v === "LONG" ? p > base : p < base); // LONG victims = price fell; reversal = up

  const out: Episode[] = [];
  let i = 0;
  while (i < buckets.length) {
    const b = buckets[i];
    if (!(slopeAt[i] < 0 && b.count > 0)) { i++; continue; }
    const v = sideOf(b.long, b.short);
    const start = i;
    let peak = i, extremeIdx = i, lastVictim = i;
    let confirmIdx = -1;
    for (let k = i; k < buckets.length; k++) {
      const x = buckets[k];
      if (dominant(x, v)) {
        lastVictim = k; // victims still being closed: a reversal must start after this
        if (victimUsd(x, v) > victimUsd(buckets[peak], v)) peak = k;
      }
      if (Number.isFinite(x.price) && (v === "LONG" ? x.price < buckets[extremeIdx].price : x.price > buckets[extremeIdx].price)) extremeIdx = k;
      if (k <= peak || !(slopeAt[k] < 0) || dominant(x, v)) continue;
      // base: the minute before the falling-OI stretch that follows the last victim liquidation
      const base = buckets[Math.max(regimeStart[k], lastVictim + 1) - 1];
      const oiOk = significance ? base.oi - x.oi >= significance.minOiDrop && x.oi < base.oi : x.oi < base.oi;
      const priceOk = against(v, x.price, base.price) && (!significance || Math.abs(buckets[extremeIdx].price - x.price) >= significance.minReversal);
      if (oiOk && priceOk) { confirmIdx = k; break; }
    }
    const stop = confirmIdx >= 0 ? confirmIdx + 1 : buckets.length;
    let long = 0, short = 0, count = 0;
    for (let k = start; k < stop; k++) { long += buckets[k].long; short += buckets[k].short; count += buckets[k].count; }
    const startOi = buckets[Math.max(0, start - 1)].oi;
    let minOi = startOi;
    for (let k = start; k <= extremeIdx; k++) minOi = Math.min(minOi, buckets[k].oi);
    const startPrice = buckets[Math.max(0, start - 1)].price;
    const extremePrice = buckets[extremeIdx].price;
    const endTs = stop < buckets.length ? buckets[stop].ts : buckets[buckets.length - 1].ts + MINUTE_MS;
    out.push({
      start: buckets[start].ts, end: endTs, sIdx: start, eIdx: stop, victim: v, long, short, count,
      startOi, minOi, oiDropPct: startOi > 0 ? Math.max(0, ((startOi - minOi) / startOi) * 100) : NaN,
      startPrice, endPrice: buckets[stop - 1].price, extremePrice,
      priceMovePct: startPrice > 0 ? ((extremePrice - startPrice) / startPrice) * 100 : NaN,
      confirmTs: confirmIdx >= 0 ? buckets[confirmIdx].ts + MINUTE_MS : NaN,
      confirmSide: confirmIdx >= 0 ? (v === "LONG" ? "SHORT" : "LONG") : null, // the other side closing -> trade side = v
      endReason: confirmIdx >= 0 ? "PRICE_OI_REVERSAL" : "OPEN_AT_DATA_END",
      parts: 1, partRanges: [[start, stop]],
      rightCensored: confirmIdx < 0 || endTs > validUntil,
    });
    i = stop; // the next episode can start right after the confirmation
  }
  return out;
}
