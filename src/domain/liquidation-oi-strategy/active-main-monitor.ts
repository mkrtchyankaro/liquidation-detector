import type { Side } from "../../shared/common.types";
import type { LiquidationOiActiveLifecycleConfig } from "./active-lifecycle-config";

/**
 * Sep 17 2026 (Karo), operator-requested Section J. MAIN owns the
 * market thesis for an ACTIVE global signal -- this file is that
 * decision logic, pure and side-effect-free. The orchestrator (not
 * this file) is responsible for calling it from the EXISTING live
 * price/OI flow (no new stream), and for acting on its output
 * (MARKET_EXIT fan-out).
 */

// ---------------- 4A: strategy invalidation ----------------

/** LONG: price <= strategyInvalidationPrice => terminal.
 *  SHORT: price >= strategyInvalidationPrice => terminal. */
export function isStrategyInvalidated(
  candidateSide: Side,
  currentPrice: number,
  strategyInvalidationPrice: number,
): boolean {
  return candidateSide === "LONG"
    ? currentPrice <= strategyInvalidationPrice
    : currentPrice >= strategyInvalidationPrice;
}

// ---------------- 4B: OI + price efficiency controller ----------------

export type OiPriceEfficiencyState =
  | "FAVORABLE"
  | "WEAKENING"
  | "NEUTRAL"
  | "ADVERSE_CANDIDATE"
  | "ADVERSE_CONFIRMED";

export interface OiPriceEfficiencyReading {
  ts: number;
  price: number;
  oiQuantity: number;
}

export interface OiPriceEfficiencyControllerState {
  state: OiPriceEfficiencyState;
  consecutiveAdverseCount: number;
  lastEvalAt: number | null;
  windowStartReading: OiPriceEfficiencyReading | null;
  lastEvidence: "FAVORABLE" | "ADVERSE" | "NONE" | null;
  lastDeltaOiPct: number | null;
  lastDeltaPriceAtr: number | null;
}

export function initOiPriceEfficiencyState(): OiPriceEfficiencyControllerState {
  return {
    state: "NEUTRAL",
    consecutiveAdverseCount: 0,
    lastEvalAt: null,
    windowStartReading: null,
    lastEvidence: null,
    lastDeltaOiPct: null,
    lastDeltaPriceAtr: null,
  };
}

export interface OiPriceEfficiencyEvalResult {
  changed: boolean;
  state: OiPriceEfficiencyControllerState;
  justConfirmedAdverse: boolean;
  deltaOi: number | null;
  deltaOiPct: number | null;
  deltaPrice: number | null;
  deltaPriceAtr: number | null;
}

/** NEVER interprets OI direction alone -- every classification requires
 *  BOTH a meaningful price move AND meaningful OI creation, jointly, per
 *  the operator's own explicit market-mechanics instruction. Evaluated
 *  no more often than oiEfficiencyEvalIntervalMs (smoothing); each
 *  window compares against the reading at the START of the current
 *  oiEfficiencyWindowMs window (not tick-to-tick), and ADVERSE_CONFIRMED
 *  requires oiEfficiencyConfirmationCount CONSECUTIVE adverse readings
 *  (debounce/persistence/hysteresis) -- a single noisy tick can never
 *  flip the thesis. */
export function evaluateOiPriceEfficiency(
  prev: OiPriceEfficiencyControllerState,
  candidateSide: Side,
  reading: OiPriceEfficiencyReading,
  atr3m: number | null,
  config: LiquidationOiActiveLifecycleConfig,
): OiPriceEfficiencyEvalResult {
  if (
    prev.lastEvalAt !== null &&
    reading.ts - prev.lastEvalAt < config.oiEfficiencyEvalIntervalMs
  ) {
    return {
      changed: false,
      state: prev,
      justConfirmedAdverse: false,
      deltaOi: null,
      deltaOiPct: null,
      deltaPrice: null,
      deltaPriceAtr: null,
    };
  }
  const windowStart =
    prev.windowStartReading !== null &&
    reading.ts - prev.windowStartReading.ts <= config.oiEfficiencyWindowMs
      ? prev.windowStartReading
      : reading;
  const nextWindowStartReading =
    reading.ts - windowStart.ts >= config.oiEfficiencyWindowMs
      ? reading
      : windowStart;

  if (
    windowStart === reading ||
    atr3m === null ||
    atr3m <= 0 ||
    windowStart.oiQuantity <= 0
  ) {
    return {
      changed: false,
      state: {
        ...prev,
        lastEvalAt: reading.ts,
        windowStartReading: nextWindowStartReading,
      },
      justConfirmedAdverse: false,
      deltaOi: null,
      deltaOiPct: null,
      deltaPrice: null,
      deltaPriceAtr: null,
    };
  }

  const deltaOi = reading.oiQuantity - windowStart.oiQuantity;
  const deltaOiPct = deltaOi / windowStart.oiQuantity;
  const deltaPrice = reading.price - windowStart.price;
  const deltaPriceAtr = deltaPrice / atr3m;

  const meaningfulOiCreation =
    deltaOiPct >= config.oiEfficiencyMinMeaningfulOiCreationFraction;
  const priceMoveAtr = Math.abs(deltaPriceAtr);
  const meaningfulPriceMove =
    priceMoveAtr >= config.oiEfficiencyMinMeaningfulPriceAtr;

  let evidence: "FAVORABLE" | "ADVERSE" | "NONE" = "NONE";
  if (meaningfulOiCreation && meaningfulPriceMove) {
    const priceUp = deltaPrice > 0;
    const favorableDirection = candidateSide === "LONG" ? priceUp : !priceUp;
    evidence = favorableDirection ? "FAVORABLE" : "ADVERSE";
  }

  const nextConsecutiveAdverse =
    evidence === "ADVERSE" ? prev.consecutiveAdverseCount + 1 : 0;
  let nextState: OiPriceEfficiencyState;
  if (nextConsecutiveAdverse >= config.oiEfficiencyConfirmationCount)
    nextState = "ADVERSE_CONFIRMED";
  else if (nextConsecutiveAdverse >= 2) nextState = "ADVERSE_CANDIDATE";
  else if (nextConsecutiveAdverse === 1) nextState = "WEAKENING";
  else if (evidence === "FAVORABLE") nextState = "FAVORABLE";
  else nextState = "NEUTRAL";

  const justConfirmedAdverse =
    nextState === "ADVERSE_CONFIRMED" && prev.state !== "ADVERSE_CONFIRMED";
  const changed = nextState !== prev.state;

  const nextStateObj: OiPriceEfficiencyControllerState = {
    state: nextState,
    consecutiveAdverseCount: nextConsecutiveAdverse,
    lastEvalAt: reading.ts,
    windowStartReading: nextWindowStartReading,
    lastEvidence: evidence,
    lastDeltaOiPct: deltaOiPct,
    lastDeltaPriceAtr: deltaPriceAtr,
  };
  return {
    changed,
    state: nextStateObj,
    justConfirmedAdverse,
    deltaOi,
    deltaOiPct,
    deltaPrice,
    deltaPriceAtr,
  };
}
