/**
 * Sep 17 2026 (Karo), operator-requested Section E. STRICTLY
 * OBSERVATIONAL -- captured for later research analysis only. Nothing
 * in this file's output may be read by any WATCH/clearing/entry/
 * sizing/exit decision; it is a pure snapshot builder. Reuses the
 * EXISTING WallTrackerService (via getLargestPersistentWall) and the
 * bestBid/bestAsk already carried on every bookTicker tick -- no new
 * Binance subscription of any kind.
 */

import type { LiquidationOiActiveLifecycleConfig } from "./active-lifecycle-config";

export interface WallObservation {
  price: number;
  notionalUsd: number;
  distanceFromPriceAtr: number | null;
  distanceFromExtremeAtr: number | null;
}

export interface OrderBookObservation {
  capturedAt: number;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  spreadBps: number | null;
  strongestNearbyBidWall: WallObservation | null;
  strongestNearbyAskWall: WallObservation | null;
  bidDepthNotionalUsd: number | null;
  askDepthNotionalUsd: number | null;
  depthImbalance: number | null;
}

export interface WallLookup {
  getLargestPersistentWall(
    symbol: string,
    side: "BID" | "ASK",
  ): { representativePrice: number; currentNotional: number } | null;
}

/** Pure. Never fabricates a metric it cannot derive -- null instead. */
export function captureOrderBookObservation(
  symbol: string,
  currentPrice: number | null,
  extremePrice: number | null,
  atr3m: number | null,
  bestBid: number | null,
  bestAsk: number | null,
  wallLookup: WallLookup | null,
  config: LiquidationOiActiveLifecycleConfig,
  nowMs: number,
): OrderBookObservation {
  const spread =
    bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const mid =
    bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spreadBps =
    spread !== null && mid !== null && mid > 0 ? (spread / mid) * 10_000 : null;

  const bidWallRaw =
    wallLookup?.getLargestPersistentWall(symbol, "BID") ?? null;
  const askWallRaw =
    wallLookup?.getLargestPersistentWall(symbol, "ASK") ?? null;

  const toObservation = (
    raw: { representativePrice: number; currentNotional: number } | null,
  ): WallObservation | null => {
    if (raw === null) return null;
    const distanceFromPriceAtr =
      currentPrice !== null && atr3m !== null && atr3m > 0
        ? Math.abs(raw.representativePrice - currentPrice) / atr3m
        : null;
    const distanceFromExtremeAtr =
      extremePrice !== null && atr3m !== null && atr3m > 0
        ? Math.abs(raw.representativePrice - extremePrice) / atr3m
        : null;
    return {
      price: raw.representativePrice,
      notionalUsd: raw.currentNotional,
      distanceFromPriceAtr,
      distanceFromExtremeAtr,
    };
  };

  let bidWall = toObservation(bidWallRaw);
  let askWall = toObservation(askWallRaw);
  if (
    bidWall !== null &&
    bidWall.distanceFromPriceAtr !== null &&
    bidWall.distanceFromPriceAtr > config.orderBookNearbyBandAtr
  )
    bidWall = null;
  if (
    askWall !== null &&
    askWall.distanceFromPriceAtr !== null &&
    askWall.distanceFromPriceAtr > config.orderBookNearbyBandAtr
  )
    askWall = null;

  const bidDepthNotionalUsd = bidWallRaw?.currentNotional ?? null;
  const askDepthNotionalUsd = askWallRaw?.currentNotional ?? null;
  const depthImbalance =
    bidDepthNotionalUsd !== null &&
    askDepthNotionalUsd !== null &&
    bidDepthNotionalUsd + askDepthNotionalUsd > 0
      ? (bidDepthNotionalUsd - askDepthNotionalUsd) /
        (bidDepthNotionalUsd + askDepthNotionalUsd)
      : null;

  return {
    capturedAt: nowMs,
    bestBid,
    bestAsk,
    spread,
    spreadBps,
    strongestNearbyBidWall: bidWall,
    strongestNearbyAskWall: askWall,
    bidDepthNotionalUsd,
    askDepthNotionalUsd,
    depthImbalance,
  };
}
