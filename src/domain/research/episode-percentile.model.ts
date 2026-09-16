/**
 * Sep 16 2026 (Karo), operator-approved. Cache shape for
 * EpisodePercentileService. Deliberately SEPARATE from the existing
 * individual-event P95 (v5-liq-stats.ts / LiquidationStatsService) --
 * that measures a single liquidation's own size, live, in-memory,
 * rolling. This measures completed DISPLACEMENT_BALANCED episode
 * TOTAL same-direction USD, over a rolling 3-day historical window,
 * refreshed on startup and after signal close. The two systems must
 * never be confused or merged.
 */

export interface DirectionPercentiles {
  p90: number | null;
  p95: number | null;
  /** Diagnostic only -- not to be used for signal qualification. */
  p99: number | null;
  sampleCount: number;
}

export interface SymbolPercentileSnapshot {
  symbol: string;
  long: DirectionPercentiles;
  short: DirectionPercentiles;
  computedAt: number;
  /** The rolling window this snapshot was REQUESTED to cover. */
  windowFromMs: number;
  windowToMs: number;
  /** The ACTUAL data coverage found in Mongo for this symbol --
   *  independent of windowFromMs/windowToMs. Never fabricated: if
   *  Mongo doesn't have the full requested window, this says so. */
  actualCoverageFromMs: number | null;
  actualCoverageToMs: number | null;
  leftCensoredExcluded: number;
  rightCensoredExcluded: number;
  /** true when the LAST refresh attempt for this symbol failed --
   *  this snapshot is carried over from an earlier successful
   *  refresh, not fabricated or partially updated. */
  stale: boolean;
}
