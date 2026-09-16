/**
 * Sep 16 2026 (Karo), operator-requested. EXTRACTED, not duplicated:
 * the exact formula below is verified byte-for-byte against
 * execute-for-user.usecase.ts (lines ~80-102):
 *
 *   const slDistance = Math.abs(globalSignal.entry - globalSignal.sl);
 *   const riskUsd = runtime.config.risk.riskUsd;
 *   const positionQty = riskUsd / slDistance;
 *   const positionSizeUsdt = positionQty * globalSignal.entry;
 *
 * Generalized to a pure function taking (entry, structuralInvalidationPrice,
 * riskUsd) instead of reading globalSignal.sl/runtime.config directly,
 * so it has no coupling to the legacy V3/V5 signal shape and is
 * standalone testable. The CALLER (Phase 5's per-user execution
 * orchestrator) is responsible for passing
 * `riskUsd = runtime.config.risk.riskUsd` -- this file never reads or
 * invents any risk configuration itself.
 *
 * riskUsd is the EXISTING RiskUserConfig.riskUsd field
 * (user-config.model.ts), the same one V3/V5 already use. No
 * LIQUIDATION_OI_RISK_USD or equivalent exists anywhere in this
 * codebase, and this file introduces none.
 */

export interface SizingInput {
  entry: number;
  structuralInvalidationPrice: number;
  riskUsd: number;
}

export interface SizingResult {
  valid: true;
  stopDistance: number;
  positionQty: number;
  positionSizeUsdt: number;
}
export interface SizingFailure {
  valid: false;
  reason: string;
}
export type SizingOutcome = SizingResult | SizingFailure;

/** Mirrors execute-for-user.usecase.ts's own slDistance<=0 guard.
 *  Does NOT itself apply Binance min-notional/min-qty/precision --
 *  that remains BinanceExecutionService's own computeOrderPlan()
 *  responsibility, reused unchanged downstream; this function's
 *  output (positionSizeUsdt) is exactly the shape
 *  ExecutionInput.positionSizeUsdt already expects. */
export function computePositionSizing(input: SizingInput): SizingOutcome {
  const stopDistance = Math.abs(
    input.entry - input.structuralInvalidationPrice,
  );
  if (stopDistance <= 0)
    return {
      valid: false,
      reason:
        "stopDistance <= 0 -- structural invalidation price cannot equal entry",
    };
  if (input.riskUsd <= 0)
    return {
      valid: false,
      reason: `riskUsd must be positive, got ${input.riskUsd}`,
    };
  const positionQty = input.riskUsd / stopDistance;
  const positionSizeUsdt = positionQty * input.entry;
  return { valid: true, stopDistance, positionQty, positionSizeUsdt };
}
