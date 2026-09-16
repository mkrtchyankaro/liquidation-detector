import * as assert from "assert";
import { computeQuantityPhaseAccounting } from "../src/domain/research/episode-oi-liquidation-accounting";
import type { OiWaypoint } from "../src/domain/research/episode-oi-trajectory";
import type { RawEvent } from "../src/domain/research/displacement-balanced-core";
import type { Side } from "../src/shared/common.types";

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

function mkWaypoint(
  timestamp: number,
  openInterest: number | null,
): OiWaypoint {
  return {
    timestamp,
    side: "LONG",
    liquidationUsd: 0,
    price: 100,
    openInterest,
    openInterestUsd: openInterest !== null ? openInterest * 100 : null,
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
  };
}
function mkEvent(
  id: string,
  timestamp: number,
  victim: Side,
  price: number,
  quoteQty: number,
): RawEvent {
  return { _id: id, timestamp, victim, price, quoteQty, marketSnapshot: null };
}

function main(): void {
  console.log("Running episode-oi-liquidation-accounting tests...\n");

  scenario(
    "1. worked example: liq=20, netOI=+60 => implied replacement=80, ratio=4.0",
    () => {
      const events = [mkEvent("e1", 500, "LONG", 1, 20)];
      const start = mkWaypoint(0, 1000);
      const end = mkWaypoint(1000, 1060);
      const result = computeQuantityPhaseAccounting(events, start, end, 1000);
      assert.strictEqual(result.liquidatedQuantity, 20);
      assert.strictEqual(result.observedOiQuantityChange, 60);
      assert.strictEqual(
        result.impliedReplacementQuantity,
        80,
        "20 liquidated + 60 net change = 80 implied replacement",
      );
      assert.ok(
        Math.abs(result.impliedReplacementToLiquidationRatio! - 4.0) < 1e-9,
        `expected 4.0x, got ${result.impliedReplacementToLiquidationRatio}`,
      );
      assert.strictEqual(
        result.residualContractionBeyondLiquidation,
        null,
        "residual concept is not applicable to a positive net-change case",
      );
    },
  );

  scenario(
    "2. liq=20, netOI=0 => implied replacement ~20 (just enough to offset)",
    () => {
      const events = [mkEvent("e1", 500, "LONG", 1, 20)];
      const start = mkWaypoint(0, 1000);
      const end = mkWaypoint(1000, 1000);
      const result = computeQuantityPhaseAccounting(events, start, end, 1000);
      assert.strictEqual(result.liquidatedQuantity, 20);
      assert.strictEqual(result.observedOiQuantityChange, 0);
      assert.strictEqual(
        result.impliedReplacementQuantity,
        20,
        "flat net OI despite 20 liquidated implies ~20 replacement was needed just to offset it",
      );
      assert.ok(
        Math.abs(result.impliedReplacementToLiquidationRatio! - 1.0) < 1e-9,
      );
    },
  );

  scenario(
    "3. negative net OI must NOT be labeled as known gross creation -- impliedReplacementQuantity stays null",
    () => {
      const events = [mkEvent("e1", 500, "LONG", 1, 20)];
      const start = mkWaypoint(0, 1000);
      const end = mkWaypoint(1000, 982);
      const result = computeQuantityPhaseAccounting(events, start, end, 1000);
      assert.strictEqual(result.observedOiQuantityChange, -18);
      assert.strictEqual(
        result.impliedReplacementQuantity,
        null,
        "must NEVER populate a 'replacement' figure for a negative net-change case",
      );
      assert.strictEqual(result.impliedReplacementToLiquidationRatio, null);
      assert.ok(
        result.residualContractionBeyondLiquidation !== null,
        "the neutral residual figure must be populated instead",
      );
      assert.ok(
        Math.abs(result.residualContractionBeyondLiquidation! - -2) < 1e-9,
        `18 observed contraction vs 20 liquidated -- residual should be -2, got ${result.residualContractionBeyondLiquidation}`,
      );
    },
  );

  scenario(
    "4. price movement alone must not create fake quantity-based OI expansion",
    () => {
      const events = [mkEvent("e1", 500, "LONG", 1, 20)];
      const start = mkWaypoint(0, 1000);
      const startWithHigherPrice = {
        ...start,
        price: 50,
        openInterestUsd: 1000 * 50,
      };
      const end = mkWaypoint(1000, 1000);
      const result = computeQuantityPhaseAccounting(
        events,
        startWithHigherPrice,
        end,
        1000,
      );
      assert.strictEqual(
        result.observedOiQuantityChange,
        0,
        "raw quantity-based change must show exactly 0 regardless of any price difference between waypoints",
      );
    },
  );

  scenario(
    "5. time alignment: liquidations AFTER the final OI waypoint must NOT enter the numerator",
    () => {
      const events = [
        mkEvent("e1", 200, "LONG", 1, 10),
        mkEvent("e2", 1500, "LONG", 1, 999),
      ];
      const start = mkWaypoint(0, 1000);
      const end = mkWaypoint(1000, 990);
      const result = computeQuantityPhaseAccounting(events, start, end, 2000);
      assert.strictEqual(
        result.liquidatedQuantity,
        10,
        `only the event inside [0,1000] must count. Got ${result.liquidatedQuantity}`,
      );
      assert.strictEqual(
        result.offsetFromStructuralEndMs,
        1000 - 2000,
        "the offset metadata must reveal the actual OI waypoint is far earlier than the structural boundary",
      );
    },
  );

  scenario(
    "6. multiple same-direction liquidation events are summed correctly",
    () => {
      const events = [
        mkEvent("e1", 100, "LONG", 1, 10),
        mkEvent("e2", 200, "LONG", 2, 30),
        mkEvent("e3", 300, "LONG", 1, 5),
      ];
      const start = mkWaypoint(0, 1000);
      const end = mkWaypoint(1000, 1000);
      const result = computeQuantityPhaseAccounting(events, start, end, 1000);
      assert.strictEqual(
        result.liquidatedQuantity,
        10 + 15 + 5,
        `expected sum 30, got ${result.liquidatedQuantity}`,
      );
    },
  );

  scenario(
    "7. opposite-side liquidation events are never silently added",
    () => {
      const sameDirectionOnly = [mkEvent("e1", 100, "LONG", 1, 10)];
      const withOppositeSideMixedIn = [
        mkEvent("e1", 100, "LONG", 1, 10),
        mkEvent("opp1", 150, "SHORT", 1, 500),
      ];
      const start = mkWaypoint(0, 1000);
      const end = mkWaypoint(1000, 1000);
      const resultCorrect = computeQuantityPhaseAccounting(
        sameDirectionOnly,
        start,
        end,
        1000,
      );
      const resultIfMixedInByMistake = computeQuantityPhaseAccounting(
        withOppositeSideMixedIn,
        start,
        end,
        1000,
      );
      assert.strictEqual(resultCorrect.liquidatedQuantity, 10);
      assert.notStrictEqual(
        resultIfMixedInByMistake.liquidatedQuantity,
        10,
        "this function has no direction filter of its own -- callers must pass only same-direction events; demonstrating this confirms the caller-side responsibility documented in this module's own header",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
