import type { Side } from "../../shared/common.types";

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 3.
 * Lightweight, causal accumulation of a same-direction liquidation
 * episode -- NO Telegram, NO WATCH decision here (see
 * watch-qualification.ts for that). No fixed time window: an episode
 * lives as long as same-direction liquidations keep arriving.
 */

export interface LiquidationOiEpisodeState {
  symbol: string;
  victim: Side;
  firstLiqTs: number;
  latestLiqTs: number;
  eventCount: number;
  sameDirectionLiqUsd: number;
  startPrice: number;
  extremePrice: number;
  extremeTs: number;
  startOiQuantity: number | null;
  currentOiQuantity: number | null;
  currentOiTs: number | null;
  minOiQuantity: number | null;
  minOiTs: number | null;
}

export interface LiquidationOiEventInput {
  symbol: string;
  victim: Side;
  timestamp: number;
  price: number;
  quoteQty: number;
}

export function startEpisode(
  event: LiquidationOiEventInput,
  oiAtStart: { quantity: number; timestamp: number } | null,
): LiquidationOiEpisodeState {
  return {
    symbol: event.symbol,
    victim: event.victim,
    firstLiqTs: event.timestamp,
    latestLiqTs: event.timestamp,
    eventCount: 1,
    sameDirectionLiqUsd: event.quoteQty,
    startPrice: event.price,
    extremePrice: event.price,
    extremeTs: event.timestamp,
    startOiQuantity: oiAtStart?.quantity ?? null,
    currentOiQuantity: oiAtStart?.quantity ?? null,
    currentOiTs: oiAtStart?.timestamp ?? null,
    minOiQuantity: oiAtStart?.quantity ?? null,
    minOiTs: oiAtStart?.timestamp ?? null,
  };
}

/** Caller must confirm event.symbol===state.symbol &&
 *  event.victim===state.victim before calling -- an opposite-side
 *  event must never reach this (symbol-ownership's own "ignore"
 *  resolution prevents that upstream). Extreme updates only if this
 *  event's price is MORE adverse (LONG: lower; SHORT: higher). */
export function foldLiquidationIntoEpisode(
  state: LiquidationOiEpisodeState,
  event: LiquidationOiEventInput,
): LiquidationOiEpisodeState {
  const isMoreAdverse =
    state.victim === "LONG"
      ? event.price < state.extremePrice
      : event.price > state.extremePrice;
  return {
    ...state,
    latestLiqTs: event.timestamp,
    eventCount: state.eventCount + 1,
    sameDirectionLiqUsd: state.sameDirectionLiqUsd + event.quoteQty,
    extremePrice: isMoreAdverse ? event.price : state.extremePrice,
    extremeTs: isMoreAdverse ? event.timestamp : state.extremeTs,
  };
}

/** Records a fresh OI observation independent of liquidation events.
 *  Caller must supply samples strictly in arrival order -- this
 *  function does not defend against out-of-order calls. */
export function updateEpisodeOi(
  state: LiquidationOiEpisodeState,
  oi: { quantity: number; timestamp: number },
): LiquidationOiEpisodeState {
  const isNewMinimum =
    state.minOiQuantity === null || oi.quantity < state.minOiQuantity;
  return {
    ...state,
    currentOiQuantity: oi.quantity,
    currentOiTs: oi.timestamp,
    minOiQuantity: isNewMinimum ? oi.quantity : state.minOiQuantity,
    minOiTs: isNewMinimum ? oi.timestamp : state.minOiTs,
  };
}

/** OI destroyed from episode start to its own observed minimum, as a
 *  fraction (0-1) of the starting OI -- null if either endpoint is
 *  unavailable, clamped to >=0 defensively. */
export function oiDestructionFraction(
  state: LiquidationOiEpisodeState,
): number | null {
  if (
    state.startOiQuantity === null ||
    state.minOiQuantity === null ||
    state.startOiQuantity === 0
  )
    return null;
  return Math.max(
    0,
    (state.startOiQuantity - state.minOiQuantity) / state.startOiQuantity,
  );
}

/** Liquidation notional relative to the OI notional it started with
 *  -- dimensionless, comparable across symbols. Uses OI QUANTITY
 *  (contracts), never USD. Null if starting OI is unavailable -- no
 *  USD-based fallback (not a coherent ratio). */
export function liquidationToStartingOiRatio(
  state: LiquidationOiEpisodeState,
  priceAtStart: number,
): number | null {
  if (
    state.startOiQuantity === null ||
    state.startOiQuantity === 0 ||
    priceAtStart <= 0
  )
    return null;
  const startingOiUsdEstimate = state.startOiQuantity * priceAtStart;
  return state.sameDirectionLiqUsd / startingOiUsdEstimate;
}
