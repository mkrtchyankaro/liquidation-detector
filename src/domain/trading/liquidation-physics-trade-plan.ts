import type { Side } from "../../shared/common.types";

/**
 * Sep 9 2026 (Karo), operator-designed DYNAMIC liquidation-physics
 * trade plan -- SECOND REVISION. The liquidation-physics SCORE itself
 * (components A/B/C below) is UNCHANGED from the first revision. What
 * changed, per the operator's own explicit instruction, is the
 * DISTANCE RULER the score drives:
 *
 *   REMOVED: K x UNIT as the TP/SL distance engine (the first
 *   revision's own dynamicK/softExitPrice geometry). UNIT (frozen
 *   ATR1m) is now used EXCLUSIVELY for W1/W2 entry geometry
 *   (v5-wave.service.ts's own onTick/onLiquidation completion logic --
 *   completely untouched, unchanged, outside this module entirely).
 *   This module no longer takes a UNIT input at all.
 *
 *   ADDED: ATR15m as the bounded exit-distance ruler. Real, observed
 *   UNIT_pct values across every tracked symbol (confirmed via live
 *   Binance kline data, Sep 9 2026) sit in the 0.04%-0.13% range --
 *   too small, given the K-range the first revision used, for the
 *   structural distance to EVER clear the 0.20% sizing floor in
 *   practice (confirmed: 10/10 symbols x 3 confidence levels all
 *   floored, in a real numeric sweep). ATR15m is a materially larger,
 *   more appropriately-scaled ruler for a multi-minute reaction target
 *   -- it is also the SAME ruler the original (now-removed) Hybrid-C
 *   formula used for its own TP, so this is a return to a proven
 *   magnitude, not a new invention.
 *
 * Derivation order also inverts, per the operator's own explicit
 * instruction ("derive TP dynamically from physics, then SL from the
 * selected RR"):
 *   1. rawTpPct = atr15mPct x tpMultiplier(dynamicPhysicsScore) --
 *      bounded, sub-linear-in-spirit (the score itself is already the
 *      product of two sub-linear components), TP_MULT_MIN..TP_MULT_MAX.
 *   2. selectedRR = same monotonic RR-ladder mapping as before.
 *   3. impliedSlPct = rawTpPct / selectedRR.
 *   4. If impliedSlPct >= the 0.20% execution-mechanics floor, SL/TP
 *      stand as computed (SL genuinely physics-derived).
 *      If impliedSlPct < the floor, SL is pinned at the floor and TP
 *      is RECOMPUTED as floor x selectedRR -- preserving the
 *      "TP = SL x selectedRR" invariant exactly, always, in both
 *      branches, per the operator's own explicit "solved together"
 *      requirement from the first revision (unchanged principle).
 *
 * Components A/B/C (unchanged from the first revision):
 *
 *   A. liquidityStrength -- how exceptional is W1's own liquidation
 *      pressure, relative to TWO different historical baselines
 *      (individual-event P95, and today's own aggregate 24h rate).
 *      Sub-linear (sqrt) in both, per market-impact convention
 *      (square-root price-impact law). Uses W1Liq specifically
 *      (V5Wave #1's own liqNotionalUsd), NEVER totalEpisodePressure.
 *
 *   B. exhaustion -- W2's own liquidation relative to W1's. A W2
 *      materially WEAKER than W1 is the reversal thesis. V3's own
 *      original formula shape (exhaustion = 1 - clamp(W2/W1, 0, 1)).
 *
 *   C. absorption -- large forced liquidation producing relatively
 *      SMALL price displacement = the market absorbed the flow =
 *      stronger reversal evidence (Kyle's-lambda / Amihud-style
 *      price-impact intuition). HONEST LIMITATION, unchanged from the
 *      first revision: no separately-calibrated historical "expected
 *      price-move per dollar liquidated" statistic exists in this
 *      project -- this is the strongest proxy buildable from data that
 *      already exists. Displacement is now normalized in ATR15m terms
 *      (not UNIT terms -- UNIT is reserved exclusively for entry
 *      geometry per this revision's own instruction), tightly bounded
 *      [0.5, 2.0] so it can only modestly damp/boost the score.
 *
 * A HUGE liquidation alone cannot explode TP: liquidityStrength is
 * capped at STRENGTH_MAX, absorption is capped at ABSORPTION_MAX, the
 * tpMultiplier itself is capped at TP_MULT_MAX, and the RR ladder is
 * hard-capped at 2.5 -- four independent ceilings, not one.
 */

// ─── Constants (every one documented, every one reused where a
//     defensible existing meaning exists) ──────────────────────────────

export const STRENGTH_MAX = 4.0;

/** Floor on W1's own displacement-in-ATR15m-terms before it becomes
 *  the denominator of the absorption ratio -- avoids a division
 *  blowup for a genuinely near-zero-displacement W1. */
export const MIN_DISPLACEMENT_ATR = 0.1;

export const ABSORPTION_MIN = 0.5;
export const ABSORPTION_MAX = 2.0;

/** Bounded ATR15m multiplier for TP. TP_MULT_MAX=1.0 reuses the
 *  EXACT value the original (now-removed) Hybrid-C formula's own
 *  ALPHA_TP used at its own intensity=1 reference point (trade-plan.ts)
 *  -- the same, already-calibrated magnitude, not a new guess.
 *  TP_MULT_MIN=0.3 is a conservative floor for the weakest
 *  (score-near-0) setups, keeping even a barely-qualifying cascade's
 *  own TP a real, meaningful fraction of ATR15m rather than
 *  vanishingly small. */
export const TP_MULT_MIN = 0.3;
export const TP_MULT_MAX = 1.0;

export const RR_LADDER: readonly number[] = [2.0, 2.1, 2.2, 2.3, 2.4, 2.5];

/** Execution-mechanics-only floor (position sizing / exchange
 *  hard-stop distance) -- unchanged value from every prior revision. */
export const SIZING_HARD_STOP_FLOOR_PCT = 0.002; // 0.20%

export interface LiquidationPhysicsInput {
  readonly entry: number;
  readonly side: Side;
  /** Wave 1's OWN anchor/extreme/liqNotionalUsd -- never the
   *  cumulative episode total, never Wave 2's own values. */
  readonly w1AnchorPrice: number;
  readonly w1ExtremePrice: number;
  readonly w1LiqUsd: number;
  /** Wave 2's own liqNotionalUsd -- used only for exhaustionScore. */
  readonly w2LiqUsd: number;
  /** ATR15m, ABSOLUTE price units (watch.atrAtStart) -- the bounded
   *  exit-distance ruler. UNIT (ATR1m) is deliberately NOT an input
   *  to this module at all -- it remains exclusively an entry-geometry
   *  concept, owned entirely by v5-wave.service.ts's own onTick. */
  readonly atr15mAbs: number;
  /** Individual-event P95 threshold AT ENTRY TIME. An INDIVIDUAL-EVENT
   *  statistic -- never conflated with the episode-cumulative sums
   *  above. */
  readonly p95: number;
  /** Today's own aggregate liquidation rate, USD PER MINUTE. */
  readonly dailyLiqPerMinBaseline: number;
}

export interface LiquidationPhysicsDiagnostics {
  readonly liquidityStrengthP95: number;
  readonly liquidityStrength24h: number;
  readonly liquidityStrength: number;
  readonly w2ToW1Ratio: number;
  readonly exhaustionScore: number;
  readonly w1DisplacementAtr: number;
  readonly absorptionRaw: number;
  readonly absorptionScore: number;
  readonly dynamicPhysicsScore: number;
  readonly selectedRR: number;
  readonly tpMultiplier: number;
  readonly atr15mPct: number;
  /** Which value actually determined the final SL -- "physics" (the
   *  ATR15m x tpMultiplier / RR derivation) or "sizing-floor" (the
   *  0.20% execution-mechanics minimum kicked in, and TP was
   *  recomputed to preserve TP=SL x selectedRR). Pure diagnostics,
   *  never read by any decision logic. */
  readonly slDeterminedBy: "physics" | "sizing-floor";
}

export type LiquidationPhysicsResult =
  | (LiquidationPhysicsDiagnostics & {
      readonly ok: true;
      readonly entry: number;
      readonly sl: number;
      readonly tp: number;
      readonly slPct: number;
      readonly tpPct: number;
      readonly rr: number;
    })
  | (LiquidationPhysicsDiagnostics & {
      readonly ok: false;
      readonly cancelReason: "invalid-input";
    });

/** Rounds a raw [0,1] score onto the nearest RR_LADDER rung -- pure
 *  monotonic mapping, no arbitrary thresholds. */
function scoreToRR(score: number): number {
  const clamped = Math.max(0, Math.min(1, score));
  const idx = Math.round(clamped * (RR_LADDER.length - 1));
  return RR_LADDER[idx]!;
}

export function deriveLiquidationPhysicsTradePlan(
  p: LiquidationPhysicsInput,
): LiquidationPhysicsResult {
  const zeroDiag: LiquidationPhysicsDiagnostics = {
    liquidityStrengthP95: 0,
    liquidityStrength24h: 0,
    liquidityStrength: 0,
    w2ToW1Ratio: 0,
    exhaustionScore: 0,
    w1DisplacementAtr: 0,
    absorptionRaw: 0,
    absorptionScore: 0,
    dynamicPhysicsScore: 0,
    selectedRR: RR_LADDER[0]!,
    tpMultiplier: TP_MULT_MIN,
    atr15mPct: 0,
    slDeterminedBy: "sizing-floor",
  };

  if (
    !(p.entry > 0) ||
    !(p.atr15mAbs > 0) ||
    !(p.p95 > 0) ||
    !(p.w1LiqUsd > 0)
  ) {
    return { ...zeroDiag, ok: false, cancelReason: "invalid-input" };
  }

  const atr15mPct = p.atr15mAbs / p.entry;

  // ─── A. Liquidation strength (unchanged from the first revision). ──
  const liquidityStrengthP95 = Math.sqrt(p.w1LiqUsd / p.p95);
  const liquidityStrength24h =
    p.dailyLiqPerMinBaseline > 0
      ? Math.sqrt(p.w1LiqUsd / p.dailyLiqPerMinBaseline)
      : liquidityStrengthP95;
  const liquidityStrength = Math.max(
    0,
    Math.min((liquidityStrengthP95 + liquidityStrength24h) / 2, STRENGTH_MAX),
  );

  // ─── B. W2/W1 exhaustion (unchanged from the first revision). ──────
  const w2ToW1Ratio = p.w1LiqUsd > 0 ? p.w2LiqUsd / p.w1LiqUsd : 1;
  const exhaustionScore = 1 - Math.max(0, Math.min(w2ToW1Ratio, 1));

  // ─── C. Absorption -- SAME proxy shape as the first revision, but
  //     displacement is now normalized in ATR15m terms, never UNIT. ──
  const w1DisplacementAbs = Math.abs(p.w1AnchorPrice - p.w1ExtremePrice);
  const w1DisplacementAtr = Math.max(
    w1DisplacementAbs / p.atr15mAbs,
    MIN_DISPLACEMENT_ATR,
  );
  const w1LiquidityP95Units = p.w1LiqUsd / p.p95;
  const absorptionRaw = w1LiquidityP95Units / w1DisplacementAtr;
  const absorptionScore = Math.max(
    ABSORPTION_MIN,
    Math.min(Math.sqrt(absorptionRaw), ABSORPTION_MAX),
  );

  // ─── Combine -- MULTIPLICATIVE, unchanged shape from the first
  //     revision. ─────────────────────────────────────────────────────
  const rawScore =
    (liquidityStrength / STRENGTH_MAX) *
    exhaustionScore *
    (absorptionScore / ABSORPTION_MAX);
  const dynamicPhysicsScore = Math.max(0, Math.min(rawScore, 1));

  const selectedRR = scoreToRR(dynamicPhysicsScore);

  // ─── TP derived FROM physics, ATR15m-scaled, bounded. ───────────────
  const tpMultiplier =
    TP_MULT_MIN + dynamicPhysicsScore * (TP_MULT_MAX - TP_MULT_MIN);
  const rawTpPct = atr15mPct * tpMultiplier;
  const impliedSlPct = rawTpPct / selectedRR;

  const diag: LiquidationPhysicsDiagnostics = {
    liquidityStrengthP95,
    liquidityStrength24h,
    liquidityStrength,
    w2ToW1Ratio,
    exhaustionScore,
    w1DisplacementAtr,
    absorptionRaw,
    absorptionScore,
    dynamicPhysicsScore,
    selectedRR,
    tpMultiplier,
    atr15mPct,
    slDeterminedBy:
      impliedSlPct >= SIZING_HARD_STOP_FLOOR_PCT ? "physics" : "sizing-floor",
  };

  // SL/TP solved TOGETHER: if the physics-implied SL clears the
  // execution floor, both stand as computed. If not, SL is pinned at
  // the floor and TP is RECOMPUTED (floor x selectedRR) so
  // TP = SL x selectedRR remains exact in EITHER branch.
  const slPct = Math.max(impliedSlPct, SIZING_HARD_STOP_FLOOR_PCT);
  const tpPct = slPct * selectedRR;

  const sl = p.side === "LONG" ? p.entry * (1 - slPct) : p.entry * (1 + slPct);
  const tp = p.side === "LONG" ? p.entry * (1 + tpPct) : p.entry * (1 - tpPct);

  return {
    ...diag,
    ok: true,
    entry: p.entry,
    sl,
    tp,
    slPct,
    tpPct,
    rr: selectedRR,
  };
}
