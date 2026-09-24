/**
 * V9 settings validation: absent -> off; typos fail fast with clear text.
 * Usage: npx tsx tests/v9-config.test.ts
 */
import * as assert from "assert";
import { parseV9Settings } from "../src/strategy/v9/v9-config";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const users = ["main", "karo", "artak"], syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const ok = { enabled: true, symbols: ["btcusdt", "ETHUSDT"], rr: 2.2, userModes: { main: "PAPER", karo: "REAL" } };

console.log("V9 config");
scenario("absent block or enabled=false -> V9 off", () => {
  assert.strictEqual(parseV9Settings(undefined, users, syms).enabled, false);
  assert.strictEqual(parseV9Settings({ enabled: false }, users, syms).enabled, false);
});
scenario("valid block parses; symbols normalised; unlisted users are OFF", () => {
  const s = parseV9Settings(ok, users, syms);
  assert.deepStrictEqual(s.symbols, ["BTCUSDT", "ETHUSDT"]);
  assert.strictEqual(s.userModes.get("karo"), "REAL");
  assert.strictEqual(s.userModes.get("artak"), undefined);
});
scenario("mode typo fails fast", () => assert.throws(() => parseV9Settings({ ...ok, userModes: { karo: "real" } }, users, syms), /must be "OFF", "PAPER" or "REAL"/));
scenario("unknown user fails fast", () => assert.throws(() => parseV9Settings({ ...ok, userModes: { bob: "PAPER" } }, users, syms), /unknown user/));
scenario("symbol without collected data fails fast", () => assert.throws(() => parseV9Settings({ ...ok, symbols: ["XRPUSDT"] }, users, syms), /does not collect data/));
scenario("enabled as a string fails fast", () => assert.throws(() => parseV9Settings({ enabled: "true" }, users, syms), /must be true or false/));
scenario("bad rr fails fast", () => assert.throws(() => parseV9Settings({ ...ok, rr: "2.2" }, users, syms), /rr/));
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
