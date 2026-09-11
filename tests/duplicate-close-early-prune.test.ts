/**
 * Sep 9 2026 (Karo), operator-requested. Reproduces the OLD, proven
 * liqwatch-bot pattern (V5WaveService.closeTrade()'s own synchronous
 * `activeTrades.delete()`, confirmed via direct old-code trace to run
 * BEFORE any DB write or Telegram send) inside the NEW multi-user
 * reconciliation path.
 *
 * Root cause this fixes (confirmed via a real production incident,
 * signalId b0704c42-ecd1-470e-b8f3-1798e6d1fa8d, Artak's own LINKUSDT
 * close sent twice): the OLD design pruned the in-memory open-cache
 * only AFTER reconcileUserPosition() had already fully returned
 * (including having already sent the DB write and Telegram message),
 * and only in the CALLER's own, later code. A second onTick()
 * invocation, starting after the first had ALREADY finished (guard
 * released) but before that later pruning line executed, would still
 * find the signal "open" and run the entire confirm-DB-notify chain a
 * second time.
 *
 * Fix: onConfirmedClosed(signalId) now fires SYNCHRONOUSLY, inside
 * reconcileUserPosition() itself, the MOMENT Binance confirms closed
 * -- before the DB write, before Telegram. This test uses the REAL
 * reconcileUserPosition() function and a REAL InFlightGuard, simulating
 * ReconciliationManager.onTick()'s own read-cache/iterate/reconcile
 * loop pattern exactly, firing many rapid, overlapping "ticks" for the
 * same signal.
 */
import * as assert from "assert";
import { reconcileUserPosition } from "../src/application/execution/reconcile-user-position.usecase";
import { InFlightGuard } from "../src/domain/trading/risk/in-flight-guard";
import { ReconciliationHealthTracker } from "../src/domain/trading/risk/reconciliation-health";
import { DailyLossLimitTracker } from "../src/domain/trading/risk/daily-loss-limit.service";
import type { UserSignalDoc } from "../src/domain/signal/user-signal.model";
import type { GlobalSignalDoc } from "../src/domain/signal/global-signal.model";
import type { UserRuntime } from "../src/services/user-runtime";

let passed = 0;
let failed = 0;

function scenario(name: string, fn: () => Promise<void> | void): void {
  scenarios.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`  \u2713 ${name}`);
    } catch (err) {
      failed++;
      console.log(`  \u2717 ${name}`);
      console.log(
        `      ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  });
}
const scenarios: Array<() => Promise<void>> = [];

function baseUserSignal(overrides: Partial<UserSignalDoc> = {}): UserSignalDoc {
  return {
    signalId: "SIG-1",
    symbol: "LINKUSDT",
    side: "LONG",
    entry: 12.087,
    tp: 12.389,
    sl: 11.966,
    status: "OPEN",
    isLive: true,
    executionEnabled: true,
    executionSkipReason: null,
    binanceSlOrderId: 1,
    binanceTpOrderId: 2,
    positionQty: 8.27,
    notional: 100,
    riskUsd: 1,
    closedAt: null,
    closePrice: null,
    closeReason: null,
    telegramSent: true,
    telegramSentAt: 1,
    maxFavorableR: null,
    maxAdverseR: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as UserSignalDoc;
}

function baseGlobalSignal(): GlobalSignalDoc {
  return {
    signalId: "SIG-1",
    symbol: "LINKUSDT",
    side: "LONG",
    victim: "LONG",
    signalTs: 1,
    entryPrice: 12.087,
    entryWaveNumber: 1,
    waveHistory: [],
    w1Diagnostics: null,
    totalEpisodePressure: 100000,
    dominantLayerLiqUsd: null,
    dominantLayerWaveNumber: null,
    exhaustionLayerLiqUsd: 100000,
    exhaustionLayerWaveNumber: 1,
    unitAtStart: 1,
    p95AtEntry: 1000,
    dailyLiqPerMinBaselineAtEntry: 500,
    atr15mAtEntry: 5,
    cascadeId: null,
    timeframe: null,
    isMainExecuted: true,
    episodePlan: null,
    waveEfficiencyAnalysis: null,
    unitResearch: null,
    unitCompetitionResearch: null,
    commonHorizonResearch: null,
    qualifyingEventUsd: 100,
    qualifyingEventTs: 1,
    p95AtQualification: 90,
    physics: null,
    btcContext: null,
    liq24hContext: null,
    wallContext: null,
    entry: 12.087,
    tp: 12.389,
    sl: 11.966,
    rr: 2.5,
    btcSafetyStatus: "CLEAN",
    btcIntendedSideAtSignalTime: null,
    rejectionReason: null,
    status: "SIGNAL",
    closedAt: null,
    closePrice: null,
    maxFavorableR: null,
    maxAdverseR: null,
    liquidationStatsContext: null,
    planDiagnostics: null,
    researchCheckpoints: [],
    createdAt: 1,
  } as GlobalSignalDoc;
}

/** Real telegram-call counter, matching runtime.telegram's own sendMessage shape. */
function fakeTelegram() {
  let count = 0;
  return {
    get count() {
      return count;
    },
    sendMessage: async (_text: string) => {
      count++;
      return { ok: true, results: [] };
    },
  };
}

/** Simulates Binance's own reconcileLivePosition() with an artificial
 *  delay -- long enough that several rapid "ticks" can realistically
 *  overlap with it, mirroring a real REST round-trip. */
function fakeExecution(delayMs: number) {
  return {
    reconcileLivePosition: async (
      _symbol: string,
      _sl: number | null,
      _tp: number | null,
      _signalId: string,
    ) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return { stillOpen: false, reason: "SL" as const, actualPrice: 11.965 };
    },
    recordConfirmedClose: async (
      _signalId: string,
      _outcome: "TP" | "SL",
    ) => {},
  };
}

function fakeRuntime(
  telegram: ReturnType<typeof fakeTelegram>,
  execution: ReturnType<typeof fakeExecution>,
): UserRuntime {
  return {
    config: {
      userId: "artak",
      enabled: true,
      telegram: { enabled: true, botToken: "x", chatIds: ["1"] },
      binance: null,
      risk: { riskUsd: 1, accountBudgetUsd: 500, dailyLossLimitPct: 5 },
      btcBlockEnabled: false,
      longEnabled: true,
      shortEnabled: true,
    },
    telegram: telegram as unknown as UserRuntime["telegram"],
    execution: execution as unknown as UserRuntime["execution"],
    dailyLossLimit: new DailyLossLimitTracker("artak", 500, 5),
    reconcileInFlight: new InFlightGuard(),
    reconcileHealth: new ReconciliationHealthTracker(),
  } as unknown as UserRuntime;
}

/** Mirrors ReconciliationManager's OWN openCache: a plain array,
 *  mutated via the SAME synchronous pruneFromCache() pattern the real
 *  fix now uses. */
function makeCache(entries: UserSignalDoc[]) {
  let arr = entries;
  return {
    read: () => arr,
    prune: (signalId: string) => {
      arr = arr.filter((s) => s.signalId !== signalId);
    },
  };
}

console.log("Running duplicate-close early-prune regression tests...\n");

scenario(
  "many RAPID, overlapping onTick()-style calls for the SAME signal produce EXACTLY ONE Telegram close notification",
  async () => {
    const telegram = fakeTelegram();
    const execution = fakeExecution(50); // 50ms artificial Binance round-trip
    const runtime = fakeRuntime(telegram, execution);
    const userSignalRepo = {
      upsert: async (_userId: string, _doc: UserSignalDoc) => {},
    };
    const globalSignal = baseGlobalSignal();
    const cache = makeCache([baseUserSignal()]);

    // Simulates ReconciliationManager.onTick(): reads the cache, iterates,
    // calls reconcileUserPosition() with the SAME synchronous prune
    // callback the real fix wires up.
    async function simulatedTick(now: number): Promise<void> {
      const open = cache.read();
      for (const userSignal of open) {
        await reconcileUserPosition(
          userSignal,
          globalSignal,
          runtime,
          userSignalRepo,
          now,
          cache.prune,
        );
      }
    }

    // Fire 8 rapid "ticks" in quick succession -- some genuinely
    // concurrent (overlapping the 50ms Binance round-trip, caught by
    // InFlightGuard), some arriving just after the first fully resolves
    // but before old code would have pruned (caught by the NEW
    // synchronous, early prune).
    const ticks: Promise<void>[] = [];
    for (let i = 0; i < 8; i++) {
      ticks.push(simulatedTick(1000 + i));
      await new Promise((r) => setTimeout(r, 5)); // 5ms between tick starts -- much faster than the 50ms Binance round-trip
    }
    await Promise.all(ticks);

    assert.strictEqual(
      telegram.count,
      1,
      `expected exactly 1 Telegram close notification, got ${telegram.count}`,
    );
    assert.strictEqual(
      cache.read().length,
      0,
      "the signal must be pruned from the cache exactly once",
    );
  },
);

scenario(
  "onConfirmedClosed fires BEFORE the Telegram send, not after (structural proof of ordering)",
  async () => {
    const order: string[] = [];
    const telegram = {
      sendMessage: async (_text: string) => {
        order.push("telegram");
        return { ok: true, results: [] };
      },
    };
    const execution = fakeExecution(5);
    const runtime = fakeRuntime(
      telegram as unknown as ReturnType<typeof fakeTelegram>,
      execution,
    );
    const userSignalRepo = {
      upsert: async (_userId: string, _doc: UserSignalDoc) => {
        order.push("db");
      },
    };
    const globalSignal = baseGlobalSignal();

    await reconcileUserPosition(
      baseUserSignal(),
      globalSignal,
      runtime,
      userSignalRepo,
      2000,
      (signalId) => {
        order.push("prune");
        assert.strictEqual(signalId, "SIG-1");
      },
    );

    assert.deepStrictEqual(
      order,
      ["prune", "db", "telegram"],
      "prune must happen first, then DB write, then Telegram -- matching the old bot's own proven ordering exactly",
    );
  },
);

scenario(
  "failure recovery: if the DB write throws AFTER prune, the signal is not silently lost -- caller can still observe the failure and retry (matches the operator's own explicit requirement)",
  async () => {
    const telegram = fakeTelegram();
    const execution = fakeExecution(5);
    const runtime = fakeRuntime(telegram, execution);
    const userSignalRepo = {
      upsert: async (_userId: string, _doc: UserSignalDoc) => {
        throw new Error("mongo down");
      },
    };
    const globalSignal = baseGlobalSignal();

    let pruned = false;
    await assert.rejects(
      reconcileUserPosition(
        baseUserSignal(),
        globalSignal,
        runtime,
        userSignalRepo,
        3000,
        () => {
          pruned = true;
        },
      ),
      /mongo down/,
      "a DB failure must propagate to the caller, not be silently swallowed",
    );
    assert.strictEqual(
      pruned,
      true,
      "prune still fires before the failed DB write -- by design, the caller's own openCache is refreshed from Mongo every 15s (CACHE_REFRESH_MS), and since Mongo's own status is still \"OPEN\" (upsert never completed), the signal is naturally re-discovered and retried on the next refresh cycle -- never permanently lost",
    );
    assert.strictEqual(
      telegram.count,
      0,
      "Telegram must never be sent when the DB write itself failed",
    );
  },
);

(async () => {
  for (const s of scenarios) await s();
  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
