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
 * Sep 9 2026 (Karo), operator-requested RESTORE -- REVERTS
 * v5IndividualEventP95() back to the ORIGINAL, production-proven
 * combined LONG+SHORT distribution (5000-sample capacity), exactly
 * matching the OLD liqwatch-bot's own notionalPercentile() call
 * (confirmed via direct old-code trace: its own `_victim` parameter
 * was ALREADY unused there too -- this project's own combined
 * behavior always matched the original). The victim-specific
 * regime (notionalPercentileForVictim(), added later) is KEPT, fully
 * intact, for diagnostics/research (see GlobalSignalDoc.
 * liquidationStatsContext) -- it is simply no longer called from
 * here, so it can never influence signal qualification/intensity/
 * TP-SL. `victim` stays a parameter (unused by this call) purely to
 * avoid touching V5WaveService's own constructor signature or call-
 * sites -- a genuinely smaller diff than reverting that too.
 */
export function v5IndividualEventP95(
  liqStats: LiquidationStatsService,
  symbol: string,
  victim: Side,
): number {
  return liqStats.notionalPercentile(symbol, victim, 95);
}
