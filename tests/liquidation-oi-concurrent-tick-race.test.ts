import * as assert from "assert";
import { LiquidationOiGlobalSignalRepository } from "../src/infrastructure/mongo/liquidation-oi-global-signal.repository";
import { StrategyOrderRepository } from "../src/infrastructure/mongo/strategy-order.repository";
import {
  LiquidationOiRuntimeOrchestrator,
  type LiquidationOiUserRuntimeRef,
} from "../src/services/liquidation-oi-runtime-orchestrator";
import { LiquidationOiPositionLifecycleService } from "../src/services/liquidation-oi-position-lifecycle.service";
import { LiquidationOiActiveMainRuntime } from "../src/services/liquidation-oi-active-main-runtime.service";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "../src/domain/liquidation-oi-strategy/config";
import { DEFAULT_CAPACITY_MODEL_COEFFICIENTS } from "../src/domain/liquidation-oi-strategy/initial-capacity-model";
import { DEFAULT_ACTIVE_LIFECYCLE_CONFIG } from "../src/domain/liquidation-oi-strategy/active-lifecycle-config";
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
    const matches = this.docs.filter((d) => matchesClause(d, filter));
    return { toArray: async () => matches };
  }
  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return (await this.find(filter).toArray())[0] ?? null;
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
function mockRestThrowsAlways(): BinanceRestLike {
  const fail = () => {
    throw new Error("MUST NEVER BE CALLED for PAPER");
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
    telegram?: { sendMessage: (t: string) => Promise<void> };
  }>,
): () => LiquidationOiUserRuntimeRef[] {
  return () =>
    specs.map((s) => ({
      userId: s.userId,
      riskUsd: s.riskUsd,
      liquidationOiExecutionEnabled: true,
      binanceRest: s.rest,
      telegram: s.telegram ?? { sendMessage: async () => {} },
    }));
}
function buildStack(getRuntimes: () => LiquidationOiUserRuntimeRef[]) {
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
    false,
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
  return { signals, userExecs, orch, positionLifecycle, activeMain };
}
const PCTX = {
  historicalSampleCount: 20,
  historicalP90: 100000,
  historicalP95: 200000,
  historicalP99: 400000,
  percentileRank: 96,
};
function candle(
  closeTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
) {
  return {
    symbol: "X",
    interval: "1m",
    openTime: closeTime - 60_000,
    closeTime,
    open,
    high,
    low,
    close,
    volume: 0,
    isClosed: true,
  } as any;
}
const FLAT_ATR = { get: (_i: string, _t: number) => 1.0 };

/** Sep 17 2026 (Karo), operator-approved lifecycle correction --
 *  drives an episode all the way to ACTIVE through the REAL pipeline.
 *  victim=LONG -> candidateSide=LONG, favorable price movement is
 *  UPWARD throughout, extreme is the adverse LOW. */
async function driveToActive(
  orch: LiquidationOiRuntimeOrchestrator,
  symbol: string,
  now0: number,
) {
  orch.onLiquidationEvent(
    {
      symbol,
      victim: "LONG",
      timestamp: now0,
      price: 103,
      quoteQty: 1_000_000,
    },
    { quantity: 6000, timestamp: now0 },
  );
  orch.onLiquidationEvent(
    {
      symbol,
      victim: "LONG",
      timestamp: now0 + 10_000,
      price: 100,
      quoteQty: 1_100_000,
    },
    { quantity: 5600, timestamp: now0 + 10_000 },
  );
  await orch.onTick(
    symbol,
    PCTX,
    [],
    100,
    1.0,
    1000,
    now0 + 11_000,
    null,
    null,
    null,
    [],
    [],
    FLAT_ATR,
  );

  const c1 = candle(now0 + 60_000, 100, 100.9, 100, 100.9);
  await orch.onTick(
    symbol,
    PCTX,
    [],
    100.9,
    1.0,
    1000,
    now0 + 65_000,
    null,
    null,
    null,
    [c1],
    [],
    FLAT_ATR,
  );

  const c2 = candle(now0 + 120_000, 100.9, 101.1, 100.7, 101.0);
  const c3 = candle(now0 + 180_000, 101.0, 101.3, 100.8, 101.2);
  const c3m = candle(now0 + 180_000, 100, 101.3, 100, 101.2);
  const historyAtEpisodeEnd = [
    { contracts: 6000, fetchedAt: now0 },
    { contracts: 5500, fetchedAt: now0 + 15_000 },
    { contracts: 5480, fetchedAt: now0 + 25_000 },
    { contracts: 5480, fetchedAt: now0 + 180_000 },
  ];
  await orch.onTick(
    symbol,
    PCTX,
    historyAtEpisodeEnd,
    101.2,
    1.0,
    1000,
    now0 + 185_000,
    null,
    null,
    null,
    [c2, c3],
    [c3m],
    FLAT_ATR,
  );

  const historyWithCreation = [
    ...historyAtEpisodeEnd,
    { contracts: 5560, fetchedAt: now0 + 200_000 },
  ];
  await orch.onTick(
    symbol,
    PCTX,
    historyWithCreation,
    101.3,
    1.0,
    1000,
    now0 + 200_000,
    null,
    null,
    null,
    [],
    [],
    FLAT_ATR,
  );
}

async function main(): Promise<void> {
  console.log(
    "Running concurrent-tick race regression tests (production incident)...\n",
  );

  await scenario(
    "REGRESSION: two overlapping onActiveTick calls for the same signal/user must produce exactly ONE close, not zero and not two",
    async () => {
      const sentPerUser: Record<string, string[]> = { main: [], karo: [] };
      const { orch, activeMain, signals, userExecs } = buildStack(
        runtimes([
          {
            userId: "main",
            riskUsd: 10,
            rest: mockRestThrowsAlways(),
            telegram: {
              sendMessage: async (t) => {
                sentPerUser.main.push(t);
              },
            },
          },
          {
            userId: "karo",
            riskUsd: 1,
            rest: mockRestThrowsAlways(),
            telegram: {
              sendMessage: async (t) => {
                sentPerUser.karo.push(t);
              },
            },
          },
        ]),
      );
      await driveToActive(orch, "BTCUSDT", 1_000_000);
      const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
      const exitPrice = signal.strategyInvalidationPrice - 0.5;

      await Promise.all([
        activeMain.onActiveTick(
          "BTCUSDT",
          signal.globalSignalId,
          "ep-test",
          "LONG",
          exitPrice,
          4590,
          1.0,
          1_100_000,
        ),
        activeMain.onActiveTick(
          "BTCUSDT",
          signal.globalSignalId,
          "ep-test",
          "LONG",
          exitPrice,
          4590,
          1.0,
          1_100_001,
        ),
      ]);

      for (const userId of ["main", "karo"]) {
        const user = userExecs.docs.find((d: any) => d.userId === userId);
        assert.strictEqual(
          user.state,
          "TERMINAL",
          `${userId} must be terminal`,
        );
        assert.strictEqual(user.terminalReason, "STRATEGY_INVALIDATION");
        const closeMsgs = sentPerUser[userId].filter((t) =>
          t.includes("CLOSED"),
        );
        assert.strictEqual(
          closeMsgs.length,
          1,
          `${userId} must receive EXACTLY ONE close message, got ${closeMsgs.length}`,
        );
      }
      assert.strictEqual(
        signals.docs.find(
          (d: any) => d.globalSignalId === signal.globalSignalId,
        ).state,
        "CLOSED",
      );
    },
  );

  await scenario(
    "REGRESSION: two overlapping PAPER TP-hit checks for the same user produce exactly ONE close",
    async () => {
      const sent: string[] = [];
      const { orch, activeMain, signals, userExecs } = buildStack(
        runtimes([
          {
            userId: "main",
            riskUsd: 10,
            rest: mockRestThrowsAlways(),
            telegram: {
              sendMessage: async (t) => {
                sent.push(t);
              },
            },
          },
        ]),
      );
      await driveToActive(orch, "BTCUSDT", 2_000_000);
      const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
      const tpPrice = signal.initialTpPrice;

      await Promise.all([
        activeMain.onActiveTick(
          "BTCUSDT",
          signal.globalSignalId,
          "ep-test",
          "LONG",
          tpPrice,
          4590,
          1.0,
          2_100_000,
        ),
        activeMain.onActiveTick(
          "BTCUSDT",
          signal.globalSignalId,
          "ep-test",
          "LONG",
          tpPrice,
          4590,
          1.0,
          2_100_001,
        ),
      ]);

      const user = userExecs.docs.find((d: any) => d.userId === "main");
      assert.strictEqual(user.state, "TERMINAL");
      assert.strictEqual(user.terminalReason, "TP_FILLED");
      const closeMsgs = sent.filter((t) => t.includes("CLOSED"));
      assert.strictEqual(
        closeMsgs.length,
        1,
        `must receive exactly one TP close message, got ${closeMsgs.length}`,
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
