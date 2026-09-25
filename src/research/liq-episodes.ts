/**
 * LIQUIDATION EPISODES -- definition agreed with Johnny (Sep 25 2026).
 * Research only: finds and measures episodes, never trades.
 *
 * LONG victims (SHORT is the mirror image):
 *   START    price falls, LONG liquidations happen and OI falls -- together
 *            (a minute with LONG liquidations where, over the last 3 minutes,
 *            both price and OI went down).
 *   BODY     continues while OI keeps making new lows. Small OI upticks are
 *            NOISE and ignored: an uptick smaller than `noise` (25%) of the
 *            OI drop so far -- or smaller than the coin's noise floor --
 *            does not end the episode.
 *   END      OI rises by >= `noise` of the drop from its lowest point. The
 *            episode's bottom is that lowest-OI minute. (If OI never rises
 *            that much, the episode is closed after `staleMin` without a new
 *            OI low, as NO_REBOUND.)
 *   AFTER    ACCUMULATION: from the bottom, OI keeps rising to a peak (ends
 *            when OI gives back `noise` of that rise, or after `accumMaxMin`).
 *            The price range there is the "zone".
 *
 * Three numbers per episode, in USD:
 *   liqUsd       forced liquidations of the victims
 *   oiDropUsd    all positions closed (net): liquidations + stop losses +
 *                take profits + manual closes. otherClosesUsd = oiDrop - liq.
 *   oiRiseUsd    new positions opened in the zone after the bottom
 *                ("how much money got interested in this zone").
 */
export type Victim = "LONG" | "SHORT";

export interface Bar { ts: number; high: number; low: number; close: number; oi: number; longLiq: number; shortLiq: number }

/** noiseFloorPct: an OI move smaller than this % of OI is ALWAYS noise, even
 *  when it is 25% of a tiny drop (set per coin from its normal OI movement). */
export interface EpisodeParams { noise: number; noiseFloorPct: number; staleMin: number; accumMaxMin: number }
export const DEFAULT_EPISODE_PARAMS: EpisodeParams = { noise: 0.25, noiseFloorPct: 0, staleMin: 360, accumMaxMin: 720 };

export interface LiqEpisode {
  victim: Victim;
  startTs: number; bottomTs: number; endTs: number; lastLiqTs: number;
  endReason: "OI_REBOUND" | "NO_REBOUND";
  durationMin: number;      // start -> OI bottom
  liqActiveMin: number;     // start -> last victim liquidation
  basePrice: number; extremePrice: number; movePct: number;
  liqUsd: number; oppLiqUsd: number;
  oiDropPct: number; oiDropUsd: number; otherClosesUsd: number;
  oiRisePct: number; oiRiseUsd: number; accumMin: number; zoneLow: number; zoneHigh: number;
}

const MINUTE_MS = 60_000;

/** Dense minute grid (missing minutes carry the last price/OI forward). */
export function denseBars(rows: ReadonlyArray<{ ts: number; high: number | null; low: number | null; close: number | null; oi: number | null; longLiq: number; shortLiq: number }>): Bar[] {
  if (rows.length === 0) return [];
  const byTs = new Map(rows.map((r) => [r.ts, r]));
  const out: Bar[] = [];
  let close = NaN, oi = NaN;
  for (let ts = rows[0].ts; ts <= rows[rows.length - 1].ts; ts += MINUTE_MS) {
    const r = byTs.get(ts);
    if (r?.close != null && r.close > 0) close = r.close;
    if (r?.oi != null && r.oi > 0) oi = r.oi;
    out.push({ ts, close, oi, high: r?.high ?? close, low: r?.low ?? close, longLiq: r?.longLiq ?? 0, shortLiq: r?.shortLiq ?? 0 });
  }
  return out;
}

interface Active { base: number; start: number; baseOi: number; basePrice: number; minOi: number; minIdx: number; extreme: number; liq: number; opp: number; lastLiq: number }

export function findEpisodes(bars: readonly Bar[], p: EpisodeParams = DEFAULT_EPISODE_PARAMS): LiqEpisode[] {
  const out: LiqEpisode[] = [];
  for (const victim of ["LONG", "SHORT"] as const) {
    const down = victim === "LONG";
    const vLiq = (b: Bar): number => (down ? b.longLiq : b.shortLiq);
    const oLiq = (b: Bar): number => (down ? b.shortLiq : b.longLiq);
    let a: Active | null = null;
    for (let i = 3; i < bars.length; i++) {
      const b = bars[i], b3 = bars[i - 3];
      if (!Number.isFinite(b.close) || !Number.isFinite(b.oi)) continue;
      if (!a) {
        const priceWith = down ? b.close < b3.close : b.close > b3.close;
        if (vLiq(b) > 0 && b.oi < b3.oi && priceWith && Number.isFinite(b3.oi) && Number.isFinite(b3.close)) {
          a = { base: i - 3, start: i, baseOi: b3.oi, basePrice: b3.close, minOi: b3.oi, minIdx: i - 3, extreme: b3.close, liq: 0, opp: 0, lastLiq: i };
          for (let k = i - 2; k < i; k++) { a.liq += vLiq(bars[k]); a.opp += oLiq(bars[k]); if (bars[k].oi < a.minOi) { a.minOi = bars[k].oi; a.minIdx = k; } a.extreme = down ? Math.min(a.extreme, bars[k].low) : Math.max(a.extreme, bars[k].high); }
        } else continue;
      }
      a.liq += vLiq(b); a.opp += oLiq(b);
      if (vLiq(b) > 0) a.lastLiq = i;
      a.extreme = down ? Math.min(a.extreme, b.low) : Math.max(a.extreme, b.high);
      if (b.oi < a.minOi) { a.minOi = b.oi; a.minIdx = i; }
      const drop = a.baseOi - a.minOi;
      const rebound = b.oi - a.minOi;
      const rebounded = drop > 0 && rebound >= Math.max(p.noise * drop, (p.noiseFloorPct / 100) * a.baseOi);
      const stale = i - a.minIdx > p.staleMin;
      if (!rebounded && !stale && i < bars.length - 1) continue;
      if (!rebounded && !stale) break; // data ended mid-episode: not reported
      out.push(measure(bars, victim, a, i, rebounded ? "OI_REBOUND" : "NO_REBOUND", p));
      a = null;
    }
  }
  return out.sort((x, y) => x.startTs - y.startTs);
}

function measure(bars: readonly Bar[], victim: Victim, a: Active, endIdx: number, endReason: LiqEpisode["endReason"], p: EpisodeParams): LiqEpisode {
  const down = victim === "LONG";
  const bottom = bars[a.minIdx];
  const px = bottom.close;
  // accumulation: OI peak after the bottom until it gives back `noise` of the rise
  let peak = a.minOi, peakIdx = a.minIdx, zoneLow = bottom.low, zoneHigh = bottom.high;
  let zLo = bottom.low, zHi = bottom.high;
  for (let k = a.minIdx + 1; k < bars.length && k - a.minIdx <= p.accumMaxMin; k++) {
    const b = bars[k];
    if (!Number.isFinite(b.oi)) continue;
    zLo = Math.min(zLo, b.low); zHi = Math.max(zHi, b.high);
    if (b.oi > peak) { peak = b.oi; peakIdx = k; zoneLow = zLo; zoneHigh = zHi; }
    else if (peak > a.minOi && peak - b.oi >= Math.max(p.noise * (peak - a.minOi), (p.noiseFloorPct / 100) * a.minOi)) break;
  }
  const oiDropUsd = (a.baseOi - a.minOi) * px;
  const movePct = ((down ? a.basePrice - a.extreme : a.extreme - a.basePrice) / a.basePrice) * 100;
  return {
    victim, startTs: bars[a.start].ts, bottomTs: bottom.ts, endTs: bars[endIdx].ts, lastLiqTs: bars[a.lastLiq].ts, endReason,
    durationMin: Math.max(0, a.minIdx - a.start), liqActiveMin: a.lastLiq - a.start,
    basePrice: a.basePrice, extremePrice: a.extreme, movePct,
    liqUsd: a.liq, oppLiqUsd: a.opp,
    oiDropPct: ((a.baseOi - a.minOi) / a.baseOi) * 100, oiDropUsd, otherClosesUsd: oiDropUsd - a.liq - a.opp,
    oiRisePct: ((peak - a.minOi) / a.minOi) * 100, oiRiseUsd: (peak - a.minOi) * px, accumMin: peakIdx - a.minIdx, zoneLow, zoneHigh,
  };
}

/** The coin's "normal" hour: median 1h price range % and median 1h |OI change| %. */
export function coinNorms(bars: readonly Bar[]): { hourRangePct: number; hourOiPct: number } {
  const ranges: number[] = [], ois: number[] = [];
  for (let i = 60; i < bars.length; i += 15) {
    let hi = -Infinity, lo = Infinity;
    for (let k = i - 60; k < i; k++) { hi = Math.max(hi, bars[k].high); lo = Math.min(lo, bars[k].low); }
    const ref = bars[i - 60].close, o0 = bars[i - 60].oi, o1 = bars[i - 1].oi;
    if (ref > 0 && Number.isFinite(hi) && Number.isFinite(lo)) ranges.push(((hi - lo) / ref) * 100);
    if (o0 > 0 && o1 > 0) ois.push((Math.abs(o1 - o0) / o0) * 100);
  }
  return { hourRangePct: median(ranges), hourOiPct: median(ois) };
}

export function median(v: readonly number[]): number {
  const s = [...v].filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
}

/** Share (0..100) of `values` that are <= v -- "top X%" = 100 - this. */
export function percentileRank(values: readonly number[], v: number): number {
  if (values.length === 0) return NaN;
  return (100 * values.filter((x) => x <= v).length) / values.length;
}
