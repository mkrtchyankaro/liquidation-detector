/**
 * Sep 14 2026 (Karo), operator-requested. Tests for the live
 * CandlePhysicsEngine ROTATION mode (the new, minimal-patch entry
 * logic added alongside the existing, completely unchanged WAVE
 * mode). See candle-physics-engine.test.ts for the 30 pre-existing
 * WAVE-mode tests, all still passing unchanged.
 */
import * as assert from "assert";
import * as fs from "fs";
import { CandlePhysicsEngine } from "../src/domain/cascade/candle-physics-engine";
import { DirectionalAtrTracker } from "../src/strategy/v5/directional-atr";
import type { Liquidation } from "../src/shared/common.types";

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

function liq(
  symbol: string,
  price: number,
  quoteQty: number,
  timestamp: number,
): Liquidation {
  return {
    symbol,
    side: "SELL",
    price,
    quoteQty,
    quantity: quoteQty / price,
    timestamp,
  };
}
function shortLiq(
  symbol: string,
  price: number,
  quoteQty: number,
  timestamp: number,
): Liquidation {
  return {
    symbol,
    side: "BUY",
    price,
    quoteQty,
    quantity: quoteQty / price,
    timestamp,
  };
}

console.log("Running CandlePhysicsEngine ROTATION-mode tests...\n");

function setupLongEntryReady(e: CandlePhysicsEngine, symbol = "ETHUSDT"): void {
  e.onLiquidation(
    symbol,
    "LONG",
    liq(symbol, 1000, 50000, 1000),
    1,
    1000,
    1000,
    "ROTATION",
    10,
    10,
  );
  e.setRotationCausalP95(symbol, "LONG", 40000, 20);
}

scenario("first liquidation opens a ROTATION watch immediately", () => {
  const e = new CandlePhysicsEngine();
  e.onLiquidation(
    "ETHUSDT",
    "LONG",
    liq("ETHUSDT", 1000, 5000, 1000),
    1,
    1000,
    1000,
    "ROTATION",
    10,
    10,
  );
  const w = e.peekWatch("ETHUSDT", "LONG");
  assert.ok(w, "watch must exist after the first liquidation");
  assert.strictEqual(w!.mode, "ROTATION");
  assert.strictEqual(
    w!.cumulativeSameSideLiqUsd,
    5000,
    "cumulative total includes the first event",
  );
});

scenario(
  "multiple small events accumulate cumulatively (individual-event P95 never checked in ROTATION mode)",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 1000, 500, 1000),
      1,
      1000,
      1000,
      "ROTATION",
      10,
      10,
    );
    for (let i = 1; i <= 9; i++)
      e.onLiquidation(
        "ETHUSDT",
        "LONG",
        liq("ETHUSDT", 999, 500, 1000 + i * 1000),
        1,
        1000,
        1000 + i * 1000,
      );
    const w = e.peekWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(
      w.cumulativeSameSideLiqUsd,
      5000,
      "ten $500 events sum to $5000 -- no single event anywhere near a typical P95",
    );
  },
);

scenario(
  "<20 prior ROTATION samples blocks entry even when every other gate is satisfied",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 1000, 50000, 1000),
      1,
      1000,
      1000,
      "ROTATION",
      10,
      10,
    );
    e.setRotationCausalP95("ETHUSDT", "LONG", 40000, 19);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      1000,
      1000,
      880,
      900,
      null,
      5,
      15,
      -0.5,
      0.5,
    );
    assert.strictEqual(
      result,
      null,
      "must not enter with only 19 prior samples",
    );
  },
);

scenario(
  "cumulative below causal P95 blocks entry (20 samples present, but total hasn't reached the threshold)",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 1000, 50000, 1000),
      1,
      1000,
      1000,
      "ROTATION",
      10,
      10,
    );
    e.setRotationCausalP95("ETHUSDT", "LONG", 60000, 20);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      1000,
      1000,
      880,
      900,
      null,
      5,
      15,
      -0.5,
      0.5,
    );
    assert.strictEqual(result, null);
  },
);

scenario(
  "valid rotation BEFORE P95 is reached does not enter -- same rotation becomes eligible once P95 is reached",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 1000, 10000, 1000),
      1,
      1000,
      1000,
      "ROTATION",
      10,
      10,
    );
    e.setRotationCausalP95("ETHUSDT", "LONG", 40000, 20);
    const before = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      1000,
      1000,
      880,
      900,
      null,
      5,
      15,
      -0.5,
      0.5,
    );
    assert.strictEqual(
      before,
      null,
      "rotation is valid but cumulative liquidation hasn't reached P95 yet",
    );

    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 900, 35000, 90000),
      1,
      1000,
      90000,
    );
    const after = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      120000,
      900,
      900,
      880,
      890,
      null,
      5,
      15,
      -0.5,
      0.5,
    );
    assert.ok(
      after?.kind === "ENTRY",
      "the SAME rotation state now qualifies once cumulative crosses P95",
    );
  },
);

scenario(
  "full LONG entry: all 7 gates satisfied -> ENTRY fires immediately, with correct rotationDiagnostics",
  () => {
    const e = new CandlePhysicsEngine();
    setupLongEntryReady(e);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      1000,
      1000,
      880,
      900,
      null,
      5,
      15,
      -0.5,
      0.5,
    );
    assert.ok(
      result?.kind === "ENTRY",
      "all gates satisfied -> immediate ENTRY",
    );
    const diag = result!.rotationDiagnostics!;
    assert.strictEqual(diag.entryMode, "ROTATION");
    assert.ok(diag.rotationDeg! >= 15);
    assert.ok(diag.shockAtr! >= 10);
    assert.ok(diag.rotationForce! >= 0.3);
    assert.strictEqual(diag.cumulativeSameSideLiqUsd, 50000);
    assert.strictEqual(diag.causalP95Threshold, 40000);
    assert.strictEqual(diag.priorEpisodeSampleCount, 20);
  },
);

scenario(
  "ROTATION entry does not wait for any wave completion / efficiency comparison -- fires on the FIRST evaluated closed candle",
  () => {
    const e = new CandlePhysicsEngine();
    setupLongEntryReady(e);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      1000,
      1000,
      880,
      900,
      null,
      5,
      15,
      -0.5,
      0.5,
    );
    assert.ok(
      result?.kind === "ENTRY",
      "no Wave1/Wave2/dominant-wave/efficiency requirement of any kind",
    );
  },
);

scenario(
  "ShockATR below threshold blocks entry (all other gates satisfied)",
  () => {
    const e = new CandlePhysicsEngine();
    setupLongEntryReady(e);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      1000,
      1000,
      950,
      960,
      null,
      5,
      15,
      -0.5,
      0.5,
    );
    assert.strictEqual(result, null);
  },
);

scenario(
  "rotation degrees below threshold blocks entry (all other gates satisfied)",
  () => {
    const e = new CandlePhysicsEngine();
    setupLongEntryReady(e);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      1000,
      1000,
      880,
      900,
      null,
      9,
      11,
      -0.5,
      0.5,
    );
    assert.strictEqual(result, null);
  },
);

scenario(
  "liq-direction ATR NOT decaying (slope >= 0) blocks entry even with a large rotation angle",
  () => {
    const e = new CandlePhysicsEngine();
    setupLongEntryReady(e);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      1000,
      1000,
      880,
      900,
      null,
      5,
      15,
      0.1,
      0.5,
    );
    assert.strictEqual(result, null);
  },
);

scenario("recovery-direction ATR NOT rising (slope <= 0) blocks entry", () => {
  const e = new CandlePhysicsEngine();
  setupLongEntryReady(e);
  const result = e.onClosedCandle(
    "ETHUSDT",
    "LONG",
    60000,
    1000,
    1000,
    880,
    900,
    null,
    5,
    15,
    -0.5,
    -0.1,
  );
  assert.strictEqual(result, null);
});

scenario(
  "rotationForce below 0.30 blocks entry even when liqDecay/recRise are both individually positive",
  () => {
    const e = new CandlePhysicsEngine();
    setupLongEntryReady(e);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      1000,
      1000,
      880,
      900,
      null,
      5,
      15,
      -0.1,
      0.1,
    );
    assert.strictEqual(result, null);
  },
);

scenario(
  "timeFromExtremeMin > 5 blocks entry -- extreme set on an earlier candle, entry evaluated too late",
  () => {
    const e = new CandlePhysicsEngine();
    setupLongEntryReady(e);
    e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      1000,
      1000,
      880,
      900,
      null,
      8,
      10,
      0,
      0,
    );
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      480000,
      900,
      900,
      895,
      898,
      null,
      5,
      15,
      -0.5,
      0.5,
    );
    assert.strictEqual(
      result,
      null,
      "timeFromExtremeMin now ~7min, exceeds the 5min gate",
    );
  },
);

scenario(
  "fresh adverse extreme resets/restarts the 5-minute extreme-to-entry clock",
  () => {
    const e = new CandlePhysicsEngine();
    setupLongEntryReady(e);
    e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      1000,
      1000,
      950,
      960,
      null,
      8,
      10,
      0,
      0,
    );
    const w1 = e.peekWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(w1.adverseExtremeTs, 60000);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      400000,
      950,
      950,
      880,
      900,
      null,
      5,
      15,
      -0.5,
      0.5,
    );
    assert.ok(
      result?.kind === "ENTRY",
      "fresh extreme at THIS candle -> timeFromExtremeMin=0, entry fires",
    );
  },
);

scenario(
  "15-minute ROTATION inactivity (measured from last SAME-SIDE liquidation, not wave completion) cancels the watch",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 1000, 1000, 1000),
      1,
      1000,
      1000,
      "ROTATION",
      10,
      10,
    );
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      1000 + 15 * 60000,
      1000,
      1000,
      999,
      999.5,
      null,
      null,
      null,
      null,
      null,
    );
    assert.ok(
      result?.kind === "CANCEL" &&
        result.reason === "EPISODE_EXPIRED_INACTIVITY",
    );
  },
);

scenario(
  "a new same-side liquidation resets the 15-minute ROTATION inactivity timer",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 1000, 1000, 1000),
      1,
      1000,
      1000,
      "ROTATION",
      10,
      10,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 999, 500, 1000 + 10 * 60000),
      1,
      1000,
      1000 + 10 * 60000,
    );
    const stillAlive = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      1000 + 14 * 60000,
      1000,
      1000,
      999,
      999.5,
      null,
      null,
      null,
      null,
      null,
    );
    assert.strictEqual(
      stillAlive,
      null,
      "only 4min since the reset -- must not cancel",
    );
    const nowCancel = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      1000 + 10 * 60000 + 15 * 60000 + 1000,
      1000,
      1000,
      999,
      999.5,
      null,
      null,
      null,
      null,
      null,
    );
    assert.ok(nowCancel?.kind === "CANCEL");
  },
);

scenario(
  "SHORT victim: mirrored gate direction is real -- rising (not decaying) liq-direction ATR blocks entry",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "SHORT",
      shortLiq("ETHUSDT", 1000, 50000, 1000),
      1,
      1000,
      1000,
      "ROTATION",
      10,
      10,
    );
    e.setRotationCausalP95("ETHUSDT", "SHORT", 40000, 20);
    // rotUpSlope2m=+0.5 -- for SHORT, liq-direction is UpATR, so a POSITIVE upSlope2m means it is RISING, not decaying -- must block.
    const result = e.onClosedCandle(
      "ETHUSDT",
      "SHORT",
      60000,
      1000,
      1120,
      1000,
      1100,
      null,
      15,
      5,
      0.5,
      0.5,
    );
    assert.strictEqual(
      result,
      null,
      "upSlope2m=+0.5 (rising, not decaying) must block SHORT entry -- confirms mirrored gate is not a copy-paste no-op",
    );
  },
);

scenario("SHORT victim: full valid entry with correctly mirrored gates", () => {
  const e = new CandlePhysicsEngine();
  e.onLiquidation(
    "ETHUSDT",
    "SHORT",
    shortLiq("ETHUSDT", 1000, 50000, 1000),
    1,
    1000,
    1000,
    "ROTATION",
    10,
    10,
  );
  e.setRotationCausalP95("ETHUSDT", "SHORT", 40000, 20);
  const result = e.onClosedCandle(
    "ETHUSDT",
    "SHORT",
    60000,
    1000,
    1120,
    1000,
    1100,
    null,
    15,
    5,
    0.5,
    -0.5,
  );
  assert.ok(
    result?.kind === "ENTRY",
    "SHORT entry with properly mirrored liqDecay=-upSlope2m, recRise=downSlope2m",
  );
});

scenario(
  "opposite-side ROTATION watches (LONG vs SHORT, same symbol) remain fully independent",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 1000, 5000, 1000),
      1,
      1000,
      1000,
      "ROTATION",
      10,
      10,
    );
    e.onLiquidation(
      "ETHUSDT",
      "SHORT",
      shortLiq("ETHUSDT", 1000, 9000, 1000),
      1,
      1000,
      1000,
      "ROTATION",
      10,
      10,
    );
    const wl = e.peekWatch("ETHUSDT", "LONG")!,
      ws = e.peekWatch("ETHUSDT", "SHORT")!;
    assert.strictEqual(wl.cumulativeSameSideLiqUsd, 5000);
    assert.strictEqual(ws.cumulativeSameSideLiqUsd, 9000);
  },
);

scenario(
  "no duplicate watch for the same symbol+victim -- a second liquidation on an active watch accumulates, never creates a new one",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 1000, 5000, 1000),
      1,
      1000,
      1000,
      "ROTATION",
      10,
      10,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 999, 3000, 2000),
      1,
      1000,
      2000,
    );
    const w = e.peekWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(w.cumulativeSameSideLiqUsd, 8000);
    assert.strictEqual(
      w.episodeStartTs,
      1000,
      "still the SAME watch, episode start unchanged",
    );
  },
);

console.log(
  "\nRunning ROTATION SL/TP direction tests (production-safety pass, Sep 14 2026)...\n",
);

const ROTATION_SL_PCT = 0.003;
const ROTATION_TP_PCT = 0.006;

function computeRotationPlan(
  victim: "LONG" | "SHORT",
  entry: number,
): { sl: number; tp: number } {
  // Mirrors EXACTLY the formulas required and now present in
  // market-data-orchestrator.ts's handleCandlePhysicsEntry() for
  // isRotation === true: sl = entry*(1 -+ slPct), tp = entry*(1 +- tpPct).
  const sl =
    victim === "LONG"
      ? entry * (1 - ROTATION_SL_PCT)
      : entry * (1 + ROTATION_SL_PCT);
  const tp =
    victim === "LONG"
      ? entry * (1 + ROTATION_TP_PCT)
      : entry * (1 - ROTATION_TP_PCT);
  return { sl, tp };
}

scenario(
  "LONG entry=900: SL=897.3, TP=905.4 (exact values, production-safety check)",
  () => {
    const { sl, tp } = computeRotationPlan("LONG", 900);
    assert.strictEqual(Math.round(sl * 100) / 100, 897.3);
    assert.strictEqual(Math.round(tp * 100) / 100, 905.4);
  },
);

scenario(
  "SHORT entry=900: SL=902.7, TP=894.6 (exact values, production-safety check)",
  () => {
    const { sl, tp } = computeRotationPlan("SHORT", 900);
    assert.strictEqual(Math.round(sl * 100) / 100, 902.7);
    assert.strictEqual(Math.round(tp * 100) / 100, 894.6);
  },
);

scenario("LONG: TP > entry > SL (structural direction sanity check)", () => {
  const { sl, tp } = computeRotationPlan("LONG", 900);
  assert.ok(
    tp > 900 && 900 > sl,
    `expected tp(${tp}) > entry(900) > sl(${sl})`,
  );
});

scenario("SHORT: SL > entry > TP (structural direction sanity check)", () => {
  const { sl, tp } = computeRotationPlan("SHORT", 900);
  assert.ok(
    sl > 900 && 900 > tp,
    `expected sl(${sl}) > entry(900) > tp(${tp})`,
  );
});

scenario(
  "production source: LONG/SHORT sl/tp formulas in handleCandlePhysicsEntry() match the required exact expressions",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = source.indexOf("private async handleCandlePhysicsEntry(");
    const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
    assert.ok(
      /const\s+sl\s*=\s*event\.victim\s*===\s*"LONG"\s*\?\s*entry\s*\*\s*\(1\s*-\s*FIXED_SL_PCT\)\s*:\s*entry\s*\*\s*\(1\s*\+\s*FIXED_SL_PCT\)/.test(
        body,
      ),
      "SL formula must match exactly: LONG=entry*(1-slPct), SHORT=entry*(1+slPct) -- regex tolerant of Prettier line-wrapping",
    );
    assert.ok(
      /const\s+tp\s*=\s*event\.victim\s*===\s*"LONG"\s*\?\s*entry\s*\+\s*rewardDistance\s*:\s*entry\s*-\s*rewardDistance/.test(
        body,
      ),
      "TP direction must match exactly: LONG adds rewardDistance, SHORT subtracts it -- regex tolerant of Prettier line-wrapping",
    );
    assert.ok(
      /rewardDistance\s*=\s*isRotation\s*\?\s*entry\s*\*\s*v5RotationTpPct\(\)/.test(
        body,
      ),
      "ROTATION TP distance must be the direct config percentage of entry, not re-derived from WAVE mode's own RR -- regex tolerant of Prettier line-wrapping",
    );
  },
);

console.log("\nRunning DirectionalAtrTracker closed-candle-only tests...\n");

scenario(
  "DirectionalAtrTracker rejects an unclosed (forming) candle -- no leakage into ATR state",
  () => {
    const t = new DirectionalAtrTracker();
    t.onCandle({
      symbol: "ETHUSDT",
      openTime: 0,
      high: 100,
      low: 99,
      close: 99.5,
      isClosed: true,
    });
    t.onCandle({
      symbol: "ETHUSDT",
      openTime: 60000,
      high: 110,
      low: 109,
      close: 109.5,
      isClosed: false,
    });
    const downBefore = t.getDownAtr("ETHUSDT");
    t.onCandle({
      symbol: "ETHUSDT",
      openTime: 60000,
      high: 101,
      low: 100,
      close: 100.5,
      isClosed: true,
    });
    const downAfter = t.getDownAtr("ETHUSDT");
    assert.notStrictEqual(
      downBefore,
      downAfter,
      "only the genuinely closed candle should have updated ATR state",
    );
  },
);

scenario(
  "DirectionalAtrTracker: v1 DownTR/UpTR formula matches the research methodology exactly",
  () => {
    const t = new DirectionalAtrTracker();
    t.onCandle({
      symbol: "ETHUSDT",
      openTime: 0,
      high: 100,
      low: 99,
      close: 100,
      isClosed: true,
    });
    t.onCandle({
      symbol: "ETHUSDT",
      openTime: 60000,
      high: 102,
      low: 95,
      close: 98,
      isClosed: true,
    });
    assert.strictEqual(
      t.getDownAtr("ETHUSDT"),
      5,
      "DownTR=max(0,prevClose-low)=max(0,100-95)=5, first real TR seeds the EMA directly",
    );
    assert.strictEqual(
      t.getUpAtr("ETHUSDT"),
      2,
      "UpTR=max(0,high-prevClose)=max(0,102-100)=2",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
