/**
 * Sep 11 2026 (Karo), operator-requested. Deterministic production SL/TP
 * for the liquidation-reversal strategy, derived from the FULL
 * liquidation episode's own structural displacement -- NOT from ATR,
 * liquidation-strength, RR-ladder, Hybrid-C, or any fixed percentage.
 * Distinct from and unrelated to the OLDER, UNIT-extreme-based
 * structural-trade-plan.ts (Sep 9, still used by the legacy,
 * non-cascade V5 path only) -- this file is the operator's OWN,
 * NEWLY-specified episode-displacement formula for the cascade path.
 *
 * Formula (exactly as specified by the operator, no deviation):
 *   episodeDisplacement = |firstAnchorPrice - finalExtremePrice|
 *   LONG:  naturalSL = finalExtremePrice - episodeDisplacement
 *   SHORT: naturalSL = finalExtremePrice + episodeDisplacement
 *   naturalRiskPct = |entryPrice - naturalSL| / entryPrice
 *   executionRiskPct = clamp(naturalRiskPct, 0.0020, 0.0050)
 *   LONG:  stopLoss = entryPrice * (1 - executionRiskPct)
 *   SHORT: stopLoss = entryPrice * (1 + executionRiskPct)
 *   riskDistance = |entryPrice - stopLoss|
 *   rewardDistance = riskDistance * 2.2
 *   LONG:  takeProfit = entryPrice + rewardDistance
 *   SHORT: takeProfit = entryPrice - rewardDistance
 *
 * The structural calculation (naturalSL) and the execution-risk policy
 * (the 0.20%-0.50% clamp) are DELIBERATELY separate steps -- a wide
 * natural stop is never used as a reason to reject the setup; it is
 * simply capped for execution. TP is always derived from the FINAL
 * EXECUTABLE risk distance (post-clamp), never from naturalSL,
 * firstAnchorPrice, ATR, or wave efficiency.
 */

const MIN_RISK_PCT = 0.002; // 0.20%
const MAX_RISK_PCT = 0.005; // 0.50%
const REWARD_RISK_RATIO = 2.2;

export type SlAdjustment = "MIN_FLOOR" | "STRUCTURAL" | "MAX_CAP";

export interface EpisodeDisplacementTradePlan {
  readonly entryPrice: number;
  readonly direction: "LONG" | "SHORT";
  readonly firstAnchorPrice: number;
  readonly finalExtremePrice: number;
  readonly episodeDisplacement: number;
  readonly episodeDisplacementPct: number;
  readonly naturalSL: number;
  readonly naturalRiskPct: number;
  readonly executionRiskPct: number;
  readonly slAdjustment: SlAdjustment;
  readonly stopLoss: number;
  readonly riskDistance: number;
  readonly rewardDistance: number;
  readonly rewardRiskRatio: number;
  readonly takeProfit: number;
  /** Sep 11 2026 (Karo), operator-requested -- ADDITIVE, OBSERVATIONAL/
   *  ANALYTICAL LOGGING ONLY. None of the fields below feed back into
   *  naturalSL, executionRiskPct, stopLoss, or takeProfit above -- they
   *  are computed AFTER and FROM those already-final values, purely for
   *  visibility. unitAbs is the SAME frozen 1m Wilder ATR(240) the
   *  candidate itself was frozen with at cascade start (passed in,
   *  never recalculated here). */
  readonly unitAbs: number;
  readonly unitPctAtEntry: number;
  readonly actualRecoveryDistance: number;
  readonly actualRecoveryPct: number;
  readonly actualRecoveryUnits: number;
  readonly stopDistanceUnits: number;
  readonly takeProfitDistanceUnits: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function slAdjustmentFor(naturalRiskPct: number): SlAdjustment {
  if (naturalRiskPct < MIN_RISK_PCT) return "MIN_FLOOR";
  if (naturalRiskPct > MAX_RISK_PCT) return "MAX_CAP";
  return "STRUCTURAL";
}

export function deriveEpisodeDisplacementTradePlan(p: {
  entryPrice: number;
  direction: "LONG" | "SHORT";
  firstAnchorPrice: number;
  finalExtremePrice: number;
  /** The SAME frozen 1m Wilder ATR(240) UNIT the candidate itself was
   *  frozen with at cascade start -- never recalculated here, used
   *  ONLY to derive the additive, observational UNIT-relative fields
   *  below. Never participates in naturalSL/stopLoss/takeProfit. */
  unitAbs: number;
}): EpisodeDisplacementTradePlan {
  const episodeDisplacement = Math.abs(
    p.firstAnchorPrice - p.finalExtremePrice,
  );
  const episodeDisplacementPct =
    p.firstAnchorPrice > 0 ? episodeDisplacement / p.firstAnchorPrice : 0;

  const naturalSL =
    p.direction === "LONG"
      ? p.finalExtremePrice - episodeDisplacement
      : p.finalExtremePrice + episodeDisplacement;

  const naturalRiskPct =
    p.entryPrice > 0 ? Math.abs(p.entryPrice - naturalSL) / p.entryPrice : 0;
  const executionRiskPct = clamp(naturalRiskPct, MIN_RISK_PCT, MAX_RISK_PCT);
  const slAdjustment = slAdjustmentFor(naturalRiskPct);

  const stopLoss =
    p.direction === "LONG"
      ? p.entryPrice * (1 - executionRiskPct)
      : p.entryPrice * (1 + executionRiskPct);

  const riskDistance = Math.abs(p.entryPrice - stopLoss);
  const rewardDistance = riskDistance * REWARD_RISK_RATIO;
  const takeProfit =
    p.direction === "LONG"
      ? p.entryPrice + rewardDistance
      : p.entryPrice - rewardDistance;

  // ── Observational/analytical UNIT-relative logging fields only --
  // computed AFTER the above, never feeding back into them. ──
  const unitPctAtEntry = p.entryPrice > 0 ? p.unitAbs / p.entryPrice : 0;
  const actualRecoveryDistance = Math.abs(p.entryPrice - p.finalExtremePrice);
  const actualRecoveryPct =
    p.entryPrice > 0 ? actualRecoveryDistance / p.entryPrice : 0;
  const actualRecoveryUnits =
    p.unitAbs > 0 ? actualRecoveryDistance / p.unitAbs : 0;
  const stopDistanceUnits = p.unitAbs > 0 ? riskDistance / p.unitAbs : 0;
  const takeProfitDistanceUnits =
    p.unitAbs > 0 ? rewardDistance / p.unitAbs : 0;

  return {
    entryPrice: p.entryPrice,
    direction: p.direction,
    firstAnchorPrice: p.firstAnchorPrice,
    finalExtremePrice: p.finalExtremePrice,
    episodeDisplacement,
    episodeDisplacementPct,
    naturalSL,
    naturalRiskPct,
    executionRiskPct,
    slAdjustment,
    stopLoss,
    riskDistance,
    rewardDistance,
    rewardRiskRatio: REWARD_RISK_RATIO,
    takeProfit,
    unitAbs: p.unitAbs,
    unitPctAtEntry,
    actualRecoveryDistance,
    actualRecoveryPct,
    actualRecoveryUnits,
    stopDistanceUnits,
    takeProfitDistanceUnits,
  };
}
