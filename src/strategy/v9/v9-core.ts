/**
 * V9 liquidation-episode strategy -- PURE core (no I/O, no clock, no state).
 *
 * Faithful TypeScript port of the research script
 * scripts/liquidation-episodes-v13.js (the logic validated in research as
 * "v9"). tests/v9-core-equivalence.test.ts runs both implementations on the
 * same data and requires identical output -- any change here must keep
 * that test green, or be a deliberate, documented strategy change.
 *
 * Pipeline:
 *   buildBuckets     liquidation events + OI observations -> 1-minute grid
 *   changePoints     piecewise-linear OI regimes, split chosen by BIC
 *   subEpisodes      liquidation in falling OI -> growth phase -> OI peak
 *   mergeEpisodes    same-side parts merged; closed by an OPPOSITE part that
 *                    shows a real OI drop; confirmTs = when that is known
 *   episodeFeatures  DOM, DIR, EXH, CLR (OI drop per 1% move), dirMove
 *   selectEpisode    DOM & DIR & EXH & CLR > median & MOV >= median, where the
 *                    medians come from a caller-supplied reference set
 *
 * No price, size, duration or OI-magnitude threshold exists anywhere here.
 */

export const MINUTE_MS = 60_000;

export type Victim = "LONG" | "SHORT";

export interface LiqEvent { ts: number; victim: Victim; usd: number }
/** ts = when we captured the poll; updated = exchange-side OI update time. */
export interface OiObservation { ts: number; updated: number; oi: number; price: number }

export interface Bucket {
  ts: number; long: number; short: number; count: number;
  oi: number; price: number; oiPoints: number;
}
export interface Regime { a: number; b: number; slope: number }

const minuteOf = (ts: number): number => Math.floor(ts / MINUTE_MS) * MINUTE_MS;

/** A minute without liquidation stays in the timeline with zero flow. OI is
 *  placed by its EXCHANGE update time (one entry per distinct update) and
 *  carried forward only to draw a continuous level line. */
export function buildBuckets(liquidations: readonly LiqEvent[], oiObservations: readonly OiObservation[], start: number, end: number): Bucket[] {
  const buckets: Bucket[] = [];
  const byTime = new Map<number, Bucket>();
  for (let ts = minuteOf(start); ts <= minuteOf(end); ts += MINUTE_MS) {
    const bucket: Bucket = { ts, long: 0, short: 0, count: 0, oi: NaN, price: NaN, oiPoints: 0 };
    buckets.push(bucket);
    byTime.set(ts, bucket);
  }
  for (const event of liquidations) {
    const bucket = byTime.get(minuteOf(event.ts));
    if (!bucket) continue;
    if (event.victim === "LONG") bucket.long += event.usd; else bucket.short += event.usd;
    bucket.count++;
  }
  const updates = new Map<number, OiObservation>();
  for (const obs of oiObservations) {
    if (Number.isFinite(obs.updated) && obs.updated <= obs.ts) updates.set(obs.updated, obs);
  }
  for (const obs of [...updates.values()].sort((a, b) => a.updated - b.updated)) {
    const bucket = byTime.get(minuteOf(obs.updated));
    if (!bucket) continue;
    bucket.oi = obs.oi;
    bucket.price = obs.price;
    bucket.oiPoints++;
  }
  let lastOi = NaN;
  let lastPrice = NaN;
  for (const bucket of buckets) {
    if (Number.isFinite(bucket.oi)) { lastOi = bucket.oi; lastPrice = bucket.price; }
    else { bucket.oi = lastOi; bucket.price = lastPrice; }
  }
  return buckets;
}

/** Trim leading/trailing minutes that have no OI level at all. Returns null
 *  when fewer than 5 minutes carry a real level (not enough to segment). */
export function usableRange(buckets: readonly Bucket[]): Bucket[] | null {
  let first = -1, last = -1;
  for (let i = 0; i < buckets.length; i++) if (Number.isFinite(buckets[i].oi)) { if (first < 0) first = i; last = i; }
  if (first < 0 || last - first < 4) return null;
  return buckets.slice(first, last + 1);
}

function linearCost(y: readonly number[]): (a: number, b: number) => { sse: number; slope: number } {
  const sums = [0, 1, 2, 3, 4].map(() => new Float64Array(y.length + 1));
  for (let i = 0; i < y.length; i++) {
    const x = i; const v = y[i];
    sums[0][i + 1] = sums[0][i] + x;
    sums[1][i + 1] = sums[1][i] + v;
    sums[2][i + 1] = sums[2][i] + x * x;
    sums[3][i + 1] = sums[3][i] + x * v;
    sums[4][i + 1] = sums[4][i] + v * v;
  }
  return (a, b) => {
    const n = b - a;
    if (n < 2) return { sse: 0, slope: 0 };
    const [sx, sy, sxx, sxy, syy] = sums.map((s) => s[b] - s[a]);
    const den = n * sxx - sx * sx;
    const slope = den ? (n * sxy - sx * sy) / den : 0;
    const intercept = (sy - slope * sx) / n;
    const sse = Math.max(0, syy - intercept * sy - slope * sxy);
    return { sse, slope };
  };
}

/** Binary segmentation of the OI level with a parameter-count BIC. */
export function changePoints(y: readonly number[]): Regime[] {
  const cost = linearCost(y);
  const leaves: Regime[] = [];
  const stack: Array<[number, number]> = [[0, y.length]];
  const scale = Math.max(Number.EPSILON * y.reduce((s, v) => s + v * v, 0), 1e-16);
  const logN = Math.log(y.length);
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const parent = cost(a, b);
    let best: { split: number; loss: number } | null = null;
    for (let split = a + 2; split <= b - 2; split++) {
      const left = cost(a, split), right = cost(split, b);
      const loss = left.sse + right.sse;
      if (!best || loss < best.loss) best = { split, loss };
    }
    if (best) {
      const n = b - a;
      const unsplitBic = n * Math.log((parent.sse + scale) / n) + 2 * logN;
      const splitBic = n * Math.log((best.loss + scale) / n) + 4 * logN;
      if (splitBic < unsplitBic) {
        stack.push([best.split, b], [a, best.split]);
        continue;
      }
    }
    leaves.push({ a, b, slope: parent.slope });
  }
  return leaves.sort((x, z) => x.a - z.a);
}

export interface SubEpisode {
  start: number; end: number; sIdx: number; eIdx: number;
  victim: Victim; long: number; short: number; count: number;
  oiDropPct: number; continuations: number; opposite: number;
  rightCensored: boolean; endReason: string;
}

const sideOf = (long: number, short: number): Victim => (long >= short ? "LONG" : "SHORT");

/** Liquidation inside falling OI starts a part; side fixed before OI growth;
 *  the part ends at the first minute OI stops growing (the OI peak). */
export function subEpisodes(buckets: readonly Bucket[], regimes: readonly Regime[], validUntil: number): SubEpisode[] {
  const slopeAt = new Float64Array(buckets.length);
  for (const r of regimes) for (let i = r.a; i < r.b; i++) slopeAt[i] = r.slope;
  const out: SubEpisode[] = [];
  let active: { start: number; side: Victim | null; growthStart: number; continuations: number; opposite: number } | null = null;

  const close = (endIndex: number, reason: string, rightCensored = false): void => {
    if (!active) return;
    const start = active.start;
    const stop = Math.max(start + 1, Math.min(endIndex, buckets.length));
    let long = 0, short = 0, count = 0, minimum = buckets[Math.max(0, start - 1)].oi;
    const baseline = minimum;
    for (let i = start; i < stop; i++) { long += buckets[i].long; short += buckets[i].short; count += buckets[i].count; minimum = Math.min(minimum, buckets[i].oi); }
    const last = buckets[stop - 1];
    const endTs = stop < buckets.length ? buckets[stop].ts : last.ts + MINUTE_MS;
    if (count) out.push({
      start: buckets[start].ts, end: endTs, sIdx: start, eIdx: stop,
      victim: active.side ?? sideOf(long, short), long, short, count,
      oiDropPct: baseline > 0 ? Math.max(0, (baseline - minimum) / baseline * 100) : NaN,
      continuations: active.continuations, opposite: active.opposite,
      rightCensored: rightCensored || endTs > validUntil, endReason: reason,
    });
    active = null;
  };

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const slope = slopeAt[i];
    if (!active) {
      if (slope < 0 && b.count > 0) active = { start: i, side: null, growthStart: -1, continuations: 0, opposite: 0 };
      continue;
    }
    if (active.growthStart < 0) {
      if (slope <= 0) continue;
      let long = 0, short = 0;
      for (let k = active.start; k < i; k++) { long += buckets[k].long; short += buckets[k].short; }
      active.side = sideOf(long, short);
      active.growthStart = i;
    }
    if (slope <= 0) {
      close(i, "GROWTH_END");
      i--;
      continue;
    }
    if (b.count > 0) {
      if (sideOf(b.long, b.short) === active.side) active.continuations++;
      else active.opposite++;
    }
  }
  if (active) close(buckets.length, (active as { growthStart: number }).growthStart >= 0 ? "GROWING_AT_END" : "OPEN_AT_DATA_END", true);
  return out;
}

export interface Episode {
  start: number; end: number; sIdx: number; eIdx: number;
  victim: Victim; long: number; short: number; count: number;
  startOi: number; minOi: number; oiDropPct: number;
  startPrice: number; endPrice: number; extremePrice: number; priceMovePct: number;
  /** When the end became KNOWN (opposite part showed a real OI drop); NaN if not yet. */
  confirmTs: number;
  endReason: string; parts: number; partRanges: Array<[number, number]>;
  rightCensored: boolean;
}

/** Same-side parts merge; an opposite part WITH an OI drop closes the group
 *  and confirmTs is the end of the first minute its OI fell below its base. */
/** minOppositeLiqUsd (optional, variant "A_LIQSIG"): an opposite part closes
 *  the group only if its own liquidations reach this size; smaller ones are
 *  absorbed as noise. Undefined = research behaviour (any size). */
export function mergeEpisodes(buckets: readonly Bucket[], subs: readonly SubEpisode[], minOppositeLiqUsd?: number): Episode[] {
  const out: Episode[] = [];
  let group: SubEpisode[] | null = null;
  const finish = (closedBy: string, confirmTs = NaN): void => {
    if (!group) return;
    const first = group[0], last = group[group.length - 1];
    const start = first.sIdx, stop = last.eIdx;
    let long = 0, short = 0, count = 0;
    const baseline = buckets[Math.max(0, start - 1)].oi;
    let minimum = baseline;
    const prices: number[] = [];
    for (let i = start; i < stop; i++) {
      const b = buckets[i];
      long += b.long; short += b.short; count += b.count; minimum = Math.min(minimum, b.oi);
      if (Number.isFinite(b.price)) prices.push(b.price);
    }
    const endB = buckets[stop - 1];
    const startPrice = buckets[Math.max(0, start - 1)].price;
    out.push({
      start: first.start, end: last.end, sIdx: start, eIdx: stop,
      victim: first.victim, long, short, count,
      startOi: baseline, minOi: minimum,
      oiDropPct: baseline > 0 ? Math.max(0, (baseline - minimum) / baseline * 100) : NaN,
      startPrice, endPrice: endB.price,
      extremePrice: first.victim === "LONG" ? Math.min(...prices) : Math.max(...prices),
      priceMovePct: startPrice > 0 ? (endB.price - startPrice) / startPrice * 100 : NaN,
      confirmTs,
      endReason: last.rightCensored ? last.endReason : closedBy,
      parts: group.length, partRanges: group.map((p) => [p.sIdx, p.eIdx] as [number, number]),
      rightCensored: last.rightCensored,
    });
    group = null;
  };
  for (const sub of subs) {
    if (!group) { group = [sub]; continue; }
    const side = group[0].victim;
    if (sub.victim === side) group.push(sub);
    else if (sub.oiDropPct > 0 && (minOppositeLiqUsd === undefined || (sub.victim === "LONG" ? sub.long : sub.short) >= minOppositeLiqUsd)) {
      const base = buckets[Math.max(0, sub.sIdx - 1)].oi;
      let k = sub.sIdx;
      while (k < sub.eIdx && !(buckets[k].oi < base)) k++;
      finish("OPPOSITE_EPISODE", k < sub.eIdx ? buckets[k].ts + MINUTE_MS : NaN);
      group = [sub];
    }
    // else: opposite part without an OI drop is noise, absorbed
  }
  finish("DATA_END");
  return out;
}

export interface EpisodeFeatures {
  dom: boolean; dir: boolean; exh: boolean;
  dirMove: number; clr: number;
  victimLiq: number; oppLiq: number;
  peakTs: number; preEff: number; postEff: number;
}

/** Per-episode features (no reference set needed). */
export function episodeFeatures(buckets: readonly Bucket[], e: Episode): EpisodeFeatures {
  const s = e.victim === "LONG" ? -1 : 1;
  const victimOf = (b: Bucket): number => (e.victim === "LONG" ? b.long : b.short);
  const oppOf = (b: Bucket): number => (e.victim === "LONG" ? b.short : b.long);
  let victimLiq = 0, oppLiq = 0;
  for (let i = e.sIdx; i < e.eIdx; i++) { victimLiq += victimOf(buckets[i]); oppLiq += oppOf(buckets[i]); }
  const dom = e.partRanges.every(([a, z]) => {
    let v = 0, o = 0;
    for (let i = a; i < z; i++) { v += victimOf(buckets[i]); o += oppOf(buckets[i]); }
    return v > o;
  });
  const dirMove = s * e.priceMovePct;
  let peak = e.sIdx;
  for (let i = e.sIdx; i < e.eIdx; i++) if (victimOf(buckets[i]) > victimOf(buckets[peak])) peak = i;
  const segment = (a: number, z: number): { move: number; drop: number; eff: number } => {
    const base = buckets[Math.max(0, a - 1)];
    if (z < a || !(base.price > 0) || !(base.oi > 0)) return { move: NaN, drop: NaN, eff: NaN };
    let minOi = base.oi;
    for (let i = a; i <= z; i++) minOi = Math.min(minOi, buckets[i].oi);
    const move = s * (buckets[z].price - base.price) / base.price * 100;
    const drop = (base.oi - minOi) / base.oi * 100;
    return { move, drop, eff: drop > 0 ? move / drop : NaN };
  };
  const pre = segment(e.sIdx, peak);
  const post = segment(peak + 1, e.eIdx - 1);
  const exh = post.drop > 0 && (post.move <= 0 || (Number.isFinite(pre.eff) && post.eff < pre.eff));
  return {
    dom, dir: dirMove > 0, exh, dirMove,
    clr: dirMove > 0 ? e.oiDropPct / dirMove : NaN,
    victimLiq, oppLiq, peakTs: buckets[peak].ts, preEff: pre.eff, postEff: post.eff,
  };
}

/** Typical size of a liquidation minute: median USD of minutes that had any. */
export function typicalLiquidationMinuteUsd(buckets: readonly Bucket[]): number {
  return median(buckets.filter((b) => b.count > 0).map((b) => b.long + b.short));
}

export function median(values: readonly number[]): number {
  const s = values.filter(Number.isFinite).slice().sort((p, q) => p - q);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface SelectionReference { medianClr: number; medianMove: number; sampleCount: number }

/** Reference medians over DIR episodes only (as in research). */
export function buildReference(dirFeatures: ReadonlyArray<Pick<EpisodeFeatures, "clr" | "dirMove">>): SelectionReference {
  return { medianClr: median(dirFeatures.map((f) => f.clr)), medianMove: median(dirFeatures.map((f) => f.dirMove)), sampleCount: dirFeatures.length };
}

export interface SelectionResult { selected: boolean; checks: { DOM: boolean; DIR: boolean; CLR: boolean; MOV: boolean; EXH: boolean } }

export function selectEpisode(f: EpisodeFeatures, ref: SelectionReference): SelectionResult {
  const checks = { DOM: f.dom, DIR: f.dir, CLR: f.clr > ref.medianClr, MOV: f.dirMove >= ref.medianMove, EXH: f.exh };
  return { selected: Object.values(checks).every(Boolean), checks };
}

/** Convenience: whole pipeline over one window of data (used by offline
 *  replay and by the causal engine). */
export function analyzeWindow(liquidations: readonly LiqEvent[], oi: readonly OiObservation[], from: number, until: number): { buckets: Bucket[]; episodes: Episode[] } | null {
  // Same input filtering as the research loader.
  const events = liquidations.filter((x) => x.ts >= from && x.ts <= until && Number.isFinite(x.usd) && x.usd >= 0);
  const observations = oi.filter((x) => Number.isFinite(x.updated) && Number.isFinite(x.oi) && x.oi > 0 && x.updated >= from && x.updated <= until);
  const usable = usableRange(buildBuckets(events, observations, from, until));
  if (usable === null) return null;
  const regimes = changePoints(usable.map((b) => b.oi));
  return { buckets: usable, episodes: mergeEpisodes(usable, subEpisodes(usable, regimes, until)) };
}
