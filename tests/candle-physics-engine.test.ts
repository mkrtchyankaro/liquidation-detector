import * as assert from "assert";
import { CandlePhysicsEngine } from "../src/domain/cascade/candle-physics-engine";
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

console.log("Running candle-physics-engine tests...\n");

scenario(
  "first liquidation + zero-extension closed candle -> stays NO_WAVE, never a permanent invalid state",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 5000, 1000),
      1,
      100,
      1000,
    );
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      100,
      100.5,
      100,
      100.2,
    );
    assert.strictEqual(result, null);
    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(w!.state, "NO_WAVE");
    assert.strictEqual(w!.waveNumber, 0);
  },
);

scenario(
  "liquidation + real directional extension -> promoted to ACTIVE, wave 1",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 5000, 1000),
      1,
      100,
      1000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 98, 98.5);
    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(w!.state, "ACTIVE");
    assert.strictEqual(w!.waveNumber, 1);
  },
);

scenario(
  "two-wave sequence, W2 efficiency < W1 -> immediate ENTRY (no re-attack test, matching --no-extreme-test)",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 5000, 1000),
      1,
      100,
      1000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 90, 90.5);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 90.5, 90.6, 90.6, 92);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 92, 92.1, 92.1, 92.5);

    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 92, 50000, 240000),
      1,
      92,
      240000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 240000, 92, 92.1, 89, 89.5);
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 89.5, 89.6, 89.6, 90.2);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      90.2,
      90.3,
      90.3,
      90.6,
    );

    assert.ok(result && result.kind === "ENTRY", "must be an ENTRY event");
    if (result?.kind === "ENTRY") {
      assert.strictEqual(result.entryPrice, 90.6);
      assert.strictEqual(result.signalWave.waveNumber, 2);
      assert.strictEqual(result.dominantWave.waveNumber, 1);
    }
  },
);

scenario(
  "continuation (W2 efficiency >= W1) -> W2 becomes new dominant, NO entry, stays WAIT_NEXT_PRESSURE",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 50000, 1000),
      1,
      100,
      1000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 99, 99.2);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 99.2, 99.3, 99.3, 99.5);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 99.5, 99.6, 99.6, 99.7);

    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99.7, 500, 240000),
      1,
      99.7,
      240000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 240000, 99.7, 99.8, 90, 90.5);
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 90.5, 90.6, 90.6, 91);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      91,
      91.1,
      91.1,
      91.3,
    );

    assert.strictEqual(
      result,
      null,
      "continuation must never itself be a terminal result",
    );
    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(w!.state, "WAIT_NEXT_PRESSURE");
    assert.strictEqual(
      w!.dominantWave!.waveNumber,
      2,
      "W2 must become the new dominant reference",
    );
  },
);

scenario(
  "EXHAUSTING reverts to ACTIVE if a new extreme is made again -- the wave was NOT really complete",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 5000, 1000),
      1,
      100,
      1000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5);
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95.5, 3000, 120000),
      1,
      95.5,
      120000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5);
    let w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(w!.state, "EXHAUSTING");

    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 96.5, 8000, 180000),
      1,
      96.5,
      180000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 96.5, 96.6, 90, 90.5);
    w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      w!.state,
      "ACTIVE",
      "must revert to ACTIVE, the wave was not really complete",
    );
    assert.strictEqual(w!.waveNumber, 1, "still the SAME wave, not a new one");
  },
);

scenario(
  "WAIT_NEXT_PRESSURE for >=10 minutes with no new liquidation -> EPISODE_EXPIRED_INACTIVITY, never an entry",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation("ETHUSDT", "LONG", liq("ETHUSDT", 100, 5000, 0), 1, 100, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 96.5, 96.6, 96.6, 97);

    let result = null;
    for (let t = 240000; t < 180000 + 9 * 60000; t += 60000) {
      result = e.onClosedCandle("ETHUSDT", "LONG", t, 97, 97.1, 96.9, 97);
      assert.strictEqual(
        result,
        null,
        "must not terminate before the full 10-minute window",
      );
    }
    result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      180000 + 10 * 60000,
      97,
      97.1,
      96.9,
      97,
    );
    assert.ok(result && result.kind === "CANCEL");
    if (result?.kind === "CANCEL")
      assert.strictEqual(result.reason, "EPISODE_EXPIRED_INACTIVITY");
  },
);

scenario(
  "new same-side liquidation BEFORE the 10-minute inactivity window resets the wait -- no premature cancel",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation("ETHUSDT", "LONG", liq("ETHUSDT", 100, 5000, 0), 1, 100, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 96.5, 96.6, 96.6, 97);

    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 97, 4000, 300000),
      1,
      97,
      300000,
    );
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      300000,
      97,
      97.1,
      94,
      94.5,
    );
    assert.strictEqual(result, null);
    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(w!.state, "ACTIVE");
    assert.strictEqual(
      w!.waveNumber,
      2,
      "a fresh wave must have opened, the episode was never cancelled",
    );
  },
);

scenario(
  "hard 30-minute safety timeout from episode start -> EPISODE_EXPIRED_SAFETY_TIMEOUT, even mid-ACTIVE-wave, never forces an entry",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation("ETHUSDT", "LONG", liq("ETHUSDT", 100, 5000, 0), 1, 100, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5);
    let result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      29 * 60000,
      95.5,
      95.6,
      95,
      95.4,
    );
    assert.notStrictEqual(result?.kind, "CANCEL");
    result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      30 * 60000,
      95.4,
      95.5,
      90,
      90.5,
    );
    assert.ok(result && result.kind === "CANCEL");
    if (result?.kind === "CANCEL")
      assert.strictEqual(result.reason, "EPISODE_EXPIRED_SAFETY_TIMEOUT");
    assert.notStrictEqual(
      result?.kind,
      "ENTRY",
      "a timeout must NEVER itself produce an entry",
    );
  },
);

scenario(
  "clearTerminal() releases an ENTERED watch, allowing a completely fresh episode to start immediately",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 50000, 1000),
      1,
      100,
      1000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 90, 90.5);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 90.5, 90.6, 90.6, 92);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 92, 92.1, 92.1, 92.5);
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 92, 50000, 240000),
      1,
      92,
      240000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 240000, 92, 92.1, 89, 89.5);
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 89.5, 89.6, 89.6, 90.2);
    const entry = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      90.2,
      90.3,
      90.3,
      90.6,
    );
    assert.strictEqual(entry?.kind, "ENTRY");
    assert.strictEqual(e.peekWatch("ETHUSDT", "LONG")!.state, "ENTERED");

    e.clearTerminal("ETHUSDT", "LONG");
    assert.strictEqual(
      e.peekWatch("ETHUSDT", "LONG"),
      null,
      "must be fully released -- no orphan ENTERED watch left behind",
    );

    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 90.6, 3000, 400000),
      1,
      90.6,
      400000,
    );
    const fresh = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      420000,
      90.6,
      90.7,
      88,
      88.5,
    );
    assert.strictEqual(fresh, null);
    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      w!.waveNumber,
      1,
      "must be a genuinely fresh episode, wave numbering reset",
    );
  },
);

scenario(
  "LONG and SHORT watches on the same symbol are completely independent",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 5000, 1000),
      1,
      100,
      1000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5);
    assert.strictEqual(e.peekWatch("ETHUSDT", "LONG")!.state, "ACTIVE");
    assert.strictEqual(
      e.peekWatch("ETHUSDT", "SHORT"),
      null,
      "a SHORT-victim liquidation on the same symbol must never touch the LONG watch",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
