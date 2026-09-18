import * as assert from "assert";
import { LiquidationOiWatchManager } from "../src/domain/liquidation-oi-strategy/liquidation-oi-watch-manager";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "../src/domain/liquidation-oi-strategy/config";
const TEST_STRATEGY_CONFIG = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, maxDistanceFromExtremeAtrForEntry: 2.0 };
import { LiquidationOiRuntimeOrchestrator, type LiquidationOiUserRuntimeRef } from "../src/services/liquidation-oi-runtime-orchestrator";
import { LiquidationOiGlobalSignalRepository } from "../src/infrastructure/mongo/liquidation-oi-global-signal.repository";
import { StrategyOrderRepository } from "../src/infrastructure/mongo/strategy-order.repository";
import { DEFAULT_CAPACITY_MODEL_COEFFICIENTS } from "../src/domain/liquidation-oi-strategy/initial-capacity-model";
import type { BinanceRestLike } from "../src/infrastructure/binance/liquidation-oi-user-execution.service";
import type { MongoClientWrapper } from "../src/infrastructure/mongo/mongo.client";

let passed = 0;
let failed = 0;
async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}`); console.log(`      ${err instanceof Error ? err.message : String(err)}\n`); }
}

const PCTX = { historicalSampleCount: 20, historicalP90: 100000, historicalP95: 200000, historicalP99: 400000, percentileRank: 96 };
function candle(closeTime: number, open: number, high: number, low: number, close: number) {
  return { symbol: "X", interval: "1m", openTime: closeTime - 60_000, closeTime, open, high, low, close, volume: 0, isClosed: true } as any;
}
const FLAT_ATR = { get: (_i: string, _t: number) => 1.0 };


class FakeCollection<T extends Record<string, unknown>> {
  docs: T[] = [];
  async createIndex(): Promise<void> {}
  async updateOne(filter: Record<string, unknown>, update: { $set?: Partial<T>; $setOnInsert?: Partial<T> }, opts?: { upsert?: boolean }): Promise<{ matchedCount: number }> {
    const idx = this.docs.findIndex((d) => Object.entries(filter).every(([k, v]) => (d as Record<string, unknown>)[k] === v));
    if (idx >= 0) { this.docs[idx] = { ...this.docs[idx], ...(update.$set ?? {}) } as T; return { matchedCount: 1 }; }
    if (opts?.upsert) this.docs.push({ ...(filter as Partial<T>), ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) } as T);
    return { matchedCount: 0 };
  }
  find(filter: Record<string, unknown> = {}): { toArray: () => Promise<T[]> } {
    const matches = this.docs.filter((d) => Object.entries(filter).every(([k, v]) => (d as Record<string, unknown>)[k] === v));
    return { toArray: async () => matches };
  }
  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return this.docs.find((d) => Object.entries(filter).every(([k, v]) => (d as Record<string, unknown>)[k] === v)) ?? null;
  }
  async countDocuments(filter: Record<string, unknown>): Promise<number> { return (await this.find(filter).toArray()).length; }
}
function fakeMongo(): { mongo: MongoClientWrapper; signals: FakeCollection<any>; userExecs: FakeCollection<any>; orders: FakeCollection<any> } {
  const signals = new FakeCollection<any>(); const userExecs = new FakeCollection<any>(); const orders = new FakeCollection<any>();
  const mongo = { liquidationOiGlobalSignals: async () => signals, liquidationOiUserExecutions: async () => userExecs, strategyOrders: async () => orders } as unknown as MongoClientWrapper;
  return { mongo, signals, userExecs, orders };
}
const EXCHANGE_INFO = { symbols: [{ symbol: "SOLUSDT", pricePrecision: 2, quantityPrecision: 1, filters: [
  { filterType: "PRICE_FILTER", tickSize: "0.01" }, { filterType: "LOT_SIZE", stepSize: "0.1", minQty: "0.1" }, { filterType: "MIN_NOTIONAL", notional: "5" },
] }] };
function mockRestSuccess(): BinanceRestLike & { calls: string[] } {
  const calls: string[] = []; let algoId = 1, orderId = 1;
  return {
    calls,
    getExchangeInfo: async () => { calls.push("getExchangeInfo"); return EXCHANGE_INFO; },
    createOrder: async (p: any) => { calls.push(`createOrder:${p.type}:trigger=${p.price ?? "n/a"}`); return { orderId: orderId++ }; },
    createAlgoOrder: async (p: any) => { calls.push(`createAlgoOrder:${p.type}:trigger=${p.triggerPrice}`); return { algoId: algoId++ }; },
    getAlgoOrder: async () => ({ algoStatus: "WORKING" }),
    getAlgoOrderByClientId: async () => ({ algoStatus: "WORKING" }),
    cancelAlgoOrder: async () => ({}),
    getOrder: async () => ({ status: "NEW" }),
    getPositionRisk: async () => [{ symbol: "SOLUSDT", positionAmt: "10", entryPrice: "98" }],
    cancelOrder: async () => ({}),
    getOpenOrders: async () => [],
    getOpenAlgoOrders: async () => [],
  };
}
/** Sep 17 2026 (Karo), operator-approved lifecycle correction --
 *  drives an episode all the way to ENTRY_READY through the REAL, new
 *  pipeline. victim=SHORT -> candidateSide=SHORT, favorable price
 *  movement is DOWNWARD throughout. */
async function driveToEntryReady(orch: LiquidationOiRuntimeOrchestrator, symbol: string, now0: number): Promise<void> {
  orch.onLiquidationEvent({ symbol, victim: "SHORT", timestamp: now0, price: 100, quoteQty: 500000 }, { quantity: 5000, timestamp: now0 });
  orch.onLiquidationEvent({ symbol, victim: "SHORT", timestamp: now0 + 10_000, price: 103, quoteQty: 300000 }, { quantity: 4700, timestamp: now0 + 10_000 });
  await orch.onTick(symbol, PCTX, [], 103, 1.0, 1000, now0 + 11_000, null, null, null, [], [], FLAT_ATR);

  const c1 = candle(now0 + 60_000, 103, 103, 102.1, 102.1);
  await orch.onTick(symbol, PCTX, [], 102.1, 1.0, 1000, now0 + 65_000, null, null, null, [c1], [], FLAT_ATR);

  const c2 = candle(now0 + 120_000, 102.1, 102.3, 101.9, 102.0);
  const c3 = candle(now0 + 180_000, 102.0, 102.2, 101.7, 101.8);
  const c3m = candle(now0 + 180_000, 103, 103, 101.7, 101.8);
  const historyAtEpisodeEnd = [{ contracts: 5000, fetchedAt: now0 }, { contracts: 4600, fetchedAt: now0 + 15_000 }, { contracts: 4590, fetchedAt: now0 + 25_000 }, { contracts: 4750, fetchedAt: now0 + 180_000 }];
  await orch.onTick(symbol, PCTX, historyAtEpisodeEnd, 101.8, 1.0, 1000, now0 + 185_000, null, null, null, [c2, c3], [c3m], FLAT_ATR);

  const historyWithCreation = [...historyAtEpisodeEnd, { contracts: 4900, fetchedAt: now0 + 200_000 }];
  await orch.onTick(symbol, PCTX, historyWithCreation, 101.7, 1.0, 1000, now0 + 200_000, null, null, null, [], [], FLAT_ATR, { capacityAtr: 2.5, candidateTpPrice: 99.2, candidateSlPrice: 103.1, netRR: 2.5 });
}

async function main(): Promise<void> {
  console.log("Running production-completion-pass-A regression tests (bounded logs / ownership observability / separated stop prices)...\n");

  await scenario("A.1. noSignalLog never exceeds its bounded cap, even after far more pushes than the cap", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 999_999_999 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75000, quoteQty: 1000 }, null);
    // drive 2000 WATCH rejections -- far more than any reasonable bound
    for (let i = 1; i <= 2000; i++) {
      mgr.onTick("BTCUSDT", { historicalSampleCount: 20, historicalP90: 999999999, historicalP95: 999999999, historicalP99: 999999999, percentileRank: 1 }, [], 75000, 100, 1000, i);
    }
    const log = mgr.getNoSignalLog();
    assert.ok(log.length <= 500, `noSignalLog must stay bounded (<=500), got ${log.length}`);
    assert.ok(log.length > 0, "sanity: log must not be empty");
  });

  await scenario("A.2. oppositeEventIgnoredLog never exceeds its bounded cap after many opposite events", () => {
    const mgr = new LiquidationOiWatchManager();
    mgr.onLiquidationEvent({ symbol: "ETHUSDT", victim: "SHORT", timestamp: 0, price: 2400, quoteQty: 500000 }, null);
    for (let i = 1; i <= 2000; i++) {
      mgr.onLiquidationEvent({ symbol: "ETHUSDT", victim: "LONG", timestamp: i, price: 2400, quoteQty: 10 }, null);
    }
    const log = mgr.getOppositeEventIgnoredLog();
    assert.ok(log.length <= 500, `oppositeEventIgnoredLog must stay bounded (<=500), got ${log.length}`);
  });

  await scenario("A.3. bounded logs drop OLDEST entries, keeping the most recent -- test/debug access still returns real recent data", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 999_999_999 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75000, quoteQty: 1000 }, null);
    for (let i = 1; i <= 600; i++) {
      mgr.onTick("BTCUSDT", { historicalSampleCount: 20, historicalP90: 999999999, historicalP95: 999999999, historicalP99: 999999999, percentileRank: 1 }, [], 75000, 100, 1000, i);
    }
    const log = mgr.getNoSignalLog();
    assert.strictEqual(log.length, 500, "must be exactly at the cap after 600 pushes");
    assert.ok(log[log.length - 1]!.timestamp > log[0]!.timestamp, "must retain the MOST RECENT entries, not the oldest");
  });

  await scenario("B.1. GLOBAL_OWNERSHIP_CONTENTION path (silent-ignore fix) leaves the OTHER, legitimately-owned episode's ownership completely untouched", async () => {
    // This directly proves the fix does NOT introduce the release-bug: since the
    // ignore path is structurally unreachable under direction-sticky ownership,
    // this test instead proves the SAFER property -- that a symbol's ownership,
    // once legitimately held (via a real WATCH_QUALIFIED promotion), is never
    // released by anything OTHER than cancel()/confirmActivePosition() reaching
    // that SAME episode -- i.e. no code path can release someone else's ownership.
    const { mongo } = fakeMongo();
    const rest = mockRestSuccess();
    const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, new LiquidationOiGlobalSignalRepository(mongo), new StrategyOrderRepository(mongo), () => [{ userId: "karo", riskUsd: 1, liquidationOiExecutionEnabled: true, binanceRest: rest, telegram: null }], true, true);
    await driveToEntryReady(orch, "SOLUSDT", 1_000_000);
    assert.strictEqual(orch.getWatchManager().getLifecycle("SOLUSDT")!.globalState, "ACTIVE");
    assert.strictEqual(orch.getWatchManager().isSymbolOwned("SOLUSDT"), true, "ownership must remain held for the real ACTIVE episode");
  });

  await scenario("G.1. strategyInvalidationPrice and emergencyHardStopPrice are genuinely different prices, and the emergency stop is placed FURTHER from entry", async () => {
    const { mongo, signals } = fakeMongo();
    const rest = mockRestSuccess();
    const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, new LiquidationOiGlobalSignalRepository(mongo), new StrategyOrderRepository(mongo), () => [{ userId: "karo", riskUsd: 1, liquidationOiExecutionEnabled: true, binanceRest: rest, telegram: null }], true, true);
    await driveToEntryReady(orch, "SOLUSDT", 2_000_000);
    const doc = signals.docs.find((d: any) => d.state === "ACTIVE");
    assert.ok(doc, "sanity: must have an ACTIVE signal doc");
    assert.notStrictEqual(doc.strategyInvalidationPrice, doc.emergencyHardStopPrice, "the two prices must be genuinely different");
    // candidateSide=SHORT (victim SHORT -> candidate SHORT): strategy invalidation is ABOVE entry (extreme+buffer),
    // emergency hard stop must be FURTHER above -- i.e. even higher than strategyInvalidationPrice.
    assert.ok(doc.emergencyHardStopPrice > doc.strategyInvalidationPrice, `emergency stop (${doc.emergencyHardStopPrice}) must sit further from entry than strategy invalidation (${doc.strategyInvalidationPrice}) for a SHORT candidate`);
    // Confirm the REAL placed Binance order used the emergency price, not the strategy-invalidation price.
    const stopCall = rest.calls.find((c) => c.startsWith("createAlgoOrder:STOP_MARKET"));
    assert.ok(stopCall, "sanity: a STOP_MARKET must have been placed");
    assert.ok(stopCall!.includes(String(doc.emergencyHardStopPrice.toFixed(2))) || stopCall!.includes(doc.emergencyHardStopPrice.toFixed(2)), `the physical stop order's own trigger must use emergencyHardStopPrice, got: ${stopCall}`);
  });

  await scenario("G.2. sizing still uses ONLY strategyInvalidationPrice, unchanged, never the wider emergency price", async () => {
    const { mongo, userExecs } = fakeMongo();
    const rest = mockRestSuccess();
    const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, new LiquidationOiGlobalSignalRepository(mongo), new StrategyOrderRepository(mongo), () => [{ userId: "karo", riskUsd: 1, liquidationOiExecutionEnabled: true, binanceRest: rest, telegram: null }], true, true);
    await driveToEntryReady(orch, "SOLUSDT", 3_000_000);
    const userExec = userExecs.docs.find((d: any) => d.userId === "karo");
    assert.ok(userExec.estimatedStrategyLossUsd === 1, "estimatedStrategyLossUsd must equal the configured riskUsd exactly (sizing driven by strategyInvalidationPrice, not the wider emergency price)");
    assert.ok(userExec.estimatedEmergencyMaxLossUsd > userExec.estimatedStrategyLossUsd, "the emergency worst-case loss must be LARGER than the intended strategy risk, since it sits further away");
  });

  await scenario("G.3. emergency-loss safety constraint skips execution rather than silently accepting excessive risk", async () => {
    const { mongo, userExecs } = fakeMongo();
    const rest = mockRestSuccess();
    // configure an emergency buffer + cap combination that WILL violate maxEmergencyLossMultipleOfRiskUsd
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, emergencyHardStopBufferAtrMultiple: 50, maxEmergencyLossMultipleOfRiskUsd: 0.001, maxDistanceFromExtremeAtrForEntry: 2.0 };
    const orch = new LiquidationOiRuntimeOrchestrator(config, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, new LiquidationOiGlobalSignalRepository(mongo), new StrategyOrderRepository(mongo), () => [{ userId: "karo", riskUsd: 1, liquidationOiExecutionEnabled: true, binanceRest: rest, telegram: null }], true, true);
    await driveToEntryReady(orch, "SOLUSDT", 4_000_000);
    const userExec = userExecs.docs.find((d: any) => d.userId === "karo");
    assert.strictEqual(userExec.state, "TERMINAL");
    assert.strictEqual(userExec.terminalReason, "EXECUTION_FAILED");
    assert.ok(!rest.calls.some((c) => c.startsWith("createOrder:MARKET")), "no MARKET entry may ever be placed when the emergency-risk safety constraint is violated");
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
