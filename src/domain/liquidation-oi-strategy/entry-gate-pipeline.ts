import type { Side } from "../../shared/common.types";
import type { LiquidationOiEpisodeState } from "./episode-tracker";
import {
  detectClearingState,
  isClearingEndDetected,
  type OiHistorySample,
  type ClearingState,
} from "./oi-clearing-detector";
import type { LiquidationOiStrategyConfig } from "./config";
import { candidateTradeSideForVictim } from "./lifecycle.types";

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 4.
 *
 * ENTRY_READY DECISION ONLY -- this module never places a Binance
 * order and never touches execution/risk infrastructure (Phase 5+).
 * OI alone must never trigger entry: isClearingEndDetected() being
 * true is a NECESSARY but not SUFFICIENT condition here -- causal
 * price counter-move confirmation is required independently and
 * jointly.
 */

export type EntryNoSignalReasonCode =
  | "CLEARING_NOT_DETECTED"
  | "NO_COUNTER_MOVE_YET"
  | "TOO_FAR_FROM_EXTREME"
  | "STALE_OI"
  | "ATR_NOT_READY";

export interface PriceConfirmationInput {
  currentPrice: number;
  extremePrice: number;
  victim: Side;
  atr3m: number;
}

/** Favorable counter-move from the extreme, in ATR3m units. */
export function counterMoveAtr(input: PriceConfirmationInput): number {
  const favorableMove =
    input.victim === "LONG"
      ? input.currentPrice - input.extremePrice
      : input.extremePrice - input.currentPrice;
  return favorableMove / input.atr3m;
}

export interface EntryGateSuccess {
  entryReady: true;
  candidateSide: Side;
  clearingState: ClearingState;
  counterMoveAtr: number;
  distanceFromExtremeAtr: number;
}
export interface EntryGateFailure {
  entryReady: false;
  reasonCode: EntryNoSignalReasonCode;
  detail: string;
  clearingState: ClearingState | null;
}
export type EntryGateResult = EntryGateSuccess | EntryGateFailure;

export interface EvaluateEntryGatesInput {
  episode: LiquidationOiEpisodeState;
  oiHistory: readonly OiHistorySample[];
  currentPrice: number;
  atr3m: number | null;
  atr3mAgeMs: number | null;
  nowMs: number;
  config: LiquidationOiStrategyConfig;
}

/** Assumes WATCH_QUALIFIED has already passed -- this function does
 *  not re-check percentile/sample-count/displacement, only the
 *  clearing+price gates specific to EXHAUSTION_CANDIDATE ->
 *  ENTRY_READY. */
export function evaluateEntryGates(
  input: EvaluateEntryGatesInput,
): EntryGateResult {
  if (
    input.atr3m === null ||
    input.atr3m <= 0 ||
    input.atr3mAgeMs === null ||
    input.atr3mAgeMs > input.config.maxAtrAgeMsForEntry
  ) {
    return {
      entryReady: false,
      reasonCode: "ATR_NOT_READY",
      detail: `atr3m=${input.atr3m} atr3mAgeMs=${input.atr3mAgeMs} (max ${input.config.maxAtrAgeMsForEntry})`,
      clearingState: null,
    };
  }

  const clearingState = detectClearingState(
    input.oiHistory,
    input.episode.firstLiqTs,
    input.nowMs,
    input.config,
  );

  if (
    clearingState.mostRecentSampleAgeMs === null ||
    clearingState.mostRecentSampleAgeMs > input.config.maxOiSampleAgeMsForEntry
  ) {
    return {
      entryReady: false,
      reasonCode: "STALE_OI",
      detail: `mostRecentSampleAgeMs=${clearingState.mostRecentSampleAgeMs} (max ${input.config.maxOiSampleAgeMsForEntry}) -- stale OI must never be silently ignored`,
      clearingState,
    };
  }

  if (!isClearingEndDetected(clearingState, input.config)) {
    return {
      entryReady: false,
      reasonCode: "CLEARING_NOT_DETECTED",
      detail: `windowsShowingClearing=${clearingState.windowsShowingClearing} < minConsecutiveWindowsForClearingEnd=${input.config.minConsecutiveWindowsForClearingEnd}`,
      clearingState,
    };
  }

  const moveAtr = counterMoveAtr({
    currentPrice: input.currentPrice,
    extremePrice: input.episode.extremePrice,
    victim: input.episode.victim,
    atr3m: input.atr3m,
  });
  if (moveAtr < input.config.minCounterMoveAtrForEntry) {
    return {
      entryReady: false,
      reasonCode: "NO_COUNTER_MOVE_YET",
      detail: `counterMoveAtr=${moveAtr.toFixed(3)} < minCounterMoveAtrForEntry=${input.config.minCounterMoveAtrForEntry} -- OI clearing alone is not sufficient`,
      clearingState,
    };
  }

  const distanceFromExtremeAtr =
    Math.abs(input.currentPrice - input.episode.extremePrice) / input.atr3m;
  if (distanceFromExtremeAtr > input.config.maxDistanceFromExtremeAtrForEntry) {
    return {
      entryReady: false,
      reasonCode: "TOO_FAR_FROM_EXTREME",
      detail: `distanceFromExtremeAtr=${distanceFromExtremeAtr.toFixed(3)} > maxDistanceFromExtremeAtrForEntry=${input.config.maxDistanceFromExtremeAtrForEntry}`,
      clearingState,
    };
  }

  return {
    entryReady: true,
    candidateSide: candidateTradeSideForVictim(input.episode.victim),
    clearingState,
    counterMoveAtr: moveAtr,
    distanceFromExtremeAtr,
  };
}
