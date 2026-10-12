/**
 * V11 settings ("v11" in users.config.json): defaults = the tested values, per-user overrides, typos fail fast.
 * Usage: npx tsx tests/v11-config.test.ts
 */
import * as assert from "assert";
import { parseV11Settings, v11RulesFor } from "../src/strategy/v11/v11-config";
import { DEFAULT_V11_RULE } from "../src/strategy/v11/v11-engine";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const USERS = ["main", "karo"], SYMS = ["BTCUSDT", "ETHUSDT", "XRPUSDT"];
const p = (o: Record<string, unknown>) => parseV11Settings({ enabled: true, ...o }, USERS, SYMS);

console.log("V11 config");
scenario("absent block -> disabled, nobody trades", () => {
  const s = parseV11Settings(undefined, USERS, SYMS);
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.userModes.size, 0);
});
scenario("minimal block -> the tested defaults: SHORT only, 2R, wick high, all rally types, 48 h, every collected coin", () => {
  const s = p({});
  assert.deepStrictEqual([s.short, s.long, s.tpR, s.slBufferPct, s.meaningfulOnly, s.timeoutHours, s.maxOpen, s.riskUsd], [true, false, 2, 0, false, 48, null, null]);
  assert.deepStrictEqual(s.rallyTypes, ["T1", "T2", "FLAT"]);
  assert.deepStrictEqual(s.symbols, SYMS);
  assert.deepStrictEqual(s.rule, DEFAULT_V11_RULE);
});
scenario("disabled block is still fully checked (a typo is found before the day it is switched on)", () => {
  assert.throws(() => parseV11Settings({ enabled: false, tpr: 2 }, USERS, SYMS), /"v11.tpr" is not a known setting/);
  const s = parseV11Settings({ enabled: false, tpR: 3, userModes: { main: "PAPER" } }, USERS, SYMS);
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.tpR, 3);
});
scenario("perUser overrides only what it names; null switches a limit off", () => {
  const s = p({ tpR: 2.5, maxRiskPct: 4, perUser: { karo: { tpR: 2, rallyTypes: ["T1"], riskUsd: 1, maxRiskPct: null, timeoutHours: null, maxOpen: 2 } } });
  const k = v11RulesFor(s, "karo"), m = v11RulesFor(s, "main");
  assert.deepStrictEqual([k.tpR, k.rallyTypes, k.riskUsd, k.maxRiskPct, k.timeoutHours, k.maxOpen, k.short], [2, ["T1"], 1, null, null, 2, true]);
  assert.deepStrictEqual([m.tpR, m.rallyTypes.length, m.riskUsd, m.maxRiskPct, m.timeoutHours, m.maxOpen], [2.5, 3, null, 4, 48, null]);
});
scenario("rule overrides: liqPercentile 90 -> 0.9, confirmCandles 1", () => {
  const s = p({ rule: { liqPercentile: 90, confirmCandles: 1, minLiqUsd: 50_000 } });
  assert.strictEqual(s.rule.liqPct, 0.9);
  assert.strictEqual(s.rule.confirmCandles, 1);
  assert.strictEqual(s.rule.minLiqUsd, 50_000);
  assert.strictEqual(s.rule.rallyHours, 6);
});
scenario("symbols / excludeSymbols: must be collected; excluded ones removed", () => {
  assert.deepStrictEqual(p({ excludeSymbols: ["btcusdt"] }).symbols, ["ETHUSDT", "XRPUSDT"]);
  assert.deepStrictEqual(p({ symbols: ["xrpusdt", "ETHUSDT"] }).symbols, ["XRPUSDT", "ETHUSDT"]);
  assert.throws(() => p({ symbols: ["DOGEUSDT"] }), /does not collect data/);
});
scenario("bad values fail with a clear message", () => {
  assert.throws(() => p({ tpR: 0 }), /tpR/);
  assert.throws(() => p({ tpR: "2" }), /tpR/);
  assert.throws(() => p({ short: "yes" }), /short/);
  assert.throws(() => p({ rallyTypes: ["T3"] }), /rallyTypes/);
  assert.throws(() => p({ rallyTypes: [] }), /rallyTypes/);
  assert.throws(() => p({ minRiskPct: 2, maxRiskPct: 1 }), /minRiskPct/);
  assert.throws(() => p({ maxOpen: 1.5 }), /maxOpen/);
  assert.throws(() => p({ rule: { confirmCandles: 3 } }), /confirmCandles/);
  assert.throws(() => p({ rule: { foo: 1 } }), /v11.rule.foo/);
  assert.throws(() => p({ userModes: { bob: "PAPER" } }), /unknown user "bob"/);
  assert.throws(() => p({ userModes: { main: "LIVE" } }), /"OFF", "PAPER" or "REAL"/);
  assert.throws(() => p({ perUser: { karo: { slPct: 1 } } }), /v11.perUser.karo.slPct/);
  assert.throws(() => p({ perUser: { karo: { minRiskPct: 3 } }, maxRiskPct: 2 }), /minRiskPct/);
  assert.throws(() => parseV11Settings({ enabled: "true" }, USERS, SYMS), /enabled/);
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
