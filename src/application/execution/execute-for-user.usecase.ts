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
 */
export async function executeForUser(
  globalSignal: GlobalSignalDoc,
  runtime: UserRuntime,
  userSignalRepo: { upsert(userId: string, doc: UserSignalDoc): Promise<void> },
): Promise<void> {
  const userId = runtime.config.userId;
  const now = Date.now();

  const baseDoc: UserSignalDoc = {
    signalId: globalSignal.signalId,
    symbol: globalSignal.symbol,
    side: globalSignal.side,
    telegramSent: false,
    telegramSentAt: null,
    executionEnabled: runtime.config.binance?.enabled ?? false,
    status: "NOT_EXECUTED",
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

  if (globalSignal.entry === null || globalSignal.sl === null || globalSignal.tp === null) {
    baseDoc.status = "TELEGRAM_ONLY";
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
    await userSignalRepo.upsert(userId, baseDoc);
    return;
  }

  // Same combined daily-loss-limit check shape as liqwatch-bot's own
  // (there, V3+V5 cross-awareness within one instance; here, simply
  // this user's own tracker -- there is no second strategy to combine
  // with in this project).
  if (runtime.dailyLossLimit.isOwnBlocked(now)) {
    log.warn(`[USER_DAILY_LOSS_LIMIT] userId=${userId} symbol=${globalSignal.symbol} -- execution skipped`);
    baseDoc.status = "NOT_EXECUTED";
    await userSignalRepo.upsert(userId, baseDoc);
    return;
  }

  const riskUsd = runtime.config.risk.riskUsd;
  const positionQty = riskUsd / slDistance;
  const positionSizeUsdt = positionQty * globalSignal.entry;

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
      cumLiq: globalSignal.totalEpisodePressure,
      liqBaseline: globalSignal.physics?.liqBaseline ?? 0,
      atr15mPct: globalSignal.physics?.atrPct ?? 0,
      walls: globalSignal.wallContext
        ? { atEntry: { ...globalSignal.wallContext, topBidPersistent: false, topAskPersistent: false }, atAnchor: { ...globalSignal.wallContext, topBidPersistent: false, topAskPersistent: false }, atSweepStart: null }
        : { atEntry: { topBidNotional: 0, topAskNotional: 0, topBidPrice: 0, topAskPrice: 0, imbalance: 0, topBidPersistent: false, topAskPersistent: false }, atAnchor: { topBidNotional: 0, topAskNotional: 0, topBidPrice: 0, topAskPrice: 0, imbalance: 0, topBidPersistent: false, topAskPersistent: false }, atSweepStart: null },
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
      log.info(`[USER_LIVE_EXECUTED] userId=${userId} symbol=${globalSignal.symbol} entry=${execResult.actualEntry}`);
    } else {
      baseDoc.status = "NOT_EXECUTED";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, userId, signalId: globalSignal.signalId }, "[USER_EXECUTION_FAILED] -- isolated, other users unaffected");
    baseDoc.status = "EXECUTION_FAILED";
  }

  await userSignalRepo.upsert(userId, baseDoc);
}
