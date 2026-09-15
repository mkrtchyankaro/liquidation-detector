/**
 * OiTrackerService — Binance perpetual Open Interest tracker.
 *
 * Fetches current OI per symbol from Binance's public
 * `/fapi/v1/openInterest` endpoint (no auth required) and caches it in
 * memory for fast lookup.
 *
 * Sep 15 2026 (Karo), operator-approved -- upgraded from 60s sequential
 * polling to 1s PARALLEL polling for causal high-resolution OI
 * research on liquidation events. Verified against Binance's own
 * current docs before this change: this endpoint's request weight is
 * 1, the USDS-M Futures IP-wide limit is 2400 REQUEST_WEIGHT/minute --
 * at 1s cadence with N tracked symbols fetched in parallel, one cycle
 * = N weight, so N=10 costs 600 weight/min (25% of the limit), leaving
 * ample headroom for every other REST call this bot makes. Parallel
 * fetching (not sequential) is used specifically so cycle duration is
 * bounded by the SLOWEST single request rather than the SUM of all N
 * -- the prior sequential design could not reliably guarantee a full
 * pass completes inside a 1s window.
 *
 * Research-only: wired into V3 paperSignals.research.oiAt* snapshots
 * and the liquidation-market-snapshot enrichment builder so offline
 * analysis can investigate OI behavior around liquidation events. NO
 * production strategy/signal/entry logic branches on this value --
 * same observe-first stance taken with FundingStatsService (L/S
 * ratio) and FundingRateService.
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

import { childLogger } from "../../infrastructure/logging/logger";

const log = childLogger({ mod: "oi-tracker" });

const REFRESH_MS = 1_000; // Sep 15 2026 (Karo) -- was 60_000; see this file's own header for the weight/timing justification
const STALE_MS = 5 * 60 * 1000; // values older than this are returned as null
const FETCH_TIMEOUT_MS = 5_000;
/** Sep 15 2026 (Karo), operator-requested -- time-based retention,
 *  replacing the prior fixed-COUNT MAX_OI_HISTORY=240. That constant
 *  was sized for 4 hours at 60s cadence; reused verbatim at 1s cadence
 *  it would have silently shrunk retention to 4 MINUTES (240 x 1s) --
 *  the exact same bug class already found and fixed in
 *  OrderbookStore's raw ring earlier this project. At least 20
 *  minutes requested; retained generously above that so the boundary
 *  itself is never the limiting factor for a 10-minute-lookback delta
 *  query. Memory at ~1200 samples/symbol x {contracts,fetchedAt} is
 *  trivially small (well under 200KB even for 10 symbols). */
const HISTORY_RETENTION_MS = 21 * 60 * 1000; // 21 min -- comfortable margin above the 20 min floor

interface OiCacheEntry {
  /** OI value in contracts (base-asset units), as returned by Binance. */
  contracts: number;
  /** Local wall-clock when this entry was cached (ms epoch). Used for
   *  staleness check; NOT the `time` field Binance returned (which
   *  represents Binance's exchange time, can drift slightly). */
  fetchedAt: number;
}

export class OiTrackerService {
  private readonly cache = new Map<string, OiCacheEntry>();
  private readonly history = new Map<string, OiCacheEntry[]>();
  private timer: NodeJS.Timeout | null = null;
  /** Sep 15 2026 (Karo), operator-requested -- WHOLE-CYCLE overlap
   *  prevention. Replaces the prior PER-SYMBOL `inFlight` guard (which
   *  only stopped a duplicate request to the SAME symbol, not a whole
   *  new pass starting while a previous pass was still in flight for
   *  OTHER symbols). With parallel per-cycle fetching, if a full cycle
   *  hasn't resolved by the time the next 1s tick fires, that tick is
   *  skipped entirely rather than starting an overlapping cycle. */
  private cycleRunning = false;

  constructor(private readonly symbols: ReadonlyArray<string>) {
    // Kick off an immediate fetch so the cache is warm before the
    // first V3 watch state is created. setInterval handles ongoing
    // refreshes.
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    log.info(
      `[oi-tracker] OiTrackerService started for ${symbols.length} symbols (refresh ${REFRESH_MS}ms, parallel, historyRetentionMs=${HISTORY_RETENTION_MS})`,
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
   *  null". No production strategy logic branches on this value --
   *  research capture only. */
  getCachedOI(symbol: string): { contracts: number; ts: number } | null {
    const entry = this.cache.get(symbol);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > STALE_MS) return null;
    return { contracts: entry.contracts, ts: entry.fetchedAt };
  }

  /** Rolling MEDIAN of ABSOLUTE consecutive-sample OI change
   *  (contracts), over the retained history. Cadence-agnostic by
   *  design (Sep 15 2026, Karo): prior to the 1s-polling upgrade this
   *  measured minute-to-minute change at 60s cadence; it now measures
   *  second-to-second change at 1s cadence -- the MATH is unchanged,
   *  only the granularity being measured differs, since it always
   *  compares consecutive RETAINED samples whatever the current
   *  polling interval is. Returns null if fewer than 5 samples exist
   *  yet (cold start). */
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
   *  causal at-or-before lookups for delta/velocity features). Returns
   *  an empty array if never sampled. */
  getOiHistory(symbol: string): ReadonlyArray<OiCacheEntry> {
    return this.history.get(symbol) ?? [];
  }

  /** Refresh all tracked symbols in PARALLEL (Sep 15 2026, Karo --
   *  see this file's own header for why parallel replaced sequential).
   *  Whole-cycle overlap prevention: if a previous cycle is still
   *  running, this tick is skipped entirely rather than starting a
   *  second concurrent pass. Per-symbol failures are fully isolated --
   *  each symbol's fetch has its own try/catch, so one symbol's
   *  failure (timeout, bad response, parse error) can never affect
   *  any other symbol's fetch in the same cycle; the previous cached
   *  value for a failing symbol is kept until STALE_MS elapses. */
  private async refresh(): Promise<void> {
    if (this.cycleRunning) {
      return; // previous cycle still in flight -- skip this tick rather than stacking cycles
    }
    this.cycleRunning = true;
    try {
      await Promise.all(this.symbols.map((symbol) => this.fetchOne(symbol)));
    } finally {
      this.cycleRunning = false;
    }
  }

  /** Fetch and record OI for exactly one symbol. Never throws -- every
   *  failure path is caught and logged here, isolated from every
   *  other symbol's own fetchOne() call in the same Promise.all(). */
  private async fetchOne(symbol: string): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const url = `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) {
        log.warn(`[oi-tracker] ${symbol} HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { openInterest?: string };
      if (!data.openInterest) return;
      const contracts = parseFloat(data.openInterest);
      if (!Number.isFinite(contracts) || contracts <= 0) return;
      const entry: OiCacheEntry = { contracts, fetchedAt: Date.now() };
      this.cache.set(symbol, entry);

      let hist = this.history.get(symbol);
      if (!hist) {
        hist = [];
        this.history.set(symbol, hist);
      }
      hist.push(entry);
      // time-based eviction -- see HISTORY_RETENTION_MS's own doc comment
      const cutoff = entry.fetchedAt - HISTORY_RETENTION_MS;
      while (hist.length > 0 && hist[0]!.fetchedAt < cutoff) hist.shift();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[oi-tracker] ${symbol} fetch failed: ${msg}`);
    }
  }
}
