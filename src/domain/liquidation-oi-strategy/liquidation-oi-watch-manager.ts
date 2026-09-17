import type { Side } from "../../shared/common.types";
import { SymbolOwnershipRegistry } from "./symbol-ownership";
import {
  startEpisode,
  foldLiquidationIntoEpisode,
  updateEpisodeOi,
  oiDestructionFraction,
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
import type { ForensicEvent } from "./forensic-events";

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
 * previously had NO automatic release mechanism at all. Explicit,
 * causal lifecycle death for every pre-ACTIVE state, and an explicit
 * ENTRY_READY resolution path (confirmActivePosition/cancel), so
 * ENTRY_READY can never behave as a permanent, unresolved state.
 *
 * Sep 16 2026 (Karo), operator-requested SECOND fix: EPISODE_NO_PROGRESS
 * now compares against a "meaningful progress" checkpoint (relative,
 * self-scaling thresholds on liquidation USD / ATR-normalized extreme
 * / OI destruction) rather than raw latestLiqTs/extremeTs, which any
 * tiny event used to refresh unconditionally.
 *
 * Sep 16 2026 (Karo), operator-requested THIRD pass: FORENSIC
 * OBSERVABILITY. An optional `forensic` callback (constructor param,
 * default no-op) receives structured ForensicEvent objects at every
 * meaningful change -- episode creation, liquidation accumulation,
 * extreme updates, OI progress, meaningful-progress checkpoint
 * refreshes (the event that directly explains why an episode did or
 * did not die), watch/entry/clearing evaluation CHANGES (not every
 * tick), state transitions, and terminal reasons. This is STRICTLY
 * additive: every emit() call sits alongside logic that already
 * existed and decided the outcome on its own -- nothing here reads a
 * forensic event back to make a decision, and every existing test in
 * this project (including the full lifecycle-death and meaningful-
 * progress regression suites) passes unchanged with or without a
 * forensic callback attached.
 *
 * INVARIANT (structural, not just documented): once a symbol reaches
 * ACTIVE, none of the pre-entry staleness/no-progress checks in
 * onTick() are ever evaluated for it again -- see the early return at
 * the top of onTick() for ACTIVE/CLOSING states.
 */

interface SymbolLifecycle {
  episodeId: string;
  ownershipId: string;
  globalState: GlobalLifecycleState;
  episode: LiquidationOiEpisodeState;
  watchResult: WatchQualificationResult | null;
  entryResult: EntryGateResult | null;
  enteredExhaustionCandidateAt: number | null;
  lastTickAt: number | null;
  lastMeaningfulProgressAt: number;
  liqUsdAtLastMeaningfulProgress: number;
  extremeAtLastMeaningfulProgress: number;
  minOiAtLastMeaningfulProgress: number | null;
  /** Sep 16 2026 (Karo), operator-requested forensic-only fields --
   *  used exclusively to detect "the watch/entry evaluation result
   *  CHANGED since last tick" so WATCH_EVALUATION/ENTRY_GATE_EVALUATION
   *  are emitted only on change, never every tick. Never read by any
   *  decision logic. */
  lastLoggedWatchReasonCode: string | null;
  lastLoggedEntryReasonCode: string | null;
  lastLoggedClearingResult: boolean | null;
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
    private readonly makeEpisodeId: () => string = () =>
      `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly forensic: (event: ForensicEvent) => void = () => {},
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

  private base(
    lifecycle: SymbolLifecycle,
    symbol: string,
    nowMs: number,
  ): {
    ts: number;
    symbol: string;
    episodeId: string;
    victim: Side;
    state: string;
    episodeAgeSec: number;
  } {
    return {
      ts: nowMs,
      symbol,
      episodeId: lifecycle.episodeId,
      victim: lifecycle.episode.victim,
      state: lifecycle.globalState,
      episodeAgeSec: (nowMs - lifecycle.episode.firstLiqTs) / 1000,
    };
  }

  /** Called for every liquidation event on a symbol.
   *
   *  Sep 16 2026 (Karo), operator-requested fix -- DIRECTION-STICKY
   *  INTERNAL EPISODE OWNERSHIP. An opposite-victim event while an
   *  episode is internally tracking -- at ANY state, EPISODE_TRACKING
   *  through ENTRY_READY -- is always ignored: it never replaces,
   *  never resets, never creates a competing episode. Once the
   *  current lifecycle legitimately terminates, the VERY NEXT
   *  liquidation event, same or opposite direction, starts a
   *  genuinely fresh episode with a fresh episodeId. */
  onLiquidationEvent(
    event: LiquidationOiEventInput,
    oiAtEvent: { quantity: number; timestamp: number } | null,
  ): void {
    const existing = this.symbols.get(event.symbol);

    if (existing === undefined) {
      const episode = startEpisode(event, oiAtEvent);
      const episodeId = this.makeEpisodeId();
      const lifecycle: SymbolLifecycle = {
        episodeId,
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
        lastLoggedWatchReasonCode: null,
        lastLoggedEntryReasonCode: null,
        lastLoggedClearingResult: null,
      };
      this.symbols.set(event.symbol, lifecycle);
      this.forensic({
        ...this.base(lifecycle, event.symbol, event.timestamp),
        type: "EPISODE_START",
        triggerUsd: event.quoteQty,
        triggerPrice: event.price,
        startPrice: episode.startPrice,
        startingOi: episode.startOiQuantity,
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

    const previousTotal = existing.episode.sameDirectionLiqUsd;
    const previousExtreme = existing.episode.extremePrice;
    const previousMinOi = existing.episode.minOiQuantity;
    const foldedEpisode = foldLiquidationIntoEpisode(existing.episode, event);
    const withOi =
      oiAtEvent !== null
        ? updateEpisodeOi(foldedEpisode, oiAtEvent)
        : foldedEpisode;
    const updated: SymbolLifecycle = { ...existing, episode: withOi };
    this.symbols.set(event.symbol, updated);

    // Forensic-only "would this individually clear the meaningful-progress
    // bar" reporting for the LIQ dimension (no ATR needed here) -- the
    // OFFICIAL checkpoint refresh (which actually drives the death clock)
    // still only happens in onTick()'s recomputeMeaningfulProgressCheckpoint,
    // unchanged. This is per-event telemetry, not a second source of truth.
    const liqBase = existing.liqUsdAtLastMeaningfulProgress;
    const liqProgressFraction =
      liqBase > 0 ? (withOi.sameDirectionLiqUsd - liqBase) / liqBase : 0;
    this.forensic({
      ...this.base(updated, event.symbol, event.timestamp),
      type: "LIQ_ACCUMULATED",
      eventUsd: event.quoteQty,
      previousTotal,
      newTotal: withOi.sameDirectionLiqUsd,
      meaningfulLiqProgress:
        liqProgressFraction >= this.config.minMeaningfulLiqProgressFraction,
    });

    if (withOi.extremePrice !== previousExtreme) {
      this.forensic({
        ...this.base(updated, event.symbol, event.timestamp),
        type: "EXTREME_UPDATE",
        previousExtreme,
        newExtreme: withOi.extremePrice,
        extensionPrice: Math.abs(withOi.extremePrice - previousExtreme),
        extensionAtr: null,
        meaningfulExtremeProgress: false,
      });
    }
    if (oiAtEvent !== null && withOi.minOiQuantity !== previousMinOi) {
      this.forensic({
        ...this.base(updated, event.symbol, event.timestamp),
        type: "OI_PROGRESS",
        startingOi: withOi.startOiQuantity,
        currentOi: withOi.currentOiQuantity,
        minOi: withOi.minOiQuantity,
        destructionFraction: oiDestructionFraction(withOi),
        previousCheckpointDestructionFraction: null,
        meaningfulOiProgress: false,
      });
    }
  }

  /** Periodic tick -- advances EPISODE_TRACKING -> EXHAUSTION_CANDIDATE
   *  and EXHAUSTION_CANDIDATE -> ENTRY_READY, AND applies explicit,
   *  causal lifecycle-death checks so no pre-ACTIVE state can occupy
   *  a symbol's slot indefinitely.
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
      const before = lifecycle;
      const checkpoint = this.recomputeMeaningfulProgressCheckpoint(
        lifecycle,
        atr3m,
        nowMs,
      );
      if (
        checkpoint.lastMeaningfulProgressAt !== before.lastMeaningfulProgressAt
      ) {
        const trigger: "LIQ" | "EXTREME" | "OI" =
          checkpoint.liqUsdAtLastMeaningfulProgress !==
          before.liqUsdAtLastMeaningfulProgress
            ? "LIQ"
            : checkpoint.extremeAtLastMeaningfulProgress !==
                before.extremeAtLastMeaningfulProgress
              ? "EXTREME"
              : "OI";
        const thresholdCrossed =
          trigger === "LIQ"
            ? `liq >= minMeaningfulLiqProgressFraction=${this.config.minMeaningfulLiqProgressFraction}`
            : trigger === "EXTREME"
              ? `extreme >= minMeaningfulExtremeProgressAtr=${this.config.minMeaningfulExtremeProgressAtr} ATR`
              : `OI destruction >= minMeaningfulOiProgressFraction=${this.config.minMeaningfulOiProgressFraction}`;
        this.forensic({
          ...this.base(before, symbol, nowMs),
          type: "MEANINGFUL_PROGRESS_REFRESH",
          oldTimestamp: before.lastMeaningfulProgressAt,
          newTimestamp: checkpoint.lastMeaningfulProgressAt,
          trigger,
          oldCheckpoint: {
            liqUsd: before.liqUsdAtLastMeaningfulProgress,
            extreme: before.extremeAtLastMeaningfulProgress,
            minOi: before.minOiAtLastMeaningfulProgress,
          },
          newCheckpoint: {
            liqUsd: checkpoint.liqUsdAtLastMeaningfulProgress,
            extreme: checkpoint.extremeAtLastMeaningfulProgress,
            minOi: checkpoint.minOiAtLastMeaningfulProgress,
          },
          thresholdCrossed,
        });
      }

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
      const watchReasonCode = result.qualifies
        ? "QUALIFIED"
        : result.reasonCode;
      if (watchReasonCode !== lifecycle.lastLoggedWatchReasonCode) {
        const displacementAtr =
          atr3m !== null && atr3m > 0
            ? Math.abs(
                lifecycle.episode.extremePrice - lifecycle.episode.startPrice,
              ) / atr3m
            : null;
        this.forensic({
          ...this.base(lifecycle, symbol, nowMs),
          type: "WATCH_EVALUATION",
          totalLiqUsd: lifecycle.episode.sameDirectionLiqUsd,
          percentileRank: percentile.percentileRank,
          requiredPercentile: this.config.minPercentileRankForWatch,
          displacementAtr,
          requiredDisplacement: this.config.minDisplacementAtrForWatch,
          result: result.qualifies ? "PASS" : "FAIL",
          reasonCode: watchReasonCode,
          detail: result.qualifies ? "qualified" : result.detail,
        });
      }
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
          lastLoggedWatchReasonCode: watchReasonCode,
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
      const next: SymbolLifecycle = {
        ...lifecycle,
        ownershipId,
        globalState: "EXHAUSTION_CANDIDATE",
        watchResult: result,
        entryResult: null,
        enteredExhaustionCandidateAt: nowMs,
        lastTickAt: nowMs,
        lastLoggedWatchReasonCode: watchReasonCode,
      };
      this.symbols.set(symbol, next);
      this.forensic({
        ...this.base(next, symbol, nowMs),
        type: "STATE_TRANSITION",
        from: "EPISODE_TRACKING",
        to: "EXHAUSTION_CANDIDATE",
        reason: "WATCH qualified",
      });
      return;
    }

    if (lifecycle.globalState === "EXHAUSTION_CANDIDATE") {
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
      const entryReasonCode = result.entryReady
        ? "ENTRY_READY"
        : result.reasonCode;

      if (
        result.clearingState !== null &&
        result.clearingState.windows.length > 0
      ) {
        const clearingPass =
          result.entryReady || result.reasonCode !== "CLEARING_NOT_DETECTED";
        if (
          lifecycle.lastLoggedClearingResult === null ||
          clearingPass !== lifecycle.lastLoggedClearingResult ||
          entryReasonCode !== lifecycle.lastLoggedEntryReasonCode
        ) {
          this.forensic({
            ...this.base(lifecycle, symbol, nowMs),
            type: "CLEARING_EVALUATION",
            windows: result.clearingState.windows.map((w) => ({
              windowSec: w.windowSec,
              slopeContractsPerSec: w.slopeContractsPerSec,
              sampleCount: w.sampleCount,
            })),
            peakDestructionSlopeContractsPerSec:
              result.clearingState.peakDestructionSlopeContractsPerSec,
            windowsPassed: result.clearingState.windowsShowingClearing,
            windowsRequired: this.config.minConsecutiveWindowsForClearingEnd,
            result: clearingPass ? "PASS" : "FAIL",
          });
        }
      }

      if (entryReasonCode !== lifecycle.lastLoggedEntryReasonCode) {
        const atrReady = {
          pass:
            atr3m !== null &&
            atr3m > 0 &&
            atr3mAgeMs !== null &&
            atr3mAgeMs <= this.config.maxAtrAgeMsForEntry,
          detail: `atr3m=${atr3m} atr3mAgeMs=${atr3mAgeMs}`,
        };
        const clearingOk =
          result.clearingState !== null &&
          (result.entryReady ||
            (result.reasonCode !== "CLEARING_NOT_DETECTED" &&
              result.reasonCode !== "STALE_OI"));
        const oiFresh = {
          pass:
            result.clearingState !== null &&
            (result.entryReady || result.reasonCode !== "STALE_OI"),
          detail: `mostRecentSampleAgeMs=${result.clearingState?.mostRecentSampleAgeMs ?? "null"}`,
        };
        const clearing = {
          pass: clearingOk,
          detail:
            result.clearingState !== null
              ? `windowsShowingClearing=${result.clearingState.windowsShowingClearing}`
              : "no clearing state",
        };
        const counterMove = {
          pass:
            result.entryReady ||
            (result.reasonCode !== "NO_COUNTER_MOVE_YET" &&
              atrReady.pass &&
              clearingOk),
          detail: result.entryReady
            ? `counterMoveAtr=${result.counterMoveAtr.toFixed(3)}`
            : result.reasonCode === "NO_COUNTER_MOVE_YET"
              ? result.detail
              : "not yet evaluated",
        };
        const distanceFromExtreme = {
          pass:
            result.entryReady || result.reasonCode !== "TOO_FAR_FROM_EXTREME",
          detail: result.entryReady
            ? `distanceFromExtremeAtr=${result.distanceFromExtremeAtr.toFixed(3)}`
            : result.reasonCode === "TOO_FAR_FROM_EXTREME"
              ? result.detail
              : "not yet evaluated",
        };
        const blockedBy: string[] = result.entryReady
          ? []
          : [result.reasonCode];
        this.forensic({
          ...this.base(lifecycle, symbol, nowMs),
          type: "ENTRY_GATE_EVALUATION",
          atrReady,
          oiFresh,
          clearing,
          counterMove,
          distanceFromExtreme,
          final: result.entryReady ? "ENTRY_READY" : "NO_ENTRY",
          blockedBy,
        });
      }

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
          lastLoggedEntryReasonCode: entryReasonCode,
          lastLoggedClearingResult:
            result.clearingState !== null
              ? result.reasonCode !== "CLEARING_NOT_DETECTED"
              : lifecycle.lastLoggedClearingResult,
        });
        return;
      }
      this.assertTransition("EXHAUSTION_CANDIDATE", "ENTRY_READY", symbol);
      const next: SymbolLifecycle = {
        ...lifecycle,
        globalState: "ENTRY_READY",
        entryResult: result,
        lastTickAt: nowMs,
        lastLoggedEntryReasonCode: entryReasonCode,
        lastLoggedClearingResult: true,
      };
      this.symbols.set(symbol, next);
      this.forensic({
        ...this.base(next, symbol, nowMs),
        type: "STATE_TRANSITION",
        from: "EXHAUSTION_CANDIDATE",
        to: "ENTRY_READY",
        reason: "entry gates passed",
      });
      this.forensic({
        ...this.base(next, symbol, nowMs),
        type: "ENTRY_READY",
        entryReferencePrice: currentPrice,
        extreme: next.episode.extremePrice,
        totalLiqUsd: next.episode.sameDirectionLiqUsd,
        percentileRank: next.watchResult?.qualifies
          ? next.watchResult.episodePercentileRank
          : 0,
        counterMoveAtr: result.counterMoveAtr,
        distanceFromExtremeAtr: result.distanceFromExtremeAtr,
      });
      return;
    }
  }

  /** Sep 16 2026 (Karo), operator-requested. The ONLY path to ACTIVE. */
  confirmActivePosition(symbol: string, nowMs: number): void {
    const lifecycle = this.symbols.get(symbol);
    if (lifecycle === undefined) return;
    this.assertTransition(lifecycle.globalState, "ACTIVE", symbol);
    const next = {
      ...lifecycle,
      globalState: "ACTIVE" as const,
      lastTickAt: nowMs,
    };
    this.symbols.set(symbol, next);
    this.forensic({
      ...this.base(next, symbol, nowMs),
      type: "STATE_TRANSITION",
      from: lifecycle.globalState,
      to: "ACTIVE",
      reason: "real user position confirmed",
    });
  }

  /** Explicit CANCEL, callable from EPISODE_TRACKING through
   *  ENTRY_READY. Also the resolution path for ENTRY_READY-with-no-
   *  real-position (observational-only, all users disabled, all
   *  executions failed). */
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
    const wasOwned = this.ownership.isOwned(symbol);
    if (wasOwned) this.ownership.release(symbol);
    this.symbols.delete(symbol);
    this.forensic({
      ...this.base(lifecycle, symbol, nowMs),
      type: "EPISODE_TERMINAL",
      reason: reasonCode,
      detail,
      lifetimeMs: nowMs - lifecycle.episode.firstLiqTs,
      finalTotalLiqUsd: lifecycle.episode.sameDirectionLiqUsd,
      finalPercentileRank: lifecycle.watchResult?.qualifies
        ? lifecycle.watchResult.episodePercentileRank
        : null,
      finalExtreme: lifecycle.episode.extremePrice,
      lastMeaningfulProgressAt: lifecycle.lastMeaningfulProgressAt,
      symbolReleased: wasOwned || lifecycle.globalState === "EPISODE_TRACKING",
    });
  }

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
