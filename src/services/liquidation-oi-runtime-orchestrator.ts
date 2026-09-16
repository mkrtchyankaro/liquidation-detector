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
  binanceRest: BinanceRestLike | null;
  telegram: { sendMessage(text: string): Promise<unknown> } | null;
}

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

    for (const runtime of this.getUserRuntimes()) {
      try {
        await this.executeForUser(
          runtime,
          symbol,
          globalSignalId,
          candidateSide,
          entryPrice,
          structuralInvalidationPrice,
          tpPrice,
          nowMs,
        );
      } catch (err) {
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
  ): Promise<void> {
    const existing = await this.globalSignalRepo.findUserExecution(
      runtime.userId,
      globalSignalId,
    );
    if (existing !== null) {
      log.info(
        `[LOX_USER_EXECUTION_ALREADY_EXISTS] userId=${runtime.userId} globalSignalId=${globalSignalId} state=${existing.state} -- skipping, idempotent`,
      );
      return;
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
      return;
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
        `[LOX_OBSERVATION_ONLY] userId=${runtime.userId} symbol=${symbol} would have entered ${side} qty=${sizing.positionQty} sizeUsdt=${sizing.positionSizeUsdt.toFixed(2)} -- executionEnabled=false, no order placed`,
      );
      return;
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
      return;
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

    await this.persistOutcome(
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
  ): Promise<void> {
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
      return;
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
      return;
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
  }
}
