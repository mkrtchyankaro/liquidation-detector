import "dotenv/config";
import { MongoClientWrapper } from "../src/infrastructure/mongo/mongo.client";
import {
  loxMongoConfig,
  getLoxCollections,
  auditLoxState,
} from "./lox-reset-audit";

/**
 * Sep 17 2026 (Karo), operator-requested operational-safety pass.
 *
 *   npx tsx scripts/lox-reset.ts --dry-run   (default if no flag given)
 *   npx tsx scripts/lox-reset.ts --confirm
 *
 * DEFAULT IS DRY RUN. Without --confirm this script makes ZERO Mongo
 * writes -- every write call in this file is inside the
 * `if (confirm)` branch, and the dry-run branch returns before that
 * branch is ever reached.
 *
 * Touches ONLY: liquidation_oi_global_signals, liquidation_oi_user_executions,
 * and LOX-owned rows (proven by a non-empty globalSignalId) in
 * strategy_orders -- via deleteMany({}), never .drop(), never a
 * database drop, never an index drop. Never touches liq_raw_events,
 * oi_second_observations, liq_minute_aggregates, wall_minute_aggregates,
 * or any v5 / execution_records / execution_claims collection --
 * this script never even constructs an accessor for any of those.
 *
 * REAL SAFETY: if any REAL user has state=ACTIVE, cleanupState=PENDING
 * or FAILED_RETRYING, or any LOX-owned strategy order is still OPEN,
 * --confirm is REFUSED outright (no override flag) -- resolve that
 * first and re-run.
 */

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const mongo = new MongoClientWrapper(loxMongoConfig());
  const cols = await getLoxCollections(mongo);
  if (cols === null) {
    console.error(
      "MONGO_URI not set or Mongo unavailable -- cannot audit or reset. No data changed.",
    );
    await mongo.close();
    process.exit(1);
  }

  const audit = await auditLoxState(cols);

  console.log(`LOX RESET \u2014 ${confirm ? "CONFIRMED" : "DRY RUN"}\n`);

  console.log("Global signals:");
  for (const [state, count] of Object.entries(audit.signalsByState))
    console.log(`  ${state}: ${count}`);
  if (Object.keys(audit.signalsByState).length === 0) console.log("  (none)");

  console.log("\nUser executions:");
  for (const [key, count] of Object.entries(audit.userExecsByModeState))
    console.log(`  ${key}: ${count}`);
  if (Object.keys(audit.userExecsByModeState).length === 0)
    console.log("  (none)");

  console.log("\nLOX-owned strategy orders:");
  for (const [state, count] of Object.entries(audit.ordersByState))
    console.log(`  ${state}: ${count}`);
  if (Object.keys(audit.ordersByState).length === 0) console.log("  (none)");

  console.log("\nSymbols currently locked:");
  if (audit.lockedSignals.length === 0) console.log("  (none)");
  for (const s of audit.lockedSignals)
    console.log(`  ${s.symbol}  ${s.globalSignalId}  (${s.state})`);

  console.log(
    `\nRows that WOULD be removed/reset: ${audit.allSignals.length} global signal(s), ${audit.allUserExecs.length} user execution(s), ${audit.allOrders.length} LOX-owned strategy order(s)`,
  );

  console.log(
    "\nObservational collections (liq_raw_events, oi_second_observations, liq_minute_aggregates, wall_minute_aggregates):",
  );
  console.log("  PRESERVED -- never touched by this script");

  console.log(
    "\nV5 collections (v5_global_signals, v5_active_cascades, v5_signals_<userId>, execution_records_<userId>, execution_claims_<userId>):",
  );
  console.log("  PRESERVED -- never touched by this script");

  if (audit.realExposure.length > 0) {
    console.log(
      "\nBinance: REAL EXPOSURE DETECTED \u2014 destructive reset would be REFUSED",
    );
    for (const r of audit.realExposure)
      console.log(
        `  userId=${r.userId} globalSignalId=${r.globalSignalId} symbol=${r.symbol}: ${r.reason}`,
      );
  } else {
    console.log("\nBinance: NO REAL EXPOSURE DETECTED");
  }

  if (!confirm) {
    console.log(
      "\nNo data changed. Re-run with --confirm to perform the reset (will be refused if REAL exposure is detected above).",
    );
    await mongo.close();
    return;
  }

  if (audit.realExposure.length > 0) {
    console.error(
      "\nRESET BLOCKED. The exposure listed above must be resolved first -- this tool will NOT cancel Binance orders or delete Mongo state that could orphan a real position/order. No data changed.",
    );
    await mongo.close();
    process.exit(1);
  }

  console.log("\nProceeding with confirmed reset...");
  await cols.signals.deleteMany({});
  await cols.userExecs.deleteMany({});
  // Sep 17 2026 (Karo), operator-reported type-safety fix -- matching
  // by _id required importing/threading the driver's own ObjectId
  // type correctly through every layer, which is fragile and driver-
  // version-sensitive. Matching on globalSignalId instead is simpler,
  // equally precise (it is the SAME ownership-proof field
  // auditLoxState() already uses to decide what counts as LOX-owned),
  // and has no ObjectId typing concerns at all.
  const ownedGlobalSignalIds = [
    ...new Set(audit.allOrders.map((o) => o.globalSignalId)),
  ];
  if (ownedGlobalSignalIds.length > 0)
    await cols.orders.deleteMany({
      globalSignalId: { $in: ownedGlobalSignalIds },
    });

  const remainingActiveSignals = await cols.signals.countDocuments({});
  const remainingUserExecs = await cols.userExecs.countDocuments({});
  const remainingOrders = await cols.orders.countDocuments({});
  if (
    remainingActiveSignals > 0 ||
    remainingUserExecs > 0 ||
    remainingOrders > 0
  ) {
    console.error(
      `\nVERIFICATION FAILED: ${remainingActiveSignals} signal(s), ${remainingUserExecs} user execution(s), ${remainingOrders} order row(s) still present after reset. Investigate before restarting the bot.`,
    );
    await mongo.close();
    process.exit(1);
  }

  console.log(
    "\nVerified: zero active LOX global signals, zero active LOX user executions, zero unresolved LOX-owned strategy orders, no symbol ownership remains from old LOX signals.",
  );
  console.log("\nLOX RESET COMPLETE");
  console.log("Ready for clean startup.");
  await mongo.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
