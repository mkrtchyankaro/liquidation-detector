import * as assert from "assert";
import {
  buildMinuteTimeline,
  buildLastLiquidationAnchor,
  annotateOiObservations,
  causalPriceAtOrBefore,
  oiAtOrBefore,
  firstOiAtOrAfter,
  type OiObservation,
  type LiquidationEvent,
} from "../src/domain/research/liquidation-oi-inspection";
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

function mkCandle(
  openTime: number,
  o: number,
  h: number,
  l: number,
  c: number,
): Candle {
  return {
    symbol: "BTCUSDT",
    interval: "1m",
    openTime,
    closeTime: openTime + 59_999,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1,
    quoteVolume: 1,
    takerBuyVolume: 1,
    takerBuyQuoteVolume: 1,
    trades: 1,
    isClosed: true,
  };
}
function mkOi(timestamp: number, openInterest: number): OiObservation {
  return {
    symbol: "BTCUSDT",
    timestamp,
    oiUpdatedAtMs: timestamp,
    openInterest,
  };
}
function mkLiq(
  timestamp: number,
  victim: "LONG" | "SHORT",
  price: number,
  quoteQty: number,
): LiquidationEvent {
  return { timestamp, victim, price, quoteQty };
}

function main(): void {
  console.log("Running liquidation-oi-inspection tests...\n");

  scenario(
    "1. minute timeline continues through minutes with ZERO liquidations, all the way to the requested TO",
    () => {
      const from = 0,
        to = 20 * 60_000; // 20 minutes
      const liqs = [mkLiq(90_000, "LONG", 100, 5000)]; // liquidation only in minute 1
      const candles = Array.from({ length: 21 }, (_, i) =>
        mkCandle(i * 60_000, 100, 101, 99, 100 + i * 0.1),
      );
      const oi = Array.from({ length: 21 }, (_, i) =>
        mkOi(i * 60_000 + 500, 1000 - i),
      ); // OI observed every minute, continuously, no liquidations after minute 1
      const timeline = buildMinuteTimeline(from, to, candles, oi, liqs);
      assert.strictEqual(
        timeline.length,
        21,
        "must produce one row per minute across the full requested window, not stop after the last liquidation",
      );
      const minute15 = timeline[15]!;
      assert.strictEqual(
        minute15.longLiqCount,
        0,
        "minute 15 has no liquidations",
      );
      assert.notStrictEqual(
        minute15.priceClose,
        null,
        "price must still be present 14 minutes after the last liquidation",
      );
      assert.notStrictEqual(
        minute15.oiEnd,
        null,
        "OI must still be present 14 minutes after the last liquidation -- this is the whole point of the tool",
      );
    },
  );

  scenario("2. causal price lookup never uses a future candle", () => {
    const candles = [
      mkCandle(0, 100, 101, 99, 100),
      mkCandle(60_000, 100, 101, 99, 105),
      mkCandle(120_000, 105, 106, 104, 110),
    ];
    // exactly at a timestamp between candle 1's close and candle 2's close
    const price = causalPriceAtOrBefore(candles, 90_000);
    assert.strictEqual(
      price,
      100,
      "at t=90000 (inside candle 1's own span, before candle 2 closes), the causal price must be candle 1's close (100), never candle 2's future close (105)",
    );
  });

  scenario(
    "3. oiAtOrBefore / firstOiAtOrAfter never fabricate an observation at the exact target",
    () => {
      const oi = [mkOi(1000, 10), mkOi(5000, 20), mkOi(9000, 30)];
      const before = oiAtOrBefore(oi, 6000);
      assert.strictEqual(
        before?.timestamp,
        5000,
        "must return the REAL observation at 5000, not an interpolated value at 6000",
      );
      const after = firstOiAtOrAfter(oi, 6000);
      assert.strictEqual(
        after?.timestamp,
        9000,
        "must return the REAL observation at 9000, not an interpolated value at 6000",
      );
    },
  );

  scenario(
    "4. last-liquidation anchor uses the first REAL observation at/after each horizon, with true offset reported",
    () => {
      const liq = mkLiq(0, "LONG", 100, 50_000);
      // observations are sparse and irregular -- NOT landing exactly on horizon targets
      const oi = [
        mkOi(-1000, 500),
        mkOi(3, 500),
        mkOi(7_200, 480),
        mkOi(31_500, 470),
        mkOi(65_000, 460),
      ];
      const candles = [
        mkCandle(-60_000, 100, 101, 99, 100),
        mkCandle(0, 100, 102, 99, 101),
        mkCandle(60_000, 101, 103, 100, 102),
      ];
      const anchor = buildLastLiquidationAnchor(liq, oi, candles, 120_000);
      const plus5s = anchor.horizons.find((h) => h.targetOffsetSeconds === 5)!;
      assert.strictEqual(
        plus5s.actualTimestamp,
        7_200,
        "target +5s (5000ms) must resolve to the first REAL observation at or after it (7200ms), never fabricated to land exactly at 5000",
      );
      assert.ok(
        Math.abs(plus5s.actualOffsetSeconds! - 7.2) < 1e-6,
        "actual offset must reflect the true 7.2s gap, not the nominal 5s target",
      );
    },
  );

  scenario(
    "5. horizons beyond the requested TO are marked unavailable, never extrapolated past what was requested",
    () => {
      const liq = mkLiq(0, "LONG", 100, 50_000);
      const oi = [mkOi(0, 500), mkOi(400_000, 400)]; // an observation exists far in the future, but...
      const candles = [mkCandle(0, 100, 101, 99, 100)];
      const anchor = buildLastLiquidationAnchor(liq, oi, candles, 100_000); // ...the requested window only extends to 100_000ms (100s)
      const plus10m = anchor.horizons.find(
        (h) => h.targetOffsetSeconds === 600,
      )!; // +10min = 600_000ms, past the 100_000ms window
      assert.strictEqual(
        plus10m.actualTimestamp,
        null,
        "a horizon past the requested TO must be reported unavailable, never silently reaching past what was requested",
      );
    },
  );

  scenario(
    "6. OI deltas are computed strictly from real consecutive observations, never interpolated across a gap",
    () => {
      const oi = [mkOi(0, 1000), mkOi(1000, 990), mkOi(50_000, 900)]; // a large real gap between the 2nd and 3rd observation
      const candles = [mkCandle(0, 100, 101, 99, 100)];
      const annotated = annotateOiObservations(oi, candles, null);
      assert.strictEqual(
        annotated[2]!.deltaOiFromPrevious,
        900 - 990,
        "delta must be computed directly against the previous REAL observation, however large the real time gap between them -- no interpolation inserted",
      );
      assert.strictEqual(
        annotated[0]!.deltaOiFromPrevious,
        null,
        "the first observation has no previous observation to delta against",
      );
      assert.strictEqual(annotated[2]!.deltaOiFromPeriodStart, 900 - 1000);
    },
  );

  scenario(
    "7. deltaOiFromLastLiquidation is only populated for observations at/after the liquidation, and uses the causal OI at that liquidation",
    () => {
      const oi = [mkOi(0, 1000), mkOi(5000, 950), mkOi(10_000, 920)];
      const candles = [mkCandle(0, 100, 101, 99, 100)];
      const lastLiqTs = 5000;
      const annotated = annotateOiObservations(oi, candles, lastLiqTs);
      assert.strictEqual(
        annotated[0]!.deltaOiFromLastLiquidation,
        null,
        "an observation BEFORE the last liquidation must not have this delta populated",
      );
      assert.strictEqual(
        annotated[1]!.deltaOiFromLastLiquidation,
        0,
        "the observation AT the liquidation itself deltas against itself -- 0",
      );
      assert.strictEqual(annotated[2]!.deltaOiFromLastLiquidation, 920 - 950);
    },
  );

  scenario(
    "8. estimatedOiUsd is explicitly derived (openInterest * causal price), null when no causal price exists, and OI documents' own null price/USD fields are never read",
    () => {
      const oi = [mkOi(70_000, 1000)]; // after the first candle has actually closed (closeTime=59999)
      const candlesPresent = [mkCandle(0, 100, 101, 99, 50)]; // close=50
      const withPrice = annotateOiObservations(oi, candlesPresent, null);
      assert.strictEqual(withPrice[0]!.estimatedOiUsd, 1000 * 50);

      const withoutCandles: Candle[] = [];
      const withoutPrice = annotateOiObservations(oi, withoutCandles, null);
      assert.strictEqual(
        withoutPrice[0]!.estimatedOiUsd,
        null,
        "must be null, not a fabricated value, when no causal price is available",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
