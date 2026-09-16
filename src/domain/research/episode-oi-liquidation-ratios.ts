import type { OiWaypoint } from "./episode-oi-trajectory";

/**
 * Sep 16 2026 (Karo), operator-approved. Quantifies observed net OI
 * change RELATIVE TO liquidation size -- explicitly a coincidence
 * measurement, never an accounting claim. "$8M liquidated, $6M net OI
 * contraction observed" is a valid statement this module supports;
 * "$8M closed, $2M reopened" or "new shorts opened" are NOT claims
 * this module (or any code that consumes it) is permitted to make --
 * OI alone cannot identify which side initiated new contracts, and
 * liquidation notional and OI USD change are not the same accounting
 * quantity in the first place.
 *
 * QUANTITY vs USD (schema-verified, not invented): the stored
 * openInterest field is raw CONTRACTS (base-asset units), captured
 * completely independently of openInterestUsd (contracts times mark
 * price at capture time) -- confirmed directly against
 * liquidation-market-snapshot.builder.ts. This means a QUANTITY-based
 * percent change is available and is mechanically free of price
 * revaluation effects, unlike the USD-based change, which can move
 * even with zero actual contract-count change purely because price
 * moved. Both are computed here, explicitly separate, so callers can
 * compare them rather than assuming they tell the same story.
 *
 * The liquidation-normalized RATIO features are intentionally USD-
 * based only (liquidation notional is inherently a dollar figure;
 * dividing it by a raw contract-count change would not be a coherent
 * ratio). The quantity-based phase changes exist purely as an
 * independent price-effect-free cross-check, not to feed the ratios.
 */

export interface OiPhaseChangeUsd {
  oiStartUsd: number | null;
  oiNearExtremeUsd: number | null;
  oiNearEndUsd: number | null;
  oiStartToExtremeUsd: number | null;
  oiExtremeToEndUsd: number | null;
  oiStartToEndUsd: number | null;
  oiStartToExtremePct: number | null;
  oiExtremeToEndPct: number | null;
  oiStartToEndPct: number | null;
}
export interface OiPhaseChangeQuantity {
  oiStartQuantity: number | null;
  oiNearExtremeQuantity: number | null;
  oiNearEndQuantity: number | null;
  oiQuantityStartToExtremePct: number | null;
  oiQuantityExtremeToEndPct: number | null;
  oiQuantityStartToEndPct: number | null;
}
export interface OiLiquidationRatios {
  /** Signed. Negative = net OI contraction observed over the full
   *  episode; positive = net OI expansion observed. NEVER clamped --
   *  magnitude can exceed 1, and that is not automatically a bug.
   *  Null when sameDirectionLiqUsd<=0 or oiStartToEndUsd unavailable. */
  oiNetChangeToLiqRatio: number | null;
  /** Same signed quantity, expressed per $1M of episode liquidation
   *  notional. */
  oiNetChangePer1MLiqUsd: number | null;
  /** Contraction-only, floored at 0 -- a human-readable "how much of
   *  the liquidation notional coincided with observed OI contraction"
   *  figure, kept SEPARATE from the signed ratio above. */
  oiClearingRatio: number | null;
}

function pctChange(from: number | null, to: number | null): number | null {
  return from !== null && from > 0 && to !== null
    ? ((to - from) / from) * 100
    : null;
}

export function computeOiPhaseChangeUsd(
  startWp: OiWaypoint | null,
  extremeWp: OiWaypoint | null,
  endWp: OiWaypoint | null,
): OiPhaseChangeUsd {
  const startUsd = startWp?.openInterestUsd ?? null,
    extremeUsd = extremeWp?.openInterestUsd ?? null,
    endUsd = endWp?.openInterestUsd ?? null;
  return {
    oiStartUsd: startUsd,
    oiNearExtremeUsd: extremeUsd,
    oiNearEndUsd: endUsd,
    oiStartToExtremeUsd:
      startUsd !== null && extremeUsd !== null ? extremeUsd - startUsd : null,
    oiExtremeToEndUsd:
      extremeUsd !== null && endUsd !== null ? endUsd - extremeUsd : null,
    oiStartToEndUsd:
      startUsd !== null && endUsd !== null ? endUsd - startUsd : null,
    oiStartToExtremePct: pctChange(startUsd, extremeUsd),
    oiExtremeToEndPct: pctChange(extremeUsd, endUsd),
    oiStartToEndPct: pctChange(startUsd, endUsd),
  };
}

export function computeOiPhaseChangeQuantity(
  startWp: OiWaypoint | null,
  extremeWp: OiWaypoint | null,
  endWp: OiWaypoint | null,
): OiPhaseChangeQuantity {
  const startQ = startWp?.openInterest ?? null,
    extremeQ = extremeWp?.openInterest ?? null,
    endQ = endWp?.openInterest ?? null;
  return {
    oiStartQuantity: startQ,
    oiNearExtremeQuantity: extremeQ,
    oiNearEndQuantity: endQ,
    oiQuantityStartToExtremePct: pctChange(startQ, extremeQ),
    oiQuantityExtremeToEndPct: pctChange(extremeQ, endQ),
    oiQuantityStartToEndPct: pctChange(startQ, endQ),
  };
}

/** sameDirectionLiqUsd must be strictly positive for any ratio to be
 *  meaningful -- returns all-null otherwise, never a fabricated ratio. */
export function computeOiLiquidationRatios(
  sameDirectionLiqUsd: number,
  oiStartToEndUsd: number | null,
): OiLiquidationRatios {
  if (sameDirectionLiqUsd <= 0 || oiStartToEndUsd === null) {
    return {
      oiNetChangeToLiqRatio: null,
      oiNetChangePer1MLiqUsd: null,
      oiClearingRatio: null,
    };
  }
  return {
    oiNetChangeToLiqRatio: oiStartToEndUsd / sameDirectionLiqUsd,
    oiNetChangePer1MLiqUsd: oiStartToEndUsd / (sameDirectionLiqUsd / 1_000_000),
    oiClearingRatio: Math.max(0, -oiStartToEndUsd) / sameDirectionLiqUsd,
  };
}
