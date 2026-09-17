import * as assert from "assert";
import { ensureTtlIndexSeconds } from "../src/infrastructure/mongo/mongo-ttl-helper";

let passed = 0,
  failed = 0;
async function scenario(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
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

interface FakeIndex {
  name: string;
  key: Record<string, number>;
  expireAfterSeconds?: number;
}

class FakeCollection {
  indexes: FakeIndex[];
  createIndexCalls: Array<{ spec: unknown; opts: unknown }> = [];
  dropIndexCalls: string[] = [];
  constructor(initial: FakeIndex[]) {
    this.indexes = initial;
  }
  listIndexes() {
    return { toArray: async () => this.indexes };
  }
  async createIndex(
    spec: Record<string, number>,
    opts: { name: string; expireAfterSeconds: number },
  ): Promise<void> {
    this.createIndexCalls.push({ spec, opts });
    this.indexes.push({
      name: opts.name,
      key: spec,
      expireAfterSeconds: opts.expireAfterSeconds,
    });
  }
  async dropIndex(name: string): Promise<void> {
    this.dropIndexCalls.push(name);
    this.indexes = this.indexes.filter((ix) => ix.name !== name);
  }
}

class FakeDb {
  commandCalls: Array<{
    collMod: string;
    index: { name: string; expireAfterSeconds: number };
  }> = [];
  constructor(private readonly coll: FakeCollection) {}
  collection(_name: string) {
    return this.coll as unknown as never;
  }
  async command(cmd: {
    collMod: string;
    index: { name: string; expireAfterSeconds: number };
  }): Promise<{ ok: number }> {
    this.commandCalls.push(cmd);
    const ix = this.coll.indexes.find((i) => i.name === cmd.index.name);
    if (ix) ix.expireAfterSeconds = cmd.index.expireAfterSeconds;
    return { ok: 1 };
  }
}

async function main(): Promise<void> {
  console.log("Running mongo-ttl-helper tests (Case A/B/C)...\n");

  await scenario(
    "Case A: existing ttl_7d/createdAt/604800 -> collMod updates to 345600, same index name, no drop, no duplicate",
    async () => {
      const coll = new FakeCollection([
        { name: "ttl_7d", key: { createdAt: 1 }, expireAfterSeconds: 604800 },
      ]);
      const db = new FakeDb(coll);
      const result = await ensureTtlIndexSeconds(
        db as unknown as never,
        "liq_minute_aggregates",
        "createdAt",
        345600,
        "ttl_createdAt",
      );

      assert.strictEqual(result.action, "updated");
      assert.strictEqual(
        result.indexName,
        "ttl_7d",
        "the NAME is cosmetic -- collMod must target the EXISTING index by its actual name, never rename it",
      );
      assert.strictEqual(result.before, 604800);
      assert.strictEqual(result.after, 345600);
      assert.strictEqual(coll.indexes.length, 1, "no duplicate index created");
      assert.strictEqual(coll.indexes[0]!.name, "ttl_7d");
      assert.strictEqual(coll.indexes[0]!.expireAfterSeconds, 345600);
      assert.strictEqual(
        coll.dropIndexCalls.length,
        0,
        "must never drop this index",
      );
      assert.strictEqual(
        coll.createIndexCalls.length,
        0,
        "must never create a new index when one already exists on this field",
      );
      assert.strictEqual(db.commandCalls.length, 1);
      assert.deepStrictEqual(db.commandCalls[0], {
        collMod: "liq_minute_aggregates",
        index: { name: "ttl_7d", expireAfterSeconds: 345600 },
      });
    },
  );

  await scenario(
    "Case B: existing timestamp_1/timestamp/604800 -> collMod updates to 259200, same index name, no drop, no duplicate",
    async () => {
      const coll = new FakeCollection([
        {
          name: "timestamp_1",
          key: { timestamp: 1 },
          expireAfterSeconds: 604800,
        },
      ]);
      const db = new FakeDb(coll);
      const result = await ensureTtlIndexSeconds(
        db as unknown as never,
        "oi_second_observations",
        "timestamp",
        259200,
        "ttl_timestamp",
      );

      assert.strictEqual(result.action, "updated");
      assert.strictEqual(result.indexName, "timestamp_1");
      assert.strictEqual(result.before, 604800);
      assert.strictEqual(result.after, 259200);
      assert.strictEqual(coll.indexes.length, 1);
      assert.strictEqual(coll.indexes[0]!.expireAfterSeconds, 259200);
      assert.strictEqual(coll.dropIndexCalls.length, 0);
      assert.strictEqual(coll.createIndexCalls.length, 0);
    },
  );

  await scenario(
    "Case C: already correct TTL -> idempotent, no collMod, no drop, no create",
    async () => {
      const coll = new FakeCollection([
        {
          name: "ttl_createdAt",
          key: { createdAt: 1 },
          expireAfterSeconds: 345600,
        },
      ]);
      const db = new FakeDb(coll);
      const result = await ensureTtlIndexSeconds(
        db as unknown as never,
        "liq_minute_aggregates",
        "createdAt",
        345600,
        "ttl_createdAt",
      );

      assert.strictEqual(result.action, "unchanged");
      assert.strictEqual(
        db.commandCalls.length,
        0,
        "must not call collMod when the value is already correct",
      );
      assert.strictEqual(coll.dropIndexCalls.length, 0);
      assert.strictEqual(coll.createIndexCalls.length, 0);
      assert.strictEqual(coll.indexes.length, 1);
    },
  );

  await scenario(
    "no existing TTL index on the field -> creates one (first-time case, not a migration)",
    async () => {
      const coll = new FakeCollection([
        { name: "symbol_1_timestamp_1", key: { symbol: 1, timestamp: 1 } },
      ]);
      const db = new FakeDb(coll);
      const result = await ensureTtlIndexSeconds(
        db as unknown as never,
        "oi_second_observations",
        "timestamp",
        259200,
        "ttl_timestamp",
      );

      assert.strictEqual(result.action, "created");
      assert.strictEqual(coll.createIndexCalls.length, 1);
      assert.strictEqual(
        db.commandCalls.length,
        0,
        "creating is not a collMod",
      );
      assert.strictEqual(
        coll.indexes.length,
        2,
        "the pre-existing non-TTL compound index must be left completely untouched",
      );
      const nonTtl = coll.indexes.find(
        (ix) => ix.name === "symbol_1_timestamp_1",
      );
      assert.ok(
        nonTtl && nonTtl.expireAfterSeconds === undefined,
        "the unrelated non-TTL index must be untouched",
      );
    },
  );

  await scenario(
    "repeated calls (simulating repeated restarts) are fully idempotent",
    async () => {
      const coll = new FakeCollection([
        { name: "ttl_7d", key: { createdAt: 1 }, expireAfterSeconds: 604800 },
      ]);
      const db = new FakeDb(coll);
      await ensureTtlIndexSeconds(
        db as unknown as never,
        "liq_minute_aggregates",
        "createdAt",
        345600,
        "ttl_createdAt",
      );
      assert.strictEqual(db.commandCalls.length, 1);

      const result2 = await ensureTtlIndexSeconds(
        db as unknown as never,
        "liq_minute_aggregates",
        "createdAt",
        345600,
        "ttl_createdAt",
      );
      assert.strictEqual(result2.action, "unchanged");
      assert.strictEqual(
        db.commandCalls.length,
        1,
        "a second, already-correct call must not issue another collMod",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
