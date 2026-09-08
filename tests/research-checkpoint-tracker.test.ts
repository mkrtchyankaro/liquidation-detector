/**
 * Sep 8 2026 (Karo). Pure-logic tests for ResearchCheckpointTracker --
 * zero I/O, zero Mongo, zero user/execution dependency (proves
 * "research checkpoints work without a user/Binance execution" and
 * "no-entry episodes can receive research observations" directly, at
 * the unit level).
 */
import * as assert from "assert";
import { ResearchCheckpointTracker } from "../src/domain/signal/research-checkpoint-tracker";

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

console.log("Running ResearchCheckpointTracker tests...\n");

scenario(
  "SIGNAL anchor: R-normalized mfe/mae computed correctly at 30s, no user or execution involved",
  () => {
    const t = new ResearchCheckpointTracker();
    const anchorTs = 1_000_000;
    // entry=100, sl=99 -> denom(R)=1, dirMul=+1 (LONG)
    t.registerWatch("sig-1", "ETHUSDT", "SIGNAL", anchorTs, 100, {
      kind: "R",
      dirMul: 1,
      denom: 1,
    });

    // price climbs to 100.5 by t+31s -- best=100.5, worst stays 100 (never dipped below anchor)
    const out = t.onTick("ETHUSDT", 100.5, anchorTs + 31_000);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0]!.checkpoint.offsetLabel, "30s");
    assert.strictEqual(out[0]!.checkpoint.normalization, "R");
    assert.ok(
      Math.abs(out[0]!.checkpoint.mfe - 0.5) < 1e-9,
      `expected mfe~0.5, got ${out[0]!.checkpoint.mfe}`,
    );
    assert.strictEqual(out[0]!.checkpoint.mae, 0);
    assert.strictEqual(out[0]!.done, false);
  },
);

scenario(
  "EXHAUSTION_CANDIDATE anchor (no signal fired): ATR-normalized, ONLY requires symbol+price, no signalId tied to any user",
  () => {
    const t = new ResearchCheckpointTracker();
    const anchorTs = 2_000_000;
    // anchor=50000, atrAbs=100 -> denom(ATR)=100, dirMul=-1 (SHORT episode)
    t.registerWatch(
      "sig-2",
      "BTCUSDT",
      "EXHAUSTION_CANDIDATE",
      anchorTs,
      50000,
      { kind: "ATR", dirMul: -1, denom: 100 },
    );
    // price DROPS to 49800 (favorable for a SHORT) by t+61s
    const out = t.onTick("BTCUSDT", 49800, anchorTs + 61_000);
    // Should fire BOTH 30s and 1m (sparse ticks can cross multiple offsets at once)
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0]!.checkpoint.offsetLabel, "30s");
    assert.strictEqual(out[1]!.checkpoint.offsetLabel, "1m");
    assert.strictEqual(out[0]!.checkpoint.normalization, "ATR");
    // dirMul=-1, price dropped 200 -> mfe = (50000-49800)*-1... let's verify sign via direct formula:
    // mfe = (bestPrice - anchor) * dirMul / denom = (49800-50000)*(-1)/100 = 2.0 (favorable, correct)
    assert.ok(
      Math.abs(out[0]!.checkpoint.mfe - 2.0) < 1e-9,
      `expected mfe~2.0, got ${out[0]!.checkpoint.mfe}`,
    );
  },
);

scenario(
  "EPISODE_END anchor works identically -- no entry, no user, purely a market observation",
  () => {
    const t = new ResearchCheckpointTracker();
    const anchorTs = 3_000_000;
    t.registerWatch("sig-3", "SOLUSDT", "EPISODE_END", anchorTs, 150, {
      kind: "ATR",
      dirMul: 1,
      denom: 2,
    });
    const out = t.onTick("SOLUSDT", 151, anchorTs + 30_000);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0]!.group.anchorType, "EPISODE_END");
  },
);

scenario(
  "Sparse fixed offsets only: exactly 5 checkpoints total, none in between, watch auto-removed when done",
  () => {
    const t = new ResearchCheckpointTracker();
    const anchorTs = 4_000_000;
    t.registerWatch("sig-4", "ETHUSDT", "SIGNAL", anchorTs, 100, {
      kind: "R",
      dirMul: 1,
      denom: 1,
    });
    assert.strictEqual(t.activeWatchCount, 1);

    // Jump straight to 61 minutes -- all 5 offsets (30s,1m,5m,15m,60m) should fire in one call
    const out = t.onTick("ETHUSDT", 101, anchorTs + 61 * 60_000);
    assert.strictEqual(out.length, 5);
    assert.deepStrictEqual(
      out.map((o) => o.checkpoint.offsetLabel),
      ["30s", "1m", "5m", "15m", "60m"],
    );
    assert.strictEqual(out[4]!.done, true);
    assert.strictEqual(t.activeWatchCount, 0); // cleaned up automatically
  },
);

scenario(
  "Different symbol's tick never advances another symbol's watch",
  () => {
    const t = new ResearchCheckpointTracker();
    t.registerWatch("sig-5", "ETHUSDT", "SIGNAL", 5_000_000, 100, {
      kind: "R",
      dirMul: 1,
      denom: 1,
    });
    const out = t.onTick("BTCUSDT", 99999, 5_100_000); // wrong symbol, far enough in time to have fired if it were ETHUSDT
    assert.strictEqual(out.length, 0);
    assert.strictEqual(t.activeWatchCount, 1); // still there, untouched
  },
);

scenario(
  "registerWatch is a no-op for a duplicate signalId -- SIGNAL never double-tracked alongside a prior EXHAUSTION_CANDIDATE for the same episode",
  () => {
    const t = new ResearchCheckpointTracker();
    t.registerWatch(
      "sig-6",
      "ETHUSDT",
      "EXHAUSTION_CANDIDATE",
      6_000_000,
      100,
      { kind: "ATR", dirMul: 1, denom: 5 },
    );
    t.registerWatch("sig-6", "ETHUSDT", "SIGNAL", 6_000_000, 100, {
      kind: "R",
      dirMul: 1,
      denom: 1,
    }); // ignored
    assert.strictEqual(t.activeWatchCount, 1);
    const out = t.onTick("ETHUSDT", 100, 6_030_000);
    assert.strictEqual(out[0]!.group.anchorType, "EXHAUSTION_CANDIDATE"); // first registration wins
  },
);

scenario(
  "Zero/negative denominator is refused -- never produces Infinity/NaN checkpoints",
  () => {
    const t = new ResearchCheckpointTracker();
    t.registerWatch("sig-7", "ETHUSDT", "SIGNAL", 7_000_000, 100, {
      kind: "R",
      dirMul: 1,
      denom: 0,
    });
    assert.strictEqual(t.activeWatchCount, 0);
  },
);

scenario(
  "Stale watch (older than max age) is silently dropped, never leaks memory forever",
  () => {
    const t = new ResearchCheckpointTracker();
    t.registerWatch("sig-8", "ETHUSDT", "SIGNAL", 8_000_000, 100, {
      kind: "R",
      dirMul: 1,
      denom: 1,
    });
    const out = t.onTick("ETHUSDT", 100, 8_000_000 + 91 * 60_000); // 91 minutes later, past MAX_WATCH_AGE_MS
    assert.strictEqual(out.length, 0);
    assert.strictEqual(t.activeWatchCount, 0);
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
