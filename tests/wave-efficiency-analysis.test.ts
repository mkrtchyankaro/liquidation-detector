import * as assert from "assert";
import { computeWaveEfficiencyAnalysis } from "../src/domain/trading/wave-efficiency-analysis";

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

function closeTo(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) < eps;
}

console.log("Running wave-efficiency-analysis tests...\n");

scenario(
  "operator's own general worked example: dominant~4.17 U/$1M, signal~0.597 U/$1M, efficiencyRatio~0.143, exhaustionPct~85.7%",
  () => {
    const unitAbs = 1;
    const waveHistory = [
      { waveNumber: 1, anchorPrice: 0, extremePrice: 0.6757, liqUsd: 162_200 },
      { waveNumber: 2, anchorPrice: 0, extremePrice: 0.08949, liqUsd: 149_800 },
    ];
    const result = computeWaveEfficiencyAnalysis(
      waveHistory,
      2,
      unitAbs,
      "SHORT",
    );
    assert.ok(result);
    assert.ok(
      closeTo(result!.dominant.efficiency, 4.17, 0.01),
      `dominant efficiency ~4.17, got ${result!.dominant.efficiency}`,
    );
    assert.ok(
      closeTo(result!.signal.efficiency, 0.597, 0.005),
      `signal efficiency ~0.597, got ${result!.signal.efficiency}`,
    );
    assert.ok(
      closeTo(result!.efficiencyRatio, 0.143, 0.002),
      `efficiencyRatio ~0.143, got ${result!.efficiencyRatio}`,
    );
    assert.ok(
      closeTo(result!.exhaustionPct, 85.7, 0.2),
      `exhaustionPct ~85.7%, got ${result!.exhaustionPct}`,
    );
  },
);

scenario(
  "operator's own W3 example: dominant is W2 (largest prior liq), NEVER W1, even though W1 came first",
  () => {
    const unitAbs = 1;
    const waveHistory = [
      { waveNumber: 1, anchorPrice: 0, extremePrice: 1.2, liqUsd: 500_000 },
      { waveNumber: 2, anchorPrice: 0, extremePrice: 1.0, liqUsd: 1_200_000 },
      { waveNumber: 3, anchorPrice: 0, extremePrice: 0.2, liqUsd: 900_000 },
    ];
    const result = computeWaveEfficiencyAnalysis(
      waveHistory,
      3,
      unitAbs,
      "SHORT",
    );
    assert.ok(result);
    assert.strictEqual(
      result!.dominant.waveNumber,
      2,
      "dominant MUST be W2 (largest prior liqUsd), not W1",
    );
    assert.strictEqual(result!.signal.waveNumber, 3);
    assert.ok(
      closeTo(result!.dominant.efficiency, 0.833, 0.002),
      `W2 efficiency ~0.833, got ${result!.dominant.efficiency}`,
    );
    assert.ok(
      closeTo(result!.signal.efficiency, 0.222, 0.002),
      `W3 efficiency ~0.222, got ${result!.signal.efficiency}`,
    );
    assert.ok(
      closeTo(result!.efficiencyRatio, 0.267, 0.005),
      `efficiencyRatio ~0.267, got ${result!.efficiencyRatio}`,
    );
    assert.ok(
      closeTo(result!.exhaustion, 0.733, 0.005),
      `exhaustion ~0.733, got ${result!.exhaustion}`,
    );
    assert.ok(
      closeTo(result!.exhaustionPct, 73.3, 0.5),
      `exhaustionPct ~73.3%, got ${result!.exhaustionPct}`,
    );
    assert.ok(
      closeTo(result!.liqRatio, 0.75, 0.001),
      `liqRatio = 900k/1.2M = 0.75, got ${result!.liqRatio}`,
    );
  },
);

scenario(
  "dominant-before-W2 example: W1=$1M, W2=$500k -> dominant before W2 is W1 (W1 is the ONLY prior wave)",
  () => {
    const waveHistory = [
      { waveNumber: 1, anchorPrice: 100, extremePrice: 99, liqUsd: 1_000_000 },
      { waveNumber: 2, anchorPrice: 99, extremePrice: 98, liqUsd: 500_000 },
    ];
    const result = computeWaveEfficiencyAnalysis(waveHistory, 2, 1, "LONG");
    assert.strictEqual(result!.dominant.waveNumber, 1);
  },
);

scenario(
  "W1=$500k, W2=$1M, then W3 signals -> dominant before W3 is W2 (the largest of W1/W2), NOT W1",
  () => {
    const waveHistory = [
      { waveNumber: 1, anchorPrice: 100, extremePrice: 99, liqUsd: 500_000 },
      { waveNumber: 2, anchorPrice: 99, extremePrice: 98, liqUsd: 1_000_000 },
      { waveNumber: 3, anchorPrice: 98, extremePrice: 97, liqUsd: 300_000 },
    ];
    const result = computeWaveEfficiencyAnalysis(waveHistory, 3, 1, "LONG");
    assert.strictEqual(
      result!.dominant.waveNumber,
      2,
      "must never let an older smaller wave (W1) remain the reference",
    );
  },
);

scenario(
  "efficiencyRatio > 1 (signal wave MORE efficient than dominant) is logged as-is, NEVER clamped to 1",
  () => {
    const waveHistory = [
      {
        waveNumber: 1,
        anchorPrice: 100,
        extremePrice: 99.9,
        liqUsd: 1_000_000,
      },
      { waveNumber: 2, anchorPrice: 99.9, extremePrice: 95, liqUsd: 100_000 },
    ];
    const result = computeWaveEfficiencyAnalysis(waveHistory, 2, 1, "LONG");
    assert.ok(
      result!.efficiencyRatio > 1,
      "efficiencyRatio must genuinely exceed 1 here, never artificially capped",
    );
  },
);

scenario(
  "liqRatio is preserved SEPARATELY from efficiencyRatio -- Case A (almost no pressure) vs Case B (substantial pressure, still low efficiency) are distinguishable",
  () => {
    const caseA = computeWaveEfficiencyAnalysis(
      [
        {
          waveNumber: 1,
          anchorPrice: 100,
          extremePrice: 90,
          liqUsd: 1_000_000,
        },
        { waveNumber: 2, anchorPrice: 90, extremePrice: 89.99, liqUsd: 50_000 },
      ],
      2,
      1,
      "LONG",
    )!;
    const caseB = computeWaveEfficiencyAnalysis(
      [
        {
          waveNumber: 1,
          anchorPrice: 100,
          extremePrice: 90,
          liqUsd: 1_000_000,
        },
        {
          waveNumber: 2,
          anchorPrice: 90,
          extremePrice: 89.99,
          liqUsd: 800_000,
        },
      ],
      2,
      1,
      "LONG",
    )!;
    assert.ok(
      caseA.liqRatio < caseB.liqRatio,
      "liqRatio must distinguish the two cases even though signal-wave progress is identical in both",
    );
    assert.ok(closeTo(caseA.liqRatio, 0.05, 0.001));
    assert.ok(closeTo(caseB.liqRatio, 0.8, 0.001));
  },
);

scenario(
  "newExtremeExtension (LONG): max(0, previousEpisodeExtreme - signalWaveExtreme), distinct from signalWaveProgressUnits",
  () => {
    const waveHistory = [
      { waveNumber: 1, anchorPrice: 100, extremePrice: 95, liqUsd: 500_000 },
      { waveNumber: 2, anchorPrice: 96, extremePrice: 93, liqUsd: 300_000 },
    ];
    const result = computeWaveEfficiencyAnalysis(waveHistory, 2, 1, "LONG")!;
    assert.strictEqual(result.previousEpisodeExtreme, 95);
    assert.ok(
      closeTo(result.newExtremeExtension, 2, 1e-9),
      "newExtremeExtension = 95-93 = 2, distinct from the wave's own anchor-to-extreme progress (96-93=3)",
    );
    assert.ok(
      closeTo(result.signal.progressUnits, 3, 1e-9),
      "signalWaveProgressUnits (anchor-to-extreme) must remain the SEPARATE, own metric",
    );
  },
);

scenario(
  "newExtremeExtension is clamped at 0 (never negative) when the signal wave does NOT extend beyond the previous episode extreme",
  () => {
    const waveHistory = [
      { waveNumber: 1, anchorPrice: 100, extremePrice: 90, liqUsd: 500_000 },
      { waveNumber: 2, anchorPrice: 91, extremePrice: 92, liqUsd: 300_000 },
    ];
    const result = computeWaveEfficiencyAnalysis(waveHistory, 2, 1, "LONG")!;
    assert.strictEqual(result.newExtremeExtension, 0);
  },
);

scenario(
  "returns null when there is no wave before the signal wave (W1 alone can never signal in production, but handled defensively)",
  () => {
    const waveHistory = [
      { waveNumber: 1, anchorPrice: 100, extremePrice: 99, liqUsd: 500_000 },
    ];
    const result = computeWaveEfficiencyAnalysis(waveHistory, 1, 1, "LONG");
    assert.strictEqual(result, null);
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
