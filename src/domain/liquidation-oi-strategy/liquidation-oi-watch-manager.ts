import type { Side } from "../../shared/common.types";
import { SymbolOwnershipRegistry } from "./symbol-ownership";
import {
  startEpisode,
  foldLiquidationIntoEpisode,
  updateEpisodeOi,
  type LiquidationOiEpisodeState,
  type LiquidationOiEventInput,
} from "./episode-tracker";
import {
  qualifyWatch,
  type EpisodePercentileContext,
  type WatchQualificationResult,
} from "./watch-qualification";
import {
  evaluateEntryGates,
  type EntryGateResult,
} from "./entry-gate-pipeline";
import type { OiHistorySample } from "./oi-clearing-detector";
import {
  isValidGlobalTransition,
  type GlobalLifecycleState,
} from "./lifecycle.types";
import type { LiquidationOiStrategyConfig } from "./config";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "./config";

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phases 2-4
 * orchestration boundary. Ties symbol-ownership, episode-tracker,
 * watch-qualification, and entry-gate-pipeline together into one
 * per-symbol lifecycle. Deliberately NO Binance, NO Mongo, NO
 * Telegram calls anywhere in this file -- Phase 5+ owns persistence,
 * execution, and notification; this class owns only in-memory
 * lifecycle state and pure decisions, fully unit-testable without any
 * live dependency.
 *
 * NOT wired into main.ts/market-data-orchestrator.ts in this pass --
 * available for Phase 5 to construct and drive with real events, but
 * not yet receiving any from the live system.
 */

interface SymbolLifecycle {
  ownershipId: string;
  globalState: GlobalLifecycleState;
  episode: LiquidationOiEpisodeState;
  watchResult: WatchQualificationResult | null;
  entryResult: EntryGateResult | null;
}

export interface NoSignalEvent {
  symbol: string;
  victim: Side;
  atStage: "WATCH" | "ENTRY";
  reasonCode: string;
  detail: string;
  timestamp: number;
}

export interface OppositeEventIgnoredEvent {
  symbol: string;
  trackedVictim: Side;
  ignoredVictim: Side;
  ignoredQuoteQty: number;
  timestamp: number;
}

export class LiquidationOiWatchManager {
  private readonly ownership = new SymbolOwnershipRegistry();
  private readonly symbols = new Map<string, SymbolLifecycle>();
  private readonly noSignalLog: NoSignalEvent[] = [];
  private readonly oppositeEventIgnoredLog: OppositeEventIgnoredEvent[] = [];

  constructor(
    private readonly config: LiquidationOiStrategyConfig = DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
    private readonly makeOwnershipId: () => string = () =>
      `lox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  ) {}

  getLifecycle(symbol: string): Readonly<SymbolLifecycle> | null {
    return this.symbols.get(symbol) ?? null;
  }
  isSymbolOwned(symbol: string): boolean {
    return this.ownership.isOwned(symbol);
  }
  getNoSignalLog(): readonly NoSignalEvent[] {
    return this.noSignalLog;
  }
  getOppositeEventIgnoredLog(): readonly OppositeEventIgnoredEvent[] {
    return this.oppositeEventIgnoredLog;
  }

  /** Called for every liquidation event on a symbol.
   *
   *  Sep 16 2026 (Karo), operator-requested fix -- DIRECTION-STICKY
   *  INTERNAL EPISODE OWNERSHIP. Previously, an opposite-victim event
   *  arriving before WATCH_QUALIFIED (while no SymbolOwnershipRegistry
   *  entry existed yet) would REPLACE the currently-tracking episode
   *  outright -- silently erasing accumulated same-direction
   *  liquidation total and resetting extreme/start state. This was
   *  wrong: internal episode ownership begins at the FIRST liquidation
   *  event that starts EPISODE_TRACKING, strictly before (and
   *  independent of) GLOBAL_TRADE/WATCH ownership (SymbolOwnershipRegistry),
   *  which is claimed later, at WATCH_QUALIFIED. An opposite-victim
   *  event while an episode is internally tracking -- at ANY state,
   *  EPISODE_TRACKING through ENTRY_READY -- is now always ignored:
   *  it never replaces, never resets, never creates a competing
   *  episode. It is recorded in oppositeEventIgnoredLog for strategy
   *  telemetry instead. */
  onLiquidationEvent(
    event: LiquidationOiEventInput,
    oiAtEvent: { quantity: number; timestamp: number } | null,
  ): void {
    const existing = this.symbols.get(event.symbol);

    if (existing === undefined) {
      this.symbols.set(event.symbol, {
        ownershipId: "",
        globalState: "EPISODE_TRACKING",
        episode: startEpisode(event, oiAtEvent),
        watchResult: null,
        entryResult: null,
      });
      return;
    }

    if (existing.episode.victim !== event.victim) {
      // Direction-sticky: the currently-tracking episode's own
      // victimDirection is fixed from its first event, regardless of
      // whether GLOBAL_TRADE/WATCH ownership has been claimed yet.
      // Always ignored -- never replaces, never resets, never starts
      // a competing episode.
      this.oppositeEventIgnoredLog.push({
        symbol: event.symbol,
        trackedVictim: existing.episode.victim,
        ignoredVictim: event.victim,
        ignoredQuoteQty: event.quoteQty,
        timestamp: event.timestamp,
      });
      return;
    }

    const foldedEpisode = foldLiquidationIntoEpisode(existing.episode, event);
    const withOi =
      oiAtEvent !== null
        ? updateEpisodeOi(foldedEpisode, oiAtEvent)
        : foldedEpisode;
    this.symbols.set(event.symbol, { ...existing, episode: withOi });
  }

  /** Periodic tick -- advances EPISODE_TRACKING -> WATCH_QUALIFIED
   *  (claiming ownership) and EXHAUSTION_CANDIDATE -> ENTRY_READY.
   *  Failing a gate is logged as NO_SIGNAL but does not itself
   *  transition to CANCELLED (see cancel() for explicit cancellation). */
  onTick(
    symbol: string,
    percentile: EpisodePercentileContext,
    oiHistory: readonly OiHistorySample[],
    currentPrice: number,
    atr3m: number | null,
    atr3mAgeMs: number | null,
    nowMs: number,
  ): void {
    const lifecycle = this.symbols.get(symbol);
    if (lifecycle === undefined) return;

    if (lifecycle.globalState === "EPISODE_TRACKING") {
      const result = qualifyWatch(
        lifecycle.episode,
        percentile,
        atr3m,
        this.config,
      );
      if (!result.qualifies) {
        this.noSignalLog.push({
          symbol,
          victim: lifecycle.episode.victim,
          atStage: "WATCH",
          reasonCode: result.reasonCode,
          detail: result.detail,
          timestamp: nowMs,
        });
        this.symbols.set(symbol, { ...lifecycle, watchResult: result });
        return;
      }
      const resolution = this.ownership.resolve(
        symbol,
        lifecycle.episode.victim,
        this.makeOwnershipId,
      );
      if (resolution.action === "ignore") {
        this.symbols.delete(symbol);
        return;
      }
      const ownershipId = resolution.ownershipId;
      this.assertTransition(lifecycle.globalState, "WATCH_QUALIFIED", symbol);
      this.assertTransition("WATCH_QUALIFIED", "EXHAUSTION_CANDIDATE", symbol);
      this.symbols.set(symbol, {
        ownershipId,
        globalState: "EXHAUSTION_CANDIDATE",
        episode: lifecycle.episode,
        watchResult: result,
        entryResult: null,
      });
      return;
    }

    if (lifecycle.globalState === "EXHAUSTION_CANDIDATE") {
      const result = evaluateEntryGates({
        episode: lifecycle.episode,
        oiHistory,
        currentPrice,
        atr3m,
        atr3mAgeMs,
        nowMs,
        config: this.config,
      });
      if (!result.entryReady) {
        this.noSignalLog.push({
          symbol,
          victim: lifecycle.episode.victim,
          atStage: "ENTRY",
          reasonCode: result.reasonCode,
          detail: result.detail,
          timestamp: nowMs,
        });
        this.symbols.set(symbol, { ...lifecycle, entryResult: result });
        return;
      }
      this.assertTransition("EXHAUSTION_CANDIDATE", "ENTRY_READY", symbol);
      this.symbols.set(symbol, {
        ...lifecycle,
        globalState: "ENTRY_READY",
        entryResult: result,
      });
      return;
    }
  }

  /** Explicit CANCEL, callable from EPISODE_TRACKING through
   *  ENTRY_READY. Releases ownership if held; safe even if ownership
   *  was never claimed. */
  cancel(
    symbol: string,
    reasonCode: string,
    detail: string,
    nowMs: number,
  ): void {
    const lifecycle = this.symbols.get(symbol);
    if (lifecycle === undefined) return;
    if (lifecycle.globalState !== "EPISODE_TRACKING")
      this.assertTransition(lifecycle.globalState, "CANCELLED", symbol);
    this.noSignalLog.push({
      symbol,
      victim: lifecycle.episode.victim,
      atStage: lifecycle.globalState === "EPISODE_TRACKING" ? "WATCH" : "ENTRY",
      reasonCode,
      detail,
      timestamp: nowMs,
    });
    if (this.ownership.isOwned(symbol)) this.ownership.release(symbol);
    this.symbols.delete(symbol);
  }

  private assertTransition(
    from: GlobalLifecycleState,
    to: GlobalLifecycleState,
    symbol: string,
  ): void {
    if (!isValidGlobalTransition(from, to))
      throw new Error(
        `Invalid global lifecycle transition for ${symbol}: ${from} -> ${to}`,
      );
  }
}
