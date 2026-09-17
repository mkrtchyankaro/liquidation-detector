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
import {
  formatPrice,
  formatCompactUsd,
  formatSignedUsd,
  formatUtcTime,
} from "../src/domain/liquidation-oi-strategy/telegram-display-format";
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
function mockRestSuccess(): BinanceRestLike & {
  calls: string[];
  positionAmt: string;
  tpStatus: string;
} {
  const calls: string[] = [];
  let algoId = 1,
    orderId = 1;
  const state = { positionAmt: "10", tpStatus: "NEW" };
  return {
    calls,
    get positionAmt() {
      return state.positionAmt;
    },
    set positionAmt(v: string) {
      state.positionAmt = v;
    },
    get tpStatus() {
      return state.tpStatus;
    },
    set tpStatus(v: string) {
      state.tpStatus = v;
    },
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
    getOrder: async () => ({ status: state.tpStatus }),
    getPositionRisk: async () => [
      { symbol: "ADAUSDT", positionAmt: state.positionAmt, entryPrice: "98" },
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
  } as unknown as BinanceRestLike & {
    calls: string[];
    positionAmt: string;
    tpStatus: string;
  };
}

function runtimes(
  specs: Array<{
    userId: string;
    riskUsd: number;
    rest: BinanceRestLike | null;
    enabled?: boolean;
    telegram?: { sendMessage: (t: string) => Promise<void> };
  }>,
): () => LiquidationOiUserRuntimeRef[] {
  return () =>
    specs.map((s) => ({
      userId: s.userId,
      riskUsd: s.riskUsd,
      liquidationOiExecutionEnabled: s.enabled ?? true,
      binanceRest: s.rest,
      telegram: s.telegram ?? { sendMessage: async () => {} },
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
  console.log("Running Telegram UX redesign regression tests...\n");

  await scenario(
    "F.1. formatPrice: ADA-magnitude value never shows raw JS floating point",
    () => {
      assert.strictEqual(formatPrice(0.19925549538626092), "0.19926");
    },
  );
  await scenario(
    "F.2. formatPrice: BTC-magnitude and ETH-magnitude use sensible precision",
    () => {
      assert.strictEqual(formatPrice(75164.2), "75,164.2");
      assert.strictEqual(formatPrice(2477.43), "2,477.43");
    },
  );
  await scenario(
    "F.3. formatCompactUsd: K/M compaction, never shows $0.04M for a $40K value",
    () => {
      assert.strictEqual(formatCompactUsd(40000), "$40K");
      assert.strictEqual(formatCompactUsd(620000), "$620K");
      assert.strictEqual(formatCompactUsd(1240000), "$1.24M");
      assert.notStrictEqual(formatCompactUsd(40000), "$0.04M");
    },
  );
  await scenario("F.4. formatSignedUsd is always explicitly signed", () => {
    assert.strictEqual(formatSignedUsd(5.44), "+$5.44");
    assert.strictEqual(formatSignedUsd(-1), "-$1.00");
  });
  await scenario("F.5. formatUtcTime produces HH:MM:SS UTC", () => {
    assert.match(
      formatUtcTime(Date.UTC(2026, 8, 17, 8, 40, 12)),
      /^08:40:12 UTC$/,
    );
  });

  await scenario(
    "B.1. no WATCH Telegram is ever sent -- ENTRY is the first user-facing message",
    async () => {
      const sent: string[] = [];
      const rest = mockRestThrowsAlways();
      const { orch } = buildStack(
        runtimes([
          {
            userId: "karo",
            riskUsd: 1,
            rest,
            telegram: {
              sendMessage: async (t) => {
                sent.push(t);
              },
            },
          },
        ]),
        false,
      );
      await driveToActive(orch, "ADAUSDT", 1_000_000);
      assert.ok(
        !sent.some((t) => t.includes("WATCH")),
        "no message may contain the word WATCH",
      );
      assert.ok(
        sent.some((t) => t.includes("ENTRY")),
        "ENTRY must still be sent",
      );
    },
  );

  await scenario(
    "C.1. ENTRY message contains the actual persisted globalSignalId",
    async () => {
      const sent: string[] = [];
      const rest = mockRestThrowsAlways();
      const { orch, signals } = buildStack(
        runtimes([
          {
            userId: "karo",
            riskUsd: 1,
            rest,
            telegram: {
              sendMessage: async (t) => {
                sent.push(t);
              },
            },
          },
        ]),
        false,
      );
      await driveToActive(orch, "ADAUSDT", 2_000_000);
      const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
      assert.ok(
        sent.some((t) => t.includes(signal.globalSignalId)),
        "ENTRY must contain the persisted globalSignalId",
      );
    },
  );

  await scenario(
    "C.2. CLOSE message contains the same globalSignalId as ENTRY",
    async () => {
      const sent: string[] = [];
      const rest = mockRestThrowsAlways();
      const { orch, activeMain, signals } = buildStack(
        runtimes([
          {
            userId: "karo",
            riskUsd: 1,
            rest,
            telegram: {
              sendMessage: async (t) => {
                sent.push(t);
              },
            },
          },
        ]),
        false,
      );
      await driveToActive(orch, "ADAUSDT", 3_000_000);
      const karoDoc = signals.docs.find((d: any) => d.state === "ACTIVE");
      const signalId = karoDoc.globalSignalId;
      await activeMain.onActiveTick(
        "ADAUSDT",
        signalId,
        "ep-test",
        "SHORT",
        karoDoc.strategyInvalidationPrice + 1,
        4590,
        1.0,
        3_010_000,
      );
      const closeMsg = sent.find((t) => t.includes("CLOSED"));
      assert.ok(closeMsg, "a CLOSE message must have been sent");
      assert.ok(
        closeMsg!.includes(signalId),
        "CLOSE must contain the SAME globalSignalId as ENTRY",
      );
    },
  );

  await scenario("C.3. TP UPDATE message contains globalSignalId", async () => {
    const sent: string[] = [];
    const rest = mockRestThrowsAlways();
    const { orch, activeMain, signals } = buildStack(
      runtimes([
        {
          userId: "karo",
          riskUsd: 1,
          rest,
          telegram: {
            sendMessage: async (t) => {
              sent.push(t);
            },
          },
        },
      ]),
      false,
    );
    await driveToActive(orch, "ADAUSDT", 4_000_000);
    const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
    await activeMain.onActiveTick(
      "ADAUSDT",
      signal.globalSignalId,
      "ep-test",
      "SHORT",
      102.5,
      4590,
      1.0,
      4_010_000,
    );
    await activeMain.onActiveTick(
      "ADAUSDT",
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
    const tpMsg = sent.find((t) => t.includes("TP UPDATED"));
    assert.ok(tpMsg, "a TP UPDATE message must have been sent");
    assert.ok(tpMsg!.includes(signal.globalSignalId));
  });

  await scenario(
    "D.1. ENTRY contains UTC entry time, Risk, Position notional, TP %+$, SL %+$",
    async () => {
      const sent: string[] = [];
      const rest = mockRestThrowsAlways();
      const { orch } = buildStack(
        runtimes([
          {
            userId: "karo",
            riskUsd: 1,
            rest,
            telegram: {
              sendMessage: async (t) => {
                sent.push(t);
              },
            },
          },
        ]),
        false,
      );
      await driveToActive(orch, "ADAUSDT", 5_000_000);
      const entry = sent.find((t) => t.includes("ENTRY"))!;
      assert.ok(/UTC/.test(entry), "must contain a UTC timestamp");
      assert.ok(/Risk\s+\$1\.00/.test(entry), "must show Risk $1.00");
      assert.ok(/Position\s+\$/.test(entry), "must show Position notional");
      assert.ok(
        /TP\s+.*%.*\$/.test(entry),
        "TP line must contain both % and $",
      );
      assert.ok(
        /SL\s+.*%.*\$/.test(entry),
        "SL line must contain both % and $",
      );
    },
  );

  await scenario(
    "A.1. REGRESSION: PAPER never terminates as POSITION_CLOSED_EXTERNALLY via Binance reconciliation, even with a real, flat client",
    async () => {
      const rest = mockRestSuccess();
      rest.positionAmt = "0";
      const { orch, positionLifecycle, userExecs } = buildStack(
        runtimes([{ userId: "brother", riskUsd: 1, rest, enabled: false }]),
        true,
      );
      await driveToActive(orch, "ADAUSDT", 6_000_000);
      const before = userExecs.docs.find((d: any) => d.userId === "brother");
      assert.strictEqual(before.mode, "PAPER");
      await positionLifecycle.reconcileAll(6_015_000);
      const after = userExecs.docs.find((d: any) => d.userId === "brother");
      assert.strictEqual(after.state, "ACTIVE");
      assert.strictEqual(after.terminalReason, null);
    },
  );

  await scenario(
    "A.2. restart preserves an ACTIVE PAPER position and resumes virtual monitoring",
    async () => {
      const rest = mockRestSuccess();
      rest.positionAmt = "0";
      const {
        orch,
        globalSignalRepo,
        strategyOrderRepo,
        positionLifecycle,
        userExecs,
      } = buildStack(
        runtimes([{ userId: "friend", riskUsd: 1, rest, enabled: false }]),
        true,
      );
      await driveToActive(orch, "ADAUSDT", 7_000_000);
      await recoverLoxOnRestart(
        globalSignalRepo,
        strategyOrderRepo,
        positionLifecycle,
        orch.getWatchManager(),
        runtimes([{ userId: "friend", riskUsd: 1, rest, enabled: false }]),
        () => {},
        7_015_000,
      );
      const after = userExecs.docs.find((d: any) => d.userId === "friend");
      assert.strictEqual(after.mode, "PAPER");
      assert.strictEqual(
        after.state,
        "ACTIVE",
        "restart must NEVER treat a PAPER user's flat real account as a close",
      );
    },
  );

  await scenario(
    "A.3. REAL external-close reconciliation still works unchanged",
    async () => {
      const rest = mockRestSuccess();
      const { orch, positionLifecycle, userExecs } = buildStack(
        runtimes([{ userId: "karo", riskUsd: 1, rest, enabled: true }]),
        true,
      );
      await driveToActive(orch, "ADAUSDT", 8_000_000);
      const before = userExecs.docs.find((d: any) => d.userId === "karo");
      assert.strictEqual(before.mode, "REAL");
      assert.strictEqual(
        before.state,
        "ACTIVE",
        "sanity: entry must have succeeded before we simulate a later external close",
      );
      rest.positionAmt = "0";
      rest.tpStatus = "NEW"; // simulate the position closing on Binance AFTER entry, with no provable cause
      await positionLifecycle.reconcileAll(8_015_000);
      const after = userExecs.docs.find((d: any) => d.userId === "karo");
      assert.strictEqual(after.state, "TERMINAL");
      assert.strictEqual(after.terminalReason, "POSITION_CLOSED_EXTERNALLY");
    },
  );

  await scenario("A.4. mixed PAPER/REAL cannot cross-close", async () => {
    const karoRest = mockRestSuccess();
    karoRest.positionAmt = "10";
    const artakRest = mockRestSuccess();
    artakRest.positionAmt = "0";
    const { orch, positionLifecycle, userExecs } = buildStack(
      runtimes([
        { userId: "karo", riskUsd: 1, rest: karoRest, enabled: true },
        { userId: "artak", riskUsd: 5, rest: artakRest, enabled: false },
      ]),
      true,
    );
    await driveToActive(orch, "ADAUSDT", 9_000_000);
    await positionLifecycle.reconcileAll(9_015_000);
    const karo = userExecs.docs.find((d: any) => d.userId === "karo");
    const artak = userExecs.docs.find((d: any) => d.userId === "artak");
    assert.strictEqual(
      karo.state,
      "ACTIVE",
      "Karo (REAL, still open) must remain ACTIVE",
    );
    assert.strictEqual(
      artak.state,
      "ACTIVE",
      "Artak (PAPER) must remain ACTIVE regardless of his real account being flat",
    );
  });

  await scenario(
    "N.1. each user's Telegram receives ONLY that user's own ENTRY -- no cross-leak",
    async () => {
      const karoSent: string[] = [];
      const artakSent: string[] = [];
      const karoRest = mockRestThrowsAlways();
      const artakRest = mockRestThrowsAlways();
      const { orch } = buildStack(
        runtimes([
          {
            userId: "karo",
            riskUsd: 1,
            rest: karoRest,
            telegram: {
              sendMessage: async (t) => {
                karoSent.push(t);
              },
            },
          },
          {
            userId: "artak",
            riskUsd: 5,
            rest: artakRest,
            telegram: {
              sendMessage: async (t) => {
                artakSent.push(t);
              },
            },
          },
        ]),
        false,
      );
      await driveToActive(orch, "ADAUSDT", 10_000_000);
      assert.ok(
        karoSent.some((t) => t.includes("Karo")),
        "Karo's own message must show Karo's own display name",
      );
      assert.ok(
        !karoSent.some((t) => t.includes("Artak")),
        "Karo must never receive a message mentioning Artak",
      );
      assert.ok(artakSent.some((t) => t.includes("Artak")));
      assert.ok(!artakSent.some((t) => t.includes("Karo")));
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
