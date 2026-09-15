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

  // ---- CAUSAL order-book state: latest update at-or-before `now`, never "whatever is currently latest in RAM" ----
  const bookTicker = deps.orderbookStore.getBookTickerAtOrBefore(symbol, now);
  const midPrice = deps.orderbookStore.midPriceAtOrBefore(symbol, now);
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

  // ---- CAUSAL OI: current reading also goes through the at-or-before lookup, not getCachedOI()'s own "latest" semantics ----
  const oiHistory = deps.oiTracker.getOiHistory(symbol);
  const oiEntryAtOrBefore = (
    atOrBeforeMs: number,
  ): { contracts: number; fetchedAt: number } | null => {
    let best: { contracts: number; fetchedAt: number } | null = null;
    for (const h of oiHistory)
      if (
        h.fetchedAt <= atOrBeforeMs &&
        (best === null || h.fetchedAt > best.fetchedAt)
      )
        best = h;
    return best;
  };
  const oiNowEntry = oiEntryAtOrBefore(now);
  const oiDeltas: Record<string, number | null> = {};
  for (const w of OI_DELTA_WINDOWS_MS)
    oiDeltas[`oiChange${w.label}Pct`] = pctChange(
      oiEntryAtOrBefore(now - w.ms)?.contracts ?? null,
      oiNowEntry?.contracts ?? null,
    );
  const openInterest = {
    openInterest: oiNowEntry?.contracts ?? null,
    openInterestUsd:
      oiNowEntry && midPrice ? oiNowEntry.contracts * midPrice : null,
    ...oiDeltas,
    oiUpdatedAt: oiNowEntry?.fetchedAt ?? null,
    oiAgeMs: oiNowEntry ? now - oiNowEntry.fetchedAt : null,
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

  const depth = deps.orderbookStore.getDepthAtOrBefore(symbol, now);
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
  const wallSnapRaw = deps.wallTracker.snapshot(symbol);
  // CAUSAL wall guard: WallTrackerService.snapshot() returns its own
  // CURRENT internal state (no timestamp-bounded lookup exists there --
  // full historization of wall tracking is out of scope for this fix,
  // see this file's own final report). A wall whose own lastSeenAt is
  // AFTER `now` reflects an update the liquidation handler could not
  // have known about yet -- treat it as unavailable rather than leak it.
  const topBidWall =
    wallSnapRaw.topBidWall && wallSnapRaw.topBidWall.lastSeenAt <= now
      ? wallSnapRaw.topBidWall
      : null;
  const topAskWall =
    wallSnapRaw.topAskWall && wallSnapRaw.topAskWall.lastSeenAt <= now
      ? wallSnapRaw.topAskWall
      : null;
  const orderBook = {
    bestBid: bookTicker?.bid ?? null,
    bestAsk: bookTicker?.ask ?? null,
    depthBands: Object.keys(depthBands).length > 0 ? depthBands : null,
    // Sep 15 2026 (Karo), operator-reported -- flat, explicitly-named
    // aliases for the 0.05% band's own values (already computed
    // above, same causal `depth` snapshot, no duplicate calculation).
    // Added because the nested depthBands["0.05pct"] key contains a
    // literal dot, which the research exporter's naive dot-split path
    // parser could not traverse -- these flat names sidestep that
    // entirely for the most commonly needed band. depthBands itself
    // is left completely unchanged (all 4 bands, nested), preserving
    // exact backward compatibility with anything already reading it.
    bidDepth5bpUsd:
      (depthBands["0.05pct"] as { bidDepthUsd: number } | undefined)
        ?.bidDepthUsd ?? null,
    askDepth5bpUsd:
      (depthBands["0.05pct"] as { askDepthUsd: number } | undefined)
        ?.askDepthUsd ?? null,
    imbalance5bp:
      (depthBands["0.05pct"] as { bookImbalance: number | null } | undefined)
        ?.bookImbalance ?? null,
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
    nearestBidWallPrice: topBidWall?.representativePrice ?? null,
    nearestBidWallUsd: topBidWall?.currentNotional ?? null,
    nearestBidWallDistancePct:
      topBidWall && midPrice
        ? (Math.abs(topBidWall.representativePrice - midPrice) / midPrice) * 100
        : null,
    nearestBidWallPersistent: topBidWall?.isPersistent ?? null,
    nearestBidWallAgeMs: topBidWall ? now - topBidWall.lastSeenAt : null,
    nearestBidWallPeakNotional: topBidWall?.peakNotional ?? null,
    nearestAskWallPrice: topAskWall?.representativePrice ?? null,
    nearestAskWallUsd: topAskWall?.currentNotional ?? null,
    nearestAskWallDistancePct:
      topAskWall && midPrice
        ? (Math.abs(topAskWall.representativePrice - midPrice) / midPrice) * 100
        : null,
    nearestAskWallPersistent: topAskWall?.isPersistent ?? null,
    nearestAskWallAgeMs: topAskWall ? now - topAskWall.lastSeenAt : null,
    nearestAskWallPeakNotional: topAskWall?.peakNotional ?? null,
    wallsPulled1m: wallSnapRaw.pulled1mCount,
    orderBookUpdatedAt: depth?.timestamp ?? null,
    orderBookAgeMs: depth ? now - depth.timestamp : null,
  };

  const atrFor = (
    tracker: DirectionalAtrTracker,
    normalAtr: number | null,
    intervalMs: number,
  ): Record<string, unknown> => {
    const down = tracker.getDownAtrAtOrBefore(symbol, now, intervalMs),
      up = tracker.getUpAtrAtOrBefore(symbol, now, intervalMs);
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
  const lastClosedAtOrBefore = (
    interval: "1m" | "3m" | "5m",
  ): number | null => {
    const closed = deps.candleStore.getClosed(symbol, interval);
    let best: number | null = null;
    for (const c of closed)
      if (c.closeTime <= now && (best === null || c.openTime > best))
        best = c.openTime;
    return best;
  };
  const atr = {
    "1m": atrFor(
      deps.directionalAtr1m,
      deps.atrTracker.getWilderATRAtOrBefore(symbol, "1m", 14, now),
      60_000,
    ),
    "3m": atrFor(
      deps.directionalAtr3m,
      deps.atrTracker.getWilderATRAtOrBefore(symbol, "3m", 14, now),
      180_000,
    ),
    "5m": atrFor(
      deps.directionalAtr5m,
      deps.atrTracker.getWilderATRAtOrBefore(symbol, "5m", 14, now),
      300_000,
    ),
    lastClosedCandleTs: {
      "1m": lastClosedAtOrBefore("1m"),
      "3m": lastClosedAtOrBefore("3m"),
      "5m": lastClosedAtOrBefore("5m"),
    },
  };

  const globalRatioRaw = deps.fundingStats.getLongShortRatio(symbol);
  const topPositionRatioRaw = deps.fundingStats.getPositionRatio(symbol);
  // CAUSAL guard: FundingStatsService keeps only ONE cached value per
  // symbol (no history ring -- unlike OI, adding one is out of
  // proportionate scope for a 5-minute-cadence poll, see this file's
  // own final report). Reject rather than use if its own fetchedAt is
  // somehow after `now` (REST response landed in the same instant the
  // liquidation handler ran).
  const globalRatio =
    globalRatioRaw && globalRatioRaw.fetchedAt <= now ? globalRatioRaw : null;
  const topPositionRatio =
    topPositionRatioRaw && topPositionRatioRaw.fetchedAt <= now
      ? topPositionRatioRaw
      : null;
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

  const fundingRateValueRaw = deps.fundingRate.getFundingRate(symbol);
  const fundingFetchedAtRaw = deps.fundingRate.getFundingRateFetchedAt(symbol);
  // Same causal guard as positioning above.
  const fundingIsCausal =
    fundingFetchedAtRaw !== null && fundingFetchedAtRaw <= now;
  const fundingRateValue = fundingIsCausal ? fundingRateValueRaw : null;
  const fundingFetchedAt = fundingIsCausal ? fundingFetchedAtRaw : null;
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
