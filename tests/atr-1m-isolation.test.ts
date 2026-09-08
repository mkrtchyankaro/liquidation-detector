/**
 * Sep 8 2026 (Karo). Proves "1m candles are received without altering
 * ATR15m semantics" directly against ATRTrackerService itself --
 * confirms (a) 15m ATR is computed identically whether or not 1m
 * candles are ALSO fed into the same tracker instance, and (b)
 * ATRTrackerService never tracks "1m" as its own interval at all
 * (isTracked() only accepts 5m/15m/1h, unmodified by this project's
 * new research-data layer).
 */
import * as assert from "assert";
import { ATRTrackerService } from "../src/domain/market/atr-tracker.service";
import type { Candle } from "../src/shared/common.types";

let passed = 0;
let failed = 0;

function scenario(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function make15mCandle(
  i: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return {
    symbol: "ETHUSDT",
    interval: "15m",
    openTime: i * 900_000,
    closeTime: i * 900_000 + 900_000,
    open: close,
    high,
    low,
    close,
    volume: 100,
    quoteVolume: 100 * close,
    takerBuyVolume: 50,
    takerBuyQuoteVolume: 50 * close,
    isClosed: true,
  } as Candle;
}

function make1mCandle(i: number, price: number): Candle {
  return {
    symbol: "ETHUSDT",
    interval: "1m",
    openTime: i * 60_000,
    closeTime: i * 60_000 + 60_000,
    open: price,
    high: price + 500, // deliberately WILD range -- if this ever leaked into 15m ATR, the test below would catch it
    low: price - 500,
    close: price,
    volume: 10,
    quoteVolume: 10 * price,
    takerBuyVolume: 5,
    takerBuyQuoteVolume: 5 * price,
    isClosed: true,
  } as Candle;
}

console.log("Running 1m/ATR15m isolation tests...\n");

scenario(
  "1m candles are silently ignored by ATRTrackerService -- getATR('1m') is always null, never tracked",
  () => {
    const atr = new ATRTrackerService();
    for (let i = 0; i < 10; i++) atr.onCandle(make1mCandle(i, 2465 + i));
    assert.strictEqual(atr.getATR("ETHUSDT", "1m"), null);
  },
);

scenario(
  "15m ATR is IDENTICAL whether or not 1m candles are ALSO fed into the same tracker",
  () => {
    const atrWithout1m = new ATRTrackerService();
    const atrWith1m = new ATRTrackerService();

    const candles15m = [
      make15mCandle(0, 2470, 2460, 2465),
      make15mCandle(1, 2480, 2468, 2475),
      make15mCandle(2, 2490, 2470, 2485),
      make15mCandle(3, 2500, 2478, 2495),
    ];

    for (const c of candles15m) atrWithout1m.onCandle(c);

    // Same 15m candles, PLUS a flood of wildly-different-range 1m
    // candles interleaved -- if 1m data ever leaked into the 15m ATR
    // state, this run's own value would diverge from the "without 1m"
    // run above.
    for (let i = 0; i < 20; i++) atrWith1m.onCandle(make1mCandle(i, 2465 + i));
    for (const c of candles15m) atrWith1m.onCandle(c);
    for (let i = 20; i < 40; i++) atrWith1m.onCandle(make1mCandle(i, 2465 + i));

    const atrValueWithout = atrWithout1m.getATR("ETHUSDT", "15m");
    const atrValueWith = atrWith1m.getATR("ETHUSDT", "15m");

    assert.ok(
      atrValueWithout !== null,
      "expected a non-null 15m ATR after 4 closed candles",
    );
    assert.strictEqual(
      atrValueWith,
      atrValueWithout,
      "15m ATR must be byte-identical regardless of any 1m candles also being fed in",
    );
  },
);

scenario(
  "un-closed candles (isClosed=false) of any interval, including 1m, are still ignored -- pre-existing behavior, unaffected by this change",
  () => {
    const atr = new ATRTrackerService();
    const openCandle = {
      ...make15mCandle(0, 2470, 2460, 2465),
      isClosed: false,
    } as Candle;
    atr.onCandle(openCandle);
    assert.strictEqual(atr.getATR("ETHUSDT", "15m"), null);
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
