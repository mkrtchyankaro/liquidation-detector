/**
 * V9 replay trade simulation (entry at first poll at/after the decision,
 * SL = episode extreme, TP = rr x risk).
 * Usage: npx tsx tests/v9-replay.test.ts
 */
import * as assert from "assert";
import { simulateTrade, stopForVariant, typicalMinuteRangeBefore, type Poll } from "../src/strategy/v9/v9-replay";

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
scenario("SL sweep: a stop widened x2 survives a dip that hits the current stop, then reaches its own 2.2R TP", () => {
  // entry 100, current SL 99 (1%). Price dips to 98.9 then rallies to 104.5.
  const p = polls([100, 99.5, 98.9, 101, 103, 104.5]);
  const d = { evaluatedAt: 1_000, tradeSide: "LONG" as const, stopPrice: 99 };
  assert.strictEqual(simulateTrade(p, d, 2.2).result, "SL");
  const wide = simulateTrade(p, d, 2.2, (e) => stopForVariant("X2", "LONG", e, 99, 0));
  assert.strictEqual(wide.sl, 98);
  assert.strictEqual(wide.result, "TP", "TP = 100 + 2.2*2 = 104.4");
});
scenario("SL sweep placements (LONG below, SHORT above)", () => {
  assert.strictEqual(stopForVariant("CURRENT", "LONG", 100, 99.9, 0.05), 99.9);
  assert.ok(Math.abs(stopForVariant("MIN_0.33%", "LONG", 100, 99.9, 0.05) - 99.67) < 1e-9, "tight stop widened to 0.33%");
  assert.strictEqual(stopForVariant("MIN_0.33%", "LONG", 100, 99, 0.05), 99, "wide stop unchanged");
  assert.ok(Math.abs(stopForVariant("PLUS_1_MINUTE_RANGE", "SHORT", 100, 101, 0.2) - 101.2) < 1e-9);
  assert.ok(Math.abs(stopForVariant("X1.5", "SHORT", 100, 101, 0) - 101.5) < 1e-9);
});
scenario("typical minute range = mean high-low per minute over the last hour", () => {
  const p: Poll[] = [{ ts: 0, price: 10 }, { ts: 10_000, price: 12 }, { ts: 60_000, price: 11 }, { ts: 70_000, price: 11.5 }];
  assert.ok(Math.abs(typicalMinuteRangeBefore(p, 120_000) - 1.25) < 1e-12);
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
