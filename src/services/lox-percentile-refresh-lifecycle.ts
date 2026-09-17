import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "lox-percentile-refresh" });

/**
 * Sep 17 2026 (Karo), operator-requested production-completion pass,
 * Section C. Fixes the source-audit finding that LOX's WATCH
 * qualification depended on a percentile snapshot that only ever
 * refreshed when a V3/V5 legacy position happened to close on the
 * same symbol -- operationally unrelated to this strategy.
 *
 * Does NOT touch EpisodePercentileService itself, its warmupAll(),
 * its scheduleRefresh(), or the underlying DISPLACEMENT_BALANCED
 * reconstruction/percentile math in any way -- reuses
 * scheduleRefresh() exactly as V3/V5 already does, on a LOW-FREQUENCY
 * timer LOX owns independently. Readiness/sampleCount/computedAt
 * remain exactly as visible as before -- getThresholds() is
 * untouched.
 */

export interface RefreshableEpisodePercentileService {
  scheduleRefresh(symbol: string): void;
}

export class LoxPercentileRefreshLifecycle {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly service: RefreshableEpisodePercentileService,
    private readonly symbols: readonly string[],
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.refreshAll(), this.intervalMs);
    log.info(
      `[LOX_PERCENTILE_REFRESH_LIFECYCLE] started, intervalMs=${this.intervalMs}, symbols=${this.symbols.length}`,
    );
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private refreshAll(): void {
    for (const symbol of this.symbols) {
      try {
        this.service.scheduleRefresh(symbol);
      } catch (err) {
        log.error(
          { symbol, err: err instanceof Error ? err.message : String(err) },
          "[LOX_PERCENTILE_REFRESH_SCHEDULE_FAILED] -- last valid snapshot preserved",
        );
      }
    }
    log.info(
      `[LOX_PERCENTILE_REFRESH_TICK] scheduled refresh for ${this.symbols.length} symbol(s)`,
    );
  }
}
