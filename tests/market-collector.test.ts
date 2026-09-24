/**
 * Market collector writes exactly what V9 and the research read:
 *  - forced SELL order = LONG victim (and BUY = SHORT), USD size, event time
 *  - OI rows carry Binance's update time and the latest bookTicker mid price
 * Usage: npx tsx tests/market-collector.test.ts
 */
import * as assert from "assert";
import { EventEmitter } from "events";
import { MarketCollector } from "../src/collector/market-collector";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}

async function run(): Promise<void> {
  console.log("Market collector");
  await scenario("liquidations and OI rows are written with the right fields", async () => {
    const ws = Object.assign(new EventEmitter(), { subscribed: null as unknown, subscribe(s: unknown) { this.subscribed = s; }, start() {}, stop() {} });
    const liq: unknown[] = [], oi: Array<Record<string, unknown>> = [];
    const c = new MarketCollector(["BTCUSDT"], {} as never,
      { insert: async (d: unknown) => { liq.push(d); } } as never,
      { add: (d: Record<string, unknown>) => { oi.push(d); }, start() {}, stop: async () => {} } as never,
      async () => {}, ws as never);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ openInterest: "12345.6", time: 1_790_000_000_500 }) })) as never;
    try {
      c.start();
      ws.emit("bookTicker", { symbol: "BTCUSDT", bid: 100, ask: 102 });
      ws.emit("liquidation", { symbol: "BTCUSDT", side: "SELL", price: 99, quantity: 1, quoteQty: 99, timestamp: 1_790_000_000_000 });
      ws.emit("liquidation", { symbol: "BTCUSDT", side: "BUY", price: 103, quantity: 2, quoteQty: 206, timestamp: 1_790_000_001_000 });
      await c.pollOi();
      assert.deepStrictEqual(liq, [
        { symbol: "BTCUSDT", victim: "LONG", price: 99, quoteQty: 99, timestamp: 1_790_000_000_000 },
        { symbol: "BTCUSDT", victim: "SHORT", price: 103, quoteQty: 206, timestamp: 1_790_000_001_000 },
      ]);
      assert.strictEqual(oi.length, 1);
      assert.strictEqual(oi[0].openInterest, 12345.6);
      assert.strictEqual(oi[0].price, 101);
      assert.strictEqual((oi[0].oiUpdatedAt as Date).getTime(), 1_790_000_000_500);
      assert.deepStrictEqual((ws.subscribed as { intervals: unknown[]; forceOrder: boolean; bookTicker: boolean; depth: boolean; aggTrade: boolean }), { symbols: ["BTCUSDT"], intervals: [], aggTrade: false, bookTicker: true, depth: false, forceOrder: true });
    } finally {
      globalThis.fetch = realFetch;
      await c.stop();
    }
  });
  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
