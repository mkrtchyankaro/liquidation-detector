import * as assert from "assert";
import {
  LiquidationOiRuntimeOrchestrator,
  type LiquidationOiUserRuntimeRef,
} from "../src/services/liquidation-oi-runtime-orchestrator";
import { LiquidationOiGlobalSignalRepository } from "../src/infrastructure/mongo/liquidation-oi-global-signal.repository";
import { StrategyOrderRepository } from "../src/infrastructure/mongo/strategy-order.repository";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "../src/domain/liquidation-oi-strategy/config";
import { DEFAULT_CAPACITY_MODEL_COEFFICIENTS } from "../src/domain/liquidation-oi-strategy/initial-capacity-model";
import type { BinanceRestLike } from "../src/infrastructure/binance/liquidation-oi-user-execution.service";
import type { MongoClientWrapper } from "../src/infrastructure/mongo/mongo.client";

let passed = 0;
let failed = 0;
async function scenario(
  name: string,
  fn: () => Promise<void> | void,
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

class FakeCollection<T extends Record<string, unknown>> {
  docs: T[] = [];
  async createIndex(): Promise<void> {}
  async updateOne(
    filter: Record<string, unknown>,
    update: { $set?: Partial<T>; $setOnInsert?: Partial<T> },
    opts?: { upsert?: boolean },
  ): Promise<{ matchedCount: number }> {
    const idx = this.docs.findIndex((d) =>
      Object.entries(filter).every(
        ([k, v]) => (d as Record<string, unknown>)[k] === v,
      ),
    );
    if (idx >= 0) {
      this.docs[idx] = { ...this.docs[idx], ...(update.$set ?? {}) } as T;
      return { matchedCount: 1 };
    }
    if (opts?.upsert) {
      this.docs.push({
        ...(filter as Partial<T>),
        ...(update.$setOnInsert ?? {}),
        ...(update.$set ?? {}),
      } as T);
    }
    return { matchedCount: 0 };
  }
  find(filter: Record<string, unknown> = {}): {
    toArray: () => Promise<T[]>;
    sort: () => { toArray: () => Promise<T[]> };
  } {
    const matches = this.docs.filter((d) =>
      Object.entries(filter).every(([k, v]) => {
        if (
          v &&
          typeof v === "object" &&
          "$in" in (v as Record<string, unknown>)
        )
          return (v as { $in: unknown[] }).$in.includes(
            (d as Record<string, unknown>)[k],
          );
        if (
          v &&
          typeof v === "object" &&
          "$nin" in (v as Record<string, unknown>)
        )
          return !(v as { $nin: unknown[] }).$nin.includes(
            (d as Record<string, unknown>)[k],
          );
        return (d as Record<string, unknown>)[k] === v;
      }),
    );
    return {
      toArray: async () => matches,
      sort: () => ({ toArray: async () => matches }),
    };
  }
  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return (
      this.docs.find((d) =>
        Object.entries(filter).every(
          ([k, v]) => (d as Record<string, unknown>)[k] === v,
        ),
      ) ?? null
    );
  }
  async countDocuments(filter: Record<string, unknown>): Promise<number> {
    return (await this.find(filter).toArray()).length;
  }
}

function fakeMongo(): {
  mongo: MongoClientWrapper;
  signals: FakeCollection<any>;
  userExecs: FakeCollection<any>;
  orders: FakeCollection<any>;
} {
  const signals = new FakeCollection<any>();
  const userExecs = new FakeCollection<any>();
  const orders = new FakeCollection<any>();
  const mongo = {
    liquidationOiGlobalSignals: async () => signals,
    liquidationOiUserExecutions: async () => userExecs,
    strategyOrders: async () => orders,
  } as unknown as MongoClientWrapper;
  return { mongo, signals, userExecs, orders };
}

const EXCHANGE_INFO = {
  symbols: [
    {
      symbol: "SOLUSDT",
      pricePrecision: 2,
      quantityPrecision: 1,
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.01" },
        { filterType: "LOT_SIZE", stepSize: "0.1", minQty: "0.1" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    },
  ],
};

function mockRestSuccess(): BinanceRestLike & { calls: string[] } {
  const calls: string[] = [];
  let algoIdCounter = 1,
    orderIdCounter = 1;
  return {
    calls,
    getExchangeInfo: async () => {
      calls.push("getExchangeInfo");
      return EXCHANGE_INFO;
    },
    createOrder: async (p: any) => {
      calls.push(`createOrder:${p.type}`);
      return { orderId: orderIdCounter++ };
    },
    createAlgoOrder: async (p: any) => {
      calls.push(`createAlgoOrder:${p.type}`);
      return { algoId: algoIdCounter++ };
    },
    getAlgoOrder: async () => {
      calls.push("getAlgoOrder");
      return { algoStatus: "WORKING" };
    },
    getAlgoOrderByClientId: async () => ({ algoStatus: "WORKING" }),
    cancelAlgoOrder: async () => ({}),
    getOrder: async () => {
      calls.push("getOrder");
      return { status: "NEW" };
    },
    getPositionRisk: async () => {
      calls.push("getPositionRisk");
      return [{ symbol: "SOLUSDT", positionAmt: "10", entryPrice: "98" }];
    },
  };
}

function mockRestProtectionFails(): BinanceRestLike & { calls: string[] } {
  const rest = mockRestSuccess();
  rest.createAlgoOrder = async () => {
    throw new Error("simulated emergency-stop placement failure");
  };
  return rest;
}

function mockRestThatShouldNeverBeCalled(): BinanceRestLike {
  const fail = () => {
    throw new Error(
      "THIS REST CLIENT MUST NEVER BE CALLED -- execution is disabled",
    );
  };
  return {
    getExchangeInfo: fail,
    createOrder: fail,
    createAlgoOrder: fail,
    getAlgoOrder: fail,
    getAlgoOrderByClientId: fail,
    cancelAlgoOrder: fail,
    getOrder: fail,
    getPositionRisk: fail,
  } as unknown as BinanceRestLike;
}

function karoArtakRuntimes(
  karoRest: BinanceRestLike | null,
  artakRest: BinanceRestLike | null,
): LiquidationOiUserRuntimeRef[] {
  return [
    {
      userId: "karo",
      riskUsd: 1,
      binanceRest: karoRest,
      telegram: { sendMessage: async () => {} },
    },
    {
      userId: "artak",
      riskUsd: 5,
      binanceRest: artakRest,
      telegram: { sendMessage: async () => {} },
    },
  ];
}

async function driveToEntryReady(
  orch: LiquidationOiRuntimeOrchestrator,
  symbol: string,
  now0: number,
): Promise<void> {
  orch.onLiquidationEvent(
    { symbol, victim: "SHORT", timestamp: now0, price: 100, quoteQty: 500000 },
    { quantity: 5000, timestamp: now0 },
  );
  orch.onLiquidationEvent(
    {
      symbol,
      victim: "SHORT",
      timestamp: now0 + 10_000,
      price: 103,
      quoteQty: 300000,
    },
    { quantity: 4700, timestamp: now0 + 10_000 },
  );
  const percentile = {
    historicalSampleCount: 20,
    historicalP90: 100000,
    historicalP95: 200000,
    historicalP99: 400000,
    percentileRank: 96,
  };
  await orch.onTick(symbol, percentile, [], 103, 1.0, 1000, now0 + 11_000);
  const history = [
    { contracts: 5000, fetchedAt: now0 },
    { contracts: 4600, fetchedAt: now0 + 15_000 },
    { contracts: 4590, fetchedAt: now0 + 25_000 },
    { contracts: 4590, fetchedAt: now0 + 30_000 },
  ];
  await orch.onTick(
    symbol,
    percentile,
    history,
    102.5,
    1.0,
    1000,
    now0 + 30_000,
  );
}

async function main(): Promise<void> {
  console.log("Running Phase 5-7 runtime integration tests...\n");

  await scenario(
    "I.1. the real watch manager receives events fed through the orchestrator",
    () => {
      const { mongo } = fakeMongo();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => [],
      );
      orch.onLiquidationEvent(
        {
          symbol: "ETHUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 100,
          quoteQty: 50000,
        },
        null,
      );
      const lc = orch.getWatchManager().getLifecycle("ETHUSDT");
      assert.ok(lc !== null);
      assert.strictEqual(lc!.episode.eventCount, 1);
    },
  );

  await scenario(
    "I.2. live price reaches the strategy manager via onTick and advances its state machine",
    async () => {
      const { mongo } = fakeMongo();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => [],
      );
      orch.onLiquidationEvent(
        {
          symbol: "BNBUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 500,
          quoteQty: 500000,
        },
        { quantity: 1000, timestamp: 1000 },
      );
      orch.onLiquidationEvent(
        {
          symbol: "BNBUSDT",
          victim: "LONG",
          timestamp: 2000,
          price: 490,
          quoteQty: 300000,
        },
        { quantity: 950, timestamp: 2000 },
      );
      await orch.onTick(
        "BNBUSDT",
        {
          historicalSampleCount: 20,
          historicalP90: 100000,
          historicalP95: 200000,
          historicalP99: 400000,
          percentileRank: 96,
        },
        [],
        490,
        1.0,
        1000,
        3000,
      );
      assert.strictEqual(
        orch.getWatchManager().getLifecycle("BNBUSDT")!.globalState,
        "EXHAUSTION_CANDIDATE",
      );
    },
  );

  await scenario(
    "I.3. OI history is consumed from the caller-supplied array -- same data source, no second poll",
    async () => {
      const { mongo } = fakeMongo();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => karoArtakRuntimes(null, null),
        true,
        false,
      );
      await driveToEntryReady(orch, "SOLUSDT", 1_000_000);
      assert.strictEqual(
        orch.getWatchManager().getLifecycle("SOLUSDT")!.globalState,
        "ENTRY_READY",
      );
    },
  );

  await scenario(
    "I.4. absent ATR keeps the episode in EPISODE_TRACKING, never promotes without it",
    async () => {
      const { mongo } = fakeMongo();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => [],
      );
      orch.onLiquidationEvent(
        {
          symbol: "XRPUSDT",
          victim: "SHORT",
          timestamp: 1000,
          price: 1.0,
          quoteQty: 500000,
        },
        null,
      );
      orch.onLiquidationEvent(
        {
          symbol: "XRPUSDT",
          victim: "SHORT",
          timestamp: 2000,
          price: 1.02,
          quoteQty: 300000,
        },
        null,
      );
      await orch.onTick(
        "XRPUSDT",
        {
          historicalSampleCount: 20,
          historicalP90: 100000,
          historicalP95: 200000,
          historicalP99: 400000,
          percentileRank: 96,
        },
        [],
        1.02,
        null,
        null,
        3000,
      );
      assert.strictEqual(
        orch.getWatchManager().getLifecycle("XRPUSDT")!.globalState,
        "EPISODE_TRACKING",
      );
    },
  );

  await scenario(
    "I.5. disabled execution places ZERO Binance calls -- ENTRY_READY remains observational only",
    async () => {
      const { mongo, userExecs } = fakeMongo();
      const rest = mockRestThatShouldNeverBeCalled();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => karoArtakRuntimes(rest, rest),
        true,
        false,
      );
      await driveToEntryReady(orch, "SOLUSDT", 1_000_000);
      assert.strictEqual(
        orch.getWatchManager().getLifecycle("SOLUSDT")!.globalState,
        "ENTRY_READY",
      );
      assert.strictEqual(userExecs.docs.length, 2);
      for (const doc of userExecs.docs)
        assert.strictEqual(
          doc.state,
          "PENDING",
          "no user execution may become ACTIVE while executionEnabled=false",
        );
    },
  );

  await scenario(
    "I.6. enabled execution follows entry -> emergency stop -> TP ordering, in that exact sequence",
    async () => {
      const { mongo, orders } = fakeMongo();
      const rest = mockRestSuccess();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => [
          { userId: "karo", riskUsd: 1, binanceRest: rest, telegram: null },
        ],
        true,
        true,
      );
      await driveToEntryReady(orch, "SOLUSDT", 2_000_000);
      const orderCalls = rest.calls.filter((c) => c.startsWith("create"));
      assert.deepStrictEqual(orderCalls, [
        "createOrder:MARKET",
        "createAlgoOrder:STOP_MARKET",
        "createOrder:LIMIT",
      ]);
      const purposes = orders.docs.map((d: any) => d.purpose);
      assert.deepStrictEqual(purposes, [
        "ENTRY",
        "EMERGENCY_STOP",
        "TAKE_PROFIT",
      ]);
    },
  );

  await scenario(
    "I.7. protection failure triggers a fail-safe close, TP never attempted afterward",
    async () => {
      const { mongo, userExecs } = fakeMongo();
      const rest = mockRestProtectionFails();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => [
          { userId: "karo", riskUsd: 1, binanceRest: rest, telegram: null },
        ],
        true,
        true,
      );
      await driveToEntryReady(orch, "SOLUSDT", 3_000_000);
      assert.ok(!rest.calls.includes("createOrder:LIMIT"));
      const marketCloseCalls = rest.calls.filter(
        (c) => c === "createOrder:MARKET",
      );
      assert.strictEqual(
        marketCloseCalls.length,
        2,
        "entry (1st MARKET) + fail-safe close (2nd MARKET)",
      );
      const karoExec = userExecs.docs.find((d: any) => d.userId === "karo");
      assert.strictEqual(karoExec.state, "TERMINAL");
      assert.strictEqual(karoExec.terminalReason, "PROTECTION_FAILED");
    },
  );

  await scenario(
    "I.8. successful Karo execution is not rolled back by Artak's failure",
    async () => {
      const { mongo, userExecs } = fakeMongo();
      const karoRest = mockRestSuccess();
      const artakRest = mockRestProtectionFails();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => karoArtakRuntimes(karoRest, artakRest),
        true,
        true,
      );
      await driveToEntryReady(orch, "SOLUSDT", 4_000_000);
      const karoExec = userExecs.docs.find((d: any) => d.userId === "karo");
      const artakExec = userExecs.docs.find((d: any) => d.userId === "artak");
      assert.strictEqual(karoExec.state, "ACTIVE");
      assert.strictEqual(artakExec.state, "TERMINAL");
      assert.strictEqual(artakExec.terminalReason, "PROTECTION_FAILED");
      assert.notStrictEqual(karoExec.riskUsd, artakExec.riskUsd);
    },
  );

  await scenario(
    "I.9. restart/idempotency: the persisted record prevents a duplicate entry for the same (userId, globalSignalId)",
    async () => {
      const { mongo, userExecs } = fakeMongo();
      const rest = mockRestSuccess();
      const repo = new LiquidationOiGlobalSignalRepository(mongo);
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        repo,
        new StrategyOrderRepository(mongo),
        () => [
          { userId: "karo", riskUsd: 1, binanceRest: rest, telegram: null },
        ],
        true,
        true,
        () => "lox-sig-fixed-id-for-test",
      );
      await driveToEntryReady(orch, "SOLUSDT", 5_000_000);
      const callsAfterFirst = rest.calls.filter((c) =>
        c.startsWith("create"),
      ).length;
      assert.strictEqual(callsAfterFirst, 3);
      const existing = await repo.findUserExecution(
        "karo",
        "lox-sig-fixed-id-for-test",
      );
      assert.ok(existing !== null && existing.state === "ACTIVE");
      assert.strictEqual(
        userExecs.docs.filter((d: any) => d.userId === "karo").length,
        1,
        "exactly ONE user-execution row, never a duplicate",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
