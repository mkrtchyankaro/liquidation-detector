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
import { resolveUserExecutionMode } from "../src/domain/liquidation-oi-strategy/user-execution-mode";
import {
  pctMoveFromEntry,
  computePaperPnl,
} from "../src/domain/liquidation-oi-strategy/pnl-calculator";
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

function mockRestThrowsAlways(): BinanceRestLike {
  const fail = () => {
    throw new Error(
      "THIS REST CLIENT MUST NEVER BE CALLED -- PAPER mode must place zero Binance calls, regardless of whether a client is configured",
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
    cancelOrder: fail,
    getOpenOrders: fail,
    getOpenAlgoOrders: fail,
  } as unknown as BinanceRestLike;
}
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
      calls.push(`createOrder:${p.type}:${p.side}`);
      return { orderId: orderId++ };
    },
    createAlgoOrder: async (p: any) => {
      calls.push(`createAlgoOrder:${p.type}`);
      return { algoId: algoId++ };
    },
    getAlgoOrder: async () => ({ algoStatus: "WORKING" }),
    getAlgoOrderByClientId: async () => ({ algoStatus: "WORKING" }),
    cancelAlgoOrder: async () => {
      calls.push("cancelAlgoOrder");
      return {};
    },
    getOrder: async () => ({ status: "NEW" }),
    getPositionRisk: async () => [
      { symbol: "SOLUSDT", positionAmt: "10", entryPrice: "98" },
    ],
    cancelOrder: async () => {
      calls.push("cancelOrder");
      return {};
    },
    getOpenOrders: async () => {
      calls.push("getOpenOrders");
      return [];
    },
    getOpenAlgoOrders: async () => {
      calls.push("getOpenAlgoOrders");
      return [];
    },
  };
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
/** Sep 17 2026 (Karo), operator-approved lifecycle correction --
 *  drives an episode all the way to ACTIVE through the REAL, new
 *  pipeline (episode -> causal candle-confirmed episode end -> WAIT
 *  for post-episode OI creation -> ENTRY_READY -> ACTIVE), never
 *  bypassing it. victim=SHORT -> candidateSide=SHORT (identity
 *  mapping), so favorable price movement is DOWNWARD throughout. */
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
  await orch.onTick(
    symbol,
    PCTX,
    [],
    103,
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

  const c1 = candle(now0 + 60_000, 103, 103, 102.1, 102.1);
  await orch.onTick(
    symbol,
    PCTX,
    [],
    102.1,
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

  const c2 = candle(now0 + 120_000, 102.1, 102.3, 101.9, 102.0);
  const c3 = candle(now0 + 180_000, 102.0, 102.2, 101.7, 101.8);
  const c3m = candle(now0 + 180_000, 103, 103, 101.7, 101.8);
  const historyAtEpisodeEnd = [
    { contracts: 5000, fetchedAt: now0 },
    { contracts: 4600, fetchedAt: now0 + 15_000 },
    { contracts: 4590, fetchedAt: now0 + 25_000 },
    { contracts: 4590, fetchedAt: now0 + 180_000 },
  ];
  await orch.onTick(
    symbol,
    PCTX,
    historyAtEpisodeEnd,
    101.8,
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
    { contracts: 4650, fetchedAt: now0 + 200_000 },
  ];
  await orch.onTick(
    symbol,
    PCTX,
    historyWithCreation,
    101.7,
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
  console.log("Running PAPER/REAL execution architecture tests...\n");

  await scenario(
    "Matrix.1. enabled=false -> resolveUserExecutionMode returns NONE",
    () => {
      assert.strictEqual(resolveUserExecutionMode(false, true, true), "NONE");
      assert.strictEqual(resolveUserExecutionMode(false, false, false), "NONE");
    },
  );
  await scenario(
    "Matrix.2. enabled=true, userExec=false -> PAPER regardless of global",
    () => {
      assert.strictEqual(resolveUserExecutionMode(true, false, true), "PAPER");
      assert.strictEqual(resolveUserExecutionMode(true, false, false), "PAPER");
    },
  );
  await scenario(
    "Matrix.3. enabled=true, userExec=true, global=false -> PAPER (safety fallback)",
    () => {
      assert.strictEqual(resolveUserExecutionMode(true, true, false), "PAPER");
    },
  );
  await scenario(
    "Matrix.4. enabled=true, userExec=true, global=true -> REAL",
    () => {
      assert.strictEqual(resolveUserExecutionMode(true, true, true), "REAL");
    },
  );

  await scenario("PnL.1. LONG TP%/SL% signs correct", () => {
    assert.ok(
      pctMoveFromEntry("LONG", 100, 101) > 0,
      "LONG favorable move must be positive",
    );
    assert.ok(
      pctMoveFromEntry("LONG", 100, 99) < 0,
      "LONG adverse move must be negative",
    );
  });
  await scenario("PnL.2. SHORT TP%/SL% signs correct", () => {
    assert.ok(
      pctMoveFromEntry("SHORT", 100, 99) > 0,
      "SHORT favorable move (price down) must be positive",
    );
    assert.ok(
      pctMoveFromEntry("SHORT", 100, 101) < 0,
      "SHORT adverse move (price up) must be negative",
    );
  });
  await scenario(
    "PnL.3. paper gross PnL matches direction for LONG and SHORT",
    () => {
      const long = computePaperPnl({
        side: "LONG",
        entryPrice: 100,
        exitPrice: 105,
        quantity: 2,
      });
      assert.strictEqual(long.grossPnlUsd, 10);
      const short = computePaperPnl({
        side: "SHORT",
        entryPrice: 100,
        exitPrice: 95,
        quantity: 2,
      });
      assert.strictEqual(short.grossPnlUsd, 10);
    },
  );

  await scenario(
    "P.1. global OFF -> both users PAPER, paper entry persists with entry/TP/SL, zero Binance calls even though a real client is configured",
    async () => {
      const karoRest = mockRestThrowsAlways();
      const artakRest = mockRestThrowsAlways();
      const { orch, userExecs, signals } = buildStack(
        runtimes([
          { userId: "karo", riskUsd: 1, rest: karoRest },
          { userId: "artak", riskUsd: 5, rest: artakRest },
        ]),
        false,
      );
      await driveToActive(orch, "SOLUSDT", 1_000_000);
      const karo = userExecs.docs.find((d: any) => d.userId === "karo");
      const artak = userExecs.docs.find((d: any) => d.userId === "artak");
      assert.strictEqual(karo.mode, "PAPER");
      assert.strictEqual(artak.mode, "PAPER");
      assert.strictEqual(karo.state, "ACTIVE");
      assert.ok(
        karo.entryPrice !== null &&
          karo.tpPrice !== null &&
          karo.quantity !== null,
      );
      assert.strictEqual(
        signals.docs.find((d: any) => d.state === "ACTIVE")?.state,
        "ACTIVE",
        "global signal remains ACTIVE after ENTRY, not just an observational record",
      );
    },
  );

  await scenario(
    "P.2. PAPER TP hit -> terminal TP_FILLED with correct gross PnL, cleanup COMPLETE immediately, global closes once all paper users terminal",
    async () => {
      const rest = mockRestThrowsAlways();
      const { orch, activeMain, userExecs, signals } = buildStack(
        runtimes([{ userId: "karo", riskUsd: 1, rest }]),
        false,
      );
      await driveToActive(orch, "SOLUSDT", 2_000_000);
      const karo = userExecs.docs.find((d: any) => d.userId === "karo");
      const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
      await activeMain.onActiveTick(
        "SOLUSDT",
        signal.globalSignalId,
        "ep-test",
        "SHORT",
        karo.tpPrice,
        4590,
        1.0,
        2_010_000,
      );
      const updated = userExecs.docs.find((d: any) => d.userId === "karo");
      assert.strictEqual(updated.state, "TERMINAL");
      assert.strictEqual(updated.terminalReason, "TP_FILLED");
      assert.strictEqual(
        updated.cleanupState,
        "COMPLETE",
        "paper cleanup is immediate, no Binance scan needed",
      );
      const expectedPnl = computePaperPnl({
        side: "SHORT",
        entryPrice: karo.entryPrice,
        exitPrice: karo.tpPrice,
        quantity: karo.quantity,
      });
      assert.ok(Math.abs(updated.grossPnlUsd - expectedPnl.grossPnlUsd) < 1e-9);
      assert.ok(
        signals.docs.some((d: any) => d.state === "CLOSED"),
        "global must CLOSE once the only manageable user is terminal+clean",
      );
    },
  );

  await scenario(
    "P.3. PAPER strategy invalidation -> virtual close at causal reference price, correct PnL, zero Binance calls",
    async () => {
      const rest = mockRestThrowsAlways();
      const { orch, activeMain, userExecs, signals } = buildStack(
        runtimes([{ userId: "karo", riskUsd: 1, rest }]),
        false,
      );
      await driveToActive(orch, "SOLUSDT", 3_000_000);
      const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
      await activeMain.onActiveTick(
        "SOLUSDT",
        signal.globalSignalId,
        "ep-test",
        "SHORT",
        signal.strategyInvalidationPrice + 0.5,
        4590,
        1.0,
        3_010_000,
      );
      const karo = userExecs.docs.find((d: any) => d.userId === "karo");
      assert.strictEqual(karo.terminalReason, "STRATEGY_INVALIDATION");
      assert.strictEqual(
        karo.exitPrice,
        signal.strategyInvalidationPrice + 0.5,
      );
      assert.strictEqual(karo.cleanupState, "COMPLETE");
    },
  );

  await scenario(
    "P.4. PAPER follows MAIN dynamic TP revision -- currentTpPrice updates in Mongo, zero Binance calls",
    async () => {
      const rest = mockRestThrowsAlways();
      const { orch, activeMain, userExecs, signals } = buildStack(
        runtimes([{ userId: "karo", riskUsd: 1, rest }]),
        false,
      );
      await driveToActive(orch, "SOLUSDT", 4_000_000);
      const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
      const karoBefore = userExecs.docs.find((d: any) => d.userId === "karo");
      const oldTp = karoBefore.tpPrice;
      // First call establishes the window baseline (no evidence yet, same as any fresh controller);
      // the second call, after oiEfficiencyEvalIntervalMs, is where FAVORABLE evidence is actually
      // read -- price moves favorably but stays clear of the ORIGINAL TP (~99.77) so checkPaperTpHits
      // does not itself terminate the position before dynamic TP evaluation runs.
      await activeMain.onActiveTick(
        "SOLUSDT",
        signal.globalSignalId,
        "ep-test",
        "SHORT",
        102.5,
        4590,
        1.0,
        4_010_000,
      );
      await activeMain.onActiveTick(
        "SOLUSDT",
        signal.globalSignalId,
        "ep-test",
        "SHORT",
        101.5,
        4590 * 1.05,
        1.0,
        4_010_000 +
          DEFAULT_ACTIVE_LIFECYCLE_CONFIG.oiEfficiencyEvalIntervalMs +
          100,
      );
      const karoAfter = userExecs.docs.find((d: any) => d.userId === "karo");
      assert.notStrictEqual(
        karoAfter.tpPrice,
        oldTp,
        "paper TP must follow MAIN's dynamic revision",
      );
      assert.ok(karoAfter.appliedTpRevision > 0);
    },
  );

  await scenario(
    "P.5. MIXED: Karo REAL, Artak PAPER -- Artak's paper TP hits first, Karo stays REAL ACTIVE, global stays open; Karo later strategy-invalidates and closes -> GLOBAL CLOSED",
    async () => {
      const karoRest = mockRestSuccess();
      const artakRest = mockRestThrowsAlways();
      const { orch, activeMain, positionLifecycle, userExecs, signals } =
        buildStack(
          runtimes([
            { userId: "karo", riskUsd: 1, rest: karoRest, enabled: true },
            { userId: "artak", riskUsd: 5, rest: artakRest, enabled: false },
          ]),
          true,
        );
      await driveToActive(orch, "SOLUSDT", 5_000_000);
      let karo = userExecs.docs.find((d: any) => d.userId === "karo");
      let artak = userExecs.docs.find((d: any) => d.userId === "artak");
      assert.strictEqual(karo.mode, "REAL");
      assert.strictEqual(artak.mode, "PAPER");
      const signal = signals.docs.find((d: any) => d.state === "ACTIVE");

      await activeMain.onActiveTick(
        "SOLUSDT",
        signal.globalSignalId,
        "ep-test",
        "SHORT",
        artak.tpPrice,
        4590,
        1.0,
        5_010_000,
      );
      artak = userExecs.docs.find((d: any) => d.userId === "artak");
      assert.strictEqual(artak.state, "TERMINAL");
      assert.strictEqual(artak.terminalReason, "TP_FILLED");
      karo = userExecs.docs.find((d: any) => d.userId === "karo");
      assert.strictEqual(
        karo.state,
        "ACTIVE",
        "Karo's REAL position must be completely unaffected by Artak's paper TP hit",
      );
      assert.ok(
        !signals.docs.some((d: any) => d.state === "CLOSED"),
        "global must not close while Karo remains REAL ACTIVE",
      );

      karoRest.calls.length = 0;
      await activeMain.onActiveTick(
        "SOLUSDT",
        signal.globalSignalId,
        "ep-test",
        "SHORT",
        signal.strategyInvalidationPrice + 1,
        4590,
        1.0,
        5_020_000,
      );
      assert.ok(
        karoRest.calls.some((c) => c.startsWith("createOrder:MARKET")),
        "Karo (REAL) must receive an actual reduce-only MARKET close",
      );
      (karoRest as any).getPositionRisk = async () => [
        { symbol: "SOLUSDT", positionAmt: "0", entryPrice: "98" },
      ];
      (karoRest as any).getOrder = async () => ({ status: "FILLED" });
      await positionLifecycle.reconcileAll(5_030_000);
      karo = userExecs.docs.find((d: any) => d.userId === "karo");
      assert.strictEqual(karo.cleanupState, "COMPLETE");
      assert.ok(
        signals.docs.some((d: any) => d.state === "CLOSED"),
        "global closes once BOTH paper and real users are terminal+clean",
      );
    },
  );

  await scenario(
    "P.6. TP revision NEVER places a real Binance TP for a PAPER user, even when that user happens to have a real client configured",
    async () => {
      const rest = mockRestThrowsAlways();
      const { orch, activeMain, signals } = buildStack(
        runtimes([{ userId: "karo", riskUsd: 1, rest, enabled: true }]),
        false,
      );
      await driveToActive(orch, "SOLUSDT", 6_000_000);
      const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
      await activeMain.onActiveTick(
        "SOLUSDT",
        signal.globalSignalId,
        "ep-test",
        "SHORT",
        95,
        4590 * 1.05,
        1.0,
        6_010_000,
      );
    },
  );

  await scenario(
    "P.7. MARKET_EXIT never places a real Binance order for a PAPER user, even when that user happens to have a real client configured",
    async () => {
      const rest = mockRestThrowsAlways();
      const { orch, activeMain, signals } = buildStack(
        runtimes([{ userId: "karo", riskUsd: 1, rest, enabled: true }]),
        false,
      );
      await driveToActive(orch, "SOLUSDT", 7_000_000);
      const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
      await activeMain.onActiveTick(
        "SOLUSDT",
        signal.globalSignalId,
        "ep-test",
        "SHORT",
        signal.strategyInvalidationPrice + 1,
        4590,
        1.0,
        7_010_000,
      );
    },
  );

  await scenario(
    "P.8. REGRESSION (live production bug, Sep 17 2026) -- the periodic Binance reconciler must NEVER treat a PAPER user's real (always-flat) Binance position as POSITION_CLOSED_EXTERNALLY, even when that user has a real, working binanceRest client configured",
    async () => {
      const rest = mockRestSuccess();
      (rest as any).getPositionRisk = async () => [
        { symbol: "SOLUSDT", positionAmt: "0", entryPrice: "0" },
      ]; // exactly the real-world case: a real client, but flat, because no real trade was ever placed for this PAPER user
      const { orch, positionLifecycle, userExecs, signals } = buildStack(
        runtimes([{ userId: "brother", riskUsd: 1, rest, enabled: false }]),
        true,
      );
      await driveToActive(orch, "SOLUSDT", 8_000_000);
      const before = userExecs.docs.find((d: any) => d.userId === "brother");
      assert.strictEqual(before.mode, "PAPER");
      assert.strictEqual(before.state, "ACTIVE");
      // This is the exact call the 15s periodic timer makes in production -- previously this incorrectly
      // terminated the paper user within one cycle, with terminalReason=POSITION_CLOSED_EXTERNALLY and no exit price.
      await positionLifecycle.reconcileAll(8_015_000);
      const after = userExecs.docs.find((d: any) => d.userId === "brother");
      assert.strictEqual(
        after.state,
        "ACTIVE",
        "a PAPER user must remain ACTIVE through Binance reconciliation -- it is monitored exclusively by the causal price-based paper checks, never by real-position polling",
      );
      assert.strictEqual(after.terminalReason, null);
      const activeSignal = signals.docs.find((d: any) => d.state === "ACTIVE");
      assert.ok(activeSignal, "the global signal must also remain ACTIVE");
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
