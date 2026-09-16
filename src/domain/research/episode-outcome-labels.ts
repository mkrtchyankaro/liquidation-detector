import type { Side } from "../../shared/common.types";
import { fetchKlines } from "./displacement-balanced-core";

/**
 * Sep 16 2026 (Karo), operator-approved. FUTURE DATA LIVES HERE ONLY.
 * This module is the ONE place in the whole research pipeline allowed
 * to read candles after an episode's own END -- deliberately isolated
 * from every causal-feature module (displacement-balanced-core.ts,
 * episode-historical-percentile.ts, episode-oi-trajectory.ts), none
 * of which import from or call into this file. The causality test in
 * tests/episode-research-causality.test.ts asserts exactly this
 * separation holds in practice, not just by convention.
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

/** Fetches closed 1m candles for [endTime, endTime + maxHorizonMin]
 *  and computes MFE/MAE/close-return per horizon, normalized in both
 *  percent and ATR units. `atr3mAtEnd` must be the CAUSAL ATR3m
 *  already captured on the episode's own RECOVERY_CONFIRMED
 *  transition -- never re-fetched or re-derived here. `direction`
 *  determines which side is favorable (LONG -> UP, SHORT -> DOWN).
 *  Returns null for any horizon where insufficient future data
 *  exists -- never fabricates an outcome. */
export async function computeEpisodeOutcomeLabels(
  symbol: string,
  direction: Side,
  endTime: number,
  closeAtEnd: number,
  extremePrice: number,
  atr3mAtEnd: number | null,
  researchWindowToMs: number,
): Promise<EpisodeOutcomeLabels> {
  const maxHorizonMs = Math.max(...OUTCOME_HORIZONS_MIN) * 60_000;
  const fetchToMs = Math.min(endTime + maxHorizonMs, researchWindowToMs);
  const candles =
    fetchToMs > endTime
      ? await fetchKlines(symbol, 60_000, endTime, fetchToMs)
      : [];
  const afterEnd = candles
    .filter((c) => c.closeTime > endTime)
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
