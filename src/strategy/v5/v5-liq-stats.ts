import type { LiquidationStatsService } from "../../domain/liquidation/liquidation-stats.service";
import type { Side } from "../../shared/common.types";

/**
 * Sep 7 2026, operator-approved (Karo) -- V5's STRICT qualification
 * uses PURE individual-event P95, deliberately WITHOUT the
 * 0.5*tierFloor blend that thresholdLargeLiq() applies (see
 * liquidation-stats.service.ts). That existing, battle-tested,
 * blended function is left completely untouched -- other code paths
 * (V3, V4) still use it exactly as before.
 *
 * Sep 9 2026 (Karo), operator-requested victim-side-specific regime
 * with safe fallback -- REPLACES the previous, always-"LONG",
 * effectively side-agnostic single-line wrapper (confirmed via a full
 * trace: the underlying service tracked one combined distribution
 * regardless of which side-string was passed). Now delegates to
 * LiquidationStatsService.notionalPercentileForVictim(), which
 * returns victim-specific P95 when there is enough victim-specific
 * data (>= minSamplesForPercentiles), falling back to the EXISTING
 * combined LONG+SHORT distribution otherwise -- see that method's own
 * doc comment for the exact consistency guarantee with the paired
 * liqBaseline computation.
 *
 * Returns 0 if the symbol doesn't have enough warm samples yet
 * (either regime) -- callers must treat 0 as "not enough data yet",
 * not a real threshold.
 */
export function v5IndividualEventP95(
  liqStats: LiquidationStatsService,
  symbol: string,
  victim: Side,
): number {
  return liqStats.notionalPercentileForVictim(symbol, victim, 95).value;
}
