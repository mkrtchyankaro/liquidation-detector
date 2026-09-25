/**
 * Regression tests for the REAL entry sequence:
 *  - leverage + margin mode applied before the entry order
 *  - pre-flight at the executable price (skip when beyond SL/TP, re-size to riskUsd)
 *  - a reported fill is ALWAYS protected even if positionRisk lags
 *  - protection qty comes from OUR fill, not the symbol aggregate
 *  - startup readiness: hedge mode / bad keys / empty wallet are refused
 *
 * Usage: npx tsx tests/entry-sequence.test.ts
 */
import * as assert from "assert";
import { runEntrySequence, safeLeverage, type BinanceRestLike } from "../src/execution/entry-sequence";
import { checkRealReadiness } from "../src/execution/readiness";

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
  fillAvg?: string; fillQty?: string; marginErr?: string; marginType?: string;
  algoQueryFails?: boolean; algoInOpenList?: boolean;
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
    getAlgoOrder: async () => { if (o.algoQueryFails) throw new Error("Binance API error -2013: Order does not exist."); return { algoStatus: "WORKING" }; },
    getAlgoOrderByClientId: async () => ({ algoStatus: "WORKING" }),
    cancelAlgoOrder: async (id: number) => { calls.push({ fn: "cancelAlgoOrder", p: { id } }); return {}; },
    getOrder: async () => ({ status: "NEW" }),
    getPositionRisk: async () => [{ symbol: "DOGEUSDT", positionAmt: o.positionLagsForever ? "0" : (o.positionAmt ?? "100"), entryPrice: "0.2", ...(o.marginType ? { marginType: o.marginType } : {}) }],
    cancelOrder: async () => ({}),
    getOpenOrders: async () => [],
    getOpenAlgoOrders: async () => (o.algoInOpenList ? [{ algoId: 9, clientAlgoId: "x", orderType: "STOP_MARKET" }] : []),
  };
  return rest as typeof rest & BinanceRestLike;
}
const base = { userId: "karo", globalSignalId: "g1", symbol: "DOGEUSDT", side: "LONG" as const, quantity: 50, entryPriceEstimate: 0.2, slPrice: 0.198, initialTpPrice: 0.204 };

async function run(): Promise<void> {
  console.log("Entry sequence");

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

  await scenario("symbol already ISOLATED -> setMarginType is not called at all", async () => {
    const r = mockRest({ marginType: "isolated" });
    const out = await runEntrySequence(r, { ...base, marginMode: "ISOLATED", leverage: 20 });
    assert.strictEqual(out.outcome, "ENTRY_ACTIVE_WITH_TP");
    assert.ok(!r.calls.some((c) => c.fn === "setMarginType"));
  });

  await scenario("change refused because of open orders (LINK incident) -> trade proceeds in the CURRENT mode", async () => {
    const r = mockRest({ marginType: "cross", marginErr: "Binance signed POST /fapi/v1/marginType failed: Position side cannot be changed if there exists open orders." });
    const out = await runEntrySequence(r, { ...base, marginMode: "ISOLATED", leverage: 20 });
    assert.strictEqual(out.outcome, "ENTRY_ACTIVE_WITH_TP");
    // CROSSED: no isolated-liquidation cap, configured leverage is used
    assert.strictEqual(r.calls.find((c) => c.fn === "setLeverage")?.p?.l, 20);
    assert.ok(r.calls.some((c) => c.fn === "createAlgoOrder" && c.p?.type === "STOP_MARKET"));
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

  await scenario("SL not yet queryable by id (-2013) but present in the open list -> verified, trade stays protected", async () => {
    const r = mockRest({ algoQueryFails: true, algoInOpenList: true });
    const out = await runEntrySequence(r, base);
    assert.strictEqual(out.outcome, "ENTRY_ACTIVE_WITH_TP");
  });

  await scenario("SL never verifiable -> position fail-safe closed AND the SL algo order is cancelled (no orphan stop)", async () => {
    const r = mockRest({ algoQueryFails: true, algoInOpenList: false });
    const out = await runEntrySequence(r, base);
    assert.strictEqual(out.outcome, "PROTECTION_FAILED_CLOSED");
    assert.ok(r.calls.some((c) => c.fn === "createOrder" && c.p?.reduceOnly === "true" && c.p?.type === "MARKET"), "fail-safe close sent");
    assert.ok(r.calls.some((c) => c.fn === "cancelAlgoOrder" && c.p?.id === 9), "orphan SL cancelled");
  });

  await scenario("leverage is a CAP: lowered so ISOLATED liquidation stays beyond the SL", async () => {
    assert.strictEqual(safeLeverage(60, 1, "ISOLATED"), 60);
    assert.strictEqual(safeLeverage(60, 2, "ISOLATED"), 35);
    assert.strictEqual(safeLeverage(20, 5, "ISOLATED"), 14);
    assert.strictEqual(safeLeverage(60, 2, "CROSSED"), 60);
    assert.strictEqual(safeLeverage(5, 50, "ISOLATED"), 1);
    // SL 0.198 vs ask 0.2 = 1% -> 60 allowed; SL 0.194 = 3% -> 23
    const r = mockRest();
    await runEntrySequence(r, { ...base, slPrice: 0.194, leverage: 60, marginMode: "ISOLATED" });
    assert.strictEqual(r.calls.find((c) => c.fn === "setLeverage")?.p?.l, 23);
  });

  await scenario("tpRMultiple: TP is computed from the ACTUAL fill (2.2R exact), not the plan", async () => {
    // fill 0.2, SL 0.198 -> R = 0.002 -> TP = 0.2 + 2.2*0.002 = 0.2044
    const r = mockRest({ fillAvg: "0.2" });
    const out = await runEntrySequence(r, { ...base, initialTpPrice: 999, tpRMultiple: 2.2 });
    const tp = r.calls.find((c) => c.fn === "createOrder" && c.p?.type === "LIMIT");
    assert.strictEqual(tp?.p?.price, "0.20440");
    assert.ok(out.outcome === "ENTRY_ACTIVE_WITH_TP" && Math.abs((out.tpPrice ?? 0) - 0.2044) < 1e-12);
  });

  await scenario("readiness: hedge mode is refused with a clear reason", async () => {
    const res = await checkRealReadiness("karo", { getBalance: async () => [{ asset: "USDT", availableBalance: "50" }], getPositionMode: async () => ({ dualSidePosition: true }) });
    assert.ok(!res.ok && res.reason.includes("HEDGE"));
  });

  await scenario("readiness: invalid key is refused", async () => {
    const res = await checkRealReadiness("karo", { getBalance: async () => { throw new Error("-2015 Invalid API-key"); }, getPositionMode: async () => ({}) });
    assert.ok(!res.ok && res.reason.includes("API key"));
  });

  await scenario("readiness: empty wallet is refused; funded one-way account passes", async () => {
    const empty = await checkRealReadiness("karo", { getBalance: async () => [{ asset: "USDT", availableBalance: "0" }], getPositionMode: async () => ({ dualSidePosition: false }) });
    assert.ok(!empty.ok);
    const ok = await checkRealReadiness("karo", { getBalance: async () => [{ asset: "USDT", availableBalance: "25.5" }], getPositionMode: async () => ({ dualSidePosition: false }) });
    assert.ok(ok.ok && ok.availableUsdt === 25.5);
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
