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
    createOrder: async (p: any) => { calls.push(`createOrder:${p.type}`); return { orderId: orderId++ }; },
    createAlgoOrder: async (p: any) => { calls.push(`createAlgoOrder:${p.type}`); return { algoId: algoId++ }; },
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
function mockRestProtectionFails(): BinanceRestLike & { calls: string[] } {
  const rest = mockRestSuccess(); rest.createAlgoOrder = async () => { throw new Error("simulated"); }; return rest;
}
function mockRestNeverCalled(): BinanceRestLike {
  const fail = () => { throw new Error("MUST NEVER BE CALLED"); };
  return { getExchangeInfo: fail, createOrder: fail, createAlgoOrder: fail, getAlgoOrder: fail, getAlgoOrderByClientId: fail, cancelAlgoOrder: fail, getOrder: fail, getPositionRisk: fail } as unknown as BinanceRestLike;
}
function karoArtak(karoRest: BinanceRestLike | null, artakRest: BinanceRestLike | null, karoEnabled = true, artakEnabled = true): LiquidationOiUserRuntimeRef[] {
  return [
    { userId: "karo", riskUsd: 1, liquidationOiExecutionEnabled: karoEnabled, binanceRest: karoRest, telegram: { sendMessage: async () => {} } },
    { userId: "artak", riskUsd: 5, liquidationOiExecutionEnabled: artakEnabled, binanceRest: artakRest, telegram: { sendMessage: async () => {} } },
  ];
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
  console.log("Running lifecycle-death-fix regression tests...\n");

  await scenario("A. SHORT episode no-progress -> terminates -> later LONG liquidation starts a NEW episode", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "XRPUSDT", victim: "SHORT", timestamp: 1000, price: 1.0, quoteQty: 50000 }, null);
    mgr.onTick("XRPUSDT", PCTX, [], 1.0, 1.0, 1000, 1000 + 61_000);
    assert.strictEqual(mgr.getLifecycle("XRPUSDT"), null, "must release after no-progress death");
    assert.ok(mgr.getNoSignalLog().some((n) => n.reasonCode === "EPISODE_NO_PROGRESS"));
    mgr.onLiquidationEvent({ symbol: "XRPUSDT", victim: "LONG", timestamp: 1000 + 70_000, price: 0.9, quoteQty: 40000 }, null);
    const lc = mgr.getLifecycle("XRPUSDT")!;
    assert.strictEqual(lc.episode.victim, "LONG");
    assert.strictEqual(lc.episode.eventCount, 1, "must be a genuinely NEW episode, not merged with the dead SHORT one");
    assert.strictEqual(lc.episode.sameDirectionLiqUsd, 40000);
  });

  await scenario("B. ENTRY_READY + execution globally disabled -> resolves to PAPER (safety fallback) -> global signal ACTIVE -> symbol remains legitimately owned, NOT released", async () => {
    const { mongo } = fakeMongo();
    const rest = mockRestNeverCalled();
    const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, new LiquidationOiGlobalSignalRepository(mongo), new StrategyOrderRepository(mongo), () => karoArtak(rest, rest), true, false);
    await driveToEntryReady(orch, "SOLUSDT", 1_000_000);
    assert.strictEqual(orch.getWatchManager().getLifecycle("SOLUSDT")!.globalState, "ACTIVE", "PAPER users are manageable -- the global signal must remain ACTIVE, not release");
    assert.strictEqual(orch.getWatchManager().isSymbolOwned("SOLUSDT"), true, "ownership must be retained while paper positions are ACTIVE");
    // An opposite-direction liquidation while a PAPER-backed episode is ACTIVE must be ignored, exactly like a real ACTIVE position -- never steal the symbol.
    orch.onLiquidationEvent({ symbol: "SOLUSDT", victim: "LONG", timestamp: 5_000_000, price: 90, quoteQty: 60000 }, { quantity: 1000, timestamp: 5_000_000 });
    const lc = orch.getWatchManager().getLifecycle("SOLUSDT")!;
    assert.strictEqual(lc.globalState, "ACTIVE", "the ACTIVE (paper-backed) lifecycle must be completely unaffected by the opposite event");
  });

  await scenario("C. ENTRY_READY + all per-user execution disabled -> resolves to PAPER for every user -> global signal ACTIVE, symbol owned, not released", async () => {
    const { mongo } = fakeMongo();
    const rest = mockRestNeverCalled();
    const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, new LiquidationOiGlobalSignalRepository(mongo), new StrategyOrderRepository(mongo), () => karoArtak(rest, rest, false, false), true, true);
    await driveToEntryReady(orch, "SOLUSDT", 2_000_000);
    assert.strictEqual(orch.getWatchManager().getLifecycle("SOLUSDT")!.globalState, "ACTIVE");
    assert.strictEqual(orch.getWatchManager().isSymbolOwned("SOLUSDT"), true);
  });

  await scenario("D. Karo execution succeeds -> real ACTIVE position -> later opposite LONG liquidation MUST NOT steal/release the symbol", async () => {
    const { mongo } = fakeMongo();
    const rest = mockRestSuccess();
    const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, new LiquidationOiGlobalSignalRepository(mongo), new StrategyOrderRepository(mongo), () => [{ userId: "karo", riskUsd: 1, liquidationOiExecutionEnabled: true, binanceRest: rest, telegram: null }], true, true);
    await driveToEntryReady(orch, "SOLUSDT", 3_000_000);
    const activeLc = orch.getWatchManager().getLifecycle("SOLUSDT")!;
    assert.strictEqual(activeLc.globalState, "ACTIVE");
    const sameDirUsdBefore = activeLc.episode.sameDirectionLiqUsd;
    orch.onLiquidationEvent({ symbol: "SOLUSDT", victim: "LONG", timestamp: 3_100_000, price: 90, quoteQty: 999999 }, null);
    const afterLc = orch.getWatchManager().getLifecycle("SOLUSDT")!;
    assert.strictEqual(afterLc.globalState, "ACTIVE", "must remain ACTIVE -- never stolen by an opposite event");
    assert.strictEqual(afterLc.episode.victim, "SHORT", "must remain the original SHORT episode");
    assert.strictEqual(afterLc.episode.sameDirectionLiqUsd, sameDirUsdBefore, "must be completely untouched");
  });

  await scenario("E. ENTRY_READY old SHORT setup resolved with no position -> hours later new SHORT liquidation -> NEW episode, not accumulated", () => {
    const mgr = new LiquidationOiWatchManager();
    mgr.onLiquidationEvent({ symbol: "ETHUSDT", victim: "SHORT", timestamp: 1000, price: 100, quoteQty: 50000 }, null);
    mgr.cancel("ETHUSDT", "ENTRY_READY_OBSERVATIONAL_ONLY", "test", 2000);
    assert.strictEqual(mgr.getLifecycle("ETHUSDT"), null);
    const hoursLater = 2000 + 3 * 3_600_000;
    mgr.onLiquidationEvent({ symbol: "ETHUSDT", victim: "SHORT", timestamp: hoursLater, price: 105, quoteQty: 80000 }, null);
    const lc = mgr.getLifecycle("ETHUSDT")!;
    assert.strictEqual(lc.episode.eventCount, 1);
    assert.strictEqual(lc.episode.sameDirectionLiqUsd, 80000, "must NOT include the old episode's 50000");
    assert.strictEqual(lc.episode.startPrice, 105, "must be a new start price, not the old 100");
  });

  await scenario("F. one user succeeds, one fails -> global lifecycle remains ACTIVE", async () => {
    const { mongo } = fakeMongo();
    const karoRest = mockRestSuccess();
    const artakRest = mockRestProtectionFails();
    const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, new LiquidationOiGlobalSignalRepository(mongo), new StrategyOrderRepository(mongo), () => karoArtak(karoRest, artakRest), true, true);
    await driveToEntryReady(orch, "SOLUSDT", 4_000_000);
    const lc = orch.getWatchManager().getLifecycle("SOLUSDT")!;
    assert.strictEqual(lc.globalState, "ACTIVE", "Karo's success alone must be enough for the GLOBAL lifecycle to remain ACTIVE");
  });

  await scenario("G. all executions fail -> zero real positions -> global lifecycle terminates and releases", async () => {
    const { mongo, signals } = fakeMongo();
    const karoRest = mockRestProtectionFails();
    const artakRest = mockRestProtectionFails();
    const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, new LiquidationOiGlobalSignalRepository(mongo), new StrategyOrderRepository(mongo), () => karoArtak(karoRest, artakRest), true, true);
    await driveToEntryReady(orch, "SOLUSDT", 5_000_000);
    assert.strictEqual(orch.getWatchManager().getLifecycle("SOLUSDT"), null);
    assert.strictEqual(signals.docs[0].state, "CANCELLED");
  });

  await scenario("H. persistent stale market data -> eventually releases", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, marketDataStaleTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BNBUSDT", victim: "LONG", timestamp: 1000, price: 500, quoteQty: 50000 }, null);
    mgr.onTick("BNBUSDT", PCTX, [], 500, 1.0, 1000, 2000);
    assert.ok(mgr.getLifecycle("BNBUSDT") !== null, "sanity: still alive right after a normal tick");
    mgr.onTick("BNBUSDT", PCTX, [], 500, 1.0, 1000, 2000 + 61_000);
    assert.strictEqual(mgr.getLifecycle("BNBUSDT"), null);
    assert.ok(mgr.getNoSignalLog().some((n) => n.reasonCode === "MARKET_DATA_STALE_TIMEOUT"));
  });

  await scenario("I. one transient stale-ish observation does NOT immediately kill a valid episode", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, marketDataStaleTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BNBUSDT", victim: "LONG", timestamp: 1000, price: 500, quoteQty: 50000 }, null);
    mgr.onTick("BNBUSDT", PCTX, [], 500, 1.0, 1000, 2000);
    mgr.onTick("BNBUSDT", PCTX, [], 500, 1.0, 1000, 2000 + 30_000);
    assert.ok(mgr.getLifecycle("BNBUSDT") !== null, "a single sub-threshold gap must not kill the episode");
  });

  await scenario("J. failsafe lifetime can never leave a symbol locked for 10+ hours, even if the primary checks are configured not to fire", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, preEntryFailsafeMaxLifetimeMs: 100_000, noProgressTimeoutMs: 999_999_999, marketDataStaleTimeoutMs: 999_999_999, entryWindowTimeoutMs: 999_999_999 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "DOGEUSDT", victim: "LONG", timestamp: 0, price: 0.1, quoteQty: 50000 }, null);
    mgr.onTick("DOGEUSDT", PCTX, [], 0.1, 1.0, 1000, 50_000);
    assert.ok(mgr.getLifecycle("DOGEUSDT") !== null, "sanity: primary checks configured not to fire yet");
    mgr.onLiquidationEvent({ symbol: "DOGEUSDT", victim: "LONG", timestamp: 99_000, price: 0.11, quoteQty: 1000 }, null);
    mgr.onTick("DOGEUSDT", PCTX, [], 0.1, 1.0, 1000, 150_000);
    assert.strictEqual(mgr.getLifecycle("DOGEUSDT"), null, "FAILSAFE must fire even though noProgress/staleData were configured not to");
    assert.ok(mgr.getNoSignalLog().some((n) => n.reasonCode === "PRE_ENTRY_FAILSAFE_MAX_LIFETIME"));
  });

  await scenario("INVARIANT 1: no symbol can remain owned in a non-ACTIVE theoretical state indefinitely (direct proof via the failsafe)", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, preEntryFailsafeMaxLifetimeMs: 36_000_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75000, quoteQty: 50000 }, null);
    mgr.onTick("BTCUSDT", PCTX, [], 75000, 100, 1000, 36_000_001);
    assert.strictEqual(mgr.getLifecycle("BTCUSDT"), null, "10+ hour lock, exactly the real BTC incident's own duration, must be structurally impossible");
  });

  await scenario("INVARIANT 2: a symbol with a real managed position is NEVER released by pre-entry stale/no-progress logic", async () => {
    const { mongo } = fakeMongo();
    const rest = mockRestSuccess();
    // uses the DEFAULT config (not extreme test values) -- the point is that once ACTIVE,
    // even a tick far beyond every single one of the default thresholds (including the 4h
    // failsafe) must never release the symbol, because onTick() early-returns for ACTIVE
    // before any of these checks are evaluated at all.
    const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, new LiquidationOiGlobalSignalRepository(mongo), new StrategyOrderRepository(mongo), () => [{ userId: "karo", riskUsd: 1, liquidationOiExecutionEnabled: true, binanceRest: rest, telegram: null }], true, true);
    await driveToEntryReady(orch, "SOLUSDT", 6_000_000);
    const activeLc = orch.getWatchManager().getLifecycle("SOLUSDT")!;
    assert.strictEqual(activeLc.globalState, "ACTIVE");
    // 6 hours later -- past noProgressTimeoutMs (30min), entryWindowTimeoutMs (20min),
    // marketDataStaleTimeoutMs (10min), and preEntryFailsafeMaxLifetimeMs (4h), all at once.
    await orch.onTick("SOLUSDT", PCTX, [], 100, 1.0, 1000, 6_000_000 + 6 * 3_600_000);
    const stillActive = orch.getWatchManager().getLifecycle("SOLUSDT")!;
    assert.strictEqual(stillActive.globalState, "ACTIVE", "ACTIVE must be completely immune to every pre-entry timeout, even long after all of them would otherwise have fired");
  });

  // ============== Meaningful-progress fix (Sep 16 2026, second pass) -- reproduces the real BTC over-refresh pattern ==============

  await scenario("MP.1. tiny same-side liquidation noise cannot keep a dead episode alive forever", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75700, quoteQty: 500000 }, null);
    // a stream of TINY same-direction liquidations, well under minMeaningfulLiqProgressFraction (5%) each,
    // spaced closer together than noProgressTimeoutMs so the OLD (size-agnostic) check would never have fired
    for (let i = 1; i <= 20; i++) {
      mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: i * 10_000, price: 75700, quoteQty: 76 }, null);
      mgr.onTick("BTCUSDT", PCTX, [], 75700, 100, 1000, i * 10_000 + 1);
    }
    assert.ok(mgr.getLifecycle("BTCUSDT") !== null, "sanity: still alive after 200s of tiny noise (under noProgressTimeoutMs=60s since the LAST tick, but no single event was individually meaningful)");
    // now let real time pass with no further events at all
    mgr.onTick("BTCUSDT", PCTX, [], 75700, 100, 1000, 20 * 10_000 + 61_000);
    assert.strictEqual(mgr.getLifecycle("BTCUSDT"), null, "must die once meaningful progress (not mere activity) has been absent for noProgressTimeoutMs");
  });

  await scenario("MP.2. tiny adverse price extensions cannot keep a dead episode alive forever", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75700, quoteQty: 500000 }, null);
    // repeated ticks with a marginal new high each time (0.001 ATR, far under minMeaningfulExtremeProgressAtr=0.05)
    let price = 75700;
    for (let i = 1; i <= 20; i++) {
      price += 0.01; // negligible vs ATR=100
      mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: i * 10_000, price, quoteQty: 100 }, null);
      mgr.onTick("BTCUSDT", PCTX, [], price, 100, 1000, i * 10_000 + 1);
    }
    mgr.onTick("BTCUSDT", PCTX, [], price, 100, 1000, 20 * 10_000 + 61_000);
    assert.strictEqual(mgr.getLifecycle("BTCUSDT"), null, "noisy sub-threshold extreme extension must not indefinitely refresh the clock");
  });

  await scenario("MP.3. meaningful continuing liquidation pressure DOES keep an episode alive", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75700, quoteQty: 100000 }, null);
    // each new event grows the total by >= 10% (well above the 5% threshold), spaced 50s apart (< 60s noProgressTimeoutMs)
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 50_000, price: 75720, quoteQty: 15000 }, null);
    mgr.onTick("BTCUSDT", PCTX, [], 75720, 100, 1000, 50_001);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 100_000, price: 75740, quoteQty: 15000 }, null);
    mgr.onTick("BTCUSDT", PCTX, [], 75740, 100, 1000, 100_001);
    assert.ok(mgr.getLifecycle("BTCUSDT") !== null, "genuinely continuing meaningful liquidation pressure must keep the episode alive");
  });

  await scenario("MP.4. meaningful adverse displacement DOES keep an episode alive", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75700, quoteQty: 500000 }, null);
    // a genuinely material extreme extension: +10 ATR-units on ATR=100 -> 0.1 ATR, above the 0.05 threshold
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 50_000, price: 75710, quoteQty: 100 }, null);
    mgr.onTick("BTCUSDT", PCTX, [], 75710, 100, 1000, 50_001);
    assert.ok(mgr.getLifecycle("BTCUSDT") !== null, "sanity: alive right after the meaningful extension");
    mgr.onTick("BTCUSDT", PCTX, [], 75710, 100, 1000, 50_001 + 59_000);
    assert.ok(mgr.getLifecycle("BTCUSDT") !== null, "meaningful adverse displacement must extend the episode's life by refreshing the checkpoint");
  });

  await scenario("MP.5. continuing OI destruction progress can keep a genuinely active episode alive", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75700, quoteQty: 500000 }, { quantity: 100000, timestamp: 0 });
    // no new liquidation and no new extreme, but OI keeps destructing materially (>2% of starting OI per step)
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 50_000, price: 75700, quoteQty: 1 }, { quantity: 95000, timestamp: 50_000 }); // -5% of starting OI
    mgr.onTick("BTCUSDT", PCTX, [], 75700, 100, 1000, 50_001);
    assert.ok(mgr.getLifecycle("BTCUSDT") !== null, "sanity");
    mgr.onTick("BTCUSDT", PCTX, [], 75700, 100, 1000, 50_001 + 59_000);
    assert.ok(mgr.getLifecycle("BTCUSDT") !== null, "continuing meaningful OI destruction alone must be able to keep a genuinely active episode alive");
  });

  await scenario("MP.6. once flow/progress dies, a later same-side liquidation starts a NEW episode, not an accumulation into the ancient one", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75700, quoteQty: 500000 }, null);
    mgr.onTick("BTCUSDT", PCTX, [], 75700, 100, 1000, 61_000);
    assert.strictEqual(mgr.getLifecycle("BTCUSDT"), null, "the ancient episode must be dead");
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 3 * 3_600_000, price: 76000, quoteQty: 90000 }, null);
    const lc = mgr.getLifecycle("BTCUSDT")!;
    assert.strictEqual(lc.episode.eventCount, 1, "must be a fresh episode -- eventCount=1, not accumulated onto the dead one");
    assert.strictEqual(lc.episode.sameDirectionLiqUsd, 90000);
  });

  await scenario("MP.7. once released, an opposite-side liquidation can immediately start a new episode", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75700, quoteQty: 500000 }, null);
    mgr.onTick("BTCUSDT", PCTX, [], 75700, 100, 1000, 61_000);
    assert.strictEqual(mgr.getLifecycle("BTCUSDT"), null);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "LONG", timestamp: 61_500, price: 75200, quoteQty: 2527386 }, null);
    const lc = mgr.getLifecycle("BTCUSDT")!;
    assert.strictEqual(lc.episode.victim, "LONG", "reproduces the real $2.53M cascade -- must be evaluated as its own fresh episode, immediately");
    assert.strictEqual(lc.episode.sameDirectionLiqUsd, 2527386);
  });

  await scenario("MP.8. transient lack of progress does not prematurely kill a valid active burst", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75700, quoteQty: 500000 }, null);
    mgr.onTick("BTCUSDT", PCTX, [], 75700, 100, 1000, 30_000); // 30s gap, well under 60s -- must not die
    assert.ok(mgr.getLifecycle("BTCUSDT") !== null);
  });

  await scenario("MP.9. hard failsafe still works as a final safety valve even with meaningful-progress tracking active", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, preEntryFailsafeMaxLifetimeMs: 100_000, noProgressTimeoutMs: 999_999_999 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75700, quoteQty: 500000 }, null);
    // keep MEANINGFULLY progressing (large liquidations) so noProgressTimeoutMs (disabled here anyway) would never fire --
    // the FAILSAFE must still cap total lifetime regardless.
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 90_000, price: 75800, quoteQty: 400000 }, null);
    mgr.onTick("BTCUSDT", PCTX, [], 75800, 100, 1000, 150_000);
    assert.strictEqual(mgr.getLifecycle("BTCUSDT"), null, "FAILSAFE must fire regardless of meaningful progress once the absolute cap is exceeded");
    assert.ok(mgr.getNoSignalLog().some((n) => n.reasonCode === "PRE_ENTRY_FAILSAFE_MAX_LIFETIME"));
  });

  await scenario("MP.10. ACTIVE real positions are completely unaffected by all pre-entry death logic, meaningful-progress fix included", async () => {
    const { mongo } = fakeMongo();
    const rest = mockRestSuccess();
    const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, new LiquidationOiGlobalSignalRepository(mongo), new StrategyOrderRepository(mongo), () => [{ userId: "karo", riskUsd: 1, liquidationOiExecutionEnabled: true, binanceRest: rest, telegram: null }], true, true);
    await driveToEntryReady(orch, "SOLUSDT", 7_000_000);
    assert.strictEqual(orch.getWatchManager().getLifecycle("SOLUSDT")!.globalState, "ACTIVE");
    await orch.onTick("SOLUSDT", PCTX, [], 100, 1.0, 1000, 7_000_000 + 6 * 3_600_000);
    assert.strictEqual(orch.getWatchManager().getLifecycle("SOLUSDT")!.globalState, "ACTIVE");
  });

  await scenario("MP.11. no symbol can remain indefinitely owned in any non-ACTIVE theoretical state (direct proof across all three checkpoints)", () => {
    const config = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, noProgressTimeoutMs: 60_000 };
    const mgr = new LiquidationOiWatchManager(config);
    mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: 0, price: 75700, quoteQty: 500000 }, { quantity: 100000, timestamp: 0 });
    // simulate the real BTC pattern: sporadic tiny same-direction noise for hours, none of it meaningful
    let t = 0;
    let deathCount = 0;
    for (let i = 0; i < 50; i++) {
      t += 12 * 60_000; // every 12 minutes -- exceeds noProgressTimeoutMs=60s on its own, so each iteration either
      // kills the previous episode (gap since its own last checkpoint) or, if it was just (re)created, survives
      // this one tick but will die on the NEXT big gap -- either way, no episode can persist indefinitely.
      const before = mgr.getLifecycle("BTCUSDT");
      mgr.onLiquidationEvent({ symbol: "BTCUSDT", victim: "SHORT", timestamp: t, price: 75700 + (i % 2), quoteQty: 80 }, { quantity: 99999, timestamp: t });
      mgr.onTick("BTCUSDT", PCTX, [], 75700, 100, 1000, t + 1);
      if (before !== null && mgr.getLifecycle("BTCUSDT") === null) deathCount++;
    }
    assert.ok(deathCount >= 20, `expected the pure-noise episode to die repeatedly across the ~${(t / 3_600_000).toFixed(1)}h window (got ${deathCount} deaths) -- proving no single noisy episode persisted indefinitely`);
    // one final large gap confirms the CURRENT (possibly just-recreated) episode also cannot persist
    mgr.onTick("BTCUSDT", PCTX, [], 75700, 100, 1000, t + 1 + 61_000);
    assert.strictEqual(mgr.getLifecycle("BTCUSDT"), null, "the final live episode must also die once its own noProgressTimeoutMs elapses -- nothing here is exempt");
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();