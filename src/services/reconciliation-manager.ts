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

/** Sep 14 2026 (Karo), operator-requested fix. How often the
 *  deterministic fallback reconciliation loop runs, independent of
 *  any symbol's own bookTicker tick frequency -- see
 *  runFallbackReconciliation()'s own doc comment for the full
 *  incident/rationale this closes. 3s targets "detection within a
 *  few seconds" as requested, without polling faster than necessary:
 *  each run only touches whatever is ALREADY cached as open (zero
 *  Mongo I/O of its own, same as onTick()), and every actual Binance
 *  call it makes is still governed by the existing InFlightGuard/
 *  ReconciliationHealthTracker backoff -- so a shorter interval here
 *  would not increase real Binance call volume during a healthy
 *  reconcile, only during an active failure episode, which the 5s
 *  backoff already caps independently of this interval. */
const FALLBACK_RECONCILE_MS = 3_000;

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
  /** Sep 14 2026 (Karo), operator-requested fix. symbol -> last known
   *  real market mid-price, updated on EVERY bookTicker tick this
   *  manager sees (regardless of whether any user currently has an
   *  open position on that symbol, so the value is ready the instant
   *  it's needed). This is what restores the old, proven
   *  `bestPrice`/`lastMid` fallback behavior for the genuinely-
   *  ambiguous "UNKNOWN" reconciliation case -- see
   *  reconcile-user-position.usecase.ts's own doc comment on its
   *  `lastKnownPrice` parameter for the full history. */
  private readonly lastKnownPrice = new Map<string, number>();
  private refreshTimer: NodeJS.Timeout | null = null;
  /** Sep 14 2026 (Karo), operator-requested fix -- see this class's
   *  own updated doc comment and startFallbackReconciliationLoop()'s
   *  own doc comment for the full incident/rationale. */
  private fallbackTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly mongo: MongoClientWrapper,
    private readonly userRuntimes: UserRuntime[],
  ) {}

  /** Call once at startup (after Mongo is connected). Does an
   *  immediate refresh, then starts the periodic timer, then starts
   *  the fallback reconciliation loop. */
  async start(): Promise<void> {
    await this.refreshCache();
    this.refreshTimer = setInterval(() => {
      void this.refreshCache();
    }, CACHE_REFRESH_MS);
    this.fallbackTimer = setInterval(() => {
      void this.runFallbackReconciliation();
    }, FALLBACK_RECONCILE_MS);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
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

  /** Called once per relevant WS bookTicker tick for `symbol`. Records
   *  `mid` into lastKnownPrice UNCONDITIONALLY (even if no user has an
   *  open position on this symbol right now), then reads ONLY the
   *  in-memory openCache -- zero Mongo I/O in this method itself. The
   *  actual Binance reconciliation call (reconcileUserPosition) still
   *  runs per-tick for whatever IS cached as open on THIS symbol --
   *  that part is unchanged and correct. This tick-driven path is now
   *  a fast path, not the ONLY path: see runFallbackReconciliation()
   *  for the deterministic, symbol-tick-independent safety net added
   *  Sep 14 2026.
   *
   *  CRITICAL FIX (Sep 8 2026, confirmed real production incident --
   *  a single position sent 11+ duplicate "V5 CLOSE ... TP" Telegram
   *  messages within one minute): once a position closed,
   *  reconcileUserPosition() correctly reported it via Mongo/Telegram
   *  -- but this class's OWN in-memory openCache still listed that
   *  signalId as "open" for up to CACHE_REFRESH_MS (15s) longer, since
   *  the cache only refreshes on its own slow timer, not per-tick.
   *  EVERY bookTicker tick in that window (which can fire many times
   *  per second) re-discovered the same, already-closed userSignal
   *  from the stale cache and re-ran the ENTIRE reconcile-and-notify
   *  flow again -- InFlightGuard only prevents truly CONCURRENT
   *  re-entry, not this sequential re-triggering once each prior call
   *  had already finished. reconcileUserPosition() now returns `true`
   *  exactly when it just closed a position; on `true`, this method
   *  immediately prunes that signalId from its OWN cache entry, so no
   *  further tick within the same window can re-discover it. */
  async onTick(symbol: string, mid: number, now: number): Promise<void> {
    this.lastKnownPrice.set(symbol, mid);
    for (const runtime of this.userRuntimes) {
      if (!runtime.config.enabled || !runtime.execution) continue;
      const open = this.openCache.get(runtime.config.userId);
      if (!open || open.length === 0) continue;
      for (const userSignal of open) {
        if (userSignal.symbol !== symbol) continue;
        await this.reconcileOneSignal(runtime, userSignal, now, "tick");
      }
    }
  }

  /** Sep 14 2026 (Karo), operator-requested fix. Deterministic
   *  fallback reconciliation, independent of any specific symbol's
   *  own bookTicker tick frequency. Root cause this closes: onTick()
   *  only reconciles a signal when ITS OWN symbol happens to tick --
   *  for a symbol with sparse bookTicker updates, or during any
   *  extended span where that symbol's own ticks are delayed, a
   *  closed position could sit undetected far longer than the fast
   *  path implies. This loop iterates every cached-open signal for
   *  every enabled user directly, on a fixed short interval,
   *  regardless of tick arrival -- reusing the EXACT SAME
   *  reconcileOneSignal() logic (and therefore the exact same
   *  InFlightGuard/backoff/idempotency protections) as the tick path,
   *  so it can never double-process anything the tick path is already
   *  handling concurrently; it can only pick up what the tick path
   *  hasn't reached yet. FALLBACK_RECONCILE_MS bounds the worst-case
   *  additional detection delay to a few seconds, independent of any
   *  symbol's own tick cadence. */
  private async runFallbackReconciliation(): Promise<void> {
    const now = Date.now();
    for (const runtime of this.userRuntimes) {
      if (!runtime.config.enabled || !runtime.execution) continue;
      const open = this.openCache.get(runtime.config.userId);
      if (!open || open.length === 0) continue;
      for (const userSignal of open) {
        await this.reconcileOneSignal(
          runtime,
          userSignal,
          now,
          "fallback-loop",
        );
      }
    }
  }

  /** Shared per-signal reconciliation body, used by BOTH onTick()
   *  (tick-driven fast path) and runFallbackReconciliation() (the
   *  deterministic, tick-independent safety net) -- kept as one
   *  function so both paths get identical InFlightGuard/backoff/
   *  price-fallback/timing-log behavior, never two slightly-
   *  different implementations to keep in sync. `source` is logged
   *  only, for observability into which path detected each close. */
  private async reconcileOneSignal(
    runtime: UserRuntime,
    userSignal: UserSignalDoc,
    now: number,
    source: "tick" | "fallback-loop",
  ): Promise<void> {
    if (!runtime.execution) return;
    const userSignalRepo = new UserSignalRepository(
      this.mongo,
      runtime.config.userId,
    );
    try {
      const globalSignal = await this.getGlobalSignal(userSignal.signalId);
      if (!globalSignal) {
        log.debug(
          {
            userId: runtime.config.userId,
            signalId: userSignal.signalId,
            symbol: userSignal.symbol,
            source,
            skipReason: "global-signal-not-found",
          },
          "[RECONCILIATION_MANAGER_TICK_SKIPPED]",
        );
        return;
      }
      // Sep 9 2026 (Karo), operator-requested -- reproduces the OLD,
      // proven liqwatch-bot pattern exactly (V5WaveService.closeTrade()'s
      // own synchronous activeTrades.delete(), confirmed via direct
      // old-code trace to run BEFORE any DB write or Telegram send).
      // This callback fires SYNCHRONOUSLY, inside reconcileUserPosition(),
      // the MOMENT Binance confirms the position closed -- closing the
      // gap that let a LATER (not concurrent -- InFlightGuard already
      // covers concurrent) invocation still find this signal "open" and
      // run the entire reconcile-confirm-notify chain again. Shared
      // between both callers via this one method, so it prunes the
      // SAME openCache regardless of which path (tick or fallback)
      // triggered the close.
      const pruneFromCache = (signalId: string): void => {
        const stillCached = this.openCache.get(runtime.config.userId);
        if (stillCached) {
          this.openCache.set(
            runtime.config.userId,
            stillCached.filter((s) => s.signalId !== signalId),
          );
        }
      };
      // Sep 12 2026 (Karo), operator-reported CRITICAL FIX -- the
      // cross-user CLOSE broadcast that used to run here (looping
      // over every OTHER user's own runtime and sending THIS
      // user's own real-execution CLOSE through their telegram
      // client too) is REMOVED. Execution CLOSE notifications must
      // be strictly per-user: reconcileUserPosition() above already
      // sends notifyUserClose(message, runtime) to the ACTUAL
      // position owner's own telegram client -- that is the only
      // send that belongs here. ENTRY's own unconditional fan-out
      // (SignalDistributor.distribute()) is untouched and
      // unrelated to this fix.
      const lastKnownPrice = this.lastKnownPrice.get(userSignal.symbol);
      const { closed } = await reconcileUserPosition(
        userSignal,
        globalSignal,
        runtime,
        userSignalRepo,
        now,
        pruneFromCache,
        lastKnownPrice,
      );
      if (closed) {
        // Sep 9 2026 (Karo) -- defensive safety-net only; the real
        // removal already happened synchronously above, via
        // pruneFromCache(), before any DB/Telegram I/O. Filtering an
        // already-pruned array is a harmless no-op.
        pruneFromCache(userSignal.signalId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err: msg,
          userId: runtime.config.userId,
          symbol: userSignal.symbol,
          signalId: userSignal.signalId,
          source,
        },
        "[RECONCILIATION_MANAGER_TICK_FAILED] -- isolated",
      );
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
