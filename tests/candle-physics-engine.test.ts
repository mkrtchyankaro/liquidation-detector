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
      0,
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
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 98, 98.5, 0);
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
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95, 2000, 30000),
      1,
      100,
      30000,
    ); // 2nd event, same wave
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 90, 90.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 90.5, 90.6, 90.6, 92, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 92, 92.1, 92.1, 92.5, 0);

    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 92, 50000, 240000),
      1,
      92,
      240000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 91, 30000, 260000),
      1,
      92,
      260000,
    ); // 2nd event, same wave
    e.onClosedCandle("ETHUSDT", "LONG", 240000, 92, 92.1, 89, 89.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 89.5, 89.6, 89.6, 90.2, 0);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      90.2,
      90.3,
      90.3,
      90.6,
      0,
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
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99.5, 10000, 30000),
      1,
      100,
      30000,
    ); // 2nd event, same wave
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 99, 99.2, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 99.2, 99.3, 99.3, 99.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 99.5, 99.6, 99.6, 99.7, 0);

    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99.7, 500, 240000),
      1,
      99.7,
      240000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95, 200, 250000),
      1,
      99.7,
      250000,
    ); // 2nd event, same wave
    e.onClosedCandle("ETHUSDT", "LONG", 240000, 99.7, 99.8, 90, 90.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 90.5, 90.6, 90.6, 91, 0);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      91,
      91.1,
      91.1,
      91.3,
      0,
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
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, 0);
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95.5, 3000, 120000),
      1,
      95.5,
      120000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, 0);
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
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 96.5, 96.6, 90, 90.5, 0);
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
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 96, 2000, 30000),
      1,
      100,
      30000,
    ); // 2nd event, same wave
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 96.5, 96.6, 96.6, 97, 0);

    let result = null;
    for (let t = 240000; t < 180000 + 9 * 60000; t += 60000) {
      result = e.onClosedCandle("ETHUSDT", "LONG", t, 97, 97.1, 96.9, 97, 0);
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
      0,
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
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 96, 2000, 30000),
      1,
      100,
      30000,
    ); // 2nd event, same wave
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 96.5, 96.6, 96.6, 97, 0);

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
      0,
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
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, 0);
    let result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      29 * 60000,
      95.5,
      95.6,
      95,
      95.4,
      0,
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
      0,
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
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95, 20000, 30000),
      1,
      100,
      30000,
    ); // 2nd event, same wave
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 90, 90.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 90.5, 90.6, 90.6, 92, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 92, 92.1, 92.1, 92.5, 0);
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 92, 50000, 240000),
      1,
      92,
      240000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 90, 20000, 250000),
      1,
      92,
      250000,
    ); // 2nd event, same wave
    e.onClosedCandle("ETHUSDT", "LONG", 240000, 92, 92.1, 89, 89.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 89.5, 89.6, 89.6, 90.2, 0);
    const entry = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      90.2,
      90.3,
      90.3,
      90.6,
      0,
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
      0,
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
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, 0);
    assert.strictEqual(e.peekWatch("ETHUSDT", "LONG")!.state, "ACTIVE");
    assert.strictEqual(
      e.peekWatch("ETHUSDT", "SHORT"),
      null,
      "a SHORT-victim liquidation on the same symbol must never touch the LONG watch",
    );
  },
);

// ─── Sep 11 2026 (Karo), operator-requested: single-event waves are discarded ───

scenario(
  "1. single-event first candidate is discarded on natural completion, the NEXT valid multi-event candidate becomes W1 (not W2)",
  () => {
    const e = new CandlePhysicsEngine();
    // Candidate A: exactly 1 event, gets real directional extension (so it tracks
    // normally through ACTIVE/EXHAUSTING), then naturally completes.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 5000, 1000),
      1,
      100,
      1000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, 0); // ACTIVE, waveNumber=1
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, 0); // EXHAUSTING
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 96.5, 96.6, 96.6, 97, 0); // naturally completes, eventCount=1 -> DISCARDED

    const wAfterDiscard = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      wAfterDiscard!.state,
      "NO_WAVE",
      "must return to NO_WAVE, no dominant wave exists yet",
    );
    assert.strictEqual(
      wAfterDiscard!.waveNumber,
      0,
      "waveNumber must be reset back -- Candidate A was never a real, numbered wave",
    );
    assert.strictEqual(
      wAfterDiscard!.dominantWave,
      null,
      "the discarded candidate must never become dominant",
    );
    assert.strictEqual(
      wAfterDiscard!.completedWaves.length,
      0,
      "the discarded candidate must never enter completedWaves",
    );

    // Candidate B: 5 events -- must become W1, not W2.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 97, 1000, 300000),
      1,
      97,
      300000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 96, 1000, 310000),
      1,
      97,
      310000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95, 1000, 320000),
      1,
      97,
      320000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 94, 1000, 330000),
      1,
      97,
      330000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 93, 1000, 340000),
      1,
      97,
      340000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 360000, 97, 97.1, 90, 90.5, 0); // ACTIVE
    const wOpen = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(wOpen!.state, "ACTIVE");
    assert.strictEqual(
      wOpen!.waveNumber,
      1,
      "Candidate B must become W1, NOT W2 -- the discarded candidate never counted",
    );
  },
);

scenario(
  "2. a single-event candidate that appears BETWEEN two already-meaningful waves is discarded without incrementing the wave number -- the next multi-event candidate is still correctly numbered",
  () => {
    const e = new CandlePhysicsEngine();
    // W1: multi-event, meaningful.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 1000, 1000),
      1,
      100,
      1000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99, 1000, 10000),
      1,
      100,
      10000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, 0); // ACTIVE, W1
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, 0); // EXHAUSTING
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 96.5, 96.6, 96.6, 97, 0); // W1 complete, becomes dominant
    let w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(w!.dominantWave!.waveNumber, 1);

    // A single-event noise candidate arrives -- must be discarded, must NOT become "W2".
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 96, 500, 240000),
      1,
      96,
      240000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 97, 97.1, 92, 92.5, 0); // ACTIVE, provisionally "wave 2"
    e.onClosedCandle("ETHUSDT", "LONG", 360000, 92.5, 92.6, 92.6, 93.5, 0); // EXHAUSTING
    e.onClosedCandle("ETHUSDT", "LONG", 420000, 93.5, 93.6, 93.6, 94, 0); // completes, eventCount=1 -> DISCARDED

    w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      w!.state,
      "WAIT_NEXT_PRESSURE",
      "must return to WAIT_NEXT_PRESSURE (a dominant wave already exists)",
    );
    assert.strictEqual(
      w!.waveNumber,
      1,
      "waveNumber must be given back to 1 -- the discarded candidate must not have incremented it to 2",
    );
    assert.strictEqual(
      w!.dominantWave!.waveNumber,
      1,
      "the dominant reference must remain W1, untouched by the discarded candidate",
    );
    assert.strictEqual(
      w!.completedWaves.length,
      1,
      "completedWaves must still contain only the real W1 -- the discarded candidate is not in it",
    );

    // The NEXT real, multi-event candidate must correctly become W2.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 94, 1000, 480000),
      1,
      94,
      480000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 93, 1000, 490000),
      1,
      94,
      490000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 540000, 94, 94.1, 88, 88.5, 0); // ACTIVE
    w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(w!.state, "ACTIVE");
    assert.strictEqual(
      w!.waveNumber,
      2,
      "the next real candidate must correctly become W2, not W3",
    );
  },
);

scenario(
  "3. a candidate with multiple events (>=2) still produces a normal meaningful wave, exactly as before this change",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 1000, 1000),
      1,
      100,
      1000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99, 1000, 10000),
      1,
      100,
      10000,
    ); // exactly 2 events
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, 0); // ACTIVE
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, 0); // EXHAUSTING
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 96.5, 96.6, 96.6, 97, 0); // completes normally

    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(w!.state, "WAIT_NEXT_PRESSURE");
    assert.strictEqual(
      w!.waveNumber,
      1,
      "a real, numbered wave -- NOT discarded",
    );
    assert.ok(w!.dominantWave, "must become the dominant reference");
    assert.strictEqual(w!.dominantWave!.waveNumber, 1);
    assert.strictEqual(
      w!.dominantWave!.totalEvents,
      2,
      "the wave's own totalEvents must correctly reflect both liquidation events",
    );
    assert.strictEqual(w!.completedWaves.length, 1);
  },
);

scenario(
  "4. a discarded single-event candidate can NEVER become dominant or trigger ENTRY, even when it would otherwise have 'won' on efficiency",
  () => {
    const e = new CandlePhysicsEngine();
    // W1: multi-event, meaningful, LOW efficiency (big liq, small progress) -- deliberately easy to "beat".
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 100000, 1000),
      1,
      100,
      1000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99.9, 100000, 10000),
      1,
      100,
      10000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 99, 99.2, 0); // ACTIVE, tiny progress despite huge liq
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 99.2, 99.3, 99.3, 99.5, 0); // EXHAUSTING
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 99.5, 99.6, 99.6, 99.7, 0); // W1 complete (low efficiency), dominant
    const w1Eff = e.peekWatch("ETHUSDT", "LONG")!.dominantWave!.efficiency;

    // A single-event candidate arrives that makes a LARGE new extension (would be
    // very HIGH efficiency, easily "beating" W1's own low efficiency and normally
    // triggering continuation/new-dominant) -- but it is single-event, so it must
    // be discarded BEFORE any efficiency comparison ever happens, and must never
    // reach ENTERED or change the dominant reference.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99.6, 100, 240000),
      1,
      99.6,
      240000,
    ); // exactly 1 event
    const entryAttempt1 = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      300000,
      99.7,
      99.8,
      80,
      80.5,
      0,
    ); // ACTIVE, huge new extension
    assert.strictEqual(entryAttempt1, null);
    const entryAttempt2 = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      80.5,
      80.6,
      80.6,
      81.5,
      0,
    ); // EXHAUSTING
    assert.strictEqual(entryAttempt2, null);
    const entryAttempt3 = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      420000,
      81.5,
      81.6,
      81.6,
      82,
      0,
    ); // completes -- eventCount=1 -> DISCARDED, never compared
    assert.notStrictEqual(
      entryAttempt3?.kind,
      "ENTRY",
      "a discarded single-event candidate must NEVER produce an ENTRY result, no matter how efficient it would have looked",
    );
    assert.strictEqual(
      entryAttempt3?.kind,
      "PRE_W1_DISCARD",
      "the discard itself is now a diagnostic event, not a silent null",
    );

    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      w!.dominantWave!.waveNumber,
      1,
      "the dominant reference must remain the original, real W1",
    );
    assert.strictEqual(
      w!.dominantWave!.efficiency,
      w1Eff,
      "W1's own efficiency value must be completely untouched by the discarded candidate",
    );
    assert.strictEqual(w!.state, "WAIT_NEXT_PRESSURE");
    assert.strictEqual(
      w!.waveNumber,
      1,
      "waveNumber must still be 1 -- the discarded candidate's own number was given back",
    );
  },
);

// ─── Sep 11 2026 (Karo), operator-requested: P95 seriousness-gate support ───
// (the actual P95 COMPARISON lives in market-data-orchestrator.ts, outside
// this pure engine -- these tests prove the engine's own
// maxIndividualEventUsd tracking, the raw ingredient that gate needs, is
// correctly episode-level, individual-event-based, never cumulative.)

scenario(
  "1/2. maxIndividualEventUsd on the ENTRY event correctly reflects the largest SINGLE raw event notional seen anywhere in the episode (not cumulative)",
  () => {
    const e = new CandlePhysicsEngine();
    // Same proven candle-structure as the "two-wave sequence...ENTRY" test above -- only the notional amounts differ.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 90000, 1000),
      1,
      100,
      1000,
    ); // the one large event
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95, 2000, 30000),
      1,
      100,
      30000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 90, 90.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 90.5, 90.6, 90.6, 92, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 92, 92.1, 92.1, 92.5, 0);

    // W2 -- must still end up LESS efficient than W1's own 10u/$92k ratio
    // for physics to reach exhaustion->ENTRY; liq bumped up accordingly
    // (only the RATIO matters here, not realism).
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 92, 20000, 240000),
      1,
      92,
      240000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 91, 20000, 260000),
      1,
      92,
      260000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 240000, 92, 92.1, 89, 89.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 89.5, 89.6, 89.6, 90.2, 0);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      90.2,
      90.3,
      90.3,
      90.6,
      0,
    );

    assert.ok(result && result.kind === "ENTRY");
    if (result?.kind === "ENTRY") {
      assert.strictEqual(
        result.maxIndividualEventUsd,
        90000,
        "must reflect the single largest event ($90k, from W1), NOT the signal wave's own small events, NOT any cumulative sum",
      );
    }
  },
);

scenario(
  "3. cumulative episode liquidity can exceed a hypothetical P95 while every INDIVIDUAL event stays below it -- maxIndividualEventUsd must reflect only the individual max, proving the caller's own gate compares against the right thing",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 9000, 1000),
      1,
      100,
      1000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95, 2000, 30000),
      1,
      100,
      30000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 90, 90.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 90.5, 90.6, 90.6, 92, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 92, 92.1, 92.1, 92.5, 0);

    // W2 -- 5 individual events, none exceeding $9k, cumulative $45k -- deliberately
    // larger than a hypothetical P95 that a single event never reaches.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 92, 9000, 240000),
      1,
      92,
      240000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 91.5, 9000, 250000),
      1,
      92,
      250000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 91, 9000, 260000),
      1,
      92,
      260000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 90.5, 9000, 270000),
      1,
      92,
      270000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 90, 9000, 280000),
      1,
      92,
      280000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 240000, 92, 92.1, 89, 89.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 89.5, 89.6, 89.6, 90.2, 0);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      90.2,
      90.3,
      90.3,
      90.6,
      0,
    );

    assert.ok(result && result.kind === "ENTRY");
    if (result?.kind === "ENTRY") {
      const episodeTotal = result.allWaves.reduce(
        (s, w) => s + w.totalLiqUsd,
        0,
      );
      assert.ok(
        episodeTotal >= 56000,
        "episode total must be meaningfully large (sanity check on the test itself), got " +
          episodeTotal,
      );
      assert.strictEqual(
        result.maxIndividualEventUsd,
        9000,
        "must be the single largest INDIVIDUAL event ($9k), even though cumulative episode liquidity is far larger ($" +
          episodeTotal +
          ")",
      );
    }
  },
);

scenario(
  "4. a single qualifying large event earlier in the episode (even in the dominant wave, not the signal wave) is still correctly reflected in maxIndividualEventUsd at the later, real ENTRY",
  () => {
    const e = new CandlePhysicsEngine();
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 88000, 1000),
      1,
      100,
      1000,
    ); // the one large event, in W1
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95, 2000, 30000),
      1,
      100,
      30000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 90, 90.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 90.5, 90.6, 90.6, 92, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 92, 92.1, 92.1, 92.5, 0);

    // W2 -- the real signal/exhaustion wave, contains nothing near $88k
    // PER EVENT (many smaller events instead, same cumulative liq bump).
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 92, 50000, 240000),
      1,
      92,
      240000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 91.8, 50000, 245000),
      1,
      92,
      245000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 91.6, 50000, 250000),
      1,
      92,
      250000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 91.4, 50000, 255000),
      1,
      92,
      255000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 91.2, 50000, 258000),
      1,
      92,
      258000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 91, 50000, 260000),
      1,
      92,
      260000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 240000, 92, 92.1, 89, 89.5, 0);
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 89.5, 89.6, 89.6, 90.2, 0);
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      90.2,
      90.3,
      90.3,
      90.6,
      0,
    );

    assert.ok(
      result && result.kind === "ENTRY",
      "physics must still reach ENTRY on its own terms",
    );
    if (result?.kind === "ENTRY") {
      assert.strictEqual(
        result.signalWave.waveNumber,
        2,
        "W2 is the signal/exhaustion wave",
      );
      assert.strictEqual(
        result.maxIndividualEventUsd,
        88000,
        "the qualifying $88k event from W1 (NOT the signal wave) must still be visible at the moment of ENTRY -- 'somewhere in the CURRENT episode, before that ENTRY'",
      );
    }
  },
);

scenario(
  "5. single-event-wave discard behavior is completely unaffected by the new maxIndividualEventUsd tracking -- even a LARGE single event still gets its wave discarded",
  () => {
    const e = new CandlePhysicsEngine();
    // A single event, even a huge one, still only counts as ONE event -- its wave must still be discarded.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 500000, 1000),
      1,
      100,
      1000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, 0); // ACTIVE
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, 0); // EXHAUSTING
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 96.5, 96.6, 96.6, 97, 0); // completes, eventCount=1 -> DISCARDED

    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      w!.state,
      "NO_WAVE",
      "must still be discarded regardless of the event's own size",
    );
    assert.strictEqual(w!.waveNumber, 0);
    assert.strictEqual(w!.dominantWave, null);
    // But the episode-level max-event tracker itself is untouched by the discard --
    // it is a completely separate, episode-scoped concern from wave-meaningfulness.
    assert.strictEqual(
      (w as unknown as { episodeMaxIndividualEventUsd: number })
        .episodeMaxIndividualEventUsd,
      500000,
    );
  },
);

// ─── Sep 11 2026 (Karo), operator-requested: P95-based W1 qualification ───
// (P95 ONLY ever gates whether a completed wave may become the FIRST
// meaningful W1 -- never W2/W3/etc., which continue using the existing
// efficiency-vs-dominant comparison completely unaffected.)

scenario(
  "1. multi-event candidate, cumulative liq > P95, but EVERY individual event < P95 -> discarded, no W1",
  () => {
    const e = new CandlePhysicsEngine();
    const P95 = 20000;
    // 3 events: $8k + $7k + $6k = $21k cumulative (> P95), but max individual = $8k (< P95).
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 8000, 1000),
      1,
      100,
      1000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99, 7000, 10000),
      1,
      100,
      10000,
    );
    const r1 = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      60000,
      100,
      100.1,
      95,
      95.5,
      P95,
    ); // ACTIVE
    assert.strictEqual(r1, null);
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 94, 6000, 90000),
      1,
      94,
      90000,
    );
    const r2 = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      120000,
      95.5,
      95.6,
      95.6,
      96.5,
      P95,
    ); // EXHAUSTING
    assert.strictEqual(r2, null);
    const r3 = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      180000,
      96.5,
      96.6,
      96.6,
      97,
      P95,
    ); // completes -- cumulative $21k > P95, but max individual $8k < P95
    assert.ok(r3 && r3.kind === "PRE_W1_DISCARD");
    if (r3?.kind === "PRE_W1_DISCARD") {
      assert.strictEqual(r3.reason, "DISCARDED_NO_P95");
      assert.strictEqual(
        r3.totalLiqUsd,
        21000,
        "cumulative liq must be $21k (sanity check on the test itself)",
      );
      assert.strictEqual(
        r3.maxIndividualEventUsd,
        8000,
        "must compare the MAX INDIVIDUAL event ($8k), never the cumulative sum ($21k)",
      );
    }
    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      w!.dominantWave,
      null,
      "must NOT become W1 despite cumulative liq exceeding P95",
    );
    assert.strictEqual(w!.waveNumber, 0);
  },
);

scenario(
  "2. multi-event candidate with ONE individual event >= P95 -> becomes W1",
  () => {
    const e = new CandlePhysicsEngine();
    const P95 = 20000;
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 25000, 1000),
      1,
      100,
      1000,
    ); // >= P95
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99, 3000, 10000),
      1,
      100,
      10000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, P95);
    const r = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      180000,
      96.5,
      96.6,
      96.6,
      97,
      P95,
    );
    assert.strictEqual(
      r,
      null,
      "becoming W1 is a silent success, not a discard event",
    );
    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.ok(w!.dominantWave, "must become the real, meaningful W1");
    assert.strictEqual(w!.waveNumber, 1);
    assert.strictEqual(w!.p95AtW1Qualification, P95);
    assert.strictEqual(w!.maxIndividualEventUsdAtW1, 25000);
    assert.strictEqual(w!.w1QualificationTs, 180000);
  },
);

scenario(
  "3. several weak completed waves before the first P95-qualifying wave -> ALL discarded, and the qualifying wave becomes W1 (not W3/W4)",
  () => {
    const e = new CandlePhysicsEngine();
    const P95 = 20000;
    // Candidate A: weak, max event $5k.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 5000, 1000),
      1,
      100,
      1000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99, 1000, 10000),
      1,
      100,
      10000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, P95);
    const rA = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      180000,
      96.5,
      96.6,
      96.6,
      97,
      P95,
    );
    assert.strictEqual((rA as any)?.reason, "DISCARDED_NO_P95");

    // Candidate B: also weak, max event $8k.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 97, 8000, 240000),
      1,
      97,
      240000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 96, 1000, 250000),
      1,
      97,
      250000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 97, 97.1, 93, 93.5, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 360000, 93.5, 93.6, 93.6, 94.5, P95);
    const rB = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      420000,
      94.5,
      94.6,
      94.6,
      95,
      P95,
    );
    assert.strictEqual((rB as any)?.reason, "DISCARDED_NO_P95");

    let w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      w!.dominantWave,
      null,
      "still no meaningful W1 after 2 weak candidates",
    );
    assert.strictEqual(w!.waveNumber, 0);

    // Candidate C: qualifies, max event $25k.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95, 25000, 480000),
      1,
      95,
      480000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 90, 2000, 490000),
      1,
      95,
      490000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 540000, 95, 95.1, 88, 88.5, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 600000, 88.5, 88.6, 88.6, 89.5, P95);
    const rC = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      660000,
      89.5,
      89.6,
      89.6,
      90,
      P95,
    );
    assert.strictEqual(rC, null);

    w = e.peekWatch("ETHUSDT", "LONG");
    assert.ok(w!.dominantWave);
    assert.strictEqual(
      w!.waveNumber,
      1,
      "the qualifying wave must become W1, NOT W3 -- the two discarded candidates never counted",
    );
    assert.strictEqual(w!.maxIndividualEventUsdAtW1, 25000);
  },
);

scenario(
  "4. a qualifying W1 alone (no W2 yet) -> NO ENTRY, ever, from W1 by itself",
  () => {
    const e = new CandlePhysicsEngine();
    const P95 = 20000;
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 25000, 1000),
      1,
      100,
      1000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99, 3000, 10000),
      1,
      100,
      10000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, P95);
    const r = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      180000,
      96.5,
      96.6,
      96.6,
      97,
      P95,
    );
    assert.strictEqual(r, null, "W1 qualifying is never itself an ENTRY");
    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      w!.state,
      "WAIT_NEXT_PRESSURE",
      "must be waiting for a second wave, never ENTERED",
    );
  },
);

scenario(
  "5. once a real W1 exists, a LATER wave (W2) is NEVER required to contain a P95 event -- it uses the existing efficiency comparison only",
  () => {
    const e = new CandlePhysicsEngine();
    const P95 = 100000;
    // W1 qualifies (max event $150k >= P95), same proven candle-shape as the base ENTRY test.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 150000, 1000),
      1,
      100,
      1000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95, 3000, 30000),
      1,
      100,
      30000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 90, 90.5, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 90.5, 90.6, 90.6, 92, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 92, 92.1, 92.1, 92.5, P95); // W1 complete, dominant, eff~65

    // W2: two events of $40k each -- well below P95 ($100k), but still enough
    // cumulative liq to genuinely undercut W1's own efficiency (exhaustion).
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 92, 40000, 240000),
      1,
      92,
      240000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 91, 40000, 260000),
      1,
      92,
      260000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 240000, 92, 92.1, 89, 89.5, P95); // ACTIVE
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 89.5, 89.6, 89.6, 90.2, P95); // EXHAUSTING
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      90.2,
      90.3,
      90.3,
      90.6,
      P95,
    );

    assert.ok(
      result && result.kind === "ENTRY",
      "W2 must be allowed to trigger a normal ENTRY even though NO individual event anywhere near P95",
    );
    if (result?.kind === "ENTRY") {
      assert.strictEqual(
        result.signalWave.maxEvent,
        40000,
        "W2's own max individual event ($40k) is well below P95 ($100k) -- proves P95 was never checked for W2",
      );
    }
  },
);

scenario(
  "6. a single-event wave with an individual event >= P95 is STILL discarded by the existing single-event rule (single-event check runs first, unconditionally)",
  () => {
    const e = new CandlePhysicsEngine();
    const P95 = 20000;
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 50000, 1000),
      1,
      100,
      1000,
    ); // single event, $50k >> P95
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, P95);
    const r = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      180000,
      96.5,
      96.6,
      96.6,
      97,
      P95,
    );
    assert.ok(r && r.kind === "PRE_W1_DISCARD");
    if (r?.kind === "PRE_W1_DISCARD")
      assert.strictEqual(
        r.reason,
        "DISCARDED_SINGLE_EVENT",
        "must be discarded for being single-event, NOT reported as a P95 pass/fail",
      );
    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(w!.dominantWave, null);
  },
);

scenario(
  "7. a valid W1 (P95-qualified immediately) remains valid through a full ENTRY, with p95AtW1Qualification/maxIndividualEventUsdAtW1 correctly persisted on the ENTRY event (matches the operator's own ETH LONG example)",
  () => {
    const e = new CandlePhysicsEngine();
    const P95 = 246180;
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 289844, 1000),
      1,
      100,
      1000,
    ); // >= P95, qualifies immediately
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 95, 2000, 30000),
      1,
      100,
      30000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 90, 90.5, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 90.5, 90.6, 90.6, 92, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 180000, 92, 92.1, 92.1, 92.5, P95); // W1 qualifies, eff~34.3

    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 92, 60000, 240000),
      1,
      92,
      240000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 91, 40000, 260000),
      1,
      92,
      260000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 240000, 92, 92.1, 89, 89.5, P95); // ACTIVE
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 89.5, 89.6, 89.6, 90.2, P95); // EXHAUSTING, eff=30 < 34.3
    const result = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      360000,
      90.2,
      90.3,
      90.3,
      90.6,
      P95,
    );

    assert.ok(result && result.kind === "ENTRY");
    if (result?.kind === "ENTRY") {
      assert.strictEqual(result.p95AtW1Qualification, P95);
      assert.strictEqual(result.maxIndividualEventUsdAtW1, 289844);
      assert.strictEqual(result.dominantWave.waveNumber, 1);
    }
  },
);

scenario(
  "8. old pattern (weak W1 + serious W2) -> the weak one is discarded, the serious old-W2 becomes the NEW W1, and there is NO immediate entry",
  () => {
    const e = new CandlePhysicsEngine();
    const P95 = 20000;
    // Old "W1": weak, max event $3k -- gets discarded.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 100, 3000, 1000),
      1,
      100,
      1000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 99, 500, 10000),
      1,
      100,
      10000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, P95);
    const r1 = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      180000,
      96.5,
      96.6,
      96.6,
      97,
      P95,
    );
    assert.strictEqual((r1 as any)?.reason, "DISCARDED_NO_P95");

    // Old "W2": serious, max event $27k -- becomes the NEW W1.
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 97, 27000, 240000),
      1,
      97,
      240000,
    );
    e.onLiquidation(
      "ETHUSDT",
      "LONG",
      liq("ETHUSDT", 90, 2000, 250000),
      1,
      97,
      250000,
    );
    e.onClosedCandle("ETHUSDT", "LONG", 300000, 97, 97.1, 85, 85.5, P95);
    e.onClosedCandle("ETHUSDT", "LONG", 360000, 85.5, 85.6, 85.6, 86.5, P95);
    const r2 = e.onClosedCandle(
      "ETHUSDT",
      "LONG",
      420000,
      86.5,
      86.6,
      86.6,
      87,
      P95,
    );

    assert.strictEqual(
      r2,
      null,
      "must NOT be an immediate entry -- it becomes W1, waiting for its own W2",
    );
    const w = e.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      w!.waveNumber,
      1,
      "the old-W2 must be relabeled/renumbered as the new W1, not accepted as W2",
    );
    assert.strictEqual(w!.maxIndividualEventUsdAtW1, 27000);
    assert.strictEqual(w!.state, "WAIT_NEXT_PRESSURE");
  },
);

// ─── Sep 12 2026 (Karo), operator-requested: BTC_BLOCK redesign --
// getSeriousEpisodeContext() itself (generic, works for any symbol/
// victim; BTC-specificity lives in the caller). ───

scenario(
  "1/3/4. getSeriousEpisodeContext(): ACTIVE, EXHAUSTING, and WAIT_NEXT_PRESSURE all report active+serious once a real W1 exists",
  () => {
    const e = new CandlePhysicsEngine();
    const P95 = 20000;
    e.onLiquidation(
      "BTCUSDT",
      "LONG",
      liq("BTCUSDT", 100, 25000, 1000),
      1,
      100,
      1000,
    );
    e.onLiquidation(
      "BTCUSDT",
      "LONG",
      liq("BTCUSDT", 99, 3000, 10000),
      1,
      100,
      10000,
    );
    e.onClosedCandle("BTCUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, P95); // ACTIVE
    let ctx = e.getSeriousEpisodeContext("BTCUSDT", "LONG")!;
    assert.strictEqual(ctx.phase, "ACTIVE");
    assert.strictEqual(ctx.active, true);
    assert.strictEqual(
      ctx.serious,
      false,
      "not yet -- wave hasn't completed/qualified yet",
    );

    e.onClosedCandle("BTCUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, P95); // EXHAUSTING
    ctx = e.getSeriousEpisodeContext("BTCUSDT", "LONG")!;
    assert.strictEqual(ctx.phase, "EXHAUSTING");

    e.onClosedCandle("BTCUSDT", "LONG", 180000, 96.5, 96.6, 96.6, 97, P95); // W1 qualifies -> WAIT_NEXT_PRESSURE
    ctx = e.getSeriousEpisodeContext("BTCUSDT", "LONG")!;
    assert.strictEqual(ctx.phase, "WAIT_NEXT_PRESSURE");
    assert.strictEqual(ctx.active, true);
    assert.strictEqual(
      ctx.serious,
      true,
      "dominantWave is now set -- reused, never recomputed",
    );
    assert.strictEqual(ctx.victim, "LONG");
    assert.strictEqual(ctx.maxIndividualEventUsd, 25000);
    assert.strictEqual(ctx.p95AtQualification, P95);
    assert.strictEqual(ctx.eventCount, 2);
  },
);

scenario(
  "2/6. getSeriousEpisodeContext(): NO_WAVE (no meaningful W1 yet) is active but never serious, even with real liquidation activity",
  () => {
    const e = new CandlePhysicsEngine();
    const P95 = 20000;
    // Small liquidation, well below P95 -- discarded as pre-W1-weak.
    e.onLiquidation(
      "BTCUSDT",
      "SHORT",
      liq("BTCUSDT", 100, 500, 1000),
      1,
      100,
      1000,
    );
    e.onLiquidation(
      "BTCUSDT",
      "SHORT",
      liq("BTCUSDT", 101, 300, 10000),
      1,
      100,
      10000,
    );
    e.onClosedCandle("BTCUSDT", "SHORT", 60000, 100, 105, 100, 104.5, P95);
    e.onClosedCandle("BTCUSDT", "SHORT", 120000, 104.5, 104.6, 104, 104.2, P95);
    e.onClosedCandle(
      "BTCUSDT",
      "SHORT",
      180000,
      104.2,
      104.3,
      104.2,
      104.1,
      P95,
    ); // discarded, NO_WAVE
    const ctx = e.getSeriousEpisodeContext("BTCUSDT", "SHORT")!;
    assert.strictEqual(ctx.phase, "NO_WAVE");
    assert.strictEqual(
      ctx.serious,
      false,
      "no dominantWave -- never considered serious even with real liquidation activity",
    );
  },
);

scenario(
  "5. getSeriousEpisodeContext(): TERMINAL_CANCELLED is never active/serious -- the engine's own existing inactivity timeout clears stale state",
  () => {
    const e = new CandlePhysicsEngine();
    const P95 = 20000;
    e.onLiquidation(
      "BTCUSDT",
      "LONG",
      liq("BTCUSDT", 100, 25000, 0),
      1,
      100,
      0,
    );
    e.onLiquidation(
      "BTCUSDT",
      "LONG",
      liq("BTCUSDT", 99, 3000, 30000),
      1,
      100,
      30000,
    );
    e.onClosedCandle("BTCUSDT", "LONG", 60000, 100, 100.1, 95, 95.5, P95);
    e.onClosedCandle("BTCUSDT", "LONG", 120000, 95.5, 95.6, 95.6, 96.5, P95);
    e.onClosedCandle("BTCUSDT", "LONG", 180000, 96.5, 96.6, 96.6, 97, P95); // W1 qualifies, WAIT_NEXT_PRESSURE
    // 11 minutes of pure silence -- past the 10-min inactivity timeout.
    for (let t = 240000; t <= 780000; t += 60000) {
      e.onClosedCandle("BTCUSDT", "LONG", t, 97, 97, 97, 97, P95);
    }
    const ctx = e.getSeriousEpisodeContext("BTCUSDT", "LONG")!;
    assert.strictEqual(ctx.phase, "TERMINAL_CANCELLED");
    assert.strictEqual(
      ctx.active,
      false,
      "TERMINAL_CANCELLED must never be reported as active, regardless of serious",
    );
  },
);

scenario(
  "getSeriousEpisodeContext(): returns null when no watch exists for that symbol/victim at all",
  () => {
    const e = new CandlePhysicsEngine();
    assert.strictEqual(e.getSeriousEpisodeContext("BTCUSDT", "LONG"), null);
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
