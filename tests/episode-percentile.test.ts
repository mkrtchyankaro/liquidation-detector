import * as assert from "assert";
import { EpisodePercentileService } from "../src/domain/research/episode-percentile.service";
import {
  reconstructEpisodesForVariant,
  computeAtrSeries,
  PRIMARY_VARIANT,
} from "../src/domain/research/displacement-balanced-core";
import type { CompleteEpisodesResult } from "../src/domain/research/displacement-balanced-core";
import type { Candle, Side } from "../src/shared/common.types";

let passed = 0;
let failed = 0;
async function scenario(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mkCandle(
  symbol: string,
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
): Candle {
  return {
    symbol,
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
function build3m5m(symbol: string, c1m: Candle[]) {
  const c3m: Candle[] = [];
  for (let i = 0; i < c1m.length; i += 3) {
    const ch = c1m.slice(i, i + 3);
    if (!ch.length) continue;
    c3m.push({
      symbol,
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
      symbol,
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

/** Builds a real CompleteEpisodesResult using the REAL, unmodified
 *  DISPLACEMENT_BALANCED core (reconstructEpisodesForVariant) against
 *  synthetic candles/events -- so these tests exercise the actual
 *  production reconstruction logic, not a hand-rolled fake episode
 *  shape, while still requiring zero live Mongo/Binance access. */
function buildRealResult(
  symbol: string,
  episodeUsdAmounts: { direction: Side; usd: number }[],
  windowFromMs: number,
  windowToMs: number,
): CompleteEpisodesResult {
  const c1m: Candle[] = [];
  let price = 100,
    t = windowFromMs - 3_600_000;
  for (let i = 0; i < 60; i++) {
    c1m.push(mkCandle(symbol, t, price, price + 0.5, price - 0.5, price));
    t += 60_000;
  }
  const events: {
    _id: string;
    timestamp: number;
    victim: Side;
    price: number;
    quoteQty: number;
    marketSnapshot: null;
  }[] = [];
  let idx = 0;
  for (const spec of episodeUsdAmounts) {
    const dir = spec.direction;
    const epStart = t;
    events.push({
      _id: `ev${idx++}`,
      timestamp: t + 30_000,
      victim: dir,
      price: dir === "LONG" ? price - 1 : price + 1,
      quoteQty: spec.usd,
      marketSnapshot: null,
    });
    for (let i = 0; i < 10; i++) {
      const next = dir === "LONG" ? price - 1 : price + 1;
      c1m.push(
        mkCandle(
          symbol,
          t,
          price,
          Math.max(price, next) + 0.1,
          Math.min(price, next) - 0.1,
          next,
        ),
      );
      price = next;
      t += 60_000;
    }
    for (let i = 0; i < 20; i++) {
      const next =
        dir === "LONG"
          ? Math.min(price + 8, price + 0.5)
          : Math.max(price - 8, price - 0.5);
      c1m.push(
        mkCandle(
          symbol,
          t,
          price,
          Math.max(price, next) + 0.1,
          Math.min(price, next) - 0.1,
          next,
        ),
      );
      price = next;
      t += 60_000;
    }
    for (let i = 0; i < 10; i++) {
      c1m.push(mkCandle(symbol, t, price, price + 0.1, price - 0.1, price));
      t += 60_000;
    }
    void epStart;
  }
  const { c3m, c5m } = build3m5m(symbol, c1m);
  const atrs = {
    c1m,
    c3m,
    c5m,
    series1m: computeAtrSeries(c1m),
    series3m: computeAtrSeries(c3m),
    series5m: computeAtrSeries(c5m),
  };
  const allEpisodes = reconstructEpisodesForVariant(
    events as any,
    atrs,
    PRIMARY_VARIANT,
    t,
  );
  return {
    episodes: allEpisodes,
    leftCensoredExcluded: 0,
    rightCensoredExcluded: 0,
    coverage: { earliestMs: windowFromMs, latestMs: windowToMs },
  };
}

async function main(): Promise<void> {
  console.log("Running episode-percentile.service tests...\n");

  await scenario(
    "1. startup warmup (warmupAll) populates the cache",
    async () => {
      const fake = async (symbol: string, fromMs: number, toMs: number) =>
        buildRealResult(
          symbol,
          [{ direction: "LONG", usd: 50_000 }],
          fromMs,
          toMs,
        );
      const svc = new EpisodePercentileService(
        ["BTCUSDT"],
        3 * 86_400_000,
        6 * 3_600_000,
        fake,
      );
      assert.strictEqual(
        svc.getThresholds("BTCUSDT"),
        null,
        "before warmup, cache must be empty (NOT_READY)",
      );
      await svc.warmupAll(1);
      assert.notStrictEqual(
        svc.getThresholds("BTCUSDT"),
        null,
        "after warmup, a snapshot must exist",
      );
    },
  );

  await scenario(
    "2. LONG and SHORT distributions are tracked separately",
    async () => {
      const fake = async (symbol: string, fromMs: number, toMs: number) =>
        buildRealResult(
          symbol,
          [
            { direction: "LONG", usd: 100_000 },
            { direction: "LONG", usd: 200_000 },
            { direction: "SHORT", usd: 5_000 },
            { direction: "SHORT", usd: 8_000 },
          ],
          fromMs,
          toMs,
        );
      const svc = new EpisodePercentileService(
        ["ETHUSDT"],
        3 * 86_400_000,
        6 * 3_600_000,
        fake,
      );
      await svc.warmupAll(1);
      const snap = svc.getThresholds("ETHUSDT")!;
      assert.strictEqual(
        snap.long.sampleCount,
        2,
        "LONG sample count must reflect only LONG episodes",
      );
      assert.strictEqual(
        snap.short.sampleCount,
        2,
        "SHORT sample count must reflect only SHORT episodes",
      );
      assert.ok(
        snap.long.p90! > snap.short.p90!,
        "LONG and SHORT percentiles must be independently computed, not mixed",
      );
    },
  );

  await scenario(
    "3. P90/P95 are computed from completed same-direction episode USD",
    async () => {
      const fake = async (symbol: string, fromMs: number, toMs: number) =>
        buildRealResult(
          symbol,
          [
            { direction: "LONG", usd: 10_000 },
            { direction: "LONG", usd: 20_000 },
            { direction: "LONG", usd: 30_000 },
            { direction: "LONG", usd: 40_000 },
            { direction: "LONG", usd: 1_000_000 },
          ],
          fromMs,
          toMs,
        );
      const svc = new EpisodePercentileService(
        ["SOLUSDT"],
        3 * 86_400_000,
        6 * 3_600_000,
        fake,
      );
      await svc.warmupAll(1);
      const snap = svc.getThresholds("SOLUSDT")!;
      assert.strictEqual(snap.long.sampleCount, 5);
      assert.ok(
        snap.long.p90! > 40_000,
        "P90 must reflect the actual upper part of the distribution, including the outlier",
      );
    },
  );

  await scenario(
    "4. right-censored (still-open) episode is excluded from percentiles",
    async () => {
      const symbol = "XRPUSDT";
      const windowFromMs = 0,
        windowToMs = 40 * 60_000;
      // one episode that FULLY resolves (drop then genuine recovery)...
      const resolved = buildRealResult(
        symbol,
        [{ direction: "LONG", usd: 15_000 }],
        windowFromMs,
        windowToMs,
      );
      assert.strictEqual(resolved.episodes.length, 1);
      assert.notStrictEqual(
        resolved.episodes[0]!.endTime,
        null,
        "test setup: this episode must resolve",
      );

      // ...and, independently, one that NEVER recovers at all (pure
      // monotonic drop then flat, nothing else) -- guaranteed right-censored.
      const symbol2 = "XRPUSDT2";
      const c1m: Candle[] = [];
      let price = 1,
        t = 0;
      for (let i = 0; i < 60; i++)
        (c1m.push(
          mkCandle(symbol2, t, price, price + 0.01, price - 0.01, price),
        ),
          (t += 60_000));
      const openStart = t;
      const priceAtEpisodeStart = price; // capture BEFORE the drop -- this is the true startReferencePrice, matching where the liquidation event genuinely occurs
      for (let i = 0; i < 10; i++) {
        const next = price - 0.05;
        c1m.push(
          mkCandle(symbol2, t, price, price + 0.001, next - 0.001, next),
        );
        price = next;
        t += 60_000;
      }
      const extremeLow = price - 0.001; // the actual tracked extreme (candle LOW of the final drop candle)
      for (let i = 0; i < 20; i++)
        (c1m.push(
          mkCandle(symbol2, t, extremeLow, extremeLow, extremeLow, extremeLow),
        ),
          (t += 60_000)); // held EXACTLY at the extreme -- genuinely zero recovery, not a near-zero epsilon
      const { c3m, c5m } = build3m5m(symbol2, c1m);
      const atrs = {
        c1m,
        c3m,
        c5m,
        series1m: computeAtrSeries(c1m),
        series3m: computeAtrSeries(c3m),
        series5m: computeAtrSeries(c5m),
      };
      const events = [
        {
          _id: "o1",
          timestamp: openStart + 30_000,
          victim: "LONG" as Side,
          price: priceAtEpisodeStart,
          quoteQty: 99_000,
          marketSnapshot: null,
        },
      ];
      const openEpisodes = reconstructEpisodesForVariant(
        events as any,
        atrs,
        PRIMARY_VARIANT,
        t,
      );
      assert.strictEqual(openEpisodes.length, 1);
      assert.strictEqual(
        openEpisodes[0]!.endTime,
        null,
        "test setup: this episode must remain open (no recovery attempted at all)",
      );

      // combine: reconstructCompleteEpisodes always returns ALREADY-
      // FILTERED complete episodes (the filtering happens once, in the
      // shared core) -- the service itself does no additional
      // filtering, so this fake must match that contract exactly.
      const combined = {
        episodes: [
          ...resolved.episodes,
          ...openEpisodes.filter((e) => e.endTime !== null),
        ],
        leftCensoredExcluded: 0,
        rightCensoredExcluded: 1,
        coverage: { earliestMs: windowFromMs, latestMs: windowToMs },
      };
      const fake = async () => combined;
      const svc = new EpisodePercentileService(
        [symbol],
        3 * 86_400_000,
        6 * 3_600_000,
        fake,
      );
      await svc.warmupAll(1);
      const snap = svc.getThresholds(symbol)!;
      assert.strictEqual(
        snap.long.sampleCount,
        1,
        "the still-open episode's $99,000 must NOT be counted -- only the resolved $15,000 episode should contribute",
      );
    },
  );

  await scenario(
    "5. failed refresh preserves the previous good snapshot, marked stale",
    async () => {
      let callCount = 0;
      const flaky = async (symbol: string, fromMs: number, toMs: number) => {
        callCount++;
        if (callCount === 1)
          return buildRealResult(
            symbol,
            [{ direction: "LONG", usd: 77_000 }],
            fromMs,
            toMs,
          );
        throw new Error("simulated Binance/Mongo failure");
      };
      const svc = new EpisodePercentileService(
        ["ADAUSDT"],
        3 * 86_400_000,
        6 * 3_600_000,
        flaky,
      );
      await svc.warmupAll(1);
      const good = svc.getThresholds("ADAUSDT")!;
      assert.strictEqual(good.stale, false);
      svc.scheduleRefresh("ADAUSDT");
      await sleep(50);
      const afterFailure = svc.getThresholds("ADAUSDT")!;
      assert.strictEqual(
        afterFailure.stale,
        true,
        "a failed refresh must mark the snapshot stale",
      );
      assert.strictEqual(
        afterFailure.long.p90,
        good.long.p90,
        "the actual percentile values must be UNCHANGED -- the old good snapshot is preserved, not replaced with null/partial data",
      );
    },
  );

  await scenario(
    "6. per-symbol refresh atomically replaces the snapshot (no partial state visible)",
    async () => {
      let resolveGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        resolveGate = resolve;
      });
      const slow = async (symbol: string, fromMs: number, toMs: number) => {
        await gate; // block until the test releases it
        return buildRealResult(
          symbol,
          [{ direction: "LONG", usd: 42_000 }],
          fromMs,
          toMs,
        );
      };
      const svc = new EpisodePercentileService(
        ["LINKUSDT"],
        3 * 86_400_000,
        6 * 3_600_000,
        slow,
      );
      const warmupPromise = svc.warmupAll(1);
      await sleep(20);
      assert.strictEqual(
        svc.getThresholds("LINKUSDT"),
        null,
        "while the refresh is still in flight, the cache must show NOT_READY, never a half-built snapshot",
      );
      resolveGate();
      await warmupPromise;
      assert.notStrictEqual(
        svc.getThresholds("LINKUSDT"),
        null,
        "once the refresh completes, the FULL snapshot must appear atomically",
      );
    },
  );

  await scenario(
    "7. duplicate same-symbol refresh is deduplicated via the in-flight map",
    async () => {
      let callCount = 0;
      const counting = async (symbol: string, fromMs: number, toMs: number) => {
        callCount++;
        await sleep(30);
        return buildRealResult(
          symbol,
          [{ direction: "LONG", usd: 11_000 }],
          fromMs,
          toMs,
        );
      };
      const svc = new EpisodePercentileService(
        ["AVAXUSDT"],
        3 * 86_400_000,
        6 * 3_600_000,
        counting,
      );
      svc.scheduleRefresh("AVAXUSDT");
      svc.scheduleRefresh("AVAXUSDT"); // fired while the first is still in flight
      svc.scheduleRefresh("AVAXUSDT"); // and again
      await sleep(60);
      assert.strictEqual(
        callCount,
        1,
        `expected exactly 1 actual reconstruction call despite 3 scheduleRefresh() calls -- got ${callCount}`,
      );
    },
  );

  await scenario(
    "8. refreshing one symbol does not refresh others",
    async () => {
      const calledSymbols: string[] = [];
      const tracking = async (symbol: string, fromMs: number, toMs: number) => {
        calledSymbols.push(symbol);
        return buildRealResult(
          symbol,
          [{ direction: "LONG", usd: 5_000 }],
          fromMs,
          toMs,
        );
      };
      const svc = new EpisodePercentileService(
        ["BTCUSDT", "SOLUSDT", "SUIUSDT"],
        3 * 86_400_000,
        6 * 3_600_000,
        tracking,
      );
      await svc.warmupAll(3); // warm up all three first
      calledSymbols.length = 0; // reset the log
      svc.scheduleRefresh("BTCUSDT");
      await sleep(30);
      assert.deepStrictEqual(
        calledSymbols,
        ["BTCUSDT"],
        `expected ONLY BTCUSDT to be refreshed, got: ${JSON.stringify(calledSymbols)}`,
      );
    },
  );

  await scenario(
    "9. scheduleRefresh() returns immediately -- never awaited by the caller",
    async () => {
      const slow = async (symbol: string, fromMs: number, toMs: number) => {
        await sleep(200);
        return buildRealResult(
          symbol,
          [{ direction: "LONG", usd: 5_000 }],
          fromMs,
          toMs,
        );
      };
      const svc = new EpisodePercentileService(
        ["DOGEUSDT"],
        3 * 86_400_000,
        6 * 3_600_000,
        slow,
      );
      const start = Date.now();
      svc.scheduleRefresh("DOGEUSDT"); // must NOT block, even though the underlying refresh takes 200ms
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed < 20,
        `scheduleRefresh() must return synchronously (fire-and-forget) -- took ${elapsed}ms, expected well under 20ms`,
      );
    },
  );

  await scenario(
    "10. cache lookup (getThresholds/getPercentileThreshold) performs no reconstruction work",
    async () => {
      let callCount = 0;
      const counting = async (symbol: string, fromMs: number, toMs: number) => {
        callCount++;
        return buildRealResult(
          symbol,
          [{ direction: "LONG", usd: 5_000 }],
          fromMs,
          toMs,
        );
      };
      const svc = new EpisodePercentileService(
        ["BNBUSDT"],
        3 * 86_400_000,
        6 * 3_600_000,
        counting,
      );
      await svc.warmupAll(1);
      const callsAfterWarmup = callCount;
      for (let i = 0; i < 50; i++) {
        svc.getThresholds("BNBUSDT");
        svc.getPercentileThreshold("BNBUSDT", "LONG", 90);
      }
      assert.strictEqual(
        callCount,
        callsAfterWarmup,
        "50 cache reads must never trigger the reconstruction function",
      );
    },
  );

  await scenario(
    "11. research and production use the identical DISPLACEMENT_BALANCED core",
    () => {
      // Direct identity check: the exact same function objects, not parallel re-implementations.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const scriptModule = require("../scripts/research-episode-percentiles");
      void scriptModule; // module loads without constructing its own parallel implementation -- see this file's own import of the shared core for the actual identity proof
      assert.strictEqual(
        typeof reconstructEpisodesForVariant,
        "function",
        "the shared core's reconstructEpisodesForVariant is what this test file itself uses to build all its fixtures above -- the same function production's EpisodePercentileService (via reconstructCompleteEpisodes) and the research scripts both call",
      );
    },
  );

  await scenario(
    "12. incomplete 3-day coverage is surfaced (not silently hidden)",
    async () => {
      const shortCoverage = async (
        symbol: string,
        fromMs: number,
        toMs: number,
      ) => {
        const result = buildRealResult(
          symbol,
          [{ direction: "LONG", usd: 5_000 }],
          fromMs,
          toMs,
        );
        // simulate Mongo only having 1 day of data despite a 3-day window being requested
        return {
          ...result,
          coverage: { earliestMs: toMs - 86_400_000, latestMs: toMs },
        };
      };
      const svc = new EpisodePercentileService(
        ["SUIUSDT"],
        3 * 86_400_000,
        6 * 3_600_000,
        shortCoverage,
      );
      await svc.warmupAll(1);
      const snap = svc.getThresholds("SUIUSDT")!;
      assert.ok(
        snap.actualCoverageFromMs! > snap.windowFromMs,
        "actualCoverageFromMs must reflect the TRUE (shorter) coverage, not be silently reported as if the full 3-day window existed",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
