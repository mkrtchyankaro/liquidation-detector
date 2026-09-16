import type { Side } from "../../shared/common.types";
import { percentile } from "./displacement-balanced-core";

/**
 * Sep 16 2026 (Karo), operator-approved (Change 1 of the research-
 * pipeline design). Answers "what would the bot have known about this
 * episode's seriousness at the historical moment it ended?" -- NOT
 * "how serious does this episode look against the full research
 * dataset." The distinction matters: using the full dataset would let
 * episodes from AFTER T change T's own historical seriousness
 * classification, which is exactly the kind of lookahead leakage this
 * whole research pipeline exists to avoid.
 *
 * Deliberately SEPARATE from, and does not call into,
 * EpisodePercentileService (the live production cache) -- this is a
 * REPLAY of that same concept (same symbol, same direction, rolling
 * prior 3 days) computed once over a static historical dataset for
 * research purposes, not a live service.
 */

export interface HistoricalPercentileContext {
  historicalSampleCount: number;
  historicalP90: number | null;
  historicalP95: number | null;
  /** 0-100. Fraction of the PRIOR reference population with
   *  sameDirectionUsd <= this episode's own, as a percentage. null
   *  when historicalSampleCount === 0 -- never fabricated. */
  percentileRank: number | null;
}

export interface CompletedEpisodeRef {
  symbol: string;
  direction: Side;
  endTime: number;
  sameDirectionUsd: number;
}

const DEFAULT_ROLLING_WINDOW_MS = 3 * 86_400_000;

/** For episode E ending at T, computes seriousness using ONLY
 *  completed episodes with `endTime < T` (strictly before -- this is
 *  what excludes E from classifying itself, and what makes a future
 *  episode structurally unable to affect E's own result) and
 *  `endTime >= T - windowMs`, matching same symbol + same direction.
 *  Returns all-null fields when the prior reference population is
 *  empty -- never fabricates a threshold from insufficient history. */
export function computeCausalHistoricalPercentile(
  target: CompletedEpisodeRef,
  allCompletedEpisodes: readonly CompletedEpisodeRef[],
  windowMs: number = DEFAULT_ROLLING_WINDOW_MS,
): HistoricalPercentileContext {
  const priorSameSymbolDirection = allCompletedEpisodes.filter(
    (e) =>
      e.symbol === target.symbol &&
      e.direction === target.direction &&
      e.endTime < target.endTime &&
      e.endTime >= target.endTime - windowMs,
  );
  if (priorSameSymbolDirection.length === 0) {
    return {
      historicalSampleCount: 0,
      historicalP90: null,
      historicalP95: null,
      percentileRank: null,
    };
  }
  const usdSorted = priorSameSymbolDirection
    .map((e) => e.sameDirectionUsd)
    .sort((a, b) => a - b);
  const historicalP90 = percentile(usdSorted, 0.9);
  const historicalP95 = percentile(usdSorted, 0.95);
  const countAtOrBelow = usdSorted.filter(
    (v) => v <= target.sameDirectionUsd,
  ).length;
  const percentileRank = (countAtOrBelow / usdSorted.length) * 100;
  return {
    historicalSampleCount: usdSorted.length,
    historicalP90,
    historicalP95,
    percentileRank,
  };
}
