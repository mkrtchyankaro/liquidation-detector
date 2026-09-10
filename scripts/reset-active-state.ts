/**
 * Sep 10 2026 (Karo), operator-requested clean active-state reset for
 * the new V5 multi-timeframe cascade lifecycle. Manually run, never
 * called from the application itself.
 *
 * Deletes/resets ONLY active/non-terminal state:
 *   - v5_global_signals: status="SIGNAL" documents (deleted)
 *   - v5_signals_<userId> (every configured user, not just main):
 *     status="OPEN" documents (deleted)
 *   - v5_active_cascades: status="ACTIVE" documents (deleted --
 *     includes any duplicate-cascadeId artifacts from the
 *     now-fixed race condition)
 *
 * Never touches: CLOSED_TP/CLOSED_SL/CANCEL/CLOSED-status documents
 * (historical), liq_minute_aggregates or any other liquidation-
 * statistics/history collection, strategy config, enable/disable
 * flags, or any collection this script does not explicitly name.
 *
 * Usage:
 *   npx tsx scripts/reset-active-state.ts            (print + reset)
 *   npx tsx scripts/reset-active-state.ts --dry-run   (print only, no writes)
 */
import "dotenv/config";
import * as path from "path";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import { loadUsersConfig } from "../src/infrastructure/config/users.config.loader";

function buildMongo(): MongoClientWrapper {
  const cfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  return new MongoClientWrapper(cfg);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const mongo = buildMongo();

  const globalCol = await mongo.globalSignals();
  const cascadeCol = await mongo.activeCascades();
  if (!globalCol || !cascadeCol) {
    console.error(
      !((process.env.MONGO_URI ?? "").length > 0)
        ? "MONGO_URI not set in .env."
        : "Mongo is configured but the connection FAILED (network/auth/URI).",
    );
    process.exit(1);
  }

  let userIds: string[] = [];
  try {
    const usersConfigPath =
      process.env.USERS_CONFIG_PATH ??
      path.join(process.cwd(), "users.config.json");
    userIds = loadUsersConfig(usersConfigPath).map((u) => u.userId);
  } catch (err) {
    console.error(
      "Could not load users.config.json -- per-user collections will be skipped:",
      err instanceof Error ? err.message : String(err),
    );
  }

  console.log("=".repeat(60));
  console.log(
    dryRun
      ? "DRY RUN -- reporting only, no writes will be made"
      : "ACTIVE-STATE RESET",
  );
  console.log("=".repeat(60));

  // ── 1. What currently exists (BEFORE) ──────────────────────────────
  console.log("\n--- BEFORE ---\n");

  const activeGlobal = await globalCol.find({ status: "SIGNAL" }).toArray();
  console.log(`active v5_global_signals: ${activeGlobal.length}`);
  for (const d of activeGlobal)
    console.log(
      `  ${d.signalId} ${d.symbol} ${d.side} cascadeId=${d.cascadeId ?? "n/a"} timeframe=${d.timeframe ?? "n/a"}`,
    );

  const perUserOpen: Record<string, number> = {};
  for (const userId of userIds) {
    const col = await mongo.userSignals(userId);
    const count = col ? await col.countDocuments({ status: "OPEN" }) : 0;
    perUserOpen[userId] = count;
    console.log(`active v5_signals_${userId}: ${count}`);
    if (col && count > 0) {
      const docs = await col.find({ status: "OPEN" }).toArray();
      for (const d of docs)
        console.log(
          `  ${(d as any).signalId} ${(d as any).symbol} isLive=${(d as any).isLive}`,
        );
    }
  }

  const activeCascades = await cascadeCol.find({ status: "ACTIVE" }).toArray();
  console.log(`active cascades (v5_active_cascades): ${activeCascades.length}`);
  let activeCandidateCount = 0;
  for (const c of activeCascades as any[]) {
    const phases = (["1m", "3m", "5m"] as const).map(
      (tf) => `${tf}=${c.candidates?.[tf]?.phase ?? "n/a"}`,
    );
    for (const tf of ["1m", "3m", "5m"] as const) {
      if (c.candidates?.[tf]?.phase === "ACTIVE") activeCandidateCount++;
    }
    console.log(
      `  ${c.cascadeId} ${c.symbol} ${c.victimSide} ${phases.join(" ")}`,
    );
  }
  console.log(
    `active 1m/3m/5m candidates (phase=ACTIVE, across all active cascades): ${activeCandidateCount}`,
  );

  console.log("\n--- RAM-ONLY STATE (not in this report -- already gone) ---");
  console.log(
    "V5WaveService in-memory watches/activeTrades, mainSymbolLocks, CascadeRegistry",
  );
  console.log(
    "ownership map, and CascadeCandidateService's own 1m/3m/5m in-memory watch",
  );
  console.log(
    "Maps are ALL process-memory-only. Any deploy/restart already cleared them",
  );
  console.log(
    "completely -- there is nothing this script can or needs to touch there.",
  );
  console.log("");
  console.log(
    "REHYDRATION WARNING: hydrateMainLocks() re-populates mainSymbolLocks +",
  );
  console.log(
    "V5WaveService's own activeTrades from v5_global_signals (status=SIGNAL) on",
  );
  console.log(
    "every startup. hydrateActiveCascades() re-populates CascadeRegistry +",
  );
  console.log(
    "CascadeCandidateService from v5_active_cascades (status=ACTIVE) on every",
  );
  console.log(
    "startup. This is exactly WHY the Mongo-side active/non-terminal records",
  );
  console.log(
    "(not the RAM state itself) are what this script deletes -- leaving them",
  );
  console.log(
    "would cause the OLD state to silently come back on the next restart.",
  );

  if (dryRun) {
    console.log("\n--dry-run: no changes made.");
    await mongo.close();
    return;
  }

  // ── 2. Delete active/non-terminal state ─────────────────────────────
  console.log("\n--- DELETING ---\n");

  const r1 = await globalCol.deleteMany({ status: "SIGNAL" });
  console.log(`Deleted v5_global_signals (status=SIGNAL): ${r1.deletedCount}`);

  let totalUserDeleted = 0;
  for (const userId of userIds) {
    const col = await mongo.userSignals(userId);
    if (!col) continue;
    const r = await col.deleteMany({ status: "OPEN" });
    totalUserDeleted += r.deletedCount ?? 0;
    console.log(
      `Deleted v5_signals_${userId} (status=OPEN): ${r.deletedCount}`,
    );
  }

  const r3 = await cascadeCol.deleteMany({ status: "ACTIVE" });
  console.log(`Deleted v5_active_cascades (status=ACTIVE): ${r3.deletedCount}`);

  // ── 3. Verify (AFTER) ────────────────────────────────────────────────
  console.log("\n--- AFTER (verification) ---\n");
  const afterGlobal = await globalCol.countDocuments({ status: "SIGNAL" });
  let afterUserTotal = 0;
  for (const userId of userIds) {
    const col = await mongo.userSignals(userId);
    afterUserTotal += col ? await col.countDocuments({ status: "OPEN" }) : 0;
  }
  const afterCascades = await cascadeCol.countDocuments({ status: "ACTIVE" });
  const afterActiveCandidates = (
    await cascadeCol.find({ status: "ACTIVE" }).toArray()
  ).reduce((sum: number, c: any) => {
    return (
      sum +
      (["1m", "3m", "5m"] as const).filter(
        (tf) => c.candidates?.[tf]?.phase === "ACTIVE",
      ).length
    );
  }, 0);

  console.log(`active global signals: ${afterGlobal}`);
  console.log(
    `active MAIN signals: ${perUserOpen["main"] !== undefined ? 0 : "n/a (no 'main' user configured)"}`,
  );
  console.log(`active cascades: ${afterCascades}`);
  console.log(`active candidates: ${afterActiveCandidates}`);
  console.log("");
  console.log(
    "Historical CLOSED_TP / CLOSED_SL / CANCEL / CLOSED-status records: UNTOUCHED.",
  );
  console.log("liquidation statistics/history collections: UNTOUCHED.");
  console.log("Strategy config / enable-disable flags: UNTOUCHED.");

  await mongo.close();
}

main().catch((err) => {
  console.error("reset-active-state failed:", err);
  process.exit(1);
});
