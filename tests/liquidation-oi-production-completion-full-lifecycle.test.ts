import * as assert from "assert";
import { LiquidationOiGlobalSignalRepository } from "../src/infrastructure/mongo/liquidation-oi-global-signal.repository";
import { StrategyOrderRepository } from "../src/infrastructure/mongo/strategy-order.repository";
import { LiquidationOiRuntimeOrchestrator, type LiquidationOiUserRuntimeRef } from "../src/services/liquidation-oi-runtime-orchestrator";
import { LiquidationOiPositionLifecycleService } from "../src/services/liquidation-oi-position-lifecycle.service";
import { LiquidationOiActiveMainRuntime } from "../src/services/liquidation-oi-active-main-runtime.service";
import { recoverLoxOnRestart } from "../src/services/liquidation-oi-restart-recovery";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "../src/domain/liquidation-oi-strategy/config";
const TEST_STRATEGY_CONFIG = { ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG, maxDistanceFromExtremeAtrForEntry: 2.0 };
import { DEFAULT_CAPACITY_MODEL_COEFFICIENTS } from "../src/domain/liquidation-oi-strategy/initial-capacity-model";
import { DEFAULT_ACTIVE_LIFECYCLE_CONFIG } from "../src/domain/liquidation-oi-strategy/active-lifecycle-config";
import type { BinanceRestLike } from "../src/infrastructure/binance/liquidation-oi-user-execution.service";
import type { MongoClientWrapper } from "../src/infrastructure/mongo/mongo.client";

let passed = 0, failed = 0;
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
    const matchesClause = (d: T, clause: Record<string, unknown>): boolean => Object.entries(clause).every(([k, v]) => {
      const dv = (d as Record<string, unknown>)[k];
      if (v && typeof v === "object" && "$in" in (v as any)) return (v as any).$in.includes(dv);
      if (v && typeof v === "object" && "$nin" in (v as any)) return !(v as any).$nin.includes(dv);
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

interface MockRestOpts { failGetOpenOrders?: boolean }
function mockRest(opts: MockRestOpts = {}): BinanceRestLike & { calls: string[]; positionAmt: string; tpStatus: string; stopStatus: string } {
  const calls: string[] = []; let algoId = 1, orderId = 1;
  const state = { positionAmt: "10", tpStatus: "NEW", stopStatus: "WORKING" }; // entry verification requires "NEW"/"WORKING"; flip to terminal statuses AFTER entry, before reconciliation, to simulate a later fill
  return {
    calls,
    get positionAmt() { return state.positionAmt; },
    set positionAmt(v: string) { state.positionAmt = v; },
    get tpStatus() { return state.tpStatus; },
    set tpStatus(v: string) { state.tpStatus = v; },
    get stopStatus() { return state.stopStatus; },
    set stopStatus(v: string) { state.stopStatus = v; },
    getExchangeInfo: async () => { calls.push("getExchangeInfo"); return EXCHANGE_INFO; },
    createOrder: async (p: any) => { calls.push(`createOrder:${p.type}:${p.side}`); return { orderId: orderId++ }; },
    createAlgoOrder: async (p: any) => { calls.push(`createAlgoOrder:${p.type}`); return { algoId: algoId++ }; },
    getAlgoOrder: async () => ({ algoStatus: state.stopStatus }),
    getAlgoOrderByClientId: async () => ({ algoStatus: state.stopStatus }),
    cancelAlgoOrder: async () => { calls.push("cancelAlgoOrder"); return {}; },
    getOrder: async () => ({ status: state.tpStatus }),
    getPositionRisk: async () => [{ symbol: "SOLUSDT", positionAmt: state.positionAmt, entryPrice: "98" }],
    cancelOrder: async () => { calls.push("cancelOrder"); return {}; },
    getOpenOrders: async () => { calls.push("getOpenOrders"); if (opts.failGetOpenOrders) throw new Error("simulated API failure"); return []; },
    getOpenAlgoOrders: async () => { calls.push("getOpenAlgoOrders"); return []; },
  } as unknown as BinanceRestLike & { calls: string[]; positionAmt: string; tpStatus: string; stopStatus: string };
}

function runtimes(specs: Array<{ userId: string; riskUsd: number; rest: BinanceRestLike | null; enabled?: boolean }>): () => LiquidationOiUserRuntimeRef[] {
  return () => specs.map((s) => ({ userId: s.userId, riskUsd: s.riskUsd, liquidationOiExecutionEnabled: s.enabled ?? true, binanceRest: s.rest, telegram: { sendMessage: async () => {} } }));
}

function buildStack(getRuntimes: () => LiquidationOiUserRuntimeRef[]) {
  const { mongo, signals, userExecs, orders } = fakeMongo();
  const globalSignalRepo = new LiquidationOiGlobalSignalRepository(mongo);
  const strategyOrderRepo = new StrategyOrderRepository(mongo);
  const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, globalSignalRepo, strategyOrderRepo, getRuntimes, true, true);
  const positionLifecycle = new LiquidationOiPositionLifecycleService(globalSignalRepo, strategyOrderRepo, orch.getWatchManager(), getRuntimes, DEFAULT_ACTIVE_LIFECYCLE_CONFIG.positionReconciliationIntervalMs);
  const activeMain = new LiquidationOiActiveMainRuntime(globalSignalRepo, strategyOrderRepo, positionLifecycle, getRuntimes, DEFAULT_ACTIVE_LIFECYCLE_CONFIG);
  orch.setActiveMainRuntime(activeMain);
  return { mongo, signals, userExecs, orders, globalSignalRepo, strategyOrderRepo, orch, positionLifecycle, activeMain };
}

/** Sep 17 2026 (Karo), operator-approved lifecycle correction --
 *  drives an episode all the way to ACTIVE through the REAL, new
 *  pipeline (episode -> causal candle-confirmed episode end -> WAIT
 *  for post-episode OI creation -> ENTRY_READY -> ACTIVE), never
 *  bypassing it. victim=SHORT -> candidateSide=SHORT (identity
 *  mapping), so favorable price movement is DOWNWARD throughout. */
async function driveToActive(orch: LiquidationOiRuntimeOrchestrator, symbol: string, now0: number): Promise<void> {
  orch.onLiquidationEvent({ symbol, victim: "SHORT", timestamp: now0, price: 100, quoteQty: 500000 }, { quantity: 5000, timestamp: now0 });
  orch.onLiquidationEvent({ symbol, victim: "SHORT", timestamp: now0 + 10_000, price: 103, quoteQty: 300000 }, { quantity: 4700, timestamp: now0 + 10_000 });
  await orch.onTick(symbol, PCTX, [], 103, 1.0, 1000, now0 + 11_000, null, null, null, [], [], FLAT_ATR);

  // 1m recovery candidate: SHORT favorable = price falling, >=0.75 ATR down from extreme(103).
  const c1 = candle(now0 + 60_000, 103, 103, 102.1, 102.1);
  await orch.onTick(symbol, PCTX, [], 102.1, 1.0, 1000, now0 + 65_000, null, null, null, [c1], [], FLAT_ATR);

  // Two more 1m candles (no new adverse extreme) let the loop "reach" the 3m close; 3m recovery >=1.0 ATR confirms episode end.
  const c2 = candle(now0 + 120_000, 102.1, 102.3, 101.9, 102.0);
  const c3 = candle(now0 + 180_000, 102.0, 102.2, 101.7, 101.8);
  const c3m = candle(now0 + 180_000, 103, 103, 101.7, 101.8);
  const historyAtEpisodeEnd = [{ contracts: 5000, fetchedAt: now0 }, { contracts: 4600, fetchedAt: now0 + 15_000 }, { contracts: 4590, fetchedAt: now0 + 25_000 }, { contracts: 4590, fetchedAt: now0 + 180_000 }];
  await orch.onTick(symbol, PCTX, historyAtEpisodeEnd, 101.8, 1.0, 1000, now0 + 185_000, null, null, null, [c2, c3], [c3m], FLAT_ATR);

  // Now WAIT_FOR_POST_EPISODE_OI_CREATION (episodeEndOiQuantity frozen at 4590). Genuine positive
  // OI creation (+60, well above the 2%-of-destroyed threshold) + favorable price (SHORT: lower) -> ENTRY_READY -> ACTIVE.
  const historyWithCreation = [...historyAtEpisodeEnd, { contracts: 4650, fetchedAt: now0 + 200_000 }];
  await orch.onTick(symbol, PCTX, historyWithCreation, 101.7, 1.0, 1000, now0 + 200_000, null, null, null, [], [], FLAT_ATR, { capacityAtr: 2.5, candidateTpPrice: 99.2, candidateSlPrice: 103.1, netRR: 2.5 });
}

async function main(): Promise<void> {
  console.log("Running production-completion-pass-full-lifecycle tests...\n");

  await scenario("L/M.1. TP fill is detected and drives cleanup to COMPLETE", async () => {
    const rest = mockRest();
    const { orch, positionLifecycle, userExecs } = buildStack(runtimes([{ userId: "karo", riskUsd: 1, rest }]));
    await driveToActive(orch, "SOLUSDT", 1_000_000);
    let karo = userExecs.docs.find((d: any) => d.userId === "karo");
    assert.strictEqual(karo.state, "ACTIVE");
    rest.positionAmt = "0";
    rest.tpStatus = "FILLED";
    await positionLifecycle.reconcileAll(1_100_000);
    karo = userExecs.docs.find((d: any) => d.userId === "karo");
    assert.strictEqual(karo.state, "TERMINAL");
    assert.strictEqual(karo.terminalReason, "TP_FILLED");
    assert.strictEqual(karo.cleanupState, "COMPLETE");
  });

  await scenario("L/M.2. emergency stop fill is detected and drives cleanup to COMPLETE", async () => {
    const rest = mockRest();
    const { orch, positionLifecycle, userExecs } = buildStack(runtimes([{ userId: "karo", riskUsd: 1, rest }]));
    await driveToActive(orch, "SOLUSDT", 2_000_000);
    rest.positionAmt = "0";
    rest.stopStatus = "FILLED";
    await positionLifecycle.reconcileAll(2_100_000);
    const karo = userExecs.docs.find((d: any) => d.userId === "karo");
    assert.strictEqual(karo.terminalReason, "EMERGENCY_STOP");
    assert.strictEqual(karo.cleanupState, "COMPLETE");
  });

  await scenario("L/M.3. flat position with no provable cause -> POSITION_CLOSED_EXTERNALLY, never invented", async () => {
    const rest = mockRest();
    const { orch, positionLifecycle, userExecs } = buildStack(runtimes([{ userId: "karo", riskUsd: 1, rest }]));
    await driveToActive(orch, "SOLUSDT", 3_000_000);
    rest.positionAmt = "0";
    await positionLifecycle.reconcileAll(3_100_000);
    const karo = userExecs.docs.find((d: any) => d.userId === "karo");
    assert.strictEqual(karo.terminalReason, "POSITION_CLOSED_EXTERNALLY");
  });

  await scenario("M.4. cleanup API failure -> FAILED_RETRYING, then a later retry succeeds -> COMPLETE, global never closes on the failed attempt", async () => {
    const rest = mockRest({ failGetOpenOrders: true });
    const { orch, positionLifecycle, userExecs, signals } = buildStack(runtimes([{ userId: "karo", riskUsd: 1, rest }]));
    await driveToActive(orch, "SOLUSDT", 4_000_000);
    rest.positionAmt = "0";
    rest.tpStatus = "FILLED";
    await positionLifecycle.reconcileAll(4_100_000);
    let karo = userExecs.docs.find((d: any) => d.userId === "karo");
    assert.strictEqual(karo.cleanupState, "FAILED_RETRYING");
    assert.ok(karo.cleanupFailureReason);
    let active = signals.docs.find((d: any) => d.state === "ACTIVE");
    assert.ok(active, "global must NOT close while cleanup is FAILED_RETRYING");

    (rest as any).getOpenOrders = async () => [];
    await positionLifecycle.reconcileAll(4_200_000);
    karo = userExecs.docs.find((d: any) => d.userId === "karo");
    assert.strictEqual(karo.cleanupState, "COMPLETE");
    const closed = signals.docs.find((d: any) => d.state === "CLOSED");
    assert.ok(closed, "global must close once the retry succeeds and no other blocker remains");
  });

  await scenario("O.1. Karo closes while Artak remains ACTIVE -- global stays open, symbol stays owned; Artak closing later closes the global and releases the symbol", async () => {
    const karoRest = mockRest();
    const artakRest = mockRest();
    const { orch, positionLifecycle, userExecs, signals } = buildStack(runtimes([{ userId: "karo", riskUsd: 1, rest: karoRest }, { userId: "artak", riskUsd: 5, rest: artakRest }]));
    await driveToActive(orch, "SOLUSDT", 5_000_000);
    karoRest.positionAmt = "0";
    karoRest.tpStatus = "FILLED";
    await positionLifecycle.reconcileAll(5_100_000);
    const karo = userExecs.docs.find((d: any) => d.userId === "karo");
    let artak = userExecs.docs.find((d: any) => d.userId === "artak");
    assert.strictEqual(karo.state, "TERMINAL");
    assert.strictEqual(karo.cleanupState, "COMPLETE");
    assert.strictEqual(artak.state, "ACTIVE");
    assert.ok(!signals.docs.some((d: any) => d.state === "CLOSED"), "global must not close while Artak remains ACTIVE");
    assert.strictEqual(orch.getWatchManager().isSymbolOwned("SOLUSDT"), true, "symbol must remain owned while Artak remains ACTIVE");

    (artakRest as any).getPositionRisk = async () => [{ symbol: "SOLUSDT", positionAmt: "0", entryPrice: "98" }];
    await positionLifecycle.reconcileAll(5_200_000);
    artak = userExecs.docs.find((d: any) => d.userId === "artak");
    assert.strictEqual(artak.state, "TERMINAL");
    assert.strictEqual(artak.cleanupState, "COMPLETE");
    assert.ok(signals.docs.some((d: any) => d.state === "CLOSED"), "global must close once BOTH users are terminal and clean");
    assert.strictEqual(orch.getWatchManager().isSymbolOwned("SOLUSDT"), false, "symbol must be released after global close");
    assert.strictEqual(orch.getWatchManager().getLifecycle("SOLUSDT"), null, "symbol must be available for a fresh episode");
  });

  await scenario("J.1. strategy invalidation breach fans out a reduce-only MARKET close to every ACTIVE user, isolated", async () => {
    const karoRest = mockRest();
    const artakRest = mockRest();
    const { orch, activeMain, signals, userExecs } = buildStack(runtimes([{ userId: "karo", riskUsd: 1, rest: karoRest }, { userId: "artak", riskUsd: 5, rest: artakRest }]));
    await driveToActive(orch, "SOLUSDT", 6_000_000);
    const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
    assert.ok(signal);
    await activeMain.onActiveTick("SOLUSDT", signal.globalSignalId, "ep-test", "SHORT", signal.strategyInvalidationPrice + 1, 4590, 1.0, 6_100_000);
    assert.ok(karoRest.calls.some((c) => c.startsWith("createOrder:MARKET")), "Karo must receive a reduce-only MARKET close");
    assert.ok(artakRest.calls.some((c) => c.startsWith("createOrder:MARKET")), "Artak must receive a reduce-only MARKET close");
    const karo = userExecs.docs.find((d: any) => d.userId === "karo");
    assert.strictEqual(karo.terminalReason, "STRATEGY_INVALIDATION");
  });

  await scenario("D.1. a single noisy adverse OI/price tick does NOT trigger MARKET_EXIT -- confirmation requires consecutive evidence", async () => {
    const rest = mockRest();
    const { orch, activeMain, signals } = buildStack(runtimes([{ userId: "karo", riskUsd: 1, rest }]));
    await driveToActive(orch, "SOLUSDT", 7_000_000);
    const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
    const callsBefore = rest.calls.length;
    await activeMain.onActiveTick("SOLUSDT", signal.globalSignalId, "ep-test", "SHORT", 102.6, 5000, 1.0, 7_010_000);
    const newCalls = rest.calls.slice(callsBefore);
    assert.ok(!newCalls.some((c) => c.startsWith("createOrder:MARKET")), "a single adverse reading must never alone trigger MARKET_EXIT");
  });

  await scenario("D.2. CONSECUTIVE confirmed-adverse readings DO trigger MARKET_EXIT with reason ADVERSE_OI_PRICE_EFFICIENCY_FLIP", async () => {
    const rest = mockRest();
    const { orch, activeMain, signals, userExecs } = buildStack(runtimes([{ userId: "karo", riskUsd: 1, rest }]));
    await driveToActive(orch, "SOLUSDT", 8_000_000);
    const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
    assert.ok(signal.strategyInvalidationPrice > 102.9, "sanity: the ramp below must stay clear of strategy invalidation so this test isolates OI-efficiency specifically");
    const callsBefore = rest.calls.length;
    let t = 8_010_000;
    let price = 102.5, oi = 4590;
    for (let i = 0; i < 5; i++) {
      price += 0.08; oi += 200; // SHORT candidate: price rising + OI rising = adverse; small enough steps to stay well clear of strategyInvalidationPrice (103.1) while each step still clears the meaningful-move threshold
      await activeMain.onActiveTick("SOLUSDT", signal.globalSignalId, "ep-test", "SHORT", price, oi, 1.0, t);
      t += DEFAULT_ACTIVE_LIFECYCLE_CONFIG.oiEfficiencyEvalIntervalMs + 100;
    }
    const newCalls = rest.calls.slice(callsBefore);
    assert.ok(newCalls.some((c) => c.startsWith("createOrder:MARKET")), "consecutive confirmed-adverse readings must eventually trigger MARKET_EXIT");
    const karo = userExecs.docs.find((d: any) => d.userId === "karo");
    assert.strictEqual(karo.terminalReason, "ADVERSE_OI_PRICE_EFFICIENCY_FLIP");
  });

  await scenario("K.1. dynamic TP revision NEVER touches the emergency stop", async () => {
    const rest = mockRest();
    const { orch, activeMain, signals } = buildStack(runtimes([{ userId: "karo", riskUsd: 1, rest }]));
    await driveToActive(orch, "SOLUSDT", 9_000_000);
    const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
    const callsBefore = rest.calls.length;
    await activeMain.onActiveTick("SOLUSDT", signal.globalSignalId, "ep-test", "SHORT", 95, 4590 * 1.05, 1.0, 9_010_000);
    const newCalls = rest.calls.slice(callsBefore);
    assert.ok(!newCalls.some((c) => c.startsWith("cancelAlgoOrder")), "emergency stop must NEVER be cancelled during a TP revision");
    assert.ok(!newCalls.some((c) => c.startsWith("createAlgoOrder")), "no new emergency stop should be placed during a plain TP revision");
  });

  await scenario("N.1. restart with DB ACTIVE but Binance flat -> reconciled to terminal + cleaned up, no duplicate entry", async () => {
    const rest = mockRest();
    const { orch, globalSignalRepo, strategyOrderRepo, positionLifecycle, userExecs, signals } = buildStack(runtimes([{ userId: "karo", riskUsd: 1, rest }]));
    await driveToActive(orch, "SOLUSDT", 10_000_000);
    const callsBeforeRestart = rest.calls.length;
    rest.positionAmt = "0";
    rest.tpStatus = "FILLED";
    await recoverLoxOnRestart(globalSignalRepo, strategyOrderRepo, positionLifecycle, orch.getWatchManager(), runtimes([{ userId: "karo", riskUsd: 1, rest }]), () => {}, 10_100_000);
    const newCalls = rest.calls.slice(callsBeforeRestart);
    assert.ok(!newCalls.some((c) => c.startsWith("createOrder:MARKET")), "restart recovery must NEVER place a fresh MARKET entry");
    const karo = userExecs.docs.find((d: any) => d.userId === "karo");
    assert.strictEqual(karo.state, "TERMINAL");
    assert.strictEqual(karo.cleanupState, "COMPLETE");
    assert.ok(signals.docs.some((d: any) => d.state === "CLOSED"));
  });

  await scenario("N.2. restart with a stuck ENTRY_READY is conservatively CANCELLED, never assumed ACTIVE", async () => {
    const { globalSignalRepo, strategyOrderRepo, positionLifecycle, orch, signals } = buildStack(runtimes([]));
    await globalSignalRepo.upsertSignal({ globalSignalId: "stuck-1", symbol: "ETHUSDT", victim: "LONG", candidateSide: "LONG", state: "ENTRY_READY", ownershipId: "own-1", episodePercentileRank: 95, sameDirectionLiqUsd: 100000, extremePrice: 2400, entryPrice: 2405, strategyInvalidationPrice: 2390, emergencyHardStopPrice: 2385, initialCapacityAtr: 1, initialTpPrice: 2420, tpRevision: 0, currentTargetPrice: 2420, orderBookAtEntryReady: null } as any);
    await recoverLoxOnRestart(globalSignalRepo, strategyOrderRepo, positionLifecycle, orch.getWatchManager(), runtimes([]), () => {}, 11_000_000);
    const stuck = signals.docs.find((d: any) => d.globalSignalId === "stuck-1");
    assert.strictEqual(stuck.state, "CANCELLED");
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

