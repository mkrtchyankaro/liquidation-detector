import * as assert from "assert";
import {
  reconstructEpisodesForVariant,
  computeAtrSeries,
  PRIMARY_VARIANT,
} from "../src/domain/research/displacement-balanced-core";
import {
  extractOiTrajectory,
  closestWaypoint,
} from "../src/domain/research/episode-oi-trajectory";
import {
  computeCausalHistoricalPercentile,
  type CompletedEpisodeRef,
} from "../src/domain/research/episode-historical-percentile";
import type { Candle, Side } from "../src/shared/common.types";

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

const SYMBOL = "BTCUSDT";
function mkCandle(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
): Candle {
  return {
    symbol: SYMBOL,
    interval: "1m",
    openTime: t,
    closeTime: t + 59999,
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
function build3m5m(c1m: Candle[]) {
  const c3m: Candle[] = [];
  for (let i = 0; i < c1m.length; i += 3) {
    const ch = c1m.slice(i, i + 3);
    if (!ch.length) continue;
    c3m.push({
      symbol: SYMBOL,
      interval: "3m",
      openTime: ch[0]!.openTime,
      closeTime: ch[ch.length - 1]!.closeTime,
      open: ch[0]!.open,
      close: ch[ch.length - 1]!.close,
      high: Math.max(...ch.map((c) => c.high)),
      low: Math.min(...ch.map((c) => c.low)),
      volume: 1,
      quoteVolume: 1,
      takerBuyVolume: 1,
      takerBuyQuoteVolume: 1,
      trades: 1,
      isClosed: true,
    });
  }
  const c5m: Candle[] = [];
  for (let i = 0; i < c1m.length; i += 5) {
    const ch = c1m.slice(i, i + 5);
    if (!ch.length) continue;
    c5m.push({
      symbol: SYMBOL,
      interval: "5m",
      openTime: ch[0]!.openTime,
      closeTime: ch[ch.length - 1]!.closeTime,
      open: ch[0]!.open,
      close: ch[ch.length - 1]!.close,
      high: Math.max(...ch.map((c) => c.high)),
      low: Math.min(...ch.map((c) => c.low)),
      volume: 1,
      quoteVolume: 1,
      takerBuyVolume: 1,
      takerBuyQuoteVolume: 1,
      trades: 1,
      isClosed: true,
    });
  }
  return { c3m, c5m };
}

/** Builds one genuine, confirmed LONG episode (drop then recovery),
 *  with a realistic OI-bearing marketSnapshot on each event, followed
 *  by a controllable amount of extra candles/events AFTER the
 *  episode's own END -- used to test that nothing this pipeline
 *  computes as a "causal feature" is affected by what comes after. */
function buildScenario(extraEventsAfterEndUsd: number[]) {
  const c1m: Candle[] = [];
  let price = 100,
    t = 0;
  for (let i = 0; i < 60; i++) {
    c1m.push(mkCandle(t, price, price + 0.5, price - 0.5, price));
    t += 60_000;
  }
  const dropStart = t;
  for (let i = 0; i < 10; i++) {
    const next = price - 1;
    c1m.push(mkCandle(t, price, price + 0.1, next - 0.1, next));
    price = next;
    t += 60_000;
  }
  for (let i = 0; i < 20; i++) {
    const next = Math.min(price + 8, price + 0.5);
    c1m.push(mkCandle(t, price, next + 0.1, price - 0.1, next));
    price = next;
    t += 60_000;
  }
  const events: any[] = [
    {
      _id: "e1",
      timestamp: dropStart + 30_000,
      victim: "LONG" as Side,
      price: 99,
      quoteQty: 50_000,
      marketSnapshot: {
        openInterest: {
          openInterest: 1000,
          openInterestUsd: 100_000_000,
          oiDelta5sPct: -0.01,
          oiDelta10sPct: -0.02,
          oiDelta15sPct: -0.03,
          oiDelta30sPct: -0.05,
          oiDelta1mPct: -0.08,
          oiDelta2mPct: -0.1,
          oiDelta3mPct: -0.12,
          oiDelta5mPct: -0.15,
          oiDelta10mPct: -0.18,
          oiVelocity10sPctPerSec: -0.001,
          oiVelocity30sPctPerSec: -0.0009,
          oiVelocity1mPctPerSec: -0.0008,
          oiAccelerationPctPerSecSq: -0.00001,
          oiAgeMs: 0,
        },
      },
    },
    {
      _id: "e2",
      timestamp: dropStart + 300_000,
      victim: "LONG" as Side,
      price: 92,
      quoteQty: 70_000,
      marketSnapshot: {
        openInterest: {
          openInterest: 980,
          openInterestUsd: 90_000_000,
          oiDelta5sPct: 0.01,
          oiDelta10sPct: 0.02,
          oiDelta15sPct: 0.01,
          oiDelta30sPct: -0.01,
          oiDelta1mPct: -0.05,
          oiDelta2mPct: -0.07,
          oiDelta3mPct: -0.09,
          oiDelta5mPct: -0.11,
          oiDelta10mPct: -0.14,
          oiVelocity10sPctPerSec: 0.0002,
          oiVelocity30sPctPerSec: -0.0001,
          oiVelocity1mPctPerSec: -0.0005,
          oiAccelerationPctPerSecSq: 0.00002,
          oiAgeMs: 0,
        },
      },
    },
  ];
  for (let i = 0; i < 10; i++) {
    c1m.push(mkCandle(t, price, price + 0.1, price - 0.1, price));
    t += 60_000;
  }
  const trueEndBoundaryT = t;

  // ---- everything below happens AFTER the episode's own END ----
  const extraEvents: any[] = extraEventsAfterEndUsd.map((usd, idx) => ({
    _id: `future${idx}`,
    timestamp: t + 30_000 * (idx + 1),
    victim: "LONG" as Side,
    price: price + idx,
    quoteQty: usd,
    marketSnapshot: {
      openInterest: {
        openInterest: 2000,
        openInterestUsd: 500_000_000,
        oiDelta5sPct: 0,
        oiDelta10sPct: 0,
        oiDelta15sPct: 0,
        oiDelta30sPct: 0,
        oiDelta1mPct: 0,
        oiDelta2mPct: 0,
        oiDelta3mPct: 0,
        oiDelta5mPct: 0,
        oiDelta10mPct: 0,
        oiVelocity10sPctPerSec: 0,
        oiVelocity30sPctPerSec: 0,
        oiVelocity1mPctPerSec: 0,
        oiAccelerationPctPerSecSq: 0,
        oiAgeMs: 0,
      },
    },
  }));
  for (let i = 0; i < 30; i++) {
    c1m.push(mkCandle(t, price, price + 0.3, price - 0.3, price + 0.1));
    t += 60_000;
  }

  const { c3m, c5m } = build3m5m(c1m);
  const atrs = {
    c1m,
    c3m,
    c5m,
    series1m: computeAtrSeries(c1m),
    series3m: computeAtrSeries(c3m),
    series5m: computeAtrSeries(c5m),
  };
  return {
    atrs,
    events: [...events, ...extraEvents],
    trueEndBoundaryT,
    allCandles: c1m,
  };
}

async function main(): Promise<void> {
  console.log("Running episode-research causality tests...\n");

  scenario(
    "1. future-truncation: OI trajectory and episode features are IDENTICAL whether or not future events/candles exist",
    () => {
      const withFuture = buildScenario([9_999_999, 8_888_888]);
      const withoutFuture = buildScenario([]);

      const epWithFuture = reconstructEpisodesForVariant(
        withFuture.events,
        withFuture.atrs,
        PRIMARY_VARIANT,
        withFuture.trueEndBoundaryT + 10_000_000,
      )[0]!;
      const epWithoutFuture = reconstructEpisodesForVariant(
        withoutFuture.events,
        withoutFuture.atrs,
        PRIMARY_VARIANT,
        withoutFuture.trueEndBoundaryT + 10_000_000,
      )[0]!;

      assert.strictEqual(
        epWithFuture.endTime,
        epWithoutFuture.endTime,
        "the episode's own END must not move just because future events/candles exist",
      );
      assert.strictEqual(
        epWithFuture.extremePrice,
        epWithoutFuture.extremePrice,
      );
      assert.strictEqual(
        epWithFuture.sameDirectionEvents.length,
        epWithoutFuture.sameDirectionEvents.length,
        "future liquidation events must never be pulled into THIS episode's own same-direction set",
      );

      const trajWithFuture = extractOiTrajectory(epWithFuture);
      const trajWithoutFuture = extractOiTrajectory(epWithoutFuture);
      assert.strictEqual(
        trajWithFuture.length,
        trajWithoutFuture.length,
        "OI trajectory waypoint count must be identical -- future liquidation events must never appear in an already-closed episode's own trajectory",
      );
      for (let i = 0; i < trajWithFuture.length; i++) {
        assert.strictEqual(
          trajWithFuture[i]!.openInterestUsd,
          trajWithoutFuture[i]!.openInterestUsd,
          `waypoint ${i}'s OI must be identical`,
        );
        assert.strictEqual(
          trajWithFuture[i]!.timestamp,
          trajWithoutFuture[i]!.timestamp,
        );
      }

      const closestWithFuture = closestWaypoint(
        trajWithFuture,
        epWithFuture.endTime!,
      );
      const closestWithoutFuture = closestWaypoint(
        trajWithoutFuture,
        epWithoutFuture.endTime!,
      );
      assert.strictEqual(
        closestWithFuture?.offsetMs,
        closestWithoutFuture?.offsetMs,
        "the closest-to-END waypoint offset must be identical regardless of future data",
      );
    },
  );

  scenario(
    "2. percentile causality: appending enormous FUTURE episodes never changes an earlier episode's own historical percentile context",
    () => {
      const earlyEpisode: CompletedEpisodeRef = {
        symbol: "BTCUSDT",
        direction: "LONG",
        endTime: 1_000_000,
        sameDirectionUsd: 500_000,
      };
      const priorHistory: CompletedEpisodeRef[] = [
        {
          symbol: "BTCUSDT",
          direction: "LONG",
          endTime: 500_000,
          sameDirectionUsd: 100_000,
        },
        {
          symbol: "BTCUSDT",
          direction: "LONG",
          endTime: 700_000,
          sameDirectionUsd: 300_000,
        },
        {
          symbol: "BTCUSDT",
          direction: "LONG",
          endTime: 900_000,
          sameDirectionUsd: 200_000,
        },
      ];

      const before = computeCausalHistoricalPercentile(earlyEpisode, [
        ...priorHistory,
        earlyEpisode,
      ]);

      // append ENORMOUS episodes strictly AFTER earlyEpisode's own endTime
      const futureEnormousEpisodes: CompletedEpisodeRef[] = [
        {
          symbol: "BTCUSDT",
          direction: "LONG",
          endTime: 1_100_000,
          sameDirectionUsd: 999_999_999,
        },
        {
          symbol: "BTCUSDT",
          direction: "LONG",
          endTime: 1_200_000,
          sameDirectionUsd: 888_888_888,
        },
      ];
      const after = computeCausalHistoricalPercentile(earlyEpisode, [
        ...priorHistory,
        earlyEpisode,
        ...futureEnormousEpisodes,
      ]);

      assert.deepStrictEqual(
        before,
        after,
        "appending future episodes (even enormous ones) must NEVER change an earlier episode's own historicalP90/P95/percentileRank -- any difference here is lookahead leakage",
      );
      console.log(`      before=${JSON.stringify(before)}`);
      console.log(`      after =${JSON.stringify(after)}`);
    },
  );

  scenario(
    "3. the episode itself is never included in its own reference distribution",
    () => {
      const target: CompletedEpisodeRef = {
        symbol: "BTCUSDT",
        direction: "SHORT",
        endTime: 1_000_000,
        sameDirectionUsd: 50_000_000,
      }; // deliberately enormous
      const onlyItself = computeCausalHistoricalPercentile(target, [target]);
      assert.strictEqual(
        onlyItself.historicalSampleCount,
        0,
        "with only itself in the dataset, the reference population must be empty (endTime < T excludes itself)",
      );
      assert.strictEqual(
        onlyItself.percentileRank,
        null,
        "percentileRank must be null, never fabricated, when there is no prior history",
      );
      assert.strictEqual(onlyItself.historicalP90, null);
    },
  );

  scenario(
    "4. insufficient prior history yields null fields, never a fabricated threshold",
    () => {
      const target: CompletedEpisodeRef = {
        symbol: "ETHUSDT",
        direction: "LONG",
        endTime: 1_000_000,
        sameDirectionUsd: 10_000,
      };
      const result = computeCausalHistoricalPercentile(target, []);
      assert.strictEqual(result.historicalSampleCount, 0);
      assert.strictEqual(result.historicalP90, null);
      assert.strictEqual(result.historicalP95, null);
      assert.strictEqual(result.percentileRank, null);
    },
  );

  scenario(
    "5. rolling window correctly excludes prior episodes older than the window",
    () => {
      const windowMs = 3 * 86_400_000;
      const target: CompletedEpisodeRef = {
        symbol: "SOLUSDT",
        direction: "SHORT",
        endTime: 10 * 86_400_000,
        sameDirectionUsd: 5_000,
      };
      const tooOld: CompletedEpisodeRef = {
        symbol: "SOLUSDT",
        direction: "SHORT",
        endTime: 10 * 86_400_000 - windowMs - 1,
        sameDirectionUsd: 100_000_000,
      }; // just outside the window, enormous
      const withinWindow: CompletedEpisodeRef = {
        symbol: "SOLUSDT",
        direction: "SHORT",
        endTime: 10 * 86_400_000 - 1000,
        sameDirectionUsd: 3_000,
      };
      const result = computeCausalHistoricalPercentile(
        target,
        [tooOld, withinWindow],
        windowMs,
      );
      assert.strictEqual(
        result.historicalSampleCount,
        1,
        "only the within-window prior episode should count -- the too-old one must be excluded regardless of how large it is",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
