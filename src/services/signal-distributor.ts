import type { GlobalSignalDoc } from "../domain/signal/global-signal.model";
import type { UserRuntime } from "./user-runtime";
import { notifyUser } from "../application/signal/notify-user.usecase";
import { executeForUser } from "../application/execution/execute-for-user.usecase";
import { GlobalSignalRepository } from "../infrastructure/mongo/global-signal.repository";
import { UserSignalRepository } from "../infrastructure/mongo/user-signal.repository";
import type { MongoClientWrapper } from "../infrastructure/mongo/mongo.client";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "signal-distributor" });

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

  async distribute(globalSignal: GlobalSignalDoc, mongo: MongoClientWrapper): Promise<void> {
    await this.globalSignalRepo.insert(globalSignal);

    if (globalSignal.status !== "SIGNAL") return; // terminal-non-signal outcome -- nothing to fan out

    for (const runtime of this.userRuntimes) {
      if (!runtime.config.enabled) continue;
      const userSignalRepo = new UserSignalRepository(mongo, runtime.config.userId);

      try {
        await notifyUser(globalSignal, runtime);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, userId: runtime.config.userId, signalId: globalSignal.signalId }, "[DISTRIBUTE_TELEGRAM_FAILED] -- isolated");
      }

      try {
        await executeForUser(globalSignal, runtime, userSignalRepo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, userId: runtime.config.userId, signalId: globalSignal.signalId }, "[DISTRIBUTE_EXECUTION_FAILED] -- isolated, other users unaffected");
      }
    }
  }
}
