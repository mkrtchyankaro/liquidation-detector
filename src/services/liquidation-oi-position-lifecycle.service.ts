import {
  isGlobalCloseEligible,
  type UserExecutionSummary,
} from "../domain/liquidation-oi-strategy/lifecycle.types";
import { LiquidationOiGlobalSignalRepository } from "../infrastructure/mongo/liquidation-oi-global-signal.repository";
import {
  StrategyOrderRepository,
  type StrategyOrderDoc,
} from "../infrastructure/mongo/strategy-order.repository";
import type { LiquidationOiUserExecutionState } from "../domain/liquidation-oi-strategy/user-execution.types";
import type { LiquidationOiWatchManager } from "../domain/liquidation-oi-strategy/liquidation-oi-watch-manager";
import type { LiquidationOiUserRuntimeRef } from "./liquidation-oi-runtime-orchestrator";
import type { BinanceRestLike } from "../infrastructure/binance/liquidation-oi-user-execution.service";
import type { ForensicEvent } from "../domain/liquidation-oi-strategy/forensic-events";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "lox-position-lifecycle" });

/**
 * Sep 17 2026 (Karo), operator-requested production-completion pass,
 * Sections L (real termination detection), M (one mandatory common
 * cleanup routine), O (multi-user global close). Deliberately a
 * SEPARATE class from LiquidationOiRuntimeOrchestrator (which owns
 * the pre-ACTIVE lifecycle) -- this one owns everything from a real
 * fill onward. Reuses each user's own existing BinanceRestClient (via
 * LiquidationOiUserRuntimeRef.binanceRest) -- no new execution
 * abstraction, no new Binance stream. Driven by a periodic poll
 * (positionReconciliationIntervalMs), started/stopped by the
 * orchestration layer, mirroring OiTrackerService's own
 * setInterval-driven pattern.
 */

export class LiquidationOiPositionLifecycleService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly globalSignalRepo: LiquidationOiGlobalSignalRepository,
    private readonly strategyOrderRepo: StrategyOrderRepository,
    private readonly watchManager: LiquidationOiWatchManager,
    private readonly getUserRuntimes: () => readonly LiquidationOiUserRuntimeRef[],
    private readonly reconciliationIntervalMs: number,
    private readonly forensic: (event: ForensicEvent) => void = () => {},
  ) {}

  private emit(
    userExec: LiquidationOiUserExecutionState,
    nowMs: number,
    partial: Record<string, unknown> & { type: ForensicEvent["type"] },
  ): void {
    const episodeId =
      this.watchManager.getLifecycle(userExec.symbol)?.episodeId ??
      userExec.globalSignalId;
    this.forensic({
      ts: nowMs,
      symbol: userExec.symbol,
      episodeId,
      victim: userExec.side,
      state: "TERMINAL",
      episodeAgeSec: 0,
      ...partial,
    } as unknown as ForensicEvent);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(
      () =>
        void this.reconcileAll(Date.now()).catch((err) =>
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "[LOX_RECONCILE_ALL_UNEXPECTED_ERROR]",
          ),
        ),
      this.reconciliationIntervalMs,
    );
    log.info(
      `[LOX_POSITION_LIFECYCLE] started, intervalMs=${this.reconciliationIntervalMs}`,
    );
  }
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async reconcileAll(nowMs: number): Promise<void> {
    const nonTerminal =
      await this.globalSignalRepo.findNonTerminalUserExecutions();
    for (const userExec of nonTerminal) {
      try {
        await this.reconcileOneUser(userExec, nowMs);
      } catch (err) {
        log.error(
          {
            userId: userExec.userId,
            globalSignalId: userExec.globalSignalId,
            err: err instanceof Error ? err.message : String(err),
          },
          "[LOX_RECONCILE_ONE_USER_UNEXPECTED_ERROR] -- isolated",
        );
      }
    }
  }

  private findRuntime(userId: string): LiquidationOiUserRuntimeRef | null {
    return this.getUserRuntimes().find((r) => r.userId === userId) ?? null;
  }

  private async reconcileOneUser(
    userExec: LiquidationOiUserExecutionState,
    nowMs: number,
  ): Promise<void> {
    if (userExec.cleanupState === "FAILED_RETRYING") {
      await this.runCleanup(userExec, nowMs);
      return;
    }
    if (userExec.state !== "ACTIVE") return;

    const runtime = this.findRuntime(userExec.userId);
    if (runtime === null || runtime.binanceRest === null) return;

    const positionFlat = await this.isPositionFlat(
      runtime.binanceRest,
      userExec.symbol,
    );
    if (positionFlat === null) return;
    if (!positionFlat) return;

    const terminalReason = await this.determineTerminalReason(
      userExec,
      runtime.binanceRest,
    );
    const updated: LiquidationOiUserExecutionState = {
      ...userExec,
      state: "TERMINAL",
      terminalReason,
      updatedAt: nowMs,
    };
    await this.globalSignalRepo.upsertUserExecution(updated);
    this.emit(userExec, nowMs, {
      type: "POSITION_TERMINAL_DETECTED",
      userId: userExec.userId,
      reason: terminalReason ?? "UNKNOWN",
    });
    log.info(
      `[LOX_POSITION_TERMINAL_DETECTED] userId=${userExec.userId} symbol=${userExec.symbol} reason=${terminalReason}`,
    );

    await this.runCleanup(updated, nowMs);
  }

  private async isPositionFlat(
    rest: BinanceRestLike,
    symbol: string,
  ): Promise<boolean | null> {
    try {
      const res = (await rest.getPositionRisk(symbol)) as Array<{
        symbol: string;
        positionAmt: string;
      }>;
      const pos = res.find((p) => p.symbol === symbol);
      if (!pos) return true;
      return Math.abs(Number(pos.positionAmt)) < 1e-9;
    } catch {
      return null;
    }
  }

  private async determineTerminalReason(
    userExec: LiquidationOiUserExecutionState,
    rest: BinanceRestLike,
  ): Promise<LiquidationOiUserExecutionState["terminalReason"]> {
    try {
      if (userExec.tpBinanceOrderId !== null) {
        const tp = (await rest.getOrder(
          userExec.symbol,
          userExec.tpBinanceOrderId,
        )) as { status?: string };
        if (tp.status === "FILLED") return "TP_FILLED";
      }
    } catch {
      /* fall through */
    }
    try {
      if (userExec.emergencyStopBinanceAlgoId !== null) {
        const stop = (await rest.getAlgoOrder(
          userExec.emergencyStopBinanceAlgoId,
        )) as { algoStatus?: string };
        if (stop.algoStatus === "FILLED" || stop.algoStatus === "EXECUTED")
          return "EMERGENCY_STOP";
      }
    } catch {
      /* fall through */
    }
    return "POSITION_CLOSED_EXTERNALLY";
  }

  async runCleanup(
    userExec: LiquidationOiUserExecutionState,
    nowMs: number,
  ): Promise<void> {
    const runtime = this.findRuntime(userExec.userId);
    if (runtime === null || runtime.binanceRest === null) {
      await this.markCleanupFailed(
        userExec,
        "no configured Binance client for this user",
        nowMs,
      );
      return;
    }
    try {
      const unresolved = await this.strategyOrderRepo.findUnresolved(
        userExec.userId,
        userExec.globalSignalId,
      );
      const stillCancellable = unresolved.filter(
        (o) =>
          o.purpose !== "ENTRY" &&
          o.purpose !== "MARKET_EXIT" &&
          o.purpose !== "FAILSAFE_CLOSE",
      );
      for (const order of stillCancellable) {
        await this.cancelOneStrategyOrder(runtime.binanceRest, order);
      }
      const stillOpen = await this.findResidualOpenStrategyOrders(
        runtime.binanceRest,
        userExec.symbol,
        userExec.userId,
        userExec.globalSignalId,
      );
      if (stillOpen.length > 0) {
        await this.markCleanupFailed(
          userExec,
          `${stillOpen.length} residual strategy-owned order(s) still open after cancellation attempt`,
          nowMs,
        );
        return;
      }

      const finalized: LiquidationOiUserExecutionState = {
        ...userExec,
        cleanupState: "COMPLETE",
        updatedAt: nowMs,
      };
      await this.globalSignalRepo.upsertUserExecution(finalized);
      this.emit(userExec, nowMs, {
        type: "CLEANUP_COMPLETE",
        userId: userExec.userId,
      });
      log.info(
        `[LOX_CLEANUP_COMPLETE] userId=${userExec.userId} symbol=${userExec.symbol} globalSignalId=${userExec.globalSignalId}`,
      );
      if (runtime.telegram !== null) {
        try {
          await runtime.telegram.sendMessage(
            `${userExec.symbol} ${userExec.side} CLOSE\nReason: ${userExec.terminalReason}\nEntry: ${userExec.entryPrice}\nExit: ${userExec.exitPrice ?? "N/A"}\nPnL: ${userExec.realizedPnlUsd !== null ? userExec.realizedPnlUsd.toFixed(2) : "N/A (" + (userExec.pnlSource ?? "unknown") + ")"}\nCleanup: COMPLETE`,
          );
        } catch (err) {
          log.error(
            {
              userId: userExec.userId,
              err: err instanceof Error ? err.message : String(err),
            },
            "[LOX_TELEGRAM_CLOSE_SEND_FAILED] -- isolated, cleanup already persisted",
          );
        }
      }

      await this.maybeCloseGlobal(userExec.globalSignalId, nowMs);
    } catch (err) {
      await this.markCleanupFailed(
        userExec,
        err instanceof Error ? err.message : String(err),
        nowMs,
      );
    }
  }

  private async cancelOneStrategyOrder(
    rest: BinanceRestLike,
    order: StrategyOrderDoc,
  ): Promise<void> {
    try {
      if (order.clientAlgoId !== null && order.binanceAlgoId !== null) {
        await rest.cancelAlgoOrder(order.binanceAlgoId);
      } else if (order.binanceOrderId !== null) {
        await rest.cancelOrder(order.symbol, order.binanceOrderId);
      }
      await this.strategyOrderRepo.setState(
        order.userId,
        order.globalSignalId,
        order.purpose,
        order.revision,
        "CANCELLED",
      );
    } catch (err) {
      log.warn(
        {
          userId: order.userId,
          purpose: order.purpose,
          err: err instanceof Error ? err.message : String(err),
        },
        "[LOX_CANCEL_ORDER_ATTEMPT_ERROR] -- verified by ground-truth check next",
      );
    }
  }

  private async findResidualOpenStrategyOrders(
    rest: BinanceRestLike,
    symbol: string,
    userId: string,
    globalSignalId: string,
  ): Promise<unknown[]> {
    try {
      const [openOrders, openAlgoOrders] = await Promise.all([
        rest.getOpenOrders(symbol) as Promise<
          Array<{ clientOrderId?: string }>
        >,
        rest.getOpenAlgoOrders(symbol) as Promise<
          Array<{ clientAlgoId?: string }>
        >,
      ]);
      const ownedOrderIds = new Set(
        (
          await this.strategyOrderRepo.findUnresolved(userId, globalSignalId)
        ).map((o) => o.clientOrderId || o.clientAlgoId),
      );
      const residualOrders = (openOrders ?? []).filter(
        (o) => o.clientOrderId && ownedOrderIds.has(o.clientOrderId),
      );
      const residualAlgo = (openAlgoOrders ?? []).filter(
        (o) => o.clientAlgoId && ownedOrderIds.has(o.clientAlgoId),
      );
      return [...residualOrders, ...residualAlgo];
    } catch {
      return [{ reason: "verification-api-unavailable" }];
    }
  }

  private async markCleanupFailed(
    userExec: LiquidationOiUserExecutionState,
    reason: string,
    nowMs: number,
  ): Promise<void> {
    const updated: LiquidationOiUserExecutionState = {
      ...userExec,
      cleanupState: "FAILED_RETRYING",
      lastCleanupAttemptAt: nowMs,
      cleanupFailureReason: reason,
      updatedAt: nowMs,
    };
    await this.globalSignalRepo.upsertUserExecution(updated);
    this.emit(userExec, nowMs, {
      type: "CLEANUP_FAILED_RETRYING",
      userId: userExec.userId,
      reason,
    });
    log.error(
      `[LOX_CLEANUP_FAILED_RETRYING] userId=${userExec.userId} symbol=${userExec.symbol} reason=${reason} -- global CLOSED/symbol release BLOCKED until resolved`,
    );
    const runtime = this.findRuntime(userExec.userId);
    if (runtime !== null && runtime.telegram !== null) {
      try {
        await runtime.telegram.sendMessage(
          `${userExec.symbol} ${userExec.side} CLEANUP FAILURE\nUser: ${userExec.userId}\nReason: ${reason}\nWill retry automatically. Manual review recommended if this persists.`,
        );
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[LOX_TELEGRAM_CLEANUP_FAILURE_SEND_FAILED] -- isolated",
        );
      }
    }
  }

  async maybeCloseGlobal(globalSignalId: string, nowMs: number): Promise<void> {
    const allUserExecs =
      await this.globalSignalRepo.findUserExecutionsForSignal(globalSignalId);
    if (allUserExecs.length === 0) return;
    const summaries: UserExecutionSummary[] = allUserExecs.map((u) => ({
      userId: u.userId,
      state: u.state,
      cleanupState: u.cleanupState,
    }));
    const unresolvedCount =
      await this.strategyOrderRepo.countOpen(globalSignalId);
    const eligibility = isGlobalCloseEligible({
      mainThesisTerminal: true,
      users: summaries,
      unresolvedStrategyOrderCount: unresolvedCount,
    });
    if (!eligibility.eligible) {
      log.info(
        `[LOX_GLOBAL_NOT_YET_CLOSE_ELIGIBLE] globalSignalId=${globalSignalId} reasons=${eligibility.reasons.join("; ")}`,
      );
      return;
    }
    const signal = await this.globalSignalRepo.findSignal(globalSignalId);
    if (signal === null) return;
    await this.globalSignalRepo.upsertSignal({ ...signal, state: "CLOSED" });
    const episodeId =
      this.watchManager.getLifecycle(signal.symbol)?.episodeId ??
      globalSignalId;
    this.forensic({
      ts: nowMs,
      symbol: signal.symbol,
      episodeId,
      victim: signal.victim,
      state: "CLOSED",
      episodeAgeSec: 0,
      type: "GLOBAL_CLOSED",
    });
    this.watchManager.closeActive(
      signal.symbol,
      "ALL_USERS_TERMINAL_AND_CLEAN",
      nowMs,
    );
    this.forensic({
      ts: nowMs,
      symbol: signal.symbol,
      episodeId,
      victim: signal.victim,
      state: "CLOSED",
      episodeAgeSec: 0,
      type: "SYMBOL_RELEASED",
    });
    log.info(
      `[LOX_GLOBAL_CLOSED] globalSignalId=${globalSignalId} symbol=${signal.symbol} -- symbol released, next independent episode may now start`,
    );
  }

  async requestGlobalMarketExit(
    globalSignalId: string,
    reason: LiquidationOiUserExecutionState["terminalReason"],
    nowMs: number,
  ): Promise<void> {
    const allUserExecs =
      await this.globalSignalRepo.findUserExecutionsForSignal(globalSignalId);
    for (const userExec of allUserExecs.filter((u) => u.state === "ACTIVE")) {
      try {
        await this.requestUserMarketExit(userExec, reason, nowMs);
      } catch (err) {
        log.error(
          {
            userId: userExec.userId,
            globalSignalId,
            err: err instanceof Error ? err.message : String(err),
          },
          "[LOX_USER_MARKET_EXIT_UNEXPECTED_ERROR] -- isolated, other users unaffected",
        );
      }
    }
  }

  private async requestUserMarketExit(
    userExec: LiquidationOiUserExecutionState,
    reason: LiquidationOiUserExecutionState["terminalReason"],
    nowMs: number,
  ): Promise<void> {
    const runtime = this.findRuntime(userExec.userId);
    if (
      runtime === null ||
      runtime.binanceRest === null ||
      userExec.quantity === null
    )
      return;
    const closeSide = userExec.side === "LONG" ? "SELL" : "BUY";
    try {
      const res = (await runtime.binanceRest.createOrder({
        symbol: userExec.symbol,
        side: closeSide,
        type: "MARKET",
        quantity: String(userExec.quantity),
        reduceOnly: "true",
      })) as { orderId?: number };
      await this.strategyOrderRepo.upsert({
        userId: userExec.userId,
        globalSignalId: userExec.globalSignalId,
        symbol: userExec.symbol,
        purpose: "MARKET_EXIT",
        revision: 0,
        clientOrderId: "",
        clientAlgoId: null,
        binanceOrderId: res.orderId ?? null,
        binanceAlgoId: null,
        state: "FILLED",
      });
      const updated: LiquidationOiUserExecutionState = {
        ...userExec,
        state: "TERMINAL",
        terminalReason: reason,
        updatedAt: nowMs,
      };
      await this.globalSignalRepo.upsertUserExecution(updated);
      this.emit(userExec, nowMs, {
        type: "USER_MARKET_EXIT_CONFIRMED",
        userId: userExec.userId,
      });
      log.info(
        `[LOX_USER_MARKET_EXIT_CONFIRMED] userId=${userExec.userId} symbol=${userExec.symbol} reason=${reason}`,
      );
      await this.runCleanup(updated, nowMs);
    } catch (err) {
      log.error(
        {
          userId: userExec.userId,
          symbol: userExec.symbol,
          err: err instanceof Error ? err.message : String(err),
        },
        "[LOX_USER_MARKET_EXIT_FAILED] -- position may remain open, will be caught by the next reconciliation pass or requires manual attention",
      );
    }
  }
}
