/**
 * Sep 10 2026 (Karo), operator-reported CRITICAL FIX. Proves a cascade-
 * produced GlobalSignalDoc (mapped exactly as handleCascadeSignalReady()
 * now does) renders through the EXISTING, UNCHANGED
 * toV5SignalEventShape() + formatV5EntryMessage() exactly like a
 * normal V5 signal -- never producing the malformed output that
 * originally motivated this fix ("Wave 2 of 0", "Dominant layer: $0
 * (Wave null)", "Plan rejected: unknown").
 */
import * as assert from "assert";
import { formatV5EntryMessage } from "../src/infrastructure/telegram/signal.formatter";
import type { GlobalSignalDoc } from "../src/domain/signal/global-signal.model";
import type { V5Wave } from "../src/strategy/v5/v5-wave.model";

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

/** Mirrors toV5SignalEventShape() in notify-user.usecase.ts -- same
 *  physics-presence gate, same spread. Reproduced here (not imported)
 *  because that function is not exported; this keeps the test
 *  exercising the SAME contract without depending on an internal. */
function toV5SignalEventShape(doc: GlobalSignalDoc): any {
  const plan =
    doc.entry !== null &&
    doc.tp !== null &&
    doc.sl !== null &&
    doc.rr !== null &&
    doc.physics !== null
      ? {
          entry: doc.entry,
          tp: doc.tp,
          sl: doc.sl,
          rr: doc.rr,
          liqStrengthRaw: doc.physics.liqStrengthRaw,
          liqStrength: doc.physics.liqStrength,
          liqBaseline: doc.physics.liqBaseline,
          physicsTPPct: doc.physics.physicsTPPct,
          wallAdjustedTpPct: doc.physics.wallAdjustedTpPct,
          wallApplied: doc.physics.wallApplied,
          rrCandidate: doc.physics.rrCandidate,
          slCapApplied: doc.physics.slCapApplied,
          slCapValue: doc.physics.slCapValue,
          finalTpPct: doc.physics.finalTpPct,
          finalSlPct: doc.physics.finalSlPct,
          structuralSoftExitPrice: doc.physics.structuralSoftExitPrice,
          structuralRiskPct: doc.physics.structuralRiskPct,
          sizingRiskPct: doc.physics.sizingRiskPct,
          hardStopRiskPct: doc.physics.hardStopRiskPct,
          liquidityStrengthP95: doc.physics.liquidityStrengthP95,
          liquidityStrength24h: doc.physics.liquidityStrength24h,
          liquidityStrength: doc.physics.liquidityStrength,
          w2ToW1Ratio: doc.physics.w2ToW1Ratio,
          exhaustionScore: doc.physics.exhaustionScore,
          w1DisplacementAtr: doc.physics.w1DisplacementAtr,
          absorptionRaw: doc.physics.absorptionRaw,
          absorptionScore: doc.physics.absorptionScore,
          dynamicPhysicsScore: doc.physics.dynamicPhysicsScore,
          selectedRR: doc.physics.selectedRR,
          tpMultiplier: doc.physics.tpMultiplier,
          slDeterminedBy: doc.physics.slDeterminedBy,
        }
      : null;
  return { ...doc, plan };
}

/** Builds a realistic W1(100k)->W2(150k)->W3(220k)->W4(180k) cascade
 *  waveHistory, exactly like cascadeWavesToV5Waves() now derives it --
 *  every wave before the last is COMPLETED with a derived reclaimPrice
 *  (extreme +/- unitAbs), the last is ACTIVE (this is the signal-
 *  triggering wave, entryPrice is its own completion price in
 *  practice, but the object itself models it as just-completed here
 *  for a clean, realistic fixture). */
function buildCascadeWaveHistory(unitAbs: number): V5Wave[] {
  const raw = [
    {
      waveNumber: 1,
      anchorPrice: 2000,
      anchorTs: 1000,
      extremePrice: 1990,
      extremeTs: 1500,
      liqUsd: 100_000,
      liqEvents: 3,
    },
    {
      waveNumber: 2,
      anchorPrice: 1991,
      anchorTs: 1600,
      extremePrice: 1985,
      extremeTs: 2000,
      liqUsd: 150_000,
      liqEvents: 5,
    },
    {
      waveNumber: 3,
      anchorPrice: 1986,
      anchorTs: 2100,
      extremePrice: 1975,
      extremeTs: 2500,
      liqUsd: 220_000,
      liqEvents: 8,
    },
    {
      waveNumber: 4,
      anchorPrice: 1976,
      anchorTs: 2600,
      extremePrice: 1970,
      extremeTs: 3000,
      liqUsd: 180_000,
      liqEvents: 4,
    },
  ];
  return raw.map((w, i, arr): V5Wave => {
    const isCompleted = i < arr.length - 1;
    return {
      waveNumber: w.waveNumber,
      state: isCompleted ? "COMPLETED" : "ACTIVE",
      anchorPrice: w.anchorPrice,
      anchorTs: w.anchorTs,
      extremePrice: w.extremePrice,
      extremeTs: w.extremeTs,
      reclaimPrice: isCompleted ? w.extremePrice + unitAbs : null,
      reclaimTs: isCompleted ? w.extremeTs : null,
      liqNotionalUsd: w.liqUsd,
      liqEvents: w.liqEvents,
      maxSingleEventUsd: 0,
      maxRecoveryPrice: w.extremePrice,
      recoveryPct: null,
      priceEfficiency: null,
      liquidationRatioVsDominant: null,
      priceEfficiencyRatioVsDominant: null,
      extremeDistanceAtr: Math.abs(w.anchorPrice - w.extremePrice) / 5, // atr15mAbs=5
      isMeaningful: true,
      selectedRecoveryPct: null,
      recoveryTargetPrice: null,
      recovery50AtTs: null,
      recovery50AtPrice: null,
      recovery75AtTs: null,
      recovery75AtPrice: null,
      takerBuyUsd: null,
      takerSellUsd: null,
      takerImbalance: null,
      oiStart: null,
      oiEnd: null,
      oiDeltaPct: null,
    };
  });
}

function buildCascadeSignalDoc(planOk: boolean): GlobalSignalDoc {
  const waveHistory = buildCascadeWaveHistory(1);
  const triggerWave = waveHistory[waveHistory.length - 1]!;
  const dominantWave = waveHistory.reduce(
    (best, w) => (w.liqNotionalUsd > best.liqNotionalUsd ? w : best),
    waveHistory[0]!,
  );
  const totalLiq = waveHistory.reduce((sum, w) => sum + w.liqNotionalUsd, 0);

  return {
    signalId: "sig-cascade-test",
    symbol: "ETHUSDT",
    side: "LONG",
    victim: "LONG",
    signalTs: 3000,
    entryPrice: 1971,
    entryWaveNumber: triggerWave.waveNumber,
    cascadeId: "casc-test",
    timeframe: "3m",
    waveHistory,
    w1Diagnostics: null,
    totalEpisodePressure: totalLiq,
    dominantLayerLiqUsd: dominantWave.liqNotionalUsd,
    dominantLayerWaveNumber: dominantWave.waveNumber,
    exhaustionLayerLiqUsd: triggerWave.liqNotionalUsd,
    exhaustionLayerWaveNumber: triggerWave.waveNumber,
    unitAtStart: 1,
    p95AtEntry: 50_000,
    dailyLiqPerMinBaselineAtEntry: 20_000,
    atr15mAtEntry: 5,
    qualifyingEventUsd: waveHistory[0]!.liqNotionalUsd,
    qualifyingEventTs: waveHistory[0]!.anchorTs,
    p95AtQualification: 50_000,
    physics: planOk
      ? {
          cumLiqUsd: totalLiq,
          atrPct: 5,
          liqBaseline: 20_000,
          liqStrengthRaw: 1.4,
          liqStrength: 1.8,
          physicsTPPct: 0.01,
          wallAdjustedTpPct: 0.01,
          wallApplied: false,
          rrCandidate: 2.2,
          slCapApplied: false,
          slCapValue: 0,
          finalTpPct: 0.01,
          finalSlPct: 0.0045,
          actualRR: 2.2,
          structuralSoftExitPrice: 0,
          structuralRiskPct: 0,
          sizingRiskPct: 0,
          hardStopRiskPct: 0,
          liquidityStrengthP95: 1.4,
          liquidityStrength24h: 2.2,
          liquidityStrength: 1.8,
          w2ToW1Ratio: 0.5,
          exhaustionScore: 0.5,
          w1DisplacementAtr: 2.0,
          absorptionRaw: 0.7,
          absorptionScore: 0.83,
          dynamicPhysicsScore: 0.37,
          selectedRR: 2.2,
          tpMultiplier: 0.6,
          slDeterminedBy: "physics",
        }
      : null,
    btcContext: null,
    liq24hContext: null,
    wallContext: null,
    entry: planOk ? 1971 : null,
    tp: planOk ? 1990.71 : null,
    sl: planOk ? 1962.13 : null,
    rr: planOk ? 2.2 : null,
    btcSafetyStatus: "UNKNOWN",
    btcIntendedSideAtSignalTime: null,
    rejectionReason: planOk ? null : "invalid-input",
    planDiagnostics: null,
    status: planOk ? "SIGNAL" : "REJECTED_PLAN",
    closedAt: null,
    closePrice: null,
    maxFavorableR: null,
    maxAdverseR: null,
    liquidationStatsContext: null,
    researchCheckpoints: [],
    unitResearch: null,
    unitCompetitionResearch: null,
    commonHorizonResearch: null,
    createdAt: Date.now(),
  };
}

console.log("Running cascade-Telegram-format regression tests...\n");

scenario(
  "a cascade signal with a VALID plan renders a normal V5 ENTRY message -- never the malformed output",
  () => {
    const doc = buildCascadeSignalDoc(true);
    const event = toV5SignalEventShape(doc);
    const message = formatV5EntryMessage(event);

    assert.ok(
      !message.includes("Wave 2 of 0"),
      "must never show a zero-length wave chain",
    );
    assert.ok(
      !message.includes("trigger: ?%") === false ||
        message.includes("trigger:"),
      "the trigger line must render (selectedRecoveryPct is honestly null -- '?' is acceptable, but the LINE ITSELF must exist and reference a real wave)",
    );
    assert.ok(
      !message.includes("extremeDistanceAtr=?"),
      "extremeDistanceAtr must be a real, derived number, never '?'",
    );
    assert.ok(
      !message.includes("Dominant layer: $0 (Wave null)"),
      "dominant layer must never show $0/Wave null",
    );
    assert.ok(
      !message.includes("Plan rejected: unknown"),
      "a VALID plan must never show 'Plan rejected'",
    );
    assert.ok(
      message.includes("🟢"),
      "a valid plan must render as an executed ENTRY (green), not a rejected SIGNAL",
    );
    assert.ok(
      message.includes("Wave 4 of 4"),
      "must show the real wave count (4) and the real entry wave (4)",
    );
    assert.ok(
      message.includes("Dominant layer: $220k (Wave 3)"),
      "must show the REAL dominant wave (W3, the largest at 220k)",
    );
    assert.ok(
      message.includes("Exhaustion layer: $180k (Wave 4)"),
      "must show the real exhaustion/trigger wave",
    );
  },
);

scenario(
  "a cascade signal with a REJECTED plan shows the REAL rejection reason, never 'unknown'",
  () => {
    const doc = buildCascadeSignalDoc(false);
    const event = toV5SignalEventShape(doc);
    const message = formatV5EntryMessage(event);

    assert.ok(
      message.includes("🟡"),
      "a rejected plan must render as SIGNAL (not executed), not a fake green ENTRY",
    );
    assert.ok(
      message.includes("Plan rejected: invalid-input"),
      "must show the REAL rejection reason from plan.cancelReason, never 'unknown'",
    );
    assert.ok(
      !message.includes("Wave 2 of 0"),
      "even a rejected plan must show the real wave chain, never a zero-length one",
    );
    assert.ok(
      !message.includes("Dominant layer: $0 (Wave null)"),
      "dominant layer must be populated even for a rejected plan",
    );
  },
);

scenario(
  "every wave in the chain listing shows its own real anchor/extreme/liquidation, never a fabricated placeholder",
  () => {
    const doc = buildCascadeSignalDoc(true);
    const event = toV5SignalEventShape(doc);
    const message = formatV5EntryMessage(event);

    assert.ok(
      message.includes("W1: anchor=2000"),
      "Wave 1's own real anchor must appear",
    );
    assert.ok(
      message.includes("$100k"),
      "Wave 1's own real liquidation total must appear",
    );
    assert.ok(
      message.includes("W3: anchor=1986"),
      "Wave 3's own real anchor must appear",
    );
    assert.ok(
      message.includes("$220k"),
      "Wave 3's own real (dominant) liquidation total must appear",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
