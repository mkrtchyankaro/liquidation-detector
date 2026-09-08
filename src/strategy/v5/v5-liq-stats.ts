import type { LiquidationStatsService } from '../../domain/liquidation/liquidation-stats.service';

/**
 * Sep 7 2026, operator-approved (Karo) -- V5's STRICT qualification
 * uses PURE individual-event P95, deliberately WITHOUT the
 * 0.5*tierFloor blend that thresholdLargeLiq() applies (see
 * liquidation-stats.service.ts). That existing, battle-tested,
 * blended function is left completely untouched -- other code paths
 * (V3, V4) still use it exactly as before.
 *
 * This is a thin, one-line wrapper around the SAME underlying,
 * already-public notionalPercentile() the blended function itself
 * calls internally -- no duplicated percentile logic, no new
 * statistics implementation. Explicitly always the LONG-side sample
 * distribution (matching thresholdLargeLiq()'s own choice, confirmed
 * from source), since the underlying service tracks one combined,
 * side-agnostic notional-size distribution per symbol.
 *
 * Returns 0 if the symbol doesn't have enough warm samples yet
 * (matches notionalPercentile()'s own conservative fallback) --
 * callers must treat 0 as "not enough data yet", not a real threshold.
 */
export function v5IndividualEventP95(liqStats: LiquidationStatsService, symbol: string): number {
  return liqStats.notionalPercentile(symbol, "LONG", 95);
}
