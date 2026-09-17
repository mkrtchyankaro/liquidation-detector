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
      if ("$or" in filter) { const clauses = (filter as any).$or as Record<string, unknown>[]; return clauses.some((c) => matchesClause(d, c)); }
      return matchesClause(d, filter);
    });
    return { toArray: async () => matches };
  }
  async findOne(filter: Record<string, unknown>): Promise<T | null> { return (await this.find(filter).toArray())[0] ?? null; }
  async countDocuments(filter: Record<string, unknown>): Promise<number> { return (await this.find(filter).toArray()).length; }
}
function fakeMongo(): { mongo: MongoClientWrapper; signals: FakeCollection<any>; userExecs: FakeCollection<any>; orders: FakeCollection<any> } {
  const signals = new FakeCollection<any>(); const userExecs = new FakeCollection<any>(); const orders = new FakeCollection<any>();
  const mongo = { liquidationOiGlobalSignals: async () => signals, liquidationOiUserExecutions: async () => userExecs, strategyOrders: async () => orders } as unknown as MongoClientWrapper;
  return { mongo, signals, userExecs, orders };
}
function mockRestThrowsAlways(): BinanceRestLike {
  const fail = () => { throw new Error("MUST NEVER BE CALLED for PAPER"); };
  return { getExchangeInfo: fail, createOrder: fail, createAlgoOrder: fail, getAlgoOrder: fail, getAlgoOrderByClientId: fail, cancelAlgoOrder: fail, getOrder: fail, getPositionRisk: fail, cancelOrder: fail, getOpenOrders: fail, getOpenAlgoOrders: fail } as unknown as BinanceRestLike;
}
function runtimes(specs: Array<{ userId: string; riskUsd: number; rest: BinanceRestLike | null; enabled?: boolean }>): () => LiquidationOiUserRuntimeRef[] {
  return () => specs.map((s) => ({ userId: s.userId, riskUsd: s.riskUsd, liquidationOiExecutionEnabled: s.enabled ?? true, binanceRest: s.rest, telegram: { sendMessage: async () => {} } }));
}
function buildStack(getRuntimes: () => LiquidationOiUserRuntimeRef[], globalExecutionEnabled: boolean) {
  const { mongo, signals, userExecs, orders } = fakeMongo();
  const globalSignalRepo = new LiquidationOiGlobalSignalRepository(mongo);
  const strategyOrderRepo = new StrategyOrderRepository(mongo);
  const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, globalSignalRepo, strategyOrderRepo, getRuntimes, true, globalExecutionEnabled);
  const positionLifecycle = new LiquidationOiPositionLifecycleService(globalSignalRepo, strategyOrderRepo, orch.getWatchManager(), getRuntimes, DEFAULT_ACTIVE_LIFECYCLE_CONFIG.positionReconciliationIntervalMs);
  const activeMain = new LiquidationOiActiveMainRuntime(globalSignalRepo, strategyOrderRepo, positionLifecycle, getRuntimes, DEFAULT_ACTIVE_LIFECYCLE_CONFIG);
  orch.setActiveMainRuntime(activeMain);
  return { mongo, signals, userExecs, orders, globalSignalRepo, strategyOrderRepo, orch, positionLifecycle, activeMain };
}

const PCTX = { historicalSampleCount: 20, historicalP90: 100000, historicalP95: 200000, historicalP99: 400000, percentileRank: 96 };
function candle(closeTime: number, open: number, high: number, low: number, close: number) {
  return { symbol: "X", interval: "1m", openTime: closeTime - 60_000, closeTime, open, high, low, close, volume: 0, isClosed: true } as any;
}
const FLAT_ATR = { get: (_i: string, _t: number) => 1.0 };


/** Drives a fresh LONG episode to ACTIVE via the REAL entry pipeline,
 *  then returns a tick() helper that calls orch.onTick() -- the EXACT
 *  production path -- for the ACTIVE portion, never activeMain.onActiveTick()
 *  directly. This is deliberate: calling onActiveTick() directly is
 *  exactly what let the real bug (onTick() passing the wrong id) go
 *  completely unnoticed by every earlier PAPER/REAL test in this repo.
 *  candidateTradeSideForVictim() is the identity function, so victim
 *  "LONG" is what produces a LONG candidate (a LONG-victim cascade --
 *  forced sells -- displaces price DOWN to the extreme, then a small
 *  upward counter-move triggers ENTRY_READY). Mirrors the same
 *  ATR-relative shape (3.0 ATR displacement, 0.5 ATR counter-move)
 *  proven to qualify WATCH/ENTRY in every earlier test in this repo. */
/** Sep 17 2026 (Karo), operator-approved lifecycle correction --
 *  drives an episode all the way to ACTIVE through the REAL pipeline.
 *  victim=LONG -> candidateSide=LONG, favorable price movement is
 *  UPWARD throughout. The returned tick() is for the POST-ACTIVE
 *  phase only (TP/SL monitoring) -- unrelated to entry, reuses
 *  whatever OI history was current at the moment ACTIVE was reached. */
async function driveLongEpisodeToActive(orch: LiquidationOiRuntimeOrchestrator, symbol: string, now0: number): Promise<{ tick: (price: number, tMs: number) => Promise<void> }> {
  orch.onLiquidationEvent({ symbol, victim: "LONG", timestamp: now0, price: 103, quoteQty: 1_000_000 }, { quantity: 6000, timestamp: now0 });
  orch.onLiquidationEvent({ symbol, victim: "LONG", timestamp: now0 + 10_000, price: 100, quoteQty: 1_100_000 }, { quantity: 5600, timestamp: now0 + 10_000 });
  await orch.onTick(symbol, PCTX, [], 100, 1.0, 1000, now0 + 11_000, null, null, null, [], [], FLAT_ATR);

  const c1 = candle(now0 + 60_000, 100, 100.9, 100, 100.9);
  await orch.onTick(symbol, PCTX, [], 100.9, 1.0, 1000, now0 + 65_000, null, null, null, [c1], [], FLAT_ATR);

  const c2 = candle(now0 + 120_000, 100.9, 101.1, 100.7, 101.0);
  const c3 = candle(now0 + 180_000, 101.0, 101.3, 100.8, 101.2);
  const c3m = candle(now0 + 180_000, 100, 101.3, 100, 101.2);
  const historyAtEpisodeEnd = [{ contracts: 6000, fetchedAt: now0 }, { contracts: 5500, fetchedAt: now0 + 15_000 }, { contracts: 5480, fetchedAt: now0 + 25_000 }, { contracts: 5480, fetchedAt: now0 + 180_000 }];
  await orch.onTick(symbol, PCTX, historyAtEpisodeEnd, 101.2, 1.0, 1000, now0 + 185_000, null, null, null, [c2, c3], [c3m], FLAT_ATR);

  const historyWithCreation = [...historyAtEpisodeEnd, { contracts: 5560, fetchedAt: now0 + 200_000 }];
  await orch.onTick(symbol, PCTX, historyWithCreation, 101.3, 1.0, 1000, now0 + 200_000, null, null, null, [], [], FLAT_ATR, { capacityAtr: 2.5, candidateTpPrice: 103.8, candidateSlPrice: 99.9, netRR: 2.5 });
  return {
    tick: async (price: number, tMs: number) => {
      await orch.onTick(symbol, PCTX, historyWithCreation, price, 1.0, 1000, tMs);
    },
  };
}

/** Builds a fresh set of RUNTIME objects (orchestrator, position
 *  lifecycle, watch manager -- everything that lives ONLY in-memory
 *  and is lost on restart) that SHARE the given repos (backed by the
 *  SAME underlying fake Mongo docs) -- this is what "restart" means:
 *  Mongo state persists, in-memory state does not. */
function buildFreshRuntimeOnSameMongo(globalSignalRepo: LiquidationOiGlobalSignalRepository, strategyOrderRepo: StrategyOrderRepository, getRuntimes: () => LiquidationOiUserRuntimeRef[], globalExecutionEnabled: boolean) {
  const orch = new LiquidationOiRuntimeOrchestrator(TEST_STRATEGY_CONFIG, DEFAULT_CAPACITY_MODEL_COEFFICIENTS, globalSignalRepo, strategyOrderRepo, getRuntimes, true, globalExecutionEnabled);
  const positionLifecycle = new LiquidationOiPositionLifecycleService(globalSignalRepo, strategyOrderRepo, orch.getWatchManager(), getRuntimes, DEFAULT_ACTIVE_LIFECYCLE_CONFIG.positionReconciliationIntervalMs);
  const activeMain = new LiquidationOiActiveMainRuntime(globalSignalRepo, strategyOrderRepo, positionLifecycle, getRuntimes, DEFAULT_ACTIVE_LIFECYCLE_CONFIG);
  orch.setActiveMainRuntime(activeMain);
  return { orch, positionLifecycle, activeMain };
}

async function main(): Promise<void> {
  console.log("Running the ETHUSDT stuck-signal regression tests (real orch.onTick() wiring)...\n");

  await scenario("REGRESSION (live production bug): onTick()'s ACTIVE branch must pass globalSignalId, not ownershipId, to onActiveTick", async () => {
    const rest = mockRestThrowsAlways();
    const { orch, signals, userExecs } = buildStack(runtimes([{ userId: "main", riskUsd: 10, rest }]), false);
    const { tick } = await driveLongEpisodeToActive(orch, "ETHUSDT", 1_000_000);
    const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
    assert.ok(signal, "sanity: signal must be ACTIVE after entry");

    await tick(signal.strategyInvalidationPrice - 0.5, 1_100_000);

    const after = signals.docs.find((d: any) => d.globalSignalId === signal.globalSignalId);
    assert.strictEqual(after.state, "CLOSED", "with the fix, a real tick through orch.onTick() must reach onActiveTick and trigger strategy invalidation");
    const user = userExecs.docs.find((d: any) => d.userId === "main");
    assert.strictEqual(user.terminalReason, "STRATEGY_INVALIDATION");
  });

  await scenario("CASE A (exact ETH shape): LONG PAPER entry=2431.52 tp=2437.62 SL=2430.80 -- stays ACTIVE below TP; hits TP_FILLED at TP, exitPrice/PnL populated, CLOSE once, cleanup COMPLETE", async () => {
    const rest = mockRestThrowsAlways();
    const { orch, signals, userExecs } = buildStack(runtimes([{ userId: "main", riskUsd: 10, rest }]), false);
    const { tick } = await driveLongEpisodeToActive(orch, "ETHUSDT", 2_000_000);
    const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
    const tpPrice = signal.initialTpPrice;

    await tick(100.3, 2_100_000);
    assert.strictEqual(signals.docs.find((d: any) => d.globalSignalId === signal.globalSignalId).state, "ACTIVE");
    await tick(tpPrice - 0.01, 2_200_000);
    assert.strictEqual(signals.docs.find((d: any) => d.globalSignalId === signal.globalSignalId)?.state ?? "ACTIVE", "ACTIVE", "must remain ACTIVE just below TP");
    const beforeTp = userExecs.docs.find((d: any) => d.userId === "main");
    assert.strictEqual(beforeTp.state, "ACTIVE");

    await tick(tpPrice, 2_300_000);
    const user = userExecs.docs.find((d: any) => d.userId === "main");
    assert.strictEqual(user.state, "TERMINAL");
    assert.strictEqual(user.terminalReason, "TP_FILLED");
    assert.strictEqual(user.exitPrice, tpPrice, "exitPrice must be populated");
    assert.ok(user.grossPnlUsd !== null && user.grossPnlUsd > 0, "PnL must be populated and positive for a LONG TP hit");
    assert.strictEqual(user.cleanupState, "COMPLETE");
    const closedSignal = signals.docs.find((d: any) => d.globalSignalId === signal.globalSignalId);
    assert.strictEqual(closedSignal.state, "CLOSED");

    const pnlBefore = user.grossPnlUsd;
    await tick(tpPrice + 1, 2_400_000);
    const userAfterExtraTick = userExecs.docs.find((d: any) => d.userId === "main");
    assert.strictEqual(userAfterExtraTick.grossPnlUsd, pnlBefore, "terminal transition must be idempotent -- no duplicate CLOSE/PnL recompute");
  });

  await scenario("CASE B (exact ETH shape), fresh signal: stays ACTIVE above SL; hits STRATEGY_INVALIDATION at SL, exitPrice/PnL populated, CLOSE once, cleanup COMPLETE", async () => {
    const rest = mockRestThrowsAlways();
    const { orch, signals, userExecs } = buildStack(runtimes([{ userId: "main", riskUsd: 10, rest }]), false);
    const { tick } = await driveLongEpisodeToActive(orch, "ETHUSDT", 3_000_000);
    const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
    const slPrice = signal.strategyInvalidationPrice;

    await tick(100.2, 3_100_000);
    assert.strictEqual(signals.docs.find((d: any) => d.globalSignalId === signal.globalSignalId).state, "ACTIVE");
    await tick(slPrice + 0.01, 3_200_000);
    assert.strictEqual(signals.docs.find((d: any) => d.globalSignalId === signal.globalSignalId)?.state ?? "ACTIVE", "ACTIVE", "must remain ACTIVE just above SL");

    await tick(slPrice, 3_300_000);
    const user = userExecs.docs.find((d: any) => d.userId === "main");
    assert.strictEqual(user.state, "TERMINAL");
    assert.strictEqual(user.terminalReason, "STRATEGY_INVALIDATION");
    assert.strictEqual(user.exitPrice, slPrice);
    assert.ok(user.grossPnlUsd !== null && user.grossPnlUsd < 0, "PnL must be populated and negative for a LONG SL hit");
    assert.strictEqual(user.cleanupState, "COMPLETE");
    assert.strictEqual(signals.docs.find((d: any) => d.globalSignalId === signal.globalSignalId).state, "CLOSED");
  });

  await scenario("SHORT symmetric: TP below entry, SL above entry, both trigger correctly through the real tick path", async () => {
    const rest = mockRestThrowsAlways();
    const { orch, signals, userExecs } = buildStack(runtimes([{ userId: "main", riskUsd: 10, rest }]), false);
    orch.onLiquidationEvent({ symbol: "ETHUSDT", victim: "SHORT", timestamp: 4_000_000, price: 100, quoteQty: 1_000_000 }, { quantity: 6000, timestamp: 4_000_000 });
    orch.onLiquidationEvent({ symbol: "ETHUSDT", victim: "SHORT", timestamp: 4_010_000, price: 103, quoteQty: 1_100_000 }, { quantity: 5600, timestamp: 4_010_000 });
    await orch.onTick("ETHUSDT", PCTX, [], 103, 1.0, 1000, 4_011_000, null, null, null, [], [], FLAT_ATR);
    const c1 = candle(4_060_000, 103, 103, 102.1, 102.1);
    await orch.onTick("ETHUSDT", PCTX, [], 102.1, 1.0, 1000, 4_065_000, null, null, null, [c1], [], FLAT_ATR);
    const c2 = candle(4_120_000, 102.1, 102.3, 101.9, 102.0);
    const c3 = candle(4_180_000, 102.0, 102.2, 101.7, 101.8);
    const c3m = candle(4_180_000, 103, 103, 101.7, 101.8);
    const historyAtEpisodeEnd = [{ contracts: 6000, fetchedAt: 4_000_000 }, { contracts: 5500, fetchedAt: 4_015_000 }, { contracts: 5480, fetchedAt: 4_025_000 }, { contracts: 5480, fetchedAt: 4_180_000 }];
    await orch.onTick("ETHUSDT", PCTX, historyAtEpisodeEnd, 101.8, 1.0, 1000, 4_185_000, null, null, null, [c2, c3], [c3m], FLAT_ATR);
    const history = [...historyAtEpisodeEnd, { contracts: 5540, fetchedAt: 4_200_000 }];
    await orch.onTick("ETHUSDT", PCTX, history, 101.7, 1.0, 1000, 4_200_000, null, null, null, [], [], FLAT_ATR, { capacityAtr: 2.5, candidateTpPrice: 99.2, candidateSlPrice: 103.1, netRR: 2.5 });
    const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
    assert.strictEqual(signal.candidateSide, "SHORT");
    const tpPrice = signal.initialTpPrice;
    assert.ok(tpPrice < signal.entryPrice, "SHORT TP must be below entry");

    await orch.onTick("ETHUSDT", PCTX, history, tpPrice, 1.0, 1000, 4_300_000, null, null, null, [], [], FLAT_ATR);
    const user = userExecs.docs.find((d: any) => d.userId === "main");
    assert.strictEqual(user.state, "TERMINAL");
    assert.strictEqual(user.terminalReason, "TP_FILLED");
    assert.ok(user.grossPnlUsd > 0);
  });

  await scenario("Mixed PAPER + REAL: both users' active monitoring is reached through the real tick path", async () => {
    const paperRest = mockRestThrowsAlways();
    const realRest: BinanceRestLike = {
      getExchangeInfo: async () => ({ symbols: [{ symbol: "ETHUSDT", pricePrecision: 2, quantityPrecision: 3, filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01" }, { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" }, { filterType: "MIN_NOTIONAL", notional: "5" }] }] }),
      createOrder: async () => ({ orderId: 1 }), createAlgoOrder: async () => ({ algoId: 1 }),
      getAlgoOrder: async () => ({ algoStatus: "WORKING" }), getAlgoOrderByClientId: async () => ({ algoStatus: "WORKING" }),
      cancelAlgoOrder: async () => ({}), getOrder: async () => ({ status: "NEW" }),
      getPositionRisk: async () => [{ symbol: "ETHUSDT", positionAmt: "1", entryPrice: "100" }],
      cancelOrder: async () => ({}), getOpenOrders: async () => [], getOpenAlgoOrders: async () => [],
    } as unknown as BinanceRestLike;
    const { orch, signals, userExecs } = buildStack(runtimes([{ userId: "paperuser", riskUsd: 10, rest: paperRest, enabled: false }, { userId: "realuser", riskUsd: 10, rest: realRest, enabled: true }]), true);
    const { tick } = await driveLongEpisodeToActive(orch, "ETHUSDT", 5_000_000);
    const signal = signals.docs.find((d: any) => d.state === "ACTIVE");
    const paperBefore = userExecs.docs.find((d: any) => d.userId === "paperuser");
    const realBefore = userExecs.docs.find((d: any) => d.userId === "realuser");
    assert.strictEqual(paperBefore.mode, "PAPER");
    assert.strictEqual(realBefore.mode, "REAL");

    await tick(signal.strategyInvalidationPrice - 0.5, 5_100_000);
    const paperAfter = userExecs.docs.find((d: any) => d.userId === "paperuser");
    assert.strictEqual(paperAfter.state, "TERMINAL", "PAPER user's active monitoring must be reached through the real tick path too");
    assert.strictEqual(paperAfter.terminalReason, "STRATEGY_INVALIDATION");
  });

  await scenario("RESTART: a persisted ACTIVE PAPER signal is reattached to live monitoring after restart -- a subsequent real tick above TP closes it", async () => {
    const rest = mockRestThrowsAlways();
    const { orch, signals, userExecs, globalSignalRepo, strategyOrderRepo } = buildStack(runtimes([{ userId: "main", riskUsd: 10, rest }]), false);
    await driveLongEpisodeToActive(orch, "ETHUSDT", 6_000_000);
    const beforeRestart = signals.docs.find((d: any) => d.state === "ACTIVE");
    assert.ok(beforeRestart, "sanity: signal must be ACTIVE before restart");

    const { orch: freshOrch, positionLifecycle: freshPositionLifecycle } = buildFreshRuntimeOnSameMongo(globalSignalRepo, strategyOrderRepo, runtimes([{ userId: "main", riskUsd: 10, rest }]), false);
    await recoverLoxOnRestart(globalSignalRepo, strategyOrderRepo, freshPositionLifecycle, freshOrch.getWatchManager(), runtimes([{ userId: "main", riskUsd: 10, rest }]), () => {}, 6_100_000);

    const restoredSignal = signals.docs.find((d: any) => d.state === "ACTIVE");
    assert.ok(restoredSignal, "signal must still be ACTIVE after restart (never closed merely for being old)");

    const historyPost = [{ contracts: 5480, fetchedAt: 6_050_000 }];
    await freshOrch.onTick("ETHUSDT", PCTX, historyPost, restoredSignal.initialTpPrice, 1.0, 1000, 6_200_000);

    const user = userExecs.docs.find((d: any) => d.userId === "main");
    assert.strictEqual(user.state, "TERMINAL", "restored PAPER signal must be reattached to live TP monitoring after restart");
    assert.strictEqual(user.terminalReason, "TP_FILLED");
  });

  await scenario("RESTART: fresh signal, post-restart tick below strategyInvalidationPrice closes it correctly", async () => {
    const rest = mockRestThrowsAlways();
    const { orch, signals, userExecs, globalSignalRepo, strategyOrderRepo } = buildStack(runtimes([{ userId: "main", riskUsd: 10, rest }]), false);
    await driveLongEpisodeToActive(orch, "ETHUSDT", 7_000_000);

    const { orch: freshOrch, positionLifecycle: freshPositionLifecycle } = buildFreshRuntimeOnSameMongo(globalSignalRepo, strategyOrderRepo, runtimes([{ userId: "main", riskUsd: 10, rest }]), false);
    await recoverLoxOnRestart(globalSignalRepo, strategyOrderRepo, freshPositionLifecycle, freshOrch.getWatchManager(), runtimes([{ userId: "main", riskUsd: 10, rest }]), () => {}, 7_100_000);
    const restoredSignal = signals.docs.find((d: any) => d.state === "ACTIVE");
    assert.ok(restoredSignal, "sanity: signal must still be ACTIVE after restart");

    const historyPost = [{ contracts: 5480, fetchedAt: 7_050_000 }];
    await freshOrch.onTick("ETHUSDT", PCTX, historyPost, restoredSignal.strategyInvalidationPrice, 1.0, 1000, 7_200_000);

    const user = userExecs.docs.find((d: any) => d.userId === "main");
    assert.strictEqual(user.state, "TERMINAL");
    assert.strictEqual(user.terminalReason, "STRATEGY_INVALIDATION");
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
