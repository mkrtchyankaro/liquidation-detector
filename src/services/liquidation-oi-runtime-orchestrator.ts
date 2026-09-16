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
 *  (>=1 real position) or a specific no-position CANCELLED reason. */
type UserFanOutOutcome =
  | "ACTIVE"
  | "ALREADY_ACTIVE"
  | "ALREADY_TERMINAL"
  | "GLOBAL_DISABLED"
  | "USER_DISABLED"
  | "FAILED";

const STRUCTURAL_INVALIDATION_BUFFER_ATR = 0.1; // UNTUNED -- small noise/execution buffer beyond the episode's own extreme

export class LiquidationOiRuntimeOrchestrator {
  private readonly watchManager: LiquidationOiWatchManager;

  constructor(
    strategyConfig: LiquidationOiStrategyConfig,
    private readonly capacityCoeffs: CapacityModelCoefficients,
    private readonly globalSignalRepo: LiquidationOiGlobalSignalRepository,
    private readonly strategyOrderRepo: StrategyOrderRepository,
    private readonly getUserRuntimes: () => readonly LiquidationOiUserRuntimeRef[],
    private readonly observationEnabled: boolean = true,
    private readonly executionEnabled: boolean = false,
    private readonly makeGlobalSignalId: () => string = () =>
      `lox-sig-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  ) {
    this.watchManager = new LiquidationOiWatchManager(strategyConfig);
    log.info(
      `[LOX_RUNTIME] constructed observationEnabled=${observationEnabled} executionEnabled=${executionEnabled}`,
    );
  }

  getWatchManager(): LiquidationOiWatchManager {
    return this.watchManager;
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
  ): Promise<void> {
    if (!this.observationEnabled) return;
    const before = this.watchManager.getLifecycle(symbol);
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
    if (
      before?.globalState !== "ENTRY_READY" &&
      after !== null &&
      after.globalState === "ENTRY_READY" &&
      atr3m !== null
    ) {
      await this.handleEntryReady(
        symbol,
        after.ownershipId,
        after.episode,
        after.watchResult,
        currentPrice,
        atr3m,
        nowMs,
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
    },
    watchResult: WatchQualificationResult | null,
    entryPrice: number,
    atr3m: number,
    nowMs: number,
  ): Promise<void> {
    if (watchResult === null || !watchResult.qualifies) return;
    const globalSignalId = this.makeGlobalSignalId();
    const candidateSide = candidateTradeSideForVictim(episode.victim);
    const structuralInvalidationPrice =
      candidateSide === "LONG"
        ? episode.extremePrice - atr3m * STRUCTURAL_INVALIDATION_BUFFER_ATR
        : episode.extremePrice + atr3m * STRUCTURAL_INVALIDATION_BUFFER_ATR;

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

    log.info(
      `[LOX_ENTRY_READY] ${symbol} ${candidateSide} globalSignalId=${globalSignalId} entry=${entryPrice} invalidation=${structuralInvalidationPrice} capacityAtr=${capacity.initialCapacityAtr} tp=${tpPrice} components=${JSON.stringify(capacity.components)}`,
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
      strategyInvalidationPrice: structuralInvalidationPrice,
      initialCapacityAtr: capacity.initialCapacityAtr,
      initialTpPrice: tpPrice,
      tpRevision: 0,
    });

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
            structuralInvalidationPrice,
            tpPrice,
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

    // Sep 16 2026 (Karo), operator-requested CRITICAL FIX: ENTRY_READY
    // is now ALWAYS resolved, synchronously, in this same call --
    // never left waiting across ticks. This is what makes ENTRY_READY
    // a genuinely transient state rather than a permanent lock, and
    // is what lets observation-only mode (executionEnabled=false)
    // produce an unbounded sequence of independent setups for the
    // same symbol within one process lifetime, with no restart ever
    // required to "see the next setup".
    const hasRealPosition = outcomes.some(
      (o) => o === "ACTIVE" || o === "ALREADY_ACTIVE",
    );
    if (hasRealPosition) {
      this.watchManager.confirmActivePosition(symbol, nowMs);
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
        strategyInvalidationPrice: structuralInvalidationPrice,
        initialCapacityAtr: capacity.initialCapacityAtr,
        initialTpPrice: tpPrice,
        tpRevision: 0,
      });
      log.info(
        `[LOX_GLOBAL_ACTIVE] ${symbol} globalSignalId=${globalSignalId} -- at least one real user position confirmed, symbol ownership retained`,
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
      strategyInvalidationPrice: structuralInvalidationPrice,
      initialCapacityAtr: capacity.initialCapacityAtr,
      initialTpPrice: tpPrice,
      tpRevision: 0,
    });
    log.info(
      `[LOX_GLOBAL_CANCELLED] ${symbol} globalSignalId=${globalSignalId} reason=${code} -- no real position resulted, symbol released for the next independent episode`,
    );
  }

  /** Sep 16 2026 (Karo), operator-requested. Picks the specific
   *  no-position reason code from the fan-out outcomes:
   *  - executionEnabled was false for the whole batch -> observational
   *  - no users configured at all -> no eligible users
   *  - every user had their own liquidationOiExecutionEnabled=false ->
   *    all-users-disabled
   *  - otherwise, execution was genuinely attempted for at least one
   *    user but produced no real position -> all-executions-failed */
  private resolveNoPositionReason(outcomes: readonly UserFanOutOutcome[]): {
    code: string;
    detail: string;
  } {
    if (!this.executionEnabled)
      return {
        code: "ENTRY_READY_OBSERVATIONAL_ONLY",
        detail:
          "global executionEnabled=false -- observational signal recorded and consumed, no Binance call was ever attempted for any user",
      };
    if (outcomes.length === 0)
      return {
        code: "ENTRY_READY_NO_ELIGIBLE_USERS",
        detail: "no users were configured for fan-out",
      };
    const anyUserEnabled = outcomes.some((o) => o !== "USER_DISABLED");
    if (!anyUserEnabled)
      return {
        code: "ENTRY_READY_ALL_USERS_EXECUTION_DISABLED",
        detail:
          "every configured user's own liquidationOiExecutionEnabled=false",
      };
    return {
      code: "ENTRY_READY_ALL_EXECUTIONS_FAILED",
      detail:
        "execution was attempted for at least one user but no real position resulted",
    };
  }

  private async executeForUser(
    runtime: LiquidationOiUserRuntimeRef,
    symbol: string,
    globalSignalId: string,
    side: Side,
    entryPrice: number,
    structuralInvalidationPrice: number,
    tpPrice: number,
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
      return existing.state === "ACTIVE"
        ? "ALREADY_ACTIVE"
        : "ALREADY_TERMINAL";
    }

    const sizing = computePositionSizing({
      entry: entryPrice,
      structuralInvalidationPrice,
      riskUsd: runtime.riskUsd,
    });
    let userExec = newPendingUserExecution(
      runtime.userId,
      globalSignalId,
      symbol,
      side,
      runtime.riskUsd,
      nowMs,
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
    userExec = {
      ...userExec,
      quantity: sizing.positionQty,
      positionSizeUsdt: sizing.positionSizeUsdt,
      estimatedStrategyLossUsd: runtime.riskUsd,
    };
    await this.globalSignalRepo.upsertUserExecution(userExec);

    if (!this.executionEnabled) {
      log.info(
        `[LOX_OBSERVATION_ONLY] userId=${runtime.userId} symbol=${symbol} would have entered ${side} qty=${sizing.positionQty} sizeUsdt=${sizing.positionSizeUsdt.toFixed(2)} -- executionEnabled=false (GLOBAL master switch), no order placed`,
      );
      return "GLOBAL_DISABLED";
    }

    // Sep 16 2026 (Karo), operator-requested -- SECOND required gate,
    // checked only after the global master switch has already passed
    // above. BOTH must be true for a real order to be placed. This
    // user's own opt-out is recorded as a distinct TERMINAL reason
    // (never left as an ambiguous PENDING/observational row, and
    // never becomes ACTIVE) -- and no Telegram is sent, since
    // persistOutcome()/the Telegram send are never reached from here.
    if (!runtime.liquidationOiExecutionEnabled) {
      userExec = {
        ...userExec,
        state: "TERMINAL",
        terminalReason: "USER_STRATEGY_EXECUTION_DISABLED",
        cleanupState: "COMPLETE",
        updatedAt: Date.now(),
      };
      await this.globalSignalRepo.upsertUserExecution(userExec);
      log.info(
        `[LOX_USER_STRATEGY_EXECUTION_DISABLED] userId=${runtime.userId} symbol=${symbol} -- this user's own liquidationOiExecutionEnabled=false, no order attempted, no Binance call made`,
      );
      return "USER_DISABLED";
    }

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

    const outcome = await runEntrySequence(runtime.binanceRest, {
      userId: runtime.userId,
      globalSignalId,
      symbol,
      side,
      quantity: sizing.positionQty,
      entryPriceEstimate: entryPrice,
      emergencyStopPrice: structuralInvalidationPrice,
      initialTpPrice: tpPrice,
    });

    return await this.persistOutcome(
      userExec,
      outcome,
      symbol,
      side,
      structuralInvalidationPrice,
      tpPrice,
      runtime,
    );
  }

  private async persistOutcome(
    userExec: LiquidationOiUserExecutionState,
    outcome: Awaited<ReturnType<typeof runEntrySequence>>,
    symbol: string,
    side: Side,
    structuralInvalidationPrice: number,
    tpPrice: number,
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
      emergencyStopPrice: structuralInvalidationPrice,
      estimatedEmergencyMaxLossUsd:
        Math.abs(outcome.entryPrice - structuralInvalidationPrice) *
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
        const tpLine =
          outcome.outcome === "ENTRY_ACTIVE_WITH_TP"
            ? `TP: confirmed`
            : `TP: not yet placed (${outcome.outcome === "ENTRY_ACTIVE_WITHOUT_TP" ? outcome.tpFailureReason : ""})`;
        await runtime.telegram.sendMessage(
          `${symbol} ${side} ENTRY (Liquidation+OI Exhaustion, experimental)\nEntry: ${outcome.entryPrice}\nQty: ${outcome.quantity}\nEmergency stop: confirmed\n${tpLine}`,
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
