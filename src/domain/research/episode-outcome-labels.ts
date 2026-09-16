import type { Side, Candle } from "../../shared/common.types";

/**
 * Sep 16 2026 (Karo), operator-approved. FUTURE DATA LIVES HERE ONLY.
 * This module is the ONE place in the whole research pipeline that
 * reads candles after an episode's own END -- deliberately isolated
 * from every causal-feature module (displacement-balanced-core.ts,
 * episode-historical-percentile.ts, episode-oi-trajectory.ts), none
 * of which import from or call into this file. The causality test in
 * tests/episode-research-causality.test.ts asserts exactly this
 * separation holds in practice, not just by convention.
 *
 * Sep 16 2026 (Karo), operator-requested (429 fix). This function no
 * longer fetches its own candles -- it used to call fetchKlines once
 * PER EPISODE, which meant 162 separate REST calls across just 3
 * symbols in the first real run, with heavily overlapping windows
 * (episodes ending close together in time re-fetch nearly the same
 * 60-minute stretch), and no retry on 429. The caller now fetches 1m
 * candles ONCE per symbol (covering the whole research window plus
 * the outcome buffer) and passes that array in here to be filtered
 * per episode -- zero additional network calls per episode.
 */

export interface HorizonOutcome {
  mfePct: number | null;
  maePct: number | null;
  mfeAtr: number | null;
  maeAtr: number | null;
  closeReturnPct: number | null;
  timeToFavorableMs: number | null;
}

export const OUTCOME_HORIZONS_MIN = [1, 3, 5, 10, 15, 30, 60] as const;
export type OutcomeHorizonMin = (typeof OUTCOME_HORIZONS_MIN)[number];

export interface EpisodeOutcomeLabels {
  outcomes: Record<OutcomeHorizonMin, HorizonOutcome | null>;
  madeAdverseNewExtremeAfterEnd: boolean | null;
}

/** Computes MFE/MAE/close-return per horizon from an ALREADY-FETCHED
 *  1m candle pool (`postEndCandlePool` -- must cover at least
 *  [endTime, endTime + 60min] for full-horizon coverage; a shorter
 *  pool simply yields null for horizons it doesn't reach, never a
 *  fabricated value), normalized in both percent and ATR units.
 *  `atr3mAtEnd` must be the CAUSAL ATR3m already captured on the
 *  episode's own RECOVERY_CONFIRMED transition -- never re-derived
 *  here. `direction` determines which side is favorable (LONG -> UP,
 *  SHORT -> DOWN). Returns null for any horizon where insufficient
 *  future data exists in the pool -- never fabricates an outcome. */
export function computeEpisodeOutcomeLabels(
  symbol: string,
  direction: Side,
  endTime: number,
  closeAtEnd: number,
  extremePrice: number,
  atr3mAtEnd: number | null,
  researchWindowToMs: number,
  postEndCandlePool: readonly Candle[],
): EpisodeOutcomeLabels {
  const afterEnd = postEndCandlePool
    .filter((c) => c.symbol === symbol && c.closeTime > endTime)
    .sort((a, b) => a.openTime - b.openTime);

  const outcomes: Record<number, HorizonOutcome | null> = {};
  let adverseExtremeRevisited = false;
  let anyHorizonComputed = false;

  for (const horizonMin of OUTCOME_HORIZONS_MIN) {
    const horizonEndMs = endTime + horizonMin * 60_000;
    if (horizonEndMs > researchWindowToMs) {
      outcomes[horizonMin] = null;
      continue;
    }
    const window = afterEnd.filter((c) => c.closeTime <= horizonEndMs);
    if (window.length === 0) {
      outcomes[horizonMin] = null;
      continue;
    }
    anyHorizonComputed = true;

    let favorableExtreme = direction === "LONG" ? -Infinity : Infinity;
    let adverseExtreme = direction === "LONG" ? Infinity : -Infinity;
    let timeToFavorableMs: number | null = null;
    const noiseFloor = atr3mAtEnd !== null ? atr3mAtEnd * 0.1 : 0;

    for (const c of window) {
      if (direction === "LONG") {
        if (c.high > favorableExtreme) favorableExtreme = c.high;
        if (c.low < adverseExtreme) adverseExtreme = c.low;
        if (timeToFavorableMs === null && c.high - closeAtEnd >= noiseFloor)
          timeToFavorableMs = c.closeTime - endTime;
        if (c.low < extremePrice) adverseExtremeRevisited = true;
      } else {
        if (c.low < favorableExtreme) favorableExtreme = c.low;
        if (c.high > adverseExtreme) adverseExtreme = c.high;
        if (timeToFavorableMs === null && closeAtEnd - c.low >= noiseFloor)
          timeToFavorableMs = c.closeTime - endTime;
        if (c.high > extremePrice) adverseExtremeRevisited = true;
      }
    }
    const lastClose = window[window.length - 1]!.close;
    const mfe =
      direction === "LONG"
        ? favorableExtreme - closeAtEnd
        : closeAtEnd - favorableExtreme;
    const mae =
      direction === "LONG"
        ? adverseExtreme - closeAtEnd
        : closeAtEnd - adverseExtreme;
    const closeReturn =
      direction === "LONG" ? lastClose - closeAtEnd : closeAtEnd - lastClose;

    outcomes[horizonMin] = {
      mfePct: (mfe / closeAtEnd) * 100,
      maePct: (mae / closeAtEnd) * 100,
      mfeAtr: atr3mAtEnd !== null && atr3mAtEnd > 0 ? mfe / atr3mAtEnd : null,
      maeAtr: atr3mAtEnd !== null && atr3mAtEnd > 0 ? mae / atr3mAtEnd : null,
      closeReturnPct: (closeReturn / closeAtEnd) * 100,
      timeToFavorableMs,
    };
  }

  return {
    outcomes: outcomes as Record<OutcomeHorizonMin, HorizonOutcome | null>,
    madeAdverseNewExtremeAfterEnd: anyHorizonComputed
      ? adverseExtremeRevisited
      : null,
  };
}
