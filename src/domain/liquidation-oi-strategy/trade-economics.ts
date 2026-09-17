import type { Side } from "../../shared/common.types";

/**
 * Sep 17 2026 (Karo), operator-approved final capacity architecture,
 * Sections 16-18.
 *
 * FEE RATE: reused verbatim from binance-execution.service.ts's own
 * takerFeeRateEstimate default (0.0005 = 5bps) and its
 * estimatedRoundTripFeeUsd formula (quantity * price * rate * 2) --
 * the ONLY fee-estimation methodology found anywhere in this
 * repository. Symmetric (same rate for entry and exit, both assumed
 * taker) -- no repository evidence of an asymmetric split.
 *
 * RR MINIMUM: reused verbatim from trade-plan.ts's own RR_MIN = 2.0.
 */

export const LOX_TAKER_FEE_RATE_ESTIMATE = 0.0005;
export const LOX_MIN_NET_RR = 2.0; // NOTE: retained as a calculated/reported figure ONLY -- see LOX_ENTRY_ECONOMIC_POLICY below for what actually gates LOX entry. Still the canonical minimum for OTHER strategies that use RR_MIN elsewhere; unchanged, unaffected by this file.

/** Sep 17 2026 (Karo), operator-approved correction -- RR>=2.0 is NOT
 *  a mandatory LOX entry condition. RR is an OUTPUT of market
 *  physics -> capacity -> TP -> structural SL -> fees, not a target
 *  solved backward from. The only thing LOX's entry gate protects
 *  against is a trade that is economically ABSURD after fees --
 *  never a specific RR ratio.
 *
 *  No canonical fee/economic-viability rule was found anywhere else
 *  in the repository (confirmed by search) -- this policy is
 *  therefore new and explicitly UNTUNED. Design: net TP profit must
 *  be positive AND must clear expected fees by a meaningful multiple
 *  (guards against exactly the operator's own example -- $30 gross
 *  profit against $29 of fees is technically "positive" but
 *  economically useless). LOX_MIN_NET_RR above is calculated and
 *  logged/persisted for every candidate, but is NEVER used to gate
 *  LOX entry -- only LOX_MIN_FEE_COVERAGE_MULTIPLE below does. */
export const LOX_MIN_FEE_COVERAGE_MULTIPLE = 3.0; // UNTUNED -- net TP profit must be >= 3x the round-trip fee cost

export function estimateRoundTripFeeUsd(quantity: number, entryPrice: number, exitPrice: number): number {
  const entryFee = quantity * entryPrice * LOX_TAKER_FEE_RATE_ESTIMATE;
  const exitFee = quantity * exitPrice * LOX_TAKER_FEE_RATE_ESTIMATE;
  return entryFee + exitFee;
}

export interface TradeEconomicsInput {
  candidateSide: Side;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  quantity: number;
}

export interface TradeEconomicsResult {
  grossTpProfitUsd: number;
  grossSlLossUsd: number;
  expectedTpFeesUsd: number;
  expectedSlFeesUsd: number;
  netTpProfitUsd: number;
  netSlLossUsd: number;
  netRR: number | null;
  passesMinNetRR: boolean;
  /** Sep 17 2026 (Karo) -- the ACTUAL LOX entry-economics gate: net TP
   *  profit is positive and clears fees by LOX_MIN_FEE_COVERAGE_MULTIPLE.
   *  netRR/passesMinNetRR above remain calculated and reported but are
   *  NOT used to gate LOX entry. */
  passesEconomicViability: boolean;
}

export function evaluateTradeEconomics(input: TradeEconomicsInput): TradeEconomicsResult {
  const grossTpProfitUsd = (input.candidateSide === "LONG" ? input.tpPrice - input.entryPrice : input.entryPrice - input.tpPrice) * input.quantity;
  const grossSlPriceLossUsd = (input.candidateSide === "LONG" ? input.entryPrice - input.slPrice : input.slPrice - input.entryPrice) * input.quantity;

  const expectedTpFeesUsd = estimateRoundTripFeeUsd(input.quantity, input.entryPrice, input.tpPrice);
  const expectedSlFeesUsd = estimateRoundTripFeeUsd(input.quantity, input.entryPrice, input.slPrice);

  const netTpProfitUsd = grossTpProfitUsd - expectedTpFeesUsd;
  const netSlLossUsd = grossSlPriceLossUsd + expectedSlFeesUsd;

  const netRR = netSlLossUsd > 0 ? netTpProfitUsd / netSlLossUsd : null;
  const passesMinNetRR = netRR !== null && netRR >= LOX_MIN_NET_RR;
  const passesEconomicViability = netTpProfitUsd > 0 && netTpProfitUsd >= LOX_MIN_FEE_COVERAGE_MULTIPLE * expectedTpFeesUsd;

  return { grossTpProfitUsd, grossSlLossUsd: grossSlPriceLossUsd, expectedTpFeesUsd, expectedSlFeesUsd, netTpProfitUsd, netSlLossUsd, netRR, passesMinNetRR, passesEconomicViability };
}
