/**
 * Sep 14 2026 (Karo), operator-requested fix verification. Covers,
 * with lightweight in-memory fakes (no live Binance/Mongo needed):
 *   1. Binance OPEN -> signal remains ACTIVE
 *   2. Binance CLOSED -> closes on next reconciliation cycle
 *   3. Missed-tick path -> the fallback loop still closes it promptly
 *   4. Binance API temporary failure -> retry happens, bounded (not
 *      tens of minutes) per attempt
 *   5. UNKNOWN reconciliation never produces a fake exit==entry,
 *      0.00% PnL close -- uses lastKnownPrice instead
 *   6. Brother/Friend (two separate users) each reconcile their own
 *      account correctly, independently
 */
import * as assert from "assert";
import { reconcileUserPosition } from "../src/application/execution/reconcile-user-position.usecase";
import { ReconciliationManager } from "../src/services/reconciliation-manager";
import { InFlightGuard } from "../src/domain/trading/risk/in-flight-guard";
import { ReconciliationHealthTracker } from "../src/domain/trading/risk/reconciliation-health";
import { DailyLossLimitTracker } from "../src/domain/trading/risk/daily-loss-limit.service";
import type { UserRuntime } from "../src/services/user-runtime";
import type { UserSignalDoc } from "../src/domain/signal/user-signal.model";
import type { GlobalSignalDoc } from "../src/domain/signal/global-signal.model";
import type { BinanceExecutionService } from "../src/infrastructure/binance/binance-execution.service";

let passed = 0;
let failed = 0;

async function scenario(
  name: string,
  fn: () => void | Promise<void>,
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

type ReconcileResult =
  | { stillOpen: true; positionAmt: number }
  | {
      stillOpen: false;
      reason: "TP" | "SL";
      actualPrice: number;
      firedOrderId: number;
      siblingOrderId: number | null;
      positionAmt: number;
    }
  | { stillOpen: false; reason: "UNKNOWN"; positionAmt: number };

/** Fake BinanceExecutionService -- only the two methods
 *  reconcile-user-position.usecase.ts actually calls. `calls` records
 *  every reconcileLivePosition invocation for assertion. */
function makeFakeExecution(
  behavior: () => ReconcileResult | Promise<ReconcileResult>,
): { fake: BinanceExecutionService; calls: number[] } {
  const calls: number[] = [];
  const fake = {
    reconcileLivePosition: async (
      _symbol: string,
      _sl: number | null,
      _tp: number | null,
      _signalId: string,
    ) => {
      calls.push(Date.now());
      return await behavior();
    },
    recordConfirmedClose: async (_signalId: string, _reason: "TP" | "SL") => {},
  };
  return { fake: fake as unknown as BinanceExecutionService, calls };
}

function makeRuntime(
  userId: string,
  execution: BinanceExecutionService | null,
): UserRuntime {
  return {
    // Only `config.userId`/`config.enabled` are read by the code
    // under test -- same partial-fixture rationale as makeGlobalSignal
    // above, `as unknown as X` used explicitly rather than a direct
    // cast against the full UserConfig interface.
    config: { userId, enabled: true } as unknown as UserRuntime["config"],
    binanceRest: null,
    execution,
    telegram: null,
    dailyLossLimit: new DailyLossLimitTracker(userId, 500, 5),
    reconcileInFlight: new InFlightGuard(),
    reconcileHealth: new ReconciliationHealthTracker(),
    executionRecords: null,
    executionClaims: null,
  };
}

function makeUserSignal(signalId: string, symbol = "ETHUSDT"): UserSignalDoc {
  return {
    signalId,
    symbol,
    side: "SHORT",
    telegramSent: true,
    telegramSentAt: Date.now(),
    executionEnabled: true,
    status: "OPEN",
    executionSkipReason: null,
    isLive: true,
    binanceSlOrderId: 111,
    binanceTpOrderId: 222,
    positionQty: 2.67,
    notional: 6670,
    riskUsd: 20,
    entry: 2499.5,
    sl: 2507,
    tp: 2483,
    closedAt: null,
    closePrice: null,
    closeReason: null,
    maxFavorableR: null,
    maxAdverseR: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeGlobalSignal(signalId: string): GlobalSignalDoc {
  // Only `signalId`/`entryWaveNumber` are actually read by the code
  // under test (formatV5CloseMessage's own entryWaveNumber param) --
  // GlobalSignalDoc has many more required fields this fixture
  // deliberately doesn't populate, so `as unknown as X` (TypeScript's
  // own suggested pattern for a partial test double) is used
  // explicitly here, rather than a direct `as X` cast that could
  // silently pass or fail depending on the compiler's own literal-
  // overlap heuristic.
  return { signalId, entryWaveNumber: 1 } as unknown as GlobalSignalDoc;
}

class FakeUpsertRepo {
  public lastUpserted: UserSignalDoc | null = null;
  async upsert(_userId: string, doc: UserSignalDoc): Promise<void> {
    this.lastUpserted = doc;
  }
}

async function main() {
  console.log("Running reconciliation price-fix + fallback-loop tests...\n");

  await scenario(
    "1. Binance OPEN (positionAmt != 0) -> signal remains ACTIVE, no DB write",
    async () => {
      const { fake } = makeFakeExecution(() => ({
        stillOpen: true,
        positionAmt: 2.67,
      }));
      const runtime = makeRuntime("karo", fake);
      const repo = new FakeUpsertRepo();
      const { closed } = await reconcileUserPosition(
        makeUserSignal("sig-open"),
        makeGlobalSignal("sig-open"),
        runtime,
        repo,
        Date.now(),
        () => {},
        2500,
      );
      assert.strictEqual(
        closed,
        false,
        "must report not closed while Binance still shows an open position",
      );
      assert.strictEqual(
        repo.lastUpserted,
        null,
        "must not write to the DB while still open",
      );
    },
  );

  await scenario(
    "2. Binance CLOSED (positionAmt == 0, confirmed SL) -> closes immediately with the real fill price",
    async () => {
      const { fake } = makeFakeExecution(() => ({
        stillOpen: false,
        reason: "SL",
        actualPrice: 2507.3,
        firedOrderId: 111,
        siblingOrderId: 222,
        positionAmt: 0,
      }));
      const runtime = makeRuntime("karo", fake);
      const repo = new FakeUpsertRepo();
      let pruned: string | null = null;
      const { closed } = await reconcileUserPosition(
        makeUserSignal("sig-sl"),
        makeGlobalSignal("sig-sl"),
        runtime,
        repo,
        Date.now(),
        (id) => {
          pruned = id;
        },
        2500,
      );
      assert.strictEqual(closed, true, "must report closed");
      assert.strictEqual(repo.lastUpserted?.status, "CLOSED_SL");
      assert.strictEqual(
        repo.lastUpserted?.closePrice,
        2507.3,
        "must use the REAL actualPrice from Binance, not a placeholder",
      );
      assert.strictEqual(
        pruned,
        "sig-sl",
        "must prune from the open cache synchronously on confirmed close",
      );
    },
  );

  await scenario(
    "3. Fallback loop reconciles a signal even with zero matching bookTicker ticks for its symbol",
    async () => {
      const { fake } = makeFakeExecution(() => ({
        stillOpen: false,
        reason: "TP",
        actualPrice: 2483.1,
        firedOrderId: 222,
        siblingOrderId: 111,
        positionAmt: 0,
      }));
      const runtime = makeRuntime("karo", fake);
      const mongo = {
        globalSignals: async () => ({
          findOne: async () => makeGlobalSignal("sig-fallback"),
        }),
        userSignals: async () => null,
      } as any;
      const manager = new ReconciliationManager(mongo, [runtime]);
      // Directly seed the open-cache the way refreshCache() would, WITHOUT
      // calling onTick() at all -- simulating a symbol whose bookTicker
      // never ticked during this window.
      (manager as any).openCache.set("karo", [
        makeUserSignal("sig-fallback", "XLMUSDT"),
      ]);
      await (manager as any).runFallbackReconciliation();
      const stillOpen = (manager as any).openCache.get(
        "karo",
      ) as UserSignalDoc[];
      assert.strictEqual(
        stillOpen.length,
        0,
        "the fallback loop must have reconciled and pruned the signal even though onTick(XLMUSDT, ...) was never called",
      );
    },
  );

  await scenario(
    "4. Binance API failure -> backoff is a flat, bounded 5s, never escalates or blocks tens of minutes",
    async () => {
      let attemptCount = 0;
      const { fake } = makeFakeExecution(() => {
        attemptCount++;
        throw new Error("simulated Binance API timeout");
      });
      const runtime = makeRuntime("karo", fake);
      const repo = new FakeUpsertRepo();
      const signal = makeUserSignal("sig-fail");
      const t0 = 1_000_000;
      const r1 = await reconcileUserPosition(
        signal,
        makeGlobalSignal("sig-fail"),
        runtime,
        repo,
        t0,
        () => {},
        undefined,
      );
      assert.strictEqual(r1.closed, false);
      assert.strictEqual(
        attemptCount,
        1,
        "first attempt must actually call Binance",
      );
      const r2 = await reconcileUserPosition(
        signal,
        makeGlobalSignal("sig-fail"),
        runtime,
        repo,
        t0 + 100,
        () => {},
        undefined,
      );
      assert.strictEqual(
        attemptCount,
        1,
        "a retry inside the 5s backoff window must NOT call Binance again",
      );
      void r2;
      const r3 = await reconcileUserPosition(
        signal,
        makeGlobalSignal("sig-fail"),
        runtime,
        repo,
        t0 + 5_001,
        () => {},
        undefined,
      );
      assert.strictEqual(
        attemptCount,
        2,
        "a retry AFTER the 5s backoff window must call Binance again -- proves the delay is bounded to ~5s per attempt, not indefinite",
      );
      void r3;
    },
  );

  await scenario(
    "5. UNKNOWN reconciliation uses lastKnownPrice, never entry -- no fake exit==entry 0.00% PnL",
    async () => {
      const { fake } = makeFakeExecution(() => ({
        stillOpen: false,
        reason: "UNKNOWN",
        positionAmt: 0,
      }));
      const runtime = makeRuntime("friend", fake);
      const repo = new FakeUpsertRepo();
      const signal = makeUserSignal("sig-unknown");
      const realLastKnownPrice = 2501.2;
      const { closed } = await reconcileUserPosition(
        signal,
        makeGlobalSignal("sig-unknown"),
        runtime,
        repo,
        Date.now(),
        () => {},
        realLastKnownPrice,
      );
      assert.strictEqual(closed, true);
      assert.strictEqual(
        repo.lastUpserted?.closeReason,
        "MANUAL",
        "genuinely ambiguous close must be labeled MANUAL, never a confirmed TP/SL",
      );
      assert.strictEqual(
        repo.lastUpserted?.closePrice,
        realLastKnownPrice,
        "closePrice must be the real last-known market price, not entry",
      );
      assert.notStrictEqual(
        repo.lastUpserted?.closePrice,
        signal.entry,
        "must NEVER silently fall back to entry when a real lastKnownPrice was available -- this is the exact historical regression",
      );
    },
  );

  await scenario(
    "5b. UNKNOWN reconciliation falls back to entry ONLY when genuinely no price is available",
    async () => {
      const { fake } = makeFakeExecution(() => ({
        stillOpen: false,
        reason: "UNKNOWN",
        positionAmt: 0,
      }));
      const runtime = makeRuntime("friend", fake);
      const repo = new FakeUpsertRepo();
      const signal = makeUserSignal("sig-unknown-noprice");
      const { closed } = await reconcileUserPosition(
        signal,
        makeGlobalSignal("sig-unknown-noprice"),
        runtime,
        repo,
        Date.now(),
        () => {},
        undefined,
      );
      assert.strictEqual(
        closed,
        true,
        "must still close promptly even with no price available -- never leave a confirmed-closed Binance position stuck ACTIVE locally",
      );
      assert.strictEqual(
        repo.lastUpserted?.closePrice,
        signal.entry,
        "entry is the correct LAST-RESORT fallback only when lastKnownPrice is genuinely undefined",
      );
    },
  );

  await scenario(
    "6. Brother and Friend each reconcile their own account independently, never cross-contaminating",
    async () => {
      const brotherCalls: string[] = [];
      const friendCalls: string[] = [];
      const brotherExec = makeFakeExecution(() => {
        brotherCalls.push("called");
        return {
          stillOpen: false,
          reason: "TP",
          actualPrice: 100,
          firedOrderId: 1,
          siblingOrderId: 2,
          positionAmt: 0,
        };
      });
      const friendExec = makeFakeExecution(() => {
        friendCalls.push("called");
        return {
          stillOpen: false,
          reason: "SL",
          actualPrice: 200,
          firedOrderId: 3,
          siblingOrderId: 4,
          positionAmt: 0,
        };
      });
      const brotherRuntime = makeRuntime("brother", brotherExec.fake);
      const friendRuntime = makeRuntime("friend", friendExec.fake);
      const mongo = {
        globalSignals: async () => ({
          findOne: async ({ signalId }: { signalId: string }) =>
            makeGlobalSignal(signalId),
        }),
        userSignals: async () => null,
      } as any;
      const manager = new ReconciliationManager(mongo, [
        brotherRuntime,
        friendRuntime,
      ]);
      (manager as any).openCache.set("brother", [
        makeUserSignal("sig-shared", "ETHUSDT"),
      ]);
      (manager as any).openCache.set("friend", [
        makeUserSignal("sig-shared", "ETHUSDT"),
      ]);
      await manager.onTick("ETHUSDT", 2500, Date.now());
      assert.strictEqual(
        brotherCalls.length,
        1,
        "brother's own execution must be called exactly once",
      );
      assert.strictEqual(
        friendCalls.length,
        1,
        "friend's own execution must be called exactly once, independently of brother's outcome",
      );
      const brotherOpen = (manager as any).openCache.get(
        "brother",
      ) as UserSignalDoc[];
      const friendOpen = (manager as any).openCache.get(
        "friend",
      ) as UserSignalDoc[];
      assert.strictEqual(
        brotherOpen.length,
        0,
        "brother's own signal must be pruned after its own confirmed close",
      );
      assert.strictEqual(
        friendOpen.length,
        0,
        "friend's own signal must be pruned after its own confirmed close, independently",
      );
    },
  );

  await scenario(
    "7. onTick() records lastKnownPrice for the fallback loop / UNKNOWN-case to use later",
    async () => {
      const { fake } = makeFakeExecution(() => ({
        stillOpen: true,
        positionAmt: 1,
      }));
      const runtime = makeRuntime("karo", fake);
      const mongo = {
        globalSignals: async () => ({
          findOne: async () => makeGlobalSignal("sig-price"),
        }),
        userSignals: async () => null,
      } as any;
      const manager = new ReconciliationManager(mongo, [runtime]);
      await manager.onTick("SOLUSDT", 145.23, Date.now());
      const priceMap = (manager as any).lastKnownPrice as Map<string, number>;
      assert.strictEqual(
        priceMap.get("SOLUSDT"),
        145.23,
        "onTick must record the tick's mid price for this symbol, even with no open positions on it",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
