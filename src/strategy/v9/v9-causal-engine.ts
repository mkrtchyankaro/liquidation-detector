import {
  MINUTE_MS, buildReference, changePoints, episodeFeatures, mergeEpisodes, selectEpisode, subEpisodes, usableRange,
  typicalLiquidationMinuteUsd, type Bucket, type Episode, type EpisodeFeatures, type Regime, type SelectionReference, type SelectionResult, type Victim,
} from "./v9-core";
import { V9MinuteStore } from "./v9-minute-store";
import { priceOiEpisodes, typicalMinuteNoise } from "./v9-price-oi";
import { TAKER_FEE } from "./v9-fees";

/**
 * Causal (live) V9 engine for ONE symbol.
 *
 * Research ran the pipeline once over a finished dataset (look-ahead). Live,
 * evaluate(now) runs the SAME pure pipeline on data up to `now` only:
 *   - OI regimes are fitted on the trailing window ending at now;
 *   - an episode is acted on only once its end is CONFIRMED (confirmTs <= now);
 *   - CLR/MOV medians come only from episodes confirmed BEFORE this one.
 *
 * Every confirmed episode becomes a decision (selected or not, with reasons)
 * so the operator can audit why a signal did or did not fire.
 */
export interface V9EngineSettings {
  /** Trailing data window for the regime fit. Research used ~3 days. */
  windowMs: number;
  /** Trailing window of prior confirmed DIR episodes for the medians. */
  referenceWindowMs: number;
  /** Medians of fewer samples are not meaningful: no selection below this. */
  minReferenceSamples: number;
  /** A confirmation discovered later than this after confirmTs (e.g. after
   *  a data gap or a regime re-fit) is recorded but never traded. */
  maxSignalAgeMs: number;
  /** How the end of an episode is confirmed:
   *   OPPOSITE_LIQ  an opposite-side liquidation part with an OI drop (research v9)
   *   PRICE_OI      OI falling while price moves against the liquidation move
   *                 (the other side is being closed) -- see v9-price-oi.ts */
  confirmMode: "OPPOSITE_LIQ" | "PRICE_OI";
  /** SL anchor: extreme price since the episode START, or since its PEAK
   *  liquidation minute (ignores early small liquidations). */
  slFrom: "START" | "PEAK";
  /** PRICE_OI only: require the OI drop AND the price reversal to exceed this
   *  symbol's typical one-minute noise (median over the data window). */
  significantConfirm: boolean;
  /** Extra room beyond the extreme for the SL, in units of the symbol's
   *  typical one-minute high-low range over the last hour (0 = none). */
  slBufferMinuteRanges: number;
  /** Which filters must pass: ALL five, only DOM, or NONE (every confirmation). */
  filters: "ALL" | "DOM" | "NONE";
  /** OPPOSITE_LIQ only: the confirming opposite liquidations must be at least
   *  this symbol's typical liquidation-minute size (median, from the data). */
  significantOppositeLiq: boolean;
  /** Skip a signal whose SL is so close that Binance fees on a stop-out would
   *  exceed this many R (null = never skip). */
  maxSlFeeR: number | null;
  /** Minimum SL distance as a fraction of price (0.0033 = 0.33%). A tighter
   *  stop is moved out to this distance (and the TP follows as rr x risk);
   *  wider stops are unchanged. Keeps stop-out fees <= ~0.3R and the position
   *  size <= ~300x the risk. 0 = off. */
  minSlFraction: number;
  /** LATE-ENTRY STOP (Johnny, Sep 25 2026): when the stop at the episode
   *  extreme is farther than this % from the entry (we are "very late"),
   *  the stop moves to where the confirming OI drop STARTED: the extreme
   *  price since the OI peak between the episode end and the confirmation.
   *  Used only if it is closer than the extreme stop. 0 = always, null = off. */
  lateSlPct: number | null;
  /** SHARP ACCUMULATION (Johnny, Sep 25 2026): after the cleaning, new
   *  positions must open FAST and in size. Measure: the biggest OI rise in any
   *  30-minute window between the episode's OI bottom and the OI peak before
   *  the confirmation. It must reach this percentile (e.g. 70 or 90) of the
   *  coin's own 30-minute OI rises over the data window before the
   *  confirmation. null = off. */
  minAccumPercentile: number | null;
}

export const DEFAULT_V9_ENGINE_SETTINGS: V9EngineSettings = {
  windowMs: 3 * 24 * 3_600_000,
  referenceWindowMs: 3 * 24 * 3_600_000,
  minReferenceSamples: 5,
  maxSignalAgeMs: 2 * MINUTE_MS,
  confirmMode: "OPPOSITE_LIQ",
  slFrom: "START",
  significantConfirm: false,
  slBufferMinuteRanges: 0,
  filters: "ALL",
  significantOppositeLiq: false,
  maxSlFeeR: null,
  minSlFraction: 0,
  lateSlPct: null,
  minAccumPercentile: null,
};

export interface V9Decision {
  symbol: string;
  episode: Episode;
  features: EpisodeFeatures;
  reference: SelectionReference;
  selection: SelectionResult;
  /** true only when selected AND fresh AND the reference is large enough. */
  tradable: boolean;
  reason: "SELECTED" | "NOT_SELECTED" | "REFERENCE_TOO_SMALL" | "STALE_CONFIRMATION" | "DUPLICATE_EPISODE" | "DATA_GAP" | "SL_TOO_TIGHT" | "ACCUM_WEAK" | "SYMBOL_BUSY";
  /** Whole minutes between episode start and the decision with no data at all. */
  missingMinutes: number;
  evaluatedAt: number;
  /** Trade plan (fade): LONG victims -> BUY, SHORT victims -> SELL. */
  tradeSide: Victim;
  /** Episode extreme from its start through `evaluatedAt` (SL anchor). */
  stopPrice: number;
  referencePrice: number;
}

interface ReferenceSample { confirmTs: number; clr: number; dirMove: number }

/** What the engine sees RIGHT NOW for a symbol: the episode that is still
 *  forming (not yet confirmed), or none. Persisted every minute so an
 *  episode's live evolution can be replayed and audited later. */
export interface V9EpisodeSnapshot {
  symbol: string;
  ts: number;
  oiPhase: "OI_FALLING" | "OI_RISING" | "OI_FLAT";
  oi: number;
  price: number;
  forming: null | {
    start: number; victim: Victim; parts: number; longUsd: number; shortUsd: number;
    oiDropPct: number; priceMovePct: number; dom: boolean; dir: boolean; exh: boolean; clr: number;
  };
}

/** Shared per-minute episode computation for multi-variant replays. */
export type EpisodeCache = Map<string, { usable: Bucket[]; regimes: Regime[]; episodes: Episode[] }>;

export class V9CausalEngine {
  readonly store = new V9MinuteStore();
  private lastConfirmTs = -Infinity;
  private readonly reference: ReferenceSample[] = [];
  /** Time of the last TRADABLE decision per victim side. The regime fit is
   *  re-done every minute, so the same liquidation episode can re-appear
   *  with a later confirmation (seen in replay: SOL 15:53 signalled three
   *  times). Any selected episode that STARTED before the last tradable
   *  signal on the same side is the same move seen again -- never traded twice. */
  private readonly lastTradableAt: Record<Victim, number> = { LONG: -Infinity, SHORT: -Infinity };

  /** Latest snapshot produced by evaluate(). */
  lastSnapshot: V9EpisodeSnapshot | null = null;

  /** `cache` (replay only): engines fed IDENTICAL data at the same minute can
   *  share the expensive part (regime fit + episodes) -- it depends only on
   *  the data and the episode-shaping settings, never on the decision rules. */
  constructor(readonly symbol: string, private readonly settings: V9EngineSettings = DEFAULT_V9_ENGINE_SETTINGS, private readonly cache?: EpisodeCache) {}

  /** Restore "this side was already traded at `ts`" after a restart, from
   *  the persisted trades -- so a re-confirmed old episode is never traded twice. */
  markTraded(side: Victim, ts: number): void {
    this.lastTradableAt[side] = Math.max(this.lastTradableAt[side], ts);
  }

  /** Evaluate with all data up to `now`. Returns decisions for episodes whose
   *  end became known since the previous call, oldest first. */
  evaluate(now: number): V9Decision[] {
    const from = now - this.settings.windowMs;
    this.store.prune(from - MINUTE_MS);
    const key = `${now}|${this.settings.windowMs}|${this.settings.confirmMode}|${this.settings.significantConfirm}|${this.settings.significantOppositeLiq}`;
    let shaped = this.cache?.get(key);
    if (!shaped) {
      const usable0 = usableRange(this.store.toBuckets(from, now));
      if (usable0 === null) return [];
      const regimes0 = changePoints(usable0.map((b) => b.oi));
      const episodes0 = this.settings.confirmMode === "PRICE_OI"
        ? priceOiEpisodes(usable0, regimes0, now, this.settings.significantConfirm ? typicalMinuteNoise(usable0) : undefined)
        : mergeEpisodes(usable0, subEpisodes(usable0, regimes0, now), this.settings.significantOppositeLiq ? typicalLiquidationMinuteUsd(usable0) : undefined);
      shaped = { usable: usable0, regimes: regimes0, episodes: episodes0 };
      this.cache?.set(key, shaped);
    }
    const { usable, regimes, episodes } = shaped;
    this.lastSnapshot = this.snapshot(now, usable, regimes, episodes);

    const fresh = episodes
      .filter((e) => Number.isFinite(e.confirmTs) && e.confirmTs <= now && e.confirmTs > this.lastConfirmTs)
      .sort((a, b) => a.confirmTs - b.confirmTs);

    const decisions: V9Decision[] = [];
    for (const e of fresh) {
      const features = episodeFeatures(usable, e);
      const prior = this.reference.filter((r) => r.confirmTs < e.confirmTs && r.confirmTs >= e.confirmTs - this.settings.referenceWindowMs);
      const reference = buildReference(prior);
      const full = selectEpisode(features, reference);
      const selection = this.settings.filters === "ALL" ? full
        : { ...full, selected: this.settings.filters === "NONE" ? true : features.dom };
      const stale = now - e.confirmTs > this.settings.maxSignalAgeMs;
      const small = this.settings.filters === "ALL" && reference.sampleCount < this.settings.minReferenceSamples;
      const duplicate = e.start < this.lastTradableAt[e.victim];
      // Minutes with no poll at all = the collector was down (restart,
      // outage). Liquidations of that time are lost for good (Binance keeps
      // no history), so such an episode is not trusted with money.
      // (the current minute is still in progress and is not checked)
      const lastFull = now - MINUTE_MS;
      const expectedMinutes = Math.floor(lastFull / MINUTE_MS) - Math.floor(e.start / MINUTE_MS) + 1;
      const missingMinutes = Math.max(0, expectedMinutes - this.store.minuteRange(e.start, lastFull).length);
      const extreme = this.store.extremePrice(e.victim === "LONG" ? "LOW" : "HIGH", this.settings.slFrom === "PEAK" ? features.peakTs : e.start, now);
      const buffer = this.settings.slBufferMinuteRanges > 0 ? this.settings.slBufferMinuteRanges * this.typicalMinuteRange(now) : 0;
      const refPrice = this.store.lastPrice(now);
      let stopPrice = e.victim === "LONG" ? extreme - buffer : extreme + buffer;
      if (this.settings.lateSlPct !== null && refPrice > 0 && (Math.abs(refPrice - stopPrice) / refPrice) * 100 > this.settings.lateSlPct) {
        const turnTs = oiTurnTs(usable, e);
        if (turnTs !== null) {
          const turn = this.store.extremePrice(e.victim === "LONG" ? "LOW" : "HIGH", turnTs, now);
          const t = e.victim === "LONG" ? turn - buffer : turn + buffer;
          const valid = e.victim === "LONG" ? t < refPrice && t > stopPrice : t > refPrice && t < stopPrice;
          if (Number.isFinite(t) && valid) stopPrice = t;
        }
      }
      const minDist = refPrice * this.settings.minSlFraction;
      if (minDist > 0 && Math.abs(refPrice - stopPrice) < minDist) stopPrice = e.victim === "LONG" ? refPrice - minDist : refPrice + minDist;
      const riskDist = Math.abs(refPrice - stopPrice);
      const slFeeR = riskDist > 0 ? (2 * TAKER_FEE * refPrice) / riskDist : Infinity;
      const tooTight = this.settings.maxSlFeeR !== null && slFeeR > this.settings.maxSlFeeR;
      const accumWeak = this.settings.minAccumPercentile !== null && !sharpAccumulation(usable, e, this.settings.minAccumPercentile);
      const reason: V9Decision["reason"] = !selection.selected ? "NOT_SELECTED" : small ? "REFERENCE_TOO_SMALL" : stale ? "STALE_CONFIRMATION" : duplicate ? "DUPLICATE_EPISODE" : missingMinutes > 0 ? "DATA_GAP" : tooTight ? "SL_TOO_TIGHT" : accumWeak ? "ACCUM_WEAK" : "SELECTED";
      decisions.push({
        symbol: this.symbol, episode: e, features, reference, selection,
        tradable: reason === "SELECTED", reason, evaluatedAt: now, missingMinutes,
        tradeSide: e.victim, stopPrice, referencePrice: refPrice,
      });
      if (reason === "SELECTED") this.lastTradableAt[e.victim] = now;
      if (features.dir) this.reference.push({ confirmTs: e.confirmTs, clr: features.clr, dirMove: features.dirMove });
      this.lastConfirmTs = e.confirmTs;
    }
    const keepFrom = now - this.settings.referenceWindowMs;
    while (this.reference.length && this.reference[0].confirmTs < keepFrom) this.reference.shift();
    return decisions;
  }

  /** Mean poll-price high-low of the last 60 full minutes. */
  private typicalMinuteRange(now: number): number {
    const r = this.store.minuteRange(now - 61 * MINUTE_MS, now - MINUTE_MS);
    return r.length ? r.reduce((t, m) => t + (m.high - m.low), 0) / r.length : 0;
  }

  private snapshot(now: number, usable: Bucket[], regimes: Regime[], episodes: Episode[]): V9EpisodeSnapshot {
    const lastIdx = usable.length - 1;
    const slope = regimes.find((r) => lastIdx >= r.a && lastIdx < r.b)?.slope ?? 0;
    const last = episodes.at(-1);
    const formingEp = last && !Number.isFinite(last.confirmTs) ? last : null;
    const f = formingEp ? episodeFeatures(usable, formingEp) : null;
    return {
      symbol: this.symbol, ts: now,
      oiPhase: slope < 0 ? "OI_FALLING" : slope > 0 ? "OI_RISING" : "OI_FLAT",
      oi: usable[lastIdx].oi, price: usable[lastIdx].price,
      forming: formingEp && f ? {
        start: formingEp.start, victim: formingEp.victim, parts: formingEp.parts,
        longUsd: formingEp.long, shortUsd: formingEp.short,
        oiDropPct: formingEp.oiDropPct, priceMovePct: formingEp.priceMovePct,
        dom: f.dom, dir: f.dir, exh: f.exh, clr: f.clr,
      } : null,
    };
  }
}

/** Where the confirming OI drop started: the minute of highest OI between
 *  the episode's last part and the confirmation (both already known). */
export function oiTurnTs(buckets: readonly Bucket[], e: Episode): number | null {
  if (!Number.isFinite(e.confirmTs)) return null;
  let best = -1;
  for (let i = Math.max(0, e.eIdx - 1); i < buckets.length && buckets[i].ts < e.confirmTs; i++) {
    if (!(buckets[i].oi > 0)) continue;
    if (best < 0 || buckets[i].oi >= buckets[best].oi) best = i;
  }
  return best >= 0 ? buckets[best].ts : null;
}

const ACCUM_WINDOW = 30; // minutes

/** Biggest OI rise (%) inside any 30-minute window of [from, to] (bucket indexes). */
function maxWindowRisePct(buckets: readonly Bucket[], from: number, to: number): number {
  let best = 0;
  for (let i = from + 1; i <= to; i++) {
    const cur = buckets[i].oi;
    if (!(cur > 0)) continue;
    let low = Infinity;
    for (let j = Math.max(from, i - ACCUM_WINDOW); j < i; j++) if (buckets[j].oi > 0) low = Math.min(low, buckets[j].oi);
    if (Number.isFinite(low)) best = Math.max(best, ((cur - low) / low) * 100);
  }
  return best;
}

/** True when the accumulation after the episode (OI bottom -> OI peak before
 *  the confirmation) contains a 30-minute OI rise at least at the
 *  `percentile` of the coin's 30-minute OI rises before the confirmation. */
export function sharpAccumulation(buckets: readonly Bucket[], e: Episode, percentile: number): boolean {
  const turnTs = oiTurnTs(buckets, e);
  if (turnTs === null) return false;
  let bottom = -1, peak = -1;
  for (let i = e.sIdx; i < buckets.length && buckets[i].ts <= turnTs; i++) {
    if (!(buckets[i].oi > 0)) continue;
    if (i < e.eIdx && (bottom < 0 || buckets[i].oi < buckets[bottom].oi)) bottom = i;
    if (buckets[i].ts === turnTs) peak = i;
  }
  if (bottom < 0 || peak <= bottom) return false;
  const rise = maxWindowRisePct(buckets, bottom, peak);
  // the coin's normal 30-minute OI rises, only from data before the confirmation
  const rises: number[] = [];
  for (let i = ACCUM_WINDOW; i < buckets.length && buckets[i].ts < e.confirmTs; i += 5) {
    const a = buckets[i - ACCUM_WINDOW].oi, b = buckets[i].oi;
    if (a > 0 && b > a) rises.push(((b - a) / a) * 100);
  }
  if (rises.length < 20) return false;
  rises.sort((x, y) => x - y);
  const threshold = rises[Math.min(rises.length - 1, Math.floor((percentile / 100) * rises.length))];
  return rise >= threshold;
}
