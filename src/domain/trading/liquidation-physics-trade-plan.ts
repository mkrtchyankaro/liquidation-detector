import type { Side } from "../../shared/common.types";

/**
 * Sep 9 2026 (Karo), operator-designed DYNAMIC liquidation-physics
 * trade plan. REPLACES the previous FIXED K=0.4 / RR=2.2 structural
 * plan (structural-trade-plan.ts, left in place unmodified but no
 * longer called from any production path -- see the operator's own
 * explicit instruction: "study both old implementations because they
 * contain useful ideas", not "delete and start over").
 *
 * Three conceptually distinct, independently-bounded components,
 * combined MULTIPLICATIVELY (never summed -- summing correlated
 * ratios double-counts the same underlying information):
 *
 *   A. liquidityStrength -- how exceptional is W1's own liquidation
 *      pressure, relative to TWO different historical baselines
 *      (individual-event P95, and today's own aggregate 24h rate).
 *      Sub-linear (sqrt) in both, per the operator's own explicit
 *      instruction and standard market-impact convention (square-root
 *      price-impact law). CRITICAL: uses W1Liq specifically (V5Wave
 *      #1's own liqNotionalUsd), NEVER totalEpisodePressure (the
 *      whole-episode cumulative sum) and NEVER compared against P95
 *      as if they were the same statistic -- P95 is an INDIVIDUAL-
 *      EVENT threshold, W1Liq is a SUM of events; dividing one by the
 *      other answers "how many P95-sized events' worth of pressure is
 *      W1", a normalized RATIO, not a category error.
 *
 *   B. exhaustion -- W2's own liquidation relative to W1's. A W2
 *      materially WEAKER than W1 is the operator's own explicit
 *      reversal thesis (forced flow drying up on the second push).
 *      Reused, unmodified, from V3's own original formula shape
 *      (exhaustion = 1 - clamp(W2/W1, 0, 1)) -- the one piece of V3
 *      the operator explicitly asked to revive.
 *
 *   C. absorption -- large forced liquidation producing relatively
 *      SMALL price displacement = the market absorbed the flow =
 *      stronger reversal evidence (Kyle's-lambda / Amihud-style
 *      price-impact intuition, per the operator's own research).
 *      HONEST LIMITATION, stated explicitly per the operator's own
 *      instruction: this project has NO separately-calibrated
 *      historical "expected price-move per dollar liquidated"
 *      statistic anywhere (that would require a new, independent
 *      liquidation-to-price-displacement regression this project does
 *      not currently track). This is the STRONGEST proxy buildable
 *      from data that ALREADY exists: W1's own liquidity-in-P95-units
 *      divided by W1's own price displacement, in UNIT terms --
 *      "how much forced-selling pressure occurred per unit of actual
 *      price movement". Sub-linear (sqrt) for the same square-root-law
 *      reason as component A, and tightly bounded [0.5, 2.0] so it can
 *      only modestly damp or boost the other two components, never
 *      dominate the score on its own.
 *
 * The three components are combined into ONE score in [0, 1]
 * (dynamicPhysicsScore), which THEN drives, monotonically:
 *   - selectedRR: one of {2.0, 2.1, ..., 2.5} -- never outside this
 *     ladder, per the operator's own hard requirement.
 *   - dynamicK: the SAME structural-geometry concept as the previous
 *     fixed-K model (softExitPrice = W2extreme +/- K x UNIT), but K
 *     itself now ranges [K_MAX, K_MIN] (LOWER K = WIDER structural
 *     risk) as the score rises -- so a stronger, more-exhausted,
 *     better-absorbed setup earns BOTH a wider SL and a higher RR,
 *     coherently, from the SAME underlying confidence measure, per
 *     the operator's own explicit "solved together" requirement.
 *
 * SL is then floored at the EXECUTION-MECHANICS-ONLY 0.20% minimum
 * (position sizing / exchange hard-stop distance -- see this module's
 * own SIZING_HARD_STOP_FLOOR_PCT, identical concept and value to
 * structural-trade-plan.ts's own SIZING_HARD_STOP_FLOOR_PCT). TP is
 * ALWAYS exactly slPct x selectedRR -- never computed independently,
 * per the operator's own explicit "TP = SL x selectedRR" requirement.
 *
 * A HUGE liquidation alone cannot explode TP: liquidityStrength is
 * capped at STRENGTH_MAX, absorption is capped at ABSORPTION_MAX, and
 * the RR ladder itself is hard-capped at 2.5 -- three independent
 * ceilings, not one.
 */

// ─── Constants (every one documented, every one reused where a
//     defensible existing meaning exists) ──────────────────────────────

/** Caps liquidityStrength's own two sub-scores before averaging.
 *  Reuses the EXACT value (and the same underlying meaning -- "beyond
 *  this, market microstructure breaks down for outsized flow") as the
 *  previous formula's own INTENSITY_MAX (trade-plan.ts). */
export const STRENGTH_MAX = 4.0;

/** Floor on W1's own displacement-in-UNIT-terms before it becomes the
 *  denominator of the absorption ratio -- avoids a division blowup
 *  when W1's own anchor-to-extreme move was smaller than half a UNIT
 *  (a genuinely near-zero-displacement wave, not a data error). */
export const MIN_DISPLACEMENT_UNITS = 0.5;

/** Absorption is a MODEST damper/booster, never a dominant term --
 *  deliberately narrow bound so components A and B (which carry the
 *  primary liquidation-magnitude and exhaustion evidence) remain the
 *  main drivers of the score. */
export const ABSORPTION_MIN = 0.5;
export const ABSORPTION_MAX = 2.0;

/** Dynamic structural-K range. K_MAX (weakest setups) reproduces
 *  roughly the SAME tight geometry the previous fixed K=0.4 model
 *  used; K_MIN (strongest setups) widens the structural risk (and
 *  therefore SL and TP together) for a materially more convincing
 *  setup. LOWER K = WIDER structural risk (softExitPrice sits FARTHER
 *  from entry, since entry is fixed at W2extreme +/- 1.0xUNIT and
 *  structural risk = (1.0 - K) x UNIT). */
export const K_MIN = 0.3;
export const K_MAX = 0.7;

/** RR ladder -- hard requirement, never outside this set. */
export const RR_LADDER: readonly number[] = [2.0, 2.1, 2.2, 2.3, 2.4, 2.5];

/** Execution-mechanics-only floor (position sizing / exchange hard-
 *  stop distance) -- IDENTICAL concept and value to
 *  structural-trade-plan.ts's own SIZING_HARD_STOP_FLOOR_PCT. Never
 *  widens the app-side structural exit itself, never feeds TP. */
export const SIZING_HARD_STOP_FLOOR_PCT = 0.002; // 0.20%

export interface LiquidationPhysicsInput {
  readonly entry: number;
  readonly side: Side;
  /** Wave 1's OWN anchor/extreme/liqNotionalUsd -- never the
   *  cumulative episode total, never Wave 2's own values. */
  readonly w1AnchorPrice: number;
  readonly w1ExtremePrice: number;
  readonly w1LiqUsd: number;
  /** Wave 2's (the ENTRY wave's) own liqNotionalUsd and extreme --
   *  extremePrice here is what softExitPrice/entry geometry anchors
   *  to, exactly like the previous fixed-K model. */
  readonly w2LiqUsd: number;
  readonly w2ExtremePrice: number;
  /** Frozen pre-cascade UNIT (ATR1m, absolute price units) --
   *  watch.unitAtStart, unchanged source/semantics from the previous
   *  model. */
  readonly unitAbs: number;
  /** Individual-event P95 threshold AT ENTRY TIME (liqStats'
   *  own notionalPercentile(...,95), combined-samples regime --
   *  unchanged source from the already-restored, combined-only
   *  strategy path). An INDIVIDUAL-EVENT statistic -- never
   *  conflated with the episode-cumulative sums above. */
  readonly p95: number;
  /** Today's own aggregate liquidation rate, in USD PER MINUTE --
   *  derived from the EXISTING liq24hContext.dayLiqTotalUsd (already
   *  computed by get24hStats()) divided by 1440 minutes. Not a new
   *  statistic; simple arithmetic on an already-persisted field. */
  readonly dailyLiqPerMinBaseline: number;
}

export interface LiquidationPhysicsDiagnostics {
  readonly liquidityStrengthP95: number;
  readonly liquidityStrength24h: number;
  readonly liquidityStrength: number;
  readonly w2ToW1Ratio: number;
  readonly exhaustionScore: number;
  readonly w1DisplacementUnits: number;
  readonly absorptionRaw: number;
  readonly absorptionScore: number;
  readonly dynamicPhysicsScore: number;
  readonly selectedRR: number;
  readonly dynamicK: number;
  readonly unitAbs: number;
  /** Which floor/cap actually determined the final SL -- "structural"
   *  (the dynamic K x UNIT geometry) or "sizing-floor" (the 0.20%
   *  execution-mechanics minimum kicked in). Pure diagnostics, never
   *  read by any decision logic. */
  readonly slDeterminedBy: "structural" | "sizing-floor";
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
      readonly cancelReason: "invalid-input" | "structural-risk-non-positive";
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
    w1DisplacementUnits: 0,
    absorptionRaw: 0,
    absorptionScore: 0,
    dynamicPhysicsScore: 0,
    selectedRR: RR_LADDER[0]!,
    dynamicK: K_MAX,
    unitAbs: p.unitAbs,
    slDeterminedBy: "sizing-floor",
  };

  if (!(p.entry > 0) || !(p.unitAbs > 0) || !(p.p95 > 0) || !(p.w1LiqUsd > 0)) {
    return { ...zeroDiag, ok: false, cancelReason: "invalid-input" };
  }

  // ─── A. Liquidation strength (sub-linear, dual-baseline, averaged
  //     -- NOT summed -- to avoid double-counting the same underlying
  //     W1Liq figure against two different, but related, baselines) ──
  const liquidityStrengthP95 = Math.sqrt(p.w1LiqUsd / p.p95);
  const liquidityStrength24h =
    p.dailyLiqPerMinBaseline > 0
      ? Math.sqrt(p.w1LiqUsd / p.dailyLiqPerMinBaseline)
      : liquidityStrengthP95;
  const liquidityStrength = Math.max(
    0,
    Math.min((liquidityStrengthP95 + liquidityStrength24h) / 2, STRENGTH_MAX),
  );

  // ─── B. W2/W1 exhaustion -- V3's own original shape, reused as-is,
  //     with the CORRECT wave-specific liqUsd values (never episode-
  //     cumulative). ──────────────────────────────────────────────────
  const w2ToW1Ratio = p.w1LiqUsd > 0 ? p.w2LiqUsd / p.w1LiqUsd : 1;
  const exhaustionScore = 1 - Math.max(0, Math.min(w2ToW1Ratio, 1));

  // ─── C. Absorption -- honest, existing-data-only proxy (see this
  //     module's own doc comment for the full limitation statement). ──
  const w1DisplacementAbs = Math.abs(p.w1AnchorPrice - p.w1ExtremePrice);
  const w1DisplacementUnits = Math.max(
    w1DisplacementAbs / p.unitAbs,
    MIN_DISPLACEMENT_UNITS,
  );
  const w1LiquidityP95Units = p.w1LiqUsd / p.p95;
  const absorptionRaw = w1LiquidityP95Units / w1DisplacementUnits;
  const absorptionScore = Math.max(
    ABSORPTION_MIN,
    Math.min(Math.sqrt(absorptionRaw), ABSORPTION_MAX),
  );

  // ─── Combine -- MULTIPLICATIVE, each term independently normalized
  //     to roughly [0,1] first, so ALL THREE must contribute for a
  //     high score (a huge W1 alone, with weak exhaustion or weak
  //     absorption, cannot alone produce a high score). ────────────────
  const rawScore =
    (liquidityStrength / STRENGTH_MAX) *
    exhaustionScore *
    (absorptionScore / ABSORPTION_MAX);
  const dynamicPhysicsScore = Math.max(0, Math.min(rawScore, 1));

  const selectedRR = scoreToRR(dynamicPhysicsScore);
  const dynamicK = K_MAX - dynamicPhysicsScore * (K_MAX - K_MIN);

  const softExitPrice =
    p.side === "LONG"
      ? p.w2ExtremePrice + dynamicK * p.unitAbs
      : p.w2ExtremePrice - dynamicK * p.unitAbs;
  const structuralRiskAbs = Math.abs(p.entry - softExitPrice);
  const structuralRiskPct = structuralRiskAbs / p.entry;

  const diag: LiquidationPhysicsDiagnostics = {
    liquidityStrengthP95,
    liquidityStrength24h,
    liquidityStrength,
    w2ToW1Ratio,
    exhaustionScore,
    w1DisplacementUnits,
    absorptionRaw,
    absorptionScore,
    dynamicPhysicsScore,
    selectedRR,
    dynamicK,
    unitAbs: p.unitAbs,
    slDeterminedBy:
      structuralRiskPct >= SIZING_HARD_STOP_FLOOR_PCT
        ? "structural"
        : "sizing-floor",
  };

  if (!(structuralRiskPct > 0)) {
    return { ...diag, ok: false, cancelReason: "structural-risk-non-positive" };
  }

  const slPct = Math.max(structuralRiskPct, SIZING_HARD_STOP_FLOOR_PCT);
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
