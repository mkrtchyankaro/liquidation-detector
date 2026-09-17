import { LiquidationOiGlobalSignalRepository } from "../infrastructure/mongo/liquidation-oi-global-signal.repository";
import { StrategyOrderRepository } from "../infrastructure/mongo/strategy-order.repository";
import type { LiquidationOiPositionLifecycleService } from "./liquidation-oi-position-lifecycle.service";
import type { LiquidationOiUserRuntimeRef } from "./liquidation-oi-runtime-orchestrator";
import { strategyClientOrderId } from "../domain/liquidation-oi-strategy/strategy-order-identity";
import type { BinanceRestLike } from "../infrastructure/binance/liquidation-oi-user-execution.service";
import type { ForensicEvent } from "../domain/liquidation-oi-strategy/forensic-events";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "lox-restart-recovery" });

/**
 * Sep 17 2026 (Karo), operator-requested production-completion pass,
 * Section N. Called ONCE from main.ts, before any new liquidation
 * event or tick is processed. Reuses
 * LiquidationOiPositionLifecycleService's OWN reconcileAll() for the
 * bulk of the work -- this file adds ONLY the two genuinely
 * restart-specific pieces reconcileAll() does not already cover: a
 * stuck in-flight ENTRY_READY signal, and re-verifying emergency
 * protection still exists for a position confirmed to genuinely
 * still be open.
 *
 * RESTART INVARIANT: this function NEVER calls createOrder with a
 * MARKET entry type, and NEVER constructs a fresh
 * LiquidationOiUserExecutionState -- it only reads existing Mongo
 * rows and either marks them terminal (via the shared reconciler) or
 * re-verifies/re-places PROTECTIVE orders using deterministic
 * clientOrderIds (idempotent). Nothing here can create a second
 * position.
 */

export async function recoverLoxOnRestart(
  globalSignalRepo: LiquidationOiGlobalSignalRepository,
  strategyOrderRepo: StrategyOrderRepository,
  positionLifecycle: LiquidationOiPositionLifecycleService,
  getUserRuntimes: () => readonly LiquidationOiUserRuntimeRef[],
  forensic: (event: ForensicEvent) => void,
  nowMs: number,
): Promise<void> {
  const openSignals = await globalSignalRepo.findOpenSignals();
  log.info(
    `[LOX_RESTART_RECONCILIATION_START] ${openSignals.length} non-terminal global signal(s) found`,
  );

  for (const signal of openSignals) {
    try {
      if (signal.state === "ENTRY_READY") {
        await globalSignalRepo.upsertSignal({ ...signal, state: "CANCELLED" });
        forensic({
          ts: nowMs,
          symbol: signal.symbol,
          episodeId: signal.globalSignalId,
          victim: signal.victim,
          state: "CANCELLED",
          episodeAgeSec: 0,
          type: "RESTART_RECONCILIATION",
          outcome: "ENTRY_READY_CANCELLED_ON_RESTART",
          detail:
            "process restarted mid-resolution -- never assume a real position resulted",
        });
        log.warn(
          `[LOX_RESTART_STUCK_ENTRY_READY_CANCELLED] symbol=${signal.symbol} globalSignalId=${signal.globalSignalId}`,
        );
      }

      const userExecs = await globalSignalRepo.findUserExecutionsForSignal(
        signal.globalSignalId,
      );
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
        const runtime = getUserRuntimes().find(
          (r) => r.userId === userExec.userId,
        );
        if (runtime === undefined || runtime.binanceRest === null) {
          forensic({
            ts: nowMs,
            symbol: signal.symbol,
            episodeId: signal.globalSignalId,
            victim: signal.victim,
            state: "ACTIVE",
            episodeAgeSec: 0,
            type: "RESTART_RECONCILIATION",
            outcome: "NO_CLIENT_UNRESOLVED",
            detail: `userId=${userExec.userId} has no configured Binance client -- remains unresolved`,
          });
          continue;
        }
        const rest: BinanceRestLike = runtime.binanceRest;
        try {
          const posRes = (await rest.getPositionRisk(signal.symbol)) as Array<{
            symbol: string;
            positionAmt: string;
          }>;
          const pos = posRes.find((p) => p.symbol === signal.symbol);
          const isFlat = !pos || Math.abs(Number(pos.positionAmt)) < 1e-9;
          if (isFlat) continue; // reconcileAll() below discovers and cleans this up

          if (userExec.emergencyStopBinanceAlgoId !== null) {
            const stop = (await rest.getAlgoOrder(
              userExec.emergencyStopBinanceAlgoId,
            )) as { algoStatus?: string };
            if (stop.algoStatus !== "WORKING" && stop.algoStatus !== "NEW") {
              log.error(
                `[LOX_RESTART_MISSING_EMERGENCY_STOP] userId=${userExec.userId} symbol=${signal.symbol} algoStatus=${stop.algoStatus} -- re-placing deterministically`,
              );
              if (signal.emergencyHardStopPrice !== null) {
                const clientAlgoId = strategyClientOrderId(
                  userExec.userId,
                  signal.globalSignalId,
                  "EMERGENCY_STOP",
                  0,
                );
                const closeSide = userExec.side === "LONG" ? "SELL" : "BUY";
                try {
                  const replaced = (await rest.createAlgoOrder({
                    symbol: signal.symbol,
                    side: closeSide,
                    type: "STOP_MARKET",
                    quantity: String(userExec.quantity ?? 0),
                    triggerPrice: String(signal.emergencyHardStopPrice),
                    reduceOnly: "true",
                    newClientAlgoId: clientAlgoId,
                  })) as { algoId?: number };
                  await strategyOrderRepo.upsert({
                    userId: userExec.userId,
                    globalSignalId: signal.globalSignalId,
                    symbol: signal.symbol,
                    purpose: "EMERGENCY_STOP",
                    revision: 0,
                    clientOrderId: "",
                    clientAlgoId,
                    binanceOrderId: null,
                    binanceAlgoId: replaced.algoId ?? null,
                    state: "OPEN",
                  });
                  forensic({
                    ts: nowMs,
                    symbol: signal.symbol,
                    episodeId: signal.globalSignalId,
                    victim: signal.victim,
                    state: "ACTIVE",
                    episodeAgeSec: 0,
                    type: "RESTART_RECONCILIATION",
                    outcome: "EMERGENCY_STOP_REPLACED",
                    detail: `userId=${userExec.userId}`,
                  });
                } catch (err) {
                  log.error(
                    {
                      userId: userExec.userId,
                      err: err instanceof Error ? err.message : String(err),
                    },
                    "[LOX_RESTART_EMERGENCY_STOP_REPLACE_FAILED] -- genuinely unprotected position, requires manual attention",
                  );
                  forensic({
                    ts: nowMs,
                    symbol: signal.symbol,
                    episodeId: signal.globalSignalId,
                    victim: signal.victim,
                    state: "ACTIVE",
                    episodeAgeSec: 0,
                    type: "RESTART_RECONCILIATION",
                    outcome: "EMERGENCY_STOP_REPLACE_FAILED",
                    detail: `userId=${userExec.userId}: ${err instanceof Error ? err.message : String(err)}`,
                  });
                }
              }
            } else {
              forensic({
                ts: nowMs,
                symbol: signal.symbol,
                episodeId: signal.globalSignalId,
                victim: signal.victim,
                state: "ACTIVE",
                episodeAgeSec: 0,
                type: "RESTART_RECONCILIATION",
                outcome: "VERIFIED_HEALTHY",
                detail: `userId=${userExec.userId} position and emergency stop both confirmed live`,
              });
            }
          }
        } catch (err) {
          log.error(
            {
              userId: userExec.userId,
              symbol: signal.symbol,
              err: err instanceof Error ? err.message : String(err),
            },
            "[LOX_RESTART_RECONCILE_USER_FAILED] -- API unavailable, remains unresolved",
          );
        }
      }
    } catch (err) {
      log.error(
        {
          globalSignalId: signal.globalSignalId,
          err: err instanceof Error ? err.message : String(err),
        },
        "[LOX_RESTART_RECONCILE_SIGNAL_UNEXPECTED_ERROR] -- isolated",
      );
    }
  }

  await positionLifecycle.reconcileAll(nowMs);
  log.info("[LOX_RESTART_RECONCILIATION_COMPLETE]");
}
