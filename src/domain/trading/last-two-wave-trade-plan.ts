const MIN_RISK_PCT = 0.003; // 0.30%
const MAX_RISK_PCT = 0.005; // 0.50%
const REWARD_RISK_RATIO = 2.2;

export type SlAdjustment = "MIN_FLOOR" | "STRUCTURAL" | "MAX_CAP";

export interface LastTwoWaveTradePlan {
  readonly entryPrice: number;
  readonly direction: "LONG" | "SHORT";
  readonly previousExtreme: number;
  readonly finalExtreme: number;
  readonly lastLegExtension: number;
  readonly naturalSL: number;
  readonly naturalRiskPct: number;
  readonly executionRiskPct: number;
  readonly slAdjustment: SlAdjustment;
  readonly stopLoss: number;
  readonly riskDistance: number;
  readonly rewardDistance: number;
  readonly rewardRiskRatio: number;
  readonly takeProfit: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function slAdjustmentFor(naturalRiskPct: number): SlAdjustment {
  if (naturalRiskPct < MIN_RISK_PCT) return "MIN_FLOOR";
  if (naturalRiskPct > MAX_RISK_PCT) return "MAX_CAP";
  return "STRUCTURAL";
}

export function deriveLastTwoWaveTradePlan(p: {
  entryPrice: number;
  direction: "LONG" | "SHORT";
  previousExtreme: number;
  finalExtreme: number;
}): LastTwoWaveTradePlan {
  const lastLegExtension = Math.abs(p.previousExtreme - p.finalExtreme);
  const naturalSL =
    p.direction === "LONG"
      ? p.finalExtreme - lastLegExtension
      : p.finalExtreme + lastLegExtension;

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

  return {
    entryPrice: p.entryPrice,
    direction: p.direction,
    previousExtreme: p.previousExtreme,
    finalExtreme: p.finalExtreme,
    lastLegExtension,
    naturalSL,
    naturalRiskPct,
    executionRiskPct,
    slAdjustment,
    stopLoss,
    riskDistance,
    rewardDistance,
    rewardRiskRatio: REWARD_RISK_RATIO,
    takeProfit,
  };
}
