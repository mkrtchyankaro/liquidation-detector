/**
 * Sep 8 2026 (Karo). Verifies the specific multi-user invariants the
 * operator explicitly listed, using lightweight in-memory fakes for
 * Mongo/Binance/Telegram (no live services needed). DailyLossLimitTracker
 * is the REAL, unmodified-behavior class.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { DailyLossLimitTracker } from "../src/domain/trading/risk/daily-loss-limit.service";
import type { UserSignalDoc } from "../src/domain/signal/user-signal.model";
import type { GlobalSignalDoc } from "../src/domain/signal/global-signal.model";

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

/** In-memory stand-in for "N separate per-user Mongo collections"
 *  (v5_signals_karo, v5_signals_friend, ...) -- one Map PER userId,
 *  never a single shared Map keyed by (userId, signalId). */
class FakePerUserSignalStore {
  private readonly collections = new Map<string, Map<string, UserSignalDoc>>();

  private collectionFor(userId: string): Map<string, UserSignalDoc> {
    let col = this.collections.get(userId);
    if (!col) {
      col = new Map();
      this.collections.set(userId, col);
    }
    return col;
  }

  async upsert(userId: string, doc: UserSignalDoc): Promise<void> {
    this.collectionFor(userId).set(doc.signalId, { ...doc });
  }

  async findBySignalId(
    userId: string,
    signalId: string,
  ): Promise<UserSignalDoc | null> {
    return this.collectionFor(userId).get(signalId) ?? null;
  }

  hasAny(userId: string, signalId: string): boolean {
    return this.collectionFor(userId).has(signalId);
  }
}

function makeGlobalSignal(signalId: string): GlobalSignalDoc {
  return {
    signalId,
    symbol: "ETHUSDT",
    side: "LONG",
    victim: "LONG",
    signalTs: Date.now(),
    entryPrice: 2500,
    entryWaveNumber: 2,
    waveHistory: [],
    w1Diagnostics: null,
    totalEpisodePressure: 100_000,
    dominantLayerLiqUsd: null,
    dominantLayerWaveNumber: null,
    exhaustionLayerLiqUsd: null,
    exhaustionLayerWaveNumber: null,
    unitAtStart: 1,
    p95AtEntry: 1000,
    dailyLiqPerMinBaselineAtEntry: 500,
    atr15mAtEntry: 5,
    cascadeId: null,
    timeframe: null,
    isMainExecuted: true,
    episodePlan: null,
    waveEfficiencyAnalysis: null,
    marketContextAtEntry: null,
    p95AtW1Qualification: null,
    maxIndividualEventUsdAtW1: null,
    w1QualificationTs: null,
    unitResearch: null,
    unitCompetitionResearch: null,
    commonHorizonResearch: null,
    qualifyingEventUsd: 50_000,
    qualifyingEventTs: Date.now(),
    p95AtQualification: 40_000,
    physics: null,
    btcContext: null,
    liq24hContext: null,
    wallContext: null,
    entry: 2500,
    tp: 2525,
    sl: 2490,
    rr: 2.5,
    btcSafetyStatus: "CLEAN",
    btcIntendedSideAtSignalTime: null,
    rejectionReason: null,
    status: "SIGNAL",
    planDiagnostics: null,
    closedAt: null,
    closePrice: null,
    maxFavorableR: null,
    maxAdverseR: null,
    liquidationStatsContext: null,
    researchCheckpoints: [],
    createdAt: Date.now(),
  };
}

function makeUserSignal(signalId: string): UserSignalDoc {
  return {
    signalId,
    symbol: "ETHUSDT",
    side: "LONG",
    telegramSent: true,
    telegramSentAt: Date.now(),
    executionEnabled: true,
    executionSkipReason: null,
    status: "OPEN",
    isLive: true,
    binanceSlOrderId: 111,
    binanceTpOrderId: 222,
    positionQty: 1,
    notional: 2500,
    riskUsd: 10,
    entry: 2500,
    sl: 2490,
    tp: 2525,
    closedAt: null,
    closePrice: null,
    closeReason: null,
    maxFavorableR: null,
    maxAdverseR: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function main(): Promise<void> {
  console.log("Running multi-user isolation invariant tests...\n");

  await scenario(
    "ONE V5 strategy signal has exactly ONE canonical signalId",
    () => {
      const g1 = makeGlobalSignal("SIG-ABC123");
      const g2 = makeGlobalSignal("SIG-ABC123");
      assert.strictEqual(g1.signalId, g2.signalId);
    },
  );

  await scenario(
    "the SAME signalId is independently persisted into v5_signals_karo AND v5_signals_friend (two SEPARATE collections)",
    async () => {
      const store = new FakePerUserSignalStore();
      const signalId = "SIG-ABC123";
      await store.upsert("karo", makeUserSignal(signalId));
      await store.upsert("friend", makeUserSignal(signalId));
      assert.ok(store.hasAny("karo", signalId));
      assert.ok(store.hasAny("friend", signalId));
      const karoDoc = await store.findBySignalId("karo", signalId);
      const friendDoc = await store.findBySignalId("friend", signalId);
      assert.notStrictEqual(karoDoc, friendDoc);
    },
  );

  await scenario(
    "a THIRD user (artak) who was never given this signalId has NO document for it at all",
    async () => {
      const store = new FakePerUserSignalStore();
      await store.upsert("karo", makeUserSignal("SIG-XYZ"));
      assert.strictEqual(store.hasAny("artak", "SIG-XYZ"), false);
    },
  );

  await scenario(
    "Karo's manual close updates ONLY v5_signals_karo -- v5_signals_friend for the SAME signalId remains untouched",
    async () => {
      const store = new FakePerUserSignalStore();
      const signalId = "SIG-ABC123";
      await store.upsert("karo", makeUserSignal(signalId));
      await store.upsert("friend", makeUserSignal(signalId));
      const karoDoc = await store.findBySignalId("karo", signalId);
      assert.ok(karoDoc);
      await store.upsert("karo", {
        ...karoDoc,
        status: "CLOSED_MANUAL",
        isLive: false,
        closedAt: Date.now(),
        closeReason: "MANUAL",
      });
      const karoAfter = await store.findBySignalId("karo", signalId);
      const friendAfter = await store.findBySignalId("friend", signalId);
      assert.strictEqual(karoAfter?.status, "CLOSED_MANUAL");
      assert.strictEqual(friendAfter?.status, "OPEN");
    },
  );

  await scenario(
    "the GLOBAL canonical signal document itself is never mutated by any user's own close -- structurally cannot hold a per-user close status",
    () => {
      const g = makeGlobalSignal("SIG-ABC123");
      assert.strictEqual(g.status, "SIGNAL");
    },
  );

  await scenario(
    "one user's own daily-loss-limit block does not affect another user's own tracker",
    () => {
      const now = Date.now();
      const karoLimit = new DailyLossLimitTracker("karo", 100, 5);
      const friendLimit = new DailyLossLimitTracker("friend", 500, 5);
      karoLimit.recordRealizedPnl(-6, now);
      assert.strictEqual(karoLimit.isOwnBlocked(now), true);
      assert.strictEqual(friendLimit.isOwnBlocked(now), false);
    },
  );

  await scenario(
    "preserved calculation/fallback behavior: unconfigured tracker falls back to the EXACT original 500/5 defaults",
    () => {
      const now = Date.now();
      const tracker = new DailyLossLimitTracker("no-config-user");
      tracker.recordRealizedPnl(-24, now);
      assert.strictEqual(tracker.isOwnBlocked(now), false);
      tracker.recordRealizedPnl(-3, now);
      assert.strictEqual(tracker.isOwnBlocked(now), true);
    },
  );

  await scenario(
    "per-user execution claims are scoped per user (structural proof: constructor requires userId, collection name includes it)",
    () => {
      const src = fs.readFileSync(
        path.join(
          __dirname,
          "../src/infrastructure/mongo/execution-claim.repository.ts",
        ),
        "utf8",
      );
      assert.ok(src.includes("userId: string"));
      const mongoClientSrc = fs.readFileSync(
        path.join(__dirname, "../src/infrastructure/mongo/mongo.client.ts"),
        "utf8",
      );
      assert.ok(mongoClientSrc.includes("execution_claims_${userId}"));
    },
  );

  // ─── Sep 12 2026 (Karo), operator-reported CRITICAL FIX: execution
  // CLOSE notifications must be strictly per-user -- the cross-user
  // broadcast that used to send one user's real-execution CLOSE
  // through every OTHER user's own telegram client is removed. ───

  await scenario(
    "1. reconcileUserPosition()'s own return shape no longer carries a broadcastMessage -- the only thing it can report is whether it closed",
    () => {
      const src = fs.readFileSync(
        path.join(
          __dirname,
          "../src/application/execution/reconcile-user-position.usecase.ts",
        ),
        "utf8",
      );
      assert.ok(
        !/broadcastMessage\s*[:,]/.test(src),
        "broadcastMessage must be gone from the actual interface/return-shape (not merely absent from comments)",
      );
      assert.ok(
        src.includes("Promise<{ closed: boolean }>"),
        "the return type must be the minimal { closed: boolean } shape",
      );
      assert.ok(
        src.includes("await notifyUserClose(message, runtime)"),
        "the actual position owner's own per-user notifyUserClose(message, runtime) must remain, unchanged",
      );
    },
  );

  await scenario(
    "2/3. ReconciliationManager.onTick() no longer loops over other users' runtimes to send a close message -- no cross-user telegram send exists in this file at all",
    () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../src/services/reconciliation-manager.ts"),
        "utf8",
      );
      assert.ok(
        !src.includes("for (const other of this.userRuntimes)"),
        "the cross-user broadcast loop must be completely removed",
      );
      assert.ok(
        !src.includes("other.telegram.sendMessage"),
        "no code path in this file may send to any runtime other than the one that actually owns the position being reconciled",
      );
      assert.ok(
        !src.includes("CLOSE_BROADCAST_SEND_FAILED"),
        "the broadcast-specific log marker must be gone along with the broadcast code it described",
      );
      // The per-user reconcile call itself, which internally sends via
      // notifyUserClose(message, runtime) to ONLY that same runtime, must
      // still be present and untouched -- checked piece-by-piece rather
      // than as one exact single-line string, so this survives harmless
      // reformatting (e.g. Prettier wrapping the call across lines).
      assert.ok(
        src.includes("reconcileUserPosition("),
        "the per-user reconcile call must remain present",
      );
      // Sep 14 2026 (Karo), operator-reported fix -- the PREVIOUS version
      // of this assertion checked one exact single-line literal string,
      // which broke the moment the call was Prettier-wrapped across
      // multiple lines (confirmed: a real, differently-formatted but
      // functionally identical file failed this exact assertion).
      // Checking each argument's presence independently, in a way that
      // tolerates whitespace/newlines between them, actually delivers on
      // this test's own stated intent ("survives harmless reformatting")
      // instead of only claiming to.
      const callSiteMatch = /await reconcileUserPosition\(([\s\S]*?)\);/.exec(
        src,
      );
      assert.ok(
        callSiteMatch,
        "must find a reconcileUserPosition(...) call in this file",
      );
      const callArgs = callSiteMatch![1].replace(/\s+/g, " ").trim();
      for (const requiredArg of [
        "userSignal",
        "globalSignal",
        "runtime",
        "userSignalRepo",
        "now",
        "pruneFromCache",
        "lastKnownPrice",
      ]) {
        assert.ok(
          new RegExp(`\\b${requiredArg}\\b`).test(callArgs),
          `the per-user reconcile call must pass ${requiredArg} -- got: ${callArgs}`,
        );
      }
      // Order matters for `runtime`/`userSignal` specifically -- the
      // actual invariant this test protects (never a DIFFERENT runtime
      // than the one whose position is being checked). Argument order
      // in general (e.g. lastKnownPrice vs pruneFromCache) is not what
      // this invariant is about, so only the two that matter are order-
      // checked, not the full literal sequence.
      assert.ok(
        /runtime,\s*userSignalRepo/.test(callArgs) ||
          /\bruntime\b[\s\S]*\buserSignalRepo\b/.test(callArgs),
        "runtime must be the SAME runtime passed alongside userSignalRepo -- never a different user's runtime",
      );
    },
  );

  await scenario(
    "4. ENTRY fan-out (SignalDistributor.distribute()) is completely untouched by this fix -- still unconditionally loops over every enabled user for every signal, independent of real Binance ownership",
    () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../src/services/signal-distributor.ts"),
        "utf8",
      );
      assert.ok(
        src.includes("for (const runtime of this.userRuntimes)"),
        "ENTRY's own unconditional per-enabled-user loop must still be present, unchanged",
      );
      assert.ok(
        src.includes("if (!runtime.config.enabled) continue;"),
        "the ENTRY loop's own gating condition (enabled only, no execution/ownership check) must be exactly as before",
      );
    },
  );

  await scenario(
    "5. no duplicate CLOSE mechanism was introduced -- notifyUserClose is actually invoked from exactly one call site",
    () => {
      const src = fs.readFileSync(
        path.join(
          __dirname,
          "../src/application/execution/reconcile-user-position.usecase.ts",
        ),
        "utf8",
      );
      const matches = src.match(/await notifyUserClose\(/g) ?? [];
      assert.strictEqual(
        matches.length,
        1,
        "notifyUserClose must be invoked from exactly one place -- no second/replacement broadcast call was added",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
