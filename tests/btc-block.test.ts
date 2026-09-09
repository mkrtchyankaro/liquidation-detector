/**
 * Sep 8 2026 (Karo). Tests for isBtcBlockedForUser -- the per-user
 * port of liqwatch-bot's own V5_BTC_BLOCK (same-side block, BTC's own
 * signal always blocked when enabled, disabled users never blocked --
 * see UserConfig.btcBlockEnabled's own doc comment for the full spec).
 */
import * as assert from "assert";
import { isBtcBlockedForUser } from "../src/services/signal-distributor";
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

function baseSignal(overrides: Partial<GlobalSignalDoc>): GlobalSignalDoc {
  return {
    signalId: "SIG-1",
    symbol: "ETHUSDT",
    side: "LONG",
    victim: "LONG",
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
    unitResearch: null,
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
    ...overrides,
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

console.log("Running BTC-block per-user tests...\n");

scenario(
  "btcBlockEnabled=false (e.g. 'main') -- NEVER blocks, regardless of BTC state or symbol",
  () => {
    const signal = baseSignal({ symbol: "BTCUSDT", side: "LONG" });
    const user = baseUser({ btcBlockEnabled: false });
    assert.strictEqual(isBtcBlockedForUser(signal, user), false);
  },
);

scenario(
  "btcBlockEnabled=true -- BTC's OWN signal is always blocked for this user, unconditionally",
  () => {
    const signal = baseSignal({
      symbol: "BTCUSDT",
      side: "LONG",
      btcIntendedSideAtSignalTime: null,
    });
    const user = baseUser({ btcBlockEnabled: true });
    assert.strictEqual(isBtcBlockedForUser(signal, user), true);
  },
);

scenario(
  "btcBlockEnabled=true -- ALT LONG blocked when BTC currently has an active LONG setup (same side)",
  () => {
    const signal = baseSignal({
      symbol: "SOLUSDT",
      side: "LONG",
      btcIntendedSideAtSignalTime: "LONG",
    });
    const user = baseUser({ btcBlockEnabled: true });
    assert.strictEqual(isBtcBlockedForUser(signal, user), true);
  },
);

scenario(
  "btcBlockEnabled=true -- ALT SHORT is NOT blocked when BTC has an active LONG setup (opposite side, allowed)",
  () => {
    const signal = baseSignal({
      symbol: "SOLUSDT",
      side: "SHORT",
      btcIntendedSideAtSignalTime: "LONG",
    });
    const user = baseUser({ btcBlockEnabled: true });
    assert.strictEqual(isBtcBlockedForUser(signal, user), false);
  },
);

scenario(
  "btcBlockEnabled=true -- ALT signal NOT blocked when BTC has no active setup at all",
  () => {
    const signal = baseSignal({
      symbol: "SOLUSDT",
      side: "LONG",
      btcIntendedSideAtSignalTime: null,
    });
    const user = baseUser({ btcBlockEnabled: true });
    assert.strictEqual(isBtcBlockedForUser(signal, user), false);
  },
);

scenario(
  "Karo (btcBlockEnabled=true) and Friend (btcBlockEnabled=false) get DIFFERENT results for the identical signal -- fully independent per user",
  () => {
    const signal = baseSignal({
      symbol: "SOLUSDT",
      side: "LONG",
      btcIntendedSideAtSignalTime: "LONG",
    });
    const karo = baseUser({ userId: "karo", btcBlockEnabled: true });
    const friend = baseUser({ userId: "friend", btcBlockEnabled: false });
    assert.strictEqual(isBtcBlockedForUser(signal, karo), true);
    assert.strictEqual(isBtcBlockedForUser(signal, friend), false);
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
