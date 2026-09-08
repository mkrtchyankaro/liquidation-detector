import type { UserRuntime } from "./user-runtime";
import type { GlobalSignalDoc } from "../domain/signal/global-signal.model";
import { UserSignalRepository } from "../infrastructure/mongo/user-signal.repository";
import type { MongoClientWrapper } from "../infrastructure/mongo/mongo.client";
import { reconcileUserPosition } from "../application/execution/reconcile-user-position.usecase";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "reconciliation-manager" });

/**
 * Sep 8 2026 (Karo). Per relevant WS price tick (mirroring
 * liqwatch-bot's own handleV5Tick -> reconcileV5LiveTrade wiring, see
 * MIGRATION_NOTES.md), loops over EVERY user's own open positions for
 * this symbol and reconciles each independently. A manual Binance
 * close for Karo only ever touches Karo's own collection/runtime --
 * this loop never reads or writes any other user's documents.
 */
export class ReconciliationManager {
  private readonly globalSignalCache = new Map<string, GlobalSignalDoc>();

  constructor(
    private readonly mongo: MongoClientWrapper,
    private readonly userRuntimes: UserRuntime[],
  ) {}

  /** Called once per relevant WS bookTicker tick for `symbol`. */
  async onTick(symbol: string, now: number): Promise<void> {
    for (const runtime of this.userRuntimes) {
      if (!runtime.config.enabled || !runtime.execution) continue;
      const userSignalRepo = new UserSignalRepository(this.mongo, runtime.config.userId);

      try {
        const open = await userSignalRepo.findOpen(runtime.config.userId);
        for (const userSignal of open) {
          if (userSignal.symbol !== symbol) continue;
          const globalSignal = await this.getGlobalSignal(userSignal.signalId);
          if (!globalSignal) continue;
          await reconcileUserPosition(userSignal, globalSignal, runtime, userSignalRepo, now);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, userId: runtime.config.userId, symbol }, "[RECONCILIATION_MANAGER_TICK_FAILED] -- isolated");
      }
    }
  }

  private async getGlobalSignal(signalId: string): Promise<GlobalSignalDoc | null> {
    const cached = this.globalSignalCache.get(signalId);
    if (cached) return cached;
    const col = await this.mongo.globalSignals();
    if (!col) return null;
    const doc = await col.findOne({ signalId });
    if (doc) this.globalSignalCache.set(signalId, doc);
    return doc;
  }
}
