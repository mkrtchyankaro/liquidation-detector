import type { Side } from "../../shared/common.types";

/**
 * Sep 19 2026 (Karo), operator-requested Spot-vs-Futures order-flow
 * observation. Pure functions only -- no I/O, no state. These
 * produce OBSERVATIONAL labels only; nothing here is read by any
 * entry/exit/sizing/cancellation decision anywhere in the strategy.
 */

export type SpotConfirmationLabel = "SPOT_CONFIRM" | "SPOT_NEUTRAL" | "SPOT_CONTRADICT" | "SPOT_NA";
export type FuturesOiMoveLabel = "SHORT_COVERING_OR_DELEVERAGING" | "POSITION_TRANSFER_OR_MIXED" | "NEW_FUTURES_POSITIONING" | "LONG_LIQUIDATION_OR_DELEVERAGING";

export function cvdUsd(takerBuyUsd: number, takerSellUsd: number): number {
  return takerBuyUsd - takerSellUsd;
}

export function imbalancePct(takerBuyUsd: number, takerSellUsd: number): number {
  const total = takerBuyUsd + takerSellUsd;
  return total > 0 ? ((takerBuyUsd - takerSellUsd) / total) * 100 : 0;
}

/**
 * candidateSide is the direction of the reversal thesis (a SHORT
 * victim episode has a SHORT candidateSide -- see
 * candidateTradeSideForVictim()'s own doc comment elsewhere for why
 * this project uses that identity mapping). For a LONG-reversal
 * candidate (after LONG liquidations), SPOT_CONFIRM means Spot flow
 * is meaningfully BUY-led; for a SHORT-reversal candidate, mirrored
 * -- SPOT_CONFIRM means Spot flow is meaningfully SELL-led.
 *
 * neutralBandPct is the configurable half-width (e.g. 5 means
 * -5%..+5% spotImbalancePct is NEUTRAL). This label is observational
 * only -- never a trade filter (operator's own explicit instruction).
 */
export function classifySpotConfirmation(candidateSide: Side, spotImbalancePctValue: number, neutralBandPct: number, spotDataAvailable: boolean): SpotConfirmationLabel {
  if (!spotDataAvailable) return "SPOT_NA";
  if (Math.abs(spotImbalancePctValue) <= neutralBandPct) return "SPOT_NEUTRAL";
  const buyLed = spotImbalancePctValue > 0;
  if (candidateSide === "LONG") {
    return buyLed ? "SPOT_CONFIRM" : "SPOT_CONTRADICT";
  }
  return buyLed ? "SPOT_CONTRADICT" : "SPOT_CONFIRM";
}

/**
 * For an upward recovery (LONG-reversal candidate): price up + OI
 * down -> SHORT_COVERING_OR_DELEVERAGING; price up + OI flat ->
 * POSITION_TRANSFER_OR_MIXED; price up + OI up -> NEW_FUTURES_POSITIONING.
 * Mirrored for a downward recovery (SHORT-reversal candidate): price
 * down + OI down -> LONG_LIQUIDATION_OR_DELEVERAGING; price down + OI
 * flat -> POSITION_TRANSFER_OR_MIXED; price down + OI up ->
 * NEW_FUTURES_POSITIONING.
 *
 * The label for the "OI down" case is a DIFFERENT word per side
 * (SHORT_COVERING for a LONG candidate's own expected upward
 * recovery, LONG_LIQUIDATION for a SHORT candidate's own expected
 * downward recovery) -- driven by candidateSide directly, per the
 * operator's own two tables, not by re-deriving "which way is price
 * actually moving" independently (that direction is exactly what
 * candidateSide already encodes as the strategy's own expected
 * recovery direction).
 *
 * oiFlatBandPct is the configurable half-width (as a percentage of
 * oiStart) within which oiDeltaPct is treated as "approximately
 * flat". Observational only.
 */
export function classifyFuturesOiMove(candidateSide: Side, futuresPriceDeltaPct: number, oiDeltaPct: number | null, oiFlatBandPct: number): FuturesOiMoveLabel | null {
  if (oiDeltaPct === null) return null;
  void futuresPriceDeltaPct; // kept in the signature for callers/future display; not needed for the label itself -- see doc comment above
  const oiFlat = Math.abs(oiDeltaPct) <= oiFlatBandPct;
  const oiUp = oiDeltaPct > 0;
  if (oiFlat) return "POSITION_TRANSFER_OR_MIXED";
  if (oiUp) return "NEW_FUTURES_POSITIONING";
  // OI down
  return candidateSide === "LONG" ? "SHORT_COVERING_OR_DELEVERAGING" : "LONG_LIQUIDATION_OR_DELEVERAGING";
}

export type RecoveryOiMoveLabel = "SHORT_COVERING_OR_DELEVERAGING" | "POSITION_TRANSFER_OR_MIXED" | "NEW_FUTURES_POSITIONING" | "LONG_CLOSING_OR_DELEVERAGING";

/**
 * Sep 19 2026 (Karo), operator-requested Recovery Flow (final extreme
 * -> confirmed entry window) -- a DIFFERENT label set from
 * classifyFuturesOiMove()'s own Episode Flow labels above
 * (LONG_CLOSING_OR_DELEVERAGING here vs LONG_LIQUIDATION_OR_DELEVERAGING
 * there -- the operator's own explicit wording for this narrower,
 * confirmation-window feature). Otherwise identical logic/thresholds.
 */
export function classifyRecoveryOiMove(candidateSide: Side, oiDeltaPct: number | null, oiFlatBandPct: number): RecoveryOiMoveLabel | null {
  if (oiDeltaPct === null) return null;
  const oiFlat = Math.abs(oiDeltaPct) <= oiFlatBandPct;
  const oiUp = oiDeltaPct > 0;
  if (oiFlat) return "POSITION_TRANSFER_OR_MIXED";
  if (oiUp) return "NEW_FUTURES_POSITIONING";
  return candidateSide === "LONG" ? "SHORT_COVERING_OR_DELEVERAGING" : "LONG_CLOSING_OR_DELEVERAGING";
}
