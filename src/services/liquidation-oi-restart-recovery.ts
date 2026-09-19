import { LiquidationOiGlobalSignalRepository } from "../infrastructure/mongo/liquidation-oi-global-signal.repository";
import { StrategyOrderRepository } from "../infrastructure/mongo/strategy-order.repository";
import type { LiquidationOiPositionLifecycleService } from "./liquidation-oi-position-lifecycle.service";
import type { LiquidationOiWatchManager } from "../domain/liquidation-oi-strategy/liquidation-oi-watch-manager";
import type { LiquidationOiUserRuntimeRef } from "./liquidation-oi-runtime-orchestrator";
import { strategyClientOrderId } from "../domain/liquidation-oi-strategy/strategy-order-identity";
import type { BinanceRestLike } from "../infrastructure/binance/liquidation-oi-user-execution.service";
import type { ForensicEvent } from "../domain/liquidation-oi-strategy/forensic-events";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "lox-restart-recovery" });

/**
 * Sep 17 2026 (Karo), operator-requested production-completion pass,
 * Section N -- EXTENDED Sep 17 2026 (Karo), operator-requested
 * operational-safety pass, to close two source-audit-confirmed gaps:
 *
 * GAP 1 -- "stuck ACTIVE forever": maybeCloseGlobal() was previously
 * only ever called from inside runCleanup(), which only runs for a
 * user actively being reconciled THIS pass. If every user for a
 * signal was ALREADY terminal+COMPLETE before a crash (e.g. the crash
 * landed between the last user's cleanup completing and its own
 * maybeCloseGlobal() call), restart's own per-user loop (which only
 * looks at state==="ACTIVE" rows) found nothing to act on for that
 * signal, and the global row stayed ACTIVE forever. Fixed by sweeping
 * maybeCloseGlobal() for EVERY open signal, unconditionally, after
 * per-user reconciliation.
 *
 * GAP 2 -- "restart loses the lock": LiquidationOiWatchManager's own
 * `symbols` map and SymbolOwnershipRegistry both started COMPLETELY
 * EMPTY after every restart (confirmed: hydrate() was never called
 * anywhere in this codebase) -- a symbol with a genuinely still-ACTIVE
 * global signal in Mongo was NOT locked in-memory, so a fresh
 * liquidation event for that same symbol post-restart would have
 * started a competing episode. Fixed by calling the new
 * watchManager.restoreActiveLifecycle() for every signal confirmed
 * (after the sweep above) to still be genuinely ACTIVE.
 *
 * RESTART INVARIANT: this function NEVER calls createOrder with a
 * MARKET entry type, and NEVER constructs a fresh
 * LiquidationOiUserExecutionState -- it only reads existing Mongo
 * rows, marks genuinely-resolved ones terminal/closed (via the shared
 * reconciler and eligibility rules -- never a bare timeout), and
 * re-verifies/re-places PROTECTIVE orders using deterministic
 * clientOrderIds (idempotent). Nothing here can create a second
 * position, and nothing here closes a signal merely because it is old.
 */

export async function recoverLoxOnRestart(
  globalSignalRepo: LiquidationOiGlobalSignalRepository,
  strategyOrderRepo: StrategyOrderRepository,
  positionLifecycle: LiquidationOiPositionLifecycleService,
  watchManager: LiquidationOiWatchManager,
  getUserRuntimes: () => readonly LiquidationOiUserRuntimeRef[],
  forensic: (event: ForensicEvent) => void,
  nowMs: number,
): Promise<void> {
  const openSignals = await globalSignalRepo.findOpenSignals();
  log.info(`[LOX_RESTART_RECONCILIATION_START] ${openSignals.length} non-terminal global signal(s) found`);

  for (const signal of openSignals) {
    try {
      if (signal.state === "ENTRY_READY") {
        await globalSignalRepo.upsertSignal({ ...signal, state: "CANCELLED" });
        forensic({ ts: nowMs, symbol: signal.symbol, episodeId: signal.globalSignalId, victim: signal.victim, state: "CANCELLED", episodeAgeSec: 0, type: "RESTART_RECONCILIATION", outcome: "ENTRY_READY_CANCELLED_ON_RESTART", detail: "process restarted mid-resolution -- never assume a real position resulted" });
        log.warn(`[LOX_RESTART_STUCK_ENTRY_READY_CANCELLED] symbol=${signal.symbol} globalSignalId=${signal.globalSignalId}`);
        continue; // not ACTIVE -- nothing further to reconcile or hydrate for this one
      }

      const userExecs = await globalSignalRepo.findUserExecutionsForSignal(signal.globalSignalId);
      for (const userExec of userExecs.filter((u) => u.state === "ACTIVE")) {
        // Sep 17 2026 (Karo), operator-reported CRITICAL FIX (defense in
        // depth, matching the same fix in reconcileOneUser) -- a PAPER
        // user must NEVER be Binance-reconciled here either, even though
        // it is transitively safe today (a paper user's real position is
        // always flat, so the loop below would just `continue`) -- an
        // explicit, unconditional skip is required so a future change to
        // this loop can never silently start treating a paper user's
        // always-flat position as something to act on.
        if (userExec.mode === "PAPER") continue;
        const runtime = getUserRuntimes().find((r) => r.userId === userExec.userId);
        if (runtime === undefined || runtime.binanceRest === null) {
          forensic({ ts: nowMs, symbol: signal.symbol, episodeId: signal.globalSignalId, victim: signal.victim, state: "ACTIVE", episodeAgeSec: 0, type: "RESTART_RECONCILIATION", outcome: "NO_CLIENT_UNRESOLVED", detail: `userId=${userExec.userId} has no configured Binance client -- remains unresolved` });
          continue;
        }
        const rest: BinanceRestLike = runtime.binanceRest;
        try {
          const posRes = (await rest.getPositionRisk(signal.symbol)) as Array<{ symbol: string; positionAmt: string }>;
          const pos = posRes.find((p) => p.symbol === signal.symbol);
          const isFlat = !pos || Math.abs(Number(pos.positionAmt)) < 1e-9;
          if (isFlat) continue; // reconcileAll() below discovers and cleans this up

          if (userExec.slBinanceAlgoId !== null) {
            const stop = (await rest.getAlgoOrder(userExec.slBinanceAlgoId)) as { algoStatus?: string };
            if (stop.algoStatus !== "WORKING" && stop.algoStatus !== "NEW") {
              log.error(`[LOX_RESTART_MISSING_SL] userId=${userExec.userId} symbol=${signal.symbol} algoStatus=${stop.algoStatus} -- re-placing deterministically`);
              if (signal.strategyInvalidationPrice !== null) {
                const clientAlgoId = strategyClientOrderId(userExec.userId, signal.globalSignalId, "STOP_LOSS", 0);
                const closeSide = userExec.side === "LONG" ? "SELL" : "BUY";
                try {
                  const replaced = (await rest.createAlgoOrder({ symbol: signal.symbol, side: closeSide, type: "STOP_MARKET", quantity: String(userExec.quantity ?? 0), triggerPrice: String(signal.strategyInvalidationPrice), reduceOnly: "true", newClientAlgoId: clientAlgoId })) as { algoId?: number };
                  await strategyOrderRepo.upsert({ userId: userExec.userId, globalSignalId: signal.globalSignalId, symbol: signal.symbol, purpose: "STOP_LOSS", revision: 0, clientOrderId: "", clientAlgoId, binanceOrderId: null, binanceAlgoId: replaced.algoId ?? null, state: "OPEN" });
                  forensic({ ts: nowMs, symbol: signal.symbol, episodeId: signal.globalSignalId, victim: signal.victim, state: "ACTIVE", episodeAgeSec: 0, type: "RESTART_RECONCILIATION", outcome: "SL_REPLACED", detail: `userId=${userExec.userId}` });
                } catch (err) {
                  log.error({ userId: userExec.userId, err: err instanceof Error ? err.message : String(err) }, "[LOX_RESTART_EMERGENCY_STOP_REPLACE_FAILED] -- genuinely unprotected position, requires manual attention");
                  forensic({ ts: nowMs, symbol: signal.symbol, episodeId: signal.globalSignalId, victim: signal.victim, state: "ACTIVE", episodeAgeSec: 0, type: "RESTART_RECONCILIATION", outcome: "EMERGENCY_STOP_REPLACE_FAILED", detail: `userId=${userExec.userId}: ${err instanceof Error ? err.message : String(err)}` });
                }
              }
            } else {
              forensic({ ts: nowMs, symbol: signal.symbol, episodeId: signal.globalSignalId, victim: signal.victim, state: "ACTIVE", episodeAgeSec: 0, type: "RESTART_RECONCILIATION", outcome: "VERIFIED_HEALTHY", detail: `userId=${userExec.userId} position and emergency stop both confirmed live` });
            }
          }
        } catch (err) {
          log.error({ userId: userExec.userId, symbol: signal.symbol, err: err instanceof Error ? err.message : String(err) }, "[LOX_RESTART_RECONCILE_USER_FAILED] -- API unavailable, remains unresolved");
        }
      }
    } catch (err) {
      log.error({ globalSignalId: signal.globalSignalId, err: err instanceof Error ? err.message : String(err) }, "[LOX_RESTART_RECONCILE_SIGNAL_UNEXPECTED_ERROR] -- isolated");
    }
  }

  // Sep 17 2026 (Karo) -- per-user reconciliation (TP/stop-fill detection,
  // cleanup) BEFORE the close-eligibility sweep below, so a user who
  // becomes terminal here is already accounted for when we check whether
  // each signal is now eligible to close.
  await positionLifecycle.reconcileAll(nowMs);

  // GAP 1 fix: sweep every open signal for close-eligibility, not just
  // ones whose users happened to be freshly reconciled above. This is
  // the ONLY thing that can advance a signal whose every user was
  // ALREADY terminal+COMPLETE before this restart even began.
  for (const signal of openSignals) {
    if (signal.state === "ACTIVE") {
      try { await positionLifecycle.maybeCloseGlobal(signal.globalSignalId, nowMs); }
      catch (err) { log.error({ globalSignalId: signal.globalSignalId, err: err instanceof Error ? err.message : String(err) }, "[LOX_RESTART_CLOSE_ELIGIBILITY_SWEEP_FAILED] -- isolated"); }
    }
  }

  // GAP 2 fix: for every signal STILL genuinely ACTIVE after the sweep
  // above, restore its in-memory lock -- otherwise a fresh liquidation
  // event on that same symbol would start a competing episode. Never
  // closes a healthy signal merely because it survived restart; this
  // only LOCKS what genuinely remains open.
  let restoredCount = 0;
  for (const globalSignalId of new Set(openSignals.map((s) => s.globalSignalId))) {
    const current = await globalSignalRepo.findSignal(globalSignalId);
    if (current === null || current.state !== "ACTIVE") continue;
    watchManager.restoreActiveLifecycle(current.symbol, current.globalSignalId, current.ownershipId, current.victim, current.sameDirectionLiqUsd, current.extremePrice, nowMs);
    restoredCount++;
  }
  log.info(`[LOX_RESTART_RECONCILIATION_COMPLETE] restoredActiveLocks=${restoredCount}`);
}
