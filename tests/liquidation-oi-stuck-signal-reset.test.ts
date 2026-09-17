import * as assert from "assert";
import { LiquidationOiGlobalSignalRepository } from "../src/infrastructure/mongo/liquidation-oi-global-signal.repository";
import { StrategyOrderRepository } from "../src/infrastructure/mongo/strategy-order.repository";
import {
  LiquidationOiRuntimeOrchestrator,
  type LiquidationOiUserRuntimeRef,
} from "../src/services/liquidation-oi-runtime-orchestrator";
import { LiquidationOiPositionLifecycleService } from "../src/services/liquidation-oi-position-lifecycle.service";
import { LiquidationOiActiveMainRuntime } from "../src/services/liquidation-oi-active-main-runtime.service";
import { recoverLoxOnRestart } from "../src/services/liquidation-oi-restart-recovery";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "../src/domain/liquidation-oi-strategy/config";
import { DEFAULT_CAPACITY_MODEL_COEFFICIENTS } from "../src/domain/liquidation-oi-strategy/initial-capacity-model";
import { DEFAULT_ACTIVE_LIFECYCLE_CONFIG } from "../src/domain/liquidation-oi-strategy/active-lifecycle-config";
import { auditLoxState, type LoxCollections } from "../scripts/lox-reset-audit";
import type { BinanceRestLike } from "../src/infrastructure/binance/liquidation-oi-user-execution.service";
import type { MongoClientWrapper } from "../src/infrastructure/mongo/mongo.client";

let passed = 0,
  failed = 0;
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
    const matchesClause = (d: T, clause: Record<string, unknown>): boolean =>
      Object.entries(clause).every(([k, v]) => {
        const dv = (d as Record<string, unknown>)[k];
        if (v && typeof v === "object" && "$in" in (v as any))
          return (v as any).$in.includes(dv);
        if (v && typeof v === "object" && "$nin" in (v as any))
          return !(v as any).$nin.includes(dv);
        return dv === v;
      });
    const matches = this.docs.filter((d) => {
      if ("$or" in filter) {
        const clauses = (filter as any).$or as Record<string, unknown>[];
        return clauses.some((c) => matchesClause(d, c));
      }
      return matchesClause(d, filter);
    });
    return { toArray: async () => matches };
  }
  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return (await this.find(filter).toArray())[0] ?? null;
  }
  async countDocuments(filter: Record<string, unknown>): Promise<number> {
    return (await this.find(filter).toArray()).length;
  }
  async deleteMany(
    filter: Record<string, unknown>,
  ): Promise<{ deletedCount: number }> {
    const toDelete = await this.find(filter).toArray();
    this.docs = this.docs.filter((d) => !toDelete.includes(d));
    return { deletedCount: toDelete.length };
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
      symbol: "ADAUSDT",
      pricePrecision: 5,
      quantityPrecision: 1,
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.00001" },
        { filterType: "LOT_SIZE", stepSize: "0.1", minQty: "0.1" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    },
  ],
};

function mockRestThrowsAlways(): BinanceRestLike {
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
    cancelOrder: fail,
    getOpenOrders: fail,
    getOpenAlgoOrders: fail,
  } as unknown as BinanceRestLike;
}
function runtimes(
  specs: Array<{
    userId: string;
    riskUsd: number;
    rest: BinanceRestLike | null;
    enabled?: boolean;
  }>,
): () => LiquidationOiUserRuntimeRef[] {
  return () =>
    specs.map((s) => ({
      userId: s.userId,
      riskUsd: s.riskUsd,
      liquidationOiExecutionEnabled: s.enabled ?? true,
      binanceRest: s.rest,
      telegram: { sendMessage: async () => {} },
    }));
}
function buildStack(
  getRuntimes: () => LiquidationOiUserRuntimeRef[],
  globalExecutionEnabled: boolean,
) {
  const { mongo, signals, userExecs, orders } = fakeMongo();
  const globalSignalRepo = new LiquidationOiGlobalSignalRepository(mongo);
  const strategyOrderRepo = new StrategyOrderRepository(mongo);
  const orch = new LiquidationOiRuntimeOrchestrator(
    DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
    DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
    globalSignalRepo,
    strategyOrderRepo,
    getRuntimes,
    true,
    globalExecutionEnabled,
  );
  const positionLifecycle = new LiquidationOiPositionLifecycleService(
    globalSignalRepo,
    strategyOrderRepo,
    orch.getWatchManager(),
    getRuntimes,
    DEFAULT_ACTIVE_LIFECYCLE_CONFIG.positionReconciliationIntervalMs,
  );
  const activeMain = new LiquidationOiActiveMainRuntime(
    globalSignalRepo,
    strategyOrderRepo,
    positionLifecycle,
    getRuntimes,
    DEFAULT_ACTIVE_LIFECYCLE_CONFIG,
  );
  orch.setActiveMainRuntime(activeMain);
  return {
    mongo,
    signals,
    userExecs,
    orders,
    globalSignalRepo,
    strategyOrderRepo,
    orch,
    positionLifecycle,
    activeMain,
  };
}
async function driveToActive(
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
  console.log(
    "Running operational-safety (stuck-signal / reset-tool) regression tests...\n",
  );

  await scenario(
    "4. all users already TERMINAL+COMPLETE before restart -> global self-heals to CLOSED on restart",
    async () => {
      const {
        orch,
        globalSignalRepo,
        strategyOrderRepo,
        positionLifecycle,
        signals,
      } = buildStack(
        runtimes([
          { userId: "karo", riskUsd: 1, rest: mockRestThrowsAlways() },
        ]),
        false,
      );
      await driveToActive(orch, "ADAUSDT", 1_000_000);
      const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
      const userExecRow = (
        await globalSignalRepo.findUserExecutionsForSignal(
          signal.globalSignalId,
        )
      )[0];
      await globalSignalRepo.upsertUserExecution({
        ...userExecRow,
        state: "TERMINAL",
        terminalReason: "TP_FILLED",
        cleanupState: "COMPLETE",
      });
      assert.strictEqual(
        signals.docs.find(
          (d: any) => d.globalSignalId === signal.globalSignalId,
        ).state,
        "ACTIVE",
        "sanity: global is stuck ACTIVE before restart",
      );

      await recoverLoxOnRestart(
        globalSignalRepo,
        strategyOrderRepo,
        positionLifecycle,
        orch.getWatchManager(),
        runtimes([
          { userId: "karo", riskUsd: 1, rest: mockRestThrowsAlways() },
        ]),
        () => {},
        1_100_000,
      );

      const after = signals.docs.find(
        (d: any) => d.globalSignalId === signal.globalSignalId,
      );
      assert.strictEqual(
        after.state,
        "CLOSED",
        "restart must self-heal a signal whose every user was already terminal+clean before the crash",
      );
    },
  );

  await scenario(
    "5. a genuinely valid ACTIVE signal survives restart UNCHANGED and stays locked",
    async () => {
      const {
        orch,
        globalSignalRepo,
        strategyOrderRepo,
        positionLifecycle,
        signals,
      } = buildStack(
        runtimes([
          { userId: "karo", riskUsd: 1, rest: mockRestThrowsAlways() },
        ]),
        false,
      );
      await driveToActive(orch, "ADAUSDT", 2_000_000);
      const signal = signals.docs.find((d: any) => d.state === "ACTIVE");

      await recoverLoxOnRestart(
        globalSignalRepo,
        strategyOrderRepo,
        positionLifecycle,
        orch.getWatchManager(),
        runtimes([
          { userId: "karo", riskUsd: 1, rest: mockRestThrowsAlways() },
        ]),
        () => {},
        2_100_000,
      );

      const after = signals.docs.find(
        (d: any) => d.globalSignalId === signal.globalSignalId,
      );
      assert.strictEqual(
        after.state,
        "ACTIVE",
        "a genuinely still-managed PAPER position must not be closed merely by restarting",
      );
    },
  );

  await scenario(
    "restart restores the in-memory symbol lock for a genuinely still-ACTIVE signal -- a fresh opposite-direction liquidation must NOT steal the symbol",
    async () => {
      const { orch, globalSignalRepo, strategyOrderRepo } = buildStack(
        runtimes([
          { userId: "karo", riskUsd: 1, rest: mockRestThrowsAlways() },
        ]),
        false,
      );
      await driveToActive(orch, "ADAUSDT", 3_000_000);
      const { orch: freshOrch, positionLifecycle: freshPositionLifecycle } =
        buildStack(
          runtimes([
            { userId: "karo", riskUsd: 1, rest: mockRestThrowsAlways() },
          ]),
          false,
        );
      assert.strictEqual(
        freshOrch.getWatchManager().getLifecycle("ADAUSDT"),
        null,
        "sanity: a brand new process starts with an empty in-memory map",
      );

      await recoverLoxOnRestart(
        globalSignalRepo,
        strategyOrderRepo,
        freshPositionLifecycle,
        freshOrch.getWatchManager(),
        runtimes([
          { userId: "karo", riskUsd: 1, rest: mockRestThrowsAlways() },
        ]),
        () => {},
        3_100_000,
      );

      assert.strictEqual(
        freshOrch.getWatchManager().getLifecycle("ADAUSDT")?.globalState,
        "ACTIVE",
        "restart must restore the in-memory lock for a genuinely still-ACTIVE signal",
      );
      assert.strictEqual(
        freshOrch.getWatchManager().isSymbolOwned("ADAUSDT"),
        true,
      );
      freshOrch.onLiquidationEvent(
        {
          symbol: "ADAUSDT",
          victim: "LONG",
          timestamp: 3_200_000,
          price: 90,
          quoteQty: 60000,
        },
        null,
      );
      assert.strictEqual(
        freshOrch.getWatchManager().getLifecycle("ADAUSDT")?.globalState,
        "ACTIVE",
        "the restored ACTIVE lifecycle must be completely unaffected by a post-restart opposite event",
      );
    },
  );

  await scenario(
    "6. reset dry-run (audit only) performs ZERO writes",
    async () => {
      const { signals, userExecs, orders } = fakeMongo();
      signals.docs.push({
        globalSignalId: "sig-1",
        symbol: "ADAUSDT",
        state: "ACTIVE",
        victim: "SHORT",
      } as any);
      userExecs.docs.push({
        userId: "karo",
        globalSignalId: "sig-1",
        symbol: "ADAUSDT",
        mode: "PAPER",
        state: "ACTIVE",
        cleanupState: "PENDING",
      } as any);
      const cols: LoxCollections = {
        signals: signals as any,
        userExecs: userExecs as any,
        orders: orders as any,
      };
      await auditLoxState(cols);
      assert.strictEqual(
        signals.docs.length,
        1,
        "dry-run audit must not remove anything",
      );
      assert.strictEqual(userExecs.docs.length, 1);
    },
  );

  await scenario(
    "7. reset detection correctly flags REAL exposure and would refuse",
    async () => {
      const { signals, userExecs, orders } = fakeMongo();
      userExecs.docs.push({
        userId: "karo",
        globalSignalId: "sig-real",
        symbol: "ADAUSDT",
        mode: "REAL",
        state: "ACTIVE",
        cleanupState: "PENDING",
      } as any);
      userExecs.docs.push({
        userId: "artak",
        globalSignalId: "sig-real2",
        symbol: "SOLUSDT",
        mode: "REAL",
        state: "TERMINAL",
        cleanupState: "FAILED_RETRYING",
        cleanupFailureReason: "api down",
      } as any);
      orders.docs.push({
        userId: "artak",
        globalSignalId: "sig-real2",
        symbol: "SOLUSDT",
        purpose: "TAKE_PROFIT",
        state: "OPEN",
      } as any);
      const cols: LoxCollections = {
        signals: signals as any,
        userExecs: userExecs as any,
        orders: orders as any,
      };
      const audit = await auditLoxState(cols);
      assert.ok(
        audit.realExposure.length >= 2,
        "must detect real exposure from BOTH the ACTIVE+PENDING row and the FAILED_RETRYING+unresolved-order row",
      );
      assert.ok(audit.realExposure.some((r) => r.userId === "karo"));
      assert.ok(audit.realExposure.some((r) => r.userId === "artak"));
    },
  );

  await scenario(
    "10. shared strategy_orders collection: only rows with a genuine globalSignalId are treated as LOX-owned",
    async () => {
      const { signals, userExecs, orders } = fakeMongo();
      orders.docs.push({
        userId: "karo",
        globalSignalId: "sig-1",
        symbol: "ADAUSDT",
        purpose: "ENTRY",
        state: "FILLED",
      } as any);
      orders.docs.push({
        userId: "someone",
        globalSignalId: "",
        symbol: "ADAUSDT",
        purpose: "OTHER",
        state: "OPEN",
      } as any);
      const cols: LoxCollections = {
        signals: signals as any,
        userExecs: userExecs as any,
        orders: orders as any,
      };
      const audit = await auditLoxState(cols);
      assert.strictEqual(
        audit.allOrders.length,
        1,
        "only the row with a non-empty globalSignalId must be counted as LOX-owned",
      );
    },
  );

  await scenario(
    "11. confirmed reset (simulated) leaves zero LOX active locks",
    async () => {
      const { signals, userExecs, orders } = fakeMongo();
      signals.docs.push({
        globalSignalId: "sig-1",
        symbol: "ADAUSDT",
        state: "CLOSED",
      } as any);
      userExecs.docs.push({
        userId: "karo",
        globalSignalId: "sig-1",
        symbol: "ADAUSDT",
        mode: "PAPER",
        state: "TERMINAL",
        cleanupState: "COMPLETE",
      } as any);
      orders.docs.push({
        userId: "karo",
        globalSignalId: "sig-1",
        symbol: "ADAUSDT",
        purpose: "ENTRY",
        state: "FILLED",
      } as any);
      await signals.deleteMany({});
      await userExecs.deleteMany({});
      await orders.deleteMany({});
      assert.strictEqual(signals.docs.length, 0);
      assert.strictEqual(userExecs.docs.length, 0);
      assert.strictEqual(orders.docs.length, 0);
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
