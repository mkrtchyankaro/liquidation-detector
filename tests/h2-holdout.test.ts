/**
 * H2 holdout tool (frozen 2026-10-12): on the discovery data (--discovery) it must reproduce the discovery numbers,
 * and in holdout mode the discovery data gives no entries at all (nothing before 2026-10-12 13:00 UTC is used).
 * Usage: npx tsx tests/h2-holdout.test.ts
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { execFileSync } from "child_process";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-"));
const csv = path.join(dir, "all_1h.csv");
fs.writeFileSync(csv, zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", "research_1h_clean.csv.gz"))));
const run = (...a: string[]): string => execFileSync(process.execPath, [require.resolve("tsx/cli"), path.join(__dirname, "..", "src", "tools", "h2-holdout.ts"), csv, ...a], { encoding: "utf8" });

console.log("H2 holdout tool");
scenario("discovery check: all 44 / H2 18 (4 TP, 11 SL, 3 open, -4.2R) / the rest 26 (15 TP, 10 SL, +15.2R)", () => {
  const out = run("--discovery");
  assert.ok(/all signals\s+n\s+44 \| TP\s+19 SL\s+21 OPEN 4 .* net \+11\.0R/.test(out), out);
  assert.ok(/H2 dangerous\s+n\s+18 \| TP\s+4 SL\s+11 OPEN 3 .* net -4\.2R/.test(out), out);
  assert.ok(/the rest\s+n\s+26 \| TP\s+15 SL\s+10 OPEN 1 .* net \+15\.2R/.test(out), out);
  assert.ok(/events 9\n/.test(out), "44 entries = 9 market events");
  assert.ok(fs.existsSync(path.join(dir, "h2_discovery_entries.csv")));
});
scenario("holdout mode never uses the discovery period: no entries", () => {
  const out = run();
  assert.ok(/all signals\s+n\s+0 /.test(out), out);
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
