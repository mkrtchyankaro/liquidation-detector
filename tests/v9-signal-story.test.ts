/**
 * Signal story rows: per-minute joins of liquidations, OI, live timeline,
 * positioning and markers.
 * Usage: npx tsx tests/v9-signal-story.test.ts
 */
import * as assert from "assert";
import { buildStory } from "../src/strategy/v9/v9-signal-story";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const M = 60_000, T = 1_790_000_000_000 - (1_790_000_000_000 % M);
console.log("V9 signal story");
scenario("joins everything per minute", () => {
  const rows = buildStory({
    from: T, to: T + 11 * M,
    liquidations: [{ ts: T + 5_000, victim: "LONG", usd: 100 }, { ts: T + 50_000, victim: "LONG", usd: 50 }, { ts: T + M + 1, victim: "SHORT", usd: 7 }],
    oi: [{ ts: T + 1_000, oi: 100, price: 10 }, { ts: T + 59_000, oi: 101, price: 10.5 }, { ts: T + 2 * M, oi: 99, price: 9 }],
    timeline: [{ ts: T + 2 * M + 10_000, oiPhase: "OI_FALLING", forming: { victim: "LONG", parts: 2, start: T } }],
    positioning: [{ ts: T, globalLongPct: 60, topPositionsLongPct: 70 }, { ts: T + 5 * M, globalLongPct: 55 }],
    markers: [{ ts: T + 2 * M + 10_000, label: "CONFIRM" }],
  });
  assert.strictEqual(rows.length, 12);
  assert.strictEqual(rows[0].longLiqUsd, 150);
  assert.strictEqual(rows[1].shortLiqUsd, 7);
  assert.strictEqual(rows[0].oi, 101, "last poll of the minute wins");
  assert.ok(Math.abs(rows[2].oiChangePct! - ((99 - 101) / 101) * 100) < 1e-12);
  assert.strictEqual(rows[2].livePhase, "FALLING");
  assert.ok(rows[2].liveEpisode.startsWith("LONG x2 since"));
  assert.deepStrictEqual(rows[2].markers, ["CONFIRM"]);
  assert.strictEqual(rows[4].globalLongPct, 60, "positioning carried inside its 5-min period");
  assert.strictEqual(rows[5].globalLongPct, 55);
  assert.strictEqual(rows[5].topPositionsLongPct, null);
  assert.strictEqual(rows[11].globalLongPct, null, "not carried beyond its period");
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
