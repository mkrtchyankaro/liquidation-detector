/**
 * OiTrackerService — Binance perpetual Open Interest tracker.
 *
 * Fetches current OI per symbol from Binance's public
 * `/fapi/v1/openInterest` endpoint (no auth required) and caches it in
 * memory for fast lookup. Refreshed every 60 seconds.
 *
 * Research-only (Sep 2026): wired into V3 paperSignals.research.oiAt*
 * snapshots so offline analysis can investigate whether OI change
 * during the watch→entry window predicts reversal success. NO V3
 * strategy decisions branch on this value — same observe-first stance
 * taken with FundingStatsService (L/S ratio) and FundingRateService.
 *
 * Open Interest semantics:
 *   - Returned in CONTRACTS (base-asset units). For BTCUSDT, OI=82k
 *     means 82,000 BTC of total open positions across all traders.
 *   - To get USD notional, multiply by mark price (callers supply
 *     this at capture time using the mid/entry price they already
 *     have on hand — no separate REST call needed).
 *
 *   - During a long-victim cascade: OI dropping = real positions
 *     closing (capitulation, reversal candidate); OI flat = positions
 *     just rotated to new longs (continuation risk).
 *   - During a short-victim cascade: same logic, OI should drop as
 *     shorts close.
 */

import { childLogger } from '../../infrastructure/logging/logger';

const log = childLogger({ mod: "oi-tracker" });

const REFRESH_MS = 60 * 1000; // 60s — OI changes continuously, this is fine
const STALE_MS = 5 * 60 * 1000; // values older than this are returned as null
const FETCH_TIMEOUT_MS = 5_000;

interface OiCacheEntry {
  /** OI value in contracts (base-asset units), as returned by Binance. */
  contracts: number;
  /** Local wall-clock when this entry was cached (ms epoch). Used for
   *  staleness check; NOT the `time` field Binance returned (which
   *  represents Binance's exchange time, can drift slightly). */
  fetchedAt: number;
}

/** Aug 21 2026, operator-requested (Karo) — MARKET BASELINE shadow
 *  telemetry. Bounded ring of recent OI samples, one per refresh()
 *  cycle (60s cadence — same REST call already made below, just also
 *  retained instead of discarded). At MAX_HISTORY entries (240 = 4h
 *  at 60s/sample), memory cost is ~240 * 16 bytes * symbol count —
 *  trivially small. RAM-only, like the rest of this service; lost on
 *  restart, refills naturally within MAX_HISTORY*60s. */
const MAX_OI_HISTORY = 240;

export class OiTrackerService {
  private readonly cache = new Map<string, OiCacheEntry>();
  /** Aug 21 2026, operator-requested (Karo) — MARKET BASELINE shadow
   *  telemetry. Bounded ring of recent OI samples per symbol — see
   *  MAX_OI_HISTORY's doc comment. */
  private readonly history = new Map<string, OiCacheEntry[]>();
  private timer: NodeJS.Timeout | null = null;
  /** Per-symbol guard against piled-up requests when Binance is slow.
   *  If a previous fetch is still pending when the timer fires, the
   *  next cycle skips that symbol rather than queueing parallel calls. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly symbols: ReadonlyArray<string>) {
    // Kick off an immediate fetch so the cache is warm before the
    // first V3 watch state is created. setInterval handles ongoing
    // refreshes.
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    log.info(
      `[oi-tracker] OiTrackerService started for ${symbols.length} symbols (refresh ${REFRESH_MS}ms)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns the cached OI snapshot for the symbol, or null if no
   *  successful fetch has been made yet OR if the most recent fetch
   *  is older than STALE_MS (Binance API down for >5 min). Callers
   *  should treat null as "unavailable, suppress display / persist
   *  null". V3 strategy logic does NOT branch on this value — research
   *  capture only. */
  getCachedOI(symbol: string): { contracts: number; ts: number } | null {
    const entry = this.cache.get(symbol);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > STALE_MS) return null;
    return { contracts: entry.contracts, ts: entry.fetchedAt };
  }

  /** Aug 21 2026, operator-requested (Karo) — MARKET BASELINE shadow
   *  telemetry. Rolling MEDIAN of ABSOLUTE minute-to-minute OI change
   *  (contracts), over the retained history (up to MAX_OI_HISTORY
   *  samples = up to 4h at 60s cadence). Answers "how much does this
   *  symbol's OI TYPICALLY move, minute to minute" — the baseline a
   *  caller compares a specific watch/entry-window OI change against.
   *  Returns null if fewer than 5 samples exist yet (cold start). */
  getRollingMedianOiChange(symbol: string): number | null {
    const hist = this.history.get(symbol);
    if (!hist || hist.length < 5) return null;
    const deltas: number[] = [];
    for (let i = 1; i < hist.length; i += 1) {
      deltas.push(Math.abs(hist[i]!.contracts - hist[i - 1]!.contracts));
    }
    deltas.sort((a, b) => a - b);
    const mid = Math.floor(deltas.length / 2);
    return deltas.length % 2 === 1
      ? deltas[mid]!
      : (deltas[mid - 1]! + deltas[mid]!) / 2;
  }

  /** Raw OI-sample history for `symbol`, oldest-first, for callers
   *  that need more than the single rolling-median summary (e.g.
   *  percentile-rank of a specific delta against the full recent
   *  distribution). Returns an empty array if never sampled. */
  getOiHistory(symbol: string): ReadonlyArray<OiCacheEntry> {
    return this.history.get(symbol) ?? [];
  }

  /** Refresh all tracked symbols sequentially. Sequential rather than
   *  parallel so we never hit Binance's per-IP rate limit during a
   *  burst. Per-symbol failures are silent — the previous cached value
   *  is kept until STALE_MS elapses. */
  private async refresh(): Promise<void> {
    for (const symbol of this.symbols) {
      if (this.inFlight.has(symbol)) {
        // Previous cycle still pending — skip rather than queue.
        continue;
      }
      this.inFlight.add(symbol);
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          FETCH_TIMEOUT_MS,
        );
        const url = `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) {
          log.warn(`[oi-tracker] ${symbol} HTTP ${res.status}`);
          continue;
        }
        const data = (await res.json()) as { openInterest?: string };
        if (!data.openInterest) continue;
        const contracts = parseFloat(data.openInterest);
        if (!Number.isFinite(contracts) || contracts <= 0) continue;
        const entry: OiCacheEntry = { contracts, fetchedAt: Date.now() };
        this.cache.set(symbol, entry);
        // MARKET BASELINE shadow telemetry (Aug 21 2026, Karo) — same
        // REST response, just also retained in a bounded ring instead
        // of only overwriting the single latest-value cache above.
        let hist = this.history.get(symbol);
        if (!hist) {
          hist = [];
          this.history.set(symbol, hist);
        }
        hist.push(entry);
        if (hist.length > MAX_OI_HISTORY) {
          hist.shift();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[oi-tracker] ${symbol} fetch failed: ${msg}`);
      } finally {
        this.inFlight.delete(symbol);
      }
    }
  }
}
