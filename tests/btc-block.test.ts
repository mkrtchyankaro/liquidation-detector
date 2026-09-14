/**
 * Sep 8 2026 (Karo). Tests for isBtcBlockedForUser -- the per-user
 * port of liqwatch-bot's own V5_BTC_BLOCK (same-side block, BTC's own
 * signal always blocked when enabled, disabled users never blocked --
 * see UserConfig.btcBlockEnabled's own doc comment for the full spec).
 */
import * as assert from "assert";
import * as fs from "fs";
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
    marketContextAtEntry: null,
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

// ─── Sep 11 2026 (Karo), operator-reported CRITICAL FIX: MAIN's own
// real-position-opening decision + the Telegram diagnostic line must
// both reuse this SAME per-user mechanism, never a hardcoded/
// disconnected approximation. ───

scenario(
  "1. BTC_BLOCK active (main btcBlockEnabled=true) + ALT signal, same-side active BTC setup -- blocked",
  () => {
    const signal = baseSignal({
      symbol: "SOLUSDT",
      side: "LONG",
      btcIntendedSideAtSignalTime: "LONG",
    });
    const main = baseUser({ userId: "main", btcBlockEnabled: true });
    assert.strictEqual(isBtcBlockedForUser(signal, main), true);
  },
);

scenario(
  "2. BTC_BLOCK inactive (main btcBlockEnabled=false) + ALT signal -- never blocked, regardless of BTC state",
  () => {
    const signal = baseSignal({
      symbol: "SOLUSDT",
      side: "LONG",
      btcIntendedSideAtSignalTime: "LONG",
    });
    const main = baseUser({ userId: "main", btcBlockEnabled: false });
    assert.strictEqual(isBtcBlockedForUser(signal, main), false);
  },
);

scenario(
  "3. BTC signal itself is ALWAYS blocked when main btcBlockEnabled=true (unconditional, regardless of btcIntendedSideAtSignalTime), and NEVER blocked when false",
  () => {
    const signalBlocked = baseSignal({
      symbol: "BTCUSDT",
      side: "LONG",
      btcIntendedSideAtSignalTime: null,
    });
    const mainBlocking = baseUser({ userId: "main", btcBlockEnabled: true });
    assert.strictEqual(isBtcBlockedForUser(signalBlocked, mainBlocking), true);

    const mainNotBlocking = baseUser({
      userId: "main",
      btcBlockEnabled: false,
    });
    assert.strictEqual(
      isBtcBlockedForUser(signalBlocked, mainNotBlocking),
      false,
      "BTC must be free to trade normally when main's own btcBlockEnabled=false -- this is exactly the operator-observed live bug (BTC entries/closes happening while Telegram falsely implied it never trades)",
    );
  },
);

// Sep 11 2026 (Karo), operator-instructed REVERT -- tests 4/4b removed:
// they asserted the BTC_BLOCK execution-gating/diagnostic wiring
// (isMainBtcBlocked(), real btcEval on handleCandlePhysicsEntry())
// which was never deployed to production and the operator explicitly
// does not want implemented yet. Re-add these once that work is
// actually requested and implemented again.

scenario(
  "5. no regression -- fixed 0.30% SL, TP=2.2R, P95 seriousness gate, and single-event discard are all still fully present and untouched by the BTC_BLOCK fix",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = source.indexOf("private async handleCandlePhysicsEntry(");
    const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
    assert.ok(
      body.includes("FIXED_SL_PCT = isRotation ? v5RotationSlPct() : 0.003"),
      "WAVE mode's own fixed 0.30% SL must still be present, unchanged (ROTATION mode now reads its own SL% from the single-source-of-truth config, Sep 14 2026 config-wiring pass)",
    );
    assert.ok(
      body.includes(
        "REWARD_RISK_RATIO = isRotation ? v5RotationTpPct() / FIXED_SL_PCT : 2.2",
      ),
      "WAVE mode's own TP=2.2R must still be present, unchanged (ROTATION mode now reads its own ratio from the single-source-of-truth config, Sep 14 2026 config-wiring pass)",
    );
    assert.ok(
      body.includes("event.p95AtW1Qualification"),
      "the P95-at-W1-qualification value (from the new engine-level rule) must still be logged",
    );
    assert.ok(body.includes("event.maxIndividualEventUsd"));

    const engineSource = fs.readFileSync(
      require.resolve("../src/domain/cascade/candle-physics-engine.ts"),
      "utf8",
    );
    assert.ok(
      engineSource.includes("summary.totalEvents === 1"),
      "single-event-wave discard rule must still be present, untouched",
    );
  },
);

// ─── Sep 12 2026 (Karo), operator-requested: BTC_BLOCK redesign --
// canonical signal is never suppressed, and btcBlockEnabled=false
// never blocks execution regardless of what MAIN's own diagnostic
// would say. ───

scenario(
  "7. btcBlockEnabled=false never blocks a user's own execution, even when the live BTC context WOULD have matched (MAIN's own diagnostic saying YES is purely display, never a gate for this user)",
  () => {
    const signal = baseSignal({
      symbol: "SOLUSDT",
      side: "LONG",
      btcIntendedSideAtSignalTime: "LONG",
    });
    const user = baseUser({ userId: "karo", btcBlockEnabled: false });
    assert.strictEqual(
      isBtcBlockedForUser(signal, user),
      false,
      "btcBlockEnabled=false must never be overridden by a matching live BTC context",
    );
  },
);

scenario(
  "8. the canonical/global signal document is inserted UNCONDITIONALLY, before any per-user BTC_BLOCK check runs -- BTC_BLOCK must never suppress signal generation itself",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/signal-distributor.ts"),
      "utf8",
    );
    const idx = source.indexOf("async distribute(");
    assert.ok(idx > -1);
    const body = source.slice(
      idx,
      source.indexOf("private async persistBlocked", idx),
    );
    const insertIdx = body.indexOf(
      "await this.globalSignalRepo.insert(globalSignal);",
    );
    const firstBtcCheckIdx = body.indexOf("isBtcBlockedForUser(");
    assert.ok(insertIdx > -1, "the canonical signal insert must be present");
    assert.ok(
      insertIdx < firstBtcCheckIdx,
      "the canonical signal must be inserted BEFORE any per-user BTC_BLOCK check runs -- it can never be conditionally suppressed by that check",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
