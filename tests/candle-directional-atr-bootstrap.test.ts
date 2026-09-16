import * as assert from "assert";
import {
  bootstrapCandleAndDirectionalAtrFromRest,
  CANDLES_PER_PAIR,
} from "../src/domain/market/candle-directional-atr-bootstrap";
import { CandleStore } from "../src/domain/market/candle.store";
import { DirectionalAtrTracker } from "../src/strategy/v5/directional-atr";
import type { BinanceRestClient } from "../src/infrastructure/binance/binanceRest.client";
import type { Candle, KlineInterval } from "../src/shared/common.types";

let passed = 0;
let failed = 0;
function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  \u2713 ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  \u2717 ${name}`);
      console.log(
        `      ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
}

const SYMBOL = "BTCUSDT";

function mkCandle(
  symbol: string,
  interval: KlineInterval,
  openTime: number,
  intervalMs: number,
  o: number,
  h: number,
  l: number,
  c: number,
  isClosed = true,
): Candle {
  return {
    symbol,
    interval,
    openTime,
    closeTime: openTime + intervalMs - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1,
    quoteVolume: 1,
    takerBuyVolume: 1,
    takerBuyQuoteVolume: 1,
    trades: 1,
    isClosed,
  };
}

/** Deterministic synthetic candle series -- a mild random-walk with a
 *  fixed seed (linear congruential generator, no external dependency)
 *  so results are exactly reproducible across runs. */
function makeSeries(
  symbol: string,
  interval: KlineInterval,
  intervalMs: number,
  count: number,
  endTimeExclusive: number,
): Candle[] {
  let seed = 42;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out: Candle[] = [];
  let price = 100;
  const startTime = endTimeExclusive - count * intervalMs;
  for (let i = 0; i < count; i++) {
    const openTime = startTime + i * intervalMs;
    const o = price;
    const drift = (rand() - 0.5) * 2;
    price = Math.max(1, price + drift);
    const c = price;
    const h = Math.max(o, c) + rand() * 0.5;
    const l = Math.min(o, c) - rand() * 0.5;
    out.push(mkCandle(symbol, interval, openTime, intervalMs, o, h, l, c));
  }
  return out;
}

function freshDeps() {
  return {
    candleStore: new CandleStore(),
    directionalAtr1m: new DirectionalAtrTracker(),
    directionalAtr3m: new DirectionalAtrTracker(),
    directionalAtr5m: new DirectionalAtrTracker(),
  };
}

function fakeRest(
  bySymbolInterval: Map<string, Candle[]>,
  fail?: (symbol: string, interval: KlineInterval) => boolean,
): BinanceRestClient {
  return {
    getKlines: async (
      symbol: string,
      interval: KlineInterval,
      limit: number,
    ) => {
      if (fail?.(symbol, interval))
        throw new Error(`simulated REST failure for ${symbol} ${interval}`);
      const key = `${symbol}:${interval}`;
      const all = bySymbolInterval.get(key) ?? [];
      return all.slice(-limit);
    },
  } as unknown as BinanceRestClient;
}

async function main(): Promise<void> {
  console.log("Running candle-directional-atr-bootstrap tests...\n");

  await scenario(
    "1. empty CandleStore becomes immediately populated after bootstrap",
    async () => {
      const now = 10_000_000;
      const data = new Map<string, Candle[]>();
      data.set(
        `${SYMBOL}:1m`,
        makeSeries(SYMBOL, "1m", 60_000, CANDLES_PER_PAIR, now),
      );
      data.set(
        `${SYMBOL}:3m`,
        makeSeries(SYMBOL, "3m", 180_000, CANDLES_PER_PAIR, now),
      );
      data.set(
        `${SYMBOL}:5m`,
        makeSeries(SYMBOL, "5m", 300_000, CANDLES_PER_PAIR, now),
      );
      const deps = freshDeps();
      assert.strictEqual(
        deps.candleStore.getClosed(SYMBOL, "1m").length,
        0,
        "must start empty",
      );
      await bootstrapCandleAndDirectionalAtrFromRest(fakeRest(data), deps, [
        SYMBOL,
      ]);
      assert.strictEqual(
        deps.candleStore.getClosed(SYMBOL, "1m").length,
        CANDLES_PER_PAIR,
        "1m must be populated with all 100 candles",
      );
      assert.strictEqual(
        deps.candleStore.getClosed(SYMBOL, "3m").length,
        CANDLES_PER_PAIR,
      );
      assert.strictEqual(
        deps.candleStore.getClosed(SYMBOL, "5m").length,
        CANDLES_PER_PAIR,
      );
    },
  );

  await scenario(
    "2/3/4. Directional ATR 1m/3m/5m are all immediately available after bootstrap",
    async () => {
      const now = 10_000_000;
      const data = new Map<string, Candle[]>();
      data.set(
        `${SYMBOL}:1m`,
        makeSeries(SYMBOL, "1m", 60_000, CANDLES_PER_PAIR, now),
      );
      data.set(
        `${SYMBOL}:3m`,
        makeSeries(SYMBOL, "3m", 180_000, CANDLES_PER_PAIR, now),
      );
      data.set(
        `${SYMBOL}:5m`,
        makeSeries(SYMBOL, "5m", 300_000, CANDLES_PER_PAIR, now),
      );
      const deps = freshDeps();
      assert.strictEqual(
        deps.directionalAtr1m.getDownAtr(SYMBOL),
        null,
        "must start cold",
      );
      await bootstrapCandleAndDirectionalAtrFromRest(fakeRest(data), deps, [
        SYMBOL,
      ]);
      assert.notStrictEqual(
        deps.directionalAtr1m.getDownAtr(SYMBOL),
        null,
        "1m directional ATR must be warm immediately",
      );
      assert.notStrictEqual(deps.directionalAtr1m.getUpAtr(SYMBOL), null);
      assert.notStrictEqual(
        deps.directionalAtr3m.getDownAtr(SYMBOL),
        null,
        "3m directional ATR must be warm immediately",
      );
      assert.notStrictEqual(deps.directionalAtr3m.getUpAtr(SYMBOL), null);
      assert.notStrictEqual(
        deps.directionalAtr5m.getDownAtr(SYMBOL),
        null,
        "5m directional ATR must be warm immediately",
      );
      assert.notStrictEqual(deps.directionalAtr5m.getUpAtr(SYMBOL), null);
    },
  );

  await scenario("5. current unfinished REST candle is excluded", async () => {
    const now = 10_000_000;
    const closedSeries = makeSeries(SYMBOL, "1m", 60_000, 20, now);
    // must be unfinished relative to REAL Date.now() (what the bootstrap function itself checks against), not the test's synthetic historical "now" used to build the closed series
    const unfinished = mkCandle(
      SYMBOL,
      "1m",
      Date.now(),
      60_000,
      100,
      101,
      99,
      100.5,
    );
    assert.ok(
      unfinished.closeTime >= Date.now(),
      "test setup: this candle's closeTime must not be in the past relative to real time",
    );
    const data = new Map<string, Candle[]>();
    data.set(`${SYMBOL}:1m`, [...closedSeries, unfinished]);
    data.set(`${SYMBOL}:3m`, makeSeries(SYMBOL, "3m", 180_000, 5, now));
    data.set(`${SYMBOL}:5m`, makeSeries(SYMBOL, "5m", 300_000, 5, now));
    const deps = freshDeps();
    await bootstrapCandleAndDirectionalAtrFromRest(fakeRest(data), deps, [
      SYMBOL,
    ]);
    const stored = deps.candleStore.getClosed(SYMBOL, "1m");
    assert.strictEqual(
      stored.length,
      20,
      "the unfinished candle must not be counted among closed candles",
    );
    assert.ok(
      !stored.some((c) => c.openTime === unfinished.openTime),
      "the unfinished candle's openTime must not appear in the closed store at all",
    );
  });

  await scenario(
    "6. only closed candles affect directional ATR (unfinished candle never reaches onCandle)",
    async () => {
      const now = 10_000_000;
      const closedSeries = makeSeries(SYMBOL, "1m", 60_000, 20, now);
      const trackerWithoutUnfinished = new DirectionalAtrTracker();
      for (const c of closedSeries) trackerWithoutUnfinished.onCandle(c);
      const expectedDown = trackerWithoutUnfinished.getDownAtr(SYMBOL);

      const unfinished = mkCandle(
        SYMBOL,
        "1m",
        Date.now(),
        60_000,
        100,
        101,
        99,
        100.5,
      );
      const data = new Map<string, Candle[]>();
      data.set(`${SYMBOL}:1m`, [...closedSeries, unfinished]);
      data.set(`${SYMBOL}:3m`, makeSeries(SYMBOL, "3m", 180_000, 5, now));
      data.set(`${SYMBOL}:5m`, makeSeries(SYMBOL, "5m", 300_000, 5, now));
      const deps = freshDeps();
      await bootstrapCandleAndDirectionalAtrFromRest(fakeRest(data), deps, [
        SYMBOL,
      ]);
      assert.strictEqual(
        deps.directionalAtr1m.getDownAtr(SYMBOL),
        expectedDown,
        "directional ATR must be identical whether or not the unfinished candle was present in the REST response -- it must never be fed",
      );
    },
  );

  await scenario(
    "7. historical/live duplicate openTime is safely deduplicated",
    async () => {
      const now = 10_000_000;
      const series = makeSeries(SYMBOL, "1m", 60_000, 20, now);
      const data = new Map<string, Candle[]>();
      data.set(`${SYMBOL}:1m`, series);
      data.set(`${SYMBOL}:3m`, makeSeries(SYMBOL, "3m", 180_000, 5, now));
      data.set(`${SYMBOL}:5m`, makeSeries(SYMBOL, "5m", 300_000, 5, now));
      const deps = freshDeps();
      await bootstrapCandleAndDirectionalAtrFromRest(fakeRest(data), deps, [
        SYMBOL,
      ]);
      const before = deps.candleStore.getClosed(SYMBOL, "1m").length;
      const lastHistorical = series[series.length - 1]!;
      deps.candleStore.ingest(lastHistorical);
      deps.directionalAtr1m.onCandle(lastHistorical);
      const after = deps.candleStore.getClosed(SYMBOL, "1m").length;
      assert.strictEqual(
        after,
        before,
        "re-ingesting the same openTime must not create a duplicate entry in CandleStore",
      );
    },
  );

  await scenario(
    "8. chronological candle history remains correct after bootstrap",
    async () => {
      const now = 10_000_000;
      const series = makeSeries(SYMBOL, "1m", 60_000, 30, now);
      const data = new Map<string, Candle[]>();
      data.set(`${SYMBOL}:1m`, series);
      data.set(`${SYMBOL}:3m`, makeSeries(SYMBOL, "3m", 180_000, 5, now));
      data.set(`${SYMBOL}:5m`, makeSeries(SYMBOL, "5m", 300_000, 5, now));
      const deps = freshDeps();
      await bootstrapCandleAndDirectionalAtrFromRest(fakeRest(data), deps, [
        SYMBOL,
      ]);
      const stored = deps.candleStore.getClosed(SYMBOL, "1m");
      for (let i = 1; i < stored.length; i++)
        assert.ok(
          stored[i]!.openTime > stored[i - 1]!.openTime,
          `candles must remain strictly chronological -- violated at index ${i}`,
        );
    },
  );

  await scenario(
    "9. restart-bootstrap directional ATR is practically equivalent to uninterrupted EMA (tolerance, not exact)",
    () => {
      const now = 10_000_000;
      const fullSeries = makeSeries(SYMBOL, "1m", 60_000, 500, now);
      const uninterrupted = new DirectionalAtrTracker();
      for (const c of fullSeries) uninterrupted.onCandle(c);
      const uninterruptedDown = uninterrupted.getDownAtr(SYMBOL)!;
      const uninterruptedUp = uninterrupted.getUpAtr(SYMBOL)!;

      const restarted = new DirectionalAtrTracker();
      const last100 = fullSeries.slice(-CANDLES_PER_PAIR);
      for (const c of last100) restarted.onCandle(c);
      const restartedDown = restarted.getDownAtr(SYMBOL)!;
      const restartedUp = restarted.getUpAtr(SYMBOL)!;

      const downDiffPct =
        Math.abs(restartedDown - uninterruptedDown) / uninterruptedDown;
      const upDiffPct =
        Math.abs(restartedUp - uninterruptedUp) / uninterruptedUp;
      console.log(
        `      uninterrupted down=${uninterruptedDown.toFixed(4)} up=${uninterruptedUp.toFixed(4)}`,
      );
      console.log(
        `      restart+100      down=${restartedDown.toFixed(4)} up=${restartedUp.toFixed(4)}`,
      );
      console.log(
        `      relative difference: down=${(downDiffPct * 100).toFixed(3)}% up=${(upDiffPct * 100).toFixed(3)}%`,
      );
      assert.ok(
        downDiffPct < 0.05,
        `restart-bootstrap down-ATR must be within 5% of uninterrupted -- got ${(downDiffPct * 100).toFixed(2)}%`,
      );
      assert.ok(
        upDiffPct < 0.05,
        `restart-bootstrap up-ATR must be within 5% of uninterrupted -- got ${(upDiffPct * 100).toFixed(2)}%`,
      );
    },
  );

  await scenario(
    "10. one symbol's failure does not affect another symbol",
    async () => {
      const now = 10_000_000;
      const data = new Map<string, Candle[]>();
      data.set(
        `BTCUSDT:1m`,
        makeSeries("BTCUSDT", "1m", 60_000, CANDLES_PER_PAIR, now),
      );
      data.set(
        `BTCUSDT:3m`,
        makeSeries("BTCUSDT", "3m", 180_000, CANDLES_PER_PAIR, now),
      );
      data.set(
        `BTCUSDT:5m`,
        makeSeries("BTCUSDT", "5m", 300_000, CANDLES_PER_PAIR, now),
      );
      data.set(
        `ETHUSDT:1m`,
        makeSeries("ETHUSDT", "1m", 60_000, CANDLES_PER_PAIR, now),
      );
      data.set(
        `ETHUSDT:3m`,
        makeSeries("ETHUSDT", "3m", 180_000, CANDLES_PER_PAIR, now),
      );
      data.set(
        `ETHUSDT:5m`,
        makeSeries("ETHUSDT", "5m", 300_000, CANDLES_PER_PAIR, now),
      );
      const deps = freshDeps();
      const results = await bootstrapCandleAndDirectionalAtrFromRest(
        fakeRest(data, (symbol) => symbol === "ETHUSDT"),
        deps,
        ["BTCUSDT", "ETHUSDT"],
      );
      assert.ok(
        results
          .filter((r) => r.symbol === "ETHUSDT")
          .every((r) => r.error !== undefined),
        "ETHUSDT must show failures",
      );
      assert.ok(
        results
          .filter((r) => r.symbol === "BTCUSDT")
          .every((r) => r.error === undefined),
        "BTCUSDT must NOT be affected by ETHUSDT's failure",
      );
      assert.strictEqual(
        deps.candleStore.getClosed("BTCUSDT", "1m").length,
        CANDLES_PER_PAIR,
        "BTCUSDT must still be fully warm",
      );
      assert.notStrictEqual(deps.directionalAtr1m.getDownAtr("BTCUSDT"), null);
      assert.strictEqual(
        deps.candleStore.getClosed("ETHUSDT", "1m").length,
        0,
        "ETHUSDT must remain cold, not fabricated",
      );
      assert.strictEqual(
        deps.directionalAtr1m.getDownAtr("ETHUSDT"),
        null,
        "ETHUSDT directional ATR must remain null, never fabricated",
      );
    },
  );

  await scenario(
    "11. one timeframe's failure does not affect other timeframes for the same symbol",
    async () => {
      const now = 10_000_000;
      const data = new Map<string, Candle[]>();
      data.set(
        `${SYMBOL}:1m`,
        makeSeries(SYMBOL, "1m", 60_000, CANDLES_PER_PAIR, now),
      );
      data.set(
        `${SYMBOL}:3m`,
        makeSeries(SYMBOL, "3m", 180_000, CANDLES_PER_PAIR, now),
      );
      data.set(
        `${SYMBOL}:5m`,
        makeSeries(SYMBOL, "5m", 300_000, CANDLES_PER_PAIR, now),
      );
      const deps = freshDeps();
      const results = await bootstrapCandleAndDirectionalAtrFromRest(
        fakeRest(data, (_s, interval) => interval === "3m"),
        deps,
        [SYMBOL],
      );
      const threeMResult = results.find((r) => r.interval === "3m")!;
      assert.notStrictEqual(
        threeMResult.error,
        undefined,
        "3m must show a failure",
      );
      assert.strictEqual(
        deps.candleStore.getClosed(SYMBOL, "3m").length,
        0,
        "3m must remain cold",
      );
      assert.strictEqual(
        deps.directionalAtr3m.getDownAtr(SYMBOL),
        null,
        "3m directional ATR must remain null",
      );
      assert.strictEqual(
        deps.candleStore.getClosed(SYMBOL, "1m").length,
        CANDLES_PER_PAIR,
        "1m must still be fully warm despite 3m's failure",
      );
      assert.notStrictEqual(deps.directionalAtr1m.getDownAtr(SYMBOL), null);
      assert.strictEqual(
        deps.candleStore.getClosed(SYMBOL, "5m").length,
        CANDLES_PER_PAIR,
        "5m must still be fully warm despite 3m's failure",
      );
      assert.notStrictEqual(deps.directionalAtr5m.getDownAtr(SYMBOL), null);
    },
  );

  await scenario(
    "12. bootstrap is a genuinely awaited Promise, not internally fire-and-forget",
    async () => {
      let restCallsCompleted = 0;
      const now = 10_000_000;
      const rest = {
        getKlines: async (symbol: string, interval: KlineInterval) => {
          await new Promise((r) => setTimeout(r, 10));
          restCallsCompleted++;
          return makeSeries(
            symbol,
            interval,
            interval === "1m" ? 60_000 : interval === "3m" ? 180_000 : 300_000,
            10,
            now,
          );
        },
      } as unknown as BinanceRestClient;
      const deps = freshDeps();
      await bootstrapCandleAndDirectionalAtrFromRest(rest, deps, [SYMBOL]);
      assert.strictEqual(
        restCallsCompleted,
        3,
        "all 3 REST calls (1m/3m/5m) must have genuinely completed before the awaited function returns",
      );
    },
  );

  await scenario(
    "14. existing live WS candle ingestion remains unchanged after warmup (bootstrap then live extends naturally)",
    async () => {
      const now = 10_000_000;
      const series = makeSeries(SYMBOL, "1m", 60_000, 20, now);
      const data = new Map<string, Candle[]>();
      data.set(`${SYMBOL}:1m`, series);
      data.set(`${SYMBOL}:3m`, makeSeries(SYMBOL, "3m", 180_000, 5, now));
      data.set(`${SYMBOL}:5m`, makeSeries(SYMBOL, "5m", 300_000, 5, now));
      const deps = freshDeps();
      await bootstrapCandleAndDirectionalAtrFromRest(fakeRest(data), deps, [
        SYMBOL,
      ]);
      const before = deps.candleStore.getClosed(SYMBOL, "1m").length;
      const downBefore = deps.directionalAtr1m.getDownAtr(SYMBOL);
      const nextLive = mkCandle(
        SYMBOL,
        "1m",
        series[series.length - 1]!.openTime + 60_000,
        60_000,
        100,
        101,
        99,
        100.7,
      );
      deps.candleStore.ingest(nextLive);
      deps.directionalAtr1m.onCandle(nextLive);
      assert.strictEqual(
        deps.candleStore.getClosed(SYMBOL, "1m").length,
        before + 1,
        "a new live candle must extend the store by exactly one, continuing naturally from the bootstrapped history",
      );
      assert.notStrictEqual(
        deps.directionalAtr1m.getDownAtr(SYMBOL),
        downBefore,
        "directional ATR must update from the new live candle, continuing the SAME EMA the bootstrap seeded",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
