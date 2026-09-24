/**
 * Market context collector: ratio rows -> percentages per 5-min period,
 * 30-day backfill paging covers exactly the missing range, premium rows.
 * Usage: npx tsx tests/context-collector.test.ts
 */
import * as assert from "assert";
import { backfillPages, ContextCollector, toPositioningUpdates, toPremiumDoc, POSITIONING, PREMIUM } from "../src/collector/context-collector";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const P = 5 * 60_000;
const NOW = 1_790_300_000_000 - (1_790_300_000_000 % P);

function fakeDb() {
  const data: Record<string, Array<Record<string, unknown>>> = { [POSITIONING]: [], [PREMIUM]: [] };
  const col = (name: string) => ({
    createIndex: async () => "",
    insertMany: async (docs: Array<Record<string, unknown>>) => { data[name].push(...docs); },
    bulkWrite: async (ops: Array<{ updateOne: { filter: { symbol: string; ts: Date }; update: { $set: Record<string, unknown> } } }>) => {
      for (const { updateOne: { filter, update } } of ops) {
        let row = data[name].find((r) => r.symbol === filter.symbol && (r.ts as Date).getTime() === filter.ts.getTime());
        if (!row) { row = { ...filter }; data[name].push(row); }
        Object.assign(row, update.$set);
      }
    },
    find: (q: Record<string, unknown>) => {
      const kind = Object.keys(q).find((k) => k !== "symbol")!;
      const rows = data[name].filter((r) => r.symbol === q.symbol && r[kind] !== undefined).sort((a, b) => (b.ts as Date).getTime() - (a.ts as Date).getTime());
      const chain = { sort: () => chain, limit: () => chain, next: async () => rows[0] ?? null };
      return chain;
    },
  });
  return { data, db: async () => ({ collection: col }) as never };
}

async function run(): Promise<void> {
  console.log("Context collector");

  await scenario("ratio rows become % long / % short per period", () => {
    const u = toPositioningUpdates("BTCUSDT", "topPositions", [{ longAccount: "0.7", shortAccount: "0.3", longShortRatio: "2.3333", timestamp: NOW }]);
    assert.deepStrictEqual(u[0].value, { longPct: 70, shortPct: 30, ratio: 2.3333 });
    assert.strictEqual(u[0].ts.getTime(), NOW);
  });

  await scenario("backfill pages cover exactly (latest, now], in pages of 500 periods, never beyond ~30 days", () => {
    const pages = backfillPages(null, NOW);
    assert.ok(pages[0].startTime >= NOW - 30 * 24 * 3_600_000);
    assert.strictEqual(pages.at(-1)!.endTime, NOW);
    for (let i = 1; i < pages.length; i++) assert.strictEqual(pages[i].startTime, pages[i - 1].endTime + P);
    for (const p of pages) assert.ok((p.endTime - p.startTime) / P <= 499);
    assert.deepStrictEqual(backfillPages(NOW - 2 * P, NOW), [{ startTime: NOW - P, endTime: NOW }]);
    assert.deepStrictEqual(backfillPages(NOW, NOW), []);
  });

  await scenario("premium row: premium % and funding", () => {
    const d = toPremiumDoc({ symbol: "BTCUSDT", markPrice: "101", indexPrice: "100", lastFundingRate: "0.0001", nextFundingTime: NOW + 3_600_000, time: NOW });
    assert.ok(Math.abs(d.premiumPct - 1) < 1e-12);
    assert.strictEqual(d.fundingRate, 0.0001);
  });

  await scenario("backfill + poll merge three ratios into ONE row per period; premium stored for tracked symbols only", async () => {
    const f = fakeDb();
    const calls: string[] = [];
    const get = async (path: string, p: Record<string, string | number>) => {
      calls.push(path);
      if (path === "/fapi/v1/premiumIndex") return [
        { symbol: "BTCUSDT", markPrice: "101", indexPrice: "100", lastFundingRate: "0.0001", nextFundingTime: NOW, time: NOW },
        { symbol: "XYZUSDT", markPrice: "1", indexPrice: "1", lastFundingRate: "0", nextFundingTime: NOW, time: NOW },
      ];
      const end = Number(p.endTime ?? NOW), start = Number(p.startTime ?? NOW - 2 * P);
      const rows = [];
      for (let t = Math.max(start, NOW - 2 * P); t <= end; t += P) rows.push({ longAccount: "0.6", shortAccount: "0.4", longShortRatio: "1.5", timestamp: t });
      return rows;
    };
    const c = new ContextCollector(["BTCUSDT"], f.db, get, () => NOW);
    await c.backfill();
    await c.pollPositioning();
    await c.pollPremium();
    const rows = f.data[POSITIONING];
    assert.strictEqual(rows.length, 3, "three periods, one row each");
    for (const r of rows) for (const k of ["global", "topAccounts", "topPositions"]) assert.ok(r[k], `row has ${k}`);
    assert.deepStrictEqual(f.data[PREMIUM].map((d) => d.symbol), ["BTCUSDT"]);
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
