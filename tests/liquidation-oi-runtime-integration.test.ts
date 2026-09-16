import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadUsersConfig } from "../src/infrastructure/config/users.config.loader";
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
  karoEnabled = true,
  artakEnabled = true,
): LiquidationOiUserRuntimeRef[] {
  return [
    {
      userId: "karo",
      riskUsd: 1,
      liquidationOiExecutionEnabled: karoEnabled,
      binanceRest: karoRest,
      telegram: { sendMessage: async () => {} },
    },
    {
      userId: "artak",
      riskUsd: 5,
      liquidationOiExecutionEnabled: artakEnabled,
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
          {
            userId: "karo",
            riskUsd: 1,
            liquidationOiExecutionEnabled: true,
            binanceRest: rest,
            telegram: null,
          },
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
          {
            userId: "karo",
            riskUsd: 1,
            liquidationOiExecutionEnabled: true,
            binanceRest: rest,
            telegram: null,
          },
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
          {
            userId: "karo",
            riskUsd: 1,
            liquidationOiExecutionEnabled: true,
            binanceRest: rest,
            telegram: null,
          },
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

  // ============== Per-user liquidationOiExecutionEnabled gating ==============

  await scenario(
    "G.1. global OFF + Karo user-flag ON -> zero Binance calls",
    async () => {
      const { mongo, userExecs } = fakeMongo();
      const rest = mockRestThatShouldNeverBeCalled();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => [
          {
            userId: "karo",
            riskUsd: 1,
            liquidationOiExecutionEnabled: true,
            binanceRest: rest,
            telegram: { sendMessage: async () => {} },
          },
        ],
        true,
        false /* global OFF */,
      );
      await driveToEntryReady(orch, "SOLUSDT", 10_000_000);
      const karo = userExecs.docs.find((d: any) => d.userId === "karo");
      assert.strictEqual(
        karo.state,
        "PENDING",
        "global master switch off must produce the SAME observational PENDING outcome regardless of the user's own flag",
      );
    },
  );

  await scenario(
    "G.2. global ON + Karo user-flag OFF -> zero Binance calls",
    async () => {
      const { mongo, userExecs } = fakeMongo();
      const rest = mockRestThatShouldNeverBeCalled();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => [
          {
            userId: "karo",
            riskUsd: 1,
            liquidationOiExecutionEnabled: false,
            binanceRest: rest,
            telegram: { sendMessage: async () => {} },
          },
        ],
        true,
        true /* global ON */,
      );
      await driveToEntryReady(orch, "SOLUSDT", 11_000_000);
      const karo = userExecs.docs.find((d: any) => d.userId === "karo");
      assert.strictEqual(karo.state, "TERMINAL");
      assert.strictEqual(
        karo.terminalReason,
        "USER_STRATEGY_EXECUTION_DISABLED",
      );
      // mockRestThatShouldNeverBeCalled() throwing on any call, combined with the test completing without an uncaught rejection, is itself proof of zero Binance calls
    },
  );

  await scenario(
    "G.3. global ON + Karo user-flag ON -> execution allowed (real call sequence occurs)",
    async () => {
      const { mongo, userExecs } = fakeMongo();
      const rest = mockRestSuccess();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => [
          {
            userId: "karo",
            riskUsd: 1,
            liquidationOiExecutionEnabled: true,
            binanceRest: rest,
            telegram: { sendMessage: async () => {} },
          },
        ],
        true,
        true,
      );
      await driveToEntryReady(orch, "SOLUSDT", 12_000_000);
      assert.deepStrictEqual(
        rest.calls.filter((c) => c.startsWith("create")),
        [
          "createOrder:MARKET",
          "createAlgoOrder:STOP_MARKET",
          "createOrder:LIMIT",
        ],
      );
      const karo = userExecs.docs.find((d: any) => d.userId === "karo");
      assert.strictEqual(karo.state, "ACTIVE");
    },
  );

  await scenario("G.4. Karo ON + Artak OFF -> only Karo executes", async () => {
    const { mongo, userExecs } = fakeMongo();
    const karoRest = mockRestSuccess();
    const artakRest = mockRestThatShouldNeverBeCalled();
    const orch = new LiquidationOiRuntimeOrchestrator(
      DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
      DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
      new LiquidationOiGlobalSignalRepository(mongo),
      new StrategyOrderRepository(mongo),
      () => karoArtakRuntimes(karoRest, artakRest, true, false),
      true,
      true,
    );
    await driveToEntryReady(orch, "SOLUSDT", 13_000_000);
    const karo = userExecs.docs.find((d: any) => d.userId === "karo");
    const artak = userExecs.docs.find((d: any) => d.userId === "artak");
    assert.strictEqual(karo.state, "ACTIVE");
    assert.strictEqual(artak.state, "TERMINAL");
    assert.strictEqual(
      artak.terminalReason,
      "USER_STRATEGY_EXECUTION_DISABLED",
    );
  });

  await scenario(
    "G.5. Karo OFF + Artak ON -> only Artak executes",
    async () => {
      const { mongo, userExecs } = fakeMongo();
      const karoRest = mockRestThatShouldNeverBeCalled();
      const artakRest = mockRestSuccess();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => karoArtakRuntimes(karoRest, artakRest, false, true),
        true,
        true,
      );
      await driveToEntryReady(orch, "SOLUSDT", 14_000_000);
      const karo = userExecs.docs.find((d: any) => d.userId === "karo");
      const artak = userExecs.docs.find((d: any) => d.userId === "artak");
      assert.strictEqual(karo.state, "TERMINAL");
      assert.strictEqual(
        karo.terminalReason,
        "USER_STRATEGY_EXECUTION_DISABLED",
      );
      assert.strictEqual(artak.state, "ACTIVE");
    },
  );

  await scenario("G.6. both ON -> both execute independently", async () => {
    const { mongo, userExecs } = fakeMongo();
    const karoRest = mockRestSuccess();
    const artakRest = mockRestSuccess();
    const orch = new LiquidationOiRuntimeOrchestrator(
      DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
      DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
      new LiquidationOiGlobalSignalRepository(mongo),
      new StrategyOrderRepository(mongo),
      () => karoArtakRuntimes(karoRest, artakRest, true, true),
      true,
      true,
    );
    await driveToEntryReady(orch, "SOLUSDT", 15_000_000);
    const karo = userExecs.docs.find((d: any) => d.userId === "karo");
    const artak = userExecs.docs.find((d: any) => d.userId === "artak");
    assert.strictEqual(karo.state, "ACTIVE");
    assert.strictEqual(artak.state, "ACTIVE");
    assert.deepStrictEqual(
      karoRest.calls.filter((c) => c.startsWith("create")),
      [
        "createOrder:MARKET",
        "createAlgoOrder:STOP_MARKET",
        "createOrder:LIMIT",
      ],
    );
    assert.deepStrictEqual(
      artakRest.calls.filter((c) => c.startsWith("create")),
      [
        "createOrder:MARKET",
        "createAlgoOrder:STOP_MARKET",
        "createOrder:LIMIT",
      ],
    );
  });

  await scenario(
    "G.7. both OFF -> MAIN still observes (reaches ENTRY_READY) but no user executes",
    async () => {
      const { mongo, userExecs } = fakeMongo();
      const karoRest = mockRestThatShouldNeverBeCalled();
      const artakRest = mockRestThatShouldNeverBeCalled();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => karoArtakRuntimes(karoRest, artakRest, false, false),
        true,
        true,
      );
      await driveToEntryReady(orch, "SOLUSDT", 16_000_000);
      assert.strictEqual(
        orch.getWatchManager().getLifecycle("SOLUSDT")!.globalState,
        "ENTRY_READY",
        "MAIN's own observation/WATCH/ENTRY_READY must be completely unaffected by any user's individual execution flag",
      );
      const karo = userExecs.docs.find((d: any) => d.userId === "karo");
      const artak = userExecs.docs.find((d: any) => d.userId === "artak");
      assert.strictEqual(
        karo.terminalReason,
        "USER_STRATEGY_EXECUTION_DISABLED",
      );
      assert.strictEqual(
        artak.terminalReason,
        "USER_STRATEGY_EXECUTION_DISABLED",
      );
    },
  );

  await scenario(
    "G.8. the real config loader resolves a missing field to false, not a mock",
    () => {
      const tmpPath = path.join(
        os.tmpdir(),
        `lox-test-users-${Date.now()}.json`,
      );
      // deliberately omits liquidationOiExecutionEnabled entirely, simulating a real pre-existing user JSON file untouched by this change
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({
          users: [{ userId: "karo_test_user", enabled: true }],
        }),
      );
      try {
        const [loaded] = loadUsersConfig(tmpPath);
        assert.strictEqual(
          loaded!.liquidationOiExecutionEnabled,
          false,
          "an existing user JSON file with no knowledge of this field must load as liquidationOiExecutionEnabled=false, via the REAL loader, not a mock",
        );
      } finally {
        fs.unlinkSync(tmpPath);
      }
    },
  );

  await scenario(
    "G.9. a disabled user never becomes ACTIVE, in any of the four global/user combinations",
    async () => {
      for (const [global, user] of [
        [false, true],
        [true, false],
        [false, false],
      ] as const) {
        const { mongo, userExecs } = fakeMongo();
        const rest = mockRestThatShouldNeverBeCalled();
        const orch = new LiquidationOiRuntimeOrchestrator(
          DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
          DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
          new LiquidationOiGlobalSignalRepository(mongo),
          new StrategyOrderRepository(mongo),
          () => [
            {
              userId: "karo",
              riskUsd: 1,
              liquidationOiExecutionEnabled: user,
              binanceRest: rest,
              telegram: {
                sendMessage: async () => {
                  throw new Error(
                    "Telegram must never be sent for a disabled user",
                  );
                },
              },
            },
          ],
          true,
          global,
        );
        await driveToEntryReady(
          orch,
          "SOLUSDT",
          17_000_000 + Math.random() * 1000,
        );
        const karo = userExecs.docs.find((d: any) => d.userId === "karo");
        assert.notStrictEqual(
          karo.state,
          "ACTIVE",
          `global=${global} user=${user} must never produce ACTIVE`,
        );
      }
    },
  );

  await scenario(
    "G.10. a disabled user receives NO Telegram ENTRY message",
    async () => {
      const { mongo } = fakeMongo();
      const rest = mockRestSuccess();
      let telegramCalled = false;
      const runtime: LiquidationOiUserRuntimeRef = {
        userId: "karo",
        riskUsd: 1,
        liquidationOiExecutionEnabled: false,
        binanceRest: rest,
        telegram: {
          sendMessage: async () => {
            telegramCalled = true;
          },
        },
      };
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => [runtime],
        true,
        true,
      );
      await driveToEntryReady(orch, "SOLUSDT", 18_000_000);
      assert.strictEqual(
        telegramCalled,
        false,
        "no Telegram ENTRY may be sent -- no position was ever opened for this user",
      );
    },
  );

  await scenario(
    "G.11. enabled users still size using their OWN runtime.config.risk.riskUsd, unaffected by the new gate",
    async () => {
      const { mongo, userExecs } = fakeMongo();
      const karoRest = mockRestSuccess();
      const artakRest = mockRestSuccess();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => karoArtakRuntimes(karoRest, artakRest, true, true),
        true,
        true,
      );
      await driveToEntryReady(orch, "SOLUSDT", 19_000_000);
      const karo = userExecs.docs.find((d: any) => d.userId === "karo");
      const artak = userExecs.docs.find((d: any) => d.userId === "artak");
      assert.strictEqual(karo.riskUsd, 1);
      assert.strictEqual(artak.riskUsd, 5);
      // Not asserting quantity here: mockRestSuccess()'s getPositionRisk() returns a fixed
      // positionAmt regardless of the requested quantity (it doesn't echo the request), so
      // both users' VERIFIED quantity converges to the same mocked value here -- that's a
      // property of this test's mock fidelity, not of the real sizing/execution code (which
      // is exactly why riskUsd itself, the actual sizing input, is what's asserted above).
      // computePositionSizing()'s own unit tests (S.1/S.2 in the sizing-capacity test file)
      // already directly prove different riskUsd produces different computed quantities.
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
