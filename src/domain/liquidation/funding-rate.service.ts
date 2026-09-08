/**
 * FundingRateService — Binance perpetual funding rate tracker.
 *
 * Fetches the current funding rate per symbol from Binance's public
 * `/fapi/v1/premiumIndex` endpoint (no auth required) and caches it
 * in memory for fast lookup. Refreshed every 5 minutes — the actual
 * rate changes continuously as positions shift, but funding only
 * settles every 8h, so 5-minute polling is more than enough.
 *
 * Display-only (May 2026): wired into V3 Telegram ENTRY messages as
 * a "Funding: ±X.XXXX% — bias label" line so the user can manually
 * judge whether the rate's directional bias matches the trade. NO
 * V3 strategy decisions branch on this value — same observe-first
 * stance taken with FundingStatsService (L/S ratio).
 *
 * Funding-rate semantics (perpetual futures):
 *   rate > 0  → longs pay shorts (longs are paying premium → stressed)
 *               → squeeze pressure DOWN (good for SHORT trades)
 *   rate < 0  → shorts pay longs (shorts paying premium → stressed)
 *               → squeeze pressure UP (good for LONG trades)
 *   rate ≈ 0  → no significant directional pressure
 */

import { childLogger } from '../../infrastructure/logging/logger';

const log = childLogger({ mod: "funding-rate" });

const REFRESH_MS = 5 * 60 * 1000; // 5 min
const STALE_MS = 30 * 60 * 1000; // values older than this are ignored

interface FundingRateEntry {
  rate: number;
  fetchedAt: number;
}

export class FundingRateService {
  private readonly cache = new Map<string, FundingRateEntry>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly symbols: ReadonlyArray<string>) {
    // Kick off an immediate fetch so the cache is warm before the
    // first V3 entry. setInterval handles ongoing refreshes.
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    log.info(
      `[funding-rate] FundingRateService started for ${symbols.length} symbols`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns the cached funding rate as a decimal fraction (e.g.
   *  0.00012 = 0.012% per 8h settlement). Returns null if the symbol
   *  has never been successfully fetched, or the cached value is
   *  older than STALE_MS (Binance API down for >30 min). Callers
   *  should treat null as "unavailable, suppress display". */
  getFundingRate(symbol: string): number | null {
    const entry = this.cache.get(symbol);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > STALE_MS) return null;
    return entry.rate;
  }

  /** Refresh all tracked symbols sequentially. Sequential rather than
   *  parallel so we never hit Binance's per-IP rate limit during a
   *  spike. Per-symbol failures are silent — the previous cached
   *  value is kept until STALE_MS elapses. */
  private async refresh(): Promise<void> {
    for (const symbol of this.symbols) {
      try {
        const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;
        const res = await fetch(url);
        if (!res.ok) {
          log.warn(`[funding-rate] ${symbol} HTTP ${res.status}`);
          continue;
        }
        const data = (await res.json()) as { lastFundingRate?: string };
        if (!data.lastFundingRate) continue;
        const rate = parseFloat(data.lastFundingRate);
        if (!Number.isFinite(rate)) continue;
        this.cache.set(symbol, { rate, fetchedAt: Date.now() });
        log.info(`[funding-rate] ${symbol} rate=${(rate * 100).toFixed(4)}%`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[funding-rate] ${symbol} fetch failed: ${msg}`);
      }
    }
  }
}
