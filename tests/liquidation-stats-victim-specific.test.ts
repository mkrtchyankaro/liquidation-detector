/**
 * Sep 9 2026 (Karo), operator-requested victim-side-specific P95 +
 * liqBaseline, with safe fallback to the EXISTING combined LONG+SHORT
 * regime whenever victim-specific data is insufficient (< the same
 * minSamplesForPercentiles=30 threshold, consistently, for BOTH
 * metrics -- see notionalPercentileForVictim()/
 * rollingMedianLiqNotionalPerMinForVictim()'s own doc comments in
 * liquidation-stats.service.ts for the exact consistency guarantee).
 */
import * as assert from "assert";
import { LiquidationStatsService } from "../src/domain/liquidation/liquidation-stats.service";
import { loadObservabilityConfig } from "../src/infrastructure/config/observability.config";
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

/** Feeds `count` LONG-victim (side="SELL") events of `notional` each,
 *  each in its OWN sealed 1-minute bucket (so bucketsLong[] also
 *  accumulates real history, not just notionalSamplesLong[]). */
function feedLong(
  stats: LiquidationStatsService,
  symbol: string,
  count: number,
  notional: number,
  startTs: number,
): void {
  for (let i = 0; i < count; i++) {
    stats.ingest(liq(symbol, "SELL", 100, notional, startTs + i * 60_000));
  }
}
function feedShort(
  stats: LiquidationStatsService,
  symbol: string,
  count: number,
  notional: number,
  startTs: number,
): void {
  for (let i = 0; i < count; i++) {
    stats.ingest(liq(symbol, "BUY", 100, notional, startTs + i * 60_000));
  }
}

console.log("Running victim-side-specific P95/liqBaseline tests...\n");

scenario(
  "1. Enough LONG samples -> LONG-specific P95 + LONG-specific baseline (isVictimSpecific=true)",
  () => {
    const stats = new LiquidationStatsService(loadObservabilityConfig());
    feedLong(stats, "ETHUSDT", 35, 500, 0); // 35 >= minSamplesForPercentiles(30)

    const p95 = stats.notionalPercentileForVictim("ETHUSDT", "LONG", 95);
    assert.strictEqual(p95.isVictimSpecific, true);
    assert.ok(p95.value > 0);

    const baseline = stats.rollingMedianLiqNotionalPerMinForVictim(
      "ETHUSDT",
      "LONG",
      60,
    );
    assert.strictEqual(baseline.isVictimSpecific, true);
    assert.strictEqual(baseline.value, 500); // every bucket has exactly one $500 LONG event
  },
);

scenario(
  "2. Enough SHORT samples -> SHORT-specific P95 + SHORT-specific baseline (isVictimSpecific=true)",
  () => {
    const stats = new LiquidationStatsService(loadObservabilityConfig());
    feedShort(stats, "ETHUSDT", 35, 300, 0);

    const p95 = stats.notionalPercentileForVictim("ETHUSDT", "SHORT", 95);
    assert.strictEqual(p95.isVictimSpecific, true);
    assert.ok(p95.value > 0);

    const baseline = stats.rollingMedianLiqNotionalPerMinForVictim(
      "ETHUSDT",
      "SHORT",
      60,
    );
    assert.strictEqual(baseline.isVictimSpecific, true);
    assert.strictEqual(baseline.value, 300);
  },
);

scenario(
  "3. Insufficient victim samples -> BOTH P95 and baseline fall back to the existing combined regime (isVictimSpecific=false)",
  () => {
    const stats = new LiquidationStatsService(loadObservabilityConfig());
    feedLong(stats, "ETHUSDT", 5, 500, 0); // well under 30 -- insufficient
    feedShort(stats, "ETHUSDT", 40, 200, 0); // SHORT side IS sufficient, but we're checking LONG here

    const p95 = stats.notionalPercentileForVictim("ETHUSDT", "LONG", 95);
    assert.strictEqual(
      p95.isVictimSpecific,
      false,
      "LONG has only 5 samples -- must fall back",
    );

    const baseline = stats.rollingMedianLiqNotionalPerMinForVictim(
      "ETHUSDT",
      "LONG",
      60,
    );
    assert.strictEqual(
      baseline.isVictimSpecific,
      false,
      "consistency: baseline must fall back exactly when P95 does, for the SAME (symbol, victim)",
    );

    // The fallback value must match the EXISTING, unchanged combined methods exactly.
    const combinedP95 = stats.notionalPercentile("ETHUSDT", "LONG", 95);
    const combinedBaseline = stats.rollingMedianLiqNotionalPerMin(
      "ETHUSDT",
      60,
    );
    assert.strictEqual(p95.value, combinedP95);
    assert.strictEqual(baseline.value, combinedBaseline);
  },
);

scenario(
  "4. A large OPPOSITE-victim distribution does not distort victim-specific P95/baseline once sufficient victim data exists",
  () => {
    const stats = new LiquidationStatsService(loadObservabilityConfig());
    // Both victims active in the SAME 35 minutes (realistic market activity --
    // NOT disjoint time-ranges, which would artificially zero-pad bucketsLong
    // during the minutes only SHORT was active, distorting the median).
    for (let i = 0; i < 35; i++) {
      const t = i * 60_000;
      stats.ingest(liq("ETHUSDT", "SELL", 100, 400, t)); // LONG victim, modest
      stats.ingest(liq("ETHUSDT", "BUY", 100, 50_000, t + 1000)); // SHORT victim, enormous, same minute
    }

    const longP95 = stats.notionalPercentileForVictim("ETHUSDT", "LONG", 95);
    assert.strictEqual(longP95.isVictimSpecific, true);
    assert.strictEqual(
      longP95.value,
      400,
      "the enormous SHORT-side distribution must have ZERO effect on the LONG-specific P95",
    );

    const longBaseline = stats.rollingMedianLiqNotionalPerMinForVictim(
      "ETHUSDT",
      "LONG",
      60,
    );
    assert.strictEqual(longBaseline.isVictimSpecific, true);
    assert.strictEqual(
      longBaseline.value,
      400,
      "the enormous SHORT-side distribution must have ZERO effect on the LONG-specific baseline",
    );

    // Sanity: the OLD combined methods, by contrast, WOULD be dominated by the SHORT-side outlier.
    const combinedP95 = stats.notionalPercentile("ETHUSDT", "LONG", 95);
    assert.ok(
      combinedP95 > 400,
      "confirms the combined (old) regime IS affected by the opposite side -- the victim-specific fix is the meaningful difference",
    );
  },
);

scenario(
  "5a. Existing cascade qualification (v5-wave.service.ts) is structurally unchanged -- only the SOURCE of P95/baseline values changed, never the 1xUNIT/min-2-events/hasP95Event logic itself",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/strategy/v5/v5-wave.service.ts"),
      "utf8",
    );
    assert.ok(
      source.includes("cascade.liqEvents > 1"),
      "min-2-events rule must remain exactly as implemented",
    );
    assert.ok(
      source.includes("recoveryDistance < watch.unitAtStart"),
      "1xUNIT recovery-completion check must remain exactly as implemented",
    );
    assert.ok(
      source.includes("watch.hasP95Event"),
      "hasP95Event latch-and-gate must remain exactly as implemented",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
