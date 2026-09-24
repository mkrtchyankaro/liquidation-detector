import {
  MINUTE_MS,
  buildReference,
  changePoints,
  episodeFeatures,
  mergeEpisodes,
  selectEpisode,
  subEpisodes,
  usableRange,
  type Episode,
  type EpisodeFeatures,
  type SelectionReference,
  type SelectionResult,
  type Victim,
} from "./v9-core";
import { V9MinuteStore } from "./v9-minute-store";

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
}

export const DEFAULT_V9_ENGINE_SETTINGS: V9EngineSettings = {
  windowMs: 3 * 24 * 3_600_000,
  referenceWindowMs: 3 * 24 * 3_600_000,
  minReferenceSamples: 5,
  maxSignalAgeMs: 2 * MINUTE_MS,
};

export interface V9Decision {
  symbol: string;
  episode: Episode;
  features: EpisodeFeatures;
  reference: SelectionReference;
  selection: SelectionResult;
  /** true only when selected AND fresh AND the reference is large enough. */
  tradable: boolean;
  reason:
    | "SELECTED"
    | "NOT_SELECTED"
    | "REFERENCE_TOO_SMALL"
    | "STALE_CONFIRMATION";
  evaluatedAt: number;
  /** Trade plan (fade): LONG victims -> BUY, SHORT victims -> SELL. */
  tradeSide: Victim;
  /** Episode extreme from its start through `evaluatedAt` (SL anchor). */
  stopPrice: number;
  referencePrice: number;
}

interface ReferenceSample {
  confirmTs: number;
  clr: number;
  dirMove: number;
}

export class V9CausalEngine {
  readonly store = new V9MinuteStore();
  private lastConfirmTs = -Infinity;
  private readonly reference: ReferenceSample[] = [];

  constructor(
    readonly symbol: string,
    private readonly settings: V9EngineSettings = DEFAULT_V9_ENGINE_SETTINGS,
  ) {}

  /** Evaluate with all data up to `now`. Returns decisions for episodes whose
   *  end became known since the previous call, oldest first. */
  evaluate(now: number): V9Decision[] {
    const from = now - this.settings.windowMs;
    this.store.prune(from - MINUTE_MS);
    const usable = usableRange(this.store.toBuckets(from, now));
    if (usable === null) return [];
    const regimes = changePoints(usable.map((b) => b.oi));
    const episodes = mergeEpisodes(usable, subEpisodes(usable, regimes, now));

    const fresh = episodes
      .filter(
        (e) =>
          Number.isFinite(e.confirmTs) &&
          e.confirmTs <= now &&
          e.confirmTs > this.lastConfirmTs,
      )
      .sort((a, b) => a.confirmTs - b.confirmTs);

    const decisions: V9Decision[] = [];
    for (const e of fresh) {
      const features = episodeFeatures(usable, e);
      const prior = this.reference.filter(
        (r) =>
          r.confirmTs < e.confirmTs &&
          r.confirmTs >= e.confirmTs - this.settings.referenceWindowMs,
      );
      const reference = buildReference(prior);
      const selection = selectEpisode(features, reference);
      const stale = now - e.confirmTs > this.settings.maxSignalAgeMs;
      const small = reference.sampleCount < this.settings.minReferenceSamples;
      const reason: V9Decision["reason"] = !selection.selected
        ? "NOT_SELECTED"
        : small
          ? "REFERENCE_TOO_SMALL"
          : stale
            ? "STALE_CONFIRMATION"
            : "SELECTED";
      const stopPrice = this.store.extremePrice(
        e.victim === "LONG" ? "LOW" : "HIGH",
        e.start,
        now,
      );
      decisions.push({
        symbol: this.symbol,
        episode: e,
        features,
        reference,
        selection,
        tradable: reason === "SELECTED",
        reason,
        evaluatedAt: now,
        tradeSide: e.victim,
        stopPrice,
        referencePrice: this.store.lastPrice(now),
      });
      if (features.dir)
        this.reference.push({
          confirmTs: e.confirmTs,
          clr: features.clr,
          dirMove: features.dirMove,
        });
      this.lastConfirmTs = e.confirmTs;
    }
    const keepFrom = now - this.settings.referenceWindowMs;
    while (this.reference.length && this.reference[0].confirmTs < keepFrom)
      this.reference.shift();
    return decisions;
  }
}
