import type { LiquidationOiEpisodeState } from "./episode-tracker";
import {
  oiDestructionFraction,
  liquidationToStartingOiRatio,
} from "./episode-tracker";
import type { LiquidationOiStrategyConfig } from "./config";

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 3.
 *
 * DELIBERATELY SEPARATE from LiquidationStatsService's individual-
 * event P95 (v5-liq-stats.ts) -- that mechanism is untouched, still
 * gates V5's own legacy WATCH. This gate consumes
 * EpisodePercentileService output (rolling 3-day, per-symbol,
 * per-direction, causal historical percentile) as an ALREADY-COMPUTED
 * context object -- this file has no Mongo/service dependency of its
 * own, keeping it pure and testable.
 */

export interface EpisodePercentileContext {
  historicalSampleCount: number | null;
  historicalP90: number | null;
  historicalP95: number | null;
  historicalP99: number | null;
  percentileRank: number | null;
}

export type NoSignalReasonCode =
  | "PERCENTILE_NOT_READY"
  | "INSUFFICIENT_SAMPLE_COUNT"
  | "BELOW_MINIMUM_PERCENTILE_RANK"
  | "INSUFFICIENT_DISPLACEMENT"
  | "ATR_NOT_READY";

export interface WatchQualificationSuccess {
  qualifies: true;
  episodePercentileRank: number;
  displacementAtr: number;
  liquidationToOiRatio: number | null;
  oiDestructionFractionAtQualification: number | null;
}
export interface WatchQualificationFailure {
  qualifies: false;
  reasonCode: NoSignalReasonCode;
  detail: string;
}
export type WatchQualificationResult =
  | WatchQualificationSuccess
  | WatchQualificationFailure;

/** Pure gate: decides whether EPISODE_TRACKING -> WATCH_QUALIFIED.
 *  Every failure path returns an explicit, persistable reason code. */
export function qualifyWatch(
  episode: LiquidationOiEpisodeState,
  percentile: EpisodePercentileContext,
  atr3m: number | null,
  config: LiquidationOiStrategyConfig,
): WatchQualificationResult {
  if (
    percentile.percentileRank === null ||
    percentile.historicalSampleCount === null
  ) {
    return {
      qualifies: false,
      reasonCode: "PERCENTILE_NOT_READY",
      detail:
        "EpisodePercentileService has not yet produced a causal percentile context for this symbol/direction -- prefer no signal over an unreliable one",
    };
  }
  if (
    percentile.historicalSampleCount < config.minHistoricalSampleCountForWatch
  ) {
    return {
      qualifies: false,
      reasonCode: "INSUFFICIENT_SAMPLE_COUNT",
      detail: `historicalSampleCount=${percentile.historicalSampleCount} < minHistoricalSampleCountForWatch=${config.minHistoricalSampleCountForWatch}`,
    };
  }
  if (percentile.percentileRank < config.minPercentileRankForWatch) {
    return {
      qualifies: false,
      reasonCode: "BELOW_MINIMUM_PERCENTILE_RANK",
      detail: `percentileRank=${percentile.percentileRank.toFixed(1)} < minPercentileRankForWatch=${config.minPercentileRankForWatch}`,
    };
  }
  if (atr3m === null || atr3m <= 0) {
    return {
      qualifies: false,
      reasonCode: "ATR_NOT_READY",
      detail:
        "ATR3m is not yet available or non-positive -- cannot normalize displacement",
    };
  }
  const displacementAtr =
    Math.abs(episode.extremePrice - episode.startPrice) / atr3m;
  if (displacementAtr < config.minDisplacementAtrForWatch) {
    return {
      qualifies: false,
      reasonCode: "INSUFFICIENT_DISPLACEMENT",
      detail: `displacementAtr=${displacementAtr.toFixed(3)} < minDisplacementAtrForWatch=${config.minDisplacementAtrForWatch}`,
    };
  }

  return {
    qualifies: true,
    episodePercentileRank: percentile.percentileRank,
    displacementAtr,
    liquidationToOiRatio: liquidationToStartingOiRatio(
      episode,
      episode.startPrice,
    ),
    oiDestructionFractionAtQualification: oiDestructionFraction(episode),
  };
}
