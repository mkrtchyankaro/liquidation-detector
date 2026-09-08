import type { WallAggregateRepository } from "./wall-aggregate.repository";
import type { WallTrackerService } from "../../domain/liquidation/wall-tracker.service";
import type { WallPersistenceConfig } from "../config/wall-persistence.config";
import { childLogger } from "../logging/logger";

/**
 * Orchestrator for wall summary persistence (Step E2).
 *
 * Owns:
 *   - the periodic flush timer (every flushIntervalMs, default 60s)
 *
 * Does NOT own (intentionally):
 *   - any warmup logic — walls are live state, see config docstring
 *   - any retry queue — wall flush failures are silently lossy by design
 *   - any hydration of WallTrackerService — there is no DB → live data path
 *
 * Lifecycle:
 *   1. construct                        (cheap; no I/O)
 *   2. await ensureIndexes()            (~50 ms; non-blocking for safety)
 *   3. start()                          (kicks off the 60s timer)
 *   4. (running...)
 *   5. stop()                           (clears timer, performs final flush)
 *
 * Critical design property: this class is the ONLY component allowed to call
 * `WallTrackerService.snapshotForPersist()`, because that method has the
 * side effect of resetting per-minute counters. Calling it from anywhere
 * else (strategy, observability monitor, etc.) would corrupt the counters.
 *
 * Wall persistence is ANALYSIS-ONLY: nothing in this file or its
 * dependencies writes back into the live tracker state.
 */
export class WallAggregateOrchestrator {
  private readonly log = childLogger({ mod: "wall-persist" });
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: WallPersistenceConfig,
    private readonly repo: WallAggregateRepository,
    private readonly tracker: WallTrackerService,
    private readonly symbols: readonly string[],
  ) {}

  /** Ensure indexes (idempotent). Call once at boot, after Mongo is connected.
   *  Does NOT block boot — failure here just sets the repo to degraded mode
   *  and the flush timer becomes a no-op. */
  async ensureIndexes(): Promise<void> {
    if (!this.cfg.enabled) {
      this.log.info("wall persistence disabled (WALL_PERSIST_ENABLED=false)");
      return;
    }
    const ok = await this.repo.ensureIndexes();
    if (!ok) {
      this.log.warn(
        {
          fallback:
            "wall persistence disabled for this run; live wall tracking unaffected",
        },
        "wall index setup failed; flush timer will run but skip writes",
      );
    }
  }

  /** Kick off the periodic flush timer. No-op when disabled. */
  start(): void {
    if (!this.cfg.enabled) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.cfg.flushIntervalMs);
    this.log.info(
      {
        intervalSec: Math.round(this.cfg.flushIntervalMs / 1000),
        symbols: this.symbols.length,
      },
      "wall persistence flush timer started",
    );
  }

  /** Stop the flush timer and perform a final synchronous flush. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.cfg.enabled) return;
    try {
      await this.flush();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: msg }, "final wall flush on shutdown failed");
    }
  }

  /**
   * Snapshot every tracked symbol's wall state and upsert as one minute
   * aggregate per symbol. This is the ONLY caller of
   * WallTrackerService.snapshotForPersist() in the entire codebase.
   *
   * Failure handling (different from liquidation orchestrator on purpose):
   *   - upsertMinute() returning false is silently ignored. We do NOT queue
   *     retries because wall snapshots are point-in-time observations and a
   *     missed minute has zero downstream consequences (no warmup consumer,
   *     no percentile reconstruction).
   *   - This means lost minutes during Mongo outages are accepted as a
   *     tradeoff for simpler code and zero memory growth.
   */
  async flush(): Promise<void> {
    if (!this.cfg.enabled || this.repo.isDegraded) return;

    // Anchor the minute timestamp to the timer tick. We use the previous
    // minute boundary (floor to minute, then subtract 1 minute) so that a
    // tick at 12:34:55 writes the doc for minuteStart=12:33:00 — i.e. the
    // last fully-elapsed minute, not the in-progress one.
    const now = Date.now();
    const minuteStart = Math.floor(now / 60_000) * 60_000 - 60_000;

    const flushedSymbols: string[] = [];
    const failedSymbols: string[] = [];
    const t0 = Date.now();

    for (const symbol of this.symbols) {
      const snap = this.tracker.snapshotForPersist(symbol);
      if (!snap) continue; // never-ingested symbol; nothing to write

      const ok = await this.repo.upsertMinute({
        symbol: snap.symbol,
        minuteStart,
        topBidWallNotional: snap.topBidWall
          ? snap.topBidWall.peakNotional
          : null,
        topBidWallPrice: snap.topBidWall
          ? snap.topBidWall.representativePrice
          : null,
        topBidWallAgeMs: snap.topBidWall ? snap.topBidWall.ageMs : null,
        topAskWallNotional: snap.topAskWall
          ? snap.topAskWall.peakNotional
          : null,
        topAskWallPrice: snap.topAskWall
          ? snap.topAskWall.representativePrice
          : null,
        topAskWallAgeMs: snap.topAskWall ? snap.topAskWall.ageMs : null,
        candidateBidCount: snap.candidateBidCount,
        candidateAskCount: snap.candidateAskCount,
        persistentBidCount: snap.persistentBidCount,
        persistentAskCount: snap.persistentAskCount,
        pulled1mCount: snap.pulledMinute,
        newWallsCount: snap.newWallsMinute,
        midPrice: snap.midPrice,
      });

      if (ok) flushedSymbols.push(symbol);
      else failedSymbols.push(symbol);
    }

    const durationMs = Date.now() - t0;
    if (flushedSymbols.length > 0 || failedSymbols.length > 0) {
      if (failedSymbols.length > 0) {
        this.log.warn(
          {
            flushed: flushedSymbols,
            failed: failedSymbols,
            minuteStart,
            durationMs,
          },
          "wall flush partial: some upserts failed (no retry; minute is lost)",
        );
      } else {
        this.log.debug(
          { flushed: flushedSymbols, minuteStart, durationMs },
          "wall minute aggregates flushed",
        );
      }
    }
  }
}
