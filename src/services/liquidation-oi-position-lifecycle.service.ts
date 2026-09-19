import { isGlobalCloseEligible, type UserExecutionSummary } from "../domain/liquidation-oi-strategy/lifecycle.types";
import { LiquidationOiGlobalSignalRepository } from "../infrastructure/mongo/liquidation-oi-global-signal.repository";
import { StrategyOrderRepository, type StrategyOrderDoc } from "../infrastructure/mongo/strategy-order.repository";
import type { LiquidationOiUserExecutionState } from "../domain/liquidation-oi-strategy/user-execution.types";
import type { LiquidationOiWatchManager } from "../domain/liquidation-oi-strategy/liquidation-oi-watch-manager";
import type { LiquidationOiUserRuntimeRef } from "./liquidation-oi-runtime-orchestrator";
import type { BinanceRestLike } from "../infrastructure/binance/liquidation-oi-user-execution.service";
import type { ForensicEvent } from "../domain/liquidation-oi-strategy/forensic-events";
import { computePaperPnl } from "../domain/liquidation-oi-strategy/pnl-calculator";
import { formatCloseMessage } from "../domain/liquidation-oi-strategy/telegram-formatter";
import { sendTelegramWithRetry } from "../domain/liquidation-oi-strategy/telegram-send-retry";
import { displayNameFromUserId } from "../domain/liquidation-oi-strategy/telegram-display-format";
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

  private emit(userExec: LiquidationOiUserExecutionState, nowMs: number, partial: Record<string, unknown> & { type: ForensicEvent["type"] }): void {
    const episodeId = this.watchManager.getLifecycle(userExec.symbol)?.episodeId ?? userExec.globalSignalId;
    this.forensic({ ts: nowMs, symbol: userExec.symbol, episodeId, victim: userExec.side, state: "TERMINAL", episodeAgeSec: 0, ...partial } as unknown as ForensicEvent);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.reconcileAll(Date.now()).catch((err) => log.error({ err: err instanceof Error ? err.message : String(err) }, "[LOX_RECONCILE_ALL_UNEXPECTED_ERROR]")), this.reconciliationIntervalMs);
    log.info(`[LOX_POSITION_LIFECYCLE] started, intervalMs=${this.reconciliationIntervalMs}`);
  }
  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  async reconcileAll(nowMs: number): Promise<void> {
    const nonTerminal = await this.globalSignalRepo.findNonTerminalUserExecutions();
    for (const userExec of nonTerminal) {
      try { await this.reconcileOneUser(userExec, nowMs); }
      catch (err) { log.error({ userId: userExec.userId, globalSignalId: userExec.globalSignalId, err: err instanceof Error ? err.message : String(err) }, "[LOX_RECONCILE_ONE_USER_UNEXPECTED_ERROR] -- isolated"); }
    }
  }

  private findRuntime(userId: string): LiquidationOiUserRuntimeRef | null {
    return this.getUserRuntimes().find((r) => r.userId === userId) ?? null;
  }

  private async reconcileOneUser(userExec: LiquidationOiUserExecutionState, nowMs: number): Promise<void> {
    if (userExec.cleanupState === "FAILED_RETRYING") {
      await this.runCleanup(userExec, nowMs);
      return;
    }
    if (userExec.state !== "ACTIVE") return;

    // Sep 17 2026 (Karo), operator-reported CRITICAL PRODUCTION BUG FIX.
    // Live evidence: a PAPER user with a REAL binanceRest client
    // configured (paper because of their OWN liquidationOiExecutionEnabled
    // flag, or the global safety fallback -- NOT missing credentials) was
    // being reconciled against their real, always-flat Binance position
    // by this exact method, and incorrectly terminated as
    // POSITION_CLOSED_EXTERNALLY within one ~15s poll cycle -- with no
    // exit price, no PnL, defeating PAPER mode's own virtual monitoring
    // entirely. This is the SAME class of bug already fixed in
    // applyTpRevision() and requestUserMarketExit() (mode must be the
    // exclusive gate, never client presence) -- this call site was
    // missed in that pass. PAPER users are monitored EXCLUSIVELY by
    // LiquidationOiActiveMainRuntime's own causal price-based checks
    // (checkPaperTpHits, requestGlobalMarketExit's PAPER branch) --
    // this Binance-reconciliation path must never touch them.
    if (userExec.mode === "PAPER") return;

    const runtime = this.findRuntime(userExec.userId);
    if (runtime === null || runtime.binanceRest === null) return;

    const positionFlat = await this.isPositionFlat(runtime.binanceRest, userExec.symbol);
    if (positionFlat === null) return;
    if (!positionFlat) return;

    const terminalReason = await this.determineTerminalReason(userExec, runtime.binanceRest);
    const updated: LiquidationOiUserExecutionState = { ...userExec, state: "TERMINAL", terminalReason, updatedAt: nowMs };
    await this.globalSignalRepo.upsertUserExecution(updated);
    this.emit(userExec, nowMs, { type: "POSITION_TERMINAL_DETECTED", userId: userExec.userId, reason: terminalReason ?? "UNKNOWN" });
    log.info(`[LOX_POSITION_TERMINAL_DETECTED] userId=${userExec.userId} symbol=${userExec.symbol} reason=${terminalReason}`);

    await this.runCleanup(updated, nowMs);
  }

  private async isPositionFlat(rest: BinanceRestLike, symbol: string): Promise<boolean | null> {
    try {
      const res = (await rest.getPositionRisk(symbol)) as Array<{ symbol: string; positionAmt: string }>;
      const pos = res.find((p) => p.symbol === symbol);
      if (!pos) return true;
      return Math.abs(Number(pos.positionAmt)) < 1e-9;
    } catch {
      return null;
    }
  }

  private async determineTerminalReason(userExec: LiquidationOiUserExecutionState, rest: BinanceRestLike): Promise<LiquidationOiUserExecutionState["terminalReason"]> {
    try {
      if (userExec.tpBinanceOrderId !== null) {
        const tp = (await rest.getOrder(userExec.symbol, userExec.tpBinanceOrderId)) as { status?: string };
        if (tp.status === "FILLED") return "TP_FILLED";
      }
    } catch { /* fall through */ }
    try {
      if (userExec.slBinanceAlgoId !== null) {
        const stop = (await rest.getAlgoOrder(userExec.slBinanceAlgoId)) as { algoStatus?: string };
        if (stop.algoStatus === "FILLED" || stop.algoStatus === "EXECUTED") return "SL_FILLED";
      }
    } catch { /* fall through */ }
    return "POSITION_CLOSED_EXTERNALLY";
  }

  async runCleanup(userExec: LiquidationOiUserExecutionState, nowMs: number): Promise<void> {
    const runtime = this.findRuntime(userExec.userId);

    // Sep 17 2026 (Karo), operator-requested Sections 2/10 -- PAPER
    // cleanup is immediate and trivial: there is no Binance order to
    // cancel or verify, ever, for a paper row, REGARDLESS of whether
    // this user happens to have a real binanceRest client configured
    // (mode is the single source of truth, never inferred from client
    // presence -- see the same fix applied in
    // liquidation-oi-active-main-runtime.service.ts's own
    // applyTpRevision/requestUserMarketExit).
    if (userExec.mode === "PAPER") {
      const finalized: LiquidationOiUserExecutionState = { ...userExec, cleanupState: "COMPLETE", updatedAt: nowMs };
      await this.globalSignalRepo.upsertUserExecution(finalized);
      this.emit(userExec, nowMs, { type: "CLEANUP_COMPLETE", userId: userExec.userId });
      log.info(`[LOX_PAPER_CLEANUP_COMPLETE] userId=${userExec.userId} symbol=${userExec.symbol} globalSignalId=${userExec.globalSignalId} -- no Binance calls, paper row`);
      if (runtime !== null && runtime.telegram !== null && userExec.entryPrice !== null) {
        try {
          const candidateSide = userExec.side; // candidate side equals victim-derived side already stored per-user
          const text = formatCloseMessage({
            symbol: userExec.symbol, candidateSide, terminalReason: userExec.terminalReason ?? "POSITION_CLOSED_EXTERNALLY",
            globalSignalId: userExec.globalSignalId, terminalTimestamp: nowMs,
            entryPrice: userExec.entryPrice, exitPrice: userExec.exitPrice, quantity: userExec.quantity, riskUsd: userExec.riskUsd, durationMs: nowMs - userExec.createdAt,
            mode: "PAPER", paperGrossPnlUsd: userExec.grossPnlUsd, displayName: displayNameFromUserId(userExec.userId),
          });
          await sendTelegramWithRetry(runtime.telegram, text, `PAPER_CLOSE userId=${userExec.userId} symbol=${userExec.symbol}`);
        } catch (err) {
          log.error({ userId: userExec.userId, err: err instanceof Error ? err.message : String(err) }, "[LOX_TELEGRAM_CLOSE_SEND_FAILED] -- isolated, cleanup already persisted");
        }
      }
      await this.maybeCloseGlobal(userExec.globalSignalId, nowMs);
      return;
    }

    if (runtime === null || runtime.binanceRest === null) {
      await this.markCleanupFailed(userExec, "no configured Binance client for this user", nowMs);
      return;
    }
    try {
      const unresolved = await this.strategyOrderRepo.findUnresolved(userExec.userId, userExec.globalSignalId);
      const stillCancellable = unresolved.filter((o) => o.purpose !== "ENTRY" && o.purpose !== "MARKET_EXIT" && o.purpose !== "FAILSAFE_CLOSE");
      for (const order of stillCancellable) {
        await this.cancelOneStrategyOrder(runtime.binanceRest, order);
      }
      const stillOpen = await this.findResidualOpenStrategyOrders(runtime.binanceRest, userExec.symbol, userExec.userId, userExec.globalSignalId);
      if (stillOpen.length > 0) {
        await this.markCleanupFailed(userExec, `${stillOpen.length} residual strategy-owned order(s) still open after cancellation attempt`, nowMs);
        return;
      }

      const finalized: LiquidationOiUserExecutionState = { ...userExec, cleanupState: "COMPLETE", updatedAt: nowMs };
      await this.globalSignalRepo.upsertUserExecution(finalized);
      this.emit(userExec, nowMs, { type: "CLEANUP_COMPLETE", userId: userExec.userId });
      log.info(`[LOX_CLEANUP_COMPLETE] userId=${userExec.userId} symbol=${userExec.symbol} globalSignalId=${userExec.globalSignalId}`);
      if (runtime.telegram !== null && userExec.entryPrice !== null) {
        try {
          const text = formatCloseMessage({
            symbol: userExec.symbol, candidateSide: userExec.side, terminalReason: userExec.terminalReason ?? "POSITION_CLOSED_EXTERNALLY",
            globalSignalId: userExec.globalSignalId, terminalTimestamp: nowMs,
            entryPrice: userExec.entryPrice, exitPrice: userExec.exitPrice, quantity: userExec.quantity, riskUsd: userExec.riskUsd, durationMs: nowMs - userExec.createdAt,
            mode: "REAL", realActualPnlUsd: userExec.realizedPnlUsd, cleanupState: "COMPLETE", displayName: displayNameFromUserId(userExec.userId),
          });
          await sendTelegramWithRetry(runtime.telegram, text, `REAL_CLOSE userId=${userExec.userId} symbol=${userExec.symbol}`);
        } catch (err) {
          log.error({ userId: userExec.userId, err: err instanceof Error ? err.message : String(err) }, "[LOX_TELEGRAM_CLOSE_SEND_FAILED] -- isolated, cleanup already persisted");
        }
      }

      await this.maybeCloseGlobal(userExec.globalSignalId, nowMs);
    } catch (err) {
      await this.markCleanupFailed(userExec, err instanceof Error ? err.message : String(err), nowMs);
    }
  }

  private async cancelOneStrategyOrder(rest: BinanceRestLike, order: StrategyOrderDoc): Promise<void> {
    try {
      if (order.clientAlgoId !== null && order.binanceAlgoId !== null) {
        await rest.cancelAlgoOrder(order.binanceAlgoId);
      } else if (order.binanceOrderId !== null) {
        await rest.cancelOrder(order.symbol, order.binanceOrderId);
      }
      await this.strategyOrderRepo.setState(order.userId, order.globalSignalId, order.purpose, order.revision, "CANCELLED");
    } catch (err) {
      log.warn({ userId: order.userId, purpose: order.purpose, err: err instanceof Error ? err.message : String(err) }, "[LOX_CANCEL_ORDER_ATTEMPT_ERROR] -- verified by ground-truth check next");
    }
  }

  private async findResidualOpenStrategyOrders(rest: BinanceRestLike, symbol: string, userId: string, globalSignalId: string): Promise<unknown[]> {
    try {
      const [openOrders, openAlgoOrders] = await Promise.all([
        rest.getOpenOrders(symbol) as Promise<Array<{ clientOrderId?: string }>>,
        rest.getOpenAlgoOrders(symbol) as Promise<Array<{ clientAlgoId?: string }>>,
      ]);
      const ownedOrderIds = new Set((await this.strategyOrderRepo.findUnresolved(userId, globalSignalId)).map((o) => o.clientOrderId || o.clientAlgoId));
      const residualOrders = (openOrders ?? []).filter((o) => o.clientOrderId && ownedOrderIds.has(o.clientOrderId));
      const residualAlgo = (openAlgoOrders ?? []).filter((o) => o.clientAlgoId && ownedOrderIds.has(o.clientAlgoId));
      return [...residualOrders, ...residualAlgo];
    } catch {
      return [{ reason: "verification-api-unavailable" }];
    }
  }

  private async markCleanupFailed(userExec: LiquidationOiUserExecutionState, reason: string, nowMs: number): Promise<void> {
    const updated: LiquidationOiUserExecutionState = { ...userExec, cleanupState: "FAILED_RETRYING", lastCleanupAttemptAt: nowMs, cleanupFailureReason: reason, updatedAt: nowMs };
    await this.globalSignalRepo.upsertUserExecution(updated);
    this.emit(userExec, nowMs, { type: "CLEANUP_FAILED_RETRYING", userId: userExec.userId, reason });
    log.error(`[LOX_CLEANUP_FAILED_RETRYING] userId=${userExec.userId} symbol=${userExec.symbol} reason=${reason} -- global CLOSED/symbol release BLOCKED until resolved`);
    const runtime = this.findRuntime(userExec.userId);
    if (runtime !== null && runtime.telegram !== null) {
      await sendTelegramWithRetry(runtime.telegram, `${userExec.symbol} ${userExec.side} CLEANUP FAILURE\nUser: ${userExec.userId}\nReason: ${reason}\nWill retry automatically. Manual review recommended if this persists.`, `CLEANUP_FAILURE userId=${userExec.userId} symbol=${userExec.symbol}`);
    }
  }

  async maybeCloseGlobal(globalSignalId: string, nowMs: number): Promise<void> {
    const allUserExecs = await this.globalSignalRepo.findUserExecutionsForSignal(globalSignalId);
    if (allUserExecs.length === 0) return;
    const summaries: UserExecutionSummary[] = allUserExecs.map((u) => ({ userId: u.userId, state: u.state, cleanupState: u.cleanupState }));
    const unresolvedCount = await this.strategyOrderRepo.countOpen(globalSignalId);
    const eligibility = isGlobalCloseEligible({ mainThesisTerminal: true, users: summaries, unresolvedStrategyOrderCount: unresolvedCount });
    if (!eligibility.eligible) {
      log.info(`[LOX_GLOBAL_NOT_YET_CLOSE_ELIGIBLE] globalSignalId=${globalSignalId} reasons=${eligibility.reasons.join("; ")}`);
      return;
    }
    const signal = await this.globalSignalRepo.findSignal(globalSignalId);
    if (signal === null) return;
    await this.globalSignalRepo.upsertSignal({ ...signal, state: "CLOSED" });
    const episodeId = this.watchManager.getLifecycle(signal.symbol)?.episodeId ?? globalSignalId;
    this.forensic({ ts: nowMs, symbol: signal.symbol, episodeId, victim: signal.victim, state: "CLOSED", episodeAgeSec: 0, type: "GLOBAL_CLOSED" });
    this.watchManager.closeActive(signal.symbol, "ALL_USERS_TERMINAL_AND_CLEAN", nowMs);
    this.forensic({ ts: nowMs, symbol: signal.symbol, episodeId, victim: signal.victim, state: "CLOSED", episodeAgeSec: 0, type: "SYMBOL_RELEASED" });
    log.info(`[LOX_GLOBAL_CLOSED] globalSignalId=${globalSignalId} symbol=${signal.symbol} -- symbol released, next independent episode may now start`);
  }

  async requestGlobalMarketExit(globalSignalId: string, reason: LiquidationOiUserExecutionState["terminalReason"], currentPrice: number, nowMs: number): Promise<void> {
    const allUserExecs = await this.globalSignalRepo.findUserExecutionsForSignal(globalSignalId);
    for (const userExec of allUserExecs.filter((u) => u.state === "ACTIVE")) {
      try { await this.requestUserMarketExit(userExec, reason, currentPrice, nowMs); }
      catch (err) { log.error({ userId: userExec.userId, globalSignalId, err: err instanceof Error ? err.message : String(err) }, "[LOX_USER_MARKET_EXIT_UNEXPECTED_ERROR] -- isolated, other users unaffected"); }
    }
  }

  private async requestUserMarketExit(userExec: LiquidationOiUserExecutionState, reason: LiquidationOiUserExecutionState["terminalReason"], currentPrice: number, nowMs: number): Promise<void> {
    // Sep 19 2026 (Karo), operator-requested REVISION -- for REAL
    // users, STRATEGY_INVALIDATION (price crossing our own SL level)
    // is now Binance's own job entirely: the resting STOP_MARKET order
    // placed at entry sits at exactly strategyInvalidationPrice (see
    // liquidation-oi-user-execution.service.ts's own doc comment), so
    // MAIN's in-process trigger for this ONE reason is redundant for
    // REAL and would race the resting order's own fill. This is a
    // no-op ONLY for this specific reason -- ADVERSE_OI_PRICE_EFFICIENCY_FLIP
    // (our own thesis-invalidation, price-independent) still reaches
    // this function and is still handled below unconditionally, since
    // Binance has no way to know about that decision on its own.
    // PAPER users are unaffected either way: no real resting order
    // exists for them, so they still need in-process monitoring for
    // BOTH reasons -- this early-return only fires for REAL.
    if (userExec.mode === "REAL" && reason === "STRATEGY_INVALIDATION") return;
    // Sep 17 2026 (Karo), operator-requested CRITICAL SAFETY FIX --
    // mode is the ONLY thing that decides whether a real Binance
    // reduce-only MARKET order is placed. A PAPER user (paper due to
    // their own flag or the global safety fallback) closes VIRTUALLY
    // at the causal reference price (the SAME live price MAIN itself
    // used to decide the exit -- no future information, no separate
    // price source), even if they happen to have a real binanceRest
    // client configured -- checking client presence alone would have
    // placed a real order for a paper user.
    if (userExec.mode === "PAPER") {
      if (userExec.entryPrice === null || userExec.quantity === null) return;
      const pnl = computePaperPnl({ side: userExec.side, entryPrice: userExec.entryPrice, exitPrice: currentPrice, quantity: userExec.quantity });
      const updated: LiquidationOiUserExecutionState = {
        ...userExec, state: "TERMINAL", terminalReason: reason, exitPrice: currentPrice,
        grossPnlUsd: pnl.grossPnlUsd, priceMovePct: pnl.priceMovePct, updatedAt: nowMs,
      };
      // Sep 17 2026 (Karo), operator-reported CRITICAL FIX -- ATOMIC
      // compare-and-swap, not read-then-write. A plain findUserExecution()
      // check followed by a separate upsertUserExecution() write left a
      // race window: two overlapping onActiveTick calls (confirmed live,
      // from bookTicker ticks arriving faster than one full tick cycle
      // completes -- see market-data-orchestrator.ts's loxTickInFlight
      // fix, the primary defense) could BOTH read "still ACTIVE" before
      // EITHER writes. terminalizeIfActive()'s filter includes
      // state==="ACTIVE" in the SAME atomic operation as the write, so
      // MongoDB itself guarantees only one concurrent caller can ever
      // win -- the loser's matchedCount is 0 and it cleanly skips all
      // further processing below (no duplicate Telegram, no lost write).
      const won = await this.globalSignalRepo.terminalizeIfActive(updated);
      if (!won) return;
      this.emit(userExec, nowMs, { type: "USER_MARKET_EXIT_CONFIRMED", userId: userExec.userId });
      log.info(`[LOX_PAPER_MARKET_EXIT_CONFIRMED] userId=${userExec.userId} symbol=${userExec.symbol} reason=${reason} exit=${currentPrice} grossPnlUsd=${pnl.grossPnlUsd.toFixed(2)}`);
      await this.runCleanup(updated, nowMs);
      return;
    }
    const runtime = this.findRuntime(userExec.userId);
    if (runtime === null || runtime.binanceRest === null || userExec.quantity === null) return;
    const closeSide = userExec.side === "LONG" ? "SELL" : "BUY";
    // Sep 19 2026 (Karo), operator-requested SAFETY FIX -- cancel the
    // resting TP (LIMIT) and SL (STOP_MARKET algo) orders BEFORE
    // placing the market exit. Without this, MAIN's own decision here
    // (e.g. ADVERSE_OI_PRICE_EFFICIENCY_FLIP, which is price-independent
    // and Binance has no way to know about on its own) could race
    // against either resting order filling independently on Binance's
    // side at nearly the same moment -- best-effort, each in its own
    // try/catch: if an order already filled or was already gone, the
    // cancel call fails harmlessly and is not itself a reason to abort
    // the market exit, which must still proceed regardless.
    if (userExec.tpBinanceOrderId !== null) {
      try { await runtime.binanceRest.cancelOrder(userExec.symbol, userExec.tpBinanceOrderId); }
      catch (err) { log.warn({ userId: userExec.userId, symbol: userExec.symbol, err: err instanceof Error ? err.message : String(err) }, "[LOX_MARKET_EXIT_TP_CANCEL_FAILED] -- likely already filled/gone, proceeding with market exit regardless"); }
    }
    if (userExec.slBinanceAlgoId !== null) {
      try { await runtime.binanceRest.cancelAlgoOrder(userExec.slBinanceAlgoId); }
      catch (err) { log.warn({ userId: userExec.userId, symbol: userExec.symbol, err: err instanceof Error ? err.message : String(err) }, "[LOX_MARKET_EXIT_SL_CANCEL_FAILED] -- likely already filled/gone, proceeding with market exit regardless"); }
    }
    try {
      const res = (await runtime.binanceRest.createOrder({ symbol: userExec.symbol, side: closeSide, type: "MARKET", quantity: String(userExec.quantity), reduceOnly: "true" })) as { orderId?: number };
      await this.strategyOrderRepo.upsert({ userId: userExec.userId, globalSignalId: userExec.globalSignalId, symbol: userExec.symbol, purpose: "MARKET_EXIT", revision: 0, clientOrderId: "", clientAlgoId: null, binanceOrderId: res.orderId ?? null, binanceAlgoId: null, state: "FILLED" });
      const updated: LiquidationOiUserExecutionState = { ...userExec, state: "TERMINAL", terminalReason: reason, exitPrice: currentPrice, updatedAt: nowMs };
      await this.globalSignalRepo.upsertUserExecution(updated);
      this.emit(userExec, nowMs, { type: "USER_MARKET_EXIT_CONFIRMED", userId: userExec.userId });
      log.info(`[LOX_USER_MARKET_EXIT_CONFIRMED] userId=${userExec.userId} symbol=${userExec.symbol} reason=${reason}`);
      await this.runCleanup(updated, nowMs);
    } catch (err) {
      log.error({ userId: userExec.userId, symbol: userExec.symbol, err: err instanceof Error ? err.message : String(err) }, "[LOX_USER_MARKET_EXIT_FAILED] -- position may remain open, will be caught by the next reconciliation pass or requires manual attention");
    }
  }
}
