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
scenario("maxOpenPerUser: absent = no limit; {karo:2} parsed; unknown user / bad number fail fast", () => {
  assert.strictEqual(parseV9Settings(ok, users, syms).maxOpenPerUser.size, 0);
  const s = parseV9Settings({ ...ok, maxOpenPerUser: { karo: 2, artak: 2 } }, users, syms);
  assert.strictEqual(s.maxOpenPerUser.get("karo"), 2);
  assert.strictEqual(s.maxOpenPerUser.get("main"), undefined);
  assert.throws(() => parseV9Settings({ ...ok, maxOpenPerUser: { bob: 2 } }, users, syms), /unknown user/);
  assert.throws(() => parseV9Settings({ ...ok, maxOpenPerUser: { karo: 0 } }, users, syms), /whole number/);
  assert.throws(() => parseV9Settings({ ...ok, maxOpenPerUser: { karo: 1.5 } }, users, syms), /whole number/);
  assert.throws(() => parseV9Settings({ ...ok, maxOpenPerUser: { karo: "2" } }, users, syms), /whole number/);
  assert.throws(() => parseV9Settings({ ...ok, maxOpenPerUser: [2] }, users, syms), /must be an object/);
});
scenario("rrPerUser / minStopPerUser: parsed per user, absent = global; bad values fail fast", () => {
  const s = parseV9Settings({ ...ok, rrPerUser: { karo: 1.5, main: 2.2 }, minStopPerUser: { karo: 0.7 } }, users, syms);
  assert.strictEqual(s.rrPerUser.get("karo"), 1.5);
  assert.strictEqual(s.rrPerUser.get("artak"), undefined);
  assert.strictEqual(s.minStopPerUser.get("karo"), 0.7);
  assert.strictEqual(parseV9Settings(ok, users, syms).rrPerUser.size, 0);
  assert.throws(() => parseV9Settings({ ...ok, rrPerUser: { karo: 0 } }, users, syms), /between 0.5 and 20/);
  assert.throws(() => parseV9Settings({ ...ok, rrPerUser: { bob: 1.5 } }, users, syms), /unknown user/);
  assert.throws(() => parseV9Settings({ ...ok, minStopPerUser: { karo: -1 } }, users, syms), /percent between 0 and 10/);
  assert.throws(() => parseV9Settings({ ...ok, minStopPerUser: { karo: "0.7" } }, users, syms), /percent/);
});
scenario("profitLock: off by default; toR defaults to atR; atR must be below rr; toR <= atR", () => {
  assert.strictEqual(parseV9Settings(ok, users, syms).profitLock, null);
  assert.deepStrictEqual(parseV9Settings({ ...ok, profitLock: { atR: 1.5 } }, users, syms).profitLock, { atR: 1.5, toR: 1.5 });
  assert.deepStrictEqual(parseV9Settings({ ...ok, profitLock: { atR: 1.5, toR: 1 } }, users, syms).profitLock, { atR: 1.5, toR: 1 });
  assert.throws(() => parseV9Settings({ ...ok, profitLock: { atR: 2.2 } }, users, syms), /below "v9.rr"/);
  assert.throws(() => parseV9Settings({ ...ok, profitLock: { atR: 1.5, toR: 1.6 } }, users, syms), /not above atR/);
  assert.throws(() => parseV9Settings({ ...ok, profitLock: { atR: "1.5" } }, users, syms), /atR/);
  assert.throws(() => parseV9Settings({ ...ok, profitLock: 1.5 }, users, syms), /must be an object/);
  assert.throws(() => parseV9Settings({ ...ok, rrPerUser: { karo: 1.5 }, profitLock: { atR: 1.5 } }, users, syms), /rrPerUser.karo/);
});
scenario("mode typo fails fast", () => assert.throws(() => parseV9Settings({ ...ok, userModes: { karo: "real" } }, users, syms), /must be "OFF", "PAPER" or "REAL"/));
scenario("unknown user fails fast", () => assert.throws(() => parseV9Settings({ ...ok, userModes: { bob: "PAPER" } }, users, syms), /unknown user/));
scenario("symbol without collected data fails fast", () => assert.throws(() => parseV9Settings({ ...ok, symbols: ["XRPUSDT"] }, users, syms), /does not collect data/));
scenario("enabled as a string fails fast", () => assert.throws(() => parseV9Settings({ enabled: "true" }, users, syms), /must be true or false/));
scenario("bad rr fails fast", () => assert.throws(() => parseV9Settings({ ...ok, rr: "2.2" }, users, syms), /rr/));
scenario("lateSlPct (OITURN) is off unless set; 0 = always; validated", () => {
  assert.strictEqual(parseV9Settings(ok, users, syms).lateSlPct, null);
  assert.strictEqual(parseV9Settings({ ...ok, lateSlPct: 0 }, users, syms).lateSlPct, 0);
  assert.strictEqual(parseV9Settings({ ...ok, lateSlPct: 0.8 }, users, syms).lateSlPct, 0.8);
  assert.throws(() => parseV9Settings({ ...ok, lateSlPct: "0" }, users, syms), /lateSlPct/);
  assert.throws(() => parseV9Settings({ ...ok, lateSlPct: -1 }, users, syms), /lateSlPct/);
  assert.strictEqual(parseV9Settings(ok, users, syms).lateSlMinPct, null);
  assert.strictEqual(parseV9Settings(ok, users, syms).forcedOnlyUsers.size, 0);
  assert.deepStrictEqual([...parseV9Settings({ ...ok, forcedOnlyUsers: [users[0]] }, users, syms).forcedOnlyUsers], [users[0]]);
  assert.throws(() => parseV9Settings({ ...ok, forcedOnlyUsers: ["nobody"] }, users, syms), /unknown user/);
  assert.strictEqual(parseV9Settings(ok, users, syms).frameOnlyUsers.size, 0);
  assert.deepStrictEqual([...parseV9Settings({ ...ok, frameOnlyUsers: [users[0]] }, users, syms).frameOnlyUsers], [users[0]]);
  assert.throws(() => parseV9Settings({ ...ok, frameOnlyUsers: ["nobody"] }, users, syms), /frameOnlyUsers" has unknown user/);
  assert.throws(() => parseV9Settings({ ...ok, frameOnlyUsers: "karo" }, users, syms), /must be an array/);
  assert.strictEqual(parseV9Settings(ok, users, syms).timeStopHours, null);
  assert.strictEqual(parseV9Settings({ ...ok, timeStopHours: 24 }, users, syms).timeStopHours, 24);
  assert.throws(() => parseV9Settings({ ...ok, timeStopHours: 0 }, users, syms), /timeStopHours/);
  assert.strictEqual(parseV9Settings({ ...ok, lateSlPct: 0, lateSlMinPct: 0.6 }, users, syms).lateSlMinPct, 0.6);
  assert.throws(() => parseV9Settings({ ...ok, lateSlMinPct: 0.6 }, users, syms), /only works together/);
  assert.throws(() => parseV9Settings({ ...ok, lateSlPct: 0, lateSlMinPct: "0.6" }, users, syms), /lateSlMinPct/);
});

scenario("minSlPct defaults to 0.33 and is validated", () => {
  assert.strictEqual(parseV9Settings(ok, users, syms).minSlPct, 0.33);
  assert.strictEqual(parseV9Settings({ ...ok, minSlPct: 0.5 }, users, syms).minSlPct, 0.5);
  assert.throws(() => parseV9Settings({ ...ok, minSlPct: "0.33" }, users, syms), /minSlPct/);
  assert.throws(() => parseV9Settings({ ...ok, minSlPct: 10 }, users, syms), /minSlPct/);
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
