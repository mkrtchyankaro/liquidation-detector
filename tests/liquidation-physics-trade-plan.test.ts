/**
 * Sep 9 2026 (Karo), operator-designed DYNAMIC liquidation-physics
 * trade plan. Proves every invariant requested by the operator's own
 * item 11: RR ladder discreteness, SL floor, TP=SL*RR exactly,
 * exhaustion behavior, bounded huge-liquidation behavior, P95
 * semantics (individual-event, never conflated with cumulative
 * sums), LONG/SHORT symmetry.
 */
import * as assert from "assert";
import {
  deriveLiquidationPhysicsTradePlan,
  RR_LADDER,
  SIZING_HARD_STOP_FLOOR_PCT,
  STRENGTH_MAX,
} from "../src/domain/trading/liquidation-physics-trade-plan";

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

console.log("Running liquidation-physics-trade-plan tests...\n");

// ─── RR ladder ───────────────────────────────────────────────────────

scenario(
  "RR can only ever be one of {2.0, 2.1, 2.2, 2.3, 2.4, 2.5} -- swept across the FULL possible input range",
  () => {
    const p95 = 10_000;
    const baseline = 3_000;
    for (let w1Mult = 0.5; w1Mult <= 50; w1Mult *= 1.7) {
      for (const w2Frac of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0, 1.5]) {
        for (const dispUnits of [0.2, 1, 3, 10]) {
          const w1Liq = p95 * w1Mult;
          const w2Liq = w1Liq * w2Frac;
          const unitAbs = 1;
          const w1Extreme = 100 - dispUnits * unitAbs;
          const result = deriveLiquidationPhysicsTradePlan({
            entry: 101,
            side: "LONG",
            w1AnchorPrice: 100,
            w1ExtremePrice: w1Extreme,
            w1LiqUsd: w1Liq,
            w2LiqUsd: w2Liq,
            w2ExtremePrice: w1Extreme,
            unitAbs,
            p95,
            dailyLiqPerMinBaseline: baseline,
          });
          if (!result.ok) continue;
          assert.ok(
            RR_LADDER.includes(result.rr),
            `rr=${result.rr} not on the ladder (w1Mult=${w1Mult} w2Frac=${w2Frac} dispUnits=${dispUnits})`,
          );
        }
      }
    }
  },
);

scenario(
  "RR never falls below 2.0 or exceeds 2.5, even at the absolute extremes of the score",
  () => {
    const zero = deriveLiquidationPhysicsTradePlan({
      entry: 101,
      side: "LONG",
      w1AnchorPrice: 100,
      w1ExtremePrice: 99.999,
      w1LiqUsd: 1,
      w2LiqUsd: 1,
      w2ExtremePrice: 99.999,
      unitAbs: 1,
      p95: 1_000_000,
      dailyLiqPerMinBaseline: 1_000_000,
    });
    if (zero.ok) assert.strictEqual(zero.rr, 2.0);

    const huge = deriveLiquidationPhysicsTradePlan({
      entry: 101,
      side: "LONG",
      w1AnchorPrice: 100,
      w1ExtremePrice: 99.9999,
      w1LiqUsd: 100_000_000,
      w2LiqUsd: 0,
      w2ExtremePrice: 99.9999,
      unitAbs: 1,
      p95: 100,
      dailyLiqPerMinBaseline: 100,
    });
    if (huge.ok) assert.strictEqual(huge.rr, 2.5);
  },
);

// ─── SL floor ────────────────────────────────────────────────────────

scenario(
  "SL is NEVER below the 0.20% execution-mechanics floor, even for a tiny structural risk",
  () => {
    const result = deriveLiquidationPhysicsTradePlan({
      entry: 100,
      side: "LONG",
      w1AnchorPrice: 100.01,
      w1ExtremePrice: 99.99,
      w1LiqUsd: 5000,
      w2LiqUsd: 4900,
      w2ExtremePrice: 99.99,
      unitAbs: 0.02,
      p95: 5000,
      dailyLiqPerMinBaseline: 4000,
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(
      result.slPct >= SIZING_HARD_STOP_FLOOR_PCT - 1e-12,
      `slPct=${result.slPct} must be >= ${SIZING_HARD_STOP_FLOOR_PCT}`,
    );
  },
);

scenario(
  "SL genuinely exceeds the 0.20% floor for a large-UNIT case -- floor is a no-op there",
  () => {
    const result = deriveLiquidationPhysicsTradePlan({
      entry: 103,
      side: "LONG",
      w1AnchorPrice: 103,
      w1ExtremePrice: 100,
      w1LiqUsd: 200_000,
      w2LiqUsd: 20_000,
      w2ExtremePrice: 100,
      unitAbs: 3,
      p95: 10_000,
      dailyLiqPerMinBaseline: 3_000,
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(
      result.slPct > SIZING_HARD_STOP_FLOOR_PCT,
      `slPct=${result.slPct} should genuinely exceed the floor in this large-UNIT case`,
    );
  },
);

// ─── TP = SL x RR, always exactly ───────────────────────────────────

scenario(
  "TP always equals EXACTLY finalSL x selectedRR -- swept across many scenarios",
  () => {
    const p95 = 8_000;
    for (const w1Mult of [1, 5, 20]) {
      for (const w2Frac of [0.1, 0.5, 0.9]) {
        for (const unitAbs of [0.1, 1, 5]) {
          const w1Liq = p95 * w1Mult;
          const result = deriveLiquidationPhysicsTradePlan({
            entry: 100 + unitAbs,
            side: "LONG",
            w1AnchorPrice: 100,
            w1ExtremePrice: 100 - unitAbs,
            w1LiqUsd: w1Liq,
            w2LiqUsd: w1Liq * w2Frac,
            w2ExtremePrice: 100 - unitAbs,
            unitAbs,
            p95,
            dailyLiqPerMinBaseline: 2_500,
          });
          if (!result.ok) continue;
          assert.ok(
            Math.abs(result.tpPct - result.slPct * result.rr) < 1e-9,
            `w1Mult=${w1Mult} w2Frac=${w2Frac} unitAbs=${unitAbs}: tpPct=${result.tpPct} slPct*rr=${result.slPct * result.rr}`,
          );
        }
      }
    }
  },
);

// ─── Bounded huge-liquidation behavior ───────────────────────────────

scenario(
  "a HUGE liquidation cannot make TP explode -- an extreme W1Liq/P95 ratio still produces a bounded, sane TP%",
  () => {
    const result = deriveLiquidationPhysicsTradePlan({
      entry: 100.5,
      side: "LONG",
      w1AnchorPrice: 100.5,
      w1ExtremePrice: 100,
      w1LiqUsd: 50_000_000,
      w2LiqUsd: 100,
      w2ExtremePrice: 100,
      unitAbs: 0.5,
      p95: 5_000,
      dailyLiqPerMinBaseline: 2_000,
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(
      result.tpPct < 0.05,
      `even an astronomically large liquidation must not exceed a 5% TP -- got ${result.tpPct * 100}%`,
    );
    assert.strictEqual(
      result.rr,
      2.5,
      "the huge-liquidation case should saturate at the RR ceiling, not exceed it",
    );
  },
);

scenario(
  "liquidityStrength itself is capped at STRENGTH_MAX regardless of how large W1Liq/P95 grows",
  () => {
    const modestW1 = deriveLiquidationPhysicsTradePlan({
      entry: 101,
      side: "LONG",
      w1AnchorPrice: 100,
      w1ExtremePrice: 99,
      w1LiqUsd: 1_000_000,
      w2LiqUsd: 100_000,
      w2ExtremePrice: 99,
      unitAbs: 1,
      p95: 5_000,
      dailyLiqPerMinBaseline: 2_000,
    });
    const massiveW1 = deriveLiquidationPhysicsTradePlan({
      entry: 101,
      side: "LONG",
      w1AnchorPrice: 100,
      w1ExtremePrice: 99,
      w1LiqUsd: 1_000_000_000,
      w2LiqUsd: 100_000_000,
      w2ExtremePrice: 99,
      unitAbs: 1,
      p95: 5_000,
      dailyLiqPerMinBaseline: 2_000,
    });
    assert.ok(modestW1.ok && massiveW1.ok);
    if (!modestW1.ok || !massiveW1.ok) return;
    assert.ok(modestW1.liquidityStrength <= STRENGTH_MAX + 1e-9);
    assert.ok(
      massiveW1.liquidityStrength <= STRENGTH_MAX + 1e-9,
      `massiveW1's own liquidityStrength=${massiveW1.liquidityStrength} must still be capped at ${STRENGTH_MAX}`,
    );
  },
);

// ─── W1/W2 exhaustion behavior ───────────────────────────────────────

scenario(
  "stronger W1 + weaker W2 produces STRONGER exhaustion (and a higher dynamicPhysicsScore) than an equal-strength W1/W2, all else equal",
  () => {
    const common = {
      entry: 101,
      side: "LONG" as const,
      w1AnchorPrice: 100,
      w1ExtremePrice: 99,
      w2ExtremePrice: 99,
      unitAbs: 1,
      p95: 5_000,
      dailyLiqPerMinBaseline: 2_000,
    };
    const w1Liq = 40_000;
    const equalW1W2 = deriveLiquidationPhysicsTradePlan({
      ...common,
      w1LiqUsd: w1Liq,
      w2LiqUsd: w1Liq,
    });
    const weakerW2 = deriveLiquidationPhysicsTradePlan({
      ...common,
      w1LiqUsd: w1Liq,
      w2LiqUsd: w1Liq * 0.1,
    });
    assert.ok(equalW1W2.ok && weakerW2.ok);
    if (!equalW1W2.ok || !weakerW2.ok) return;
    assert.ok(
      weakerW2.exhaustionScore > equalW1W2.exhaustionScore,
      `weakerW2 exhaustion (${weakerW2.exhaustionScore}) must exceed equalW1W2 exhaustion (${equalW1W2.exhaustionScore})`,
    );
    assert.ok(
      weakerW2.dynamicPhysicsScore > equalW1W2.dynamicPhysicsScore,
      `weakerW2's own overall score must be higher, all else equal`,
    );
    assert.strictEqual(
      equalW1W2.exhaustionScore,
      0,
      "equal W1/W2 must produce exactly ZERO exhaustion",
    );
  },
);

scenario("W2Liq > W1Liq is clamped -- exhaustion never goes negative", () => {
  const result = deriveLiquidationPhysicsTradePlan({
    entry: 101,
    side: "LONG",
    w1AnchorPrice: 100,
    w1ExtremePrice: 99,
    w1LiqUsd: 10_000,
    w2LiqUsd: 50_000,
    w2ExtremePrice: 99,
    unitAbs: 1,
    p95: 5_000,
    dailyLiqPerMinBaseline: 2_000,
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.strictEqual(
    result.exhaustionScore,
    0,
    "exhaustion must clamp at 0, never negative, when W2 exceeds W1",
  );
});

// ─── P95 semantics -- individual-event, never conflated with cumulative ─

scenario(
  "P95 is treated as an INDIVIDUAL-EVENT threshold, never compared against the cumulative episode sum -- structural proof from the function BODY (not doc-comments, which legitimately explain what to avoid)",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/domain/trading/liquidation-physics-trade-plan.ts"),
      "utf8",
    );
    const functionBody = source.slice(
      source.indexOf("export function deriveLiquidationPhysicsTradePlan"),
    );
    assert.ok(
      !functionBody.includes("totalEpisodePressure"),
      "the executable function body must never reference the whole-episode cumulative sum -- only Wave 1's own liqUsd",
    );
    assert.ok(
      source.includes("w1LiqUsd / p.p95"),
      "W1's own liquidity must be normalized against P95 directly, not any cumulative substitute",
    );
  },
);

scenario(
  "liquidityStrength scales with W1Liq specifically -- changing W2Liq alone (holding W1 fixed) never changes liquidityStrength",
  () => {
    const common = {
      entry: 101,
      side: "LONG" as const,
      w1AnchorPrice: 100,
      w1ExtremePrice: 99,
      w2ExtremePrice: 99,
      unitAbs: 1,
      p95: 5_000,
      dailyLiqPerMinBaseline: 2_000,
      w1LiqUsd: 40_000,
    };
    const smallW2 = deriveLiquidationPhysicsTradePlan({
      ...common,
      w2LiqUsd: 1_000,
    });
    const bigW2 = deriveLiquidationPhysicsTradePlan({
      ...common,
      w2LiqUsd: 39_000,
    });
    assert.ok(smallW2.ok && bigW2.ok);
    if (!smallW2.ok || !bigW2.ok) return;
    assert.strictEqual(
      smallW2.liquidityStrength,
      bigW2.liquidityStrength,
      "liquidityStrength must be W1-only, unaffected by W2's own magnitude",
    );
  },
);

// ─── LONG/SHORT symmetry ─────────────────────────────────────────────

scenario(
  "LONG and SHORT with mirrored geometry produce identical slPct/tpPct/rr magnitudes",
  () => {
    // Same entry-price MAGNITUDE (100) for both, so structuralRiskPct's
    // own denominator is identical -- a genuinely fair, symmetric
    // comparison (mirroring LONG's displacement below vs SHORT's
    // displacement above the same center).
    const longResult = deriveLiquidationPhysicsTradePlan({
      entry: 100,
      side: "LONG",
      w1AnchorPrice: 99,
      w1ExtremePrice: 98,
      w1LiqUsd: 60_000,
      w2LiqUsd: 15_000,
      w2ExtremePrice: 98,
      unitAbs: 1,
      p95: 5_000,
      dailyLiqPerMinBaseline: 2_000,
    });
    const shortResult = deriveLiquidationPhysicsTradePlan({
      entry: 100,
      side: "SHORT",
      w1AnchorPrice: 101,
      w1ExtremePrice: 102,
      w1LiqUsd: 60_000,
      w2LiqUsd: 15_000,
      w2ExtremePrice: 102,
      unitAbs: 1,
      p95: 5_000,
      dailyLiqPerMinBaseline: 2_000,
    });
    assert.ok(longResult.ok && shortResult.ok);
    if (!longResult.ok || !shortResult.ok) return;
    assert.ok(
      Math.abs(longResult.slPct - shortResult.slPct) < 1e-9,
      `LONG slPct=${longResult.slPct} SHORT slPct=${shortResult.slPct}`,
    );
    assert.ok(Math.abs(longResult.tpPct - shortResult.tpPct) < 1e-9);
    assert.strictEqual(longResult.rr, shortResult.rr);
    assert.ok(shortResult.sl > 100, "SHORT sl must be ABOVE entry");
    assert.ok(shortResult.tp < 100, "SHORT tp must be BELOW entry");
    assert.ok(longResult.sl < 100, "LONG sl must be BELOW entry");
    assert.ok(longResult.tp > 100, "LONG tp must be ABOVE entry");
  },
);

// ─── Invalid input handling ───────────────────────────────────────────

scenario(
  "invalid input (zero/negative entry, UNIT, P95, or W1Liq) is rejected with a specific cancelReason",
  () => {
    const base = {
      entry: 100,
      side: "LONG" as const,
      w1AnchorPrice: 100,
      w1ExtremePrice: 99,
      w1LiqUsd: 10_000,
      w2LiqUsd: 5_000,
      w2ExtremePrice: 99,
      unitAbs: 1,
      p95: 5_000,
      dailyLiqPerMinBaseline: 2_000,
    };
    for (const bad of [
      { entry: 0 },
      { unitAbs: 0 },
      { p95: 0 },
      { w1LiqUsd: 0 },
    ]) {
      const result = deriveLiquidationPhysicsTradePlan({ ...base, ...bad });
      assert.strictEqual(
        result.ok,
        false,
        `expected rejection for ${JSON.stringify(bad)}`,
      );
      if (!result.ok) assert.strictEqual(result.cancelReason, "invalid-input");
    }
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
