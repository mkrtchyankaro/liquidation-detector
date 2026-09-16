import type { Side } from "../../shared/common.types";
import {
  reconstructCompleteEpisodes,
  percentile,
  episodeUsd,
  type CompleteEpisodesResult,
} from "./displacement-balanced-core";
import type {
  DirectionPercentiles,
  SymbolPercentileSnapshot,
} from "./episode-percentile.model";
import { childLogger } from "../../infrastructure/logging/logger";

const log = childLogger({ mod: "episode-percentile" });

const DEFAULT_WINDOW_MS = 3 * 86_400_000;
/** Practical safeguard against left-censored episodes -- see
 *  displacement-balanced-core.ts's reconstructCompleteEpisodes for
 *  the full rationale. Not a theoretical guarantee. */
const DEFAULT_PADDING_MS = 6 * 3_600_000;
/** Sep 16 2026 (Karo), operator-approved -- controlled concurrency,
 *  not all 10 symbols at once. Sized against the actual verified
 *  Binance weight cost: /fapi/v1/klines weight scales with the
 *  `limit` parameter (this codebase always requests limit=1500 ->
 *  weight 10/request); a full 3-day, 3-timeframe fetch for one symbol
 *  costs ~50 weight (3 paginated 1m requests + 1 each for 3m/5m). At
 *  concurrency=3, worst case ~150 weight in flight at once against a
 *  2400/minute IP-wide budget -- comfortable headroom alongside the
 *  live bot's own steady ~600 weight/minute OI-polling baseline. */
const DEFAULT_WARMUP_CONCURRENCY = 3;

function directionPercentiles(
  usdValues: readonly number[],
): DirectionPercentiles {
  const sorted = [...usdValues].sort((a, b) => a - b);
  return {
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    sampleCount: sorted.length,
  };
}

function fmt(v: number | null): string {
  return v !== null ? v.toFixed(0) : "n/a";
}

/**
 * Sep 16 2026 (Karo), operator-approved. Precomputed rolling 3-day
 * DISPLACEMENT_BALANCED episode-size percentile cache, per symbol,
 * LONG and SHORT tracked separately. P90/P95 are the sanctioned
 * production percentiles; P99 is diagnostic-only (never used for
 * signal qualification here or downstream).
 *
 * DELIBERATELY SEPARATE from the existing individual-event P95
 * (v5-liq-stats.ts's v5IndividualEventP95 / LiquidationStatsService.
 * notionalPercentile) -- that measures a single liquidation's own
 * size, live, in-memory, rolling, and is currently wired into
 * V5WaveService. This service is NOT wired into V5WaveService or any
 * other signal-qualification path yet -- that integration is an
 * explicit future step, not part of this change.
 *
 * LIFECYCLE:
 *   - warmupAll() is called ONCE at startup, fire-and-forget (NOT
 *     awaited by the caller) -- see main.ts's own comment at the call
 *     site for why. Live liquidation detection starts immediately;
 *     this cache becomes READY per-symbol as each warmup completes.
 *   - scheduleRefresh(symbol) is called after a signal CLOSE, for
 *     that symbol only, fire-and-forget. Deduplicated: a second call
 *     while a refresh is already running for that symbol reuses the
 *     in-flight promise rather than starting a second one.
 *   - No periodic timer exists yet. warmupAll()/scheduleRefresh()
 *     share the exact same refreshSymbol() path a future
 *     startPeriodicRefresh(intervalMs) could call on a timer for all
 *     symbols -- not implemented now, per operator instruction, but
 *     the extension point requires no restructuring.
 *
 * READ PATH: getThresholds()/getPercentileThreshold() are pure
 * synchronous Map lookups -- NEVER touch Mongo or Binance. NOT_READY
 * (no snapshot has ever completed for a symbol) returns null; callers
 * must treat null as "cannot percentile-qualify right now" and never
 * substitute a guessed threshold.
 *
 * FAILURE HANDLING: a failed refresh preserves the previous good
 * snapshot (if one exists) and marks it `stale: true` -- it is never
 * replaced with null/partial/broken data. If no previous snapshot
 * exists, the symbol simply stays NOT_READY.
 *
 * READ-ONLY with respect to historical data: only ever reads
 * liq_raw_events and fetches Binance historical klines. Never writes/
 * updates/deletes liq_raw_events or any production signal/execution
 * collection.
 */
export class EpisodePercentileService {
  private readonly snapshots = new Map<string, SymbolPercentileSnapshot>();
  private readonly refreshInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly symbols: readonly string[],
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
    private readonly paddingMs: number = DEFAULT_PADDING_MS,
    /** Sep 16 2026 (Karo), operator-requested testability -- injected
     *  so tests can substitute a fake reconstruction without touching
     *  real Mongo/Binance. Defaults to the real, shared-core
     *  implementation in production; NEVER overridden outside tests. */
    private readonly reconstructFn: (
      symbol: string,
      fromMs: number,
      toMs: number,
      paddingMs: number,
    ) => Promise<CompleteEpisodesResult> = reconstructCompleteEpisodes,
  ) {}

  /** Startup warmup for every configured symbol, with controlled
   *  concurrency. The CALLER decides whether to await this -- see
   *  this class's own header; production main.ts does NOT await it. */
  async warmupAll(
    concurrency: number = DEFAULT_WARMUP_CONCURRENCY,
  ): Promise<void> {
    const start = Date.now();
    let cursor = 0;
    const workerCount = Math.min(concurrency, this.symbols.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < this.symbols.length) {
        const symbol = this.symbols[cursor]!;
        cursor++;
        await this.refreshSymbol(symbol);
      }
    });
    await Promise.all(workers);
    this.logStartupTable(Date.now() - start);
  }

  /** Fire-and-forget entry point for the signal-CLOSE hook (and any
   *  future periodic-refresh timer). Caller must never await this in
   *  a path that shouldn't block -- it deliberately returns void, not
   *  a Promise, to make that impossible to get wrong at the call site. */
  scheduleRefresh(symbol: string): void {
    void this.refreshSymbol(symbol);
  }

  private async refreshSymbol(symbol: string): Promise<void> {
    const existing = this.refreshInFlight.get(symbol);
    if (existing) return existing;
    const promise = this.doRefresh(symbol).finally(() =>
      this.refreshInFlight.delete(symbol),
    );
    this.refreshInFlight.set(symbol, promise);
    return promise;
  }

  private async doRefresh(symbol: string): Promise<void> {
    const toMs = Date.now();
    const fromMs = toMs - this.windowMs;
    try {
      const result = await this.reconstructFn(
        symbol,
        fromMs,
        toMs,
        this.paddingMs,
      );
      const longUsd = result.episodes
        .filter((e) => e.direction === "LONG")
        .map(episodeUsd);
      const shortUsd = result.episodes
        .filter((e) => e.direction === "SHORT")
        .map(episodeUsd);
      const snapshot: SymbolPercentileSnapshot = {
        symbol,
        long: directionPercentiles(longUsd),
        short: directionPercentiles(shortUsd),
        computedAt: Date.now(),
        windowFromMs: fromMs,
        windowToMs: toMs,
        actualCoverageFromMs: result.coverage.earliestMs,
        actualCoverageToMs: result.coverage.latestMs,
        leftCensoredExcluded: result.leftCensoredExcluded,
        rightCensoredExcluded: result.rightCensoredExcluded,
        stale: false,
      };
      // Atomic per-symbol replace: the complete new snapshot is built
      // entirely above, then this single synchronous Map.set() is the
      // only mutation -- readers via getThresholds() always see either
      // the complete old snapshot or the complete new one, never a
      // partially-updated one (JS's single-threaded event loop makes a
      // single Map.set() call atomic with respect to other synchronous
      // reads/writes).
      this.snapshots.set(symbol, snapshot);
      log.info(`[PERCENTILES] ${symbol} refreshed`);
      log.info(
        `  LONG  n=${snapshot.long.sampleCount} P90=$${fmt(snapshot.long.p90)} P95=$${fmt(snapshot.long.p95)}`,
      );
      log.info(
        `  SHORT n=${snapshot.short.sampleCount} P90=$${fmt(snapshot.short.p90)} P95=$${fmt(snapshot.short.p95)}`,
      );
      if (
        result.coverage.earliestMs !== null &&
        result.coverage.earliestMs > fromMs
      ) {
        log.warn(
          `[PERCENTILES] ${symbol} -- requested ${(this.windowMs / 86_400_000).toFixed(0)}d window but earliest available data is ${new Date(result.coverage.earliestMs).toISOString()} (later than requested from ${new Date(fromMs).toISOString()})`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[PERCENTILES] ${symbol} refresh FAILED: ${msg}`);
      const prev = this.snapshots.get(symbol);
      if (prev) {
        this.snapshots.set(symbol, { ...prev, stale: true });
        log.warn(
          `[PERCENTILES] ${symbol} -- keeping previous snapshot (computedAt=${new Date(prev.computedAt).toISOString()}), marked stale`,
        );
      } else {
        log.warn(
          `[PERCENTILES] ${symbol} -- no previous snapshot exists, remains NOT_READY`,
        );
      }
    }
  }

  private logStartupTable(durationMs: number): void {
    log.info(
      `LIQUIDATION PERCENTILES READY -- rolling ${(this.windowMs / 86_400_000).toFixed(0)}d (calculated in ${durationMs}ms)`,
    );
    for (const symbol of this.symbols) {
      const snap = this.snapshots.get(symbol);
      if (!snap) {
        log.warn(
          `${symbol} -- NOT_READY (warmup failed and no previous snapshot exists)`,
        );
        continue;
      }
      log.info(
        `${symbol} LONG   n=${snap.long.sampleCount} P90=$${fmt(snap.long.p90)} P95=$${fmt(snap.long.p95)}`,
      );
      log.info(
        `${symbol} SHORT  n=${snap.short.sampleCount} P90=$${fmt(snap.short.p90)} P95=$${fmt(snap.short.p95)}`,
      );
    }
  }

  /** Signal-path entry point. Pure synchronous Map lookup -- NEVER
   *  performs Mongo/Binance/history reconstruction work. Returns null
   *  when NOT_READY (no snapshot has ever completed for this symbol);
   *  callers must never fabricate a threshold in that case. */
  getThresholds(symbol: string): SymbolPercentileSnapshot | null {
    return this.snapshots.get(symbol) ?? null;
  }

  /** Convenience single-value accessor. Returns null when NOT_READY,
   *  exactly like getThresholds(). */
  getPercentileThreshold(
    symbol: string,
    direction: Side,
    p: 90 | 95 | 99,
  ): number | null {
    const snap = this.getThresholds(symbol);
    if (!snap) return null;
    const d = direction === "LONG" ? snap.long : snap.short;
    return p === 90 ? d.p90 : p === 95 ? d.p95 : d.p99;
  }
}
