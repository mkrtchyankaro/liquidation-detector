/**
 * Regression: a global signal read from Mongo and written back
 * ({ ...signal, state: "CLOSED" }) must not put createdAt/_id into $set.
 * Production symptom: "[LOX_GLOBAL_SIGNAL_UPSERT_FAILED] Updating the path
 * 'createdAt' would create a conflict at 'createdAt'" -> signals stuck ACTIVE.
 *
 * Usage: npx tsx tests/liquidation-oi-global-signal-upsert.test.ts
 */
import * as assert from "assert";
import { LiquidationOiGlobalSignalRepository } from "../src/infrastructure/mongo/liquidation-oi-global-signal.repository";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}

function fakeMongo() {
  const updates: Array<{ filter: unknown; update: Record<string, Record<string, unknown>> }> = [];
  const col = {
    updateOne: async (filter: unknown, update: Record<string, Record<string, unknown>>) => {
      const set = update.$set ?? {}, onInsert = update.$setOnInsert ?? {};
      for (const k of Object.keys(set)) if (k in onInsert) throw new Error(`Updating the path '${k}' would create a conflict at '${k}'`);
      if ("_id" in set) throw new Error("Performing an update on the path '_id' would modify the immutable field '_id'");
      updates.push({ filter, update });
      return { matchedCount: 1 };
    },
  };
  return { updates, mongo: { liquidationOiGlobalSignals: async () => col, liquidationOiUserExecutions: async () => col } };
}

async function run(): Promise<void> {
  console.log("LOX global signal upsert");
  await scenario("writing back a READ signal (with _id/createdAt/updatedAt) succeeds and closes it", async () => {
    const f = fakeMongo();
    const repo = new LiquidationOiGlobalSignalRepository(f.mongo as never);
    const readBack = { _id: "abc", globalSignalId: "g1", state: "CLOSED", createdAt: new Date(0), updatedAt: new Date(0) };
    const ok = await repo.upsertSignal(readBack as never);
    assert.strictEqual(ok, true);
    const set = f.updates[0].update.$set;
    assert.strictEqual(set.state, "CLOSED");
    assert.ok(!("createdAt" in set) && !("_id" in set));
  });
  await scenario("user execution read back with _id is written without _id", async () => {
    const f = fakeMongo();
    const repo = new LiquidationOiGlobalSignalRepository(f.mongo as never);
    assert.strictEqual(await repo.upsertUserExecution({ _id: "x", userId: "karo", globalSignalId: "g1", state: "TERMINAL" } as never), true);
    assert.strictEqual(await repo.terminalizeIfActive({ _id: "x", userId: "karo", globalSignalId: "g1", state: "TERMINAL" } as never), true);
  });
  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
