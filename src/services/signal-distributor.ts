import type { GlobalSignalDoc } from "../domain/signal/global-signal.model";
import type {
  UserSignalDoc,
  UserSignalStatus,
} from "../domain/signal/user-signal.model";
import type { UserConfig } from "../domain/user/user-config.model";
import type { UserRuntime } from "./user-runtime";
import { notifyUser } from "../application/signal/notify-user.usecase";
import { executeForUser } from "../application/execution/execute-for-user.usecase";
import { GlobalSignalRepository } from "../infrastructure/mongo/global-signal.repository";
import { UserSignalRepository } from "../infrastructure/mongo/user-signal.repository";
import type { MongoClientWrapper } from "../infrastructure/mongo/mongo.client";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "signal-distributor" });

/**
 * Sep 8 2026 (Karo). Ported from liqwatch-bot's own V5_BTC_BLOCK
 * (per-instance env flag there -> per-user config field here, same
 * underlying rule, see UserConfig.btcBlockEnabled's own doc comment
 * for the full spec). Pure function, no side effects.
 */
export function isBtcBlockedForUser(
  globalSignal: GlobalSignalDoc,
  userConfig: UserConfig,
): boolean {
  if (!userConfig.btcBlockEnabled) return false;
  if (globalSignal.symbol === "BTCUSDT") return true;
  return (
    globalSignal.btcIntendedSideAtSignalTime !== null &&
    globalSignal.btcIntendedSideAtSignalTime === globalSignal.side
  );
}

/**
 * Sep 8 2026 (Karo). Ported from liqwatch-bot's own V5_LONG_ENABLED/
 * V5_SHORT_ENABLED (per-instance env flags there -> per-user config
 * fields here -- see UserConfig.longEnabled/shortEnabled's own doc
 * comment for why this is deliberately NOT inside V5WaveService
 * itself). Pure function, no side effects.
 */
export function isDirectionDisabledForUser(
  globalSignal: GlobalSignalDoc,
  userConfig: UserConfig,
): boolean {
  if (globalSignal.side === "LONG") return !userConfig.longEnabled;
  return !userConfig.shortEnabled;
}

/**
 * Sep 8 2026 (Karo). ONE canonical signalId fans out to every enabled
 * user here. Every per-user step is wrapped in its OWN try/catch --
 * one user's Telegram/Binance/Mongo failure can NEVER prevent another
 * user's own delivery, and can never throw back up into the global
 * strategy engine's own tick-processing loop.
 */
export class SignalDistributor {
  private readonly globalSignalRepo: GlobalSignalRepository;

  constructor(
    mongo: MongoClientWrapper,
    private readonly userRuntimes: UserRuntime[],
  ) {
    this.globalSignalRepo = new GlobalSignalRepository(mongo);
  }

  async distribute(
    globalSignal: GlobalSignalDoc,
    mongo: MongoClientWrapper,
  ): Promise<void> {
    await this.globalSignalRepo.insert(globalSignal);

    if (globalSignal.status !== "SIGNAL") return;

    for (const runtime of this.userRuntimes) {
      if (!runtime.config.enabled) continue;
      const userSignalRepo = new UserSignalRepository(
        mongo,
        runtime.config.userId,
      );

      // Sep 8 2026 (Karo) -- both checks are per-user, independent of
      // each other and of every other user (including "main", whose
      // own longEnabled/shortEnabled/btcBlockEnabled default to
      // true/true/false -- always sees every signal, per explicit
      // operator instruction: "main-ի filter-ը take-profit/stop-loss-n
      // ա"). Either check alone is sufficient to block this user.
      if (isDirectionDisabledForUser(globalSignal, runtime.config)) {
        await this.persistBlocked(
          globalSignal,
          runtime,
          userSignalRepo,
          "DIRECTION_DISABLED",
          `[DIRECTION_DISABLED] userId=${runtime.config.userId} side=${globalSignal.side} signalId=${globalSignal.signalId} — this user has ${globalSignal.side.toLowerCase()}Enabled=false`,
        );
        continue;
      }

      if (isBtcBlockedForUser(globalSignal, runtime.config)) {
        await this.persistBlocked(
          globalSignal,
          runtime,
          userSignalRepo,
          "BTC_BLOCKED",
          `[BTC_BLOCK_SAME_SIDE] userId=${runtime.config.userId} symbol=${globalSignal.symbol} side=${globalSignal.side} signalId=${globalSignal.signalId}`,
        );
        continue;
      }

      try {
        await notifyUser(globalSignal, runtime);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          {
            err: msg,
            userId: runtime.config.userId,
            signalId: globalSignal.signalId,
          },
          "[DISTRIBUTE_TELEGRAM_FAILED] -- isolated",
        );
      }

      try {
        await executeForUser(globalSignal, runtime, userSignalRepo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          {
            err: msg,
            userId: runtime.config.userId,
            signalId: globalSignal.signalId,
          },
          "[DISTRIBUTE_EXECUTION_FAILED] -- isolated, other users unaffected",
        );
      }
    }
  }

  /** Shared by both block-reasons above -- persists a forensic,
   *  never-silently-discarded doc (visible via
   *  `show-signal.ts <signalId> --user <userId>`) and logs, WITHOUT
   *  ever calling notifyUser/executeForUser for this user. */
  private async persistBlocked(
    globalSignal: GlobalSignalDoc,
    runtime: UserRuntime,
    userSignalRepo: UserSignalRepository,
    status: UserSignalStatus,
    logLine: string,
  ): Promise<void> {
    log.info(
      `${logLine} — neither Telegram nor execution attempted for this user`,
    );
    const now = Date.now();
    const blockedDoc: UserSignalDoc = {
      signalId: globalSignal.signalId,
      symbol: globalSignal.symbol,
      side: globalSignal.side,
      telegramSent: false,
      telegramSentAt: null,
      executionEnabled: runtime.config.binance?.enabled ?? false,
      status,
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
    try {
      await userSignalRepo.upsert(runtime.config.userId, blockedDoc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId: runtime.config.userId, status },
        "[BLOCKED_DOC_PERSIST_FAILED] -- isolated",
      );
    }
  }
}
