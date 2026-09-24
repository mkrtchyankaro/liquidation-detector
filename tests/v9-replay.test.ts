/**
 * V9 replay trade simulation (entry at first poll at/after the decision,
 * SL = episode extreme, TP = rr x risk).
 * Usage: npx tsx tests/v9-replay.test.ts
 */
import * as assert from "assert";
import { simulateTrade, type Poll } from "../src/strategy/v9/v9-replay";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const polls = (prices: number[]): Poll[] => prices.map((price, i) => ({ ts: 1_000 + i * 1_000, price }));

console.log("V9 replay simulation");
scenario("BUY: TP at entry + 2.2R", () => {
  const t = simulateTrade(polls([100, 100.5, 101, 102.3]), { evaluatedAt: 1_000, tradeSide: "LONG", stopPrice: 99 }, 2.2);
  assert.strictEqual(t.result, "TP"); assert.strictEqual(t.r, 2.2); assert.ok(Math.abs(t.tp! - 102.2) < 1e-9);
});
scenario("BUY: SL when price reaches the episode low", () => {
  const t = simulateTrade(polls([100, 99.5, 99]), { evaluatedAt: 1_000, tradeSide: "LONG", stopPrice: 99 }, 2.2);
  assert.strictEqual(t.result, "SL"); assert.strictEqual(t.r, -1);
});
scenario("SELL: mirror image", () => {
  assert.strictEqual(simulateTrade(polls([100, 99, 97.7]), { evaluatedAt: 1_000, tradeSide: "SHORT", stopPrice: 101 }, 2.2).result, "TP");
  assert.strictEqual(simulateTrade(polls([100, 100.5, 101]), { evaluatedAt: 1_000, tradeSide: "SHORT", stopPrice: 101 }, 2.2).result, "SL");
});
scenario("entry already beyond SL -> NO_RISK (never counted as a trade)", () => {
  assert.strictEqual(simulateTrade(polls([98.9, 100]), { evaluatedAt: 1_000, tradeSide: "LONG", stopPrice: 99 }, 2.2).result, "NO_RISK");
});
scenario("entry is the first poll AT/AFTER the decision time (no earlier price)", () => {
  const t = simulateTrade(polls([50, 100, 102.2]), { evaluatedAt: 1_500, tradeSide: "LONG", stopPrice: 99 }, 2.2);
  assert.strictEqual(t.entry, 100);
});
scenario("neither hit -> OPEN", () => {
  assert.strictEqual(simulateTrade(polls([100, 100.2, 99.9]), { evaluatedAt: 1_000, tradeSide: "LONG", stopPrice: 99 }, 2.2).result, "OPEN");
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
