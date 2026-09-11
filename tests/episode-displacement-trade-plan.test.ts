/**
 * Sep 11 2026 (Karo), operator-requested. Proves deriveEpisodeDisplacementTradePlan()
 * matches the operator's own exact formula and worked examples,
 * including the MIN_FLOOR/STRUCTURAL/MAX_CAP execution-envelope
 * boundary behavior.
 */
import * as assert from "assert";
import { deriveEpisodeDisplacementTradePlan } from "../src/domain/trading/episode-displacement-trade-plan";

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

function closeTo(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

console.log("Running episode-displacement-trade-plan tests...\n");

scenario(
  "LONG: episodeDisplacement = |firstAnchor - finalExtreme|, naturalSL = finalExtreme - episodeDisplacement",
  () => {
    const plan = deriveEpisodeDisplacementTradePlan({
      entryPrice: 2000,
      direction: "LONG",
      firstAnchorPrice: 2010,
      finalExtremePrice: 1990,
      unitAbs: 10,
    });
    assert.ok(closeTo(plan.episodeDisplacement, 20));
    assert.ok(closeTo(plan.naturalSL, 1990 - 20));
  },
);

scenario(
  "SHORT: episodeDisplacement = |firstAnchor - finalExtreme|, naturalSL = finalExtreme + episodeDisplacement",
  () => {
    const plan = deriveEpisodeDisplacementTradePlan({
      entryPrice: 2000,
      direction: "SHORT",
      firstAnchorPrice: 1990,
      finalExtremePrice: 2010,
      unitAbs: 10,
    });
    assert.ok(closeTo(plan.episodeDisplacement, 20));
    assert.ok(closeTo(plan.naturalSL, 2010 + 20));
  },
);

scenario("naturalRisk=0.14% -> executionRisk=0.20% (MIN_FLOOR)", () => {
  const entry = 10000;
  const naturalSL = entry * (1 - 0.0014);
  const displacement = entry - naturalSL;
  const finalExtreme = entry;
  const firstAnchor = finalExtreme + displacement;
  const plan = deriveEpisodeDisplacementTradePlan({
    entryPrice: entry,
    direction: "LONG",
    firstAnchorPrice: firstAnchor,
    finalExtremePrice: finalExtreme,
    unitAbs: 10,
  });
  assert.ok(
    closeTo(plan.naturalRiskPct, 0.0014, 1e-6),
    "naturalRiskPct must be ~0.14%",
  );
  assert.ok(
    closeTo(plan.executionRiskPct, 0.002, 1e-9),
    "executionRiskPct must be floored to 0.20%",
  );
  assert.strictEqual(plan.slAdjustment, "MIN_FLOOR");
});

scenario(
  "naturalRisk=0.32% -> executionRisk=0.32% (STRUCTURAL, unchanged)",
  () => {
    const entry = 10000;
    const naturalSL = entry * (1 - 0.0032);
    const displacement = entry - naturalSL;
    const finalExtreme = entry;
    const firstAnchor = finalExtreme + displacement;
    const plan = deriveEpisodeDisplacementTradePlan({
      entryPrice: entry,
      direction: "LONG",
      firstAnchorPrice: firstAnchor,
      finalExtremePrice: finalExtreme,
      unitAbs: 10,
    });
    assert.ok(closeTo(plan.naturalRiskPct, 0.0032, 1e-6));
    assert.ok(
      closeTo(plan.executionRiskPct, 0.0032, 1e-6),
      "STRUCTURAL: executionRiskPct must equal naturalRiskPct exactly, unmodified",
    );
    assert.strictEqual(plan.slAdjustment, "STRUCTURAL");
  },
);

scenario(
  "naturalRisk=0.47% -> executionRisk=0.47% (STRUCTURAL, unchanged)",
  () => {
    const entry = 10000;
    const naturalSL = entry * (1 - 0.0047);
    const displacement = entry - naturalSL;
    const plan = deriveEpisodeDisplacementTradePlan({
      entryPrice: entry,
      direction: "LONG",
      firstAnchorPrice: entry + displacement,
      finalExtremePrice: entry,
      unitAbs: 10,
    });
    assert.ok(closeTo(plan.naturalRiskPct, 0.0047, 1e-6));
    assert.ok(closeTo(plan.executionRiskPct, 0.0047, 1e-6));
    assert.strictEqual(plan.slAdjustment, "STRUCTURAL");
  },
);

scenario(
  "naturalRisk=0.68% -> executionRisk=0.50% (MAX_CAP) -- setup is STILL taken, never cancelled",
  () => {
    const entry = 10000;
    const naturalSL = entry * (1 - 0.0068);
    const displacement = entry - naturalSL;
    const plan = deriveEpisodeDisplacementTradePlan({
      entryPrice: entry,
      direction: "LONG",
      firstAnchorPrice: entry + displacement,
      finalExtremePrice: entry,
      unitAbs: 10,
    });
    assert.ok(closeTo(plan.naturalRiskPct, 0.0068, 1e-6));
    assert.ok(
      closeTo(plan.executionRiskPct, 0.005, 1e-9),
      "executionRiskPct must be capped to 0.50%",
    );
    assert.strictEqual(plan.slAdjustment, "MAX_CAP");
    assert.ok(
      plan.stopLoss > 0,
      "a wide natural stop must NEVER cancel the setup -- it must still produce a valid, capped execution plan",
    );
  },
);

scenario("naturalRisk=1.10% -> executionRisk=0.50% (MAX_CAP)", () => {
  const entry = 10000;
  const naturalSL = entry * (1 - 0.011);
  const displacement = entry - naturalSL;
  const plan = deriveEpisodeDisplacementTradePlan({
    entryPrice: entry,
    direction: "LONG",
    firstAnchorPrice: entry + displacement,
    finalExtremePrice: entry,
    unitAbs: 10,
  });
  assert.ok(closeTo(plan.naturalRiskPct, 0.011, 1e-6));
  assert.ok(closeTo(plan.executionRiskPct, 0.005, 1e-9));
  assert.strictEqual(plan.slAdjustment, "MAX_CAP");
});

for (const dir of ["LONG", "SHORT"] as const) {
  scenario(
    `${dir}: final SL price = entry * (1 -+ executionRiskPct), correct sign`,
    () => {
      const entry = 5000;
      const plan = deriveEpisodeDisplacementTradePlan({
        entryPrice: entry,
        direction: dir,
        firstAnchorPrice: dir === "LONG" ? entry + 50 : entry - 50,
        finalExtremePrice: dir === "LONG" ? entry - 20 : entry + 20,
        unitAbs: 10,
      });
      if (dir === "LONG")
        assert.ok(plan.stopLoss < entry, "LONG SL must be below entry");
      else assert.ok(plan.stopLoss > entry, "SHORT SL must be above entry");
    },
  );
}

scenario(
  "TP examples: SL=0.20% -> TP distance ~0.44%; SL=0.30% -> ~0.66%; SL=0.40% -> ~0.88%; SL=0.50% -> ~1.10%",
  () => {
    const cases: Array<[number, number]> = [
      [0.002, 0.0044],
      [0.003, 0.0066],
      [0.004, 0.0088],
      [0.005, 0.011],
    ];
    for (const [slPct, expectedTpPct] of cases) {
      const entry = 10000;
      const naturalSL = entry * (1 - slPct);
      const displacement = entry - naturalSL;
      const plan = deriveEpisodeDisplacementTradePlan({
        entryPrice: entry,
        direction: "LONG",
        firstAnchorPrice: entry + displacement,
        finalExtremePrice: entry,
        unitAbs: 10,
      });
      const actualTpPct = plan.rewardDistance / entry;
      assert.ok(
        closeTo(actualTpPct, expectedTpPct, 1e-6),
        `SL=${slPct * 100}% -> expected TP distance ~${expectedTpPct * 100}%, got ${(actualTpPct * 100).toFixed(4)}%`,
      );
      assert.ok(closeTo(plan.rewardRiskRatio, 2.2, 1e-9));
      assert.ok(
        closeTo(plan.takeProfit, entry + plan.rewardDistance, 1e-6),
        "TP must be derived from the FINAL executable risk distance, never naturalSL directly",
      );
    }
  },
);

scenario(
  "A natural stop of 0.90% still produces a valid, capped 0.50% executable plan -- never cancelled for being 'too wide'",
  () => {
    const entry = 10000;
    const naturalSL = entry * (1 - 0.009);
    const displacement = entry - naturalSL;
    const plan = deriveEpisodeDisplacementTradePlan({
      entryPrice: entry,
      direction: "LONG",
      firstAnchorPrice: entry + displacement,
      finalExtremePrice: entry,
      unitAbs: 10,
    });
    assert.strictEqual(plan.slAdjustment, "MAX_CAP");
    assert.ok(closeTo(plan.executionRiskPct, 0.005, 1e-9));
    assert.ok(
      plan.takeProfit > entry,
      "a full, valid TP must still be produced",
    );
  },
);

// ─── Sep 11 2026, operator-requested UNIT-relative logging additions ──

scenario(
  "operator's own worked example (LONG): UNIT=$56, Entry=$70056, FinalExtreme=$70000 -> unitPctAtEntry~0.0799%, actualRecoveryUnits=1.00U",
  () => {
    const unitAbs = 56;
    const entry = 70056;
    const finalExtreme = 70000;
    // Solve backward for the naturalSL that gives EXACTLY 0.32%
    // naturalRiskPct relative to ENTRY (the real formula's own anchor:
    // naturalRiskPct = |entryPrice - naturalSL| / entryPrice), then
    // derive the displacement/firstAnchor that produces THAT naturalSL
    // from finalExtreme=70000.
    const targetNaturalSL = entry * (1 - 0.0032);
    const displacement = finalExtreme - targetNaturalSL;
    const plan = deriveEpisodeDisplacementTradePlan({
      entryPrice: entry,
      direction: "LONG",
      firstAnchorPrice: finalExtreme + displacement,
      finalExtremePrice: finalExtreme,
      unitAbs,
    });
    assert.ok(closeTo(plan.unitAbs, 56));
    assert.ok(closeTo(plan.unitPctAtEntry, 56 / 70056, 1e-9));
    assert.ok(
      closeTo(plan.unitPctAtEntry * 100, 0.0799, 1e-3),
      "unitPctAtEntryDisplay must be ~0.0799%",
    );
    assert.ok(closeTo(plan.actualRecoveryDistance, 56, 1e-9));
    assert.ok(closeTo(plan.actualRecoveryPct, 56 / 70056, 1e-9));
    assert.ok(
      closeTo(plan.actualRecoveryUnits, 1.0, 1e-6),
      "actualRecoveryUnits must be ~1.00U here, but is a SEPARATELY calculated value, never assumed to be exactly 1.0",
    );
    assert.strictEqual(plan.slAdjustment, "STRUCTURAL");
    assert.ok(closeTo(plan.executionRiskPct, 0.0032, 1e-9));
    assert.ok(
      closeTo(plan.stopDistanceUnits, plan.riskDistance / unitAbs, 1e-9),
    );
    assert.ok(
      closeTo(
        plan.takeProfitDistanceUnits,
        plan.rewardDistance / unitAbs,
        1e-9,
      ),
    );
    assert.ok(
      closeTo(plan.takeProfitDistanceUnits, plan.stopDistanceUnits * 2.2, 1e-6),
      "takeProfitDistanceUnits must be ~stopDistanceUnits*2.2, since TP=2.2R",
    );
  },
);

scenario(
  "operator's own worked example (SHORT mirror): same structure, direction reversed",
  () => {
    const unitAbs = 56;
    const entry = 69944; // SHORT mirror: entry BELOW the final extreme
    const finalExtreme = 70000;
    const naturalSL = entry * (1 + 0.0032);
    const displacement = naturalSL - entry;
    const plan = deriveEpisodeDisplacementTradePlan({
      entryPrice: entry,
      direction: "SHORT",
      firstAnchorPrice: entry - displacement,
      finalExtremePrice: finalExtreme,
      unitAbs,
    });
    assert.ok(closeTo(plan.actualRecoveryDistance, 56, 1e-9));
    assert.ok(closeTo(plan.actualRecoveryUnits, 1.0, 1e-6));
    assert.strictEqual(plan.slAdjustment, "STRUCTURAL");
    assert.ok(plan.stopLoss > entry, "SHORT stopLoss must be above entry");
    assert.ok(plan.takeProfit < entry, "SHORT takeProfit must be below entry");
    assert.ok(
      closeTo(plan.takeProfitDistanceUnits, plan.stopDistanceUnits * 2.2, 1e-6),
    );
  },
);

scenario(
  "actualRecoveryUnits is a SEPARATELY calculated value, never assumed to be exactly 1.0 -- e.g. slippage giving 1.15U",
  () => {
    const unitAbs = 10;
    const entry = 10011.5; // 1.15 UNIT away from finalExtreme=10000
    const finalExtreme = 10000;
    const naturalSL = entry * (1 - 0.0032);
    const displacement = entry - naturalSL;
    const plan = deriveEpisodeDisplacementTradePlan({
      entryPrice: entry,
      direction: "LONG",
      firstAnchorPrice: entry + displacement,
      finalExtremePrice: finalExtreme,
      unitAbs,
    });
    assert.ok(
      closeTo(plan.actualRecoveryUnits, 1.15, 1e-3),
      "must genuinely reflect actual entry vs finalExtreme, not a hardcoded 1.0",
    );
  },
);

scenario(
  "UNIT-relative fields are PURELY additive/observational -- naturalSL/executionRiskPct/stopLoss/takeProfit are IDENTICAL with or without unitAbs present",
  () => {
    const entry = 10000;
    const naturalSLTarget = entry * (1 - 0.0035);
    const displacement = entry - naturalSLTarget;
    const planA = deriveEpisodeDisplacementTradePlan({
      entryPrice: entry,
      direction: "LONG",
      firstAnchorPrice: entry + displacement,
      finalExtremePrice: entry,
      unitAbs: 5,
    });
    const planB = deriveEpisodeDisplacementTradePlan({
      entryPrice: entry,
      direction: "LONG",
      firstAnchorPrice: entry + displacement,
      finalExtremePrice: entry,
      unitAbs: 500,
    });
    assert.strictEqual(
      planA.naturalSL,
      planB.naturalSL,
      "naturalSL must be IDENTICAL regardless of unitAbs -- UNIT never influences SL",
    );
    assert.strictEqual(planA.executionRiskPct, planB.executionRiskPct);
    assert.strictEqual(planA.stopLoss, planB.stopLoss);
    assert.strictEqual(planA.takeProfit, planB.takeProfit);
    assert.strictEqual(planA.slAdjustment, planB.slAdjustment);
    // Only the UNIT-relative fields themselves differ.
    assert.notStrictEqual(planA.stopDistanceUnits, planB.stopDistanceUnits);
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
