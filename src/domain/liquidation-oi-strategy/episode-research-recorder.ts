import type { Side, Trade } from "../../shared/common.types";
import { childLogger } from "../../infrastructure/logging/logger";
import { cvdUsd } from "./order-flow-interpretation";
import type { MarketSnapshotCache, BasisSnapshot } from "./market-snapshot-cache";

const log = childLogger({ mod: "episode-research" });

/**
 * Sep 19 2026 (Karo), operator-requested Episode Research capture.
 *
 * OBSERVATIONAL / RESEARCH ONLY -- collects, computes, and persists
 * (via EpisodeResearchRepository) a comprehensive Spot+Futures data
 * record for EVERY liquidation episode, whether it produces an entry
 * or not (timeout, invalidation, or any other end reason). NOTHING
 * here reads back into entry, cancellation, SL, TP, or any existing
 * strategy decision -- this module is a pure OBSERVER, driven
 * entirely by the SAME before/after SymbolLifecycle snapshot pattern
 * already established for RecoveryFlowTracker, PLUS direct hooks on
 * liquidation events (for the per-event chain) and episode-termination
 * (for the no-entry case).
 *
 * Two distinct windows (NOT the same as RecoveryFlowTracker's own
 * "Recovery Flow" Telegram feature, which measures a narrower,
 * confirmation-only window):
 *
 *   FLUSH FLOW    = [episodeStartTs, finalExtremeTs]
 *   RECOVERY FLOW = [finalExtremeTs, confirmedEntryTs OR episodeEndTs]
 *
 * Both windows are computed RETROSPECTIVELY from bounded, timestamped
 * Spot/Futures trade buffers -- the final extreme (both windows'
 * pivot point) can move forward multiple times before the episode
 * ends, and retrospective slicing correctly handles that. If a new
 * extreme appears AFTER Recovery Flow was already computed once (a
 * reopen), the old computation is pushed into recoveryFlowHistory and
 * a fresh one starts from the new extreme.
 *
 * Liquidation notional is NEVER added into Futures taker sell/buy
 * volume a second time -- the two are structurally separate counters
 * fed by two different sources (the liquidation stream itself vs.
 * Futures aggTrade).
 */

export interface OiPointSnapshot {
  oiTimestamp: number;
  oiAgeMs: number;
  oiValue: number;
  oiNotionalUsd: number | null;
}

export interface MarketPointSnapshot extends BasisSnapshot {
  ts: number;
}

export interface LiquidationEventSnapshot {
  eventTs: number;
  symbol: string;
  side: Side;
  quantity: number;
  notionalUsd: number;
  price: number;
  market: MarketPointSnapshot;
  isNewExtreme: boolean;
  cumulativeLiqUsd: number;
  oi: OiPointSnapshot | null;
}

export interface ExtremeSnapshot {
  ts: number;
  price: number;
  market: MarketPointSnapshot;
  oi: OiPointSnapshot | null;
}

export interface FlowWindowStats {
  startAt: number;
  endAt: number;
  durationMs: number;
  futuresBuyUsd: number;
  futuresSellUsd: number;
  futuresDelta: number;
  futuresBuySellRatio: number | null;
  spotBuyUsd: number;
  spotSellUsd: number;
  spotDelta: number;
  spotBuySellRatio: number | null;
  spotDataAvailable: boolean;
  oiStart: OiPointSnapshot | null;
  oiEnd: OiPointSnapshot | null;
  oiDeltaUsd: number | null;
  oiDeltaPct: number | null;
  spotPriceStart: number | null;
  spotPriceEnd: number | null;
  spotPriceChangePct: number | null;
  futuresPriceStart: number;
  futuresPriceEnd: number;
  futuresPriceChangePct: number;
  basisStartBps: number | null;
  basisEndBps: number | null;
  basisChangeBps: number | null;
  totalObservedLiquidationUsd: number;
  eventCount: number;
  extremeCount: number;
}

export type ConvergenceDirection = "FUTURES_TOWARD_SPOT" | "SPOT_TOWARD_FUTURES" | "BOTH" | "DIVERGENCE" | "INSUFFICIENT_DATA";

export interface BasisRecoveryStats {
  basisAtExtremeUsd: number | null;
  basisAtExtremeBps: number | null;
  basisAtEntryOrEndUsd: number | null;
  basisAtEntryOrEndBps: number | null;
  basisClosedUsd: number | null;
  basisClosedPct: number | null;
  futuresPriceContributionUsd: number | null;
  spotPriceContributionUsd: number | null;
  futuresContributionPct: number | null;
  spotContributionPct: number | null;
  spotHeldAfterExtreme: boolean | null;
  spotMadeNewExtreme: boolean | null;
  futuresMadeRecovery: boolean | null;
  convergenceDirection: ConvergenceDirection;
}

export interface EpisodeResearchRecord {
  episodeId: string;
  symbol: string;
  victim: Side;

  episodeStartSnapshot: { ts: number; price: number; market: MarketPointSnapshot; oi: OiPointSnapshot | null };
  liquidationEventSnapshots: LiquidationEventSnapshot[];
  extremeSnapshots: ExtremeSnapshot[];
  finalExtremeSnapshot: ExtremeSnapshot | null;
  lastLiquidationEventSnapshot: LiquidationEventSnapshot | null;
  episodeEndSnapshot: { ts: number; price: number; market: MarketPointSnapshot; oi: OiPointSnapshot | null } | null;
  entrySnapshot: { ts: number; price: number; market: MarketPointSnapshot; oi: OiPointSnapshot | null } | null;
  endReason: string | null;

  flushFlow: FlowWindowStats | null;
  recoveryFlow: FlowWindowStats | null;
  recoveryFlowHistory: FlowWindowStats[];
  basisRecovery: BasisRecoveryStats | null;

  entryReason: string | null;
  noEntryReason: string | null;

  createdAtMs: number;
  updatedAtMs: number;
}

const MAX_BUFFER_MS = 90 * 60_000; // UNTUNED -- generous (covers even a very slow-building episode); see report for the memory/coverage tradeoff
const OI_MAX_STALENESS_MS = 60_000; // UNTUNED -- same staleness bound as RecoveryFlowTracker

interface TradeBufferEntry { ts: number; price: number; quoteQty: number; aggressor: "BUY" | "SELL"; }
interface OiBufferEntry { contracts: number; fetchedAt: number; }

interface SymbolResearchState {
  record: EpisodeResearchRecord;
  extremeAt: number;
  extremePrice: number;
  recoveryFrozen: boolean;
  futuresBuffer: TradeBufferEntry[];
  futuresSeenIds: Set<number>;
  spotBuffer: TradeBufferEntry[];
  spotSeenIds: Set<number>;
  oiBuffer: OiBufferEntry[];
}

export interface ResearchLifecycleSnapshot {
  episodeId: string;
  globalState: string;
  victim: Side;
  episodeMaxAdverseExtreme: number;
  episodeEndPrice: number | null;
  episodeEndTime: number | null;
  episodeStartPrice: number;
  episodeStartOiQuantity: number | null;
  sameDirectionLiqUsd: number;
}

export class EpisodeResearchRecorder {
  private readonly state = new Map<string, SymbolResearchState>();

  constructor(private readonly market: MarketSnapshotCache) {}

  ingestFuturesTrade(trade: Trade): void {
    const s = this.state.get(trade.symbol);
    if (s === undefined) return;
    if (trade.aggTradeId !== undefined) {
      if (s.futuresSeenIds.has(trade.aggTradeId)) return;
      s.futuresSeenIds.add(trade.aggTradeId);
    }
    s.futuresBuffer.push({ ts: trade.timestamp, price: trade.price, quoteQty: trade.quoteQty, aggressor: trade.aggressor });
    this.prune(s.futuresBuffer, trade.timestamp);
  }

  ingestSpotTrade(trade: Trade): void {
    const s = this.state.get(trade.symbol);
    if (s === undefined) return;
    if (trade.aggTradeId !== undefined) {
      if (s.spotSeenIds.has(trade.aggTradeId)) return;
      s.spotSeenIds.add(trade.aggTradeId);
    }
    s.spotBuffer.push({ ts: trade.timestamp, price: trade.price, quoteQty: trade.quoteQty, aggressor: trade.aggressor });
    this.prune(s.spotBuffer, trade.timestamp);
  }

  ingestOiSamples(symbol: string, samples: readonly { contracts: number; fetchedAt: number }[], nowMs: number): void {
    const s = this.state.get(symbol);
    if (s === undefined || samples.length === 0) return;
    for (const sample of samples) s.oiBuffer.push({ contracts: sample.contracts, fetchedAt: sample.fetchedAt });
    const cutoff = nowMs - MAX_BUFFER_MS;
    while (s.oiBuffer.length > 0 && s.oiBuffer[0]!.fetchedAt < cutoff) s.oiBuffer.shift();
  }

  private prune(buf: TradeBufferEntry[], nowMs: number): void {
    const cutoff = nowMs - MAX_BUFFER_MS;
    while (buf.length > 0 && buf[0]!.ts < cutoff) buf.shift();
  }

  private nearestOi(buf: OiBufferEntry[], targetTs: number): OiPointSnapshot | null {
    let best: OiBufferEntry | null = null;
    let bestDelta = Infinity;
    for (const sample of buf) {
      const delta = Math.abs(sample.fetchedAt - targetTs);
      if (delta < bestDelta) { bestDelta = delta; best = sample; }
    }
    if (best === null || bestDelta > OI_MAX_STALENESS_MS) return null;
    return { oiTimestamp: best.fetchedAt, oiAgeMs: bestDelta, oiValue: best.contracts, oiNotionalUsd: null };
  }

  private pointSnapshot(symbol: string, ts: number, price: number): { market: MarketPointSnapshot; oi: OiPointSnapshot | null } {
    const s = this.state.get(symbol);
    const market: MarketPointSnapshot = { ts, ...this.market.getBasisSnapshot(symbol, ts) };
    const oiRaw = s !== undefined ? this.nearestOi(s.oiBuffer, ts) : null;
    const oi = oiRaw !== null ? { ...oiRaw, oiNotionalUsd: oiRaw.oiValue * price } : null;
    return { market, oi };
  }

  onLifecycleTransition(symbol: string, before: ResearchLifecycleSnapshot | null, after: ResearchLifecycleSnapshot | null, nowMs: number): void {
    if (after !== null && (before === null || before.episodeId !== after.episodeId) && !this.state.has(symbol)) {
      const startSnap = this.pointSnapshot(symbol, nowMs, after.episodeStartPrice);
      const record: EpisodeResearchRecord = {
        episodeId: after.episodeId, symbol, victim: after.victim,
        episodeStartSnapshot: { ts: nowMs, price: after.episodeStartPrice, ...startSnap },
        liquidationEventSnapshots: [], extremeSnapshots: [], finalExtremeSnapshot: null, lastLiquidationEventSnapshot: null,
        episodeEndSnapshot: null, entrySnapshot: null, endReason: null,
        flushFlow: null, recoveryFlow: null, recoveryFlowHistory: [], basisRecovery: null,
        entryReason: null, noEntryReason: null,
        createdAtMs: nowMs, updatedAtMs: nowMs,
      };
      this.state.set(symbol, {
        record, extremeAt: nowMs, extremePrice: after.episodeStartPrice, recoveryFrozen: false,
        futuresBuffer: [], futuresSeenIds: new Set(), spotBuffer: [], spotSeenIds: new Set(), oiBuffer: [],
      });
    }

    const s = this.state.get(symbol);
    if (s === undefined || after === null) return;

    if (after.episodeMaxAdverseExtreme !== s.extremePrice) {
      s.extremePrice = after.episodeMaxAdverseExtreme;
      s.extremeAt = nowMs;
      s.recoveryFrozen = false;
      const snap = this.pointSnapshot(symbol, nowMs, after.episodeMaxAdverseExtreme);
      const extremeSnapshot: ExtremeSnapshot = { ts: nowMs, price: after.episodeMaxAdverseExtreme, ...snap };
      s.record.extremeSnapshots.push(extremeSnapshot);
      s.record.finalExtremeSnapshot = extremeSnapshot;
      s.record.updatedAtMs = nowMs;
    }

    if (after.globalState === "WAIT_FOR_POST_EPISODE_OI_CREATION" && (before === null || before.globalState !== "WAIT_FOR_POST_EPISODE_OI_CREATION")) {
      const endPrice = after.episodeEndPrice ?? after.episodeMaxAdverseExtreme;
      const endTs = after.episodeEndTime ?? nowMs;
      const snap = this.pointSnapshot(symbol, endTs, endPrice);
      s.record.episodeEndSnapshot = { ts: endTs, price: endPrice, ...snap };
      s.record.updatedAtMs = nowMs;
      this.computeFlushFlow(s);
      this.computeRecoveryFlow(s, endTs, endPrice, false);
    }
  }

  onLiquidationEvent(symbol: string, eventTs: number, side: Side, quantity: number, notionalUsd: number, price: number, cumulativeLiqUsd: number, isNewExtreme: boolean): void {
    const s = this.state.get(symbol);
    if (s === undefined) return;
    const snap = this.pointSnapshot(symbol, eventTs, price);
    const eventSnapshot: LiquidationEventSnapshot = {
      eventTs, symbol, side, quantity, notionalUsd, price, ...snap, isNewExtreme, cumulativeLiqUsd,
    };
    s.record.liquidationEventSnapshots.push(eventSnapshot);
    s.record.lastLiquidationEventSnapshot = eventSnapshot;
    s.record.updatedAtMs = eventTs;
  }

  onEntry(symbol: string, entryTs: number, entryPrice: number, entryReason: string): void {
    const s = this.state.get(symbol);
    if (s === undefined) return;
    const snap = this.pointSnapshot(symbol, entryTs, entryPrice);
    s.record.entrySnapshot = { ts: entryTs, price: entryPrice, ...snap };
    s.record.entryReason = entryReason;
    s.record.updatedAtMs = entryTs;
    this.computeRecoveryFlow(s, entryTs, entryPrice, true);
    this.computeBasisRecovery(s, s.record.entrySnapshot);
    log.info({ episodeId: s.record.episodeId, symbol, entryReason, eventCount: s.record.liquidationEventSnapshots.length, extremeCount: s.record.extremeSnapshots.length }, `[EPISODE_RESEARCH_ENTRY] ${symbol} episodeId=${s.record.episodeId}`);
  }

  onEpisodeTerminal(symbol: string, endTs: number, reason: string): EpisodeResearchRecord | null {
    const s = this.state.get(symbol);
    if (s === undefined) return null;
    s.record.endReason = reason;
    s.record.noEntryReason = s.record.entrySnapshot === null ? reason : null;
    s.record.updatedAtMs = endTs;
    if (s.record.flushFlow === null) this.computeFlushFlow(s);
    if (s.record.entrySnapshot === null) {
      const endPrice = s.record.episodeEndSnapshot?.price ?? s.extremePrice;
      this.computeRecoveryFlow(s, endTs, endPrice, true);
      const endSnap = s.record.episodeEndSnapshot ?? { ts: endTs, price: endPrice, ...this.pointSnapshot(symbol, endTs, endPrice) };
      this.computeBasisRecovery(s, endSnap);
    }
    log.info({ episodeId: s.record.episodeId, symbol, reason, noEntry: s.record.entrySnapshot === null, eventCount: s.record.liquidationEventSnapshots.length, extremeCount: s.record.extremeSnapshots.length }, `[EPISODE_RESEARCH_TERMINAL] ${symbol} episodeId=${s.record.episodeId}`);
    return s.record;
  }

  getRecord(symbol: string, episodeId: string): EpisodeResearchRecord | null {
    const s = this.state.get(symbol);
    if (s === undefined || s.record.episodeId !== episodeId) return null;
    return s.record;
  }

  clear(symbol: string): void {
    this.state.delete(symbol);
  }

  private computeFlushFlow(s: SymbolResearchState): void {
    const startAt = s.record.episodeStartSnapshot.ts;
    const endAt = s.extremeAt;
    const flush = this.buildFlowWindow(s, startAt, endAt, s.record.episodeStartSnapshot.price, s.extremePrice, s.record.liquidationEventSnapshots.reduce((a, e) => a + e.notionalUsd, 0), s.record.liquidationEventSnapshots.length, s.record.extremeSnapshots.length);
    s.record.flushFlow = flush;
  }

  private computeRecoveryFlow(s: SymbolResearchState, endAt: number, endPrice: number, freeze: boolean): void {
    if (s.recoveryFrozen) return;
    const startAt = s.extremeAt;
    const recovery = this.buildFlowWindow(s, startAt, endAt, s.extremePrice, endPrice, 0, 0, 0);
    // Sep 19 2026 (Karo), operator-reported CRITICAL FIX -- only push
    // the PREVIOUS recoveryFlow into history if it was computed for a
    // DIFFERENT (now-superseded) extreme. Without this check, a
    // no-entry episode's own WAIT-transition computation (freeze=false,
    // informational) followed by onEpisodeTerminal's own FINAL
    // computation for the SAME extreme (just a later end boundary)
    // wrongly duplicated an entry into history -- confirmed by a real
    // test failure (expected 1 history entry, got 2, for an episode
    // whose extreme never actually changed between the two calls).
    if (s.record.recoveryFlow !== null && s.record.recoveryFlow.startAt !== startAt) {
      s.record.recoveryFlowHistory.push(s.record.recoveryFlow);
    }
    s.record.recoveryFlow = recovery;
    if (freeze) s.recoveryFrozen = true;
  }

  private buildFlowWindow(s: SymbolResearchState, startAt: number, endAt: number, priceStart: number, priceEnd: number, totalObservedLiquidationUsd: number, eventCount: number, extremeCount: number): FlowWindowStats {
    const inWindow = (e: TradeBufferEntry): boolean => e.ts >= startAt && e.ts <= endAt;
    const futuresIn = s.futuresBuffer.filter(inWindow);
    const futuresBuyUsd = futuresIn.filter((e) => e.aggressor === "BUY").reduce((a, e) => a + e.quoteQty, 0);
    const futuresSellUsd = futuresIn.filter((e) => e.aggressor === "SELL").reduce((a, e) => a + e.quoteQty, 0);

    const spotIn = s.spotBuffer.filter(inWindow);
    const spotDataAvailable = spotIn.length > 0;
    const spotBuyUsd = spotIn.filter((e) => e.aggressor === "BUY").reduce((a, e) => a + e.quoteQty, 0);
    const spotSellUsd = spotIn.filter((e) => e.aggressor === "SELL").reduce((a, e) => a + e.quoteQty, 0);
    const spotPriceStart = spotDataAvailable ? spotIn[0]!.price : null;
    const spotPriceEnd = spotDataAvailable ? spotIn[spotIn.length - 1]!.price : null;

    const oiStart = this.nearestOi(s.oiBuffer, startAt);
    const oiEnd = this.nearestOi(s.oiBuffer, endAt);
    const oiDeltaUsd = oiStart !== null && oiEnd !== null ? (oiEnd.oiValue - oiStart.oiValue) * priceEnd : null;
    const oiDeltaPct = oiStart !== null && oiEnd !== null && oiStart.oiValue !== 0 ? ((oiEnd.oiValue - oiStart.oiValue) / oiStart.oiValue) * 100 : null;

    const basisStart = this.market.getBasisSnapshot(s.record.symbol, startAt);
    const basisEnd = this.market.getBasisSnapshot(s.record.symbol, endAt);

    return {
      startAt, endAt, durationMs: Math.max(0, endAt - startAt),
      futuresBuyUsd, futuresSellUsd, futuresDelta: cvdUsd(futuresBuyUsd, futuresSellUsd),
      futuresBuySellRatio: futuresSellUsd > 0 ? futuresBuyUsd / futuresSellUsd : null,
      spotBuyUsd, spotSellUsd, spotDelta: cvdUsd(spotBuyUsd, spotSellUsd),
      spotBuySellRatio: spotSellUsd > 0 ? spotBuyUsd / spotSellUsd : null,
      spotDataAvailable,
      oiStart, oiEnd, oiDeltaUsd, oiDeltaPct,
      spotPriceStart, spotPriceEnd,
      spotPriceChangePct: spotPriceStart !== null && spotPriceEnd !== null && spotPriceStart > 0 ? ((spotPriceEnd - spotPriceStart) / spotPriceStart) * 100 : null,
      futuresPriceStart: priceStart, futuresPriceEnd: priceEnd,
      futuresPriceChangePct: priceStart > 0 ? ((priceEnd - priceStart) / priceStart) * 100 : 0,
      basisStartBps: basisStart.basisBps, basisEndBps: basisEnd.basisBps,
      basisChangeBps: basisStart.basisBps !== null && basisEnd.basisBps !== null ? basisEnd.basisBps - basisStart.basisBps : null,
      totalObservedLiquidationUsd, eventCount, extremeCount,
    };
  }

  private computeBasisRecovery(s: SymbolResearchState, endSnap: { price: number; market: MarketPointSnapshot }): void {
    const extremeMarket = s.record.finalExtremeSnapshot?.market ?? null;
    if (extremeMarket === null || extremeMarket.basisUsd === null || endSnap.market.basisUsd === null || extremeMarket.futuresMid === null || extremeMarket.spotMid === null || endSnap.market.futuresMid === null || endSnap.market.spotMid === null) {
      s.record.basisRecovery = {
        basisAtExtremeUsd: extremeMarket?.basisUsd ?? null, basisAtExtremeBps: extremeMarket?.basisBps ?? null,
        basisAtEntryOrEndUsd: endSnap.market.basisUsd, basisAtEntryOrEndBps: endSnap.market.basisBps,
        basisClosedUsd: null, basisClosedPct: null,
        futuresPriceContributionUsd: null, spotPriceContributionUsd: null,
        futuresContributionPct: null, spotContributionPct: null,
        spotHeldAfterExtreme: null, spotMadeNewExtreme: null, futuresMadeRecovery: null,
        convergenceDirection: "INSUFFICIENT_DATA",
      };
      return;
    }

    const basisAtExtremeUsd = extremeMarket.basisUsd;
    const basisAtEndUsd = endSnap.market.basisUsd;
    const basisClosedUsd = basisAtExtremeUsd - basisAtEndUsd;
    const basisClosedPct = basisAtExtremeUsd !== 0 ? (basisClosedUsd / Math.abs(basisAtExtremeUsd)) * 100 : null;

    const futuresPriceContributionUsd = endSnap.market.futuresMid - extremeMarket.futuresMid;
    const spotPriceContributionUsd = -(endSnap.market.spotMid - extremeMarket.spotMid);
    const totalContribution = Math.abs(futuresPriceContributionUsd) + Math.abs(spotPriceContributionUsd);
    const futuresContributionPct = totalContribution > 0 ? (Math.abs(futuresPriceContributionUsd) / totalContribution) * 100 : null;
    const spotContributionPct = totalContribution > 0 ? (Math.abs(spotPriceContributionUsd) / totalContribution) * 100 : null;

    const victim = s.record.victim;
    const futuresMadeRecovery = victim === "LONG" ? endSnap.market.futuresMid > extremeMarket.futuresMid : endSnap.market.futuresMid < extremeMarket.futuresMid;
    const spotMovedAdverse = victim === "LONG" ? endSnap.market.spotMid < extremeMarket.spotMid : endSnap.market.spotMid > extremeMarket.spotMid;
    const spotHeldAfterExtreme = !spotMovedAdverse;
    const spotMadeNewExtreme = spotMovedAdverse;

    const futuresMoved = Math.abs(futuresPriceContributionUsd) > 0;
    const spotMovedFavorably = spotPriceContributionUsd > 0;
    let convergenceDirection: ConvergenceDirection;
    if (!futuresMoved && spotMovedFavorably) convergenceDirection = "SPOT_TOWARD_FUTURES";
    else if (futuresMoved && !spotMovedFavorably) convergenceDirection = "FUTURES_TOWARD_SPOT";
    else if (futuresMoved && spotMovedFavorably) convergenceDirection = "BOTH";
    else convergenceDirection = "DIVERGENCE";
    if (basisClosedUsd <= 0) convergenceDirection = "DIVERGENCE";

    s.record.basisRecovery = {
      basisAtExtremeUsd, basisAtExtremeBps: extremeMarket.basisBps,
      basisAtEntryOrEndUsd: basisAtEndUsd, basisAtEntryOrEndBps: endSnap.market.basisBps,
      basisClosedUsd, basisClosedPct,
      futuresPriceContributionUsd, spotPriceContributionUsd,
      futuresContributionPct, spotContributionPct,
      spotHeldAfterExtreme, spotMadeNewExtreme, futuresMadeRecovery,
      convergenceDirection,
    };
  }
}
