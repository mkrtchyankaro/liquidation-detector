import * as assert from "assert";
import {
  LiquidationOiRuntimeOrchestrator,
  type LiquidationOiUserRuntimeRef,
} from "../src/services/liquidation-oi-runtime-orchestrator";
import { LiquidationOiGlobalSignalRepository } from "../src/infrastructure/mongo/liquidation-oi-global-signal.repository";
import { LiquidationOiWaitStateRepository } from "../src/infrastructure/mongo/liquidation-oi-wait-state.repository";
import { StrategyOrderRepository } from "../src/infrastructure/mongo/strategy-order.repository";
import { DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG } from "../src/domain/liquidation-oi-strategy/config";
import { DEFAULT_CAPACITY_MODEL_COEFFICIENTS } from "../src/domain/liquidation-oi-strategy/initial-capacity-model";
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
    update: { $set?: Partial<T> },
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
        ...(update.$set ?? {}),
      } as T);
    return { matchedCount: 0 };
  }
  async deleteOne(
    filter: Record<string, unknown>,
  ): Promise<{ deletedCount: number }> {
    const before = this.docs.length;
    this.docs = this.docs.filter(
      (d) =>
        !Object.entries(filter).every(
          ([k, v]) => (d as Record<string, unknown>)[k] === v,
        ),
    );
    return { deletedCount: before - this.docs.length };
  }
  find(): { toArray: () => Promise<T[]> } {
    return { toArray: async () => [...this.docs] };
  }
}

function fakeMongoWithWaitStates() {
  const signals = new FakeCollection<any>();
  const orders = new FakeCollection<any>();
  const waitStates = new FakeCollection<any>();
  const mongo = {
    liquidationOiGlobalSignals: async () => signals,
    liquidationOiUserExecutions: async () => new FakeCollection<any>(),
    strategyOrders: async () => orders,
    liquidationOiWaitStates: async () => waitStates,
  } as unknown as MongoClientWrapper;
  return { mongo, signals, orders, waitStates };
}

const TEST_STRATEGY_CONFIG = {
  ...DEFAULT_LIQUIDATION_OI_STRATEGY_CONFIG,
  maxDistanceFromExtremeAtrForEntry: 2.0,
};
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
function noRuntimes(): LiquidationOiUserRuntimeRef[] {
  return [];
}

function buildOrch(mongo: MongoClientWrapper) {
  const globalSignalRepo = new LiquidationOiGlobalSignalRepository(mongo);
  const strategyOrderRepo = new StrategyOrderRepository(mongo);
  const waitStateRepo = new LiquidationOiWaitStateRepository(mongo);
  const orch = new LiquidationOiRuntimeOrchestrator(
    TEST_STRATEGY_CONFIG,
    DEFAULT_CAPACITY_MODEL_COEFFICIENTS,
    globalSignalRepo,
    strategyOrderRepo,
    noRuntimes,
    true,
    false,
    undefined,
    () => {},
    undefined,
    undefined,
    waitStateRepo,
  );
  return { orch, waitStateRepo };
}

async function driveToWait(
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
}

async function main(): Promise<void> {
  console.log("Running LOX WAIT restart-persistence tests...\n");

  await scenario(
    "1. entering WAIT_FOR_POST_EPISODE_OI_CREATION persists a doc",
    async () => {
      const { mongo, waitStates } = fakeMongoWithWaitStates();
      const { orch } = buildOrch(mongo);
      await driveToWait(orch, "SOLUSDT", 4_000_000);
      assert.strictEqual(
        orch.getWatchManager().getLifecycle("SOLUSDT")?.globalState,
        "WAIT_FOR_POST_EPISODE_OI_CREATION",
      );
      assert.strictEqual(
        waitStates.docs.length,
        1,
        "a WAIT doc must be persisted",
      );
      assert.strictEqual(waitStates.docs[0]!.symbol, "SOLUSDT");
    },
  );

  await scenario(
    "1b. REGRESSION (Sep 18 2026, operator-reported live bug): provisional-end reopen via onLiquidationEvent() must delete the stale WAIT doc, not leave it behind",
    async () => {
      const { mongo, waitStates } = fakeMongoWithWaitStates();
      const { orch } = buildOrch(mongo);
      await driveToWait(orch, "BNBUSDT", 4_000_000);
      assert.strictEqual(
        orch.getWatchManager().getLifecycle("BNBUSDT")?.globalState,
        "WAIT_FOR_POST_EPISODE_OI_CREATION",
      );
      assert.strictEqual(
        waitStates.docs.length,
        1,
        "a WAIT doc must be persisted before the reopen",
      );

      // A fresh same-direction liquidation while WAITING must trigger the provisional-end reopen
      // (WAIT_FOR_POST_EPISODE_OI_CREATION -> EXHAUSTION_CANDIDATE) via onLiquidationEvent(), a
      // SEPARATE method from onTick() -- this is exactly the code path that previously never
      // cleared the persisted WAIT doc.
      orch.onLiquidationEvent(
        {
          symbol: "BNBUSDT",
          victim: "SHORT",
          timestamp: 4_400_000,
          price: 104,
          quoteQty: 50000,
        },
        null,
      );
      await new Promise((resolve) => setImmediate(resolve)); // let the fire-and-forget delete's microtask complete
      assert.strictEqual(
        orch.getWatchManager().getLifecycle("BNBUSDT")?.globalState,
        "EXHAUSTION_CANDIDATE",
        "the reopen itself must have occurred",
      );
      assert.strictEqual(
        waitStates.docs.length,
        0,
        "the stale WAIT doc MUST be deleted -- a restart during this window must not restore the symbol into the wrong, outdated WAIT state",
      );
    },
  );

  await scenario(
    "2. restart restores the symbol into WAIT_FOR_POST_EPISODE_OI_CREATION in a FRESH orchestrator instance, with ownership, without duplicating the episode",
    async () => {
      const { mongo, waitStates } = fakeMongoWithWaitStates();
      const { orch: orch1 } = buildOrch(mongo);
      await driveToWait(orch1, "AVAXUSDT", 4_000_000);
      const before = orch1.getWatchManager().getLifecycle("AVAXUSDT")!;
      assert.strictEqual(
        before.globalState,
        "WAIT_FOR_POST_EPISODE_OI_CREATION",
      );
      assert.strictEqual(waitStates.docs.length, 1);

      const { orch: orch2 } = buildOrch(mongo);
      assert.strictEqual(
        orch2.getWatchManager().getLifecycle("AVAXUSDT"),
        null,
        "fresh instance starts with nothing in memory",
      );
      const restoredCount = await orch2.hydrateWaitStates(4_400_000);
      assert.strictEqual(restoredCount, 1);
      const after = orch2.getWatchManager().getLifecycle("AVAXUSDT")!;
      assert.strictEqual(
        after.globalState,
        "WAIT_FOR_POST_EPISODE_OI_CREATION",
        "must restore directly into WAIT, not re-derive it",
      );
      assert.strictEqual(
        after.episode.sameDirectionLiqUsd,
        before.episode.sameDirectionLiqUsd,
      );
      assert.strictEqual(
        after.episode.extremePrice,
        before.episode.extremePrice,
      );
      assert.strictEqual(
        after.episodeEndOiQuantity,
        before.episodeEndOiQuantity,
      );
      assert.strictEqual(after.episodeEndPrice, before.episodeEndPrice);
      assert.strictEqual(
        after.ownershipId,
        before.ownershipId,
        "ownershipId must be preserved so symbol ownership is not lost",
      );

      const episodeIdBefore = after.episodeId;
      orch2.onLiquidationEvent(
        {
          symbol: "AVAXUSDT",
          victim: "SHORT",
          timestamp: 4_400_100,
          price: 101.9,
          quoteQty: 50000,
        },
        null,
      );
      const afterEvent = orch2.getWatchManager().getLifecycle("AVAXUSDT")!;
      assert.strictEqual(
        afterEvent.episodeId,
        episodeIdBefore,
        "must fold into the SAME restored episode, never start a competing one",
      );
      assert.ok(
        afterEvent.episode.sameDirectionLiqUsd >
          before.episode.sameDirectionLiqUsd,
      );
    },
  );

  await scenario(
    "3. restart does not enter merely because it occurred -- the same causal economic gate still governs entry afterward",
    async () => {
      const { mongo } = fakeMongoWithWaitStates();
      const { orch: orch1 } = buildOrch(mongo);
      await driveToWait(orch1, "ETHUSDT", 4_000_000);

      const { orch: orch2 } = buildOrch(mongo);
      await orch2.hydrateWaitStates(4_400_000);
      assert.strictEqual(
        orch2.getWatchManager().getLifecycle("ETHUSDT")?.globalState,
        "WAIT_FOR_POST_EPISODE_OI_CREATION",
      );

      const history = [{ contracts: 4590, fetchedAt: 4_400_000 }];
      await orch2.onTick(
        "ETHUSDT",
        PCTX,
        history,
        101.8,
        1.0,
        1000,
        4_400_100,
        null,
        null,
        null,
        [],
        [],
        FLAT_ATR,
      );
      assert.strictEqual(
        orch2.getWatchManager().getLifecycle("ETHUSDT")?.globalState,
        "WAIT_FOR_POST_EPISODE_OI_CREATION",
        "must remain WAIT -- restart itself proves nothing about market evidence",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
