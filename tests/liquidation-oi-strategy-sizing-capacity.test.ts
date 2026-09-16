import * as assert from "assert";
import { computePositionSizing } from "../src/domain/liquidation-oi-strategy/sizing-adapter";
import {
  computeInitialCapacity,
  initialTpPrice,
  DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
} from "../src/domain/liquidation-oi-strategy/initial-capacity-model";

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

const COEFFS = DEFAULT_CAPACITY_MODEL_COEFFICIENTS;

function main(): void {
  console.log("Running Phase 5-7 sizing/capacity tests...\n");

  scenario(
    "S.1. sizing matches the exact existing formula verified against execute-for-user.usecase.ts",
    () => {
      const result = computePositionSizing({
        entry: 100,
        structuralInvalidationPrice: 98,
        riskUsd: 1,
      });
      assert.strictEqual(result.valid, true);
      if (result.valid) {
        assert.strictEqual(result.stopDistance, 2);
        assert.strictEqual(result.positionQty, 0.5);
        assert.strictEqual(result.positionSizeUsdt, 50);
      }
    },
  );

  scenario(
    "S.2. different riskUsd for Karo vs Artak produces different quantities from the SAME entry/invalidation",
    () => {
      const karo = computePositionSizing({
        entry: 100,
        structuralInvalidationPrice: 98,
        riskUsd: 1,
      });
      const artak = computePositionSizing({
        entry: 100,
        structuralInvalidationPrice: 98,
        riskUsd: 5,
      });
      assert.strictEqual(karo.valid, true);
      assert.strictEqual(artak.valid, true);
      if (karo.valid && artak.valid) {
        assert.notStrictEqual(karo.positionQty, artak.positionQty);
        assert.ok(Math.abs(artak.positionQty - karo.positionQty * 5) < 1e-9);
      }
    },
  );

  scenario(
    "S.3. zero stop distance is refused, never silently producing an infinite quantity",
    () => {
      const result = computePositionSizing({
        entry: 100,
        structuralInvalidationPrice: 100,
        riskUsd: 1,
      });
      assert.strictEqual(result.valid, false);
    },
  );

  scenario("S.4. non-positive riskUsd is refused", () => {
    assert.strictEqual(
      computePositionSizing({
        entry: 100,
        structuralInvalidationPrice: 98,
        riskUsd: 0,
      }).valid,
      false,
    );
    assert.strictEqual(
      computePositionSizing({
        entry: 100,
        structuralInvalidationPrice: 98,
        riskUsd: -5,
      }).valid,
      false,
    );
  });

  scenario(
    "S.5. sizing does not distort the structural invalidation -- the SAME stop distance regardless of riskUsd",
    () => {
      const small = computePositionSizing({
        entry: 100,
        structuralInvalidationPrice: 98,
        riskUsd: 1,
      });
      const large = computePositionSizing({
        entry: 100,
        structuralInvalidationPrice: 98,
        riskUsd: 200,
      });
      assert.strictEqual(small.valid, true);
      assert.strictEqual(large.valid, true);
      if (small.valid && large.valid)
        assert.strictEqual(small.stopDistance, large.stopDistance);
    },
  );

  scenario(
    "C.1. capacity model output includes a named, logged contribution per component",
    () => {
      const result = computeInitialCapacity(
        {
          episodePercentileRank: 95,
          oiDestructionFraction: 0.3,
          displacementAtr: 1.2,
          liquidationToOiRatio: 0.8,
        },
        COEFFS,
      );
      const names = result.components.map((c) => c.name);
      assert.deepStrictEqual(names, [
        "base",
        "percentileRank",
        "oiDestructionFraction",
        "displacementAtr",
        "liquidationToOiRatio",
      ]);
      for (const c of result.components)
        assert.ok(Number.isFinite(c.contributionAtr));
    },
  );

  scenario(
    "C.2. missing oiDestructionFraction/liquidationToOiRatio contribute 0, never fabricated",
    () => {
      const result = computeInitialCapacity(
        {
          episodePercentileRank: 90,
          oiDestructionFraction: null,
          displacementAtr: 1.0,
          liquidationToOiRatio: null,
        },
        COEFFS,
      );
      const oiComp = result.components.find(
        (c) => c.name === "oiDestructionFraction",
      )!;
      const ratioComp = result.components.find(
        (c) => c.name === "liquidationToOiRatio",
      )!;
      assert.strictEqual(oiComp.rawValue, null);
      assert.strictEqual(oiComp.contributionAtr, 0);
      assert.strictEqual(ratioComp.rawValue, null);
      assert.strictEqual(ratioComp.contributionAtr, 0);
    },
  );

  scenario(
    "C.3. an extreme liquidationToOiRatio is capped before weighting",
    () => {
      const capped = computeInitialCapacity(
        {
          episodePercentileRank: 90,
          oiDestructionFraction: 0.2,
          displacementAtr: 1.0,
          liquidationToOiRatio: 5000,
        },
        COEFFS,
      );
      const uncappedEquivalent = computeInitialCapacity(
        {
          episodePercentileRank: 90,
          oiDestructionFraction: 0.2,
          displacementAtr: 1.0,
          liquidationToOiRatio: COEFFS.liquidationToOiRatioCap,
        },
        COEFFS,
      );
      assert.strictEqual(
        capped.initialCapacityAtr,
        uncappedEquivalent.initialCapacityAtr,
        "a ratio of 5000 must produce the IDENTICAL result as the cap value, proving the cap is genuinely applied",
      );
    },
  );

  scenario(
    "C.4. result is clamped to maxCapacityAtr and clampedToMax is reported truthfully",
    () => {
      const result = computeInitialCapacity(
        {
          episodePercentileRank: 100,
          oiDestructionFraction: 1.0,
          displacementAtr: 5.0,
          liquidationToOiRatio: 5.0,
        },
        COEFFS,
      );
      assert.strictEqual(result.initialCapacityAtr, COEFFS.maxCapacityAtr);
      assert.strictEqual(result.clampedToMax, true);
      assert.ok(result.rawSumAtr > COEFFS.maxCapacityAtr);
    },
  );

  scenario(
    "C.5. result is clamped to minCapacityAtr and clampedToMin is reported truthfully",
    () => {
      const zeroCoeffs = {
        ...COEFFS,
        baseAtr: 0,
        percentileWeight: 0,
        oiDestructionWeight: 0,
        displacementWeight: 0,
        liquidationToOiRatioWeight: 0,
      };
      const result = computeInitialCapacity(
        {
          episodePercentileRank: 90,
          oiDestructionFraction: 0.1,
          displacementAtr: 0.5,
          liquidationToOiRatio: 0.3,
        },
        zeroCoeffs,
      );
      assert.strictEqual(result.rawSumAtr, 0);
      assert.strictEqual(result.initialCapacityAtr, COEFFS.minCapacityAtr);
      assert.strictEqual(result.clampedToMin, true);
    },
  );

  scenario(
    "C.6. initialTpPrice places TP in the favorable direction for LONG (above) and SHORT (below)",
    () => {
      assert.strictEqual(initialTpPrice(100, 2, "LONG", 1.5), 103);
      assert.strictEqual(initialTpPrice(100, 2, "SHORT", 1.5), 97);
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
