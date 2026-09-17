import type { Side } from "../shared/common.types";
import { LiquidationOiWatchManager } from "../domain/liquidation-oi-strategy/liquidation-oi-watch-manager";
import type { LiquidationOiEventInput } from "../domain/liquidation-oi-strategy/episode-tracker";
import type {
  EpisodePercentileContext,
  WatchQualificationResult,
} from "../domain/liquidation-oi-strategy/watch-qualification";
import type { OiHistorySample } from "../domain/liquidation-oi-strategy/oi-clearing-detector";
import type { LiquidationOiStrategyConfig } from "../domain/liquidation-oi-strategy/config";
import {
  computeInitialCapacity,
  initialTpPrice,
  type CapacityModelCoefficients,
} from "../domain/liquidation-oi-strategy/initial-capacity-model";
import { computePositionSizing } from "../domain/liquidation-oi-strategy/sizing-adapter";
import { candidateTradeSideForVictim } from "../domain/liquidation-oi-strategy/lifecycle.types";
import {
  newPendingUserExecution,
  type LiquidationOiUserExecutionState,
} from "../domain/liquidation-oi-strategy/user-execution.types";
import {
  runEntrySequence,
  type BinanceRestLike,
} from "../infrastructure/binance/liquidation-oi-user-execution.service";
import { LiquidationOiGlobalSignalRepository } from "../infrastructure/mongo/liquidation-oi-global-signal.repository";
import { StrategyOrderRepository } from "../infrastructure/mongo/strategy-order.repository";
import {
  captureOrderBookObservation,
  type OrderBookObservation,
  type WallLookup,
} from "../domain/liquidation-oi-strategy/order-book-observation";
import {
  DEFAULT_ACTIVE_LIFECYCLE_CONFIG,
  type LiquidationOiActiveLifecycleConfig,
} from "../domain/liquidation-oi-strategy/active-lifecycle-config";
import { formatEntryMessage } from "../domain/liquidation-oi-strategy/telegram-formatter";
import { sendTelegramWithRetry } from "../domain/liquidation-oi-strategy/telegram-send-retry";
import {
  displayNameFromUserId,
  formatCompactUsd,
} from "../domain/liquidation-oi-strategy/telegram-display-format";
import { resolveUserExecutionMode } from "../domain/liquidation-oi-strategy/user-execution-mode";
import type { LiquidationOiActiveMainRuntime } from "./liquidation-oi-active-main-runtime.service";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "lox-runtime" });

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 5-7.
 *
 * ENABLEMENT (mirrors MarketDataOrchestrator's own existing
 * productionSignalsEnabled constructor-default pattern, no
 * environment variable):
 *   - observationEnabled: default true. Controls whether liquidation
 *     events/ticks reach LiquidationOiWatchManager at all. When
 *     false, this class is completely inert.
 *   - executionEnabled: default FALSE. Controls whether ENTRY_READY
 *     triggers ANY Binance call. When false, every user's execution
 *     stops after computing sizing and persisting a PENDING record --
 *     runEntrySequence() is never invoked, so no REST call to place
 *     an order can occur. This is the deployment default.
 *
 * Both are plain constructor parameters, not read from any env var --
 * main.ts's own construction call site is where an operator would
 * explicitly pass `true` for executionEnabled later.
 */

export interface LiquidationOiUserRuntimeRef {
  userId: string;
  riskUsd: number;
  /** Sep 16 2026 (Karo), operator-requested -- PER-USER real-execution
   *  gate, sourced from that user's own UserConfig.liquidationOiExecutionEnabled
   *  (users.config.loader.ts, defaults false when absent). This is
   *  the SECOND of two required gates -- see executeForUser()'s own
   *  gating logic below for how it combines with the constructor-level
   *  executionEnabled master switch. */
  liquidationOiExecutionEnabled: boolean;
  binanceRest: BinanceRestLike | null;
  telegram: { sendMessage(text: string): Promise<unknown> } | null;
}

/** Sep 16 2026 (Karo), operator-requested. What one user's fan-out
 *  attempt resolved to -- used ONLY to decide, after the whole
 *  fan-out completes, whether the GLOBAL lifecycle resolves to ACTIVE
 *  (>=1 manageable user, PAPER or REAL) or a specific no-position
 *  CANCELLED reason. Sep 17 2026 (Karo), operator-requested CRITICAL
 *  FIX: PAPER_ACTIVE added and counted as manageable -- a market
 *  signal must not become CANCELLED merely because real execution was
 *  off; PAPER is a complete virtual lifecycle, not "nothing". */
type UserFanOutOutcome =
  | "ACTIVE"
  | "PAPER_ACTIVE"
  | "ALREADY_ACTIVE"
  | "ALREADY_TERMINAL"
  | "USER_DISABLED"
  | "FAILED";

const STRUCTURAL_INVALIDATION_BUFFER_ATR = 0.1; // UNTUNED -- small noise/execution buffer beyond the episode's own extreme

export class LiquidationOiRuntimeOrchestrator {
  private readonly watchManager: LiquidationOiWatchManager;

  constructor(
    private readonly strategyConfig: LiquidationOiStrategyConfig,
    private readonly capacityCoeffs: CapacityModelCoefficients,
    private readonly globalSignalRepo: LiquidationOiGlobalSignalRepository,
    private readonly strategyOrderRepo: StrategyOrderRepository,
    private readonly getUserRuntimes: () => readonly LiquidationOiUserRuntimeRef[],
    private readonly observationEnabled: boolean = true,
    private readonly executionEnabled: boolean = false,
    private readonly makeGlobalSignalId: () => string = () =>
      `lox-sig-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    /** Sep 16 2026 (Karo), operator-requested forensic observability
     *  -- strictly additive, default no-op. Threaded into the watch
     *  manager (which owns most emissions) and used here only for
     *  ENTRY_READY_RESOLUTION, since the fan-out outcome data lives
     *  in this class, not the watch manager. */
    private readonly forensic: (
      event: import("../domain/liquidation-oi-strategy/forensic-events").ForensicEvent,
    ) => void = () => {},
    /** Sep 17 2026 (Karo), operator-requested production-completion
     *  pass -- optional, default no-op, settable late via
     *  setActiveMainRuntime() to break the circular dependency
     *  (LiquidationOiActiveMainRuntime needs this orchestrator's OWN
     *  watchManager, which only exists after this constructor runs)
     *  -- mirrors the existing orchestratorPlaceholder pattern already
     *  used elsewhere in main.ts for the same class of dependency. */
    private activeMainRuntime: LiquidationOiActiveMainRuntime | null = null,
    private readonly activeLifecycleConfig: LiquidationOiActiveLifecycleConfig = DEFAULT_ACTIVE_LIFECYCLE_CONFIG,
  ) {
    this.watchManager = new LiquidationOiWatchManager(
      strategyConfig,
      undefined,
      undefined,
      forensic,
    );
    log.info(
      `[LOX_RUNTIME] constructed observationEnabled=${observationEnabled} executionEnabled=${executionEnabled}`,
    );
  }

  getWatchManager(): LiquidationOiWatchManager {
    return this.watchManager;
  }

  /** Sep 17 2026 (Karo), operator-requested. Late-binds the ACTIVE
   *  MAIN runtime after construction -- see the constructor param's
   *  own doc comment for why this is necessary. */
  setActiveMainRuntime(runtime: LiquidationOiActiveMainRuntime): void {
    this.activeMainRuntime = runtime;
  }

  onLiquidationEvent(
    event: LiquidationOiEventInput,
    oiAtEvent: { quantity: number; timestamp: number } | null,
  ): void {
    if (!this.observationEnabled) return;
    this.watchManager.onLiquidationEvent(event, oiAtEvent);
  }

  /** Reads OI history from the CALLER-supplied array -- this class
   *  never polls OI itself; the caller passes
   *  OiTrackerService.getOiHistory(symbol) directly. */
  async onTick(
    symbol: string,
    percentile: EpisodePercentileContext,
    oiHistory: readonly OiHistorySample[],
    currentPrice: number,
    atr3m: number | null,
    atr3mAgeMs: number | null,
    nowMs: number,
    bestBid: number | null = null,
    bestAsk: number | null = null,
    wallLookup: WallLookup | null = null,
  ): Promise<void> {
    if (!this.observationEnabled) return;
    const before = this.watchManager.getLifecycle(symbol);

    // Section J/K: ACTIVE symbols never re-enter watchManager.onTick() (it
    // early-returns for them by design), but MAIN's own post-entry
    // monitoring must still run every qualifying tick -- delegated to the
    // SAME existing tick, never a separate stream.
    if (
      before !== null &&
      before.globalState === "ACTIVE" &&
      this.activeMainRuntime !== null
    ) {
      // Sep 17 2026 (Karo), operator-reported CRITICAL LIVE BUG FIX --
      // this MUST be the real globalSignalId (the Mongo document id),
      // never ownershipId (a completely different id scheme from
      // symbol-ownership.ts). Passing the wrong id here made every
      // onActiveTick() call silently no-op forever (globalSignalRepo.
      // findSignal(<wrong id>) always returned null) -- see
      // SymbolLifecycle's own doc comment on the globalSignalId field
      // for the full root-cause trace. If this is ever null here
      // (should be structurally impossible -- confirmActivePosition
      // and restoreActiveLifecycle are the only two ways to reach
      // ACTIVE, and both now set it), skip the tick rather than call
      // onActiveTick with a null id.
      if (before.globalSignalId === null) {
        log.error(
          `[LOX_ACTIVE_TICK_MISSING_SIGNAL_ID] symbol=${symbol} -- ACTIVE lifecycle with no globalSignalId, structurally unexpected; skipping this tick`,
        );
        return;
      }
      const oiQty =
        oiHistory.length > 0
          ? oiHistory[oiHistory.length - 1]!.contracts
          : null;
      await this.activeMainRuntime.onActiveTick(
        symbol,
        before.globalSignalId,
        before.episodeId,
        candidateTradeSideForVictim(before.episode.victim),
        currentPrice,
        oiQty,
        atr3m,
        nowMs,
      );
      return;
    }

    this.watchManager.onTick(
      symbol,
      percentile,
      oiHistory,
      currentPrice,
      atr3m,
      atr3mAgeMs,
      nowMs,
    );
    const after = this.watchManager.getLifecycle(symbol);

    // Sep 17 2026 (Karo), operator-requested Section B -- WATCH Telegram
    // is REMOVED. WATCH state/qualification logic itself remains fully
    // operational and persisted/logged (forensic WATCH_EVALUATION events,
    // the state transition itself, everything downstream) -- only the
    // user-facing notification is suppressed. The first user-facing LOX
    // message is now ENTRY.

    if (
      before?.globalState !== "ENTRY_READY" &&
      after !== null &&
      after.globalState === "ENTRY_READY" &&
      atr3m !== null
    ) {
      const orderBook = captureOrderBookObservation(
        symbol,
        currentPrice,
        after.episode.extremePrice,
        atr3m,
        bestBid,
        bestAsk,
        wallLookup,
        this.activeLifecycleConfig,
        nowMs,
      );
      await this.handleEntryReady(
        symbol,
        after.ownershipId,
        after.episode,
        after.watchResult,
        currentPrice,
        atr3m,
        nowMs,
        orderBook,
        after.entryResult?.entryReady ? after.entryResult.counterMoveAtr : 0,
        after.entryResult?.entryReady
          ? after.entryResult.distanceFromExtremeAtr
          : 0,
      );
    }
  }

  private async handleEntryReady(
    symbol: string,
    ownershipId: string,
    episode: {
      victim: Side;
      extremePrice: number;
      sameDirectionLiqUsd: number;
      startOiQuantity: number | null;
      minOiQuantity: number | null;
    },
    watchResult: WatchQualificationResult | null,
    entryPrice: number,
    atr3m: number,
    nowMs: number,
    orderBook: OrderBookObservation | null,
    counterMoveAtr: number,
    distanceFromExtremeAtr: number,
  ): Promise<void> {
    if (watchResult === null || !watchResult.qualifies) return;
    const globalSignalId = this.makeGlobalSignalId();
    const candidateSide = candidateTradeSideForVictim(episode.victim);
    // Sep 17 2026 (Karo), operator-requested SEPARATION (source-audit
    // finding: these had collapsed into the same price). Two layers:
    // strategyInvalidationPrice (normal market-thesis level, used for
    // sizing) and emergencyHardStopPrice (catastrophe-only, explicitly
    // FURTHER from entry than strategyInvalidationPrice by
    // emergencyHardStopBufferAtrMultiple -- an ADDITIONAL buffer, not
    // a replacement).
    const strategyInvalidationPrice =
      candidateSide === "LONG"
        ? episode.extremePrice - atr3m * STRUCTURAL_INVALIDATION_BUFFER_ATR
        : episode.extremePrice + atr3m * STRUCTURAL_INVALIDATION_BUFFER_ATR;
    const emergencyHardStopPrice =
      candidateSide === "LONG"
        ? strategyInvalidationPrice -
          atr3m * this.strategyConfig.emergencyHardStopBufferAtrMultiple
        : strategyInvalidationPrice +
          atr3m * this.strategyConfig.emergencyHardStopBufferAtrMultiple;

    const capacity = computeInitialCapacity(
      {
        episodePercentileRank: watchResult.episodePercentileRank,
        oiDestructionFraction: watchResult.oiDestructionFractionAtQualification,
        displacementAtr: watchResult.displacementAtr,
        liquidationToOiRatio: watchResult.liquidationToOiRatio,
      },
      this.capacityCoeffs,
    );
    const tpPrice = initialTpPrice(
      entryPrice,
      atr3m,
      candidateSide,
      capacity.initialCapacityAtr,
    );

    // Sep 17 2026 (Karo), operator-requested Section I -- OI metric shown
    // at ENTRY. CAUSALLY available at this exact moment from the
    // episode's own state (startOiQuantity, minOiQuantity, both already
    // tracked from the first liquidation event onward -- see
    // episode-tracker.ts) -- nothing invented. USD figure is the
    // destroyed-OI-in-contracts converted at the current entry price
    // (the only price available at this instant; not a separate OI-price
    // history, which this codebase does not track per-sample). Fraction
    // reuses watchResult.oiDestructionFractionAtQualification, the SAME
    // value already computed for WATCH qualification -- not recomputed
    // differently here.
    let oiMetricLine: string | null = null;
    if (
      episode.startOiQuantity !== null &&
      episode.minOiQuantity !== null &&
      watchResult.oiDestructionFractionAtQualification !== null
    ) {
      const destroyedUsd =
        (episode.startOiQuantity - episode.minOiQuantity) * entryPrice;
      if (destroyedUsd > 0) {
        oiMetricLine = `\ud83d\udcca OI Clear  -${formatCompactUsd(destroyedUsd)}  (-${(watchResult.oiDestructionFractionAtQualification * 100).toFixed(2)}%)`;
      }
    }

    log.info(
      `[LOX_ENTRY_READY] ${symbol} ${candidateSide} globalSignalId=${globalSignalId} entry=${entryPrice} strategyInvalidation=${strategyInvalidationPrice} emergencyHardStop=${emergencyHardStopPrice} capacityAtr=${capacity.initialCapacityAtr} tp=${tpPrice} components=${JSON.stringify(capacity.components)}`,
    );

    // Sep 16 2026 (Karo), operator-requested lifecycle fix: the
    // persisted signal starts at ENTRY_READY, NOT ACTIVE -- ACTIVE is
    // earned only once the fan-out below confirms a real position,
    // mirroring exactly what confirmActivePosition()/cancel() do to
    // the in-memory LiquidationOiWatchManager. ENTRY_READY must never
    // by itself imply ACTIVE, for either the in-memory lifecycle or
    // its persisted record.
    await this.globalSignalRepo.upsertSignal({
      globalSignalId,
      symbol,
      victim: episode.victim,
      candidateSide,
      state: "ENTRY_READY",
      ownershipId,
      episodePercentileRank: watchResult.episodePercentileRank,
      sameDirectionLiqUsd: episode.sameDirectionLiqUsd,
      extremePrice: episode.extremePrice,
      entryPrice,
      strategyInvalidationPrice,
      emergencyHardStopPrice,
      initialCapacityAtr: capacity.initialCapacityAtr,
      initialTpPrice: tpPrice,
      tpRevision: 0,
      currentTargetPrice: tpPrice,
      orderBookAtEntryReady: orderBook,
    });

    // Sep 17 2026 (Karo), operator-requested REMOVAL of the old
    // pre-fan-out "ENTRY_READY" broadcast: each user now receives their
    // own PAPER or REAL "ENTRY" Telegram (formatPaperEntryMessage /
    // formatRealEntryMessage), sent from executeForUser() below, AFTER
    // their mode has actually resolved -- per the operator's own
    // explicit instruction not to call it ENTRY_READY in user-facing
    // Telegram once a position (paper or real) has actually been
    // created. The WATCH message (sendWatchTelegram, above) remains
    // the pre-entry observational broadcast.
    const outcomes: UserFanOutOutcome[] = [];
    for (const runtime of this.getUserRuntimes()) {
      try {
        outcomes.push(
          await this.executeForUser(
            runtime,
            symbol,
            globalSignalId,
            candidateSide,
            entryPrice,
            strategyInvalidationPrice,
            emergencyHardStopPrice,
            tpPrice,
            watchResult.episodePercentileRank,
            episode.sameDirectionLiqUsd,
            counterMoveAtr,
            orderBook,
            oiMetricLine,
            nowMs,
          ),
        );
      } catch (err) {
        outcomes.push("FAILED");
        log.error(
          {
            userId: runtime.userId,
            symbol,
            globalSignalId,
            err: err instanceof Error ? err.message : String(err),
          },
          "[LOX_USER_EXECUTION_UNEXPECTED_ERROR] -- isolated, other users unaffected",
        );
      }
    }

    // Sep 17 2026 (Karo), operator-requested CRITICAL FIX: a manageable
    // user is now ACTIVE (real Binance position) OR PAPER_ACTIVE (a
    // complete virtual lifecycle) -- the global signal must NOT become
    // CANCELLED merely because real execution was off for every user.
    // MARKET SIGNAL and USER EXECUTION MODE are different concepts.
    const hasManageableUser = outcomes.some(
      (o) => o === "ACTIVE" || o === "ALREADY_ACTIVE" || o === "PAPER_ACTIVE",
    );
    const episodeIdForForensics =
      this.watchManager.getLifecycle(symbol)?.episodeId ?? "unknown";
    const enabledUsers = this.getUserRuntimes().length;
    if (hasManageableUser) {
      this.watchManager.confirmActivePosition(symbol, globalSignalId, nowMs);
      await this.globalSignalRepo.upsertSignal({
        globalSignalId,
        symbol,
        victim: episode.victim,
        candidateSide,
        state: "ACTIVE",
        ownershipId,
        episodePercentileRank: watchResult.episodePercentileRank,
        sameDirectionLiqUsd: episode.sameDirectionLiqUsd,
        extremePrice: episode.extremePrice,
        entryPrice,
        strategyInvalidationPrice,
        emergencyHardStopPrice,
        initialCapacityAtr: capacity.initialCapacityAtr,
        initialTpPrice: tpPrice,
        tpRevision: 0,
        currentTargetPrice: tpPrice,
        orderBookAtEntryReady: orderBook,
      });
      this.forensic({
        ts: nowMs,
        symbol,
        episodeId: episodeIdForForensics,
        victim: episode.victim,
        state: "ACTIVE",
        episodeAgeSec: 0,
        type: "ENTRY_READY_RESOLUTION",
        observationEnabled: this.observationEnabled,
        globalExecutionEnabled: this.executionEnabled,
        eligibleUsers: outcomes.length,
        enabledUsers,
        attemptedUsers: outcomes.filter((o) => o !== "USER_DISABLED").length,
        activeUsers: outcomes.filter(
          (o) =>
            o === "ACTIVE" || o === "ALREADY_ACTIVE" || o === "PAPER_ACTIVE",
        ).length,
        failedUsers: outcomes.filter((o) => o === "FAILED").length,
        resolution: "ACTIVE",
        terminalReason: null,
      });
      log.info(
        `[LOX_GLOBAL_ACTIVE] ${symbol} globalSignalId=${globalSignalId} -- at least one manageable user (real or paper) confirmed, symbol ownership retained`,
      );
      return;
    }

    const { code, detail } = this.resolveNoPositionReason(outcomes);
    this.watchManager.cancel(symbol, code, detail, nowMs);
    await this.globalSignalRepo.upsertSignal({
      globalSignalId,
      symbol,
      victim: episode.victim,
      candidateSide,
      state: "CANCELLED",
      ownershipId,
      episodePercentileRank: watchResult.episodePercentileRank,
      sameDirectionLiqUsd: episode.sameDirectionLiqUsd,
      extremePrice: episode.extremePrice,
      entryPrice,
      strategyInvalidationPrice,
      emergencyHardStopPrice,
      initialCapacityAtr: capacity.initialCapacityAtr,
      initialTpPrice: tpPrice,
      tpRevision: 0,
      currentTargetPrice: tpPrice,
      orderBookAtEntryReady: orderBook,
    });
    this.forensic({
      ts: nowMs,
      symbol,
      episodeId: episodeIdForForensics,
      victim: episode.victim,
      state: "CANCELLED",
      episodeAgeSec: 0,
      type: "ENTRY_READY_RESOLUTION",
      observationEnabled: this.observationEnabled,
      globalExecutionEnabled: this.executionEnabled,
      eligibleUsers: outcomes.length,
      enabledUsers,
      attemptedUsers: outcomes.filter((o) => o !== "USER_DISABLED").length,
      activeUsers: 0,
      failedUsers: outcomes.filter((o) => o === "FAILED").length,
      resolution: "CANCELLED",
      terminalReason: code,
    });
    log.info(
      `[LOX_GLOBAL_CANCELLED] ${symbol} globalSignalId=${globalSignalId} reason=${code} -- no manageable user resulted, symbol released for the next independent episode`,
    );
  }

  /** Sep 17 2026 (Karo), operator-requested REWRITE for the PAPER/REAL
   *  architecture -- this now ONLY fires when truly NO manageable user
   *  exists (no users configured at all, or every configured user has
   *  their OWN enabled=false). It is no longer reachable merely
   *  because real execution was off, since that case now resolves to
   *  PAPER_ACTIVE instead. */
  private resolveNoPositionReason(outcomes: readonly UserFanOutOutcome[]): {
    code: string;
    detail: string;
  } {
    if (outcomes.length === 0)
      return {
        code: "ENTRY_READY_NO_ELIGIBLE_USERS",
        detail: "no users were configured for fan-out",
      };
    const anyManageable = outcomes.some((o) => o !== "USER_DISABLED");
    if (!anyManageable)
      return {
        code: "ENTRY_READY_ALL_USERS_DISABLED",
        detail: "every configured user's own enabled=false",
      };
    return {
      code: "ENTRY_READY_ALL_EXECUTIONS_FAILED",
      detail: "at least one user was manageable but every attempt failed",
    };
  }

  private async executeForUser(
    runtime: LiquidationOiUserRuntimeRef,
    symbol: string,
    globalSignalId: string,
    side: Side,
    entryPrice: number,
    strategyInvalidationPrice: number,
    emergencyHardStopPrice: number,
    tpPrice: number,
    percentileRank: number,
    sameDirectionLiqUsd: number,
    counterMoveAtr: number,
    orderBook: OrderBookObservation | null,
    oiMetricLine: string | null,
    nowMs: number,
  ): Promise<UserFanOutOutcome> {
    const existing = await this.globalSignalRepo.findUserExecution(
      runtime.userId,
      globalSignalId,
    );
    if (existing !== null) {
      log.info(
        `[LOX_USER_EXECUTION_ALREADY_EXISTS] userId=${runtime.userId} globalSignalId=${globalSignalId} state=${existing.state} -- skipping, idempotent`,
      );
      if (existing.state === "ACTIVE")
        return existing.mode === "PAPER" ? "PAPER_ACTIVE" : "ALREADY_ACTIVE";
      return "ALREADY_TERMINAL";
    }

    // Sep 17 2026 (Karo), operator-requested CRITICAL architecture fix
    // -- see user-execution-mode.ts for the exact 4-row matrix. By the
    // time a runtime reaches this method it has already passed the
    // caller's own userConfig.enabled filter (see getUserRuntimes()
    // call sites in main.ts), so userConfigEnabled=true here always;
    // the two remaining gates (this user's own liquidationOiExecutionEnabled
    // and the GLOBAL executionEnabled master switch) decide PAPER vs REAL.
    const mode = resolveUserExecutionMode(
      true,
      runtime.liquidationOiExecutionEnabled,
      this.executionEnabled,
    );
    if (mode === "NONE") {
      // Structurally unreachable: getUserRuntimes() call sites already
      // filter to userConfig.enabled=true before this method is ever
      // called (see main.ts). Defensive only.
      log.error(
        `[LOX_UNEXPECTED_NONE_MODE] userId=${runtime.userId} symbol=${symbol} -- resolveUserExecutionMode returned NONE despite a runtime already being in the fan-out list; skipping defensively`,
      );
      return "USER_DISABLED";
    }

    // Sizing STILL uses strategyInvalidationPrice, unchanged (Section H).
    const sizing = computePositionSizing({
      entry: entryPrice,
      structuralInvalidationPrice: strategyInvalidationPrice,
      riskUsd: runtime.riskUsd,
    });
    let userExec = newPendingUserExecution(
      runtime.userId,
      globalSignalId,
      symbol,
      side,
      runtime.riskUsd,
      nowMs,
      mode,
    );
    if (!sizing.valid) {
      userExec = {
        ...userExec,
        state: "TERMINAL",
        terminalReason: "EXECUTION_FAILED",
        cleanupState: "COMPLETE",
        updatedAt: nowMs,
      };
      await this.globalSignalRepo.upsertUserExecution(userExec);
      log.warn(
        `[LOX_SIZING_FAILED] userId=${runtime.userId} symbol=${symbol} reason=${sizing.reason}`,
      );
      return "FAILED";
    }

    if (mode === "REAL") {
      // Sep 17 2026 (Karo), operator-requested safety constraint --
      // "If emergency protection would violate an explicit risk/safety
      // constraint, skip execution rather than silently taking larger
      // risk." Only meaningful for REAL mode, since PAPER never places
      // a real emergency stop and carries zero real capital risk.
      const estimatedEmergencyMaxLossUsd =
        Math.abs(entryPrice - emergencyHardStopPrice) * sizing.positionQty;
      const emergencyLossMultiple =
        estimatedEmergencyMaxLossUsd / runtime.riskUsd;
      if (
        emergencyLossMultiple >
        this.strategyConfig.maxEmergencyLossMultipleOfRiskUsd
      ) {
        userExec = {
          ...userExec,
          state: "TERMINAL",
          terminalReason: "EXECUTION_FAILED",
          cleanupState: "COMPLETE",
          updatedAt: nowMs,
        };
        await this.globalSignalRepo.upsertUserExecution(userExec);
        log.warn(
          `[LOX_EMERGENCY_RISK_CONSTRAINT_VIOLATED] userId=${runtime.userId} symbol=${symbol} estimatedEmergencyMaxLossUsd=${estimatedEmergencyMaxLossUsd.toFixed(2)} riskUsd=${runtime.riskUsd} multiple=${emergencyLossMultiple.toFixed(2)}x exceeds maxEmergencyLossMultipleOfRiskUsd=${this.strategyConfig.maxEmergencyLossMultipleOfRiskUsd}x -- skipping rather than silently accepting larger risk`,
        );
        return "FAILED";
      }
      userExec = {
        ...userExec,
        quantity: sizing.positionQty,
        positionSizeUsdt: sizing.positionSizeUsdt,
        estimatedStrategyLossUsd: runtime.riskUsd,
        estimatedEmergencyMaxLossUsd,
      };
      await this.globalSignalRepo.upsertUserExecution(userExec);

      if (runtime.binanceRest === null) {
        userExec = {
          ...userExec,
          state: "TERMINAL",
          terminalReason: "EXECUTION_FAILED",
          cleanupState: "COMPLETE",
          updatedAt: Date.now(),
        };
        await this.globalSignalRepo.upsertUserExecution(userExec);
        log.warn(
          `[LOX_NO_BINANCE_CLIENT] userId=${runtime.userId} symbol=${symbol} -- user has no configured Binance client`,
        );
        return "FAILED";
      }

      // Sep 17 2026 (Karo) -- the PHYSICAL Binance order is placed at
      // emergencyHardStopPrice (the wider, catastrophe-only level),
      // never at strategyInvalidationPrice.
      const outcome = await runEntrySequence(runtime.binanceRest, {
        userId: runtime.userId,
        globalSignalId,
        symbol,
        side,
        quantity: sizing.positionQty,
        entryPriceEstimate: entryPrice,
        emergencyStopPrice: emergencyHardStopPrice,
        initialTpPrice: tpPrice,
      });
      return await this.persistOutcome(
        userExec,
        outcome,
        symbol,
        side,
        strategyInvalidationPrice,
        emergencyHardStopPrice,
        tpPrice,
        percentileRank,
        sameDirectionLiqUsd,
        counterMoveAtr,
        orderBook,
        oiMetricLine,
        runtime,
      );
    }

    // Sep 17 2026 (Karo), operator-requested Section 2/3 -- PAPER mode.
    // A COMPLETE virtual lifecycle: entry, risk, TP, strategy SL, ACTIVE
    // state, MAIN monitoring (via LiquidationOiActiveMainRuntime, same
    // as REAL), causal virtual TP/SL detection, PnL, terminal reason,
    // Telegram, Mongo. The ONLY thing that never happens is a Binance
    // call -- confirmed structurally: this branch never references
    // runtime.binanceRest at all.
    userExec = {
      ...userExec,
      state: "ACTIVE",
      quantity: sizing.positionQty,
      positionSizeUsdt: sizing.positionSizeUsdt,
      estimatedStrategyLossUsd: runtime.riskUsd,
      entryPrice,
      tpPrice,
      appliedTpRevision: 0,
      updatedAt: nowMs,
    };
    await this.globalSignalRepo.upsertUserExecution(userExec);
    log.info(
      `[LOX_PAPER_ENTRY] userId=${runtime.userId} symbol=${symbol} ${side} entry=${entryPrice} qty=${sizing.positionQty} tp=${tpPrice} sl=${strategyInvalidationPrice} -- PAPER, zero Binance calls`,
    );
    if (runtime.telegram !== null) {
      try {
        const text = formatEntryMessage({
          symbol,
          candidateSide: side,
          mode: "PAPER",
          globalSignalId,
          entryTimestamp: userExec.createdAt,
          entryPrice,
          quantity: sizing.positionQty,
          riskUsd: runtime.riskUsd,
          tpPrice,
          strategyInvalidationPrice,
          emergencyHardStopPrice: null,
          sameDirectionLiqUsd,
          percentileRank,
          oiMetricLine,
          counterMoveAtr,
          orderBook,
          protectionConfirmed: null,
          displayName: displayNameFromUserId(runtime.userId),
        });
        await sendTelegramWithRetry(
          runtime.telegram,
          text,
          `PAPER_ENTRY userId=${runtime.userId} symbol=${symbol}`,
        );
      } catch (err) {
        log.error(
          {
            userId: runtime.userId,
            err: err instanceof Error ? err.message : String(err),
          },
          "[LOX_TELEGRAM_PAPER_ENTRY_SEND_FAILED] -- isolated, paper position already persisted",
        );
      }
    }
    return "PAPER_ACTIVE";
  }

  private async persistOutcome(
    userExec: LiquidationOiUserExecutionState,
    outcome: Awaited<ReturnType<typeof runEntrySequence>>,
    symbol: string,
    side: Side,
    strategyInvalidationPrice: number,
    emergencyHardStopPrice: number,
    tpPrice: number,
    percentileRank: number,
    sameDirectionLiqUsd: number,
    counterMoveAtr: number,
    orderBook: OrderBookObservation | null,
    oiMetricLine: string | null,
    runtime: LiquidationOiUserRuntimeRef,
  ): Promise<UserFanOutOutcome> {
    const now = Date.now();
    if (outcome.outcome === "ENTRY_FAILED") {
      await this.globalSignalRepo.upsertUserExecution({
        ...userExec,
        state: "TERMINAL",
        terminalReason: "EXECUTION_FAILED",
        cleanupState: "COMPLETE",
        updatedAt: now,
      });
      log.warn(
        `[LOX_ENTRY_FAILED] userId=${userExec.userId} symbol=${symbol} reason=${outcome.reason}`,
      );
      return "FAILED";
    }
    if (outcome.outcome === "PROTECTION_FAILED_CLOSED") {
      await this.strategyOrderRepo.upsert({
        userId: userExec.userId,
        globalSignalId: userExec.globalSignalId,
        symbol,
        purpose: "ENTRY",
        revision: 0,
        clientOrderId: outcome.entryClientOrderId,
        clientAlgoId: null,
        binanceOrderId: null,
        binanceAlgoId: null,
        state: "FILLED",
      });
      await this.globalSignalRepo.upsertUserExecution({
        ...userExec,
        state: "TERMINAL",
        terminalReason: "PROTECTION_FAILED",
        cleanupState: "COMPLETE",
        entryPrice: outcome.entryPrice,
        quantity: outcome.quantity,
        entryClientOrderId: outcome.entryClientOrderId,
        updatedAt: now,
      });
      log.error(
        `[LOX_PROTECTION_FAILED_CLOSED] userId=${userExec.userId} symbol=${symbol} -- position was opened and immediately fail-safe closed, reason=${outcome.reason}`,
      );
      return "FAILED";
    }

    await this.strategyOrderRepo.upsert({
      userId: userExec.userId,
      globalSignalId: userExec.globalSignalId,
      symbol,
      purpose: "ENTRY",
      revision: 0,
      clientOrderId: outcome.entryClientOrderId,
      clientAlgoId: null,
      binanceOrderId: null,
      binanceAlgoId: null,
      state: "FILLED",
    });
    await this.strategyOrderRepo.upsert({
      userId: userExec.userId,
      globalSignalId: userExec.globalSignalId,
      symbol,
      purpose: "EMERGENCY_STOP",
      revision: 0,
      clientOrderId: "",
      clientAlgoId: outcome.emergencyStopClientAlgoId,
      binanceOrderId: null,
      binanceAlgoId: outcome.emergencyStopBinanceAlgoId,
      state: "OPEN",
    });

    let updated: LiquidationOiUserExecutionState = {
      ...userExec,
      state: "ACTIVE",
      entryPrice: outcome.entryPrice,
      quantity: outcome.quantity,
      entryClientOrderId: outcome.entryClientOrderId,
      emergencyStopClientAlgoId: outcome.emergencyStopClientAlgoId,
      emergencyStopBinanceAlgoId: outcome.emergencyStopBinanceAlgoId,
      emergencyStopPrice: emergencyHardStopPrice,
      estimatedEmergencyMaxLossUsd:
        Math.abs(outcome.entryPrice - emergencyHardStopPrice) *
        outcome.quantity,
      pnlSource: "ESTIMATED",
      updatedAt: now,
    };
    if (outcome.outcome === "ENTRY_ACTIVE_WITH_TP") {
      await this.strategyOrderRepo.upsert({
        userId: userExec.userId,
        globalSignalId: userExec.globalSignalId,
        symbol,
        purpose: "TAKE_PROFIT",
        revision: 0,
        clientOrderId: outcome.tpClientOrderId,
        clientAlgoId: null,
        binanceOrderId: outcome.tpBinanceOrderId,
        binanceAlgoId: null,
        state: "OPEN",
      });
      updated = {
        ...updated,
        tpClientOrderId: outcome.tpClientOrderId,
        tpBinanceOrderId: outcome.tpBinanceOrderId,
        tpPrice,
      };
    }
    await this.globalSignalRepo.upsertUserExecution(updated);

    // Telegram ENTRY only now -- after position confirmed, protection
    // confirmed, and (best-effort) TP addressed. A Telegram send
    // failure must never undo the already-persisted execution state.
    if (runtime.telegram !== null) {
      try {
        const text = formatEntryMessage({
          symbol,
          candidateSide: side,
          mode: "REAL",
          globalSignalId: userExec.globalSignalId,
          entryTimestamp: updated.createdAt,
          entryPrice: outcome.entryPrice,
          quantity: outcome.quantity,
          riskUsd: userExec.riskUsd,
          tpPrice,
          strategyInvalidationPrice,
          emergencyHardStopPrice,
          sameDirectionLiqUsd,
          percentileRank,
          oiMetricLine,
          counterMoveAtr,
          orderBook,
          protectionConfirmed:
            outcome.outcome === "ENTRY_ACTIVE_WITH_TP" ||
            outcome.outcome === "ENTRY_ACTIVE_WITHOUT_TP",
          displayName: displayNameFromUserId(userExec.userId),
        });
        await sendTelegramWithRetry(
          runtime.telegram,
          text,
          `REAL_ENTRY userId=${userExec.userId} symbol=${symbol}`,
        );
      } catch (err) {
        log.error(
          {
            userId: userExec.userId,
            err: err instanceof Error ? err.message : String(err),
          },
          "[LOX_TELEGRAM_ENTRY_SEND_FAILED] -- isolated, execution state already persisted and unaffected",
        );
      }
    }
    return "ACTIVE";
  }
}
