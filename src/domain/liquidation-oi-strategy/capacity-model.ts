import type { OiPhysicsNotional } from "./oi-physics";
import type { Side } from "../../shared/common.types";

/**
 * Sep 17 2026 (Karo), operator-approved final capacity architecture --
 * REVISED AGAIN this pass per two operator-identified issues:
 *
 * (1) DOUBLE-COUNTING BUG (Section 4 of the operator's own audit
 *     request): the previous revision fed `distanceFromExtremeAtr`
 *     (extreme -> candidate entry) into predictedTotalCapacityAtr's
 *     price-evidence term, weight 1.0, and THEN subtracted the SAME
 *     quantity as alreadyConsumedCapacityAtr. Net effect: the price
 *     term almost entirely cancelled against consumed, leaving
 *     capacity effectively independent of real evidence. FIXED: the
 *     price-evidence term now measures favorable movement SINCE
 *     EPISODE END ONLY (favorablePriceMoveAtrSinceEnd) -- a DIFFERENT
 *     reference point than alreadyConsumedCapacityAtr (measured from
 *     the EXTREME), so the two no longer describe the same distance.
 *     Observed movement since end is evidence about market response;
 *     consumed displacement is distance already travelled from the
 *     extreme -- kept mathematically distinct, per the operator's own
 *     explicit requirement.
 *
 * (2) HARD OI CAP (Section 2): `min(oiToLiqRatio, 2.0)` treated 2x,
 *     4x, and 8x identically and threw away quantitative distinction
 *     above the cap. Replaced with `log1p(oiToLiqRatio)` -- a
 *     monotonic, saturating, diminishing-return transform: 0 OI
 *     creation -> log1p(0)=0 (no positive evidence), every additional
 *     unit of OI creation still moves the signal (no discontinuity),
 *     but with strictly diminishing marginal effect (4x is NOT double
 *     the evidence of 2x, 10x does NOT imply 10 ATR). This is an
 *     ARCHITECTURAL CHOICE, explicitly NOT claimed as empirically
 *     validated -- log1p is used as a standard, well-behaved
 *     diminishing-return shape satisfying every structural requirement
 *     the operator listed, not because any repository data supports
 *     this specific transform over another.
 *
 * EFFICIENCY GATING (operator's own requirement: "more OI with poor
 * favorable price response must not automatically extend TP"): the OI
 * quantity term is not simply additive -- it is SCALED by an
 * efficiencyFactor derived from the SAME post-end price evidence, so
 * OI creation with weak accompanying price response contributes little
 * capacity regardless of its raw size.
 *
 * NO VALIDATED MARKET-PHYSICS FORMULA EXISTS (confirmed again,
 * unchanged from the prior pass): no live Mongo/.env access in this
 * container, so the repository's own research scripts could not be
 * executed against real historical episodes, and no precomputed
 * output/fixture files with real results were found. Every
 * coefficient below remains explicitly EXPERIMENTAL/UNTUNED.
 */

export interface CapacityModelCoefficients2 {
  baseAtr: number;
  /** Weight on the diminishing-return OI-quantity signal
   *  (log1p(oiToLiqRatio)), itself further scaled by efficiencyFactor
   *  below -- NOT a bare additive term. UNTUNED. */
  oiQuantityWeight: number;
  /** Weight on the SMALL, post-end-only observed favorable price move
   *  (favorablePriceMoveAtrSinceEnd) -- deliberately a separate,
   *  bounded signal, never the same distance used for
   *  alreadyConsumedCapacityAtr. UNTUNED. */
  priceEfficiencyWeight: number;
  /** The post-end favorable move (ATR) at or above which OI evidence
   *  is treated as "fully efficient" (efficiencyFactor saturates at
   *  1.0). Below this, efficiencyFactor scales down linearly toward 0
   *  -- the mechanism that prevents large OI creation with weak price
   *  response from automatically extending capacity. UNTUNED. */
  minExpectedEfficiencyAtr: number;
  maxCapacityAtr: number;
  minCapacityAtr: number;
}

export const DEFAULT_CAPACITY_MODEL_COEFFICIENTS_2: CapacityModelCoefficients2 = {
  baseAtr: 1.0,
  oiQuantityWeight: 1.0,
  priceEfficiencyWeight: 1.0,
  minExpectedEfficiencyAtr: 0.3,
  maxCapacityAtr: 3.0,
  minCapacityAtr: 0.3,
};

export interface CapacityModelInput2 {
  episodeLiqUsd: number;
  oiPhysics: OiPhysicsNotional;
  /** Favorable price displacement observed SINCE EPISODE END ONLY
   *  (never since the extreme -- that would reintroduce the
   *  double-count with alreadyConsumedCapacityAtr, which IS measured
   *  from the extreme). This is the market-RESPONSE evidence, kept
   *  mathematically distinct from distance already travelled. */
  favorablePriceMoveAtrSinceEnd: number;
}

export interface CapacityComponentContribution2 { name: string; rawValue: number | null; weight: number; contributionAtr: number }

export interface CapacityModelResult2 {
  predictedTotalCapacityAtr: number;
  rawSumAtr: number;
  clampedToMax: boolean;
  clampedToMin: boolean;
  components: readonly CapacityComponentContribution2[];
  oiToLiqRatio: number | null;
  oiQuantitySignal: number | null;
  efficiencyFactor: number;
}

/** Pure, deterministic. Produces predictedTotalCapacityAtr, measured
 *  from the episode's own EXTREME -- NOT a TP distance from entry.
 *  Callers MUST run this through computeRemainingCapacity() before
 *  using it as a TP distance from any candidate entry price. */
export function computeCapacity(input: CapacityModelInput2, coeffs: CapacityModelCoefficients2): CapacityModelResult2 {
  const components: CapacityComponentContribution2[] = [];
  components.push({ name: "base", rawValue: null, weight: coeffs.baseAtr, contributionAtr: coeffs.baseAtr });

  const postEndUsd = input.oiPhysics.postEndOiCreationUsd;
  const oiToLiqRatio = postEndUsd !== null && postEndUsd > 0 && input.episodeLiqUsd > 0 ? postEndUsd / input.episodeLiqUsd : null;
  const oiQuantitySignal = oiToLiqRatio !== null ? Math.log1p(oiToLiqRatio) : null;

  // efficiencyFactor: 0 at zero/negative post-end price response,
  // scales linearly to 1.0 at minExpectedEfficiencyAtr and beyond --
  // gates the OI-quantity term so poor price response cannot let raw
  // OI size alone extend capacity.
  const efficiencyFactor = coeffs.minExpectedEfficiencyAtr > 0
    ? Math.max(0, Math.min(1, input.favorablePriceMoveAtrSinceEnd / coeffs.minExpectedEfficiencyAtr))
    : (input.favorablePriceMoveAtrSinceEnd > 0 ? 1 : 0);

  if (oiQuantitySignal !== null) {
    const c = oiQuantitySignal * efficiencyFactor * coeffs.oiQuantityWeight;
    components.push({ name: "oiQuantitySignal(log1p, efficiency-gated)", rawValue: oiQuantitySignal, weight: coeffs.oiQuantityWeight, contributionAtr: c });
  } else {
    components.push({ name: "oiQuantitySignal(log1p, efficiency-gated)", rawValue: null, weight: coeffs.oiQuantityWeight, contributionAtr: 0 });
  }

  const priceContribution = input.favorablePriceMoveAtrSinceEnd * coeffs.priceEfficiencyWeight;
  components.push({ name: "favorablePriceMoveAtrSinceEnd", rawValue: input.favorablePriceMoveAtrSinceEnd, weight: coeffs.priceEfficiencyWeight, contributionAtr: priceContribution });

  const rawSumAtr = components.reduce((s, c) => s + c.contributionAtr, 0);
  let predictedTotalCapacityAtr = rawSumAtr;
  let clampedToMax = false, clampedToMin = false;
  if (predictedTotalCapacityAtr > coeffs.maxCapacityAtr) { predictedTotalCapacityAtr = coeffs.maxCapacityAtr; clampedToMax = true; }
  if (predictedTotalCapacityAtr < coeffs.minCapacityAtr) { predictedTotalCapacityAtr = coeffs.minCapacityAtr; clampedToMin = true; }

  return { predictedTotalCapacityAtr, rawSumAtr, clampedToMax, clampedToMin, components, oiToLiqRatio, oiQuantitySignal, efficiencyFactor };
}

export interface RemainingCapacityResult {
  alreadyConsumedCapacityAtr: number;
  predictedRemainingCapacityAtr: number;
}

/** Computes capacity already consumed (extreme -> candidate entry, in
 *  the SAME frozen ATR units the total was measured in) and the
 *  remainder, floored at 0. This is the ONLY function that may turn
 *  predictedTotalCapacityAtr into an entry-relative distance -- never
 *  subtract entry-price terms inside computeCapacity() itself. */
export function computeRemainingCapacity(predictedTotalCapacityAtr: number, candidateSide: Side, candidateEntryPrice: number, episodeExtremePrice: number, atrReference: number): RemainingCapacityResult {
  const alreadyConsumedCapacityAtr = candidateSide === "LONG"
    ? (candidateEntryPrice - episodeExtremePrice) / atrReference
    : (episodeExtremePrice - candidateEntryPrice) / atrReference;
  const predictedRemainingCapacityAtr = Math.max(0, predictedTotalCapacityAtr - alreadyConsumedCapacityAtr);
  return { alreadyConsumedCapacityAtr, predictedRemainingCapacityAtr };
}

/** Sections 19-20 -- TP is ALWAYS projected from the ORIGINAL, FROZEN
 *  entry coordinate using the REMAINING capacity (never the total),
 *  never currentPrice, never a live-changing ATR. */
export function projectTpFromEntry(entryPrice: number, atr3mAtEntry: number, candidateSide: Side, remainingCapacityAtr: number): number {
  const offset = atr3mAtEntry * remainingCapacityAtr;
  return candidateSide === "LONG" ? entryPrice + offset : entryPrice - offset;
}

/** Sep 17 2026 (Karo), operator-requested Section 27 -- the SAME
 *  structural-SL formula liquidation-oi-runtime-orchestrator.ts's own
 *  handleEntryReady() uses, centralized here. UNTUNED buffer,
 *  unchanged value (0.1 ATR) -- Section 14 explicitly forbids
 *  widening/narrowing this to make RR pass. */
export const STRUCTURAL_INVALIDATION_BUFFER_ATR = 0.1;
export function computeStructuralInvalidationPrice(extremePrice: number, atr3m: number, candidateSide: Side): number {
  return candidateSide === "LONG"
    ? extremePrice - atr3m * STRUCTURAL_INVALIDATION_BUFFER_ATR
    : extremePrice + atr3m * STRUCTURAL_INVALIDATION_BUFFER_ATR;
}
