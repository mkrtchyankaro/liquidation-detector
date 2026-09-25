/**
 * minute_bars: raw rows -> one bar per minute; idempotent upserts; live writer
 * skips the unfinished minute.
 * Usage: npx tsx tests/minute-bars.test.ts
 */
import * as assert from "assert";
import { aggregateMinuteBars, MinuteBarWriter, writeMinuteBars, MINUTE_BARS } from "../src/collector/minute-bars";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const M = 60_000, T0 = Date.UTC(2026, 8, 25, 8, 0);

function fakeDb(liq: Array<Record<string, unknown>>, oi: Array<Record<string, unknown>>) {
  const bars: Array<Record<string, unknown>> = [];
  const inRange = (v: number, q: { $gte: number; $lt: number }) => v >= q.$gte && v < q.$lt;
  const col = (name: string) => ({
    find: (q: { symbol: string; timestamp: { $gte: number | Date; $lt: number | Date } }) => {
      const r = { $gte: Number(new Date(q.timestamp.$gte as never)), $lt: Number(new Date(q.timestamp.$lt as never)) };
      const src = name === "liq_raw_events" ? liq : oi;
      const rows = src.filter((x) => x.symbol === q.symbol && inRange(Number(new Date(x.timestamp as never)), r));
      return { project: () => ({ toArray: async () => rows }) };
    },
    bulkWrite: async (ops: Array<{ updateOne: { filter: { symbol: string; ts: Date }; update: { $set: Record<string, unknown> } } }>) => {
      assert.strictEqual(name, MINUTE_BARS);
      for (const { updateOne: { filter, update } } of ops) {
        let row = bars.find((b) => b.symbol === filter.symbol && (b.ts as Date).getTime() === filter.ts.getTime());
        if (!row) { row = {}; bars.push(row); }
        Object.assign(row, update.$set);
      }
    },
  });
  return { bars, db: { collection: col } as never };
}

async function run(): Promise<void> {
  console.log("Minute bars");

  await scenario("OHLC from polls, OI first/last/min/max, liquidations summed per side", () => {
    const oi = [
      { ts: T0 + 1_000, oi: 100, price: 10 }, { ts: T0 + 20_000, oi: 98, price: 9.5 },
      { ts: T0 + 40_000, oi: 99, price: 10.4 }, { ts: T0 + 59_000, oi: 97, price: 10.1 },
    ];
    const liq = [{ ts: T0 + 5_000, victim: "LONG", usd: 1000 }, { ts: T0 + 6_000, victim: "LONG", usd: 500 }, { ts: T0 + 7_000, victim: "SHORT", usd: 50 }];
    const [b] = aggregateMinuteBars("ADAUSDT", liq, oi, T0, T0 + M);
    assert.deepStrictEqual([b.open, b.high, b.low, b.close], [10, 10.4, 9.5, 10.1]);
    assert.deepStrictEqual([b.oiFirst, b.oiLast, b.oiMin, b.oiMax], [100, 97, 97, 100]);
    assert.deepStrictEqual([b.longLiqUsd, b.longLiqCount, b.shortLiqUsd, b.shortLiqCount, b.polls], [1500, 2, 50, 1, 4]);
  });

  await scenario("rows are split into their own minutes; out-of-range rows ignored", () => {
    const oi = [{ ts: T0 - 1, oi: 1, price: 1 }, { ts: T0 + 10, oi: 100, price: 10 }, { ts: T0 + M + 10, oi: 101, price: 11 }, { ts: T0 + 2 * M, oi: 1, price: 1 }];
    const bars = aggregateMinuteBars("X", [], oi, T0, T0 + 2 * M);
    assert.deepStrictEqual(bars.map((b) => [b.ts.getTime(), b.close]), [[T0, 10], [T0 + M, 11]]);
  });

  await scenario("re-writing the same minutes is idempotent (late rows update the bar, never duplicate it)", async () => {
    const oi = [{ symbol: "X", timestamp: new Date(T0 + 1_000), openInterest: 100, price: 10 }];
    const liq = [{ symbol: "X", timestamp: T0 + 2_000, victim: "LONG", quoteQty: 300 }];
    const f = fakeDb(liq, oi);
    await writeMinuteBars(f.db, "X", T0, T0 + M);
    oi.push({ symbol: "X", timestamp: new Date(T0 + 50_000), openInterest: 90, price: 9 }); // late batch
    await writeMinuteBars(f.db, "X", T0, T0 + M);
    assert.strictEqual(f.bars.length, 1);
    assert.strictEqual(f.bars[0].close, 9);
    assert.strictEqual(f.bars[0].longLiqUsd, 300);
  });

  await scenario("live writer covers the last 3 whole minutes and never the unfinished one", async () => {
    const oi = [0, 1, 2, 3].map((k) => ({ symbol: "X", timestamp: new Date(T0 + k * M + 1_000), openInterest: 100 + k, price: 10 + k }));
    const f = fakeDb([], oi);
    const w = new MinuteBarWriter(["X"], async () => f.db, () => T0 + 3 * M + 20_000);
    await w.runOnce();
    assert.deepStrictEqual(f.bars.map((b) => (b.ts as Date).getTime()).sort(), [T0, T0 + M, T0 + 2 * M]);
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
