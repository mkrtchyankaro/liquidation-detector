import * as assert from "assert";
import {
  computeOiPhaseChangeUsd,
  computeOiPhaseChangeQuantity,
  computeOiLiquidationRatios,
} from "../src/domain/research/episode-oi-liquidation-ratios";
import type { OiWaypoint } from "../src/domain/research/episode-oi-trajectory";

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

function mkWaypoint(overrides: Partial<OiWaypoint>): OiWaypoint {
  return {
    timestamp: 0,
    side: "LONG",
    liquidationUsd: 0,
    price: 100,
    openInterest: null,
    openInterestUsd: null,
    oiDelta5sPct: null,
    oiDelta10sPct: null,
    oiDelta15sPct: null,
    oiDelta30sPct: null,
    oiDelta1mPct: null,
    oiDelta2mPct: null,
    oiDelta3mPct: null,
    oiDelta5mPct: null,
    oiDelta10mPct: null,
    oiVelocity10sPctPerSec: null,
    oiVelocity30sPctPerSec: null,
    oiVelocity1mPctPerSec: null,
    oiAccelerationPctPerSecSq: null,
    oiAgeMs: null,
    ...overrides,
  };
}

function main(): void {
  console.log("Running episode-oi-liquidation-ratios tests...\n");

  scenario(
    "1. worked example from the operator's own spec: $8M liq, -$6M OI -> ratio -0.75",
    () => {
      const start = mkWaypoint({ openInterestUsd: 100_000_000 });
      const end = mkWaypoint({ openInterestUsd: 94_000_000 });
      const phase = computeOiPhaseChangeUsd(start, null, end);
      assert.strictEqual(phase.oiStartToEndUsd, -6_000_000);
      const ratios = computeOiLiquidationRatios(
        8_000_000,
        phase.oiStartToEndUsd,
      );
      assert.ok(
        Math.abs(ratios.oiNetChangeToLiqRatio! - -0.75) < 1e-9,
        `expected -0.75, got ${ratios.oiNetChangeToLiqRatio}`,
      );
      assert.ok(
        Math.abs(ratios.oiNetChangePer1MLiqUsd! - -750_000) < 1e-6,
        "per-$1M figure must scale correctly",
      );
    },
  );

  scenario(
    "2. worked example: +0.50 expansion ratio, clearing-only ratio floors at 0 on expansion",
    () => {
      const start = mkWaypoint({ openInterestUsd: 100_000_000 });
      const end = mkWaypoint({ openInterestUsd: 104_000_000 });
      const phase = computeOiPhaseChangeUsd(start, null, end);
      const ratios = computeOiLiquidationRatios(
        8_000_000,
        phase.oiStartToEndUsd,
      );
      assert.ok(
        Math.abs(ratios.oiNetChangeToLiqRatio! - 0.5) < 1e-9,
        `expected 0.5, got ${ratios.oiNetChangeToLiqRatio}`,
      );
      assert.strictEqual(
        ratios.oiClearingRatio,
        0,
        "expansion must floor the clearing-only ratio at 0, never negative",
      );
    },
  );

  scenario("3. ratio is NEVER clamped -- magnitude can exceed 1", () => {
    const start = mkWaypoint({ openInterestUsd: 100_000_000 });
    const end = mkWaypoint({ openInterestUsd: 50_000_000 });
    const phase = computeOiPhaseChangeUsd(start, null, end);
    const ratios = computeOiLiquidationRatios(2_000_000, phase.oiStartToEndUsd);
    assert.ok(
      Math.abs(ratios.oiNetChangeToLiqRatio! - -25) < 1e-9,
      `expected -25 (unclamped), got ${ratios.oiNetChangeToLiqRatio}`,
    );
  });

  scenario(
    "4. quantity-based and USD-based changes diverge when price moves but contracts don't",
    () => {
      const start = mkWaypoint({
        openInterest: 1000,
        openInterestUsd: 100_000_000,
      });
      const end = mkWaypoint({
        openInterest: 1000,
        openInterestUsd: 200_000_000,
      });
      const usdPhase = computeOiPhaseChangeUsd(start, null, end);
      const qtyPhase = computeOiPhaseChangeQuantity(start, null, end);
      assert.ok(
        Math.abs(usdPhase.oiStartToEndPct! - 100) < 1e-9,
        "USD-based change must show the full price-driven 100% move",
      );
      assert.strictEqual(
        qtyPhase.oiQuantityStartToEndPct,
        0,
        "quantity-based change must show exactly 0% -- no actual contract-count change occurred, only price revaluation",
      );
    },
  );

  scenario(
    "5. quantity-based change is non-zero when contracts genuinely change, independent of price",
    () => {
      const start = mkWaypoint({
        openInterest: 1000,
        openInterestUsd: 100_000_000,
      });
      const end = mkWaypoint({
        openInterest: 900,
        openInterestUsd: 100_000_000,
      });
      const usdPhase = computeOiPhaseChangeUsd(start, null, end);
      const qtyPhase = computeOiPhaseChangeQuantity(start, null, end);
      assert.strictEqual(
        usdPhase.oiStartToEndPct,
        0,
        "USD change shows nothing since price offset the contract decline exactly",
      );
      assert.ok(
        Math.abs(qtyPhase.oiQuantityStartToEndPct! - -10) < 1e-9,
        "quantity-based change must correctly show the real -10% contract-count decline",
      );
    },
  );

  scenario(
    "6. missing waypoints and non-positive liquidation never fabricate a ratio",
    () => {
      assert.deepStrictEqual(computeOiLiquidationRatios(0, -1000), {
        oiNetChangeToLiqRatio: null,
        oiNetChangePer1MLiqUsd: null,
        oiClearingRatio: null,
      });
      assert.deepStrictEqual(computeOiLiquidationRatios(-500, -1000), {
        oiNetChangeToLiqRatio: null,
        oiNetChangePer1MLiqUsd: null,
        oiClearingRatio: null,
      });
      assert.deepStrictEqual(computeOiLiquidationRatios(1000, null), {
        oiNetChangeToLiqRatio: null,
        oiNetChangePer1MLiqUsd: null,
        oiClearingRatio: null,
      });
      const emptyPhase = computeOiPhaseChangeUsd(null, null, null);
      assert.strictEqual(emptyPhase.oiStartToEndUsd, null);
      assert.strictEqual(emptyPhase.oiStartToEndPct, null);
    },
  );

  scenario(
    "7. START->EXTREME and EXTREME->END are independently computed and sum to START->END",
    () => {
      const start = mkWaypoint({ openInterestUsd: 100_000_000 });
      const extreme = mkWaypoint({ openInterestUsd: 94_000_000 });
      const end = mkWaypoint({ openInterestUsd: 95_800_000 });
      const phase = computeOiPhaseChangeUsd(start, extreme, end);
      assert.ok(Math.abs(phase.oiStartToExtremeUsd! - -6_000_000) < 1e-6);
      assert.ok(Math.abs(phase.oiExtremeToEndUsd! - 1_800_000) < 1e-6);
      assert.ok(
        Math.abs(phase.oiStartToEndUsd! - -4_200_000) < 1e-6,
        "start->end must equal the sum of the two phases",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
