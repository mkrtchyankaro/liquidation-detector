import type { Liquidation, Side } from "../../shared/common.types";
import type { AggressiveFlowService } from "./aggressive-flow.service";
import type { OiTrackerService } from "./oi-tracker.service";
import type { OrderbookStore } from "../market/orderbook.store";
import type { WallTrackerService } from "./wall-tracker.service";
import type { CandleStore } from "../market/candle.store";
import type { LiquidationStore } from "./liquidation.store";
import type { ATRTrackerService } from "../market/atr-tracker.service";
import type { DirectionalAtrTracker } from "../../strategy/v5/directional-atr";
import type { FundingStatsService } from "./funding-stats.service";
import type { FundingRateService } from "./funding-rate.service";

/**
 * Sep 15 2026 (Karo), operator-requested. Builds the `marketSnapshot`
 * object attached to every enriched `liq_raw_events` document. PURE,
 * SYNCHRONOUS, READS-ONLY-RAM: every field comes from a service that
 * is already continuously maintained by the bot (WS-fed or
 * REST-polled on its own independent timer) -- this function itself
 * makes zero network calls and never blocks.
 *
 * CAUSALITY: every value read here reflects state as of `now` (the
 * liquidation event's own timestamp) or earlier -- nothing here can
 * observe anything that happens after the event, since it is called
 * synchronously at the moment the event arrives, before any later
 * event has been processed.
 *
 * SCOPE NOTE (documented, not hidden): three fields are honestly
 * unavailable from existing infrastructure and reported as null
 * rather than fabricated --
 *   - priceChange30sPct: no 30s-resolution price history ring exists
 *     anywhere in this codebase (CandleStore's shortest interval is
 *     1m). Reported null.
 *   - normalAtr for 1m/3m: AtrTrackerService (the NON-directional ATR)
 *     only tracks 5m/15m/1h per its own module header -- no 1m/3m
 *     instance exists in production. Reported null for those two
 *     timeframes; 5m normalAtr IS available and populated.
 *   - topTraderLongShortAccountRatio: FundingStatsService polls
 *     globalLongShortAccountRatio (global, head-count) and
 *     topLongShortPositionRatio (top-trader, money-weighted) -- there
 *     is no separate top-trader ACCOUNT (head-count) ratio poll
 *     anywhere in the codebase. Reported null with a name distinct
 *     from the two real metrics, never conflated with either.
 */

export interface MarketSnapshotDeps {
  aggressiveFlow: AggressiveFlowService;
  oiTracker: OiTrackerService;
  orderbookStore: OrderbookStore;
  wallTracker: WallTrackerService;
  candleStore: CandleStore;
  liquidationStore: LiquidationStore;
  atrTracker: ATRTrackerService;
  directionalAtr1m: DirectionalAtrTracker;
  directionalAtr3m: DirectionalAtrTracker;
  directionalAtr5m: DirectionalAtrTracker;
  fundingStats: FundingStatsService;
  fundingRate: FundingRateService;
}

const TAKER_WINDOWS_MS: { label: string; ms: number }[] = [
  { label: "10s", ms: 10_000 },
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "2m", ms: 120_000 },
  { label: "3m", ms: 180_000 },
  { label: "5m", ms: 300_000 },
];
const LIQ_CONTEXT_WINDOWS_MS: { label: string; ms: number }[] = [
  { label: "10s", ms: 10_000 },
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "3m", ms: 180_000 },
  { label: "5m", ms: 300_000 },
];
const OI_DELTA_WINDOWS_MS: { label: string; ms: number }[] = [
  { label: "1m", ms: 60_000 },
  { label: "2m", ms: 120_000 },
  { label: "3m", ms: 180_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
];
const BOOK_DISTANCE_BANDS_PCT = [0.05, 0.1, 0.25, 0.5];

function pctChange(from: number | null, to: number | null): number | null {
  return from !== null && from > 0 && to !== null
    ? ((to - from) / from) * 100
    : null;
}

export function buildMarketSnapshot(
  deps: MarketSnapshotDeps,
  liq: Liquidation,
  now: number,
): Record<string, unknown> {
  const symbol = liq.symbol;
  const victim: Side = liq.side === "SELL" ? "LONG" : "SHORT";

  const bookTicker = deps.orderbookStore.getBookTicker(symbol);
  const midPrice = deps.orderbookStore.midPrice(symbol);
  const spread = bookTicker ? bookTicker.ask - bookTicker.bid : null;
  const spreadPct =
    spread !== null && midPrice && midPrice > 0
      ? (spread / midPrice) * 100
      : null;
  const PRICE_CHANGE_WINDOWS_MS: { label: string; ms: number }[] = [
    { label: "10s", ms: 10_000 },
    { label: "30s", ms: 30_000 },
    { label: "1m", ms: 60_000 },
    { label: "2m", ms: 120_000 },
    { label: "3m", ms: 180_000 },
    { label: "5m", ms: 300_000 },
  ];
  const priceDeltas: Record<string, number | null> = {};
  for (const w of PRICE_CHANGE_WINDOWS_MS) {
    const past = deps.orderbookStore.getHistorySampleNear(symbol, now - w.ms);
    priceDeltas[`priceChange${w.label}Pct`] = pctChange(
      past?.midPrice ?? null,
      liq.price,
    );
  }
  const priceState = {
    price: liq.price,
    markPrice: null as number | null,
    bestBid: bookTicker?.bid ?? null,
    bestAsk: bookTicker?.ask ?? null,
    midPrice,
    spread,
    spreadPct,
    ...priceDeltas,
  };

  const oiNow = deps.oiTracker.getCachedOI(symbol);
  const oiHistory = deps.oiTracker.getOiHistory(symbol);
  const oiAtOrBefore = (atOrBeforeMs: number): number | null => {
    let best: { contracts: number; fetchedAt: number } | null = null;
    for (const h of oiHistory)
      if (
        h.fetchedAt <= atOrBeforeMs &&
        (best === null || h.fetchedAt > best.fetchedAt)
      )
        best = h;
    return best?.contracts ?? null;
  };
  const oiDeltas: Record<string, number | null> = {};
  for (const w of OI_DELTA_WINDOWS_MS)
    oiDeltas[`oiChange${w.label}Pct`] = pctChange(
      oiAtOrBefore(now - w.ms),
      oiNow?.contracts ?? null,
    );
  const openInterest = {
    openInterest: oiNow?.contracts ?? null,
    openInterestUsd: oiNow && midPrice ? oiNow.contracts * midPrice : null,
    ...oiDeltas,
    oiUpdatedAt: oiNow?.ts ?? null,
    oiAgeMs: oiNow ? now - oiNow.ts : null,
  };

  const takerFlow: Record<string, unknown> = {};
  for (const w of TAKER_WINDOWS_MS) {
    const snap = deps.aggressiveFlow.getRecentFlow(symbol, w.ms, now);
    const buyUsd = snap?.buyUsd ?? 0,
      sellUsd = snap?.sellUsd ?? 0,
      total = buyUsd + sellUsd;
    takerFlow[w.label] =
      snap === null
        ? null
        : {
            takerBuyUsd: buyUsd,
            takerSellUsd: sellUsd,
            totalTakerUsd: total,
            takerBuyPct: total > 0 ? (buyUsd / total) * 100 : null,
            takerSellPct: total > 0 ? (sellUsd / total) * 100 : null,
            buySellRatio: sellUsd > 0 ? buyUsd / sellUsd : null,
            imbalance: total > 0 ? (buyUsd - sellUsd) / total : null,
          };
  }

  const depth = deps.orderbookStore.getDepth(symbol);
  const depthBands: Record<string, unknown> = {};
  if (depth && midPrice) {
    for (const pct of BOOK_DISTANCE_BANDS_PCT) {
      const lowerBound = midPrice * (1 - pct / 100);
      const upperBound = midPrice * (1 + pct / 100);
      const bidDepthUsd = depth.bids
        .filter((l) => l.price >= lowerBound)
        .reduce((s, l) => s + l.price * l.quantity, 0);
      const askDepthUsd = depth.asks
        .filter((l) => l.price <= upperBound)
        .reduce((s, l) => s + l.price * l.quantity, 0);
      const total = bidDepthUsd + askDepthUsd;
      depthBands[`${pct}pct`] = {
        bidDepthUsd,
        askDepthUsd,
        bookImbalance: total > 0 ? (bidDepthUsd - askDepthUsd) / total : null,
      };
    }
  }
  const histNow = deps.orderbookStore.getHistorySampleNear(symbol, now);
  const hist30s = deps.orderbookStore.getHistorySampleNear(
    symbol,
    now - 30_000,
  );
  const hist1m = deps.orderbookStore.getHistorySampleNear(symbol, now - 60_000);
  const wallSnap = deps.wallTracker.snapshot(symbol);
  const orderBook = {
    bestBid: bookTicker?.bid ?? null,
    bestAsk: bookTicker?.ask ?? null,
    depthBands: Object.keys(depthBands).length > 0 ? depthBands : null,
    bookImbalanceChangeVs30sAgo:
      histNow?.imbalance !== null &&
      histNow?.imbalance !== undefined &&
      hist30s?.imbalance !== null &&
      hist30s?.imbalance !== undefined
        ? histNow.imbalance - hist30s.imbalance
        : null,
    bookImbalanceChangeVs1mAgo:
      histNow?.imbalance !== null &&
      histNow?.imbalance !== undefined &&
      hist1m?.imbalance !== null &&
      hist1m?.imbalance !== undefined
        ? histNow.imbalance - hist1m.imbalance
        : null,
    bidDepthChangeVs30sAgoUsd:
      histNow?.bidUsdTotal !== null &&
      histNow?.bidUsdTotal !== undefined &&
      hist30s?.bidUsdTotal !== null &&
      hist30s?.bidUsdTotal !== undefined
        ? histNow.bidUsdTotal - hist30s.bidUsdTotal
        : null,
    askDepthChangeVs30sAgoUsd:
      histNow?.askUsdTotal !== null &&
      histNow?.askUsdTotal !== undefined &&
      hist30s?.askUsdTotal !== null &&
      hist30s?.askUsdTotal !== undefined
        ? histNow.askUsdTotal - hist30s.askUsdTotal
        : null,
    bidDepthChangeVs1mAgoUsd:
      histNow?.bidUsdTotal !== null &&
      histNow?.bidUsdTotal !== undefined &&
      hist1m?.bidUsdTotal !== null &&
      hist1m?.bidUsdTotal !== undefined
        ? histNow.bidUsdTotal - hist1m.bidUsdTotal
        : null,
    askDepthChangeVs1mAgoUsd:
      histNow?.askUsdTotal !== null &&
      histNow?.askUsdTotal !== undefined &&
      hist1m?.askUsdTotal !== null &&
      hist1m?.askUsdTotal !== undefined
        ? histNow.askUsdTotal - hist1m.askUsdTotal
        : null,
    nearestBidWallPrice: wallSnap.topBidWall?.representativePrice ?? null,
    nearestBidWallUsd: wallSnap.topBidWall?.currentNotional ?? null,
    nearestBidWallDistancePct:
      wallSnap.topBidWall && midPrice
        ? (Math.abs(wallSnap.topBidWall.representativePrice - midPrice) /
            midPrice) *
          100
        : null,
    nearestBidWallPersistent: wallSnap.topBidWall?.isPersistent ?? null,
    nearestBidWallAgeMs: wallSnap.topBidWall?.ageMs ?? null,
    nearestBidWallPeakNotional: wallSnap.topBidWall?.peakNotional ?? null,
    nearestAskWallPrice: wallSnap.topAskWall?.representativePrice ?? null,
    nearestAskWallUsd: wallSnap.topAskWall?.currentNotional ?? null,
    nearestAskWallDistancePct:
      wallSnap.topAskWall && midPrice
        ? (Math.abs(wallSnap.topAskWall.representativePrice - midPrice) /
            midPrice) *
          100
        : null,
    nearestAskWallPersistent: wallSnap.topAskWall?.isPersistent ?? null,
    nearestAskWallAgeMs: wallSnap.topAskWall?.ageMs ?? null,
    nearestAskWallPeakNotional: wallSnap.topAskWall?.peakNotional ?? null,
    wallsPulled1m: wallSnap.pulled1mCount,
    orderBookUpdatedAt: depth?.timestamp ?? null,
    orderBookAgeMs: depth ? now - depth.timestamp : null,
  };

  const atrFor = (
    tracker: DirectionalAtrTracker,
    normalAtr: number | null,
  ): Record<string, unknown> => {
    const down = tracker.getDownAtr(symbol),
      up = tracker.getUpAtr(symbol);
    const liqDirAtr = victim === "LONG" ? down : up,
      recDirAtr = victim === "LONG" ? up : down;
    return {
      normalAtr,
      normalAtrPct:
        normalAtr !== null && midPrice ? (normalAtr / midPrice) * 100 : null,
      atrDown: down,
      atrUp: up,
      atrDownPct: down !== null && midPrice ? (down / midPrice) * 100 : null,
      atrUpPct: up !== null && midPrice ? (up / midPrice) * 100 : null,
      liquidationDirectionAtr: liqDirAtr,
      recoveryDirectionAtr: recDirAtr,
      liquidationDirectionAtrPct:
        liqDirAtr !== null && midPrice ? (liqDirAtr / midPrice) * 100 : null,
      recoveryDirectionAtrPct:
        recDirAtr !== null && midPrice ? (recDirAtr / midPrice) * 100 : null,
      recoveryToLiquidationAtrRatio:
        liqDirAtr !== null && liqDirAtr > 0 && recDirAtr !== null
          ? recDirAtr / liqDirAtr
          : null,
    };
  };
  const atr = {
    "1m": atrFor(
      deps.directionalAtr1m,
      deps.atrTracker.getWilderATR(symbol, "1m", 14),
    ),
    "3m": atrFor(
      deps.directionalAtr3m,
      deps.atrTracker.getWilderATR(symbol, "3m", 14),
    ),
    "5m": atrFor(
      deps.directionalAtr5m,
      deps.atrTracker.getWilderATR(symbol, "5m", 14),
    ),
    lastClosedCandleTs: {
      "1m": deps.candleStore.lastClosed(symbol, "1m")?.openTime ?? null,
      "3m": deps.candleStore.lastClosed(symbol, "3m")?.openTime ?? null,
      "5m": deps.candleStore.lastClosed(symbol, "5m")?.openTime ?? null,
    },
  };

  const globalRatio = deps.fundingStats.getLongShortRatio(symbol);
  const topPositionRatio = deps.fundingStats.getPositionRatio(symbol);
  const positioning = {
    globalLongShortAccountRatio: globalRatio?.ratio ?? null,
    globalLongPct: globalRatio ? globalRatio.longAccount * 100 : null,
    globalShortPct: globalRatio ? globalRatio.shortAccount * 100 : null,
    topTraderLongShortPositionRatio: topPositionRatio?.ratio ?? null,
    topTraderLongPositionPct: topPositionRatio
      ? topPositionRatio.longAccount * 100
      : null,
    topTraderShortPositionPct: topPositionRatio
      ? topPositionRatio.shortAccount * 100
      : null,
    topTraderLongShortAccountRatio: null as number | null,
    positioningUpdatedAt: globalRatio?.fetchedAt ?? null,
    positioningAgeMs: globalRatio ? now - globalRatio.fetchedAt : null,
  };

  const fundingRateValue = deps.fundingRate.getFundingRate(symbol);
  const fundingFetchedAt = deps.fundingRate.getFundingRateFetchedAt(symbol);
  const funding = {
    fundingRate: fundingRateValue,
    fundingUpdatedAt: fundingFetchedAt,
    fundingAgeMs: fundingFetchedAt !== null ? now - fundingFetchedAt : null,
  };

  const sameSide = liq.side;
  const oppositeSide = liq.side === "SELL" ? "BUY" : "SELL";
  const liquidationContext: Record<string, unknown> = {};
  for (const w of LIQ_CONTEXT_WINDOWS_MS) {
    const inWindow = deps.liquidationStore.inWindow(symbol, w.ms, now);
    const sameCount = deps.liquidationStore.countBySide(
      symbol,
      sameSide,
      w.ms,
      now,
    );
    const oppCount = deps.liquidationStore.countBySide(
      symbol,
      oppositeSide,
      w.ms,
      now,
    );
    const sameUsd = inWindow
      .filter((l) => l.side === sameSide)
      .reduce((s, l) => s + l.quoteQty, 0);
    const oppUsd = inWindow
      .filter((l) => l.side === oppositeSide)
      .reduce((s, l) => s + l.quoteQty, 0);
    liquidationContext[`sameSideLiqCount${w.label}`] = sameCount;
    liquidationContext[`sameSideLiqUsd${w.label}`] = sameUsd;
    liquidationContext[`oppositeSideLiqCount${w.label}`] = oppCount;
    liquidationContext[`oppositeSideLiqUsd${w.label}`] = oppUsd;
  }

  return {
    priceState,
    openInterest,
    takerFlow,
    orderBook,
    atr,
    positioning,
    funding,
    liquidationContext,
  };
}
