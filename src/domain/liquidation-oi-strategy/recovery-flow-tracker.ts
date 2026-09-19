import type { Side, Trade } from "../../shared/common.types";
import { childLogger } from "../../infrastructure/logging/logger";
import { cvdUsd, imbalancePct, classifySpotConfirmation, classifyRecoveryOiMove, type SpotConfirmationLabel, type RecoveryOiMoveLabel } from "./order-flow-interpretation";

const log = childLogger({ mod: "recovery-flow" });

/**
 * Sep 19 2026 (Karo), operator-requested Recovery Flow.
 *
 * SUPERSEDES the earlier "Episode Flow" feature (order-flow-episode-
 * tracker.ts) -- this measures a much NARROWER, more precise window:
 *
 *   recoveryStartAt = the FINAL extreme's own timestamp (never the
 *                      episode's own start, never the last liquidation
 *                      event -- reuses episodeMaxAdverseExtreme, the
 *                      SAME field structural-SL already uses as "the
 *                      true worst price ever seen", so this never
 *                      creates a second, conflicting definition of
 *                      extreme)
 *   recoveryEndAt   = the exact moment the existing causal 1m/3m
 *                      candle logic confirms EPISODE_END_CONFIRMED
 *                      (episodeEndTime) -- the SAME timestamp
 *                      structural SL/TP and WAIT's own OI/price
 *                      baseline already freeze from
 *
 * OBSERVATIONAL ONLY -- never blocks, delays, rejects, or modifies
 * any trade signal, SL, TP, cancellation, or entry timing.
 *
 * Implementation strategy (per the operator's own explicit
 * instruction): bounded, timestamped ROLLING BUFFERS of Spot trades,
 * Futures trades, and OI samples per symbol (NOT an incremental
 * accumulator) -- the exact recovery window is sliced RETROSPECTIVELY
 * out of these buffers at the moment confirmation occurs. This is
 * what correctly handles the extreme being replaced multiple times
 * before confirmation: whichever recoveryExtremeAt is current at
 * confirmation time is used to slice the buffer, so flow from BEFORE
 * the final (replaced) extreme is naturally excluded without needing
 * any incremental reset-and-rebuild logic.
 *
 * Extreme tracking: this class does NOT re-detect extremes itself.
 * It observes episodeMaxAdverseExtreme (via the same before/after
 * SymbolLifecycle snapshot pattern order-flow-episode-tracker.ts
 * already established) and simply records nowMs as recoveryExtremeAt
 * whenever that value changes -- reusing the exact same "final
 * extreme" the strategy's own SL calculation already relies on.
 *
 * Buffers are bounded by MAX_BUFFER_MS (time-pruned on every ingest)
 * and only exist for symbols with a currently in-flight, unconfirmed
 * episode -- dropped entirely once that episode ends (confirmed,
 * cancelled, or entered), so nothing leaks into the next setup.
 */

const MAX_BUFFER_MS = 30 * 60_000; // UNTUNED -- generous margin beyond any realistic recovery window (1m/3m candle confirmation)
const RECOVERY_OI_MAX_STALENESS_MS = 60_000; // UNTUNED -- "nearest valid OI sample" must be within this of the target timestamp, else N/A

interface TradeBufferEntry {
  ts: number;
  price: number;
  quoteQty: number;
  aggressor: "BUY" | "SELL";
}

interface OiBufferEntry {
  contracts: number;
  fetchedAt: number;
}

interface SymbolRecoveryState {
  episodeId: string;
  symbol: string;
  victim: Side;
  recoveryExtremePrice: number;
  recoveryExtremeAt: number;

  futuresBuffer: TradeBufferEntry[];
  futuresSeenIds: Set<number>;
  spotBuffer: TradeBufferEntry[];
  spotSeenIds: Set<number>;
  oiBuffer: OiBufferEntry[];

  frozenSnapshot: RecoveryFlowFrozenStats | null;
}

export interface RecoveryFlowFrozenStats {
  symbol: string;
  episodeId: string;
  victim: Side;

  recoveryStartAt: number;
  recoveryEndAt: number;
  recoveryDurationMs: number;
  recoveryExtremePrice: number;
  recoveryConfirmationPrice: number;
  recoveryMoveAtr: number | null;

  spotDataAvailable: boolean;
  recoverySpotTakerBuyUsd: number;
  recoverySpotTakerSellUsd: number;
  recoverySpotCvdUsd: number;
  recoverySpotImbalancePct: number;
  recoverySpotPriceDeltaPct: number | null;
  recoverySpotVolumeUsd: number;
  spotConfirmationLabel: SpotConfirmationLabel;

  recoveryFuturesTakerBuyUsd: number;
  recoveryFuturesTakerSellUsd: number;
  recoveryFuturesCvdUsd: number;
  recoveryFuturesImbalancePct: number;
  recoveryFuturesPriceDeltaPct: number;

  oiDataAvailable: boolean;
  recoveryOiStart: number | null;
  recoveryOiEnd: number | null;
  recoveryOiDelta: number | null;
  recoveryOiDeltaPct: number | null;
  recoveryOiMoveLabel: RecoveryOiMoveLabel | null;

  frozenAtMs: number;
}

/** The subset of SymbolLifecycle this tracker needs. Kept narrow and
 *  structural (no import of SymbolLifecycle itself), same pattern as
 *  order-flow-episode-tracker.ts's own LifecycleSnapshot. */
export interface RecoveryLifecycleSnapshot {
  episodeId: string;
  globalState: string;
  victim: Side;
  episodeMaxAdverseExtreme: number;
  episodeEndPrice: number | null;
  episodeEndTime: number | null;
}

export const DEFAULT_RECOVERY_FLOW_CONFIG = {
  spotImbalanceNeutralBandPct: 5,
  oiFlatBandPct: 2,
};

export class RecoveryFlowTracker {
  private readonly state = new Map<string, SymbolRecoveryState>();

  constructor(private readonly config = DEFAULT_RECOVERY_FLOW_CONFIG) {}

  onLifecycleTransition(symbol: string, before: RecoveryLifecycleSnapshot | null, after: RecoveryLifecycleSnapshot | null, nowMs: number): void {
    const existing = this.state.get(symbol);

    if (existing !== undefined && (after === null || after.episodeId !== existing.episodeId)) {
      this.state.delete(symbol);
    }

    if (after !== null && this.state.get(symbol) === undefined) {
      this.state.set(symbol, {
        episodeId: after.episodeId, symbol, victim: after.victim,
        recoveryExtremePrice: after.episodeMaxAdverseExtreme, recoveryExtremeAt: nowMs,
        futuresBuffer: [], futuresSeenIds: new Set(),
        spotBuffer: [], spotSeenIds: new Set(),
        oiBuffer: [],
        frozenSnapshot: null,
      });
    }

    const s = this.state.get(symbol);
    if (s === undefined || after === null) return;

    if (after.episodeMaxAdverseExtreme !== s.recoveryExtremePrice) {
      s.recoveryExtremePrice = after.episodeMaxAdverseExtreme;
      s.recoveryExtremeAt = nowMs;
    }

    if (after.globalState === "WAIT_FOR_POST_EPISODE_OI_CREATION" && (before === null || before.globalState !== "WAIT_FOR_POST_EPISODE_OI_CREATION")) {
      s.frozenSnapshot = this.buildSnapshot(s, after.episodeEndPrice ?? after.episodeMaxAdverseExtreme, after.episodeEndTime ?? nowMs, nowMs);
    }
  }

  ingestFuturesTrade(trade: Trade): void {
    const s = this.state.get(trade.symbol);
    if (s === undefined) return;
    if (trade.aggTradeId !== undefined) {
      if (s.futuresSeenIds.has(trade.aggTradeId)) return;
      s.futuresSeenIds.add(trade.aggTradeId);
    }
    s.futuresBuffer.push({ ts: trade.timestamp, price: trade.price, quoteQty: trade.quoteQty, aggressor: trade.aggressor });
    this.pruneTradeBuffer(s.futuresBuffer, trade.timestamp);
  }

  ingestSpotTrade(trade: Trade): void {
    const s = this.state.get(trade.symbol);
    if (s === undefined) return;
    if (trade.aggTradeId !== undefined) {
      if (s.spotSeenIds.has(trade.aggTradeId)) return;
      s.spotSeenIds.add(trade.aggTradeId);
    }
    s.spotBuffer.push({ ts: trade.timestamp, price: trade.price, quoteQty: trade.quoteQty, aggressor: trade.aggressor });
    this.pruneTradeBuffer(s.spotBuffer, trade.timestamp);
  }

  /** Ingest OI samples -- the SAME oiHistory slice already passed into
   *  watchManager.onTick() every tick; no new OI polling. */
  ingestOiSamples(symbol: string, samples: readonly { contracts: number; fetchedAt: number }[], nowMs: number): void {
    const s = this.state.get(symbol);
    if (s === undefined || samples.length === 0) return;
    for (const sample of samples) s.oiBuffer.push({ contracts: sample.contracts, fetchedAt: sample.fetchedAt });
    const cutoff = nowMs - MAX_BUFFER_MS;
    while (s.oiBuffer.length > 0 && s.oiBuffer[0]!.fetchedAt < cutoff) s.oiBuffer.shift();
  }

  getFrozenStats(symbol: string, episodeId: string): RecoveryFlowFrozenStats | null {
    const s = this.state.get(symbol);
    if (s === undefined || s.episodeId !== episodeId) return null;
    return s.frozenSnapshot;
  }

  private pruneTradeBuffer(buf: TradeBufferEntry[], nowMs: number): void {
    const cutoff = nowMs - MAX_BUFFER_MS;
    while (buf.length > 0 && buf[0]!.ts < cutoff) buf.shift();
  }

  private nearestOiSample(buf: OiBufferEntry[], targetTs: number): OiBufferEntry | null {
    let best: OiBufferEntry | null = null;
    let bestDelta = Infinity;
    for (const sample of buf) {
      const delta = Math.abs(sample.fetchedAt - targetTs);
      if (delta < bestDelta) { bestDelta = delta; best = sample; }
    }
    if (best === null || bestDelta > RECOVERY_OI_MAX_STALENESS_MS) return null;
    return best;
  }

  private buildSnapshot(s: SymbolRecoveryState, confirmationPrice: number, recoveryEndAt: number, frozenAtMs: number): RecoveryFlowFrozenStats {
    const recoveryStartAt = s.recoveryExtremeAt;
    const recoveryDurationMs = Math.max(0, recoveryEndAt - recoveryStartAt);
    const inWindow = (e: TradeBufferEntry): boolean => e.ts >= recoveryStartAt && e.ts <= recoveryEndAt;

    const futuresInWindow = s.futuresBuffer.filter(inWindow);
    const futuresBuyUsd = futuresInWindow.filter((e) => e.aggressor === "BUY").reduce((a, e) => a + e.quoteQty, 0);
    const futuresSellUsd = futuresInWindow.filter((e) => e.aggressor === "SELL").reduce((a, e) => a + e.quoteQty, 0);
    const futuresPriceDeltaPct = s.recoveryExtremePrice > 0 ? ((confirmationPrice - s.recoveryExtremePrice) / s.recoveryExtremePrice) * 100 : 0;

    const spotInWindow = s.spotBuffer.filter(inWindow);
    const spotDataAvailable = spotInWindow.length > 0;
    const spotBuyUsd = spotInWindow.filter((e) => e.aggressor === "BUY").reduce((a, e) => a + e.quoteQty, 0);
    const spotSellUsd = spotInWindow.filter((e) => e.aggressor === "SELL").reduce((a, e) => a + e.quoteQty, 0);
    const spotVolumeUsd = spotBuyUsd + spotSellUsd;
    const spotImbalance = spotDataAvailable ? imbalancePct(spotBuyUsd, spotSellUsd) : 0;
    const spotPriceStart = spotDataAvailable ? spotInWindow[0]!.price : null;
    const spotPriceEnd = spotDataAvailable ? spotInWindow[spotInWindow.length - 1]!.price : null;
    const spotPriceDeltaPct = spotPriceStart !== null && spotPriceEnd !== null && spotPriceStart > 0
      ? ((spotPriceEnd - spotPriceStart) / spotPriceStart) * 100 : null;

    const oiStartSample = this.nearestOiSample(s.oiBuffer, recoveryStartAt);
    const oiEndSample = this.nearestOiSample(s.oiBuffer, recoveryEndAt);
    const oiDataAvailable = oiStartSample !== null && oiEndSample !== null;
    const oiStart = oiStartSample?.contracts ?? null;
    const oiEnd = oiEndSample?.contracts ?? null;
    const oiDelta = oiDataAvailable ? oiEnd! - oiStart! : null;
    const oiDeltaPct = oiDataAvailable && oiStart !== 0 ? (oiDelta! / oiStart!) * 100 : (oiDataAvailable ? 0 : null);

    const candidateSide = s.victim;
    const spotConfirmationLabel = classifySpotConfirmation(candidateSide, spotImbalance, this.config.spotImbalanceNeutralBandPct, spotDataAvailable);
    const recoveryOiMoveLabel = classifyRecoveryOiMove(candidateSide, oiDeltaPct, this.config.oiFlatBandPct);

    const snapshot: RecoveryFlowFrozenStats = {
      symbol: s.symbol, episodeId: s.episodeId, victim: s.victim,
      recoveryStartAt, recoveryEndAt, recoveryDurationMs,
      recoveryExtremePrice: s.recoveryExtremePrice, recoveryConfirmationPrice: confirmationPrice,
      recoveryMoveAtr: null,
      spotDataAvailable,
      recoverySpotTakerBuyUsd: spotBuyUsd, recoverySpotTakerSellUsd: spotSellUsd, recoverySpotCvdUsd: cvdUsd(spotBuyUsd, spotSellUsd),
      recoverySpotImbalancePct: spotImbalance, recoverySpotPriceDeltaPct: spotPriceDeltaPct, recoverySpotVolumeUsd: spotVolumeUsd,
      spotConfirmationLabel,
      recoveryFuturesTakerBuyUsd: futuresBuyUsd, recoveryFuturesTakerSellUsd: futuresSellUsd, recoveryFuturesCvdUsd: cvdUsd(futuresBuyUsd, futuresSellUsd),
      recoveryFuturesImbalancePct: imbalancePct(futuresBuyUsd, futuresSellUsd), recoveryFuturesPriceDeltaPct: futuresPriceDeltaPct,
      oiDataAvailable, recoveryOiStart: oiStart, recoveryOiEnd: oiEnd, recoveryOiDelta: oiDelta, recoveryOiDeltaPct: oiDeltaPct, recoveryOiMoveLabel,
      frozenAtMs,
    };

    log.info({ ...snapshot }, `[RECOVERY_FLOW_FROZEN] ${s.symbol} episodeId=${s.episodeId}`);
    return snapshot;
  }
}
