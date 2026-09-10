/**
 * Sep 10 2026 (Karo), operator-requested LIVE research-only 3-way
 * ATR-unit competition ("dragon" TP/SL validation). Pure, standalone
 * function -- NO connection to production's own
 * deriveLiquidationPhysicsTradePlan() at all (deliberately: no
 * exhaustion, no absorption, no ATR15m, no 0.20% sizing floor, no RR
 * ladder rounding -- this is a genuinely different, simpler
 * hypothesis being tested).
 *
 * Formula, exactly per the operator's own spec:
 *   relativePressure = episodeLiqUsd / liqBaseline   (NOT dimensionless
 *     -- see this project's own README/report on this: liqBaseline is
 *     a USD-per-minute RATE, so this ratio actually carries units of
 *     "minutes" -- the operator has explicitly acknowledged this and
 *     asked to proceed with the raw formula anyway, persisting raw
 *     values for later independent study)
 *   pressureFactor = sqrt(relativePressure)
 *   rawTPPct = candidateAtrPct * pressureFactor
 *   For RR in [2.5, 2.4, 2.3, 2.2, 2.1] (descending):
 *     candidateSL = rawTPPct / RR
 *     first RR whose SL lands in [0.20%, 0.50%] wins -- ALL attempts
 *     recorded regardless, never just the winner.
 *   No RR valid -> FAIL_NO_VALID_RR.
 */

export const DRAGON_RR_CANDIDATES: readonly number[] = [
  2.5, 2.4, 2.3, 2.2, 2.1,
];
export const DRAGON_SL_MIN_PCT = 0.002; // 0.20%
export const DRAGON_SL_MAX_PCT = 0.005; // 0.50%

export interface DragonRRAttempt {
  readonly rr: number;
  readonly slPct: number;
  readonly valid: boolean;
}

export interface DragonResult {
  readonly relativePressure: number;
  readonly pressureFactor: number;
  readonly rawTpPct: number;
  readonly rrAttempts: readonly DragonRRAttempt[];
  readonly selectedRR: number | null;
  readonly rawSlPct: number | null;
  readonly verdict: "PASS" | "FAIL_NO_VALID_RR";
}

export function evaluateDragon(
  candidateAtrPct: number,
  episodeLiqUsd: number,
  liqBaseline: number,
): DragonResult {
  if (!(candidateAtrPct > 0) || !(episodeLiqUsd > 0) || !(liqBaseline > 0)) {
    return {
      relativePressure: 0,
      pressureFactor: 0,
      rawTpPct: 0,
      rrAttempts: [],
      selectedRR: null,
      rawSlPct: null,
      verdict: "FAIL_NO_VALID_RR",
    };
  }

  const relativePressure = episodeLiqUsd / liqBaseline;
  const pressureFactor = Math.sqrt(relativePressure);
  const rawTpPct = candidateAtrPct * pressureFactor;

  const rrAttempts: DragonRRAttempt[] = [];
  let selectedRR: number | null = null;
  let rawSlPct: number | null = null;

  for (const rr of DRAGON_RR_CANDIDATES) {
    const slPct = rawTpPct / rr;
    const valid = slPct >= DRAGON_SL_MIN_PCT && slPct <= DRAGON_SL_MAX_PCT;
    rrAttempts.push({ rr, slPct, valid });
    if (valid && selectedRR === null) {
      selectedRR = rr;
      rawSlPct = slPct;
    }
  }

  return {
    relativePressure,
    pressureFactor,
    rawTpPct,
    rrAttempts,
    selectedRR,
    rawSlPct,
    verdict: selectedRR !== null ? "PASS" : "FAIL_NO_VALID_RR",
  };
}
