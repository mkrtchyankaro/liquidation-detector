/**
 * FundingStatsService — long/short account ratio polling for V3 context.
 *
 * Polls Binance Futures' public endpoint
 *   GET /futures/data/globalLongShortAccountRatio
 * once every 5 minutes per tracked symbol, caches the latest snapshot,
 * and exposes a synchronous read API for V3's Telegram messages.
 *
 * Why this service exists
 * ─────────────────────────────────────────────────────────────────────
 * The endpoint reports the proportion of accounts holding net-long vs
 * net-short positions across Binance's entire futures user base. The
 * "globalLongShortAccountRatio" variant uses ALL accounts (not just
 * top traders), making it a proxy for retail sentiment — the population
 * whose stop-losses fuel cascade liquidations in the first place.
 *
 * V3's working hypothesis (display-only for now, may become a filter
 * after 2-4 weeks of observation):
 *   - LONG-victim cascade  + long-heavy market  → setup more credible
 *   - SHORT-victim cascade + short-heavy market → setup more credible
 *   - Mismatch direction                        → cascade may be real
 *                                                  momentum, not fade
 *
 * This service does NOT make trading decisions. It only fetches and
 * caches data; V3 reads `getLongShortRatio(symbol)` and embeds the
 * value plus a `[V3_FUNDING]` log line on every entry. Whether to
 * promote the signal to a hard filter is a later, evidence-driven
 * decision.
 *
 * Reliability
 * ─────────────────────────────────────────────────────────────────────
 * The endpoint is unauthenticated (no API key) and rate-limited at
 * 1000 requests / 5 minutes per IP. With 4 symbols polled every 5
 * minutes we use ~48 requests/hour, far under the cap. All HTTP
 * errors are caught; a failing poll leaves the previous cached value
 * in place rather than evicting good data. The first poll for each
 * symbol fires on `start()`; subsequent polls run on the timer.
 *
 * The endpoint returns the latest 5-minute snapshot, not real-time:
 * latency from a position change to its appearance in the API can be
 * several minutes. This is fine for a slow-moving "regime" indicator —
 * we are not making sub-second decisions on it.
 */

import axios, { type AxiosInstance } from "axios";
import { childLogger } from '../../infrastructure/logging/logger';

const log = childLogger({ mod: "funding-stats" });

// ─── Constants ───────────────────────────────────────────────────────

/** How often to poll each symbol. The endpoint's smallest period bucket
 *  is 5m, so polling more frequently than this would just return the
 *  same row repeatedly. 5 minutes is the natural cadence. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Period parameter to request from the endpoint. The API returns the
 *  account ratio aggregated over this window. We want the smallest
 *  available bucket so the data is as fresh as possible. */
const PERIOD = "5m";

/** Per-request timeout. Binance's API is normally <500ms; we give it
 *  10s of slack for network blips before treating it as a failure. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Maximum age, in ms, before a cached entry is considered stale and
 *  `getLongShortRatio()` returns null. 15min = three poll cycles missed.
 *  Past this point the data is unreliable enough that we'd rather
 *  display "n/a" than a stale ratio. */
const MAX_CACHE_AGE_MS = 15 * 60 * 1000;

/** Base URL for the public futures REST API. The long/short endpoint
 *  lives under /futures/data/, NOT /fapi/v1/, hence we don't reuse
 *  BinanceRestClient (which is rooted at /fapi). */
const BASE_URL = "https://fapi.binance.com";

// ─── Types ───────────────────────────────────────────────────────────

/** Single endpoint response row, as documented at:
 *  https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Long-Short-Ratio
 *
 *  Note: the docs example shows `longShortRatio = "0.1960"` paired
 *  with `longAccount = "0.6622"`, which is mathematically inconsistent
 *  (0.6622 / 0.3378 = 1.96, not 0.196). To avoid being burned by this
 *  inconsistency we ignore the precomputed `longShortRatio` field and
 *  recompute it from `longAccount / shortAccount`. */
interface RawRatioRow {
  symbol: string;
  longShortRatio: string;
  longAccount: string;
  shortAccount: string;
  timestamp: string;
}

/** Cached snapshot for one symbol. */
export interface FundingSnapshot {
  symbol: string;
  /** longAccount / shortAccount, recomputed from raw values.
   *  > 1.0 → more long accounts than short
   *  < 1.0 → more short accounts than long */
  ratio: number;
  /** Long account proportion (0..1). */
  longAccount: number;
  /** Short account proportion (0..1). */
  shortAccount: number;
  /** Endpoint timestamp (ms, when this snapshot represents). */
  bucketTime: number;
  /** Local fetch time (ms, used for cache freshness checks). */
  fetchedAt: number;
}

/** Categorical label for log markers and Telegram display. */
export type LongShortLabel = "long-heavy" | "short-heavy" | "balanced";

// ─── Constants for label thresholds ──────────────────────────────────
//
// Used by `labelFor()` below. These match the "moderate" preset
// discussed in design — i.e. ratio > 1.5 = long-heavy, < 0.67 (≈ 1/1.5)
// = short-heavy. Tuning these is observable from the [V3_FUNDING] log
// markers; a future change to a stricter or looser preset would not
// require any service-level rewrite.

const LABEL_LONG_HEAVY_THRESHOLD = 1.5;
const LABEL_SHORT_HEAVY_THRESHOLD = 1 / 1.5;

// ─── Service ─────────────────────────────────────────────────────────

export class FundingStatsService {
  private readonly http: AxiosInstance;
  private readonly cache = new Map<string, FundingSnapshot>();
  /** Separate cache for the top-trader POSITION ratio (money-weighted),
   *  polled from /futures/data/topLongShortPositionRatio. Account ratio
   *  (this.cache) counts heads; position ratio weights by position value.
   *  Comparing the two reveals retail-vs-smart-money divergence. */
  private readonly positionCache = new Map<string, FundingSnapshot>();
  private readonly symbols: ReadonlyArray<string>;
  private timer: NodeJS.Timeout | null = null;

  constructor(symbols: ReadonlyArray<string>) {
    this.symbols = symbols;
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  /** Fire an immediate poll for every symbol, then start the recurring
   *  timer. The immediate poll means downstream services (V3) can
   *  start querying ratios within a few seconds of boot rather than
   *  waiting a full 5 minutes for the first cycle. */
  start(): void {
    if (this.timer !== null) {
      log.warn("[funding-stats] start() called twice — ignoring");
      return;
    }
    void this.pollAll(); // fire-and-forget initial poll
    this.timer = setInterval(() => {
      void this.pollAll();
    }, POLL_INTERVAL_MS);
    log.info(
      { symbols: this.symbols, intervalMs: POLL_INTERVAL_MS },
      "[funding-stats] started",
    );
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Synchronous read for downstream consumers. Returns null when:
   *    - the symbol has never been polled successfully, OR
   *    - the cached snapshot is older than MAX_CACHE_AGE_MS.
   *  Callers must treat null as "data unavailable" and degrade
   *  gracefully (e.g. display "n/a" rather than guessing a value). */
  getLongShortRatio(symbol: string): FundingSnapshot | null {
    const snap = this.cache.get(symbol);
    if (!snap) return null;
    if (Date.now() - snap.fetchedAt > MAX_CACHE_AGE_MS) return null;
    return snap;
  }

  /** Top-trader POSITION ratio (money-weighted), same shape/staleness
   *  rules as getLongShortRatio. Returns null when unavailable or stale.
   *  Here longAccount/shortAccount carry POSITION proportions, not head
   *  counts — see positionCache docstring. */
  getPositionRatio(symbol: string): FundingSnapshot | null {
    const snap = this.positionCache.get(symbol);
    if (!snap) return null;
    if (Date.now() - snap.fetchedAt > MAX_CACHE_AGE_MS) return null;
    return snap;
  }

  /** Categorize a ratio for display. Returns "long-heavy" if there are
   *  meaningfully more long accounts than short, "short-heavy" for the
   *  opposite, and "balanced" for everything in between. */
  static labelFor(ratio: number): LongShortLabel {
    if (!Number.isFinite(ratio)) return "balanced";
    if (ratio >= LABEL_LONG_HEAVY_THRESHOLD) return "long-heavy";
    if (ratio <= LABEL_SHORT_HEAVY_THRESHOLD) return "short-heavy";
    return "balanced";
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private async pollAll(): Promise<void> {
    // Sequential rather than parallel — keeps the request rate low
    // and avoids burst-detection by Binance. With 4 symbols × 2
    // endpoints and a ~200ms RTT each this completes in ~2s. Still
    // ~96 requests/hour, far under the 1000/5min cap.
    for (const symbol of this.symbols) {
      try {
        await this.pollOne(
          symbol,
          "/futures/data/globalLongShortAccountRatio",
          this.cache,
          "account",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[funding-stats] account poll failed for ${symbol}: ${msg}`);
        // No cache eviction on failure — the previous good snapshot
        // remains until either it ages out (>15min) or a future poll
        // succeeds.
      }
      try {
        await this.pollOne(
          symbol,
          "/futures/data/topLongShortPositionRatio",
          this.positionCache,
          "position",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[funding-stats] position poll failed for ${symbol}: ${msg}`);
      }
    }
  }

  private async pollOne(
    symbol: string,
    path: string,
    cache: Map<string, FundingSnapshot>,
    kind: "account" | "position",
  ): Promise<void> {
    const res = await this.http.get<RawRatioRow[]>(path, {
      params: {
        symbol,
        period: PERIOD,
        limit: 1, // we only need the latest bucket
      },
    });
    if (!Array.isArray(res.data) || res.data.length === 0) {
      log.warn(`[funding-stats] empty ${kind} response for ${symbol}`);
      return;
    }
    const row = res.data[res.data.length - 1]; // latest bucket
    if (!row) return;
    const longAcct = parseFloat(row.longAccount);
    const shortAcct = parseFloat(row.shortAccount);
    if (
      !Number.isFinite(longAcct) ||
      !Number.isFinite(shortAcct) ||
      shortAcct <= 0
    ) {
      log.warn(
        `[funding-stats] malformed ${kind} numbers for ${symbol}: ` +
          `long=${row.longAccount} short=${row.shortAccount}`,
      );
      return;
    }
    // Recompute the ratio rather than trusting `row.longShortRatio` —
    // the docs' example contains an inconsistency between that field
    // and the longAccount/shortAccount values (see RawRatioRow comment).
    // Both endpoints share this field schema; for the position endpoint
    // longAccount/shortAccount carry position proportions, not heads.
    const ratio = longAcct / shortAcct;
    const bucketTime = parseInt(row.timestamp, 10);
    const snap: FundingSnapshot = {
      symbol,
      ratio,
      longAccount: longAcct,
      shortAccount: shortAcct,
      bucketTime: Number.isFinite(bucketTime) ? bucketTime : Date.now(),
      fetchedAt: Date.now(),
    };
    cache.set(symbol, snap);
    log.info(
      `[funding-stats] ${symbol} ${kind} ratio=${ratio.toFixed(2)} ` +
        `long=${(longAcct * 100).toFixed(1)}% ` +
        `short=${(shortAcct * 100).toFixed(1)}% ` +
        `label=${FundingStatsService.labelFor(ratio)}`,
    );
  }
}
