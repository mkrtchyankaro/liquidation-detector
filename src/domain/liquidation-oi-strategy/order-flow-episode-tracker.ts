import type { Side, Trade } from "../../shared/common.types";
import { childLogger } from "../../infrastructure/logging/logger";
import { cvdUsd, imbalancePct, classifySpotConfirmation, classifyFuturesOiMove, type SpotConfirmationLabel, type FuturesOiMoveLabel } from "./order-flow-interpretation";

const log = childLogger({ mod: "order-flow" });

/**
 * Sep 19 2026 (Karo), operator-requested Spot-vs-Futures order-flow
 * observation.
 *
 * OBSERVATIONAL ONLY -- this class never blocks, delays, rejects, or
 * modifies any trade signal. It exists purely to collect, freeze, and
 * expose Spot/Futures taker flow and OI-delta context alongside the
 * existing liquidation/episode data, for display in the WATCH/ENTRY
 * Telegram signal (see order-flow-interpretation.ts for the pure
 * label functions, and liquidation-oi-runtime-orchestrator.ts for
 * where the frozen stats are read at ENTRY_READY construction).
 *
 * Episode window: driven EXTERNALLY by lifecycle transitions (see
 * onLifecycleTransition below), reusing the EXACT SAME episode
 * boundaries the strategy itself already uses for liquidation totals
 * and OI delta -- this class deliberately never re-derives or
 * re-detects episode start/end on its own. It is a pure OBSERVER of
 * SymbolLifecycle snapshots the orchestrator already has before/after
 * every watchManager.onTick()/onLiquidationEvent() call -- no
 * modification to the pure watch-manager itself.
 *
 * Boundaries, precisely:
 *   - START: a NEW episodeId appears for a symbol (EPISODE_TRACKING
 *     begins). Accumulation begins immediately.
 *   - FREEZE: globalState transitions TO WAIT_FOR_POST_EPISODE_OI_CREATION
 *     (EPISODE_END_CONFIRMED). The accumulated stats as of that exact
 *     moment are snapshotted and become what a later WATCH/ENTRY
 *     Telegram signal reuses, per the operator's own explicit
 *     requirement -- even if the signal is emitted well after this
 *     point.
 *   - RESUME: a provisional-end reopen (globalState goes from
 *     WAIT_FOR_POST_EPISODE_OI_CREATION back to EXHAUSTION_CANDIDATE,
 *     SAME episodeId) un-freezes accumulation -- it CONTINUES adding
 *     to the SAME cumulative totals (never resets), exactly matching
 *     how liquidation totals and OI themselves behave across a
 *     reopen. The next freeze re-snapshots the fuller picture.
 *   - STOP: the episodeId disappears (episode cancelled/released) or
 *     transitions to ACTIVE (entered) -- the accumulator for that
 *     episodeId is torn down. The frozen snapshot, if one was taken,
 *     remains independently readable via getFrozenStats() until that
 *     teardown happens -- ENTRY_READY construction reads it
 *     synchronously, same tick, before ACTIVE is reached.
 *
 * Never mixes data across symbols or episodes: keyed strictly by
 * `${symbol}` (only one episode can be in-flight per symbol at a
 * time in this architecture -- confirmed by SymbolLifecycle's own
 * one-per-symbol Map in liquidation-oi-watch-manager.ts), with the
 * accumulator's own episodeId checked on every trade ingest so a
 * trade that arrives in the brief window between one episode ending
 * and a new one starting for the SAME symbol can never leak in.
 *
 * Bounded: no unlimited history. Only symbols with a currently
 * in-flight (non-frozen) episode accumulate anything at all -- trades
 * for any other symbol, or arriving while frozen, are dropped in O(1)
 * before any allocation.
 */

interface OrderFlowAccumulator {
  episodeId: string;
  symbol: string;
  victim: Side;
  startMs: number;
  frozen: boolean;
  oiStart: number | null;

  spotBuyUsd: number;
  spotSellUsd: number;
  spotVolumeUsd: number;
  spotPriceStart: number | null;
  spotPriceLast: number | null;
  spotSeenIds: Set<number>;

  futuresBuyUsd: number;
  futuresSellUsd: number;
  futuresPriceStart: number;
  futuresPriceLast: number;
  futuresSeenIds: Set<number>;

  frozenSnapshot: OrderFlowFrozenStats | null;
}

export interface OrderFlowFrozenStats {
  symbol: string;
  episodeId: string;
  victim: Side;

  spotDataAvailable: boolean;
  spotTakerBuyUsd: number;
  spotTakerSellUsd: number;
  spotCvdUsd: number;
  spotImbalancePct: number;
  spotPriceStart: number | null;
  spotPriceEnd: number | null;
  spotPriceDeltaPct: number | null;
  spotVolumeUsd: number;
  spotConfirmationLabel: SpotConfirmationLabel;

  futuresTakerBuyUsd: number;
  futuresTakerSellUsd: number;
  futuresCvdUsd: number;
  futuresImbalancePct: number;
  futuresPriceStart: number;
  futuresPriceEnd: number;
  futuresPriceDeltaPct: number;

  oiStart: number | null;
  oiEnd: number | null;
  oiDelta: number | null;
  oiDeltaPct: number | null;
  futuresOiMoveLabel: FuturesOiMoveLabel | null;

  observedLiquidationUsd: number;
  frozenAtMs: number;
}

/** Sep 19 2026 (Karo) -- half-width neutral bands, UNTUNED (no
 *  previously-approved values exist for either). Kept as local
 *  constants here rather than the main strategy config.ts, since
 *  these govern an OBSERVATIONAL label only, never a trade decision
 *  -- deliberately kept out of the strategy's own gating config to
 *  make that separation structurally obvious. */
export const DEFAULT_ORDER_FLOW_CONFIG = {
  spotImbalanceNeutralBandPct: 5,
  oiFlatBandPct: 2,
};

/** The subset of SymbolLifecycle this tracker actually needs -- kept
 *  as a narrow structural type here (rather than importing
 *  SymbolLifecycle itself) so this file has zero dependency on
 *  liquidation-oi-watch-manager.ts's own internals; the orchestrator
 *  passes its real SymbolLifecycle objects, which satisfy this shape
 *  structurally. */
export interface LifecycleSnapshot {
  episodeId: string;
  globalState: string;
  victim: Side;
  startPrice: number;
  startOiQuantity: number | null;
  sameDirectionLiqUsd: number;
  episodeEndPrice: number | null;
  episodeEndOiQuantity: number | null;
}

export class OrderFlowEpisodeTracker {
  private readonly state = new Map<string, OrderFlowAccumulator>();

  constructor(private readonly config = DEFAULT_ORDER_FLOW_CONFIG) {}

  /** Called by the orchestrator with the SymbolLifecycle snapshot
   *  immediately before and after every watchManager.onTick()/
   *  onLiquidationEvent() call -- the SAME before/after pattern
   *  already used for WAIT-doc persistence (see
   *  liquidation-oi-runtime-orchestrator.ts). Pure state-machine
   *  transition detection; never touches watch-manager.ts itself. */
  onLifecycleTransition(symbol: string, before: LifecycleSnapshot | null, after: LifecycleSnapshot | null, nowMs: number): void {
    const existing = this.state.get(symbol);

    // STOP: episode released/cancelled, or a genuinely different
    // episodeId now occupies this symbol -- tear down the old one.
    if (existing !== undefined && (after === null || after.episodeId !== existing.episodeId)) {
      this.state.delete(symbol);
    }

    // START: a new episodeId appears for this symbol.
    if (after !== null && this.state.get(symbol) === undefined) {
      this.state.set(symbol, {
        episodeId: after.episodeId, symbol, victim: after.victim, startMs: nowMs, frozen: false,
        oiStart: after.startOiQuantity,
        spotBuyUsd: 0, spotSellUsd: 0, spotVolumeUsd: 0, spotPriceStart: null, spotPriceLast: null, spotSeenIds: new Set(),
        futuresBuyUsd: 0, futuresSellUsd: 0, futuresPriceStart: after.startPrice, futuresPriceLast: after.startPrice, futuresSeenIds: new Set(),
        frozenSnapshot: null,
      });
    }

    const acc = this.state.get(symbol);
    if (acc === undefined || after === null) return;

    // FREEZE: reached WAIT_FOR_POST_EPISODE_OI_CREATION.
    if (after.globalState === "WAIT_FOR_POST_EPISODE_OI_CREATION" && (before === null || before.globalState !== "WAIT_FOR_POST_EPISODE_OI_CREATION")) {
      acc.frozen = true;
      acc.frozenSnapshot = this.buildSnapshot(acc, after.episodeEndPrice, after.episodeEndOiQuantity, after.sameDirectionLiqUsd, nowMs);
      return;
    }

    // RESUME: provisional-end reopen, same episodeId.
    if (before !== null && before.globalState === "WAIT_FOR_POST_EPISODE_OI_CREATION" && after.globalState !== "WAIT_FOR_POST_EPISODE_OI_CREATION") {
      acc.frozen = false;
      acc.frozenSnapshot = null;
    }
  }

  /** Ingest one Binance Spot aggTrade. Dropped in O(1) if the symbol
   *  has no in-flight, non-frozen episode -- bounded by construction,
   *  never accumulates for a symbol with nothing active. */
  ingestSpotTrade(trade: Trade): void {
    const acc = this.state.get(trade.symbol);
    if (acc === undefined || acc.frozen) return;
    if (trade.aggTradeId !== undefined) {
      if (acc.spotSeenIds.has(trade.aggTradeId)) return;
      acc.spotSeenIds.add(trade.aggTradeId);
    }
    if (acc.spotPriceStart === null) acc.spotPriceStart = trade.price;
    acc.spotPriceLast = trade.price;
    acc.spotVolumeUsd += trade.quoteQty;
    if (trade.aggressor === "BUY") acc.spotBuyUsd += trade.quoteQty;
    else acc.spotSellUsd += trade.quoteQty;
  }

  /** Ingest one Binance Futures aggTrade (the SAME stream already
   *  feeding AggressiveFlowService -- this is an ADDITIONAL consumer
   *  of that same event, not a new subscription). */
  ingestFuturesTrade(trade: Trade): void {
    const acc = this.state.get(trade.symbol);
    if (acc === undefined || acc.frozen) return;
    if (trade.aggTradeId !== undefined) {
      if (acc.futuresSeenIds.has(trade.aggTradeId)) return;
      acc.futuresSeenIds.add(trade.aggTradeId);
    }
    acc.futuresPriceLast = trade.price;
    if (trade.aggressor === "BUY") acc.futuresBuyUsd += trade.quoteQty;
    else acc.futuresSellUsd += trade.quoteQty;
  }

  /** Read the most recently frozen snapshot for a symbol's CURRENT
   *  episode (checked by episodeId, so a stale snapshot from an
   *  already-released episode can never be returned). */
  getFrozenStats(symbol: string, episodeId: string): OrderFlowFrozenStats | null {
    const acc = this.state.get(symbol);
    if (acc === undefined || acc.episodeId !== episodeId) return null;
    return acc.frozenSnapshot;
  }

  private buildSnapshot(acc: OrderFlowAccumulator, futuresPriceEnd: number | null, oiEnd: number | null, observedLiquidationUsd: number, nowMs: number): OrderFlowFrozenStats {
    const spotDataAvailable = acc.spotPriceStart !== null && acc.spotVolumeUsd > 0;
    const spotPriceEnd = acc.spotPriceLast;
    const spotPriceDeltaPct = spotDataAvailable && acc.spotPriceStart !== null && spotPriceEnd !== null && acc.spotPriceStart > 0
      ? ((spotPriceEnd - acc.spotPriceStart) / acc.spotPriceStart) * 100 : null;
    const spotImbalance = spotDataAvailable ? imbalancePct(acc.spotBuyUsd, acc.spotSellUsd) : 0;

    const resolvedFuturesPriceEnd = futuresPriceEnd ?? acc.futuresPriceLast;
    const futuresPriceDeltaPct = acc.futuresPriceStart > 0 ? ((resolvedFuturesPriceEnd - acc.futuresPriceStart) / acc.futuresPriceStart) * 100 : 0;

    const oiDelta = acc.oiStart !== null && oiEnd !== null ? oiEnd - acc.oiStart : null;
    const oiDeltaPct = oiDelta !== null && acc.oiStart !== null && acc.oiStart > 0 ? (oiDelta / acc.oiStart) * 100 : null;

    const candidateSide = acc.victim; // same identity mapping used throughout this strategy
    const spotConfirmationLabel = classifySpotConfirmation(candidateSide, spotImbalance, this.config.spotImbalanceNeutralBandPct, spotDataAvailable);
    const futuresOiMoveLabel = classifyFuturesOiMove(candidateSide, futuresPriceDeltaPct, oiDeltaPct, this.config.oiFlatBandPct);

    const snapshot: OrderFlowFrozenStats = {
      symbol: acc.symbol, episodeId: acc.episodeId, victim: acc.victim,
      spotDataAvailable,
      spotTakerBuyUsd: acc.spotBuyUsd, spotTakerSellUsd: acc.spotSellUsd, spotCvdUsd: cvdUsd(acc.spotBuyUsd, acc.spotSellUsd),
      spotImbalancePct: spotImbalance, spotPriceStart: acc.spotPriceStart, spotPriceEnd, spotPriceDeltaPct, spotVolumeUsd: acc.spotVolumeUsd,
      spotConfirmationLabel,
      futuresTakerBuyUsd: acc.futuresBuyUsd, futuresTakerSellUsd: acc.futuresSellUsd, futuresCvdUsd: cvdUsd(acc.futuresBuyUsd, acc.futuresSellUsd),
      futuresImbalancePct: imbalancePct(acc.futuresBuyUsd, acc.futuresSellUsd),
      futuresPriceStart: acc.futuresPriceStart, futuresPriceEnd: resolvedFuturesPriceEnd, futuresPriceDeltaPct,
      oiStart: acc.oiStart, oiEnd, oiDelta, oiDeltaPct, futuresOiMoveLabel,
      observedLiquidationUsd, frozenAtMs: nowMs,
    };

    log.info({ ...snapshot }, `[ORDER_FLOW_FROZEN] ${acc.symbol} episodeId=${acc.episodeId}`);
    return snapshot;
  }
}
