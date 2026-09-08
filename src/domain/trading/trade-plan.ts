import type { Side } from "../../shared/common.types";
import type { WallContext } from "../../shared/trading.types";

/** Liquidity-based SL/TP planner (May 2026 rewrite; extracted Aug 2026
 *  into its own module so it can be reused, byte-identical, by both
 *  SimpleLiquidationService's original pre-fill plan AND
 *  BinanceExecutionService's post-fill REPLAN — same formulas, same
 *  thresholds, zero duplication, either caller substitutes whatever
 *  `entry` it needs. Pure, side-effect-free, no `this`, no service
 *  dependencies: every input is passed in explicitly. */

// ─── Constants ─────────────────────────────────────────────────────────
//
// Quality gates: cancel if tpPct < MIN_TP_PCT, slPct < MIN_SL_PCT, or
// final RR < RR_MIN.
//
// Wall snapshots: the planner consumes walls observed at three points
// during the cascade lifetime (anchor, sweep-start, entry). The math
// currently uses only the entry-time walls for TP-cap; the journey
// snapshots are logged for forensics so we can later promote them
// into the formula once we have data on which signals actually predict
// outcomes.

/** TP scaling factor on (atrPct × intensity). At intensity=1 (a cascade
 *  exactly at the symbol's p95 single-event threshold) and ATR=0.4%,
 *  rawTP = 1.0 × 0.4% × 1 = 0.40% — close to empirical p50 MFE (0.45%).
 *  Bumped from 0.5 → 1.0 (May 2026 rev 2) so the RR-flex range
 *  [RR_MIN, RR_MAX] becomes meaningful: at ALPHA=0.5 the raw TP was so
 *  small that RR was always clamped at RR_MIN. Re-tune after 2-4 weeks
 *  of [V3_TRADE_PLAN] markers. */
export const ALPHA_TP = 1.0;

/** Upper bound on intensity. Beyond this all cascades are treated the
 *  same — market microstructure breaks down for outsized flow.
 *  intensity=4 corresponds to cumLiq = 16 × baseline. For BTCUSDT with
 *  p95 baseline ≈ $241k, that's a $3.86M cascade; everything above is
 *  treated uniformly. */
export const INTENSITY_MAX = 4.0;

/** RR floor — the user's hard rule. No trade is opened with RR below
 *  this regardless of geometry. */
export const RR_MIN = 2.0;

/** RR ceiling — caps over-aggressive RR for big TPs. Above this the
 *  capital efficiency gains plateau and SL becomes too tight. */
export const RR_MAX = 2.5;

/** SL target used by the RR-flex calculation. The planner picks the
 *  RR that lands SL exactly here when possible; if TP is too small to
 *  reach SL_TARGET_FOR_RR even at RR_MIN, RR is floored at RR_MIN and
 *  SL falls below the target. If TP is large enough that RR_MAX would
 *  still land SL above the target, RR is capped at RR_MAX and SL
 *  grows naturally (constrained by slCapFor below). */
export const SL_TARGET_FOR_RR = 0.003; // 0.30%

/** Hybrid C SL hard cap — interpolated by intensity. Normal cascades
 *  (intensity=1) cap SL at 0.30%; strong/mega cascades
 *  (intensity = INTENSITY_MAX = 4) cap at 1.00%. Linear interpolation
 *  between. Below intensity=1 the normal cap applies. The user's hard
 *  range is SL ∈ [0.30%, 1.00%]: floor enforced by MIN_SL_PCT, ceiling
 *  by SL_CAP_STRONG. */
export const SL_CAP_NORMAL = 0.003; // 0.30%
export const SL_CAP_STRONG = 0.01; // 1.00%

/** Minimum acceptable TP / SL fractions. Below either, geometry is
 *  too tight for fees + slippage and the trade is cancelled with
 *  tp-too-small / sl-too-small.
 *
 *  MIN_SL_PCT is the HARD floor — entries below this are cancelled
 *  outright (no warning entries fired). May 2026: bumped from 0.10%
 *  (with warning system) → 0.30% (strict) to reduce signal noise from
 *  marginal entries during low-ATR market regimes; currently 0.20% —
 *  see the operator's Aug 2026 audit note before changing this value,
 *  it is a deliberate risk-management boundary, not a free parameter. */
export const MIN_TP_PCT = 0.002; // 0.20%
export const MIN_SL_PCT = 0.002; // 0.20% (hard floor — cancel below)

/** Wall-handling thresholds. A wall on the profit side must carry
 *  at least WALL_NOTIONAL_MIN to be considered for capping TP; the
 *  cap is placed at WALL_SAFETY_MARGIN × wallDistance to stay inside
 *  the wall (so we exit *before* price reaches the resistance/support
 *  rather than relying on it breaking). */
// const WALL_NOTIONAL_MIN = 100_000; // $100k
export const WALL_SAFETY_MARGIN = 0.95;

// ─── Types ─────────────────────────────────────────────────────────────

/** Wall snapshots collected at the three key transitions in a cascade
 *  lifetime. Only `atEntry` is currently used by the math (TP cap on
 *  the profit side); `atAnchor` and `atSweepStart` are passed through
 *  for forensic logging so we can later promote them into the formula
 *  once we have data on which signals predict outcomes. */
export interface WallSnapshots {
  /** Walls present at fireEntry time (snapshot-fresh). */
  readonly atEntry: WallContext;
  /** Walls present at state creation (the original anchor liq). */
  readonly atAnchor: WallContext;
  /** Walls present at the moment sweep first crossed the anchor.
   *  Null if the cascade reached fireEntry without ever transitioning
   *  to SWEEPING (shouldn't happen — fakeCheckPassed gates entry). */
  readonly atSweepStart: WallContext | null;
}

export interface LiquidityPlanInput {
  readonly entry: number;
  readonly side: Side;
  /** Cumulative liquidation USD for the cascade (state.totalNotional). */
  readonly cumLiq: number;
  /** Baseline cascade size for intensity normalization. Currently uses
   *  liqStats.thresholdLargeLiq() (p95 single-event) as a proxy for
   *  "typical large cascade size". Intensity = sqrt(cumLiq / baseline).
   *  Per-symbol, so SOL/BTC/ETH each compare to their own baseline —
   *  what counts as "intensity 1" is symbol-relative. */
  readonly liqBaseline: number;
  /** ATR15m / entry — volatility unit for the formula. */
  readonly atr15mPct: number;
  /** Wall snapshots collected through the cascade lifetime. */
  readonly walls: WallSnapshots;
}

/** Forensic fields emitted on every plan call (success and failure)
 *  so [V3_TRADE_PLAN] log markers can be parsed uniformly. */
export interface LiquidityPlanForensics {
  /** Raw sqrt(cumLiq / baseline), pre-clamp. */
  readonly intensityRaw: number;
  /** Post-clamp intensity (≤ INTENSITY_MAX). */
  readonly intensity: number;
  readonly atr15mPct: number;
  /** TP fraction from formula before any caps. */
  readonly rawTpPct: number;
  /** TP fraction after wall cap (== rawTpPct if no wall capped). */
  readonly wallAdjustedTpPct: number;
  readonly wallApplied: boolean;
  /** Candidate RR from tpPct / SL_TARGET_FOR_RR before clamping. */
  readonly rrCandidate: number;
  /** Whether the SL hard cap (slCapFor) was triggered. */
  readonly slCapApplied: boolean;
  /** SL cap fraction for this intensity (slCapFor). */
  readonly slCapValue: number;
  /** Profit-side wall notional at entry, anchor, sweep-start (USD).
   *  Logged for forensics only — only atEntry is used for TP cap. */
  readonly profitWallNotionalAtEntry: number;
  readonly profitWallNotionalAtAnchor: number;
  readonly profitWallNotionalAtSweepStart: number;
  /** Aug 2026, geometry-fail outcome tracking (log-only). The
   *  locally-computed slPct/tpPct at the point of the final quality-
   *  gate checks (step 7) — i.e. the values that ACTUALLY caused a
   *  tp-too-small/sl-too-small/rr-below-floor failure. Populated on
   *  EVERY path that reaches step 6 (ok=true, tp-too-small,
   *  sl-too-small, rr-below-floor); left at 0 for invalid-input/
   *  no-baseline, where nothing was ever computed — callers must
   *  treat 0 there as "not available", not as a real value. This is a
   *  purely additive forensic field: it does not change ok/cancelReason
   *  logic anywhere, only exposes numbers that already existed as
   *  local variables but were previously discarded on failure. */
  readonly finalTpPct: number;
  readonly finalSlPct: number;
}

export type LiquidityPlanResult =
  | (LiquidityPlanForensics & {
      readonly ok: true;
      readonly sl: number;
      readonly tp: number;
      readonly slPct: number;
      readonly tpPct: number;
      readonly rr: number;
    })
  | (LiquidityPlanForensics & {
      readonly ok: false;
      readonly cancelReason:
        | "tp-too-small"
        | "sl-too-small"
        | "rr-below-floor"
        | "no-baseline"
        | "invalid-input";
    });

// ─── Functions ─────────────────────────────────────────────────────────

/** SL cap as a fraction of entry, interpolated for Hybrid C: linear from
 *  SL_CAP_NORMAL at intensity=1 to SL_CAP_STRONG at INTENSITY_MAX.
 *  Below intensity=1 (very small cascades) the normal cap applies. */
export function slCapFor(intensity: number): number {
  if (intensity <= 1) return SL_CAP_NORMAL;
  if (intensity >= INTENSITY_MAX) return SL_CAP_STRONG;
  const t = (intensity - 1) / (INTENSITY_MAX - 1);
  return SL_CAP_NORMAL + t * (SL_CAP_STRONG - SL_CAP_NORMAL);
}

/** Profit-side wall notional, or 0 if the wall is on the wrong side
 *  / below the significance threshold / missing. Used only for
 *  forensic logging — the math uses profitWallDistancePct directly. */
export function profitWallNotional(
  entry: number,
  side: Side,
  walls: WallContext,
): number {
  const wallPrice = side === "LONG" ? walls.topAskPrice : walls.topBidPrice;
  const wallNotional =
    side === "LONG" ? walls.topAskNotional : walls.topBidNotional;
  if (wallPrice <= 0 || wallNotional <= 0) return 0;
  const onProfitSide = side === "LONG" ? wallPrice > entry : wallPrice < entry;
  return onProfitSide ? wallNotional : 0;
}

/** Distance to the profit-side wall as a fraction of entry, or +Infinity
 *  if no significant wall on profit side. LONG profits upward → ask wall
 *  is the resistance; SHORT profits downward → bid wall is the support.
 *  A wall is "significant" if its peak notional ≥ WALL_NOTIONAL_MIN. */
export function profitWallDistancePct(
  entry: number,
  side: Side,
  walls: WallContext,
  minWallNotional: number,
): number {
  const wallPrice = side === "LONG" ? walls.topAskPrice : walls.topBidPrice;
  const wallNotional =
    side === "LONG" ? walls.topAskNotional : walls.topBidNotional;

  if (wallPrice <= 0 || wallNotional < minWallNotional) {
    return Number.POSITIVE_INFINITY;
  }

  const onProfitSide = side === "LONG" ? wallPrice > entry : wallPrice < entry;
  if (!onProfitSide) return Number.POSITIVE_INFINITY;

  return Math.abs(wallPrice - entry) / entry;
}

/** Liquidity-based SL/TP planner.
 *
 *  Steps:
 *    1. Cascade intensity = sqrt(cumLiq / baseline), clamped to
 *       INTENSITY_MAX.
 *    2. rawTpPct = ALPHA_TP × atr15mPct × intensity.
 *    3. If profit-side wall (entry-time snapshot) sits inside rawTpPct,
 *       pull TP to WALL_SAFETY_MARGIN × wallDistance.
 *    4. RR flex: rrCandidate = tpPct / SL_TARGET_FOR_RR. The actual RR
 *       is clamp(rrCandidate, RR_MIN, RR_MAX). For small TP, RR clamps
 *       to RR_MIN (SL ends up below SL_TARGET_FOR_RR but stays above
 *       MIN_SL_PCT). For large TP, RR clamps to RR_MAX (SL grows past
 *       SL_TARGET_FOR_RR up to slCapFor).
 *    5. slPct = tpPct / rr.
 *    6. Hybrid C SL cap. If slPct > slCapFor(intensity), pin SL at the
 *       cap and recompute TP = slCap × rr. If wall was active and the
 *       recomputed TP exceeds the wall, pin TP back to the wall and
 *       recompute SL — wall is an absolute ceiling.
 *    7. Quality gates: cancel if tpPct < MIN_TP_PCT, slPct < MIN_SL_PCT,
 *       or final RR < RR_MIN.
 *
 *  Journey walls (atAnchor, atSweepStart) are not used in the math —
 *  they are recorded in forensics for later analysis. Once we have
 *  data on whether journey-wall presence predicts trade outcomes,
 *  the formula can be extended to incorporate them.
 *
 *  Pure and stateless — callers (SimpleLiquidationService for the
 *  pre-fill plan, BinanceExecutionService for the post-fill replan)
 *  supply every input explicitly; this function reads no service
 *  state and has no side effects.
 *
 *  Returns a discriminated union: `{ ok: true, sl, tp, ... }` for valid
 *  plans, `{ ok: false, cancelReason, ... }` otherwise. Both branches
 *  carry the LiquidityPlanForensics fields for logging. */
export function deriveLiquidityTradePlan(
  p: LiquidityPlanInput,
): LiquidityPlanResult {
  // Pre-compute journey-wall notionals for forensics. These are
  // calculated even on failure paths so [V3_TRADE_PLAN] markers
  // are uniformly parseable.
  const profitWallNotionalAtEntry = profitWallNotional(
    p.entry,
    p.side,
    p.walls.atEntry,
  );
  const profitWallNotionalAtAnchor = profitWallNotional(
    p.entry,
    p.side,
    p.walls.atAnchor,
  );
  const profitWallNotionalAtSweepStart =
    p.walls.atSweepStart !== null
      ? profitWallNotional(p.entry, p.side, p.walls.atSweepStart)
      : 0;

  // Forensics initialized to defensible defaults so failure-path
  // returns still log meaningful values rather than NaN.
  const baseForensics: LiquidityPlanForensics = {
    intensityRaw: 0,
    intensity: 0,
    atr15mPct: p.atr15mPct,
    rawTpPct: 0,
    wallAdjustedTpPct: 0,
    wallApplied: false,
    rrCandidate: 0,
    slCapApplied: false,
    slCapValue: SL_CAP_NORMAL,
    profitWallNotionalAtEntry,
    profitWallNotionalAtAnchor,
    profitWallNotionalAtSweepStart,
    finalTpPct: 0,
    finalSlPct: 0,
  };

  if (!(p.entry > 0) || !(p.atr15mPct > 0) || !(p.cumLiq > 0)) {
    return { ...baseForensics, ok: false, cancelReason: "invalid-input" };
  }
  if (!(p.liqBaseline > 0)) {
    return { ...baseForensics, ok: false, cancelReason: "no-baseline" };
  }

  // Step 1. Cascade intensity (sqrt impact law, clamped).
  const intensityRaw = Math.sqrt(p.cumLiq / p.liqBaseline);
  const intensity = Math.min(intensityRaw, INTENSITY_MAX);

  // Step 2. Raw TP from volatility × intensity.
  const rawTpPct = ALPHA_TP * p.atr15mPct * intensity;

  // Step 3. Wall cap on TP — uses entry-time walls only.
  const minWallNotional = p.cumLiq * 0.5;

  const wallDistPct = profitWallDistancePct(
    p.entry,
    p.side,
    p.walls.atEntry,
    minWallNotional,
  );
  const wallCapPct = wallDistPct * WALL_SAFETY_MARGIN;
  const wallApplied = wallCapPct < rawTpPct;
  let tpPct = wallApplied ? wallCapPct : rawTpPct;
  const wallAdjustedTpPct = tpPct;

  // Step 4. RR flex: pick the RR that lands SL near SL_TARGET_FOR_RR,
  // clamped to [RR_MIN, RR_MAX]. For small TP, RR clamps to RR_MIN
  // and SL ends up smaller than the target (still above MIN_SL_PCT
  // floor). For large TP, RR clamps to RR_MAX and SL grows naturally.
  const rrCandidate = tpPct / SL_TARGET_FOR_RR;
  let rr = Math.max(RR_MIN, Math.min(rrCandidate, RR_MAX));

  // Step 5. SL from TP via the chosen RR.
  let slPct = tpPct / rr;

  // Step 6. Hybrid C SL hard cap. If SL still exceeds the cap for this
  // intensity (rare — would require very high TP combined with RR_MAX),
  // pin SL at cap and recompute TP. RR is held constant. If wall was
  // active and the new TP exceeds the wall, pin TP back to the wall
  // and recompute SL.
  const slCapValue = slCapFor(intensity);
  let slCapApplied = false;
  if (slPct > slCapValue) {
    slCapApplied = true;
    slPct = slCapValue;
    tpPct = slPct * rr;
    if (wallApplied && tpPct > wallCapPct) {
      tpPct = wallCapPct;
      slPct = tpPct / rr;
    }
  }

  // Recompute final RR after all caps (may differ slightly from `rr`
  // due to wall-after-slCap adjustment).
  rr = tpPct / slPct;

  const forensics: LiquidityPlanForensics = {
    ...baseForensics,
    intensityRaw,
    intensity,
    rawTpPct,
    wallAdjustedTpPct,
    wallApplied,
    rrCandidate,
    slCapApplied,
    slCapValue,
    finalTpPct: tpPct,
    finalSlPct: slPct,
  };

  // Step 7. Quality gates.
  if (tpPct < MIN_TP_PCT) {
    return { ...forensics, ok: false, cancelReason: "tp-too-small" };
  }
  if (slPct < MIN_SL_PCT) {
    return { ...forensics, ok: false, cancelReason: "sl-too-small" };
  }
  if (rr < RR_MIN - 0.001) {
    // float tolerance — guards against accumulated rounding.
    return { ...forensics, ok: false, cancelReason: "rr-below-floor" };
  }

  // Step 8. Compute absolute prices.
  const sl = p.side === "LONG" ? p.entry * (1 - slPct) : p.entry * (1 + slPct);
  const tp = p.side === "LONG" ? p.entry * (1 + tpPct) : p.entry * (1 - tpPct);

  return {
    ...forensics,
    ok: true,
    sl,
    tp,
    slPct,
    tpPct,
    rr,
  };
}
