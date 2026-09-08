import type { UserSignalDoc } from "../../domain/signal/user-signal.model";
import type { GlobalSignalDoc } from "../../domain/signal/global-signal.model";
import type { UserRuntime } from "../../services/user-runtime";
import { formatV5CloseMessage } from "../../infrastructure/telegram/signal.formatter";
import { notifyUserClose } from "../signal/notify-user.usecase";
import { childLogger } from "../../infrastructure/logging/logger";

const log = childLogger({ mod: "reconcile-user-position" });

/**
 * Sep 8 2026 (Karo). Ported, behavior-preserving, from liqwatch-bot's
 * own app.ts reconcileV5LiveTradeImpl() (which itself already
 * incorporated the InFlightGuard race-fix and ReconciliationHealthTracker
 * backoff/alert mechanism from the Sep 8 2026 preservation audit -- see
 * MIGRATION_NOTES.md for exact old-file line references). Adapted here
 * ONLY for per-user scoping (runtime.execution instead of a shared
 * process-wide instance, runtime's own InFlightGuard/ReconciliationHealthTracker,
 * this user's own UserSignalRepository). The core algorithm --
 * positionAmt===0 is the ONLY source of truth for "closed", best-effort
 * TP/SL-guess on ambiguous UNKNOWN reason, never any timeout-based
 * false-close -- is UNCHANGED.
 */
export async function reconcileUserPosition(
  userSignal: UserSignalDoc,
  globalSignal: GlobalSignalDoc,
  runtime: UserRuntime,
  userSignalRepo: { upsert(userId: string, doc: UserSignalDoc): Promise<void> },
  now: number,
): Promise<boolean> {
  const result = await runtime.reconcileInFlight.run(
    userSignal.signalId,
    async () => {
      return await reconcileUserPositionImpl(
        userSignal,
        globalSignal,
        runtime,
        userSignalRepo,
        now,
      );
    },
  );
  // Sep 8 2026 (Karo) -- `result` is `undefined` when a CONCURRENT call
  // for the same signalId was already in flight (InFlightGuard skipped
  // this one entirely) -- that other call, not this one, is
  // responsible for reporting whether it closed anything.
  return result ?? false;
}

async function reconcileUserPositionImpl(
  userSignal: UserSignalDoc,
  globalSignal: GlobalSignalDoc,
  runtime: UserRuntime,
  userSignalRepo: { upsert(userId: string, doc: UserSignalDoc): Promise<void> },
  now: number,
): Promise<boolean> {
  const userId = runtime.config.userId;
  if (!runtime.execution) return false;

  if (runtime.reconcileHealth.shouldSkipRetry(userSignal.signalId, now))
    return false;

  let result: Awaited<
    ReturnType<typeof runtime.execution.reconcileLivePosition>
  >;
  try {
    result = await runtime.execution.reconcileLivePosition(
      userSignal.symbol,
      userSignal.binanceSlOrderId,
      userSignal.binanceTpOrderId,
      userSignal.signalId,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { err: msg, userId, signalId: userSignal.signalId },
      "[USER_LIVE_RECONCILE_FAILED] -- will retry after backoff",
    );
    const shouldAlert = runtime.reconcileHealth.recordFailure(
      userSignal.signalId,
      now,
    );
    if (shouldAlert && runtime.telegram) {
      try {
        await runtime.telegram.sendMessage(
          `\u26a0\ufe0f RECONCILIATION ALERT (${userId})\n\n` +
            `Cannot verify ${userSignal.symbol} position status via Binance API for 5+ minutes.\n` +
            `signalId: ${userSignal.signalId}\n\n` +
            `The trade is NOT being closed automatically -- Binance remains the sole authority. Please check directly.`,
        );
      } catch (alertErr) {
        const alertMsg =
          alertErr instanceof Error ? alertErr.message : String(alertErr);
        log.error(
          { err: alertMsg, userId },
          "[USER_LIVE_RECONCILE_ALERT_SEND_FAILED]",
        );
      }
    }
    return false;
  }

  if (runtime.reconcileHealth.recordSuccess(userSignal.signalId)) {
    log.info(
      `[USER_LIVE_RECONCILE_RECOVERED] userId=${userId} symbol=${userSignal.symbol} signalId=${userSignal.signalId}`,
    );
  }

  if (result.stillOpen) return false;

  let outcome: "TP" | "SL";
  let closePrice: number;
  let closeReason: "TP" | "SL" | "MANUAL";
  if (result.reason === "UNKNOWN") {
    const distToTp =
      userSignal.tp !== null && userSignal.entry !== null
        ? Math.abs(userSignal.entry - userSignal.tp)
        : Infinity;
    const distToSl =
      userSignal.sl !== null && userSignal.entry !== null
        ? Math.abs(userSignal.entry - userSignal.sl)
        : Infinity;
    outcome = distToTp <= distToSl ? "TP" : "SL";
    closePrice = userSignal.entry ?? 0;
    closeReason = "MANUAL";
    log.error(
      `[USER_LIVE_RECONCILE_AMBIGUOUS] userId=${userId} symbol=${userSignal.symbol} -- best-effort ${outcome}, labeled MANUAL`,
    );
  } else {
    outcome = result.reason;
    closePrice = result.actualPrice;
    closeReason = result.reason;
  }

  log.info(
    `[USER_LIVE_RECONCILE_CONFIRMED] userId=${userId} symbol=${userSignal.symbol} reason=${outcome} closePrice=${closePrice}`,
  );

  if (
    userSignal.positionQty !== null &&
    userSignal.notional !== null &&
    userSignal.entry !== null
  ) {
    const FEE_ROUNDTRIP_PCT = 0.001;
    const dirMul = userSignal.side === "LONG" ? 1 : -1;
    const grossPnl =
      (closePrice - userSignal.entry) * userSignal.positionQty * dirMul;
    const fees = userSignal.notional * FEE_ROUNDTRIP_PCT;
    runtime.dailyLossLimit.recordRealizedPnl(grossPnl - fees, now);
  }

  const updated: UserSignalDoc = {
    ...userSignal,
    status:
      closeReason === "MANUAL"
        ? "CLOSED_MANUAL"
        : outcome === "TP"
          ? "CLOSED_TP"
          : "CLOSED_SL",
    isLive: false,
    closedAt: now,
    closePrice,
    closeReason,
    updatedAt: now,
  };
  await userSignalRepo.upsert(userId, updated);
  await runtime.execution.recordConfirmedClose(userSignal.signalId, outcome);

  const message = formatV5CloseMessage(
    userSignal.symbol,
    userSignal.side,
    outcome,
    userSignal.entry ?? 0,
    closePrice,
    globalSignal.entryWaveNumber,
  );
  await notifyUserClose(message, runtime);
  return true;
}
