import type { EpisodePercentileContext } from "./watch-qualification";

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 5-7.
 *
 * HONEST LIMITATION, documented rather than hidden: EpisodePercentileService
 * exposes only summary thresholds -- historicalP90/P95/P99 and
 * sampleCount -- not the full underlying sample array. A true
 * continuous percentile rank would require that full array. Live,
 * this function APPROXIMATES a rank by linear interpolation between
 * the three known points -- reasonable between two known points,
 * cruder below P90 or above P99, always bounded to [0,100].
 */

export function approximatePercentileRank(
  sampleCount: number | null,
  p90: number | null,
  p95: number | null,
  p99: number | null,
  value: number,
): number | null {
  if (sampleCount === null || p90 === null || p95 === null || p99 === null)
    return null;
  if (value <= 0) return 0;

  if (value <= p90) {
    return p90 > 0 ? Math.max(0, Math.min(90, (value / p90) * 90)) : 90;
  }
  if (value <= p95) {
    if (p95 === p90) return 90;
    return 90 + ((value - p90) / (p95 - p90)) * 5;
  }
  if (value <= p99) {
    if (p99 === p95) return 95;
    return 95 + ((value - p95) / (p99 - p95)) * 4;
  }
  const slope = p99 > p95 ? 4 / (p99 - p95) : 0;
  return Math.min(100, 99 + (value - p99) * slope);
}

export function buildPercentileContext(
  sampleCount: number | null,
  p90: number | null,
  p95: number | null,
  p99: number | null,
  currentEpisodeUsd: number,
): EpisodePercentileContext {
  return {
    historicalSampleCount: sampleCount,
    historicalP90: p90,
    historicalP95: p95,
    historicalP99: p99,
    percentileRank: approximatePercentileRank(
      sampleCount,
      p90,
      p95,
      p99,
      currentEpisodeUsd,
    ),
  };
}
