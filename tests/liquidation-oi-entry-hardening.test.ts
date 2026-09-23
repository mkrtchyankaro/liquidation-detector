/**
 * Regression tests for the hardened LOX REAL entry path:
 *  - leverage + margin mode applied before the entry order
 *  - pre-flight at the executable price (skip when beyond SL/TP, re-size to riskUsd)
 *  - a reported fill is ALWAYS protected even if positionRisk lags
 *  - protection qty comes from OUR fill, not the symbol aggregate
 *  - startup readiness: hedge mode / bad keys / empty wallet are refused
 *
 * Usage: npx tsx tests/liquidation-oi-entry-hardening.test.ts
 */
import * as assert from "assert";
import { runEntrySequence, type BinanceRestLike } from "../src/infrastructure/binance/liquidation-oi-user-execution.service";
import { checkLoxRealReadiness } from "../src/services/lox-real-readiness";

let passed = 0;
let failed = 0;
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}

const EXCHANGE_INFO = { symbols: [{ symbol: "DOGEUSDT", pricePrecision: 5, quantityPrecision: 0, filters: [
  { filterType: "PRICE_FILTER", tickSize: "0.00001" }, { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" }, { filterType: "MIN_NOTIONAL", notional: "5" },
] }] };

interface MockOpts {
  ask?: number; bid?: number; positionAmt?: string; positionLagsForever?: boolean;
  fillAvg?: string; fillQty?: string; marginErr?: string;
}
function mockRest(o: MockOpts = {}) {
  const calls: Array<{ fn: string; p?: Record<string, unknown> }> = [];
  const rest = {
    calls,
    getExchangeInfo: async () => EXCHANGE_INFO,
    getBookTicker: async () => ({ askPrice: String(o.ask ?? 0.2), bidPrice: String(o.bid ?? 0.1999) }),
    setMarginType: async (_s: string, m: string) => { calls.push({ fn: "setMarginType", p: { m } }); if (o.marginErr) throw new Error(o.marginErr); return {}; },
    setLeverage: async (_s: string, l: number) => { calls.push({ fn: "setLeverage", p: { l } }); return {}; },
    createOrder: async (p: Record<string, unknown>) => {
      calls.push({ fn: "createOrder", p });
      if (p.type === "MARKET" && p.reduceOnly === undefined) return { orderId: 1, avgPrice: o.fillAvg ?? "0.2", executedQty: o.fillQty ?? String(p.quantity) };
      return { orderId: 2 };
    },
    createAlgoOrder: async (p: Record<string, unknown>) => { calls.push({ fn: "createAlgoOrder", p }); return { algoId: 9 }; },
    getAlgoOrder: async () => ({ algoStatus: "WORKING" }),
    getAlgoOrderByClientId: async () => ({ algoStatus: "WORKING" }),
    cancelAlgoOrder: async () => ({}),
    getOrder: async () => ({ status: "NEW" }),
    getPositionRisk: async () => [{ symbol: "DOGEUSDT", positionAmt: o.positionLagsForever ? "0" : (o.positionAmt ?? "100"), entryPrice: "0.2" }],
    cancelOrder: async () => ({}),
    getOpenOrders: async () => [],
    getOpenAlgoOrders: async () => [],
  };
  return rest as typeof rest & BinanceRestLike;
}
const base = { userId: "karo", globalSignalId: "g1", symbol: "DOGEUSDT", side: "LONG" as const, quantity: 50, entryPriceEstimate: 0.2, slPrice: 0.198, initialTpPrice: 0.204 };

async function run(): Promise<void> {
  console.log("LOX entry hardening");

  await scenario("margin mode and leverage are applied BEFORE the entry order", async () => {
    const r = mockRest();
    const out = await runEntrySequence(r, { ...base, marginMode: "ISOLATED", leverage: 20 });
    assert.strictEqual(out.outcome, "ENTRY_ACTIVE_WITH_TP");
    const order = r.calls.map((c) => c.fn);
    assert.ok(order.indexOf("setMarginType") < order.indexOf("createOrder"));
    assert.ok(order.indexOf("setLeverage") < order.indexOf("createOrder"));
  });

  await scenario("'No need to change margin type' (-4046) is treated as success", async () => {
    const r = mockRest({ marginErr: "Binance API error -4046: No need to change margin type." });
    const out = await runEntrySequence(r, { ...base, marginMode: "ISOLATED" });
    assert.strictEqual(out.outcome, "ENTRY_ACTIVE_WITH_TP");
  });

  await scenario("any other margin error aborts BEFORE an order is sent", async () => {
    const r = mockRest({ marginErr: "Binance API error -2015: Invalid API-key" });
    const out = await runEntrySequence(r, { ...base, marginMode: "ISOLATED" });
    assert.strictEqual(out.outcome, "ENTRY_FAILED");
    assert.ok(!r.calls.some((c) => c.fn === "createOrder"));
  });

  await scenario("pre-flight: executable price already beyond SL -> no order", async () => {
    const r = mockRest({ ask: 0.1979 });
    const out = await runEntrySequence(r, base);
    assert.strictEqual(out.outcome, "ENTRY_FAILED");
    assert.ok(out.outcome === "ENTRY_FAILED" && out.reason.includes("beyond SL"));
    assert.ok(!r.calls.some((c) => c.fn === "createOrder"));
  });

  await scenario("pre-flight: executable price already beyond TP -> no order", async () => {
    const r = mockRest({ ask: 0.2041 });
    const out = await runEntrySequence(r, base);
    assert.ok(out.outcome === "ENTRY_FAILED" && out.reason.includes("beyond TP"));
  });

  await scenario("quantity is re-sized at the executable price to keep risk = riskUsd", async () => {
    // ask 0.199 -> distance to SL 0.001 -> qty = 1 / 0.001 = 1000
    const r = mockRest({ ask: 0.199, fillAvg: "0.199" });
    const out = await runEntrySequence(r, { ...base, riskUsd: 1 });
    const entry = r.calls.find((c) => c.fn === "createOrder" && c.p?.type === "MARKET");
    assert.strictEqual(entry?.p?.quantity, "1000");
    assert.ok(out.outcome === "ENTRY_ACTIVE_WITH_TP" && Math.abs((out.actualRiskUsd ?? 0) - 1) < 1e-9);
  });

  await scenario("a REPORTED fill is protected with SL even if positionRisk never shows it", async () => {
    const r = mockRest({ positionLagsForever: true, fillQty: "50" });
    const out = await runEntrySequence(r, base);
    assert.strictEqual(out.outcome, "ENTRY_ACTIVE_WITH_TP");
    assert.ok(r.calls.some((c) => c.fn === "createAlgoOrder" && c.p?.type === "STOP_MARKET"));
  });

  await scenario("SL/TP quantity is OUR fill, not the symbol aggregate (manual position on same symbol)", async () => {
    const r = mockRest({ positionAmt: "5000", fillQty: "50" });
    const out = await runEntrySequence(r, base);
    const sl = r.calls.find((c) => c.fn === "createAlgoOrder");
    assert.strictEqual(sl?.p?.quantity, "50");
    assert.ok(out.outcome === "ENTRY_ACTIVE_WITH_TP" && out.quantity === 50);
  });

  await scenario("readiness: hedge mode is refused with a clear reason", async () => {
    const res = await checkLoxRealReadiness("karo", { getBalance: async () => [{ asset: "USDT", availableBalance: "50" }], getPositionMode: async () => ({ dualSidePosition: true }) });
    assert.ok(!res.ok && res.reason.includes("HEDGE"));
  });

  await scenario("readiness: invalid key is refused", async () => {
    const res = await checkLoxRealReadiness("karo", { getBalance: async () => { throw new Error("-2015 Invalid API-key"); }, getPositionMode: async () => ({}) });
    assert.ok(!res.ok && res.reason.includes("API key"));
  });

  await scenario("readiness: empty wallet is refused; funded one-way account passes", async () => {
    const empty = await checkLoxRealReadiness("karo", { getBalance: async () => [{ asset: "USDT", availableBalance: "0" }], getPositionMode: async () => ({ dualSidePosition: false }) });
    assert.ok(!empty.ok);
    const ok = await checkLoxRealReadiness("karo", { getBalance: async () => [{ asset: "USDT", availableBalance: "25.5" }], getPositionMode: async () => ({ dualSidePosition: false }) });
    assert.ok(ok.ok && ok.availableUsdt === 25.5);
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
