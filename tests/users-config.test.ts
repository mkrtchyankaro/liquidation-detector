/**
 * users.config.json parsing: old/extra fields are ignored, typos fail fast.
 * Usage: npx tsx tests/users-config.test.ts
 */
import * as assert from "assert";
import { parseAppConfig } from "../src/config/users-config";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const syms = ["BTCUSDT", "ETHUSDT"];
const base = () => ({
  realOrdersEnabled: true,
  v9: { enabled: true, symbols: ["BTCUSDT"], rr: 2.2, userModes: { main: "PAPER", karo: "REAL" } },   // removed strategy: ignored
  v11: { enabled: true, tpR: 2.5, userModes: { main: "PAPER", karo: "REAL" }, perUser: { karo: { tpR: 2, rallyTypes: ["T1"], riskUsd: 2 } } },
  users: [
    { userId: "main", enabled: true, telegram: { enabled: true, botToken: "t", chatIds: "1,2" }, binance: { enabled: false }, risk: { riskUsd: 10 } },
    { userId: "karo", enabled: true, telegram: { enabled: true, botToken: "t", chatIds: ["3"] },
      binance: { enabled: true, apiKey: "k", apiSecret: "s", mode: "live", orderExecutionEnabled: true, leverage: 20, marginMode: "ISOLATED" },
      risk: { riskUsd: 1, accountBudgetUsd: 500, dailyLossLimitPct: 5 }, liquidationOiExecutionEnabled: true, btcBlockEnabled: false },
  ],
});

console.log("users config");
scenario("current production-style file (with old LOX/V5 fields) parses; old fields ignored", () => {
  const c = parseAppConfig(base(), "x", syms);
  assert.strictEqual(c.realOrdersEnabled, true);
  assert.deepStrictEqual(c.users.map((u) => u.userId), ["main", "karo"]);
  assert.deepStrictEqual(c.users[0].telegram!.chatIds, ["1", "2"]);
  assert.strictEqual(c.users[0].binance, null);
  assert.strictEqual(c.users[1].binance!.leverage, 20);
  assert.strictEqual(c.users[1].riskUsd, 1);
  assert.strictEqual(c.v11.userModes.get("karo"), "REAL");
  assert.deepStrictEqual(c.legacyBlocks, ["v9"]);
});
scenario("realOrdersEnabled as a string fails fast", () => assert.throws(() => parseAppConfig({ ...base(), realOrdersEnabled: "true" }, "x", syms), /realOrdersEnabled/));
scenario("binance enabled without keys fails fast", () => {
  const c = base(); (c.users[1].binance as Record<string, unknown>).apiKey = "";
  assert.throws(() => parseAppConfig(c, "x", syms), /apiKey/);
});
scenario("duplicate userId fails fast", () => {
  const c = base(); c.users[1].userId = "MAIN";
  assert.throws(() => parseAppConfig(c, "x", syms), /duplicate/);
});
scenario("negative riskUsd fails fast", () => {
  const c = base(); c.users[1].risk.riskUsd = -1;
  assert.throws(() => parseAppConfig(c, "x", syms), /riskUsd/);
});
scenario("v11 errors surface with the file path", () => assert.throws(() => parseAppConfig({ ...base(), v11: { enabled: true, symbols: ["XRPUSDT"] } }, "users.config.json", syms), /users\.config\.json.*does not collect data/));
scenario("old v9 / zz / oa blocks, even with garbage, are ignored (removed strategies)", () => {
  const c = parseAppConfig({ ...base(), v9: { enabled: "yes", nonsense: 1 }, zz: { enabled: true, users: ["nobody"] }, oa: { enabled: 7 } }, "x", syms);
  assert.deepStrictEqual(c.legacyBlocks, ["v9", "zz", "oa"]);
});
scenario("V11 is written lower case or it fails", () => assert.throws(() => parseAppConfig({ ...base(), V11: { enabled: true } }, "x", syms), /"V11" must be written "v11"/));
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
