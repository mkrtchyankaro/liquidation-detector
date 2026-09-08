import type {
  LiqAggregateRepository,
  TopEvent,
} from "./liq-aggregate.repository";
import type { LiquidationStatsService } from "../../domain/liquidation/liquidation-stats.service";
import type { PersistenceConfig } from "../config/persistence.config";
import { childLogger } from "../logging/logger";

/**
 * Per-symbol pendingFlush queue cap, applied AFTER the service's exportPending
 * already buffered everything in RAM. If Mongo stays down longer than this, we
 * silently drop the OLDEST pending minute (with a warning log) to prevent
 * unbounded memory growth.
 *
 * 1440 = 24h worth of buckets per symbol — plenty for typical outages while
 * still bounded at ~50KB per symbol worst case.
 */
const PENDING_FLUSH_CAP = 1440;

/**
 * Orchestrator for liquidation persistence (Step E).
 *
 * Owns:
 *   - the boot-time warmup (read 24h of aggregates → hydrate the stats service)
 *   - the periodic flush timer (export sealed buckets → upsert to Mongo)
 *
 * Lifecycle:
 *   1. Construct          (cheap; no I/O)
 *   2. await warmup()     (boot-blocking; reads 24h of aggregates)
 *   3. start()            (kicks off the 60s flush timer)
 *   4. (running...)
 *   5. stop()             (clears timer, performs one final flush)
 *
 * The orchestrator is the ONLY component that calls into the repository or
 * touches the LiquidationStatsService persistence hooks. The service itself
 * stays observation-pure and the repository stays I/O-pure.
 *
 * FUTURE NOTE: when wall persistence is added, it should be a sibling
 * orchestrator (e.g. WallAggregateOrchestrator) with the same lifecycle
 * shape, NOT bolted onto this class. Keep responsibilities separated so
 * either feature can be disabled independently.
 */
export class LiqAggregateOrchestrator {
  private readonly log = childLogger({ mod: "liq-persist" });
  private timer: NodeJS.Timeout | null = null;
  /** Tracks per-symbol queue size so we can warn before dropping old buckets. */
  private droppedSinceLastFlush = new Map<string, number>();

  constructor(
    private readonly cfg: PersistenceConfig,
    private readonly repo: LiqAggregateRepository,
    private readonly stats: LiquidationStatsService,
    private readonly symbols: readonly string[],
  ) {}

  /**
   * Block-load the last `warmupMs` of aggregates per symbol and hydrate the
   * percentile state inside LiquidationStatsService. Safe to call when Mongo
   * is unreachable: logs a warning and returns without throwing, leaving the
   * service in cold-start mode.
   */
  async warmup(): Promise<void> {
    if (!this.cfg.enabled) {
      this.log.info("persistence disabled (LIQ_PERSIST_ENABLED=false)");
      return;
    }

    // Tell the stats service to start retaining top-N events for new minutes.
    this.stats.setTopEventsPerMinute(this.cfg.topEventsPerMinute);

    const indexesOk = await this.repo.ensureIndexes();
    if (!indexesOk) {
      this.log.warn(
        {
          fallback:
            "tier-default thresholds in effect until live data accumulates",
        },
        "warmup skipped (indexes unavailable); continuing cold",
      );
      return;
    }

    this.log.info(
      {
        symbols: this.symbols.length,
        warmupHours: Math.round(this.cfg.warmupMs / 3_600_000),
      },
      "persistence enabled, warming up",
    );

    const now = Date.now();
    const since = now - this.cfg.warmupMs;
    const summary: Record<
      string,
      { docs: number; samples: number; warm: boolean }
    > = {};

    for (const symbol of this.symbols) {
      const docs = await this.repo.readRange(symbol, since, now);
      if (docs.length === 0) {
        summary[symbol] = { docs: 0, samples: 0, warm: false };
        continue;
      }
      const result = this.stats.hydrateFromAggregates(symbol, docs);
      summary[symbol] = {
        docs: docs.length,
        samples: result.samples,
        warm: this.stats.isWarm(symbol),
      };
    }

    this.log.info({ summary }, "warmup complete");
  }

  /** Kick off the 60s flush timer. No-op when persistence is disabled. */
  start(): void {
    if (!this.cfg.enabled) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.cfg.flushIntervalMs);
    this.log.info(
      { intervalSec: Math.round(this.cfg.flushIntervalMs / 1000) },
      "flush timer started",
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
      this.log.warn({ err: msg }, "final flush on shutdown failed");
    }
  }

  /**
   * Flush all sealed-but-not-yet-persisted minute buckets to Mongo. Called by
   * the timer (every flushIntervalMs) and once at shutdown. Each successful
   * upsert is followed by markFlushed() on the stats service so the bucket is
   * dropped from the in-memory pending queue.
   *
   * Failure handling:
   *   - upsertMinute() returning false leaves the bucket in pendingFlush so a
   *     future tick retries it.
   *   - PENDING_FLUSH_CAP per symbol prevents unbounded growth: when exceeded,
   *     oldest pending minutes are silently dropped (with a warn log) and the
   *     dropped count is reported on the next successful flush.
   */
  async flush(): Promise<void> {
    if (!this.cfg.enabled || this.repo.isDegraded) return;

    const pending = this.stats.exportPendingFlushes();
    if (pending.length === 0) return;

    // Apply per-symbol cap BEFORE attempting upserts. This is a safety valve;
    // if Mongo has been down long enough that we accumulated >1440 minutes per
    // symbol, the oldest buckets are sacrificed.
    const bySymbol = new Map<string, typeof pending>();
    for (const p of pending) {
      const arr = bySymbol.get(p.symbol) ?? [];
      arr.push(p);
      bySymbol.set(p.symbol, arr);
    }
    for (const [symbol, arr] of bySymbol) {
      if (arr.length <= PENDING_FLUSH_CAP) continue;
      arr.sort((a, b) => a.minuteStart - b.minuteStart);
      const drop = arr.length - PENDING_FLUSH_CAP;
      for (let i = 0; i < drop; i += 1) {
        const b = arr[i]!;
        this.stats.markFlushed(symbol, b.minuteStart);
      }
      const prev = this.droppedSinceLastFlush.get(symbol) ?? 0;
      this.droppedSinceLastFlush.set(symbol, prev + drop);
      this.log.warn(
        { symbol, dropped: drop, cap: PENDING_FLUSH_CAP },
        "pendingFlush cap exceeded; dropped oldest minutes",
      );
    }

    // Re-export after capping
    const toFlush = this.stats.exportPendingFlushes();
    const flushedCounts: Record<string, number> = {};
    const failedCounts: Record<string, number> = {};
    const t0 = Date.now();

    for (const p of toFlush) {
      const ok = await this.repo.upsertMinute({
        symbol: p.symbol,
        minuteStart: p.minuteStart,
        longSum: p.longSum,
        shortSum: p.shortSum,
        longCount: p.longCount,
        shortCount: p.shortCount,
        longMax: p.longMax,
        shortMax: p.shortMax,
        topLong: p.topLong as TopEvent[],
        topShort: p.topShort as TopEvent[],
      });
      if (ok) {
        this.stats.markFlushed(p.symbol, p.minuteStart);
        flushedCounts[p.symbol] = (flushedCounts[p.symbol] ?? 0) + 1;
      } else {
        failedCounts[p.symbol] = (failedCounts[p.symbol] ?? 0) + 1;
      }
    }

    const flushedTotal = Object.values(flushedCounts).reduce(
      (a, b) => a + b,
      0,
    );
    const failedTotal = Object.values(failedCounts).reduce((a, b) => a + b, 0);
    const durationMs = Date.now() - t0;

    if (flushedTotal > 0 || failedTotal > 0) {
      const dropped = Object.fromEntries(this.droppedSinceLastFlush);
      this.droppedSinceLastFlush.clear();
      if (failedTotal > 0) {
        this.log.warn(
          { flushed: flushedCounts, failed: failedCounts, dropped, durationMs },
          "flush partial: some upserts failed; will retry next cycle",
        );
      } else {
        this.log.info(
          { flushed: flushedCounts, durationMs },
          "flushed minute aggregates",
        );
      }
    }
  }
}
