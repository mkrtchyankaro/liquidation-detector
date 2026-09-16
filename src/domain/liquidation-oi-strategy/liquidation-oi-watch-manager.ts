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
  candidateTradeSideForVictim,
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
 * Sep 16 2026 (Karo), operator-requested CRITICAL FIX, confirmed by a
 * real production BTC replay: a symbol's internal tracking slot
 * previously had NO automatic release mechanism at all. An episode
 * that started tracking and simply never resolved (never qualified,
 * or qualified but never reached ENTRY_READY, or reached ENTRY_READY
 * but observation was never "consumed") occupied the slot
 * INDEFINITELY -- for the remainder of the process's uptime -- and,
 * combined with direction-sticky ownership, silently discarded every
 * later liquidation event in the OPPOSITE direction, including a real
 * $2.53M cascade. This file now implements explicit, causal lifecycle
 * death for every pre-ACTIVE state, and an explicit ENTRY_READY
 * resolution path (see confirmActivePosition/cancel), so ENTRY_READY
 * can never again behave as a permanent, unresolved state. See
 * lifecycle-death-fix.md-equivalent doc in the delivery report for
 * the full design.
 *
 * INVARIANT (structural, not just documented): once a symbol reaches
 * ACTIVE, none of the pre-entry staleness/no-progress checks in
 * onTick() are ever evaluated for it again -- see the early return at
 * the top of onTick() for ACTIVE/CLOSING states.
 */

interface SymbolLifecycle {
  ownershipId: string;
  globalState: GlobalLifecycleState;
  episode: LiquidationOiEpisodeState;
  watchResult: WatchQualificationResult | null;
  entryResult: EntryGateResult | null;
  /** Sep 16 2026 (Karo), operator-requested lifecycle-death tracking.
   *  All null until the relevant state is actually entered. */
  enteredExhaustionCandidateAt: number | null;
  lastTickAt: number | null;
  /** Sep 16 2026 (Karo), operator-requested SECOND fix -- "meaningful
   *  progress" checkpoint, distinct from episode.latestLiqTs/extremeTs
   *  (which refresh on ANY event, size-agnostic). Snapshots the
   *  episode's own quantities at the last point genuine material
   *  progress was detected; onTick() compares the CURRENT episode
   *  against this checkpoint, not against genesis, so a long-lived
   *  genuinely active episode is judged by its RECENT trajectory, not
   *  just whether it grew at all since it started. */
  lastMeaningfulProgressAt: number;
  liqUsdAtLastMeaningfulProgress: number;
  extremeAtLastMeaningfulProgress: number;
  minOiAtLastMeaningfulProgress: number | null;
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
   *  telemetry instead.
   *
   *  This remains correct under the Sep 16 lifecycle-death fix: an
   *  opposite event only reaches this "ignore" branch while a
   *  lifecycle genuinely still exists for the symbol. Once that
   *  lifecycle legitimately terminates (via the new death checks in
   *  onTick(), or via cancel()/confirmActivePosition() from the
   *  orchestrator), the map entry is gone -- so the VERY NEXT
   *  liquidation event, same or opposite direction, falls into the
   *  `existing === undefined` branch below and starts a genuinely
   *  fresh episode. Nothing here replays previously-ignored events. */
  onLiquidationEvent(
    event: LiquidationOiEventInput,
    oiAtEvent: { quantity: number; timestamp: number } | null,
  ): void {
    const existing = this.symbols.get(event.symbol);

    if (existing === undefined) {
      const episode = startEpisode(event, oiAtEvent);
      this.symbols.set(event.symbol, {
        ownershipId: "",
        globalState: "EPISODE_TRACKING",
        episode,
        watchResult: null,
        entryResult: null,
        enteredExhaustionCandidateAt: null,
        lastTickAt: null,
        lastMeaningfulProgressAt: event.timestamp,
        liqUsdAtLastMeaningfulProgress: episode.sameDirectionLiqUsd,
        extremeAtLastMeaningfulProgress: episode.extremePrice,
        minOiAtLastMeaningfulProgress: episode.minOiQuantity,
      });
      return;
    }

    if (existing.episode.victim !== event.victim) {
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

  /** Periodic tick -- advances EPISODE_TRACKING -> EXHAUSTION_CANDIDATE
   *  and EXHAUSTION_CANDIDATE -> ENTRY_READY, AND (Sep 16 2026 fix)
   *  applies explicit, causal lifecycle-death checks so no pre-ACTIVE
   *  state can occupy a symbol's slot indefinitely.
   *
   *  INVARIANT: once ACTIVE (or CLOSING), none of this applies --
   *  returns immediately. A real managed position is NEVER touched by
   *  pre-entry staleness/no-progress logic. */
  onTick(
    symbol: string,
    percentile: EpisodePercentileContext,
    oiHistory: readonly OiHistorySample[],
    currentPrice: number,
    atr3m: number | null,
    atr3mAgeMs: number | null,
    nowMs: number,
  ): void {
    let lifecycle = this.symbols.get(symbol);
    if (lifecycle === undefined) return;
    if (
      lifecycle.globalState === "ACTIVE" ||
      lifecycle.globalState === "CLOSING" ||
      lifecycle.globalState === "CLOSED"
    )
      return;

    // MARKET_DATA_STALE_TIMEOUT: the gap since the LAST tick this
    // symbol actually received (not since episode start) -- detects
    // the feed itself having gone quiet, independent of episode age.
    if (lifecycle.lastTickAt !== null) {
      const gapMs = nowMs - lifecycle.lastTickAt;
      if (gapMs > this.config.marketDataStaleTimeoutMs) {
        this.cancel(
          symbol,
          "MARKET_DATA_STALE_TIMEOUT",
          `gap of ${gapMs}ms since the last tick exceeds marketDataStaleTimeoutMs=${this.config.marketDataStaleTimeoutMs}ms`,
          nowMs,
        );
        return;
      }
    }

    // FAILSAFE (final safety net, not the primary boundary): absolute
    // max lifetime measured from the episode's own first liquidation
    // event, across the entire pre-ACTIVE lifetime.
    const totalLifetimeMs = nowMs - lifecycle.episode.firstLiqTs;
    if (totalLifetimeMs > this.config.preEntryFailsafeMaxLifetimeMs) {
      this.cancel(
        symbol,
        "PRE_ENTRY_FAILSAFE_MAX_LIFETIME",
        `FAILSAFE: total pre-ACTIVE lifetime ${totalLifetimeMs}ms exceeds preEntryFailsafeMaxLifetimeMs=${this.config.preEntryFailsafeMaxLifetimeMs}ms -- this indicates the primary death checks failed to fire and is a safety net, not the intended normal path`,
        nowMs,
      );
      return;
    }

    if (lifecycle.globalState === "EPISODE_TRACKING") {
      // Sep 16 2026 (Karo), operator-requested SECOND fix, proven by
      // the real BTC replay: recompute whether MEANINGFUL progress
      // (not just any event) has happened since the last checkpoint,
      // and only then check staleness against that checkpoint -- a
      // tiny liquidation print or a marginal new extreme no longer
      // resets the clock on its own.
      const checkpoint = this.recomputeMeaningfulProgressCheckpoint(
        lifecycle,
        atr3m,
        nowMs,
      );
      const sinceLastMeaningfulProgress =
        nowMs - checkpoint.lastMeaningfulProgressAt;
      if (sinceLastMeaningfulProgress > this.config.noProgressTimeoutMs) {
        this.cancel(
          symbol,
          "EPISODE_NO_PROGRESS",
          `no MEANINGFUL liquidation/extreme/OI progress for ${sinceLastMeaningfulProgress}ms, exceeds noProgressTimeoutMs=${this.config.noProgressTimeoutMs}ms (raw activity may have continued -- see minMeaningfulLiqProgressFraction/minMeaningfulExtremeProgressAtr/minMeaningfulOiProgressFraction)`,
          nowMs,
        );
        return;
      }
      lifecycle = { ...lifecycle, ...checkpoint };

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
        this.symbols.set(symbol, {
          ...lifecycle,
          watchResult: result,
          lastTickAt: nowMs,
        });
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
        enteredExhaustionCandidateAt: nowMs,
        lastTickAt: nowMs,
        lastMeaningfulProgressAt: lifecycle.lastMeaningfulProgressAt,
        liqUsdAtLastMeaningfulProgress:
          lifecycle.liqUsdAtLastMeaningfulProgress,
        extremeAtLastMeaningfulProgress:
          lifecycle.extremeAtLastMeaningfulProgress,
        minOiAtLastMeaningfulProgress: lifecycle.minOiAtLastMeaningfulProgress,
      });
      return;
    }

    if (lifecycle.globalState === "EXHAUSTION_CANDIDATE") {
      // ENTRY_WINDOW_MISSED: too long awaiting entry since clearing
      // was first expected, regardless of gate-by-gate outcome.
      const sinceEnteredExhaustion =
        lifecycle.enteredExhaustionCandidateAt !== null
          ? nowMs - lifecycle.enteredExhaustionCandidateAt
          : 0;
      if (sinceEnteredExhaustion > this.config.entryWindowTimeoutMs) {
        this.cancel(
          symbol,
          "ENTRY_WINDOW_MISSED",
          `${sinceEnteredExhaustion}ms in EXHAUSTION_CANDIDATE without reaching ENTRY_READY, exceeds entryWindowTimeoutMs=${this.config.entryWindowTimeoutMs}ms`,
          nowMs,
        );
        return;
      }
      // PRE_ENTRY_THESIS_INVALIDATED: price has already fully
      // reverted PAST the episode's own starting reference price, in
      // the FAVORABLE direction for the candidate trade, before entry
      // ever triggered -- the edge this setup was waiting for has
      // already played out without us, so waiting further no longer
      // makes sense. (Not the adverse direction: continued adverse
      // movement is already captured by the episode's own extreme
      // continuing to update on each new same-direction liquidation.)
      if (atr3m !== null) {
        const candidateSide = candidateTradeSideForVictim(
          lifecycle.episode.victim,
        );
        const buffer = atr3m * this.config.thesisInvalidationAtrMultiple;
        const invalidated =
          candidateSide === "LONG"
            ? currentPrice > lifecycle.episode.startPrice + buffer
            : currentPrice < lifecycle.episode.startPrice - buffer;
        if (invalidated) {
          this.cancel(
            symbol,
            "PRE_ENTRY_THESIS_INVALIDATED",
            `price ${currentPrice} already fully reverted past the episode's own startPrice ${lifecycle.episode.startPrice} (favorable direction) by more than thesisInvalidationAtrMultiple=${this.config.thesisInvalidationAtrMultiple} ATR (${buffer}) before entry ever triggered -- the move already played out`,
            nowMs,
          );
          return;
        }
      }

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
        this.symbols.set(symbol, {
          ...lifecycle,
          entryResult: result,
          lastTickAt: nowMs,
        });
        return;
      }
      this.assertTransition("EXHAUSTION_CANDIDATE", "ENTRY_READY", symbol);
      this.symbols.set(symbol, {
        ...lifecycle,
        globalState: "ENTRY_READY",
        entryResult: result,
        lastTickAt: nowMs,
      });
      return;
    }
  }

  /** Sep 16 2026 (Karo), operator-requested. The ONLY path to ACTIVE.
   *  Called by the orchestrator once at least one user's execution has
   *  produced a genuinely confirmed, protected real position --
   *  ENTRY_READY alone must never imply ACTIVE. Retains ownership
   *  permanently (per the approved architecture, symbol release from
   *  here on is governed solely by isGlobalCloseEligible(), Phase 8+
   *  scope) -- none of onTick()'s pre-entry death checks apply to this
   *  symbol again (see the early return at the top of onTick()). */
  confirmActivePosition(symbol: string, nowMs: number): void {
    const lifecycle = this.symbols.get(symbol);
    if (lifecycle === undefined) return;
    this.assertTransition(lifecycle.globalState, "ACTIVE", symbol);
    this.symbols.set(symbol, {
      ...lifecycle,
      globalState: "ACTIVE",
      lastTickAt: nowMs,
    });
  }

  /** Explicit CANCEL, callable from EPISODE_TRACKING through
   *  ENTRY_READY. Releases ownership if held; safe even if ownership
   *  was never claimed. This is also the resolution path for
   *  ENTRY_READY-with-no-real-position (observational-only, all users
   *  disabled, all executions failed) -- the orchestrator calls this
   *  with the appropriate reason code once it has determined no real
   *  position resulted from the fan-out, per the operator's own
   *  explicit requirement that ENTRY_READY never remain a permanent
   *  state. */
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

  /** Sep 16 2026 (Karo), operator-requested SECOND fix. Compares the
   *  CURRENT episode snapshot against the last "meaningful progress"
   *  checkpoint (not genesis) across three independent, relative,
   *  self-scaling dimensions -- reusing the episode's own accumulated
   *  USD, ATR (an existing strategy statistic), and OI, per the
   *  operator's own explicit instruction against inventing fresh
   *  absolute thresholds. ANY ONE dimension showing meaningful
   *  progress refreshes the checkpoint (an episode that is genuinely
   *  still developing via liquidation flow OR price extension OR OI
   *  destruction is still alive) -- meaningful progress is NOT
   *  required on all three simultaneously. Pure; does not mutate the
   *  lifecycle passed in. */
  private recomputeMeaningfulProgressCheckpoint(
    lifecycle: SymbolLifecycle,
    atr3m: number | null,
    nowMs: number,
  ): Pick<
    SymbolLifecycle,
    | "lastMeaningfulProgressAt"
    | "liqUsdAtLastMeaningfulProgress"
    | "extremeAtLastMeaningfulProgress"
    | "minOiAtLastMeaningfulProgress"
  > {
    let progressed = false;

    const liqBase = lifecycle.liqUsdAtLastMeaningfulProgress;
    const liqProgressFraction =
      liqBase > 0
        ? (lifecycle.episode.sameDirectionLiqUsd - liqBase) / liqBase
        : 0;
    if (liqProgressFraction >= this.config.minMeaningfulLiqProgressFraction)
      progressed = true;

    if (atr3m !== null && atr3m > 0) {
      const extremeProgressAtr =
        Math.abs(
          lifecycle.episode.extremePrice -
            lifecycle.extremeAtLastMeaningfulProgress,
        ) / atr3m;
      if (extremeProgressAtr >= this.config.minMeaningfulExtremeProgressAtr)
        progressed = true;
    }

    const startOi = lifecycle.episode.startOiQuantity;
    const currentMinOi = lifecycle.episode.minOiQuantity;
    if (
      startOi !== null &&
      startOi > 0 &&
      currentMinOi !== null &&
      lifecycle.minOiAtLastMeaningfulProgress !== null
    ) {
      const additionalDestructionFraction =
        (lifecycle.minOiAtLastMeaningfulProgress - currentMinOi) / startOi;
      if (
        additionalDestructionFraction >=
        this.config.minMeaningfulOiProgressFraction
      )
        progressed = true;
    }

    if (!progressed)
      return {
        lastMeaningfulProgressAt: lifecycle.lastMeaningfulProgressAt,
        liqUsdAtLastMeaningfulProgress:
          lifecycle.liqUsdAtLastMeaningfulProgress,
        extremeAtLastMeaningfulProgress:
          lifecycle.extremeAtLastMeaningfulProgress,
        minOiAtLastMeaningfulProgress: lifecycle.minOiAtLastMeaningfulProgress,
      };
    return {
      lastMeaningfulProgressAt: nowMs,
      liqUsdAtLastMeaningfulProgress: lifecycle.episode.sameDirectionLiqUsd,
      extremeAtLastMeaningfulProgress: lifecycle.episode.extremePrice,
      minOiAtLastMeaningfulProgress: lifecycle.episode.minOiQuantity,
    };
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
