/**
 * ATR bootstrap — restart safety (May 2026).
 *
 * On bot startup, fetches enough closed historical klines from Binance
 * REST for each (symbol, interval) pair and feeds them into the
 * ATRTrackerService via its existing onCandle() hook. After this
 * routine completes, ATR(14) is warm — V3 will not skip large
 * liquidations with "ATR15m cold" while the bot is waiting for live
 * WS klines to accumulate.
 *
 * Why this exists
 * ─────────────────────────────────────────────────────────────────────
 * Without bootstrap, every restart causes ~15-20 min of blindness per
 * (symbol, interval) pair while live WS klines accumulate to the
 * APPROXIMATE_MIN_CANDLES = 4 floor in ATRTrackerService. Worse, true
 * Wilder smoothing requires 15+ candles, which is ~3.75 hours of 15m
 * data — completely unacceptable for a production deploy that should
 * resume operation immediately after a restart.
 *
 * Mechanics
 * ─────────────────────────────────────────────────────────────────────
 * - Excludes the currently forming candle. The Binance endpoint returns
 *   the latest kline regardless of whether it has closed; our REST
 *   parser hardcodes isClosed=true, which is unsafe for the most-recent
 *   kline. We filter by closeTime < Date.now() before feeding the
 *   tracker. (Binance closeTime is the inclusive end-of-candle ms; if
 *   it has not yet passed, the candle is still live.)
 * - Dedup-safe with WS. ATRTrackerService.onCandle() dedupes by
 *   openTime, so the live WS broadcasts that follow the bootstrap will
 *   be silently ignored if they reuse an openTime we already loaded.
 * - Per-pair failure isolation. A REST error for one (symbol, interval)
 *   does not abort the whole bootstrap — the failing pair logs a
 *   warning and the rest proceed. V3 will then skip that pair with
 *   "ATR cold" until live klines warm it, exactly as before.
 * - No retry, no backoff. This is a one-shot at boot. If Binance is
 *   unreachable here it is unreachable for the whole bot — log loudly
 *   and let live WS warmup take over.
 */

import type { BinanceRestClient } from '../../infrastructure/binance/binanceRest.client';
import type { ATRTrackerService } from "./atr-tracker.service";
import type { KlineInterval } from '../../shared/common.types';
import { childLogger } from '../../infrastructure/logging/logger';

const log = childLogger({ mod: "atr-bootstrap" });

export interface BootstrapPair {
  symbol: string;
  interval: KlineInterval;
  /** Number of historical klines to request. 100 is a safe default for
   *  ATR(14) — guarantees the Wilder smoothing path (≥15 candles) plus
   *  buffer for `rangeBefore()` queries. Capped at 500 (Binance limit). */
  limit: number;
}

export interface BootstrapResult {
  symbol: string;
  interval: KlineInterval;
  /** Closed candles successfully fed into the tracker (excludes the
   *  currently-forming candle). */
  closedCandles: number;
  /** True if `atr.getATR(symbol, interval)` returns non-null after the
   *  feed completes — i.e. ATR is usable for live decisions. */
  warm: boolean;
  /** Human-readable error if the REST fetch or feed failed. */
  error?: string;
}

/** Convenience helper: build the (symbol × interval) pair list with a
 *  uniform limit. Order is (symbol-major, interval-minor) which matches
 *  the order results are logged in — easier to scan post-restart. */
export function pairsFor(
  symbols: ReadonlyArray<string>,
  intervals: ReadonlyArray<KlineInterval>,
  limit: number,
): BootstrapPair[] {
  const out: BootstrapPair[] = [];
  for (const symbol of symbols) {
    for (const interval of intervals) {
      out.push({ symbol, interval, limit });
    }
  }
  return out;
}

/** Pull historical closed klines from REST and seed the ATR tracker.
 *  Never throws — per-pair failures are logged and reflected in the
 *  returned `BootstrapResult.error` field. */
export async function bootstrapAtrFromRest(
  rest: BinanceRestClient,
  atr: ATRTrackerService,
  pairs: ReadonlyArray<BootstrapPair>,
): Promise<BootstrapResult[]> {
  const now = Date.now();
  const results: BootstrapResult[] = [];

  log.info(
    `[ATR_BOOTSTRAP] starting pairs=${pairs.length} ` +
      `symbols=${new Set(pairs.map((p) => p.symbol)).size} ` +
      `intervals=${[...new Set(pairs.map((p) => p.interval))].join(",")}`,
  );

  for (const pair of pairs) {
    try {
      const candles = await rest.getKlines(
        pair.symbol,
        pair.interval,
        Math.min(pair.limit, 500),
      );
      // Exclude the currently-forming candle. Binance's REST kline
      // endpoint returns the latest kline regardless of close state;
      // our REST parser hardcodes isClosed=true, so we have to filter
      // ourselves. closeTime is the inclusive end-of-candle timestamp
      // in ms; if it has not yet passed, the candle is still live.
      const closed = candles.filter((c) => c.closeTime < now);

      // Feed the tracker. onCandle() filters on isClosed=true (safe
      // here — REST parser already sets it), dedupes by openTime, and
      // updates the smoothed ATR after each push.
      for (const c of closed) {
        atr.onCandle(c);
      }

      const warm = atr.getATR(pair.symbol, pair.interval) !== null;
      results.push({
        symbol: pair.symbol,
        interval: pair.interval,
        closedCandles: closed.length,
        warm,
      });

      log.info(
        `[ATR_BOOTSTRAP] ${pair.symbol} tf=${pair.interval} ` +
          `closedCandles=${closed.length} warm=${warm}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        symbol: pair.symbol,
        interval: pair.interval,
        closedCandles: 0,
        warm: false,
        error: msg,
      });
      log.warn(
        `[ATR_BOOTSTRAP] ${pair.symbol} tf=${pair.interval} FAILED: ${msg} ` +
          `— falling back to live WS warmup (~15-20min cold window)`,
      );
    }
  }

  // Summary line so operators can confirm post-boot warmth at a glance.
  const warmCount = results.filter((r) => r.warm).length;
  const failedCount = results.filter((r) => r.error !== undefined).length;
  log.info(
    `[ATR_BOOTSTRAP] complete pairs=${results.length} warm=${warmCount} failed=${failedCount}`,
  );

  return results;
}
