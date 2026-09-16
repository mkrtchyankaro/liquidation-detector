import { fetchKlines } from "./displacement-balanced-core";
import type { Candle } from "../../shared/common.types";

/**
 * Sep 16 2026 (Karo), operator-requested (429 fix). RESEARCH-ONLY.
 * Wraps fetchKlines (unchanged, shared core) with retry/backoff for
 * this pipeline specifically -- does not touch fetchKlines itself
 * (used unmodified by research-liquidation-episodes.ts and
 * research-episode-percentiles.ts, both frozen) or any production
 * REST client.
 *
 * fetchKlines does its own internal pagination across potentially
 * several requests; if any one page hits a 429, the whole call throws
 * and all progress from earlier pages is lost. This wrapper retries
 * the WHOLE fetchKlines call -- wasteful on a retry but simple and
 * safe for a one-shot research run, and 429s should become rare in
 * the first place once the caller stops making hundreds of redundant
 * per-episode calls -- see research-episode-oi-outcomes.ts's own
 * header for that fix.
 */

let totalRequestAttempts = 0;
let totalRetries = 0;
export function getFetchStats(): {
  totalRequestAttempts: number;
  totalRetries: number;
} {
  return { totalRequestAttempts, totalRetries };
}
export function resetFetchStats(): void {
  totalRequestAttempts = 0;
  totalRetries = 0;
}

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

function parseHttpStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /HTTP (\d+)/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** Retries on 429 (rate limited) and 418 (IP auto-banned, which
 *  Binance issues after repeated 429s) using exponential backoff
 *  capped at MAX_BACKOFF_MS. Any other error is NOT retried -- it
 *  propagates immediately, matching fetchKlines's own fail-fast
 *  behavior for genuine errors. */
export async function fetchKlinesWithRetry(
  symbol: string,
  intervalMs: number,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  let attempt = 0;
  for (;;) {
    totalRequestAttempts++;
    try {
      return await fetchKlines(symbol, intervalMs, fromMs, toMs);
    } catch (err) {
      const status = parseHttpStatus(err);
      const isRateLimited = status === 429 || status === 418;
      if (!isRateLimited || attempt >= MAX_RETRIES) throw err;
      totalRetries++;
      const backoffMs = Math.min(
        BASE_BACKOFF_MS * 2 ** attempt,
        MAX_BACKOFF_MS,
      );
      console.log(
        `  [RATE-LIMIT] ${symbol} HTTP ${status} -- retry ${attempt + 1}/${MAX_RETRIES} after ${backoffMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      attempt++;
    }
  }
}
