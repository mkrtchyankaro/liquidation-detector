/**
 * V9 Mongo feed: overlapping re-reads never double-count liquidations;
 * late-flushed rows inside the overlap window are still picked up.
 * Usage: npx tsx tests/v9-feed.test.ts
 */
import * as assert from "assert";
import { V9MongoFeed } from "../src/strategy/v9/v9-feed";
import { V9MinuteStore } from "../src/strategy/v9/v9-minute-store";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
type Row = Record<string, unknown> & { _id: string };
function fakeDb(liq: Row[], oi: Row[]) {
  const col = (rows: Row[], field: string) => ({
    find: (q: Record<string, { $gte: number | Date }>) => {
      const from = q.timestamp.$gte instanceof Date ? q.timestamp.$gte.getTime() : Number(q.timestamp.$gte);
      const out = rows.filter((r) => (r[field] instanceof Date ? (r[field] as Date).getTime() : Number(r[field])) >= from);
      const chain = { project: () => chain, sort: () => chain, batchSize: () => chain, [Symbol.asyncIterator]: async function* () { yield* out; } };
      return chain;
    },
  });
  return { collection: (n: string) => (n === "liq_raw_events" ? col(liq, "timestamp") : col(oi, "timestamp")) };
}
const T = 1_790_300_000_000 - (1_790_300_000_000 % 60_000);

async function run(): Promise<void> {
  console.log("V9 feed");
  await scenario("overlapping polls apply each liquidation exactly once; a late-flushed row is still applied", async () => {
    const liq: Row[] = [{ _id: "a", timestamp: T + 1_000, victim: "LONG", quoteQty: 100 }];
    const oi: Row[] = [{ _id: "o1", timestamp: new Date(T + 2_000), oiUpdatedAt: new Date(T + 1_500), openInterest: 10, price: 5 }];
    const feed = new V9MongoFeed(async () => fakeDb(liq, oi) as never);
    const store = new V9MinuteStore();
    await feed.warmUp("X", store, T - 60_000);
    liq.push({ _id: "b", timestamp: T + 30_000, victim: "LONG", quoteQty: 50 });
    await feed.poll("X", store);
    liq.push({ _id: "c", timestamp: T + 20_000, victim: "SHORT", quoteQty: 7 }); // older than the cursor: late write
    await feed.poll("X", store);
    await feed.poll("X", store); // nothing new
    const b = store.toBuckets(T, T + 59_000)[0];
    assert.strictEqual(b.long, 150);
    assert.strictEqual(b.short, 7);
    assert.strictEqual(b.count, 3);
    assert.strictEqual(b.oi, 10);
  });
  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
