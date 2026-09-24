import {
  MINUTE_MS, buildReference, changePoints, episodeFeatures, mergeEpisodes, selectEpisode, subEpisodes, usableRange,
  type Bucket, type Episode, type EpisodeFeatures, type Regime, type SelectionReference, type SelectionResult, type Victim,
} from "./v9-core";
import { V9MinuteStore } from "./v9-minute-store";
import { priceOiEpisodes } from "./v9-price-oi";

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
}

export const DEFAULT_V9_ENGINE_SETTINGS: V9EngineSettings = {
  windowMs: 3 * 24 * 3_600_000,
  referenceWindowMs: 3 * 24 * 3_600_000,
  minReferenceSamples: 5,
  maxSignalAgeMs: 2 * MINUTE_MS,
  confirmMode: "OPPOSITE_LIQ",
  slFrom: "START",
};

export interface V9Decision {
  symbol: string;
  episode: Episode;
  features: EpisodeFeatures;
  reference: SelectionReference;
  selection: SelectionResult;
  /** true only when selected AND fresh AND the reference is large enough. */
  tradable: boolean;
  reason: "SELECTED" | "NOT_SELECTED" | "REFERENCE_TOO_SMALL" | "STALE_CONFIRMATION" | "DUPLICATE_EPISODE" | "DATA_GAP" | "SYMBOL_BUSY";
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

  constructor(readonly symbol: string, private readonly settings: V9EngineSettings = DEFAULT_V9_ENGINE_SETTINGS) {}

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
    const usable = usableRange(this.store.toBuckets(from, now));
    if (usable === null) return [];
    const regimes = changePoints(usable.map((b) => b.oi));
    const episodes = this.settings.confirmMode === "PRICE_OI"
      ? priceOiEpisodes(usable, regimes, now)
      : mergeEpisodes(usable, subEpisodes(usable, regimes, now));
    this.lastSnapshot = this.snapshot(now, usable, regimes, episodes);

    const fresh = episodes
      .filter((e) => Number.isFinite(e.confirmTs) && e.confirmTs <= now && e.confirmTs > this.lastConfirmTs)
      .sort((a, b) => a.confirmTs - b.confirmTs);

    const decisions: V9Decision[] = [];
    for (const e of fresh) {
      const features = episodeFeatures(usable, e);
      const prior = this.reference.filter((r) => r.confirmTs < e.confirmTs && r.confirmTs >= e.confirmTs - this.settings.referenceWindowMs);
      const reference = buildReference(prior);
      const selection = selectEpisode(features, reference);
      const stale = now - e.confirmTs > this.settings.maxSignalAgeMs;
      const small = reference.sampleCount < this.settings.minReferenceSamples;
      const duplicate = e.start < this.lastTradableAt[e.victim];
      // Minutes with no poll at all = the collector was down (restart,
      // outage). Liquidations of that time are lost for good (Binance keeps
      // no history), so such an episode is not trusted with money.
      // (the current minute is still in progress and is not checked)
      const lastFull = now - MINUTE_MS;
      const expectedMinutes = Math.floor(lastFull / MINUTE_MS) - Math.floor(e.start / MINUTE_MS) + 1;
      const missingMinutes = Math.max(0, expectedMinutes - this.store.minuteRange(e.start, lastFull).length);
      const reason: V9Decision["reason"] = !selection.selected ? "NOT_SELECTED" : small ? "REFERENCE_TOO_SMALL" : stale ? "STALE_CONFIRMATION" : duplicate ? "DUPLICATE_EPISODE" : missingMinutes > 0 ? "DATA_GAP" : "SELECTED";
      const stopPrice = this.store.extremePrice(e.victim === "LONG" ? "LOW" : "HIGH", this.settings.slFrom === "PEAK" ? features.peakTs : e.start, now);
      decisions.push({
        symbol: this.symbol, episode: e, features, reference, selection,
        tradable: reason === "SELECTED", reason, evaluatedAt: now, missingMinutes,
        tradeSide: e.victim, stopPrice, referencePrice: this.store.lastPrice(now),
      });
      if (reason === "SELECTED") this.lastTradableAt[e.victim] = now;
      if (features.dir) this.reference.push({ confirmTs: e.confirmTs, clr: features.clr, dirMove: features.dirMove });
      this.lastConfirmTs = e.confirmTs;
    }
    const keepFrom = now - this.settings.referenceWindowMs;
    while (this.reference.length && this.reference[0].confirmTs < keepFrom) this.reference.shift();
    return decisions;
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
