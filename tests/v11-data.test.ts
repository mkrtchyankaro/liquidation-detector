/**
 * V11 data source (Oct 12 2026) against a local fake Binance (HTTP) and a fake database: 1h klines, OI at the hour
 * edges from the 5m history (T = OI at T), our liquidations summed per hour, "unknown" hours, the still-open hour never
 * returned, incremental fetching, the entry hour's open.
 * Usage: npx tsx tests/v11-data.test.ts
 */
import * as assert from "assert";
import * as http from "http";
import type { AddressInfo } from "net";
import type { Db } from "mongodb";
import { BinanceMongoV11Source, MIN_MINUTES } from "../src/strategy/v11/v11-data";
import { H } from "../src/strategy/v11/v11-engine";

// the fake Binance is local: never through a proxy of the machine running the tests
process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`); }
}
const M = 60_000, M5 = 5 * M;
const T0 = Date.UTC(2026, 9, 10, 0, 0);
const NOW = T0 + 30 * H + 2 * M;          // 06:02 on day 2 -> the last closed hour is 05:00-06:00
/** the fake world's clock (Binance and the source read it) */
const clock = { now: NOW };

/** fake Binance: candle k (open T0 + k h) = o 100+k, h +2, l -1, c +1; OI every 5 min = 1000 + minutes since T0 */
function fakeBinance(log: string[]): http.Server {
  return http.createServer((req, res) => {
    const u = new URL(req.url!, "http://x"), q = (k: string): number => Number(u.searchParams.get(k));
    log.push(u.pathname);
    let out: unknown = [];
    if (u.pathname === "/fapi/v1/klines") {
      const rows: unknown[][] = [];
      const end = u.searchParams.has("endTime") ? q("endTime") : Infinity;
      for (let t = Math.ceil(q("startTime") / H) * H; t <= Math.min(end, clock.now) && rows.length < q("limit"); t += H) {
        const k = (t - T0) / H;
        rows.push([t, String(100 + k), String(102 + k), String(99 + k), String(101 + k), "1", t + H - 1]);
      }
      out = rows;
    } else if (u.pathname === "/futures/data/openInterestHist") {
      const rows: unknown[] = [];
      // Binance publishes a 5m point a little after its time: nothing newer than NOW - 1 min
      for (let t = Math.ceil(q("startTime") / M5) * M5; t <= Math.min(q("endTime"), clock.now - M) && rows.length < q("limit"); t += M5)
        rows.push({ symbol: "AAAUSDT", timestamp: t, sumOpenInterest: String(1000 + (t - T0) / M), sumOpenInterestValue: "0" });
      out = rows;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
}
/** fake minute_bars: every minute of every hour, $10 short + $1 long liquidations each; hour 3 has only 40 rows */
function fakeDb(queries: Array<{ from: number; to: number }>): () => Promise<Db> {
  const rows: Array<{ ts: Date; shortLiqUsd: number; longLiqUsd: number }> = [];
  for (let t = T0 - 50 * H; t < NOW + 2 * H; t += M) {
    const hour = Math.floor((t - T0) / H);
    if (hour === 3 && (t - T0 - 3 * H) / M >= 40) continue;
    rows.push({ ts: new Date(t), shortLiqUsd: 10, longLiqUsd: 1 });
  }
  const db = {
    collection: () => ({
      find: (f: { ts: { $gte: Date; $lt: Date } }) => {
        queries.push({ from: f.ts.$gte.getTime(), to: f.ts.$lt.getTime() });
        const sel = rows.filter((r) => r.ts >= f.ts.$gte && r.ts < f.ts.$lt && r.ts.getTime() < clock.now);
        return { project: () => ({ toArray: async () => sel.map((r) => ({ ...r })) }) };
      },
    }),
  };
  return async () => db as unknown as Db;
}

async function run(): Promise<void> {
  console.log("V11 data source");
  const log: string[] = [], queries: Array<{ from: number; to: number }> = [];
  const server = fakeBinance(log);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const src = new BinanceMongoV11Source(fakeDb(queries), base, () => clock.now);
    const lastClosed = T0 + 29 * H;    // 05:00 on day 2

    await scenario("bars: price from the 1h klines, OI at the hour edges (oo = OI at t, oc = OI at t + 1h), liquidations summed per hour", async () => {
      const bars = await src.bars("AAAUSDT", T0, lastClosed + H);
      assert.strictEqual(bars.length, 30);
      const b = bars[5]!;
      assert.deepStrictEqual([b.t, b.o, b.h, b.l, b.c], [T0 + 5 * H, 105, 107, 104, 106]);
      assert.strictEqual(b.oo, 1000 + 5 * 60);
      assert.strictEqual(b.oc, 1000 + 6 * 60);
      assert.strictEqual(b.shortLiq, 600);
      assert.strictEqual(b.longLiq, 60);
      assert.strictEqual(b.liqOk, true);
      assert.ok(bars[29], "the last closed hour is there (its closing OI point is published)");
    });

    await scenario(`an hour with fewer than ${MIN_MINUTES} of our minute rows = liquidations unknown (liqOk false)`, async () => {
      const bars = await src.bars("AAAUSDT", T0, lastClosed + H);
      assert.strictEqual(bars[3]!.liqOk, false);
      assert.strictEqual(bars[3]!.shortLiq, 400);
    });

    await scenario("the still-open hour is never returned; an hour whose closing OI point Binance has not published yet is null", async () => {
      const bars = await src.bars("AAAUSDT", T0, lastClosed + 2 * H);
      assert.strictEqual(bars[30], null, "06:00 is still open");
      clock.now = T0 + 30 * H + 30_000;        // 06:00:30 -- the 06:00 OI point is not out yet (fake: 1 min delay)
      const fresh = new BinanceMongoV11Source(fakeDb([]), base, () => clock.now);
      const b2 = await fresh.bars("AAAUSDT", T0, lastClosed + H);
      assert.strictEqual(b2[29], null, "no closing OI yet -> null -> the service waits");
      clock.now = T0 + 30 * H + 90_000;        // 06:01:30 -- out now: the same source asks again and gets it
      const b3 = await fresh.bars("AAAUSDT", T0, lastClosed + H);
      assert.ok(b3[29] && b3[29].oc === 1000 + 30 * 60, JSON.stringify(b3[29]));
      clock.now = NOW;
    });

    await scenario("incremental: a second call one hour later asks Binance / the database only for what is new", async () => {
      const k0 = log.length, q0 = queries.length;
      await src.bars("AAAUSDT", T0, lastClosed + H);
      const again = log.slice(k0);
      assert.ok(!again.includes("/fapi/v1/klines"), `no klines asked again: ${again}`);
      const q = queries.slice(q0);
      assert.ok(q.every((x) => x.from >= Math.floor(NOW / H) * H - 2 * H), `only the newest hours of liquidations re-read: ${JSON.stringify(q)}`);
      clock.now = NOW + H;
      const bars = await src.bars("AAAUSDT", T0 + H, lastClosed + 2 * H);
      assert.strictEqual(bars.length, 30);
      assert.strictEqual(bars[29]!.t, lastClosed + H);
      assert.strictEqual(bars[29]!.oc, 1000 + 31 * 60);
      clock.now = NOW;
    });

    await scenario("hourOpen: the open of the entry hour (the candle that just started)", async () => {
      assert.strictEqual(await src.hourOpen("AAAUSDT", T0 + 30 * H), 130);
    });
  } finally {
    server.close();
  }
  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
