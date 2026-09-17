import type { Side } from "../../shared/common.types";
import type { LiquidationOiActiveLifecycleConfig } from "./active-lifecycle-config";
import type { OiPriceEfficiencyState } from "./active-main-monitor";

/**
 * Sep 17 2026 (Karo), operator-requested Section K. Initial TP still
 * comes from InitialCapacityModel (unchanged) -- this controller only
 * REVISES it, post-entry, on meaningful evidence. Pure; the
 * orchestrator is responsible for acting on its output.
 */

export type DynamicExitDecision =
  | "HOLD"
  | "EXTEND_TP"
  | "TIGHTEN_TP"
  | "MARKET_EXIT";

export interface DynamicExitControllerState {
  currentTargetPrice: number;
  revision: number;
  lastRevisionAt: number | null;
}

export function initDynamicExitState(
  initialTpPrice: number,
): DynamicExitControllerState {
  return {
    currentTargetPrice: initialTpPrice,
    revision: 0,
    lastRevisionAt: null,
  };
}

export interface DynamicExitEvalInput {
  candidateSide: Side;
  currentPrice: number;
  atr3m: number | null;
  oiPriceEfficiencyState: OiPriceEfficiencyState;
  proposedTargetPrice: number | null;
  nowMs: number;
}

export interface DynamicExitEvalResult {
  decision: DynamicExitDecision;
  nextState: DynamicExitControllerState;
  reason: string;
}

/** ADVERSE_CONFIRMED always wins (MARKET_EXIT), regardless of cooldown.
 *  Otherwise: no revision unless proposedTargetPrice is supplied, the
 *  move exceeds dynamicTpMinMeaningfulChangeAtr, the cooldown has
 *  elapsed, and (for TIGHTEN_TP) the new target stays at least
 *  dynamicTpMinDistanceFromPriceAtr from the current price. */
export function evaluateDynamicExit(
  prev: DynamicExitControllerState,
  input: DynamicExitEvalInput,
  config: LiquidationOiActiveLifecycleConfig,
): DynamicExitEvalResult {
  if (input.oiPriceEfficiencyState === "ADVERSE_CONFIRMED") {
    return {
      decision: "MARKET_EXIT",
      nextState: prev,
      reason: "OI-price efficiency thesis flip confirmed (ADVERSE_CONFIRMED)",
    };
  }

  if (
    input.proposedTargetPrice === null ||
    input.atr3m === null ||
    input.atr3m <= 0
  ) {
    return {
      decision: "HOLD",
      nextState: prev,
      reason: "no proposed target or ATR unavailable",
    };
  }

  if (
    prev.lastRevisionAt !== null &&
    input.nowMs - prev.lastRevisionAt < config.dynamicTpCooldownMs
  ) {
    return {
      decision: "HOLD",
      nextState: prev,
      reason: `cooldown active (${input.nowMs - prev.lastRevisionAt}ms since last revision, requires ${config.dynamicTpCooldownMs}ms)`,
    };
  }

  const changeAtr =
    Math.abs(input.proposedTargetPrice - prev.currentTargetPrice) / input.atr3m;
  if (changeAtr < config.dynamicTpMinMeaningfulChangeAtr) {
    return {
      decision: "HOLD",
      nextState: prev,
      reason: `proposed change ${changeAtr.toFixed(3)} ATR below dynamicTpMinMeaningfulChangeAtr=${config.dynamicTpMinMeaningfulChangeAtr}`,
    };
  }

  const isExtending =
    input.candidateSide === "LONG"
      ? input.proposedTargetPrice > prev.currentTargetPrice
      : input.proposedTargetPrice < prev.currentTargetPrice;

  if (!isExtending) {
    const distanceFromPriceAtr =
      Math.abs(input.proposedTargetPrice - input.currentPrice) / input.atr3m;
    if (distanceFromPriceAtr < config.dynamicTpMinDistanceFromPriceAtr) {
      return {
        decision: "HOLD",
        nextState: prev,
        reason: `TIGHTEN_TP rejected -- ${distanceFromPriceAtr.toFixed(3)} ATR from price is below dynamicTpMinDistanceFromPriceAtr=${config.dynamicTpMinDistanceFromPriceAtr}`,
      };
    }
  }

  const nextState: DynamicExitControllerState = {
    currentTargetPrice: input.proposedTargetPrice,
    revision: prev.revision + 1,
    lastRevisionAt: input.nowMs,
  };
  return {
    decision: isExtending ? "EXTEND_TP" : "TIGHTEN_TP",
    nextState,
    reason: `meaningful change ${changeAtr.toFixed(3)} ATR, cooldown clear`,
  };
}
