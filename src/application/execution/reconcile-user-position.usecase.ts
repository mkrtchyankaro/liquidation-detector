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
  /** Sep 9 2026 (Karo), operator-requested -- reproduces the OLD,
   *  proven liqwatch-bot pattern (the old strategy engine's own
   *  synchronous active-trade removal, confirmed via direct
   *  old-code trace to run SYNCHRONOUSLY, IMMEDIATELY upon Binance
   *  confirming closed -- BEFORE any DB write or Telegram send). Called
   *  synchronously the MOMENT this function determines the position is
   *  genuinely closed, before building the DB doc and before
   *  notifyUserClose(). The caller (ReconciliationManager) uses this to
   *  remove the signal from its own openCache immediately, closing the
   *  exact gap that let a second, LATER (not concurrent -- InFlightGuard
   *  already covers concurrent) onTick() invocation still find this
   *  signal "open" and run the entire reconcile-confirm-notify chain a
   *  second time. */
  onConfirmedClosed: (signalId: string) => void,
  /** Sep 14 2026 (Karo), operator-requested fix -- see
   *  reconcileUserPositionImpl's own doc comment on this same
   *  parameter for the full rationale. */
  lastKnownPrice: number | undefined,
  /** Sep 16 2026 (Karo), operator-approved -- optional. On a
   *  CONFIRMED close (TP/SL/MANUAL), triggers an async, fire-and-
   *  forget percentile refresh for THIS symbol only -- never awaited,
   *  never blocks close processing, never used for any qualification
   *  decision here. See this function's own call site below for the
   *  exact hook point. */
  episodePercentileService?: { scheduleRefresh(symbol: string): void },
): Promise<{ closed: boolean }> {
  const result = await runtime.reconcileInFlight.run(
    userSignal.signalId,
    async () => {
      return await reconcileUserPositionImpl(
        userSignal,
        globalSignal,
        runtime,
        userSignalRepo,
        now,
        onConfirmedClosed,
        lastKnownPrice,
        episodePercentileService,
      );
    },
  );
  // Sep 8 2026 (Karo) -- `result` is `undefined` when a CONCURRENT call
  // for the same signalId was already in flight (InFlightGuard skipped
  // this one entirely) -- that other call, not this one, is
  // responsible for reporting whether it closed anything.
  return result ?? { closed: false };
}

async function reconcileUserPositionImpl(
  userSignal: UserSignalDoc,
  globalSignal: GlobalSignalDoc,
  runtime: UserRuntime,
  userSignalRepo: { upsert(userId: string, doc: UserSignalDoc): Promise<void> },
  now: number,
  onConfirmedClosed: (signalId: string) => void,
  /** Sep 14 2026 (Karo), operator-requested fix. Last known real market
   *  price for this signal's symbol, when the caller has one (a
   *  bookTicker mid at the moment of this tick, or from the fallback
   *  loop's own tracked last-seen price). Used ONLY as the closePrice
   *  approximation in the genuinely-ambiguous "UNKNOWN" reconciliation
   *  case -- restores the exact historical liqwatch-bot behavior
   *  (`v5Service.getActiveTrade(signalId)?.bestPrice ?? trade.entry`,
   *  confirmed via direct old-code trace) that the multi-user port had
   *  silently dropped, which is what produced the fake exit==entry,
   *  0.00% PnL close messages. Falls back to entry ONLY if genuinely no
   *  price is available (e.g. the very first tick after a restart,
   *  before any bookTicker has arrived for this symbol) -- never
   *  silently prefers entry over a real known price.
   */
  lastKnownPrice: number | undefined,
  /** Sep 16 2026 (Karo), operator-approved -- see reconcileUserPosition's
   *  own doc comment on this same parameter. */
  episodePercentileService?: { scheduleRefresh(symbol: string): void },
): Promise<{ closed: boolean }> {
  const userId = runtime.config.userId;
  const reconcileStartTs = Date.now();
  if (!runtime.execution) {
    log.debug(
      {
        userId,
        signalId: userSignal.signalId,
        symbol: userSignal.symbol,
        skipReason: "no-execution-configured",
      },
      "[USER_LIVE_RECONCILE_SKIPPED]",
    );
    return { closed: false };
  }

  if (runtime.reconcileHealth.shouldSkipRetry(userSignal.signalId, now)) {
    log.debug(
      {
        userId,
        signalId: userSignal.signalId,
        symbol: userSignal.symbol,
        tickTs: now,
        skipReason: "backoff-window",
      },
      "[USER_LIVE_RECONCILE_SKIPPED]",
    );
    return { closed: false };
  }

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
      {
        err: msg,
        userId,
        signalId: userSignal.signalId,
        symbol: userSignal.symbol,
        tickTs: now,
        reconcileStartTs,
      },
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
    return { closed: false };
  }

  if (runtime.reconcileHealth.recordSuccess(userSignal.signalId)) {
    log.info(
      `[USER_LIVE_RECONCILE_RECOVERED] userId=${userId} symbol=${userSignal.symbol} signalId=${userSignal.signalId}`,
    );
  }

  if (result.stillOpen) {
    log.debug(
      {
        userId,
        signalId: userSignal.signalId,
        symbol: userSignal.symbol,
        tickTs: now,
        reconcileStartTs,
        positionAmt: result.positionAmt,
      },
      "[USER_LIVE_RECONCILE_STILL_OPEN]",
    );
    return { closed: false };
  }

  const binanceDetectedCloseTs = Date.now();

  // Sep 9 2026 (Karo), operator-requested -- reproduces the OLD, proven
  // liqwatch-bot pattern EXACTLY: the moment Binance confirms the
  // position is closed, remove it from open-tracking SYNCHRONOUSLY,
  // BEFORE any DB write or Telegram send (matching the old strategy
  // engine's own synchronous active-trade removal, which the direct
  // old-code trace confirmed runs before the DB-finalize/Telegram-send
  // steps). This is what makes idempotency ATOMIC with confirmation,
  // rather than a separate, later, caller-side step.
  onConfirmedClosed(userSignal.signalId);

  let outcome: "TP" | "SL";
  let closePrice: number;
  let closeReason: "TP" | "SL" | "MANUAL";
  if (result.reason === "UNKNOWN") {
    // Sep 14 2026 (Karo), operator-reported bug fix. approxPrice is the
    // best available real-price reference for both the TP-vs-SL best-
    // effort guess AND the reported closePrice -- lastKnownPrice first
    // (matches the old, proven `bestPrice` behavior), entry only as an
    // absolute last resort when no price has ever been observed.
    const approxPrice = lastKnownPrice ?? userSignal.entry ?? 0;
    const distToTp =
      userSignal.tp !== null ? Math.abs(approxPrice - userSignal.tp) : Infinity;
    const distToSl =
      userSignal.sl !== null ? Math.abs(approxPrice - userSignal.sl) : Infinity;
    outcome = distToTp <= distToSl ? "TP" : "SL";
    closePrice = approxPrice;
    closeReason = "MANUAL";
    log.error(
      `[USER_LIVE_RECONCILE_AMBIGUOUS] userId=${userId} symbol=${userSignal.symbol} -- best-effort ${outcome} at approxPrice=${approxPrice} (usedLastKnownPrice=${lastKnownPrice !== undefined}), labeled MANUAL`,
    );
  } else {
    outcome = result.reason;
    closePrice =
      result.actualPrice > 0
        ? result.actualPrice
        : (lastKnownPrice ?? userSignal.entry ?? 0);
    closeReason = result.reason;
  }

  log.info(
    `[USER_LIVE_RECONCILE_CONFIRMED] userId=${userId} symbol=${userSignal.symbol} reason=${outcome} closePrice=${closePrice} positionAmt=${result.positionAmt} tickTs=${now} reconcileStartTs=${reconcileStartTs} binanceDetectedCloseTs=${binanceDetectedCloseTs}`,
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

  const localDbCloseTs = Date.now();
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
  log.info(
    {
      userId,
      signalId: userSignal.signalId,
      symbol: userSignal.symbol,
      localDbCloseTs,
    },
    "[USER_LIVE_RECONCILE_DB_CLOSED]",
  );

  // Sep 16 2026 (Karo), operator-approved -- fire-and-forget, this
  // symbol only, BOTH directions refreshed regardless of this trade's
  // own side (the rolling 3-day market history may have changed for
  // either). NEVER awaited -- close processing must not wait for it.
  // Deduplicated inside the service itself if a refresh for this
  // symbol is already in flight from another user's close.
  episodePercentileService?.scheduleRefresh(userSignal.symbol);

  const message = formatV5CloseMessage(
    userSignal.symbol,
    userSignal.side,
    closeReason,
    userSignal.entry ?? 0,
    closePrice,
    globalSignal.entryWaveNumber,
  );
  await notifyUserClose(message, runtime);
  const telegramSentTs = Date.now();
  log.info(
    {
      userId,
      signalId: userSignal.signalId,
      symbol: userSignal.symbol,
      tickTs: now,
      reconcileStartTs,
      binanceDetectedCloseTs,
      localDbCloseTs,
      telegramSentTs,
      totalMs: telegramSentTs - reconcileStartTs,
    },
    "[USER_LIVE_RECONCILE_TIMING]",
  );
  // Sep 12 2026 (Karo), operator-reported CRITICAL FIX -- this used to
  // ALSO return `message` as `broadcastMessage` so the caller
  // (ReconciliationManager.onTick()) could send this SAME real-
  // execution CLOSE through every OTHER user's own telegram client
  // too. Execution CLOSE notifications must be strictly per-user: the
  // notifyUserClose() call directly above (to THIS user's own runtime,
  // the actual position owner) is the only send that belongs here.
  // Removed entirely -- no broadcast mechanism replaces it.
  return { closed: true };
}
