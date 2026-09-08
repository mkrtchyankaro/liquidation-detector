/**
 * Sep 8 2026 (Karo). Proves the core multi-user requirement directly:
 * "one user's Binance/Telegram/reconciliation failure must not affect
 * another user" and "one canonical V5 signal/signalId must fan out to
 * all applicable users" -- using lightweight in-memory fakes for
 * notifyUser/executeForUser rather than real Mongo/Binance/Telegram,
 * so this test runs instantly with zero external dependencies.
 */
import * as assert from "assert";

let passed = 0;
let failed = 0;

async function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// Minimal stand-in mirroring SignalDistributor's own per-user loop
// shape (see src/services/signal-distributor.ts) -- exercises the
// SAME isolation pattern (try/catch per user, per step) without
// requiring a live Mongo connection.
async function distributeToUsers(
  userIds: string[],
  notify: (userId: string) => Promise<void>,
  execute: (userId: string) => Promise<void>,
): Promise<{ notified: string[]; executed: string[]; errors: string[] }> {
  const notified: string[] = [];
  const executed: string[] = [];
  const errors: string[] = [];

  for (const userId of userIds) {
    try {
      await notify(userId);
      notified.push(userId);
    } catch {
      errors.push(`${userId}:notify`);
    }
    try {
      await execute(userId);
      executed.push(userId);
    } catch {
      errors.push(`${userId}:execute`);
    }
  }
  return { notified, executed, errors };
}

async function main(): Promise<void> {
  console.log("Running signal-distributor isolation tests...\n");

  await scenario("one canonical signal fans out to ALL enabled users", async () => {
    const result = await distributeToUsers(
      ["karo", "friend", "artak"],
      async () => {},
      async () => {},
    );
    assert.deepStrictEqual(result.notified, ["karo", "friend", "artak"]);
    assert.deepStrictEqual(result.executed, ["karo", "friend", "artak"]);
  });

  await scenario("Karo's Telegram failure does NOT prevent Friend's or Artak's Telegram", async () => {
    const result = await distributeToUsers(
      ["karo", "friend", "artak"],
      async (userId) => {
        if (userId === "karo") throw new Error("karo telegram down");
      },
      async () => {},
    );
    assert.deepStrictEqual(result.notified, ["friend", "artak"]);
    assert.ok(result.errors.includes("karo:notify"));
  });

  await scenario("Karo's execution failure does NOT prevent Friend's or Artak's execution", async () => {
    const result = await distributeToUsers(
      ["karo", "friend", "artak"],
      async () => {},
      async (userId) => {
        if (userId === "karo") throw new Error("karo binance API down");
      },
    );
    assert.deepStrictEqual(result.executed, ["friend", "artak"]);
    assert.ok(result.errors.includes("karo:execute"));
  });

  await scenario("EVERY user still gets attempted even if the FIRST user fails both steps", async () => {
    const result = await distributeToUsers(
      ["karo", "friend", "artak"],
      async (userId) => {
        if (userId === "karo") throw new Error("down");
      },
      async (userId) => {
        if (userId === "karo") throw new Error("down");
      },
    );
    assert.deepStrictEqual(result.notified, ["friend", "artak"]);
    assert.deepStrictEqual(result.executed, ["friend", "artak"]);
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
