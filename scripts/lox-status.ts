import "dotenv/config";
import { MongoClientWrapper } from "../src/infrastructure/mongo/mongo.client";
import {
  loxMongoConfig,
  getLoxCollections,
  auditLoxState,
} from "./lox-reset-audit";
import { holdsSymbolOwnership } from "../src/domain/liquidation-oi-strategy/lifecycle.types";

/**
 * Sep 17 2026 (Karo), operator-requested operational-safety pass.
 *
 *   npx tsx scripts/lox-status.ts
 *
 * READ ONLY. Never calls any write/delete method on any collection --
 * confirmed structurally: this file contains no .deleteMany/.updateOne/
 * .drop call at all, only .find()/.toArray() (via auditLoxState).
 */

function ageLabel(createdAt: number, nowMs: number): string {
  const ms = nowMs - createdAt;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

async function main(): Promise<void> {
  const mongo = new MongoClientWrapper(loxMongoConfig());
  const cols = await getLoxCollections(mongo);
  if (cols === null) {
    console.error("MONGO_URI not set or Mongo unavailable.");
    await mongo.close();
    process.exit(1);
  }
  const audit = await auditLoxState(cols);
  const nowMs = Date.now();

  console.log("LOX STATUS\n");
  for (const signal of audit.allSignals) {
    const users = audit.allUserExecs.filter(
      (u) => u.globalSignalId === signal.globalSignalId,
    );
    console.log(`${signal.symbol}  ${signal.globalSignalId}`);
    console.log(
      `  global state: ${signal.state}  locked: ${holdsSymbolOwnership(signal.state)}  strategyInvalidation: ${signal.strategyInvalidationPrice ?? "N/A"}  currentTP: ${signal.currentTargetPrice ?? "N/A"}`,
    );
    if (users.length === 0) console.log("  (no user executions yet)");
    for (const u of users) {
      console.log(
        `  user=${u.userId} mode=${u.mode} age=${ageLabel(u.createdAt, nowMs)} state=${u.state} terminalReason=${u.terminalReason ?? "N/A"} cleanupState=${u.cleanupState} currentTP=${u.tpPrice ?? "N/A"}`,
      );
    }
    console.log("");
  }
  if (audit.allSignals.length === 0)
    console.log("(no LOX global signals found)\n");

  console.log(
    `Total: ${audit.allSignals.length} signal(s), ${audit.lockedSignals.length} currently locked, ${audit.allUserExecs.length} user execution(s).`,
  );
  await mongo.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
