import "dotenv/config";
import { MongoClientWrapper } from "../src/infrastructure/mongo/mongo.client";
import { loxMongoConfig, getLoxCollections } from "./lox-reset-audit";

/**
 * Sep 17 2026 (Karo), operator-requested -- targeted counterpart to
 * lox-reset.ts (which resets EVERYTHING). This clears exactly ONE
 * globalSignalId's rows across the three LOX collections, nothing
 * else. Same safety posture: dry-run by default, --confirm required
 * to write, refuses if the signal's own user rows show REAL exposure.
 *
 *   npx tsx scripts/lox-reset-signal.ts --signal-id=lox-sig-... [--confirm]
 */

async function main(): Promise<void> {
  const idArg = process.argv.find((a) => a.startsWith("--signal-id="));
  const globalSignalId = idArg?.split("=")[1];
  if (!globalSignalId) {
    console.error(
      "Usage: npx tsx scripts/lox-reset-signal.ts --signal-id=<globalSignalId> [--confirm]",
    );
    process.exit(1);
  }
  const confirm = process.argv.includes("--confirm");

  const mongo = new MongoClientWrapper(loxMongoConfig());
  const cols = await getLoxCollections(mongo);
  if (cols === null) {
    console.error("MONGO_URI not set or Mongo unavailable. No data changed.");
    await mongo.close();
    process.exit(1);
  }

  const signal = await cols.signals.findOne({ globalSignalId });
  const userExecs = await cols.userExecs.find({ globalSignalId }).toArray();
  const orders = await cols.orders.find({ globalSignalId }).toArray();

  console.log(
    `LOX RESET SIGNAL \u2014 ${confirm ? "CONFIRMED" : "DRY RUN"}  (globalSignalId=${globalSignalId})\n`,
  );
  if (signal === null) {
    console.log(
      "No global signal document found with this id. Nothing to reset.",
    );
    await mongo.close();
    return;
  }
  console.log(
    `Global signal: symbol=${signal.symbol} state=${signal.state} entryPrice=${signal.entryPrice} initialTpPrice=${signal.initialTpPrice} currentTargetPrice=${signal.currentTargetPrice} strategyInvalidationPrice=${signal.strategyInvalidationPrice} tpRevision=${signal.tpRevision}`,
  );
  console.log(`User executions (${userExecs.length}):`);
  for (const u of userExecs as any[])
    console.log(
      `  userId=${u.userId} mode=${u.mode} state=${u.state} terminalReason=${u.terminalReason ?? "N/A"} cleanupState=${u.cleanupState}`,
    );
  console.log(`LOX-owned strategy orders for this signal: ${orders.length}`);

  const realExposure = (userExecs as any[]).filter(
    (u) =>
      u.mode === "REAL" &&
      (u.state === "ACTIVE" ||
        u.cleanupState === "PENDING" ||
        u.cleanupState === "FAILED_RETRYING"),
  );
  const unresolvedOrders = (orders as any[]).filter((o) => o.state === "OPEN");
  if (realExposure.length > 0 || unresolvedOrders.length > 0) {
    console.log(
      "\nREAL EXPOSURE DETECTED for this signal -- destructive reset would be REFUSED:",
    );
    for (const u of realExposure)
      console.log(
        `  userId=${u.userId}: mode=REAL, state=${u.state}, cleanupState=${u.cleanupState}`,
      );
    for (const o of unresolvedOrders)
      console.log(
        `  unresolved LOX order: userId=${o.userId} purpose=${o.purpose} state=OPEN`,
      );
  } else {
    console.log(
      "\nNo REAL exposure for this signal (all rows PAPER, or REAL rows already terminal+clean).",
    );
  }

  if (!confirm) {
    console.log(
      "\nNo data changed. Re-run with --confirm to clear this signal's rows.",
    );
    await mongo.close();
    return;
  }
  if (realExposure.length > 0 || unresolvedOrders.length > 0) {
    console.error("\nRESET BLOCKED for this signal. No data changed.");
    await mongo.close();
    process.exit(1);
  }

  await cols.signals.deleteMany({ globalSignalId });
  await cols.userExecs.deleteMany({ globalSignalId });
  await cols.orders.deleteMany({ globalSignalId });

  const remaining = await cols.signals.countDocuments({ globalSignalId });
  if (remaining > 0) {
    console.error(
      `\nVERIFICATION FAILED: ${remaining} signal row(s) still present.`,
    );
    await mongo.close();
    process.exit(1);
  }
  console.log(
    `\nLOX RESET SIGNAL COMPLETE for ${globalSignalId} -- symbol ${signal.symbol} released.`,
  );
  await mongo.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
