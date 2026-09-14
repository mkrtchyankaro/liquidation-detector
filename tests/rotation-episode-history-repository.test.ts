import * as assert from "assert";
import { RotationEpisodeHistoryRepository } from "../src/infrastructure/mongo/rotation-episode-history.repository";
import type { RotationEpisodeHistoryDoc } from "../src/domain/signal/rotation-episode-history.model";

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

/** A fake collection that genuinely enforces the SAME uniqueness
 *  contract the real {symbol, victim, episodeStartTs} unique index
 *  provides: an upsert against an already-existing key is a no-op
 *  (upsertedCount=0), never a second document. */
class FakeRotationHistoryCollection {
  store = new Map<string, RotationEpisodeHistoryDoc>();

  private key(filter: {
    symbol: string;
    victim: string;
    episodeStartTs: number;
  }): string {
    return `${filter.symbol}|${filter.victim}|${filter.episodeStartTs}`;
  }

  async updateOne(
    filter: { symbol: string; victim: string; episodeStartTs: number },
    update: { $setOnInsert: RotationEpisodeHistoryDoc },
    opts: { upsert: boolean },
  ): Promise<{ upsertedCount: number }> {
    const k = this.key(filter);
    if (this.store.has(k)) return { upsertedCount: 0 };
    if (!opts.upsert) return { upsertedCount: 0 };
    this.store.set(k, update.$setOnInsert);
    return { upsertedCount: 1 };
  }

  find(query: {
    symbol: string;
    victim: string;
    episodeEndTs: { $lt: number };
  }) {
    const rows = [...this.store.values()].filter(
      (d) =>
        d.symbol === query.symbol &&
        d.victim === query.victim &&
        d.episodeEndTs < query.episodeEndTs.$lt,
    );
    return {
      project<T>(): { limit: (n: number) => { toArray: () => Promise<T[]> } } {
        return {
          limit: (n: number) => ({
            toArray: async () =>
              rows
                .slice(0, n)
                .map((d) => ({
                  cumulativeLiqUsd: d.cumulativeLiqUsd,
                  episodeEndTs: d.episodeEndTs,
                })) as unknown as T[],
          }),
        };
      },
    };
  }

  async createIndex(): Promise<void> {
    // no-op for the fake -- real index behavior is what the unique
    // {symbol,victim,episodeStartTs} key check in updateOne() above
    // already simulates for these tests' own purposes.
  }
}

function fakeMongo(col: FakeRotationHistoryCollection) {
  return {
    rotationEpisodeHistory: async () => col,
  } as unknown as import("../src/infrastructure/mongo/mongo.client").MongoClientWrapper;
}

function baseDoc(
  overrides: Partial<RotationEpisodeHistoryDoc>,
): RotationEpisodeHistoryDoc {
  return {
    symbol: "ETHUSDT",
    victim: "LONG",
    episodeStartTs: 1000,
    episodeEndTs: 2000,
    cumulativeLiqUsd: 50000,
    eventCount: 5,
    maxSingleLiqUsd: 20000,
    startPrice: 1000,
    adverseExtremePrice: 990,
    adverseExtremeTs: 1500,
    preLiqDownAtr: 5,
    preLiqUpAtr: 5,
    finalDownAtr: 4,
    finalUpAtr: 6,
    durationMs: 1000,
    completionReason: "INACTIVITY",
    entryMode: "ROTATION",
    algorithmVersion: "backfill-v1",
    finalDiagnostics: null,
    source: "backfill",
    createdAt: Date.now(),
    ...overrides,
  };
}

console.log("Running RotationEpisodeHistoryRepository tests...\n");

async function main(): Promise<void> {
  await scenario(
    "9. rerunning the backfill (same episode identity) creates no duplicates",
    async () => {
      const col = new FakeRotationHistoryCollection();
      const repo = new RotationEpisodeHistoryRepository(fakeMongo(col));
      const doc = baseDoc({});
      const first = await repo.upsertEpisode(doc);
      const second = await repo.upsertEpisode(doc); // identical episode, rerun
      assert.strictEqual(first, "inserted");
      assert.strictEqual(second, "duplicate");
      assert.strictEqual(
        col.store.size,
        1,
        "exactly one document must exist after two identical upserts",
      );
    },
  );

  await scenario(
    "different episodes (different episodeStartTs) for the SAME symbol+victim are NOT treated as duplicates",
    async () => {
      const col = new FakeRotationHistoryCollection();
      const repo = new RotationEpisodeHistoryRepository(fakeMongo(col));
      await repo.upsertEpisode(
        baseDoc({ episodeStartTs: 1000, episodeEndTs: 2000 }),
      );
      await repo.upsertEpisode(
        baseDoc({ episodeStartTs: 5000, episodeEndTs: 6000 }),
      );
      assert.strictEqual(col.store.size, 2);
    },
  );

  await scenario(
    "10. causal read only returns SAME symbol+victim episodes completed strictly before the given watch-creation timestamp",
    async () => {
      const col = new FakeRotationHistoryCollection();
      const repo = new RotationEpisodeHistoryRepository(fakeMongo(col));
      await repo.upsertEpisode(
        baseDoc({
          symbol: "ETHUSDT",
          victim: "LONG",
          episodeStartTs: 1000,
          episodeEndTs: 2000,
          cumulativeLiqUsd: 10000,
        }),
      );
      await repo.upsertEpisode(
        baseDoc({
          symbol: "ETHUSDT",
          victim: "SHORT",
          episodeStartTs: 1000,
          episodeEndTs: 2000,
          cumulativeLiqUsd: 99999,
        }),
      ); // wrong victim
      await repo.upsertEpisode(
        baseDoc({
          symbol: "BTCUSDT",
          victim: "LONG",
          episodeStartTs: 1000,
          episodeEndTs: 2000,
          cumulativeLiqUsd: 88888,
        }),
      ); // wrong symbol
      await repo.upsertEpisode(
        baseDoc({
          symbol: "ETHUSDT",
          victim: "LONG",
          episodeStartTs: 50000,
          episodeEndTs: 60000,
          cumulativeLiqUsd: 77777,
        }),
      ); // completed AFTER the watch in question -- must be excluded
      const rows = await repo.findCausalPriorEpisodes("ETHUSDT", "LONG", 40000);
      assert.strictEqual(
        rows.length,
        1,
        "only the ETHUSDT LONG episode completed strictly before 40000 must be returned",
      );
      assert.strictEqual(rows[0]!.totalUsd, 10000);
    },
  );

  await scenario(
    "no artificial 20-sample cap -- thousands of prior episodes are all returned, not just the most recent 20 (or 500)",
    async () => {
      const col = new FakeRotationHistoryCollection();
      const repo = new RotationEpisodeHistoryRepository(fakeMongo(col));
      for (let i = 0; i < 2000; i++) {
        await repo.upsertEpisode(
          baseDoc({
            episodeStartTs: 1000 + i,
            episodeEndTs: 2000 + i,
            cumulativeLiqUsd: 1000 + i,
          }),
        );
      }
      const rows = await repo.findCausalPriorEpisodes(
        "ETHUSDT",
        "LONG",
        999_999_999,
      );
      assert.strictEqual(
        rows.length,
        2000,
        "all 2000 valid causal prior episodes must be returned, no artificial cap",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
