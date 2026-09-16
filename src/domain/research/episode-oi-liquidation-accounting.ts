import type { RawEvent } from "./displacement-balanced-core";
import type { OiWaypoint } from "./episode-oi-trajectory";

/**
 * Sep 16 2026 (Karo), operator-approved. UNITS VERIFIED BEFORE
 * IMPLEMENTATION, not assumed: Liquidation.quantity (as emitted by
 * the live WS handler) comes from Binance's raw forceOrder.o.q field,
 * base-asset units. OpenInterest's openInterest field is base-asset
 * "contracts". Binance's own current documentation confirms USDS-M
 * (linear) contracts -- everything this bot trades, all through
 * /fapi/v1/ -- have NO contract multiplier: "each contract represents
 * only ONE unit of its respective base asset." The 100-USD/10-USD
 * multiplier concept applies only to COIN-Margined (inverse)
 * contracts, which this bot never uses. Liquidation quantity and OI
 * quantity are therefore directly comparable, same units, for every
 * symbol.
 *
 * IMPORTANT SCHEMA FINDING: raw base-asset quantity was never
 * persisted as its own field in liq_raw_events -- only quoteQty
 * (USD notional) and price. Confirmed directly against the WS
 * handler's own construction (quoteQty = price * quantity), so the
 * original quantity is PRECISELY recoverable as quoteQty / price --
 * an exact algebraic inversion of the same formula used to compute
 * quoteQty in the first place, not an approximation. Derived inline
 * here rather than requiring any schema/loader change.
 *
 * ACCOUNTING SCOPE, STATED PRECISELY: this module NEVER claims to
 * know total gross contract creation exactly. Voluntary closes, new
 * opens unrelated to this episode, and opposite-side liquidations can
 * all occur in the same interval and are not separable from this
 * data. What IS measurable: liquidation quantity (a real, known
 * contraction component) versus the OBSERVED net OI change over the
 * same interval. Where net OI change is >= 0 despite a known
 * contraction component, an IMPLIED minimum replacement/creation
 * quantity is well-defined arithmetically -- described as "implied
 * replacement required to offset the observed liquidation component
 * and produce the measured net OI change", never as "new shorts/longs
 * opened" or "X exactly reopened". Where net OI change is negative,
 * "implied replacement" is not computed -- a neutrally-described
 * residual is offered instead, explicitly never labeled "voluntary
 * closing".
 *
 * TIME ALIGNMENT (the operator's own emphasis): OI only exists at
 * liquidation-event timestamps. The liquidation-quantity numerator
 * for any phase is bounded to the SAME measurement interval as the OI
 * waypoints actually used for that phase -- never blindly summed to
 * the structural episode boundary when the actual OI waypoint is
 * earlier.
 */

export interface QuantityPhaseAccounting {
  liquidatedQuantity: number | null;
  observedOiQuantityChange: number | null;
  observedOiQuantityChangePct: number | null;
  netOiChangeToLiquidationRatio: number | null;
  impliedReplacementQuantity: number | null;
  impliedReplacementToLiquidationRatio: number | null;
  residualContractionBeyondLiquidation: number | null;
  phaseStartTimestamp: number | null;
  phaseEndTimestamp: number | null;
  structuralPhaseEndTimestamp: number | null;
  offsetFromStructuralEndMs: number | null;
}

function pctChange(from: number | null, to: number | null): number | null {
  return from !== null && from !== 0 && to !== null
    ? ((to - from) / from) * 100
    : null;
}

/** quantity = quoteQty / price -- exact algebraic inversion of how
 *  quoteQty was originally computed, see this module's own header.
 *  Strictly same-direction events only; strictly within
 *  (fromTsExclusive, toTsInclusive]. */
function sumLiquidatedQuantity(
  sameDirectionEvents: readonly RawEvent[],
  fromTsExclusive: number,
  toTsInclusive: number,
): number {
  let sum = 0;
  for (const ev of sameDirectionEvents) {
    if (
      ev.timestamp > fromTsExclusive &&
      ev.timestamp <= toTsInclusive &&
      ev.price > 0
    )
      sum += ev.quoteQty / ev.price;
  }
  return sum;
}

export function computeQuantityPhaseAccounting(
  sameDirectionEvents: readonly RawEvent[],
  startWp: OiWaypoint | null,
  endWp: OiWaypoint | null,
  structuralPhaseEndTimestamp: number | null,
): QuantityPhaseAccounting {
  if (
    startWp === null ||
    endWp === null ||
    startWp.openInterest === null ||
    endWp.openInterest === null
  ) {
    return {
      liquidatedQuantity: null,
      observedOiQuantityChange: null,
      observedOiQuantityChangePct: null,
      netOiChangeToLiquidationRatio: null,
      impliedReplacementQuantity: null,
      impliedReplacementToLiquidationRatio: null,
      residualContractionBeyondLiquidation: null,
      phaseStartTimestamp: startWp?.timestamp ?? null,
      phaseEndTimestamp: endWp?.timestamp ?? null,
      structuralPhaseEndTimestamp,
      offsetFromStructuralEndMs: null,
    };
  }

  const liquidatedQuantity = sumLiquidatedQuantity(
    sameDirectionEvents,
    startWp.timestamp,
    endWp.timestamp,
  );
  const observedOiQuantityChange = endWp.openInterest - startWp.openInterest;
  const observedOiQuantityChangePct = pctChange(
    startWp.openInterest,
    endWp.openInterest,
  );
  const netOiChangeToLiquidationRatio =
    liquidatedQuantity > 0
      ? observedOiQuantityChange / liquidatedQuantity
      : null;

  let impliedReplacementQuantity: number | null = null;
  let impliedReplacementToLiquidationRatio: number | null = null;
  let residualContractionBeyondLiquidation: number | null = null;
  if (liquidatedQuantity > 0) {
    if (observedOiQuantityChange >= 0) {
      impliedReplacementQuantity =
        liquidatedQuantity + observedOiQuantityChange;
      impliedReplacementToLiquidationRatio =
        impliedReplacementQuantity / liquidatedQuantity;
    } else {
      residualContractionBeyondLiquidation =
        Math.abs(observedOiQuantityChange) - liquidatedQuantity;
    }
  }

  const offsetFromStructuralEndMs =
    structuralPhaseEndTimestamp !== null
      ? endWp.timestamp - structuralPhaseEndTimestamp
      : null;

  return {
    liquidatedQuantity,
    observedOiQuantityChange,
    observedOiQuantityChangePct,
    netOiChangeToLiquidationRatio,
    impliedReplacementQuantity,
    impliedReplacementToLiquidationRatio,
    residualContractionBeyondLiquidation,
    phaseStartTimestamp: startWp.timestamp,
    phaseEndTimestamp: endWp.timestamp,
    structuralPhaseEndTimestamp,
    offsetFromStructuralEndMs,
  };
}

export interface EpisodeQuantityAccounting {
  startToExtreme: QuantityPhaseAccounting;
  extremeToEnd: QuantityPhaseAccounting;
  startToEnd: QuantityPhaseAccounting;
}

export function computeEpisodeQuantityAccounting(
  sameDirectionEvents: readonly RawEvent[],
  startWp: OiWaypoint | null,
  extremeWp: OiWaypoint | null,
  endWp: OiWaypoint | null,
  extremeTime: number,
  endTime: number | null,
): EpisodeQuantityAccounting {
  return {
    startToExtreme: computeQuantityPhaseAccounting(
      sameDirectionEvents,
      startWp,
      extremeWp,
      extremeTime,
    ),
    extremeToEnd: computeQuantityPhaseAccounting(
      sameDirectionEvents,
      extremeWp,
      endWp,
      endTime,
    ),
    startToEnd: computeQuantityPhaseAccounting(
      sameDirectionEvents,
      startWp,
      endWp,
      endTime,
    ),
  };
}
