import type { Side, Candle } from "../../shared/common.types";
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
import type { EntryGateResult } from "./entry-gate-pipeline";
import {
  advanceEpisodeEndDetection,
  initEpisodeEndDetectionState,
  passesRecoveryFractionGate,
  type EpisodeEndDetectionState,
  type AtrLookup,
} from "./episode-end-detector";
import { evaluatePostEpisodeOiCreation } from "./post-episode-oi-creation";
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

/** Sep 17 2026 (Karo), operator-requested CRITICAL FIX -- confirmed live
 *  production root cause of an OOM crash-loop (PM2 restart count 100,
 *  "JavaScript heap out of memory"). noSignalLog/oppositeEventIgnoredLog
 *  previously grew without bound for the entire process lifetime --
 *  onTick() is bookTicker-driven (not throttled to 1/sec) and pushes a
 *  NoSignalEvent on essentially every tick for any symbol with a
 *  tracked-but-unqualified episode. This bounded ring buffer preserves
 *  the SAME public read API (getNoSignalLog/getOppositeEventIgnoredLog
 *  both still return a plain array, tests unaffected) while capping
 *  memory at a fixed, conservative size, drop-oldest. Structured
 *  forensic logging (forensic-events.ts) is the primary production
 *  observability mechanism now -- these two logs remain for
 *  test/debug convenience only, per the operator's own explicit
 *  instruction to preserve that access rather than remove them. */
const DIAGNOSTIC_LOG_MAX_SIZE = 500; // conservative, UNTUNED -- a mechanical safety bound, not a strategy parameter

class BoundedLog<T> {
  private readonly items: T[] = [];
  constructor(private readonly maxSize: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.maxSize) this.items.shift();
  }
  toArray(): readonly T[] {
    return this.items;
  }
}

interface SymbolLifecycle {
  episodeId: string;
  ownershipId: string;
  /** Sep 17 2026 (Karo), operator-reported CRITICAL LIVE BUG FIX.
   *  Root cause of the ETHUSDT PAPER signal (lox-sig-1789639397924-
   *  i4yq1asq) getting stuck ACTIVE forever, TP and SL both silently
   *  ignored: this field DID NOT EXIST before this fix. onTick()'s
   *  own ACTIVE branch needed the Mongo document id to call
   *  activeMainRuntime.onActiveTick(symbol, globalSignalId, ...), but
   *  had nothing on SymbolLifecycle to read it from -- so it read
   *  `before.ownershipId` instead (a COMPLETELY DIFFERENT id scheme,
   *  from symbol-ownership.ts's own makeOwnershipId(), never equal to
   *  a real globalSignalId). Every onActiveTick() call, for every
   *  ACTIVE signal that has ever existed, therefore called
   *  globalSignalRepo.findSignal(<wrong id>), which always returned
   *  null, which made onActiveTick() return on its very first line --
   *  strategy invalidation, paper TP hits, OI efficiency, dynamic TP,
   *  ALL of it silently never ran, for every single ACTIVE signal.
   *  null until confirmActivePosition()/restoreActiveLifecycle() sets
   *  it (there is nothing to set before ACTIVE is actually reached). */
  globalSignalId: string | null;
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
  /** Sep 17 2026 (Karo), operator-approved lifecycle correction --
   *  causal, candle-driven episode-end detection state (see
   *  episode-end-detector.ts). Only meaningful while globalState is
   *  EXHAUSTION_CANDIDATE; null before that. */
  episodeEndDetection: EpisodeEndDetectionState | null;
  /** Frozen the instant EPISODE_END_CONFIRMED fires -- the baseline
   *  everything in WAIT_FOR_POST_EPISODE_OI_CREATION is measured
   *  against. Never mutated afterward. */
  episodeEndOiQuantity: number | null;
  episodeEndPrice: number | null;
  episodeEndTime: number | null;
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
  private readonly noSignalLog = new BoundedLog<NoSignalEvent>(
    DIAGNOSTIC_LOG_MAX_SIZE,
  );
  private readonly oppositeEventIgnoredLog =
    new BoundedLog<OppositeEventIgnoredEvent>(DIAGNOSTIC_LOG_MAX_SIZE);

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
    return this.noSignalLog.toArray();
  }
  getOppositeEventIgnoredLog(): readonly OppositeEventIgnoredEvent[] {
    return this.oppositeEventIgnoredLog.toArray();
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
        globalSignalId: null,
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
        episodeEndDetection: null,
        episodeEndOiQuantity: null,
        episodeEndPrice: null,
        episodeEndTime: null,
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
    new1mCandles: readonly Candle[] = [],
    all3mCandlesSorted: readonly Candle[] = [],
    atrLookup: AtrLookup | null = null,
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
        // Sep 17 2026 (Karo), operator-requested fix -- NO lifecycle may
        // disappear silently. Previously this branch deleted the map
        // entry directly, bypassing noSignalLog/oppositeEventIgnoredLog
        // and every forensic EPISODE_TERMINAL event -- the one
        // termination path in this class with zero observability.
        // Deliberately NOT routed through cancel(): this episode never
        // actually HELD global ownership (resolve() just told it "no"),
        // so calling cancel() here would incorrectly call
        // ownership.release(symbol) and free the OTHER, legitimately-
        // owned episode's ownership out from under it. Replicates
        // cancel()'s own OBSERVABILITY (noSignalLog + forensic
        // EPISODE_TERMINAL) without its release side effect.
        // NOTE: given the direction-sticky internal-episode-ownership
        // fix (see onLiquidationEvent's own header comment), this
        // branch is CONFIRMED STRUCTURALLY UNREACHABLE from current
        // code -- SymbolOwnershipRegistry can only ever be asked to
        // resolve() the SAME single victim direction a symbol's one
        // internal lifecycle is tracking, since an opposite-victim
        // episode is never allowed to reach EPISODE_TRACKING (let
        // alone WATCH_QUALIFIED) while another is already alive. Fixed
        // defensively anyway, in case a future change reintroduces
        // reachability -- this must never again be a silent path.
        const reasonCode = "GLOBAL_OWNERSHIP_CONTENTION";
        const detail =
          "SymbolOwnershipRegistry.resolve() returned action=ignore -- another victim direction already holds global ownership for this symbol (should be structurally unreachable under direction-sticky internal ownership; hardened defensively). This episode's own attempted ownership is discarded WITHOUT releasing the other, legitimately-owned episode.";
        this.noSignalLog.push({
          symbol,
          victim: lifecycle.episode.victim,
          atStage: "WATCH",
          reasonCode,
          detail,
          timestamp: nowMs,
        });
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
          symbolReleased: false,
        });
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
        episodeEndDetection: initEpisodeEndDetectionState(
          lifecycle.episode.extremePrice,
          nowMs,
        ),
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
          `${sinceEnteredExhaustion}ms in EXHAUSTION_CANDIDATE (episode-end detection) without reaching EPISODE_END_CONFIRMED, exceeds entryWindowTimeoutMs=${this.config.entryWindowTimeoutMs}ms`,
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

      // Sep 17 2026 (Karo), operator-approved lifecycle correction --
      // EPISODE END is now decided ENTIRELY by causal closed-candle
      // price/ATR structure (the ported DISPLACEMENT_BALANCED state
      // machine), NEVER by OI. oiHistory/atr3m/atr3mAgeMs are not
      // referenced anywhere in this branch anymore.
      if (atrLookup === null || lifecycle.episodeEndDetection === null) {
        // No candle/ATR data available yet this tick -- nothing to
        // advance; remain EXHAUSTION_CANDIDATE and wait for the next
        // tick that supplies it. Never a reason to cancel.
        this.symbols.set(symbol, { ...lifecycle, lastTickAt: nowMs });
        return;
      }
      const advance = advanceEpisodeEndDetection(
        lifecycle.episodeEndDetection,
        lifecycle.episode.victim,
        new1mCandles,
        all3mCandlesSorted,
        atrLookup,
      );

      if (advance.extremeUpdated) {
        this.forensic({
          ...this.base(lifecycle, symbol, nowMs),
          type: "EXTREME_UPDATE",
          previousExtreme: lifecycle.episodeEndDetection.extreme,
          newExtreme: advance.state.extreme,
          extensionPrice: Math.abs(
            advance.state.extreme - lifecycle.episodeEndDetection.extreme,
          ),
          extensionAtr:
            atr3m !== null && atr3m > 0
              ? Math.abs(
                  advance.state.extreme - lifecycle.episodeEndDetection.extreme,
                ) / atr3m
              : null,
          meaningfulExtremeProgress: true,
        } as unknown as ForensicEvent);
      }
      if (advance.candidateStarted) {
        this.forensic({
          ...this.base(lifecycle, symbol, nowMs),
          type: "STATE_TRANSITION",
          from: "EXHAUSTION_CANDIDATE",
          to: "EXHAUSTION_CANDIDATE",
          reason: `1M_RECOVERY_CANDIDATE at ${advance.state.candidateTime}`,
        } as unknown as ForensicEvent);
      }
      if (advance.candidateInvalidated && !advance.confirmed) {
        this.forensic({
          ...this.base(lifecycle, symbol, nowMs),
          type: "STATE_TRANSITION",
          from: "EXHAUSTION_CANDIDATE",
          to: "EXHAUSTION_CANDIDATE",
          reason:
            "RECOVERY_INVALIDATED -- new adverse extreme or 3m confirmation failed, still watching for episode end",
        } as unknown as ForensicEvent);
      }

      if (!advance.confirmed) {
        this.symbols.set(symbol, {
          ...lifecycle,
          episodeEndDetection: advance.state,
          lastTickAt: nowMs,
        });
        return;
      }

      const atr3mAtConfirm = atrLookup.get("3m", advance.confirmedAtCloseTime!);
      const fractionOk = passesRecoveryFractionGate(
        lifecycle.episode.victim,
        lifecycle.episode.startPrice,
        advance.state.extreme,
        advance.confirmedPrice!,
        atr3mAtConfirm,
      );
      if (!fractionOk) {
        // 3m ATR condition passed but the recovery-fraction gate
        // (30% of episode displacement, active only once displacement
        // >= 1.0x ATR3m) did not -- treat exactly like any other
        // RECOVERY_INVALIDATED: clear the candidate, keep watching.
        this.symbols.set(symbol, {
          ...lifecycle,
          episodeEndDetection: { ...advance.state, candidateTime: null },
        });
        return;
      }

      // EPISODE_END_CONFIRMED. Freeze the causal OI baseline (most
      // recent OI sample available at this exact moment -- never a
      // future sample) and transition to WAIT_FOR_POST_EPISODE_OI_CREATION.
      // Per the operator's own explicit requirement: this is NOT entry,
      // and there is deliberately NO timeout applied to the new state.
      const mostRecentOi =
        oiHistory.length > 0
          ? oiHistory.reduce((a, b) => (a.fetchedAt > b.fetchedAt ? a : b))
          : null;
      this.assertTransition(
        "EXHAUSTION_CANDIDATE",
        "WAIT_FOR_POST_EPISODE_OI_CREATION",
        symbol,
      );
      const next: SymbolLifecycle = {
        ...lifecycle,
        globalState: "WAIT_FOR_POST_EPISODE_OI_CREATION",
        episodeEndDetection: advance.state,
        episodeEndOiQuantity: mostRecentOi?.contracts ?? null,
        episodeEndPrice: advance.confirmedPrice!,
        episodeEndTime: advance.confirmedAtCloseTime!,
        lastTickAt: nowMs,
      };
      this.symbols.set(symbol, next);
      this.forensic({
        ...this.base(next, symbol, nowMs),
        type: "STATE_TRANSITION",
        from: "EXHAUSTION_CANDIDATE",
        to: "WAIT_FOR_POST_EPISODE_OI_CREATION",
        reason: `EPISODE_END_CONFIRMED at ${advance.confirmedAtCloseTime}, price=${advance.confirmedPrice}, episodeEndOiQuantity=${mostRecentOi?.contracts ?? "null"}`,
      });
      return;
    }

    if (lifecycle.globalState === "WAIT_FOR_POST_EPISODE_OI_CREATION") {
      // Sep 17 2026 (Karo), operator-requested -- deliberately NO
      // timeout/staleness cancellation in this state (beyond the
      // existing generic marketDataStaleTimeoutMs/preEntryFailsafe
      // checks already applied above, unconditionally, for every
      // pre-ACTIVE state). This state may legitimately persist across
      // many 1m candles (the XRP-type delayed OI creation case).
      const candidateSide = candidateTradeSideForVictim(
        lifecycle.episode.victim,
      );
      const mostRecentOi =
        oiHistory.length > 0
          ? oiHistory.reduce((a, b) => (a.fetchedAt > b.fetchedAt ? a : b))
          : null;
      const result = evaluatePostEpisodeOiCreation({
        candidateSide,
        episodeEndOiQuantity: lifecycle.episodeEndOiQuantity,
        currentOiQuantity: mostRecentOi?.contracts ?? null,
        episodeStartOiQuantity: lifecycle.episode.startOiQuantity,
        episodeMinOiQuantity: lifecycle.episode.minOiQuantity,
        episodeEndPrice: lifecycle.episodeEndPrice!,
        currentPrice,
        atr3m,
      });

      if (result.reasonCode !== lifecycle.lastLoggedEntryReasonCode) {
        this.forensic({
          ...this.base(lifecycle, symbol, nowMs),
          type: "ENTRY_GATE_EVALUATION",
          atrReady: {
            pass: atr3m !== null && atr3m > 0,
            detail: `atr3m=${atr3m}`,
          },
          oiFresh: {
            pass: mostRecentOi !== null,
            detail:
              mostRecentOi !== null
                ? `age=${nowMs - mostRecentOi.fetchedAt}ms`
                : "no OI sample",
          },
          clearing: {
            pass: true,
            detail: "N/A -- clearing OI is not part of the entry gate anymore",
          },
          counterMove: { pass: result.qualifies, detail: result.detail },
          distanceFromExtreme: {
            pass: true,
            detail:
              "N/A -- see capacity model for the existing distanceFromExtreme use",
          },
          final: result.qualifies ? "ENTRY_READY" : "NO_ENTRY",
          blockedBy: result.qualifies ? [] : [result.reasonCode!],
        } as unknown as ForensicEvent);
      }

      if (!result.qualifies) {
        this.noSignalLog.push({
          symbol,
          victim: lifecycle.episode.victim,
          atStage: "ENTRY",
          reasonCode: result.reasonCode ?? "UNKNOWN",
          detail: result.detail,
          timestamp: nowMs,
        });
        this.symbols.set(symbol, {
          ...lifecycle,
          lastTickAt: nowMs,
          lastLoggedEntryReasonCode: result.reasonCode,
        });
        return;
      }

      // POST_EPISODE_OI_CREATION_CONFIRMED -> ENTRY_READY. entryResult
      // is populated in the SAME shape entry-gate-pipeline.ts's
      // EntryGateSuccess used, so every existing downstream reader
      // (capacity model, Telegram, sizing) keeps working unchanged --
      // counterMoveAtr is now the POST-EPISODE favorable price move
      // (not the old counter-move-from-liquidation-extreme), and
      // distanceFromExtremeAtr is kept as distance from the episode's
      // own liquidation extreme (unchanged meaning, still feeding the
      // existing, not-yet-redesigned capacity/TP model per the
      // operator's own explicit instruction not to touch TP yet).
      const distanceFromExtremeAtr =
        atr3m !== null && atr3m > 0
          ? Math.abs(currentPrice - lifecycle.episode.extremePrice) / atr3m
          : 0;
      const entryResult: EntryGateResult = {
        entryReady: true,
        candidateSide,
        clearingState: {
          windows: [],
          peakDestructionSlopeContractsPerSec: null,
          isDecelerating: null,
          isStabilizing: null,
          hasEarlyRebuildSign: null,
          windowsShowingClearing: 0,
          mostRecentSampleAgeMs:
            mostRecentOi !== null ? nowMs - mostRecentOi.fetchedAt : null,
        },
        counterMoveAtr: result.favorablePriceMoveAtr ?? 0,
        distanceFromExtremeAtr,
      };
      this.assertTransition(
        "WAIT_FOR_POST_EPISODE_OI_CREATION",
        "ENTRY_READY",
        symbol,
      );
      const next: SymbolLifecycle = {
        ...lifecycle,
        globalState: "ENTRY_READY",
        entryResult,
        lastTickAt: nowMs,
        lastLoggedEntryReasonCode: null,
      };
      this.symbols.set(symbol, next);
      this.forensic({
        ...this.base(next, symbol, nowMs),
        type: "STATE_TRANSITION",
        from: "WAIT_FOR_POST_EPISODE_OI_CREATION",
        to: "ENTRY_READY",
        reason: `POST_EPISODE_OI_CREATION_CONFIRMED: ${result.detail}`,
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
        counterMoveAtr: entryResult.counterMoveAtr,
        distanceFromExtremeAtr: entryResult.distanceFromExtremeAtr,
      });
      return;
    }
  }

  /** Sep 16 2026 (Karo), operator-requested. The ONLY path to ACTIVE.
   *  Sep 17 2026 (Karo), operator-reported CRITICAL FIX -- now takes
   *  globalSignalId explicitly and stores it on the lifecycle (see
   *  SymbolLifecycle's own doc comment on this field for the full
   *  root-cause story). */
  confirmActivePosition(
    symbol: string,
    globalSignalId: string,
    nowMs: number,
  ): void {
    const lifecycle = this.symbols.get(symbol);
    if (lifecycle === undefined) return;
    this.assertTransition(lifecycle.globalState, "ACTIVE", symbol);
    const next = {
      ...lifecycle,
      globalSignalId,
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

  /** Sep 17 2026 (Karo), operator-requested Section O. The ONLY path
   *  from ACTIVE onward -- previously CLOSING/CLOSED were defined in
   *  lifecycle.types.ts but structurally unreachable from any code
   *  path (confirmed by the prior source audit). Called by the
   *  position-lifecycle service ONLY once isGlobalCloseEligible()
   *  confirms every user is TERMINAL, every cleanup COMPLETE, and no
   *  unresolved strategy order remains -- this method itself does NOT
   *  re-check those conditions, it trusts the caller, matching
   *  SymbolOwnershipRegistry.release()'s own existing doc comment
   *  ("the orchestrator is responsible for calling this only at the
   *  correct moment"). Transitions straight ACTIVE -> CLOSING -> CLOSED
   *  in one call (mirrors the existing EPISODE_TRACKING -> WATCH_QUALIFIED
   *  -> EXHAUSTION_CANDIDATE double-transition pattern), releases
   *  ownership, and deletes the lifecycle entry so the symbol is
   *  immediately available for a fresh, independent episode. */
  closeActive(symbol: string, reason: string, nowMs: number): void {
    const lifecycle = this.symbols.get(symbol);
    if (lifecycle === undefined || lifecycle.globalState !== "ACTIVE") return;
    this.assertTransition("ACTIVE", "CLOSING", symbol);
    this.assertTransition("CLOSING", "CLOSED", symbol);
    const wasOwned = this.ownership.isOwned(symbol);
    if (wasOwned) this.ownership.release(symbol);
    this.forensic({
      ...this.base(lifecycle, symbol, nowMs),
      type: "EPISODE_TERMINAL",
      reason,
      detail: `global lifecycle closed: ${reason}`,
      lifetimeMs: nowMs - lifecycle.episode.firstLiqTs,
      finalTotalLiqUsd: lifecycle.episode.sameDirectionLiqUsd,
      finalPercentileRank: lifecycle.watchResult?.qualifies
        ? lifecycle.watchResult.episodePercentileRank
        : null,
      finalExtreme: lifecycle.episode.extremePrice,
      lastMeaningfulProgressAt: lifecycle.lastMeaningfulProgressAt,
      symbolReleased: wasOwned,
    });
    this.symbols.delete(symbol);
  }

  /** Sep 17 2026 (Karo), operator-requested CRITICAL restart-safety
   *  fix. Source audit confirmed: this class's own `symbols` map and
   *  SymbolOwnershipRegistry both start COMPLETELY EMPTY after every
   *  process restart (nothing previously called `hydrate()` on
   *  either) -- meaning a symbol with a genuinely still-ACTIVE global
   *  signal in Mongo was NOT locked in-memory post-restart, and a
   *  fresh liquidation event for that same symbol would start a
   *  competing episode. This method is the fix: called ONCE per
   *  symbol during restart recovery, for every global signal
   *  confirmed (after reconciliation) to still be genuinely ACTIVE,
   *  BEFORE any new WS liquidation event can be processed.
   *
   *  Reconstructs a MINIMAL, APPROXIMATE episode state -- exact
   *  original firstLiqTs/eventCount/OI history are not persisted on
   *  the global signal doc and are NOT reconstructed here (nothing
   *  reads them again once a symbol is ACTIVE -- see onTick's own
   *  unconditional early-return for ACTIVE/CLOSING/CLOSED). The ONLY
   *  purpose of this reconstruction is correct symbol locking
   *  (isSymbolOwned() / onLiquidationEvent's own existing-lifecycle
   *  branch) and a valid forensic base for any FUTURE closeActive()
   *  call -- not historical fidelity. */
  restoreActiveLifecycle(
    symbol: string,
    globalSignalId: string,
    ownershipId: string,
    victim: Side,
    sameDirectionLiqUsd: number,
    extremePrice: number,
    nowMs: number,
  ): void {
    if (this.symbols.has(symbol)) return; // never overwrite a genuinely live in-memory lifecycle
    const episode: LiquidationOiEpisodeState = {
      symbol,
      victim,
      firstLiqTs: nowMs,
      latestLiqTs: nowMs,
      eventCount: 1,
      sameDirectionLiqUsd,
      startPrice: extremePrice,
      extremePrice,
      extremeTs: nowMs,
      startOiQuantity: null,
      currentOiQuantity: null,
      currentOiTs: null,
      minOiQuantity: null,
      minOiTs: null,
    };
    const lifecycle: SymbolLifecycle = {
      episodeId: globalSignalId,
      ownershipId,
      globalSignalId,
      globalState: "ACTIVE",
      episode,
      watchResult: null,
      entryResult: null,
      enteredExhaustionCandidateAt: null,
      lastTickAt: nowMs,
      lastMeaningfulProgressAt: nowMs,
      liqUsdAtLastMeaningfulProgress: sameDirectionLiqUsd,
      extremeAtLastMeaningfulProgress: extremePrice,
      minOiAtLastMeaningfulProgress: null,
      lastLoggedWatchReasonCode: null,
      lastLoggedEntryReasonCode: null,
      lastLoggedClearingResult: null,
      episodeEndDetection: null,
      episodeEndOiQuantity: null,
      episodeEndPrice: null,
      episodeEndTime: null,
    };
    this.symbols.set(symbol, lifecycle);
    this.ownership.hydrate(symbol, ownershipId, victim);
    this.forensic({
      ...this.base(lifecycle, symbol, nowMs),
      type: "RESTART_RECONCILIATION",
      outcome: "ACTIVE_LIFECYCLE_RESTORED",
      detail: `symbol locked in-memory after restart, ownershipId=${ownershipId}`,
    } as unknown as ForensicEvent);
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
