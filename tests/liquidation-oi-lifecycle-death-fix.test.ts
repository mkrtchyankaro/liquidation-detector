import * as assert from "assert";
import { LiquidationOiWatchManager } from "../src/domain/liquidation-oi-strategy/liquidation-oi-watch-manager";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "../src/domain/liquidation-oi-strategy/config";
import {
  LiquidationOiRuntimeOrchestrator,
  type LiquidationOiUserRuntimeRef,
} from "../src/services/liquidation-oi-runtime-orchestrator";
import { LiquidationOiGlobalSignalRepository } from "../src/infrastructure/mongo/liquidation-oi-global-signal.repository";
import { StrategyOrderRepository } from "../src/infrastructure/mongo/strategy-order.repository";
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

const PCTX = {
  historicalSampleCount: 20,
  historicalP90: 100000,
  historicalP95: 200000,
  historicalP99: 400000,
  percentileRank: 96,
};

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
    if (opts?.upsert)
      this.docs.push({
        ...(filter as Partial<T>),
        ...(update.$setOnInsert ?? {}),
        ...(update.$set ?? {}),
      } as T);
    return { matchedCount: 0 };
  }
  find(filter: Record<string, unknown> = {}): { toArray: () => Promise<T[]> } {
    const matches = this.docs.filter((d) =>
      Object.entries(filter).every(
        ([k, v]) => (d as Record<string, unknown>)[k] === v,
      ),
    );
    return { toArray: async () => matches };
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
  let algoId = 1,
    orderId = 1;
  return {
    calls,
    getExchangeInfo: async () => {
      calls.push("getExchangeInfo");
      return EXCHANGE_INFO;
    },
    createOrder: async (p: any) => {
      calls.push(`createOrder:${p.type}`);
      return { orderId: orderId++ };
    },
    createAlgoOrder: async (p: any) => {
      calls.push(`createAlgoOrder:${p.type}`);
      return { algoId: algoId++ };
    },
    getAlgoOrder: async () => ({ algoStatus: "WORKING" }),
    getAlgoOrderByClientId: async () => ({ algoStatus: "WORKING" }),
    cancelAlgoOrder: async () => ({}),
    getOrder: async () => ({ status: "NEW" }),
    getPositionRisk: async () => [
      { symbol: "SOLUSDT", positionAmt: "10", entryPrice: "98" },
    ],
  };
}
function mockRestProtectionFails(): BinanceRestLike & { calls: string[] } {
  const rest = mockRestSuccess();
  rest.createAlgoOrder = async () => {
    throw new Error("simulated");
  };
  return rest;
}
function mockRestNeverCalled(): BinanceRestLike {
  const fail = () => {
    throw new Error("MUST NEVER BE CALLED");
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
function karoArtak(
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
  await orch.onTick(symbol, PCTX, [], 103, 1.0, 1000, now0 + 11_000);
  const history = [
    { contracts: 5000, fetchedAt: now0 },
    { contracts: 4600, fetchedAt: now0 + 15_000 },
    { contracts: 4590, fetchedAt: now0 + 25_000 },
    { contracts: 4590, fetchedAt: now0 + 30_000 },
  ];
  await orch.onTick(symbol, PCTX, history, 102.5, 1.0, 1000, now0 + 30_000);
}

async function main(): Promise<void> {
  console.log("Running lifecycle-death-fix regression tests...\n");

  await scenario(
    "A. SHORT episode no-progress -> terminates -> later LONG liquidation starts a NEW episode",
    () => {
      const config = {
        ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        noProgressTimeoutMs: 60_000,
      };
      const mgr = new LiquidationOiWatchManager(config);
      mgr.onLiquidationEvent(
        {
          symbol: "XRPUSDT",
          victim: "SHORT",
          timestamp: 1000,
          price: 1.0,
          quoteQty: 50000,
        },
        null,
      );
      mgr.onTick("XRPUSDT", PCTX, [], 1.0, 1.0, 1000, 1000 + 61_000);
      assert.strictEqual(
        mgr.getLifecycle("XRPUSDT"),
        null,
        "must release after no-progress death",
      );
      assert.ok(
        mgr
          .getNoSignalLog()
          .some((n) => n.reasonCode === "EPISODE_NO_PROGRESS"),
      );
      mgr.onLiquidationEvent(
        {
          symbol: "XRPUSDT",
          victim: "LONG",
          timestamp: 1000 + 70_000,
          price: 0.9,
          quoteQty: 40000,
        },
        null,
      );
      const lc = mgr.getLifecycle("XRPUSDT")!;
      assert.strictEqual(lc.episode.victim, "LONG");
      assert.strictEqual(
        lc.episode.eventCount,
        1,
        "must be a genuinely NEW episode, not merged with the dead SHORT one",
      );
      assert.strictEqual(lc.episode.sameDirectionLiqUsd, 40000);
    },
  );

  await scenario(
    "B. ENTRY_READY + execution globally disabled -> observation consumed -> lifecycle releases -> later LONG starts a NEW episode",
    async () => {
      const { mongo } = fakeMongo();
      const rest = mockRestNeverCalled();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => karoArtak(rest, rest),
        true,
        false,
      );
      await driveToEntryReady(orch, "SOLUSDT", 1_000_000);
      assert.strictEqual(
        orch.getWatchManager().getLifecycle("SOLUSDT"),
        null,
        "must release immediately, same tick",
      );
      orch.onLiquidationEvent(
        {
          symbol: "SOLUSDT",
          victim: "LONG",
          timestamp: 5_000_000,
          price: 90,
          quoteQty: 60000,
        },
        { quantity: 1000, timestamp: 5_000_000 },
      );
      const lc = orch.getWatchManager().getLifecycle("SOLUSDT")!;
      assert.strictEqual(
        lc.episode.victim,
        "LONG",
        "the opposite direction must be free to start a fresh episode with no process restart",
      );
      assert.strictEqual(lc.episode.eventCount, 1);
    },
  );

  await scenario(
    "C. ENTRY_READY + all per-user execution disabled -> no position -> release -> later LONG starts normally",
    async () => {
      const { mongo } = fakeMongo();
      const rest = mockRestNeverCalled();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => karoArtak(rest, rest, false, false),
        true,
        true,
      );
      await driveToEntryReady(orch, "SOLUSDT", 2_000_000);
      assert.strictEqual(orch.getWatchManager().getLifecycle("SOLUSDT"), null);
      orch.onLiquidationEvent(
        {
          symbol: "SOLUSDT",
          victim: "LONG",
          timestamp: 6_000_000,
          price: 90,
          quoteQty: 60000,
        },
        null,
      );
      const lc = orch.getWatchManager().getLifecycle("SOLUSDT")!;
      assert.strictEqual(lc.episode.victim, "LONG");
    },
  );

  await scenario(
    "D. Karo execution succeeds -> real ACTIVE position -> later opposite LONG liquidation MUST NOT steal/release the symbol",
    async () => {
      const { mongo } = fakeMongo();
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
      await driveToEntryReady(orch, "SOLUSDT", 3_000_000);
      const activeLc = orch.getWatchManager().getLifecycle("SOLUSDT")!;
      assert.strictEqual(activeLc.globalState, "ACTIVE");
      const sameDirUsdBefore = activeLc.episode.sameDirectionLiqUsd;
      orch.onLiquidationEvent(
        {
          symbol: "SOLUSDT",
          victim: "LONG",
          timestamp: 3_100_000,
          price: 90,
          quoteQty: 999999,
        },
        null,
      );
      const afterLc = orch.getWatchManager().getLifecycle("SOLUSDT")!;
      assert.strictEqual(
        afterLc.globalState,
        "ACTIVE",
        "must remain ACTIVE -- never stolen by an opposite event",
      );
      assert.strictEqual(
        afterLc.episode.victim,
        "SHORT",
        "must remain the original SHORT episode",
      );
      assert.strictEqual(
        afterLc.episode.sameDirectionLiqUsd,
        sameDirUsdBefore,
        "must be completely untouched",
      );
    },
  );

  await scenario(
    "E. ENTRY_READY old SHORT setup resolved with no position -> hours later new SHORT liquidation -> NEW episode, not accumulated",
    () => {
      const mgr = new LiquidationOiWatchManager();
      mgr.onLiquidationEvent(
        {
          symbol: "ETHUSDT",
          victim: "SHORT",
          timestamp: 1000,
          price: 100,
          quoteQty: 50000,
        },
        null,
      );
      mgr.cancel("ETHUSDT", "ENTRY_READY_OBSERVATIONAL_ONLY", "test", 2000);
      assert.strictEqual(mgr.getLifecycle("ETHUSDT"), null);
      const hoursLater = 2000 + 3 * 3_600_000;
      mgr.onLiquidationEvent(
        {
          symbol: "ETHUSDT",
          victim: "SHORT",
          timestamp: hoursLater,
          price: 105,
          quoteQty: 80000,
        },
        null,
      );
      const lc = mgr.getLifecycle("ETHUSDT")!;
      assert.strictEqual(lc.episode.eventCount, 1);
      assert.strictEqual(
        lc.episode.sameDirectionLiqUsd,
        80000,
        "must NOT include the old episode's 50000",
      );
      assert.strictEqual(
        lc.episode.startPrice,
        105,
        "must be a new start price, not the old 100",
      );
    },
  );

  await scenario(
    "F. one user succeeds, one fails -> global lifecycle remains ACTIVE",
    async () => {
      const { mongo } = fakeMongo();
      const karoRest = mockRestSuccess();
      const artakRest = mockRestProtectionFails();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => karoArtak(karoRest, artakRest),
        true,
        true,
      );
      await driveToEntryReady(orch, "SOLUSDT", 4_000_000);
      const lc = orch.getWatchManager().getLifecycle("SOLUSDT")!;
      assert.strictEqual(
        lc.globalState,
        "ACTIVE",
        "Karo's success alone must be enough for the GLOBAL lifecycle to remain ACTIVE",
      );
    },
  );

  await scenario(
    "G. all executions fail -> zero real positions -> global lifecycle terminates and releases",
    async () => {
      const { mongo, signals } = fakeMongo();
      const karoRest = mockRestProtectionFails();
      const artakRest = mockRestProtectionFails();
      const orch = new LiquidationOiRuntimeOrchestrator(
        DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
        new LiquidationOiGlobalSignalRepository(mongo),
        new StrategyOrderRepository(mongo),
        () => karoArtak(karoRest, artakRest),
        true,
        true,
      );
      await driveToEntryReady(orch, "SOLUSDT", 5_000_000);
      assert.strictEqual(orch.getWatchManager().getLifecycle("SOLUSDT"), null);
      assert.strictEqual(signals.docs[0].state, "CANCELLED");
    },
  );

  await scenario(
    "H. persistent stale market data -> eventually releases",
    () => {
      const config = {
        ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        marketDataStaleTimeoutMs: 60_000,
      };
      const mgr = new LiquidationOiWatchManager(config);
      mgr.onLiquidationEvent(
        {
          symbol: "BNBUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 500,
          quoteQty: 50000,
        },
        null,
      );
      mgr.onTick("BNBUSDT", PCTX, [], 500, 1.0, 1000, 2000);
      assert.ok(
        mgr.getLifecycle("BNBUSDT") !== null,
        "sanity: still alive right after a normal tick",
      );
      mgr.onTick("BNBUSDT", PCTX, [], 500, 1.0, 1000, 2000 + 61_000);
      assert.strictEqual(mgr.getLifecycle("BNBUSDT"), null);
      assert.ok(
        mgr
          .getNoSignalLog()
          .some((n) => n.reasonCode === "MARKET_DATA_STALE_TIMEOUT"),
      );
    },
  );

  await scenario(
    "I. one transient stale-ish observation does NOT immediately kill a valid episode",
    () => {
      const config = {
        ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        marketDataStaleTimeoutMs: 60_000,
      };
      const mgr = new LiquidationOiWatchManager(config);
      mgr.onLiquidationEvent(
        {
          symbol: "BNBUSDT",
          victim: "LONG",
          timestamp: 1000,
          price: 500,
          quoteQty: 50000,
        },
        null,
      );
      mgr.onTick("BNBUSDT", PCTX, [], 500, 1.0, 1000, 2000);
      mgr.onTick("BNBUSDT", PCTX, [], 500, 1.0, 1000, 2000 + 30_000);
      assert.ok(
        mgr.getLifecycle("BNBUSDT") !== null,
        "a single sub-threshold gap must not kill the episode",
      );
    },
  );

  await scenario(
    "J. failsafe lifetime can never leave a symbol locked for 10+ hours, even if the primary checks are configured not to fire",
    () => {
      const config = {
        ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        preEntryFailsafeMaxLifetimeMs: 100_000,
        noProgressTimeoutMs: 999_999_999,
        marketDataStaleTimeoutMs: 999_999_999,
        entryWindowTimeoutMs: 999_999_999,
      };
      const mgr = new LiquidationOiWatchManager(config);
      mgr.onLiquidationEvent(
        {
          symbol: "DOGEUSDT",
          victim: "LONG",
          timestamp: 0,
          price: 0.1,
          quoteQty: 50000,
        },
        null,
      );
      mgr.onTick("DOGEUSDT", PCTX, [], 0.1, 1.0, 1000, 50_000);
      assert.ok(
        mgr.getLifecycle("DOGEUSDT") !== null,
        "sanity: primary checks configured not to fire yet",
      );
      mgr.onLiquidationEvent(
        {
          symbol: "DOGEUSDT",
          victim: "LONG",
          timestamp: 99_000,
          price: 0.11,
          quoteQty: 1000,
        },
        null,
      );
      mgr.onTick("DOGEUSDT", PCTX, [], 0.1, 1.0, 1000, 150_000);
      assert.strictEqual(
        mgr.getLifecycle("DOGEUSDT"),
        null,
        "FAILSAFE must fire even though noProgress/staleData were configured not to",
      );
      assert.ok(
        mgr
          .getNoSignalLog()
          .some((n) => n.reasonCode === "PRE_ENTRY_FAILSAFE_MAX_LIFETIME"),
      );
    },
  );

  await scenario(
    "INVARIANT 1: no symbol can remain owned in a non-ACTIVE theoretical state indefinitely (direct proof via the failsafe)",
    () => {
      const config = {
        ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
        preEntryFailsafeMaxLifetimeMs: 36_000_000,
      };
      const mgr = new LiquidationOiWatchManager(config);
      mgr.onLiquidationEvent(
        {
          symbol: "BTCUSDT",
          victim: "SHORT",
          timestamp: 0,
          price: 75000,
          quoteQty: 50000,
        },
        null,
      );
      mgr.onTick("BTCUSDT", PCTX, [], 75000, 100, 1000, 36_000_001);
      assert.strictEqual(
        mgr.getLifecycle("BTCUSDT"),
        null,
        "10+ hour lock, exactly the real BTC incident's own duration, must be structurally impossible",
      );
    },
  );

  await scenario(
    "INVARIANT 2: a symbol with a real managed position is NEVER released by pre-entry stale/no-progress logic",
    async () => {
      const { mongo } = fakeMongo();
      const rest = mockRestSuccess();
      // uses the DEFAULT config (not extreme test values) -- the point is that once ACTIVE,
      // even a tick far beyond every single one of the default thresholds (including the 4h
      // failsafe) must never release the symbol, because onTick() early-returns for ACTIVE
      // before any of these checks are evaluated at all.
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
      await driveToEntryReady(orch, "SOLUSDT", 6_000_000);
      const activeLc = orch.getWatchManager().getLifecycle("SOLUSDT")!;
      assert.strictEqual(activeLc.globalState, "ACTIVE");
      // 6 hours later -- past noProgressTimeoutMs (30min), entryWindowTimeoutMs (20min),
      // marketDataStaleTimeoutMs (10min), and preEntryFailsafeMaxLifetimeMs (4h), all at once.
      await orch.onTick(
        "SOLUSDT",
        PCTX,
        [],
        100,
        1.0,
        1000,
        6_000_000 + 6 * 3_600_000,
      );
      const stillActive = orch.getWatchManager().getLifecycle("SOLUSDT")!;
      assert.strictEqual(
        stillActive.globalState,
        "ACTIVE",
        "ACTIVE must be completely immune to every pre-entry timeout, even long after all of them would otherwise have fired",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
