/**
 * Sep 16 2026 (Karo), operator-approved architecture. First-version,
 * deliberately transparent capacity model -- NOT statistically
 * optimized. Every coefficient lives in CapacityModelCoefficients,
 * and every call returns each component's own contribution alongside
 * the total, so a real entry's logged output can show exactly why
 * 1.4 ATR was predicted instead of 2.2 ATR.
 */

export interface CapacityModelCoefficients {
  /** Base capacity (ATR) before any component adjustment. UNTUNED
   *  default 1.0. */
  baseAtr: number;
  /** Weight applied to (percentileRank/100). UNTUNED default 0.5. */
  percentileWeight: number;
  /** Weight applied to oiDestructionFraction (0-1) at WATCH
   *  qualification. UNTUNED default 0.5. */
  oiDestructionWeight: number;
  /** Weight applied to the episode's own displacement, already in
   *  ATR units. UNTUNED default 0.3. */
  displacementWeight: number;
  /** Weight applied to liquidationToOiRatio when available (capped at
   *  liquidationToOiRatioCap before weighting -- this ratio is
   *  unbounded and a single huge value must not dominate the model).
   *  UNTUNED default 0.2. */
  liquidationToOiRatioWeight: number;
  /** Cap applied to liquidationToOiRatio before weighting. UNTUNED
   *  default 2.0. */
  liquidationToOiRatioCap: number;
  /** Hard ceiling on the final predicted capacity -- a safety bound,
   *  not a market-model choice. Default 3.0 ATR. */
  maxCapacityAtr: number;
  /** Hard floor once WATCH has qualified at all. Default 0.3 ATR. */
  minCapacityAtr: number;
}

export const DEFAULT_CAPACITY_MODEL_COEFFICIENTS: CapacityModelCoefficients = {
  baseAtr: 1.0,
  percentileWeight: 0.5,
  oiDestructionWeight: 0.5,
  displacementWeight: 0.3,
  liquidationToOiRatioWeight: 0.2,
  liquidationToOiRatioCap: 2.0,
  maxCapacityAtr: 3.0,
  minCapacityAtr: 0.3,
};

export interface CapacityModelInput {
  episodePercentileRank: number;
  oiDestructionFraction: number | null;
  displacementAtr: number;
  liquidationToOiRatio: number | null;
}

export interface CapacityComponentContribution {
  name: string;
  rawValue: number | null;
  weight: number;
  contributionAtr: number;
}

export interface CapacityModelResult {
  initialCapacityAtr: number;
  rawSumAtr: number;
  clampedToMax: boolean;
  clampedToMin: boolean;
  components: readonly CapacityComponentContribution[];
}

/** Pure, deterministic. */
export function computeInitialCapacity(
  input: CapacityModelInput,
  coeffs: CapacityModelCoefficients,
): CapacityModelResult {
  const components: CapacityComponentContribution[] = [];

  components.push({
    name: "base",
    rawValue: null,
    weight: coeffs.baseAtr,
    contributionAtr: coeffs.baseAtr,
  });

  const percentileContribution =
    (input.episodePercentileRank / 100) * coeffs.percentileWeight;
  components.push({
    name: "percentileRank",
    rawValue: input.episodePercentileRank,
    weight: coeffs.percentileWeight,
    contributionAtr: percentileContribution,
  });

  if (input.oiDestructionFraction !== null) {
    const c = input.oiDestructionFraction * coeffs.oiDestructionWeight;
    components.push({
      name: "oiDestructionFraction",
      rawValue: input.oiDestructionFraction,
      weight: coeffs.oiDestructionWeight,
      contributionAtr: c,
    });
  } else {
    components.push({
      name: "oiDestructionFraction",
      rawValue: null,
      weight: coeffs.oiDestructionWeight,
      contributionAtr: 0,
    });
  }

  const displacementContribution =
    input.displacementAtr * coeffs.displacementWeight;
  components.push({
    name: "displacementAtr",
    rawValue: input.displacementAtr,
    weight: coeffs.displacementWeight,
    contributionAtr: displacementContribution,
  });

  if (input.liquidationToOiRatio !== null) {
    const capped = Math.min(
      input.liquidationToOiRatio,
      coeffs.liquidationToOiRatioCap,
    );
    const c = capped * coeffs.liquidationToOiRatioWeight;
    components.push({
      name: "liquidationToOiRatio",
      rawValue: input.liquidationToOiRatio,
      weight: coeffs.liquidationToOiRatioWeight,
      contributionAtr: c,
    });
  } else {
    components.push({
      name: "liquidationToOiRatio",
      rawValue: null,
      weight: coeffs.liquidationToOiRatioWeight,
      contributionAtr: 0,
    });
  }

  const rawSumAtr = components.reduce((s, c) => s + c.contributionAtr, 0);
  let initialCapacityAtr = rawSumAtr;
  let clampedToMax = false,
    clampedToMin = false;
  if (initialCapacityAtr > coeffs.maxCapacityAtr) {
    initialCapacityAtr = coeffs.maxCapacityAtr;
    clampedToMax = true;
  }
  if (initialCapacityAtr < coeffs.minCapacityAtr) {
    initialCapacityAtr = coeffs.minCapacityAtr;
    clampedToMin = true;
  }

  return {
    initialCapacityAtr,
    rawSumAtr,
    clampedToMax,
    clampedToMin,
    components,
  };
}

/** TP is placed in the FAVORABLE direction for the candidate side
 *  (LONG -> above entry, SHORT -> below entry). */
export function initialTpPrice(
  entry: number,
  atr3m: number,
  candidateSide: "LONG" | "SHORT",
  capacityAtr: number,
): number {
  const offset = atr3m * capacityAtr;
  return candidateSide === "LONG" ? entry + offset : entry - offset;
}
