import type { Side } from "../../shared/common.types";

/**
 * Sep 9 2026 (Karo), operator-designed structural SL/TP for the fast
 * liquidation-reversal bot. REPLACES the previous liquidation-
 * intensity/Hybrid-C-cap-derived formula (trade-plan.ts's own
 * deriveLiquidityTradePlan(), left in place unmodified but no longer
 * called from the V5 entry path -- see v5-wave.service.ts's own
 * evaluateSignal()).
 *
 * Core idea, operator's own words: liquidation magnitude describes
 * setup CONFIDENCE, not target DISTANCE. SL/TP are now derived
 * entirely from local price structure (the entry-wave's own extreme
 * and the frozen pre-cascade UNIT), never from cumulative liquidation
 * USD, P95, intensity, or a Hybrid-C SL cap.
 *
 * Geometry (LONG; SHORT is the exact mirror):
 *
 *   W2 extreme
 *        |
 *        | +1.0 x UNIT recovery (UNCHANGED -- this is entry
 *        v    confirmation, not touched by this module at all)
 *      ENTRY
 *        |
 *        | structural risk = ENTRY - softExitPrice
 *        |    (NOT 0.4 x UNIT -- the actual distance from the REAL
 *        |    entry price to softExitPrice, which happens to work out
 *        |    to ~(1.0 - K) x UNIT under ideal conditions, but this
 *        |    module always computes the real distance, never assumes
 *        |    the shortcut)
 *        v
 *   softExitPrice = W2 extreme + K x UNIT   (K = 0.4)
 *
 * Two SEPARATE risk numbers, deliberately never merged into one:
 *   - structuralRiskPct: WHERE the reversal thesis is objectively
 *     invalid (thesis/market-truth). This is what TP is derived from.
 *   - sizingRiskPct = hardStopRiskPct = max(structuralRiskPct, 0.20%):
 *     an EXECUTION-MECHANICS floor only (position-sizing / exchange
 *     hard-stop distance). NEVER widens the app-side structural exit,
 *     NEVER widens TP.
 *
 * `sl` (this module's own output, and everywhere downstream that
 * already reads plan.sl / globalSignal.sl for position-sizing and the
 * real exchange stop-loss order) is the HARD-STOP price --
 * deliberately, so execute-for-user.usecase.ts's own
 * `slDistance = |entry - sl|` / positionQty math keeps working
 * byte-identically with ZERO changes there: it naturally picks up the
 * max(structural, 0.20%) floor simply because `sl` now IS that price.
 * The tighter, app-side STRUCTURAL exit is exposed separately as
 * `softExitPrice` -- monitoring/exiting there (rather than waiting for
 * the wider hard-stop to be hit) is a SEPARATE, future concern; this
 * module only computes the correct prices, it does not implement live
 * monitoring.
 */

export const STRUCTURAL_K = 0.4;
export const STRUCTURAL_RR = 2.2;
export const SIZING_HARD_STOP_FLOOR_PCT = 0.002; // 0.20%, execution-mechanics only

export interface StructuralTradePlanInput {
  readonly entry: number;
  readonly side: Side;
  /** The entry wave's (Wave 2's, or later) own extreme price --
   *  NEVER Wave 1's. */
  readonly w2ExtremePrice: number;
  /** Frozen pre-cascade UNIT, in ABSOLUTE price units (same UNIT the
   *  W1/W2 recovery-completion logic already uses -- unitAtStart).
   *  NOT a percentage. */
  readonly unitAbs: number;
}

export interface StructuralTradePlanForensics {
  readonly k: number;
  readonly rrTarget: number;
  /** W2 extreme + K x UNIT (LONG) / W2 extreme - K x UNIT (SHORT). The
   *  app-side, tighter, structural invalidation price. */
  readonly softExitPrice: number;
  /** The REAL distance from entry to softExitPrice, as a fraction of
   *  entry -- NOT assumed to be (1-K) x UNIT; always computed from the
   *  actual entry price. */
  readonly structuralRiskPct: number;
  readonly structuralRiskAbs: number;
  /** max(structuralRiskPct, 0.20%) -- execution-mechanics floor for
   *  position sizing AND the exchange hard-stop distance. Identical
   *  value for both by design (see this module's own doc comment). */
  readonly sizingRiskPct: number;
  readonly hardStopRiskPct: number;
  /** entry -/+ hardStopRiskPct -- the price actually placed as the
   *  exchange stop-loss order. By construction, NEVER closer to entry
   *  than softExitPrice (max() guarantees hardStopRiskPct >=
   *  structuralRiskPct always). */
  readonly hardStopPrice: number;
}

export type StructuralTradePlanResult =
  | (StructuralTradePlanForensics & {
      readonly ok: true;
      readonly entry: number;
      /** = hardStopPrice. Named `sl` (not `hardStopPrice`) so every
       *  existing downstream consumer (position-sizing, exchange
       *  order placement, Telegram formatting) keeps working
       *  unchanged -- see this module's own doc comment. */
      readonly sl: number;
      readonly tp: number;
      /** = hardStopRiskPct, matching `sl`'s own distance exactly (NOT
       *  structuralRiskPct -- see softExitPrice for the tighter,
       *  app-side structural distance). */
      readonly slPct: number;
      /** = structuralRiskPct x RR (STRUCTURAL_RR = 2.2) -- derived
       *  purely from local price structure, never from liquidation
       *  magnitude, P95, intensity, or the sizing floor. */
      readonly tpPct: number;
      /** Always STRUCTURAL_RR (2.2) -- the strategy's own intended
       *  risk/reward, computed against the STRUCTURAL risk (the real
       *  edge), not the wider sizing/hard-stop distance. */
      readonly rr: number;
    })
  | (StructuralTradePlanForensics & {
      readonly ok: false;
      readonly cancelReason: "invalid-input" | "structural-risk-non-positive";
    });

export function deriveStructuralTradePlan(
  p: StructuralTradePlanInput,
): StructuralTradePlanResult {
  const softExitPrice =
    p.side === "LONG"
      ? p.w2ExtremePrice + STRUCTURAL_K * p.unitAbs
      : p.w2ExtremePrice - STRUCTURAL_K * p.unitAbs;

  const structuralRiskAbs = Math.abs(p.entry - softExitPrice);
  const structuralRiskPct = p.entry > 0 ? structuralRiskAbs / p.entry : 0;

  const baseForensics: StructuralTradePlanForensics = {
    k: STRUCTURAL_K,
    rrTarget: STRUCTURAL_RR,
    softExitPrice,
    structuralRiskPct,
    structuralRiskAbs,
    sizingRiskPct: 0,
    hardStopRiskPct: 0,
    hardStopPrice: 0,
  };

  if (!(p.entry > 0) || !(p.unitAbs > 0)) {
    return { ...baseForensics, ok: false, cancelReason: "invalid-input" };
  }
  if (!(structuralRiskPct > 0)) {
    return {
      ...baseForensics,
      ok: false,
      cancelReason: "structural-risk-non-positive",
    };
  }

  // Execution-mechanics floor ONLY -- never feeds TP, never widens the
  // app-side structural exit itself.
  const sizingRiskPct = Math.max(structuralRiskPct, SIZING_HARD_STOP_FLOOR_PCT);
  const hardStopRiskPct = sizingRiskPct;
  const hardStopPrice =
    p.side === "LONG"
      ? p.entry * (1 - hardStopRiskPct)
      : p.entry * (1 + hardStopRiskPct);

  // TP derived ONLY from structural risk x fixed RR target -- never
  // from cumulative liquidation USD, P95, intensity, or the sizing
  // floor above.
  const tpPct = structuralRiskPct * STRUCTURAL_RR;
  const tp = p.side === "LONG" ? p.entry * (1 + tpPct) : p.entry * (1 - tpPct);

  const forensics: StructuralTradePlanForensics = {
    ...baseForensics,
    sizingRiskPct,
    hardStopRiskPct,
    hardStopPrice,
  };

  return {
    ...forensics,
    ok: true,
    entry: p.entry,
    sl: hardStopPrice,
    tp,
    slPct: hardStopRiskPct,
    tpPct,
    rr: STRUCTURAL_RR,
  };
}
