#!/usr/bin/env node
/**
 * Stage 1 — READ-ONLY execution diagnostic. Writes nothing, sends nothing.
 *
 * Answers one question with database evidence: for every recent signal,
 * which strategy produced it, which mode each user ran in (PAPER / REAL /
 * SHADOW / TELEGRAM_ONLY), and — when no Binance position was opened —
 * the exact recorded reason.
 *
 * Two strategies write signals in this codebase:
 *   LOX (liquidation+OI)  -> liquidation_oi_global_signals + liquidation_oi_user_executions
 *   V5  (legacy waves)    -> v5_global_signals + v5_signals_<userId>
 *
 * Usage:  node scripts/diagnose-execution.js [hours=48]
 */
require("dotenv/config");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const HOURS = Number(process.argv[2] ?? 48);
if (!(HOURS > 0)) throw Error("hours must be > 0");
const since = new Date(Date.now() - HOURS * 3600_000);
const iso = (v) =>
  (v instanceof Date ? v : new Date(v))
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");

function count(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function printConfigGates() {
  console.log("\n=== CONFIG GATES ===");
  const main = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.ts"),
    "utf8",
  );
  const hardcoded = /false,\s*\/\/\s*executionEnabled/.test(main);
  console.log(
    `LOX global executionEnabled in src/main.ts: ${hardcoded ? "HARDCODED false -> every user is PAPER" : "not hardcoded false (check value)"}`,
  );
  const file = ["users.config.json", "config/users.json", "users.json"]
    .map((f) => path.join(__dirname, "..", f))
    .find((f) => fs.existsSync(f));
  if (!file) {
    console.log(
      "users config file: not found next to repo root (checked users.config.json, config/users.json, users.json)",
    );
    return;
  }
  const users = JSON.parse(fs.readFileSync(file, "utf8")).users ?? [];
  console.log(`users config: ${path.basename(file)}`);
  console.log(
    "USER        ENABLED  LOX_EXEC  BINANCE.enabled  mode     orderExec  riskUsd",
  );
  for (const u of users) {
    console.log(
      `${String(u.userId).padEnd(10)}  ${String(u.enabled).padEnd(7)}  ${String(u.liquidationOiExecutionEnabled ?? false).padEnd(8)}  ${String(u.binance?.enabled ?? false).padEnd(15)}  ${String(u.binance?.mode ?? "-").padEnd(7)}  ${String(u.binance?.orderExecutionEnabled ?? false).padEnd(9)}  ${u.risk?.riskUsd ?? "-"}`,
    );
  }
  console.log(
    "LOX opens a REAL position only if: global executionEnabled=true AND user.liquidationOiExecutionEnabled=true.",
  );
  console.log(
    "V5 opens a REAL position only if: binance.enabled AND mode=live AND orderExecutionEnabled AND planned RR >= 2.0.",
  );
}

async function main() {
  printConfigGates();
  if (!process.env.MONGO_URI) throw Error("MONGO_URI is not set");
  const client = new MongoClient(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
  });
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");

    // ── LOX ─────────────────────────────────────────────────────────────
    const loxSignals = await db
      .collection("liquidation_oi_global_signals")
      .find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .toArray();
    const loxExec = await db
      .collection("liquidation_oi_user_executions")
      .find({
        globalSignalId: { $in: loxSignals.map((s) => s.globalSignalId) },
      })
      .toArray();
    console.log(
      `\n=== LOX (last ${HOURS}h) signals=${loxSignals.length} userExecutions=${loxExec.length} ===`,
    );
    console.log(
      "signal states:",
      JSON.stringify(count(loxSignals, (s) => s.state)),
    );
    console.log("per user mode/state/reason:");
    const byUser = count(
      loxExec,
      (e) =>
        `${e.userId} | ${e.mode ?? "?"} | ${e.state} | ${e.terminalReason ?? "-"}`,
    );
    for (const [k, v] of Object.entries(byUser).sort())
      console.log(`  ${k}  x${v}`);
    console.log("last 15 signals:");
    for (const s of loxSignals.slice(0, 15)) {
      const users = loxExec
        .filter((e) => e.globalSignalId === s.globalSignalId)
        .map(
          (e) =>
            `${e.userId}:${e.mode ?? "?"}/${e.state}${e.terminalReason ? "/" + e.terminalReason : ""}`,
        )
        .join(" ");
      console.log(
        `  ${iso(s.createdAt)}  ${String(s.symbol).padEnd(9)} ${String(s.candidateSide).padEnd(5)} ${String(s.state).padEnd(14)} ${s.globalSignalId}  ${users || "(no user executions)"}`,
      );
    }

    // ── V5 ──────────────────────────────────────────────────────────────
    const v5Signals = await db
      .collection("v5_global_signals")
      .find({ createdAt: { $gte: since.getTime() } })
      .sort({ createdAt: -1 })
      .toArray()
      .catch(() => []);
    const v5Alt = v5Signals.length
      ? v5Signals
      : await db
          .collection("v5_global_signals")
          .find({ createdAt: { $gte: since } })
          .sort({ createdAt: -1 })
          .toArray()
          .catch(() => []);
    const userCols = (
      await db.listCollections({ name: /^v5_signals_/ }).toArray()
    ).map((c) => c.name);
    console.log(
      `\n=== V5 (last ${HOURS}h) signals=${v5Alt.length} userCollections=${userCols.join(", ") || "none"} ===`,
    );
    for (const name of userCols) {
      const rows = await db
        .collection(name)
        .find({ createdAt: { $gte: since.getTime() } })
        .sort({ createdAt: -1 })
        .toArray();
      console.log(`${name}: ${rows.length} rows`);
      const reasons = count(
        rows,
        (r) => `${r.status} | ${r.executionSkipReason ?? "-"}`,
      );
      for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1]))
        console.log(`  ${k}  x${v}`);
    }
    console.log("\nRead-only: nothing was written.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
