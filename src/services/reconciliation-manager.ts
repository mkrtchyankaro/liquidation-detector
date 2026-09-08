import type { UserRuntime } from "./user-runtime";
import type { GlobalSignalDoc } from "../domain/signal/global-signal.model";
import type { UserSignalDoc } from "../domain/signal/user-signal.model";
import { UserSignalRepository } from "../infrastructure/mongo/user-signal.repository";
import type { MongoClientWrapper } from "../infrastructure/mongo/mongo.client";
import { reconcileUserPosition } from "../application/execution/reconcile-user-position.usecase";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "reconciliation-manager" });

/** How often the in-memory "who has an open position" cache is
 *  refreshed from Mongo. NOT per-tick -- see this class's own doc
 *  comment for the incident this fixes. 15s is a safe balance: real
 *  trades run for minutes to hours, so a newly-opened position
 *  starting its own Binance-reconciliation polling up to 15s late is
 *  harmless, while this keeps Mongo query volume trivially low
 *  (4/min total, not "every tick x every user"). */
const CACHE_REFRESH_MS = 15_000;

/**
 * Sep 8 2026 (Karo). Per relevant WS price tick (mirroring
 * liqwatch-bot's own handleV5Tick -> reconcileV5LiveTrade wiring, see
 * MIGRATION_NOTES.md), loops over EVERY user's own open positions for
 * this symbol and reconciles each independently. A manual Binance
 * close for Karo only ever touches Karo's own collection/runtime --
 * this loop never reads or writes any other user's documents.
 *
 * CRITICAL FIX (Sep 8 2026, confirmed production OOM crash): the
 * original version of this class called
 * `userSignalRepo.findOpen(userId)` -- a full Mongo query -- directly
 * inside onTick(), which fires on EVERY relevant bookTicker WS event
 * (tens of times per second, across every tracked symbol) for EVERY
 * enabled user. On a 1GB-RAM server this produced an unbounded queue
 * of concurrent Mongo operations faster than they could resolve,
 * confirmed via "JavaScript heap out of memory" crashes and repeated
 * "[USER_SIGNAL_FIND_OPEN_FAILED] Operation interrupted" log bursts
 * during shutdown (many identical calls queued within the same
 * millisecond for one user). liqwatch-bot's own original design never
 * had this problem because its equivalent check
 * (getLiveActiveTradesForSymbol()) was an in-memory Map lookup, never
 * a per-tick database query -- this class now replicates that: an
 * in-memory cache, refreshed on a slow timer (CACHE_REFRESH_MS), not
 * on every tick. onTick() itself now does zero Mongo I/O of its own.
 */
export class ReconciliationManager {
  private readonly globalSignalCache = new Map<string, GlobalSignalDoc>();
  /** userId -> that user's own currently-known-open signals. Refreshed
   *  periodically, NOT per-tick. */
  private readonly openCache = new Map<string, UserSignalDoc[]>();
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly mongo: MongoClientWrapper,
    private readonly userRuntimes: UserRuntime[],
  ) {}

  /** Call once at startup (after Mongo is connected). Does an
   *  immediate refresh, then starts the periodic timer. */
  async start(): Promise<void> {
    await this.refreshCache();
    this.refreshTimer = setInterval(() => {
      void this.refreshCache();
    }, CACHE_REFRESH_MS);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refreshCache(): Promise<void> {
    for (const runtime of this.userRuntimes) {
      if (!runtime.config.enabled || !runtime.execution) continue;
      try {
        const userSignalRepo = new UserSignalRepository(
          this.mongo,
          runtime.config.userId,
        );
        const open = await userSignalRepo.findOpen(runtime.config.userId);
        this.openCache.set(runtime.config.userId, open);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          { err: msg, userId: runtime.config.userId },
          "[RECONCILIATION_CACHE_REFRESH_FAILED] -- will retry next cycle, stale cache used meanwhile",
        );
      }
    }
  }

  /** Called once per relevant WS bookTicker tick for `symbol`. Reads
   *  ONLY the in-memory cache -- zero Mongo I/O in this method itself.
   *  The actual Binance reconciliation call (reconcileUserPosition)
   *  still runs per-tick for whatever IS cached as open -- that part
   *  is unchanged and correct (it's a real, necessary check against
   *  the authoritative exchange state, and is itself already
   *  backoff-protected by ReconciliationHealthTracker/InFlightGuard). */
  async onTick(symbol: string, now: number): Promise<void> {
    for (const runtime of this.userRuntimes) {
      if (!runtime.config.enabled || !runtime.execution) continue;
      const open = this.openCache.get(runtime.config.userId);
      if (!open || open.length === 0) continue;
      const userSignalRepo = new UserSignalRepository(
        this.mongo,
        runtime.config.userId,
      );

      for (const userSignal of open) {
        if (userSignal.symbol !== symbol) continue;
        try {
          const globalSignal = await this.getGlobalSignal(userSignal.signalId);
          if (!globalSignal) continue;
          await reconcileUserPosition(
            userSignal,
            globalSignal,
            runtime,
            userSignalRepo,
            now,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            { err: msg, userId: runtime.config.userId, symbol },
            "[RECONCILIATION_MANAGER_TICK_FAILED] -- isolated",
          );
        }
      }
    }
  }

  private async getGlobalSignal(
    signalId: string,
  ): Promise<GlobalSignalDoc | null> {
    const cached = this.globalSignalCache.get(signalId);
    if (cached) return cached;
    const col = await this.mongo.globalSignals();
    if (!col) return null;
    const doc = await col.findOne({ signalId });
    if (doc) this.globalSignalCache.set(signalId, doc);
    return doc;
  }
}
