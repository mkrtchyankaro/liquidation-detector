import type { GlobalSignalDoc } from "../../domain/signal/global-signal.model";
import type { UserSignalDoc } from "../../domain/signal/user-signal.model";
import type { UserRuntime } from "../../services/user-runtime";
import { childLogger } from "../../infrastructure/logging/logger";

const log = childLogger({ mod: "execute-for-user" });

/**
 * Sep 8 2026 (Karo). Position-sizing formula and the SUCCESS-path
 * field mapping (actualEntry/replannedSl/replannedTp/slOrderId/
 * tpOrderId/actualQty/actualNotionalUsdt/actualRiskUsd) are REUSED,
 * byte-identical, from liqwatch-bot's own app.ts entry-firing block
 * (the same block that wires V5's evaluateSignal() output into
 * BinanceExecutionService.run()) -- see MIGRATION_NOTES.md for the
 * exact old file/line references. Only the ORCHESTRATION (which
 * user's own runtime, which user's own Mongo doc) is new.
 *
 * Sep 8 2026 (Karo) -- TWO diagnostic fixes, found during a real
 * incident investigation (karo's own live-armed execution silently
 * never firing):
 *   1. `telegramSent` used to be unconditionally hardcoded false in
 *      this function's own baseDoc -- now takes the REAL result of
 *      notifyUser() as a parameter (signal-distributor.ts calls
 *      notifyUser() first and passes its boolean return value in).
 *   2. `execResult.reason` (e.g. "plan invalid: invalid-input") used
 *      to be thrown away whenever status became NOT_EXECUTED/
 *      EXECUTION_FAILED -- now persisted as executionSkipReason, so
 *      the operator never again has to manually grep raw PM2 logs by
 *      signalId to find out WHY a trade didn't fire.
 */
export async function executeForUser(
  globalSignal: GlobalSignalDoc,
  runtime: UserRuntime,
  userSignalRepo: { upsert(userId: string, doc: UserSignalDoc): Promise<void> },
  telegramSent: boolean,
): Promise<void> {
  const userId = runtime.config.userId;
  const now = Date.now();

  const baseDoc: UserSignalDoc = {
    signalId: globalSignal.signalId,
    symbol: globalSignal.symbol,
    side: globalSignal.side,
    telegramSent,
    telegramSentAt: telegramSent ? now : null,
    executionEnabled: runtime.config.binance?.enabled ?? false,
    status: "NOT_EXECUTED",
    executionSkipReason: null,
    isLive: false,
    binanceSlOrderId: null,
    binanceTpOrderId: null,
    positionQty: null,
    notional: null,
    riskUsd: null,
    entry: globalSignal.entry,
    sl: globalSignal.sl,
    tp: globalSignal.tp,
    closedAt: null,
    closePrice: null,
    closeReason: null,
    maxFavorableR: null,
    maxAdverseR: null,
    createdAt: now,
    updatedAt: now,
  };

  if (
    globalSignal.entry === null ||
    globalSignal.sl === null ||
    globalSignal.tp === null
  ) {
    baseDoc.status = "TELEGRAM_ONLY";
    baseDoc.executionSkipReason =
      "canonical plan has no entry/sl/tp (plan-rejected)";
    await userSignalRepo.upsert(userId, baseDoc);
    return;
  }

  if (!runtime.execution || !runtime.config.binance?.enabled) {
    baseDoc.status = "TELEGRAM_ONLY";
    await userSignalRepo.upsert(userId, baseDoc);
    return;
  }

  const slDistance = Math.abs(globalSignal.entry - globalSignal.sl);
  if (slDistance <= 0) {
    baseDoc.status = "NOT_EXECUTED";
    baseDoc.executionSkipReason = "slDistance <= 0";
    await userSignalRepo.upsert(userId, baseDoc);
    return;
  }

  // Same combined daily-loss-limit check shape as liqwatch-bot's own
  // (there, V3+V5 cross-awareness within one instance; here, simply
  // this user's own tracker -- there is no second strategy to combine
  // with in this project).
  if (runtime.dailyLossLimit.isOwnBlocked(now)) {
    log.warn(
      `[USER_DAILY_LOSS_LIMIT] userId=${userId} symbol=${globalSignal.symbol} -- execution skipped`,
    );
    baseDoc.status = "NOT_EXECUTED";
    baseDoc.executionSkipReason = "daily loss limit reached";
    await userSignalRepo.upsert(userId, baseDoc);
    return;
  }

  const riskUsd = runtime.config.risk.riskUsd;
  const positionQty = riskUsd / slDistance;
  const positionSizeUsdt = positionQty * globalSignal.entry;

  const w1 = globalSignal.waveHistory[0];
  const w2 =
    globalSignal.waveHistory.find(
      (w) => w.waveNumber === globalSignal.entryWaveNumber,
    ) ?? globalSignal.waveHistory[globalSignal.waveHistory.length - 1];

  try {
    const execResult = await runtime.execution.run({
      symbol: globalSignal.symbol,
      side: globalSignal.side,
      entry: globalSignal.entry,
      stopLoss: globalSignal.sl,
      takeProfit: globalSignal.tp,
      riskUsd,
      positionSizeUsdt,
      signalId: globalSignal.signalId,
      w1AnchorPrice: w1?.anchorPrice ?? globalSignal.entry,
      w1ExtremePrice: w1?.extremePrice ?? globalSignal.entry,
      w1LiqUsd: w1?.liqNotionalUsd ?? 0,
      w2LiqUsd: w2?.liqNotionalUsd ?? 0,
      w2ExtremePrice: w2?.extremePrice ?? globalSignal.entry,
      unitAbs: globalSignal.unitAtStart,
      p95: globalSignal.p95AtEntry,
      dailyLiqPerMinBaseline: globalSignal.dailyLiqPerMinBaselineAtEntry,
    });

    if (execResult.status === "SUCCESS") {
      baseDoc.status = "OPEN";
      baseDoc.isLive = true;
      baseDoc.entry = execResult.actualEntry;
      baseDoc.sl = execResult.replannedSl;
      baseDoc.tp = execResult.replannedTp;
      baseDoc.binanceSlOrderId = execResult.slOrderId;
      baseDoc.binanceTpOrderId = execResult.tpOrderId;
      baseDoc.positionQty = execResult.actualQty;
      baseDoc.notional = execResult.actualNotionalUsdt;
      baseDoc.riskUsd = execResult.actualRiskUsd;
      log.info(
        `[USER_LIVE_EXECUTED] userId=${userId} symbol=${globalSignal.symbol} entry=${execResult.actualEntry}`,
      );
    } else {
      baseDoc.status = "NOT_EXECUTED";
      baseDoc.executionSkipReason =
        execResult.status === "ABORTED"
          ? execResult.reason
          : "shadow mode -- not a real error, no order was ever intended";
      log.warn(
        `[USER_EXECUTION_SKIPPED] userId=${userId} symbol=${globalSignal.symbol} signalId=${globalSignal.signalId} reason=${baseDoc.executionSkipReason}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { err: msg, userId, signalId: globalSignal.signalId },
      "[USER_EXECUTION_FAILED] -- isolated, other users unaffected",
    );
    baseDoc.status = "EXECUTION_FAILED";
    baseDoc.executionSkipReason = msg;
  }

  await userSignalRepo.upsert(userId, baseDoc);
}
