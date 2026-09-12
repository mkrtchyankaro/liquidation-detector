/**
 * Sep 8 2026 (Karo). Tests for isDirectionDisabledForUser -- the
 * per-user port of liqwatch-bot's own V5_LONG_ENABLED/V5_SHORT_ENABLED
 * (see UserConfig.longEnabled/shortEnabled's own doc comment for the
 * full spec, and why this lives at signal-distribution level rather
 * than inside the shared V5WaveService).
 */
import * as assert from "assert";
import { isDirectionDisabledForUser } from "../src/services/signal-distributor";
import type { GlobalSignalDoc } from "../src/domain/signal/global-signal.model";
import type { UserConfig } from "../src/domain/user/user-config.model";

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

function baseSignal(side: "LONG" | "SHORT"): GlobalSignalDoc {
  return {
    signalId: "SIG-1",
    symbol: "SOLUSDT",
    side,
    victim: side,
    signalTs: Date.now(),
    entryPrice: 100,
    entryWaveNumber: 1,
    waveHistory: [],
    w1Diagnostics: null,
    totalEpisodePressure: 0,
    dominantLayerLiqUsd: null,
    dominantLayerWaveNumber: null,
    exhaustionLayerLiqUsd: null,
    exhaustionLayerWaveNumber: null,
    unitAtStart: 1,
    p95AtEntry: 1000,
    dailyLiqPerMinBaselineAtEntry: 500,
    atr15mAtEntry: 5,
    cascadeId: null,
    timeframe: null,
    isMainExecuted: true,
    episodePlan: null,
    waveEfficiencyAnalysis: null,
    p95AtW1Qualification: null,
    maxIndividualEventUsdAtW1: null,
    w1QualificationTs: null,
    unitResearch: null,
    unitCompetitionResearch: null,
    commonHorizonResearch: null,
    qualifyingEventUsd: 0,
    qualifyingEventTs: 0,
    p95AtQualification: 0,
    physics: null,
    btcContext: null,
    liq24hContext: null,
    wallContext: null,
    entry: 100,
    tp: 101,
    sl: 99,
    rr: 2.5,
    btcSafetyStatus: "CLEAN",
    btcIntendedSideAtSignalTime: null,
    rejectionReason: null,
    status: "SIGNAL",
    closedAt: null,
    closePrice: null,
    maxFavorableR: null,
    maxAdverseR: null,
    liquidationStatsContext: null,
    planDiagnostics: null,
    researchCheckpoints: [],
    createdAt: Date.now(),
  };
}

function baseUser(overrides: Partial<UserConfig>): UserConfig {
  return {
    userId: "test",
    enabled: true,
    telegram: null,
    binance: null,
    risk: { riskUsd: 10, accountBudgetUsd: 500, dailyLossLimitPct: 5 },
    btcBlockEnabled: false,
    longEnabled: true,
    shortEnabled: true,
    ...overrides,
  };
}

console.log("Running per-user direction-disable tests...\n");

scenario(
  "default (longEnabled=true, shortEnabled=true) -- never disabled, either side",
  () => {
    const user = baseUser({});
    assert.strictEqual(
      isDirectionDisabledForUser(baseSignal("LONG"), user),
      false,
    );
    assert.strictEqual(
      isDirectionDisabledForUser(baseSignal("SHORT"), user),
      false,
    );
  },
);

scenario(
  "longEnabled=false -- LONG signals disabled for this user, SHORT unaffected",
  () => {
    const user = baseUser({ longEnabled: false, shortEnabled: true });
    assert.strictEqual(
      isDirectionDisabledForUser(baseSignal("LONG"), user),
      true,
    );
    assert.strictEqual(
      isDirectionDisabledForUser(baseSignal("SHORT"), user),
      false,
    );
  },
);

scenario(
  "shortEnabled=false -- SHORT signals disabled for this user, LONG unaffected",
  () => {
    const user = baseUser({ longEnabled: true, shortEnabled: false });
    assert.strictEqual(
      isDirectionDisabledForUser(baseSignal("LONG"), user),
      false,
    );
    assert.strictEqual(
      isDirectionDisabledForUser(baseSignal("SHORT"), user),
      true,
    );
  },
);

scenario(
  "BOTH disabled -- every direction blocked for this user (e.g. temporarily pausing entirely around a big news event)",
  () => {
    const user = baseUser({ longEnabled: false, shortEnabled: false });
    assert.strictEqual(
      isDirectionDisabledForUser(baseSignal("LONG"), user),
      true,
    );
    assert.strictEqual(
      isDirectionDisabledForUser(baseSignal("SHORT"), user),
      true,
    );
  },
);

scenario(
  "Karo (longEnabled=false) and main (default) get DIFFERENT results for the identical LONG signal -- main is never affected by Karo's own preference",
  () => {
    const signal = baseSignal("LONG");
    const karo = baseUser({ userId: "karo", longEnabled: false });
    const main = baseUser({ userId: "main" });
    assert.strictEqual(isDirectionDisabledForUser(signal, karo), true);
    assert.strictEqual(isDirectionDisabledForUser(signal, main), false);
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
