/**
 * Sep 17 2026 (Karo), operator-approved final capacity architecture.
 *
 * Preserves the four distinct OI states an episode passes through and
 * derives the quantities that follow from them, WITHOUT ever
 * arithmetically combining liquidation USD (forced executed flow)
 * with OI change (net open-contract change) -- they are related
 * market evidence, not additive/subtractive quantities.
 *
 * UNITS: every OI quantity here is raw contract/base quantity
 * (confirmed by source audit: OiTrackerService reads Binance's
 * /fapi/v1/openInterest `openInterest` field directly, no multiplier
 * applied anywhere in this codebase for any currently supported
 * USDT-margined perpetual). notional/USD conversion is centralized in
 * toNotionalUsd() below -- nowhere else in this codebase should
 * multiply an OI quantity by a price inline.
 */

export interface OiPhysicsState {
  oiStartQuantity: number | null;
  oiMinQuantity: number | null;
  oiEndQuantity: number | null;
  oiNowQuantity: number | null;
}

export interface OiPhysicsDerived {
  oiDestroyedQty: number | null;
  oiRebuiltInsideEpisodeQty: number | null;
  netEpisodeOiChangeQty: number | null;
  postEndOiCreationQty: number | null;
}

export function deriveOiPhysics(state: OiPhysicsState): OiPhysicsDerived {
  const oiDestroyedQty = state.oiStartQuantity !== null && state.oiMinQuantity !== null
    ? Math.max(0, state.oiStartQuantity - state.oiMinQuantity) : null;
  const oiRebuiltInsideEpisodeQty = state.oiEndQuantity !== null && state.oiMinQuantity !== null
    ? Math.max(0, state.oiEndQuantity - state.oiMinQuantity) : null;
  const netEpisodeOiChangeQty = state.oiEndQuantity !== null && state.oiStartQuantity !== null
    ? state.oiEndQuantity - state.oiStartQuantity : null;
  const postEndOiCreationQty = state.oiNowQuantity !== null && state.oiEndQuantity !== null
    ? state.oiNowQuantity - state.oiEndQuantity : null;
  return { oiDestroyedQty, oiRebuiltInsideEpisodeQty, netEpisodeOiChangeQty, postEndOiCreationQty };
}

/** Sep 17 2026 (Karo) -- ONE centralized OI-quantity-to-USD-notional
 *  helper. Binance USDT-margined perpetual OI is reported in
 *  base-asset contract quantity, so quantity * referencePrice is the
 *  correct notional conversion for every symbol this strategy
 *  currently trades. If a contract-multiplied symbol is ever added,
 *  this is the ONE place that would need a multiplier parameter --
 *  do not reintroduce inline qty*price conversions elsewhere. */
export function toNotionalUsd(quantity: number | null, referencePrice: number): number | null {
  if (quantity === null) return null;
  return quantity * referencePrice;
}

export interface OiPhysicsNotional {
  oiDestroyedUsd: number | null;
  oiRebuiltInsideEpisodeUsd: number | null;
  netEpisodeOiChangeUsd: number | null;
  postEndOiCreationUsd: number | null;
}

/** Sep 17 2026 (Karo), operator-requested Section 5 -- documented
 *  reference-price methodology, never a moving currentPrice for the
 *  post-END figure:
 *   - oiDestroyedUsd / oiRebuiltInsideEpisodeUsd: converted at the
 *     episode's own extremePrice (the causal price in effect during
 *     that destruction/rebuild).
 *   - netEpisodeOiChangeUsd / postEndOiCreationUsd: converted at
 *     episodeEndPrice, FIXED -- post-END OI creation in USD must not
 *     fluctuate merely because currentPrice moves. */
export function deriveOiPhysicsNotional(derived: OiPhysicsDerived, extremePrice: number, episodeEndPrice: number | null): OiPhysicsNotional {
  return {
    oiDestroyedUsd: toNotionalUsd(derived.oiDestroyedQty, extremePrice),
    oiRebuiltInsideEpisodeUsd: toNotionalUsd(derived.oiRebuiltInsideEpisodeQty, extremePrice),
    netEpisodeOiChangeUsd: episodeEndPrice !== null ? toNotionalUsd(derived.netEpisodeOiChangeQty, episodeEndPrice) : null,
    postEndOiCreationUsd: episodeEndPrice !== null ? toNotionalUsd(derived.postEndOiCreationQty, episodeEndPrice) : null,
  };
}
