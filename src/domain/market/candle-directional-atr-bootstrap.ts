/**
 * Candle + directional-ATR bootstrap — restart safety (Sep 16 2026,
 * Karo, operator-approved).
 *
 * Companion to atr-bootstrap.ts, which already warms standard
 * (Wilder) ATR on every restart -- confirmed correct and UNCHANGED by
 * this file. The gap this closes is narrower and specific:
 *   - CandleStore (candleStore.seed() already existed for exactly
 *     this purpose -- never previously called at startup)
 *   - DirectionalAtrTracker 1m / 3m / 5m (no bootstrap existed at all)
 *
 * Without this, candleStore/directionalAtr* are empty on restart and
 * only warm as live WS klines accumulate -- meaning a liquidation
 * arriving shortly after redeploy could be enriched with incomplete
 * directional-ATR / lastClosedCandleTs context in its marketSnapshot.
 *
 * SAME DATA PATH, NOT A PARALLEL IMPLEMENTATION: this feeds the exact
 * same production objects (CandleStore.seed(), DirectionalAtrTracker.
 * onCandle()) that live WS klines already feed -- no new ATR/candle
 * math anywhere in this file.
 *
 * CLOSED CANDLES ONLY: Binance's REST kline endpoint returns the
 * latest kline regardless of whether it has closed; we filter by
 * closeTime < now before feeding anything, exactly matching
 * atr-bootstrap.ts's own established filter.
 *
 * SEQUENCING, NOT RACE-HANDLING: this is awaited in main.ts BEFORE
 * orchestrator.start() -- the same call that opens the WS connection
 * carrying both klines and forceOrder (liquidation) events. Because
 * nothing can arrive from WS before that connection opens, there is
 * structurally no REST/WS race to design around here -- see this
 * turn's own architecture writeup for the full reasoning. DirectionalAtrTracker.
 * onCandle()'s own openTime dedup and CandleStore.seed()'s own closed-
 * only filter are an additional safety margin, not the primary
 * defense.
 *
 * 100-CANDLE POLICY: DirectionalAtrTracker is a pure EMA (alpha =
 * 2/15), not Wilder-smoothed -- its seed value never fully washes out
 * of a running EMA, only decays exponentially. Solving
 * (1-alpha)^N < 0.01 gives N~=33 for <1% residual seed influence.
 * 100 candles is a deliberately generous margin beyond that
 * mathematical minimum, producing a genuinely representative warm
 * value rather than merely a non-null one -- operator-specified, not
 * tuned down to the bare minimum.
 */

import type { BinanceRestClient } from "../../infrastructure/binance/binanceRest.client";
import type { CandleStore } from "./candle.store";
import type { DirectionalAtrTracker } from "../../strategy/v5/directional-atr";
import { childLogger } from "../../infrastructure/logging/logger";

const log = childLogger({ mod: "candle-directional-atr-bootstrap" });

const CANDLE_WARMUP_INTERVALS = ["1m", "3m", "5m"] as const;
export type CandleWarmupInterval = (typeof CANDLE_WARMUP_INTERVALS)[number];
export const CANDLES_PER_PAIR = 100;

export interface CandleBootstrapDeps {
  candleStore: CandleStore;
  directionalAtr1m: DirectionalAtrTracker;
  directionalAtr3m: DirectionalAtrTracker;
  directionalAtr5m: DirectionalAtrTracker;
}

export interface CandleBootstrapResult {
  symbol: string;
  interval: CandleWarmupInterval;
  /** Closed candles successfully fed into both candleStore and the
   *  matching DirectionalAtrTracker (excludes the currently-forming
   *  candle). */
  closedCandles: number;
  /** True if the matching DirectionalAtrTracker returns non-null
   *  down/up ATR for this symbol after the feed completes. */
  directionalWarm: boolean;
  error?: string;
}

function trackerFor(
  deps: CandleBootstrapDeps,
  interval: CandleWarmupInterval,
): DirectionalAtrTracker {
  return interval === "1m"
    ? deps.directionalAtr1m
    : interval === "3m"
      ? deps.directionalAtr3m
      : deps.directionalAtr5m;
}

/** Pull historical closed 1m/3m/5m klines from REST and seed
 *  CandleStore + the matching DirectionalAtrTracker for every symbol.
 *  Never throws -- per (symbol, interval) failures are logged and
 *  reflected in the returned result's `error` field; a failing pair
 *  never aborts the rest of the bootstrap. */
export async function bootstrapCandleAndDirectionalAtrFromRest(
  rest: BinanceRestClient,
  deps: CandleBootstrapDeps,
  symbols: ReadonlyArray<string>,
): Promise<CandleBootstrapResult[]> {
  const startedAt = Date.now();
  const results: CandleBootstrapResult[] = [];

  log.info(
    `[CANDLE-WARMUP] starting symbols=${symbols.length} intervals=${CANDLE_WARMUP_INTERVALS.join(",")} candlesPerPair=${CANDLES_PER_PAIR}`,
  );

  for (const symbol of symbols) {
    const closedCounts: Record<CandleWarmupInterval, number> = {
      "1m": 0,
      "3m": 0,
      "5m": 0,
    };
    for (const interval of CANDLE_WARMUP_INTERVALS) {
      const now = Date.now(); // per-pair, matching atr-bootstrap.ts's own per-pair "now" semantics
      try {
        const candles = await rest.getKlines(
          symbol,
          interval,
          CANDLES_PER_PAIR,
        );
        // CLOSED CANDLES ONLY -- see this file's own header for why
        // this exact filter (closeTime < now) matches atr-bootstrap.ts.
        const closed = candles.filter((c) => c.closeTime < now);

        // Same production objects live WS klines already feed -- no
        // parallel implementation. seed() replaces this interval's
        // closed array wholesale, which is safe here specifically
        // because this call is sequenced before any WS candle can
        // possibly have arrived (see this file's own SEQUENCING note).
        deps.candleStore.seed(symbol, interval, closed);

        const tracker = trackerFor(deps, interval);
        for (const c of closed) tracker.onCandle(c);

        const directionalWarm =
          tracker.getDownAtr(symbol) !== null &&
          tracker.getUpAtr(symbol) !== null;
        closedCounts[interval] = closed.length;
        results.push({
          symbol,
          interval,
          closedCandles: closed.length,
          directionalWarm,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          symbol,
          interval,
          closedCandles: 0,
          directionalWarm: false,
          error: msg,
        });
        log.warn(
          `[CANDLE-WARMUP] ${symbol} ${interval} FAILED: ${msg} -- will warm naturally from live WS candles instead`,
        );
      }
    }

    const oneM = deps.directionalAtr1m,
      threeM = deps.directionalAtr3m,
      fiveM = deps.directionalAtr5m;
    const fmt = (v: number | null): string =>
      v !== null ? v.toFixed(6) : "n/a";
    log.info(
      `[CANDLE-WARMUP] ${symbol}\n` +
        `  1m closed=${closedCounts["1m"]}\n` +
        `  3m closed=${closedCounts["3m"]}\n` +
        `  5m closed=${closedCounts["5m"]}\n` +
        `  directionalATR:\n` +
        `    1m down=${fmt(oneM.getDownAtr(symbol))} up=${fmt(oneM.getUpAtr(symbol))}\n` +
        `    3m down=${fmt(threeM.getDownAtr(symbol))} up=${fmt(threeM.getUpAtr(symbol))}\n` +
        `    5m down=${fmt(fiveM.getDownAtr(symbol))} up=${fmt(fiveM.getUpAtr(symbol))}`,
    );
  }

  const durationMs = Date.now() - startedAt;
  const failedCount = results.filter((r) => r.error !== undefined).length;
  log.info(
    `[CANDLE-WARMUP] complete symbols=${symbols.length} durationMs=${durationMs} failed=${failedCount}`,
  );

  return results;
}
