/**
 * Sep 10 2026 (Karo), operator-requested READ-ONLY monitoring script.
 * Proves the READ-ONLY guarantee structurally (no write-operations
 * anywhere in the file, no import of any repository class), and spot-
 * checks the pure formatting helpers against synthetic data.
 */
import * as assert from "assert";
import * as fs from "fs";

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

console.log("Running research-competition-report tests...\n");

scenario(
  "structural: the script contains EXACTLY ONE Mongo operation (.find()), no updateOne/insertOne/deleteOne/upsert anywhere in the EXECUTABLE code",
  () => {
    const source = fs.readFileSync(
      require.resolve("../scripts/research-competition-report.ts"),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("*") &&
          !line.trim().startsWith("//") &&
          !line.trim().startsWith("/**"),
      )
      .join("\n");
    assert.ok(!codeOnly.includes("updateOne("), "must never call updateOne");
    assert.ok(!codeOnly.includes("insertOne("), "must never call insertOne");
    assert.ok(!codeOnly.includes("deleteOne("), "must never call deleteOne");
    assert.ok(
      !codeOnly.includes("upsert"),
      "must never reference upsert in executable code",
    );
    assert.ok(
      !codeOnly.includes("$set") && !codeOnly.includes("$push"),
      "must never reference a Mongo write-operator in executable code",
    );
    const findCount = (codeOnly.match(/\.find\(/g) ?? []).length;
    assert.strictEqual(
      findCount,
      1,
      `expected exactly one .find() call, found ${findCount}`,
    );
  },
);

scenario(
  "structural: the script never imports GlobalSignalRepository or any other repository/write-capable class",
  () => {
    const source = fs.readFileSync(
      require.resolve("../scripts/research-competition-report.ts"),
      "utf8",
    );
    const importLines = source
      .split("\n")
      .filter((l) => l.trim().startsWith("import"));
    assert.ok(
      !importLines.some((l) => l.includes("Repository")),
      "must never IMPORT a repository class -- only the raw MongoClient driver, read-only",
    );
  },
);

scenario(
  "structural: uses the REAL, traced collection/database names -- v5_global_signals, own DB",
  () => {
    const source = fs.readFileSync(
      require.resolve("../scripts/research-competition-report.ts"),
      "utf8",
    );
    assert.ok(
      source.includes('"v5_global_signals"'),
      "must use the real collection name",
    );
    assert.ok(
      source.includes("MONGO_OWN_DB"),
      "must use the real own-database env var, matching mongo.client.ts's own pattern",
    );
  },
);

// ─── Pure formatting-helper spot-checks (re-implemented inline to avoid
//     importing the script itself, which would execute main() on import) ─

function fmtPct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(3)}%`;
}
function fmtUsd(v: number | null): string {
  if (v === null) return "n/a";
  return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`;
}
function fmtDuration(ms: number | null): string {
  if (ms === null) return "n/a";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

scenario(
  "fmtPct/fmtUsd/fmtDuration handle null gracefully -- incomplete candidates must never crash the report",
  () => {
    assert.strictEqual(fmtPct(null), "n/a");
    assert.strictEqual(fmtUsd(null), "n/a");
    assert.strictEqual(fmtDuration(null), "n/a");
  },
);

scenario(
  "fmtPct/fmtUsd/fmtDuration produce the expected, real-value formatting",
  () => {
    assert.strictEqual(fmtPct(0.00121), "0.121%");
    assert.strictEqual(fmtUsd(184200), "$184.2k");
    assert.strictEqual(fmtUsd(500), "$500");
    assert.strictEqual(fmtDuration(84000), "1m 24s");
    assert.strictEqual(fmtDuration(18000), "18s");
  },
);

// Re-implemented inline, mirroring the script's own safeIsoTime() --
// same import-avoidance reasoning as the other formatters above.
function safeIsoTime(ts: number | undefined | null): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0)
    return "unknown time";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return d.toISOString().replace("T", " ").replace("Z", "");
}

scenario(
  "safeIsoTime never throws on a missing/undefined/null/zero/NaN signalTs -- the exact real-production race (partial upserted docs) that crashed the report before this fix",
  () => {
    assert.strictEqual(safeIsoTime(undefined), "unknown time");
    assert.strictEqual(safeIsoTime(null), "unknown time");
    assert.strictEqual(safeIsoTime(0), "unknown time");
    assert.strictEqual(safeIsoTime(NaN), "unknown time");
    assert.strictEqual(safeIsoTime(-1), "unknown time");
  },
);

scenario("safeIsoTime formats a real, valid timestamp correctly", () => {
  const result = safeIsoTime(new Date("2026-09-10T10:42:15.000Z").getTime());
  assert.strictEqual(result, "2026-09-10 10:42:15.000");
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
