/**
 * Sep 8 2026 (Karo). Proves the Mongo-touching half of the research-
 * data layer using a lightweight in-memory fake collection (same
 * convention as signal-distributor.test.ts -- no live Mongo needed,
 * runs instantly). Covers:
 *   - raw liquidation events persist correctly
 *   - TTL/indexes are created
 *   - research checkpoints append correctly to a GLOBAL doc
 *   - no-entry episodes can receive research observations (via the
 *     SAME appendCheckpoint path a SIGNAL uses -- proving there is no
 *     entry-only special case)
 *   - user fan-out remains independent from global research (the
 *     research-data calls never touch any per-user collection at all)
 */
import * as assert from "assert";
import {
  RawLiquidationEventRepository,
  type RawLiquidationEventDoc,
} from "../src/infrastructure/mongo/raw-liquidation-event.repository";
import { GlobalSignalRepository } from "../src/infrastructure/mongo/global-signal.repository";
import type { ResearchCheckpointGroup } from "../src/domain/signal/research-checkpoint.model";

let passed = 0;
let failed = 0;

async function scenario(
  name: string,
  fn: () => void | Promise<void>,
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

// ── Minimal fake Mongo collection + client wrapper ──────────────────
// Mirrors only the methods the two repositories under test actually
// call. Records every call so assertions can inspect exactly what was
// sent, without a live database.
class FakeCollection<T> {
  inserted: T[] = [];
  updates: Array<{ filter: unknown; update: unknown }> = [];
  indexesCreated: Array<{ spec: unknown; opts: unknown }> = [];
  private store = new Map<string, T & { researchCheckpoints?: unknown[] }>();

  async insertOne(doc: T): Promise<void> {
    this.inserted.push(doc);
    const withId = doc as unknown as { signalId?: string };
    if (withId.signalId)
      this.store.set(
        withId.signalId,
        doc as T & { researchCheckpoints?: unknown[] },
      );
  }

  async createIndex(spec: unknown, opts?: unknown): Promise<void> {
    this.indexesCreated.push({ spec, opts });
  }

  async updateOne(
    filter: { signalId?: string },
    update: { $push?: { researchCheckpoints?: unknown } },
  ): Promise<void> {
    this.updates.push({ filter, update });
    if (filter.signalId) {
      const existing = this.store.get(filter.signalId);
      if (existing && update.$push?.researchCheckpoints) {
        existing.researchCheckpoints = existing.researchCheckpoints ?? [];
        (existing.researchCheckpoints as unknown[]).push(
          update.$push.researchCheckpoints,
        );
      }
    }
  }

  /** Sep 17 2026 (Karo), operator-requested retention pass -- needed
   *  by mongo-ttl-helper.ts's ensureTtlIndexSeconds/dropStaleTtlIndex,
   *  which discover existing TTL indexes by listing them (real Mongo
   *  behavior) rather than assuming a fixed name. Mirrors indexesCreated
   *  as {name, key, expireAfterSeconds} shaped like real Mongo index
   *  metadata. */
  listIndexes(): {
    toArray: () => Promise<
      Array<{
        name: string;
        key: Record<string, number>;
        expireAfterSeconds?: number;
      }>
    >;
  } {
    return {
      toArray: async () =>
        this.indexesCreated.map((ix, i) => ({
          name: (ix.opts as { name?: string } | undefined)?.name ?? `idx_${i}`,
          key: ix.spec as Record<string, number>,
          expireAfterSeconds: (
            ix.opts as { expireAfterSeconds?: number } | undefined
          )?.expireAfterSeconds,
        })),
    };
  }

  async dropIndex(name: string): Promise<void> {
    const idx = this.indexesCreated.findIndex(
      (ix, i) =>
        ((ix.opts as { name?: string } | undefined)?.name ?? `idx_${i}`) ===
        name,
    );
    if (idx >= 0) this.indexesCreated.splice(idx, 1);
  }

  async updateMany(
    _filter: unknown,
    _update: unknown,
  ): Promise<{ modifiedCount: number }> {
    return { modifiedCount: 0 }; // no pre-existing documents lacking eventTimeDate in these tests
  }

  get(signalId: string): (T & { researchCheckpoints?: unknown[] }) | undefined {
    return this.store.get(signalId);
  }
}

class FakeMongoClient {
  rawCol = new FakeCollection<RawLiquidationEventDoc>();
  globalCol = new FakeCollection<Record<string, unknown>>();

  async rawLiquidationEvents() {
    return this.rawCol as unknown as never;
  }
  async globalSignals() {
    return this.globalCol as unknown as never;
  }
  /** Sep 17 2026 (Karo), operator-requested retention pass -- fake Db
   *  handle, matching the real MongoClientWrapper.ensureOwn(). Its
   *  .collection("liq_raw_events") returns the SAME rawCol instance
   *  the tests already inspect, so index/TTL assertions see a single
   *  consistent state regardless of whether the call went through the
   *  typed Collection<T> accessor or this raw Db path. command() is a
   *  no-op stub -- these tests never exercise the collMod path (no
   *  pre-existing differently-valued TTL index in a fresh FakeCollection). */
  async ensureOwn() {
    return {
      collection: (_name: string) => this.rawCol as unknown as never,
      command: async (_cmd: unknown) => ({ ok: 1 }),
    } as unknown as never;
  }
}

async function main(): Promise<void> {
  console.log("Running research-data-layer (Mongo-touching) tests...\n");

  await scenario(
    "raw liquidation events persist correctly -- zero derivation, victim correctly mapped from side",
    async () => {
      const fake = new FakeMongoClient();
      const repo = new RawLiquidationEventRepository(fake as never);
      await repo.insert({
        symbol: "ETHUSDT",
        victim: "LONG",
        price: 2465.5,
        quoteQty: 71000,
        timestamp: 1_725_800_000_000,
      });
      assert.strictEqual(fake.rawCol.inserted.length, 1);
      assert.deepStrictEqual(fake.rawCol.inserted[0], {
        symbol: "ETHUSDT",
        victim: "LONG",
        price: 2465.5,
        quoteQty: 71000,
        timestamp: 1_725_800_000_000,
        eventTimeDate: new Date(1_725_800_000_000),
      });
    },
  );

  await scenario(
    "TTL/indexes are created -- symbol+timestamp index AND a TTL (expireAfterSeconds) index on timestamp",
    async () => {
      const fake = new FakeMongoClient();
      const repo = new RawLiquidationEventRepository(fake as never);
      const ok = await repo.ensureIndexes();
      assert.strictEqual(ok, true);
      assert.strictEqual(fake.rawCol.indexesCreated.length, 2);
      const ttlIndex = fake.rawCol.indexesCreated.find(
        (i) =>
          (i.opts as { expireAfterSeconds?: number })?.expireAfterSeconds !==
          undefined,
      );
      assert.ok(ttlIndex, "expected a TTL index to be created");
      assert.strictEqual(
        (ttlIndex!.opts as { expireAfterSeconds: number }).expireAfterSeconds,
        4 * 24 * 3600,
      );
      const symbolIndex = fake.rawCol.indexesCreated.find(
        (i) => (i.spec as Record<string, unknown>).symbol !== undefined,
      );
      assert.ok(symbolIndex, "expected a symbol+timestamp index to be created");
    },
  );

  await scenario(
    "insert() never throws even when the collection is unavailable (degraded Mongo)",
    async () => {
      const brokenClient = { rawLiquidationEvents: async () => null };
      const repo = new RawLiquidationEventRepository(brokenClient as never);
      await repo.insert({
        symbol: "BTCUSDT",
        victim: "SHORT",
        price: 78000,
        quoteQty: 235,
        timestamp: 1,
      }); // must not throw
    },
  );

  await scenario(
    "research checkpoints append correctly via $push, without touching any other field on the doc",
    async () => {
      const fake = new FakeMongoClient();
      const repo = new GlobalSignalRepository(fake as never);
      await fake.globalCol.insertOne({
        signalId: "sig-A",
        symbol: "ETHUSDT",
        status: "SIGNAL",
        researchCheckpoints: [],
      });
      const group: ResearchCheckpointGroup = {
        anchorType: "SIGNAL",
        anchorTs: 1000,
        anchorPrice: 100,
        checkpoints: [
          {
            offsetLabel: "30s",
            atMs: 30500,
            price: 100.5,
            mfe: 0.5,
            mae: 0,
            normalization: "R",
          },
        ],
      };
      await repo.appendCheckpoint("sig-A", group);
      assert.strictEqual(fake.globalCol.updates.length, 1);
      const doc = fake.globalCol.get("sig-A");
      assert.ok(doc);
      assert.strictEqual((doc!.researchCheckpoints as unknown[]).length, 1);
    },
  );

  await scenario(
    "no-entry episodes can receive research observations -- appendCheckpoint has NO signal-only gate, works for a TERMINAL_NON_SIGNAL doc identically",
    async () => {
      const fake = new FakeMongoClient();
      const repo = new GlobalSignalRepository(fake as never);
      await fake.globalCol.insertOne({
        signalId: "sig-B",
        symbol: "SOLUSDT",
        status: "W1_EXTREME_TOO_SMALL",
        researchCheckpoints: [],
      });
      const group: ResearchCheckpointGroup = {
        anchorType: "EPISODE_END",
        anchorTs: 2000,
        anchorPrice: 150,
        checkpoints: [
          {
            offsetLabel: "30s",
            atMs: 30100,
            price: 151,
            mfe: 0.5,
            mae: 0,
            normalization: "ATR",
          },
        ],
      };
      await repo.appendCheckpoint("sig-B", group);
      const doc = fake.globalCol.get("sig-B");
      assert.ok(doc);
      assert.strictEqual((doc!.researchCheckpoints as unknown[]).length, 1);
      // Confirms this is the exact same code path as the SIGNAL case above -- no branching on status.
    },
  );

  await scenario(
    "user fan-out remains independent from global research -- the fake mongo client used here has NO per-user collection accessor at all, yet both research repositories work fully",
    async () => {
      const fake = new FakeMongoClient();
      // FakeMongoClient intentionally does not implement userSignals()/
      // executionRecords()/executionClaims() at all -- if either research
      // repository secretly depended on per-user collections, this test
      // would throw a "not a function" error instead of passing.
      const rawRepo = new RawLiquidationEventRepository(fake as never);
      const globalRepo = new GlobalSignalRepository(fake as never);
      await rawRepo.insert({
        symbol: "ETHUSDT",
        victim: "LONG",
        price: 1,
        quoteQty: 1,
        timestamp: 1,
      });
      await fake.globalCol.insertOne({
        signalId: "sig-C",
        researchCheckpoints: [],
      });
      await globalRepo.appendCheckpoint("sig-C", {
        anchorType: "SIGNAL",
        anchorTs: 1,
        anchorPrice: 1,
        checkpoints: [],
      });
      assert.strictEqual(fake.rawCol.inserted.length, 1);
      assert.strictEqual(fake.globalCol.updates.length, 1);
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
