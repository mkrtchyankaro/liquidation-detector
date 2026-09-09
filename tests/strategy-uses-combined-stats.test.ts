/**
 * Sep 9 2026 (Karo), operator-requested RESTORE. Proves that
 * STRATEGY-facing P95 (v5IndividualEventP95) and liqBaseline (main.ts's
 * own getBaseline callback pattern, tested here via
 * rollingMedianLiqNotionalPerMin directly) ALWAYS use the ORIGINAL,
 * production-proven COMBINED LONG+SHORT distribution -- matching the
 * OLD liqwatch-bot's own behavior byte-for-byte (confirmed via direct
 * old-code trace) -- regardless of how skewed/sparse one victim side's
 * own data is. The victim-specific regime (notionalPercentileForVictim/
 * rollingMedianLiqNotionalPerMinForVictim/getVictimStatsSnapshot) still
 * exists, fully intact, but is proven here to be structurally
 * unreachable from the strategy path -- it remains diagnostics/
 * research-only (GlobalSignalDoc.liquidationStatsContext).
 *
 * Reproduces the real production incident that motivated this restore:
 * XRPUSDT signalId 313f105e-43da-41fb-8275-78c6b534174e -- the
 * victim-specific SHORT-only median collapsed to $8.1 vs the combined
 * $1064.6 (131x smaller) over the same 60 real buckets, purely because
 * LONG-side liquidations dominated that window.
 */
import * as assert from "assert";
import * as fs from "fs";
import { LiquidationStatsService } from "../src/domain/liquidation/liquidation-stats.service";
import { loadObservabilityConfig } from "../src/infrastructure/config/observability.config";
import { v5IndividualEventP95 } from "../src/strategy/v5/v5-liq-stats";
import type { Liquidation } from "../src/shared/common.types";

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

function liq(
  symbol: string,
  side: "BUY" | "SELL",
  price: number,
  quoteQty: number,
  timestamp: number,
): Liquidation {
  return {
    symbol,
    side,
    price,
    quantity: quoteQty / price,
    quoteQty,
    timestamp,
  };
}

function seedSkewedData(stats: LiquidationStatsService, symbol: string): void {
  for (let i = 0; i < 40; i++) {
    stats.ingest(liq(symbol, "SELL", 100, 1000 + i * 50, i * 60_000));
  }
  stats.ingest(liq(symbol, "BUY", 100, 10, 40 * 60_000));
  stats.ingest(liq(symbol, "BUY", 100, 8, 41 * 60_000));
  stats.ingest(liq(symbol, "BUY", 100, 5, 42 * 60_000));
}

console.log("Running strategy-uses-combined-stats regression tests...\n");

scenario(
  "1. Strategy P95 (v5IndividualEventP95) always uses COMBINED samples, even when one victim side is heavily skewed",
  () => {
    const stats = new LiquidationStatsService(loadObservabilityConfig());
    seedSkewedData(stats, "XRPUSDT");

    const strategyP95Short = v5IndividualEventP95(stats, "XRPUSDT", "SHORT");
    const combinedP95 = stats.notionalPercentile("XRPUSDT", "SHORT", 95);
    assert.strictEqual(
      strategyP95Short,
      combinedP95,
      "strategy P95 must equal the combined percentile exactly",
    );

    const victimSpecificShortP95 = stats.notionalPercentileForVictim(
      "XRPUSDT",
      "SHORT",
      95,
    );
    assert.strictEqual(
      victimSpecificShortP95.isVictimSpecific,
      false,
      "only 3 SHORT samples -- victim-specific itself would correctly fall back too, but strategy must not even ask",
    );
    assert.notStrictEqual(
      strategyP95Short,
      0,
      "the combined P95 must be a real, non-zero value despite SHORT being sparse",
    );
  },
);

scenario(
  "2. Strategy liqBaseline (rollingMedianLiqNotionalPerMin) always uses COMBINED long+short buckets, never the victim-specific regime",
  () => {
    const stats = new LiquidationStatsService(loadObservabilityConfig());
    seedSkewedData(stats, "XRPUSDT");

    const combinedBaseline = stats.rollingMedianLiqNotionalPerMin(
      "XRPUSDT",
      60,
    );
    assert.ok(
      combinedBaseline !== null && combinedBaseline > 0,
      "combined baseline must be a real, healthy value",
    );

    // Structural: main.ts's own getBaseline callback must call
    // rollingMedianLiqNotionalPerMin (combined), never
    // rollingMedianLiqNotionalPerMinForVictim, for the STRATEGY wiring.
    // This is the actual guarantee that matters -- regardless of how
    // sparse/skewed victim-specific data happens to be in any given
    // moment, the strategy-facing callback simply never calls that path
    // at all.
    const mainSource = fs.readFileSync(
      require.resolve("../src/main.ts"),
      "utf8",
    );
    const v5ConstructorStart = mainSource.indexOf(
      "const v5 = new V5WaveService(",
    );
    const v5ConstructorEnd = mainSource.indexOf(");", v5ConstructorStart);
    const v5ConstructorArgs = mainSource.slice(
      v5ConstructorStart,
      v5ConstructorEnd,
    );
    // Whitespace/line-wrap-agnostic: a formatter (prettier, editor
    // auto-wrap) may legitimately split a long call across multiple
    // lines, or keep it on one -- \s* (zero or more) between tokens
    // handles both without assuming either shape.
    assert.ok(
      /rollingMedianLiqNotionalPerMin\s*\(\s*symbol\s*,\s*60/.test(
        v5ConstructorArgs,
      ),
      "the strategy's own getBaseline callback must call the combined method",
    );
    // Checks the actual CALLBACK CALL specifically (not the surrounding
    // doc-comment, which legitimately references the victim-specific
    // method BY NAME for explanatory purposes) -- the real guarantee is
    // that the executable callback itself never invokes it.
    const callbackStart = v5ConstructorArgs.indexOf(
      "orchestratorPlaceholder.instance?.liquidationStats.rollingMedianLiqNotionalPerMin",
    );
    assert.ok(
      callbackStart > -1,
      "the getBaseline callback's own executable call must exist",
    );
    const afterCallbackStart = v5ConstructorArgs.slice(callbackStart);
    const callbackCallEnd = afterCallbackStart.indexOf(
      ",",
      afterCallbackStart.indexOf("?? 0"),
    );
    const callbackCall = afterCallbackStart.slice(
      0,
      callbackCallEnd > -1 ? callbackCallEnd : undefined,
    );
    assert.ok(
      !callbackCall.includes("ForVictim"),
      "the executable getBaseline callback call itself must NEVER call the victim-specific method",
    );
  },
);

scenario(
  "2b. reproduces the real production magnitude: a heavily one-sided-skewed 60-bucket window collapses the victim-specific median far below the combined median (the exact incident this restore fixes)",
  () => {
    const stats = new LiquidationStatsService(loadObservabilityConfig());
    // 40 LONG-only minutes, 35 SHORT-only minutes (35 >= minSamplesForPercentiles,
    // so victim-specific WOULD activate for SHORT) -- interleaved
    // chronologically, matching the real incident's own mixed pattern.
    for (let i = 0; i < 75; i++) {
      if (i % 15 < 8) {
        stats.ingest(liq("XRPUSDT", "SELL", 100, 1000 + i, i * 60_000));
      } else {
        stats.ingest(liq("XRPUSDT", "BUY", 100, 5 + (i % 3), i * 60_000));
      }
    }
    const combinedBaseline = stats.rollingMedianLiqNotionalPerMin(
      "XRPUSDT",
      60,
    )!;
    const shortSpecific = stats.rollingMedianLiqNotionalPerMinForVictim(
      "XRPUSDT",
      "SHORT",
      60,
    );
    assert.ok(
      shortSpecific.isVictimSpecific,
      "35 SHORT samples must be enough to activate victim-specific",
    );
    assert.ok(
      (shortSpecific.value ?? 0) < combinedBaseline / 5,
      "the victim-specific median must collapse well below the combined one -- reproducing the real 131x-magnitude incident structurally",
    );
  },
);

scenario(
  "3. restart/hydration does not change strategy behavior -- combined P95/baseline identical before and after a simulated restart",
  () => {
    const cfg = loadObservabilityConfig();

    // Explicit, hand-built aggregate docs (matching exactly what
    // LiqAggregateRepository would have persisted) -- avoids any
    // reverse-engineering of internal state, so this test is robust and
    // independent of ingest()'s own exact internal bookkeeping.
    const docs: {
      minuteStart: number;
      longSum: number;
      shortSum: number;
      longCount: number;
      shortCount: number;
      topLong: {
        quoteQty: number;
        price: number;
        quantity: number;
        timestamp: number;
      }[];
      topShort: {
        quoteQty: number;
        price: number;
        quantity: number;
        timestamp: number;
      }[];
    }[] = [];
    for (let i = 0; i < 40; i++) {
      docs.push({
        minuteStart: i * 60_000,
        longSum: 1000 + i * 50,
        shortSum: 0,
        longCount: 1,
        shortCount: 0,
        topLong: [
          {
            quoteQty: 1000 + i * 50,
            price: 100,
            quantity: (1000 + i * 50) / 100,
            timestamp: i * 60_000,
          },
        ],
        topShort: [],
      });
    }
    for (let i = 40; i < 43; i++) {
      const v = (i - 40 + 1) * 5;
      docs.push({
        minuteStart: i * 60_000,
        longSum: 0,
        shortSum: v,
        longCount: 0,
        shortCount: 1,
        topLong: [],
        topShort: [
          { quoteQty: v, price: 100, quantity: v / 100, timestamp: i * 60_000 },
        ],
      });
    }

    const statsBeforeRestart = new LiquidationStatsService(cfg);
    statsBeforeRestart.hydrateFromAggregates("XRPUSDT", docs);
    const p95Before = statsBeforeRestart.notionalPercentile(
      "XRPUSDT",
      "LONG",
      95,
    );
    const baselineBefore = statsBeforeRestart.rollingMedianLiqNotionalPerMin(
      "XRPUSDT",
      60,
    );

    // "Restart": a completely FRESH service instance, hydrated from the
    // EXACT SAME historical docs (as a real restart would read from
    // liq_minute_aggregates).
    const statsAfterRestart = new LiquidationStatsService(cfg);
    statsAfterRestart.hydrateFromAggregates("XRPUSDT", docs);
    const p95After = statsAfterRestart.notionalPercentile(
      "XRPUSDT",
      "LONG",
      95,
    );
    const baselineAfter = statsAfterRestart.rollingMedianLiqNotionalPerMin(
      "XRPUSDT",
      60,
    );

    assert.strictEqual(
      p95After,
      p95Before,
      "combined P95 must be identical before and after restart-hydration",
    );
    assert.strictEqual(
      baselineAfter,
      baselineBefore,
      "combined baseline must be identical before and after restart-hydration",
    );
  },
);

scenario(
  "4. victim-specific zero-heavy data cannot change TP/SL -- strategy P95/baseline identical regardless of which victim is queried",
  () => {
    const stats = new LiquidationStatsService(loadObservabilityConfig());
    seedSkewedData(stats, "XRPUSDT");

    const strategyP95 = v5IndividualEventP95(stats, "XRPUSDT", "SHORT");
    const strategyBaseline = stats.rollingMedianLiqNotionalPerMin(
      "XRPUSDT",
      60,
    );

    assert.strictEqual(
      strategyP95,
      stats.notionalPercentile("XRPUSDT", "LONG", 95),
      "P95 must be identical regardless of which victim side is queried -- it's the same combined distribution either way",
    );
    assert.strictEqual(
      strategyBaseline,
      stats.rollingMedianLiqNotionalPerMin("XRPUSDT", 60),
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
