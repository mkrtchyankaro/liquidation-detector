/**
 * Sep 10 2026 (Karo), operator-reported CRITICAL FIX. Proves the
 * duplicate-cascade-document race condition (confirmed in production:
 * the same cascadeId appearing as two separate Mongo documents) is
 * fixed at BOTH layers:
 *   1. Data layer -- a fake collection that simulates a REAL unique
 *      index on cascadeId (a genuine check-then-insert race between
 *      two concurrent calls throws a duplicate-key error for the
 *      loser, exactly like MongoDB itself would), proving
 *      upsertCandidateState()'s own defensive retry correctly
 *      recovers from that error without losing the write or creating
 *      a second document.
 *   2. Application layer -- a structural check confirming
 *      feedCascade() now awaits each candidate's own persistence call
 *      SEQUENTIALLY (never fires all three concurrently), which is
 *      the actual root-cause fix -- the data-layer defense is the
 *      second line of defense, not the primary one.
 */
import * as assert from "assert";
import * as fs from "fs";
import { CascadeRepository } from "../src/infrastructure/mongo/cascade.repository";
import {
  emptyCandidateStateDoc,
  type CascadeDoc,
  type CascadeCandidateStateDoc,
} from "../src/domain/cascade/cascade.model";
import type { Side } from "../src/shared/common.types";

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

/** A fake Mongo collection that genuinely SIMULATES a unique index on
 *  cascadeId under real concurrency: updateOne()'s own check-then-
 *  insert is split across an `await` (yielding to the event loop, so
 *  concurrent calls can genuinely interleave, exactly like a real
 *  async Mongo driver), and if TWO calls both see "no document yet"
 *  before either finishes inserting, only the FIRST to actually write
 *  succeeds -- the second gets a genuine MongoServerError-shaped
 *  duplicate-key error (code 11000), matching what a real unique
 *  index enforces. */
class RaceSimulatingFakeCollection {
  private store = new Map<string, CascadeDoc>();
  insertAttempts = 0;

  async updateOne(
    filter: { cascadeId: string },
    update: {
      $set?: Record<string, unknown>;
      $setOnInsert?: Record<string, unknown>;
    },
    opts?: { upsert?: boolean },
  ): Promise<void> {
    const existing = this.store.get(filter.cascadeId);
    if (existing) {
      this.applySet(existing, update.$set);
      return;
    }
    if (!opts?.upsert) return; // no doc, not an upsert -- no-op, matches real Mongo

    // Yield to the event loop HERE, between "checked -- doesn't exist
    // yet" and "actually insert" -- this is exactly where a real
    // concurrent race window exists, and is what makes this fake
    // genuinely provable rather than trivially sequential.
    await new Promise((resolve) => setImmediate(resolve));

    if (this.store.has(filter.cascadeId)) {
      // Someone else inserted while we were yielded -- a REAL unique
      // index would reject OUR insert attempt right here.
      this.insertAttempts++;
      const err = new Error(
        `E11000 duplicate key error collection: cascadeId: "${filter.cascadeId}"`,
      ) as Error & { code: number };
      err.code = 11000;
      throw err;
    }

    this.insertAttempts++;
    const seed = update.$setOnInsert ?? {};
    const doc: CascadeDoc = {
      cascadeId: filter.cascadeId,
      symbol: seed.symbol as string,
      victimSide: seed.victimSide as Side,
      startedAt: seed.startedAt as number,
      status: (seed.status as "ACTIVE" | "CLOSED") ?? "ACTIVE",
      closedAt: null,
      candidates: {
        "1m":
          (seed["candidates.1m"] as CascadeCandidateStateDoc) ??
          emptyCandidateStateDoc("1m", Date.now()),
        "3m":
          (seed["candidates.3m"] as CascadeCandidateStateDoc) ??
          emptyCandidateStateDoc("3m", Date.now()),
        "5m":
          (seed["candidates.5m"] as CascadeCandidateStateDoc) ??
          emptyCandidateStateDoc("5m", Date.now()),
      },
      lastUpdatedTs: Date.now(),
    };
    this.applySet(doc, update.$set);
    this.store.set(filter.cascadeId, doc);
  }

  private applySet(
    doc: CascadeDoc,
    set: Record<string, unknown> | undefined,
  ): void {
    if (!set) return;
    for (const [path, value] of Object.entries(set)) {
      if (path.startsWith("candidates.")) {
        const tf = path.split(".")[1] as "1m" | "3m" | "5m";
        (doc.candidates as any)[tf] = value;
      } else {
        (doc as any)[path] = value;
      }
    }
  }

  async findOne(filter: { cascadeId: string }): Promise<CascadeDoc | null> {
    return this.store.get(filter.cascadeId) ?? null;
  }

  documentsFor(cascadeId: string): CascadeDoc[] {
    const doc = this.store.get(cascadeId);
    return doc ? [doc] : [];
  }

  get totalDocumentCount(): number {
    return this.store.size;
  }
}

function makeFakeMongo(col: RaceSimulatingFakeCollection) {
  return { activeCascades: async () => col } as any;
}

async function main(): Promise<void> {
  console.log("Running cascade-repository concurrency tests...\n");

  await scenario(
    "three CONCURRENT upsertCandidateState() calls for a brand-new cascadeId (simulating the old, buggy fire-and-forget pattern) still produce EXACTLY ONE Mongo document -- the defensive duplicate-key retry recovers the losing racers",
    async () => {
      const col = new RaceSimulatingFakeCollection();
      const repo = new CascadeRepository(makeFakeMongo(col));
      const now = Date.now();

      // Fire all three CONCURRENTLY (Promise.all, not sequential await)
      // -- this is deliberately the OLD, buggy pattern, to prove the
      // DATA-LAYER defense (duplicate-key retry) alone is sufficient
      // even if the application layer ever regresses back to concurrent
      // calls.
      await Promise.all([
        repo.upsertCandidateState(
          "casc-race",
          "ETHUSDT",
          "LONG",
          1000,
          {
            ...emptyCandidateStateDoc("1m", now),
            phase: "ACTIVE",
            frozenUnitAbs: 1,
          },
          now,
        ),
        repo.upsertCandidateState(
          "casc-race",
          "ETHUSDT",
          "LONG",
          1000,
          {
            ...emptyCandidateStateDoc("3m", now),
            phase: "ACTIVE",
            frozenUnitAbs: 2,
          },
          now,
        ),
        repo.upsertCandidateState(
          "casc-race",
          "ETHUSDT",
          "LONG",
          1000,
          {
            ...emptyCandidateStateDoc("5m", now),
            phase: "ACTIVE",
            frozenUnitAbs: 3,
          },
          now,
        ),
      ]);

      assert.strictEqual(
        col.totalDocumentCount,
        1,
        "exactly ONE document must exist for this cascadeId, never two",
      );
      const doc = await col.findOne({ cascadeId: "casc-race" });
      assert.ok(doc, "the document must exist");
      // All three candidates' own writes must have landed on the SAME document.
      assert.strictEqual(doc!.candidates["1m"].frozenUnitAbs, 1);
      assert.strictEqual(doc!.candidates["3m"].frozenUnitAbs, 2);
      assert.strictEqual(doc!.candidates["5m"].frozenUnitAbs, 3);
    },
  );

  await scenario(
    "ten concurrent racers for the same NEW cascadeId still produce exactly one document (stress version)",
    async () => {
      const col = new RaceSimulatingFakeCollection();
      const repo = new CascadeRepository(makeFakeMongo(col));
      const now = Date.now();
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.upsertCandidateState(
            "casc-stress",
            "SOLUSDT",
            "SHORT",
            2000,
            {
              ...emptyCandidateStateDoc("1m", now),
              phase: "ACTIVE",
              frozenUnitAbs: i + 1,
            },
            now,
          ),
        ),
      );
      assert.strictEqual(col.totalDocumentCount, 1);
    },
  );

  await scenario(
    "different cascadeIds never interfere with each other under concurrency",
    async () => {
      const col = new RaceSimulatingFakeCollection();
      const repo = new CascadeRepository(makeFakeMongo(col));
      const now = Date.now();
      await Promise.all([
        repo.upsertCandidateState(
          "casc-a",
          "ETHUSDT",
          "LONG",
          1000,
          {
            ...emptyCandidateStateDoc("1m", now),
            phase: "ACTIVE",
            frozenUnitAbs: 1,
          },
          now,
        ),
        repo.upsertCandidateState(
          "casc-b",
          "SOLUSDT",
          "SHORT",
          1000,
          {
            ...emptyCandidateStateDoc("1m", now),
            phase: "ACTIVE",
            frozenUnitAbs: 1,
          },
          now,
        ),
      ]);
      assert.strictEqual(
        col.totalDocumentCount,
        2,
        "two genuinely different cascades must produce two documents",
      );
    },
  );

  console.log("\nRunning structural tests (application-layer fix)...\n");

  await scenario(
    "structural: feedCascade() awaits its own single candidate's persistActiveCandidateSnapshot() call -- never fire-and-forget (operator-requested 1m-only simplification: only ONE candidate/timeframe exists in production now, so the original three-candidate race-condition concern no longer applies structurally, but the await discipline itself is unchanged)",
    () => {
      const source = fs.readFileSync(
        require.resolve("../src/services/market-data-orchestrator.ts"),
        "utf8",
      );
      const idx = source.indexOf("private async feedCascade(");
      assert.ok(idx > -1, "feedCascade must be async");
      const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
      const awaitCount = (
        body.match(/await this\.persistActiveCandidateSnapshot\(/g) ?? []
      ).length;
      assert.strictEqual(
        awaitCount,
        2,
        "both persistActiveCandidateSnapshot() call-sites (route + start branches) for the SINGLE 1m candidate must be awaited",
      );
      assert.ok(
        !body.includes("void this.persistActiveCandidateSnapshot("),
        "must never fire-and-forget this call anymore",
      );
      assert.ok(
        !body.includes("cascadeCandidate3m") &&
          !body.includes("cascadeCandidate5m"),
        "feedCascade() must never reference the 3m/5m candidates anymore",
      );
    },
  );

  await scenario(
    "structural: persistActiveCandidateSnapshot() itself is async and its own call to upsertCandidateState() is awaited, not fire-and-forget",
    () => {
      const source = fs.readFileSync(
        require.resolve("../src/services/market-data-orchestrator.ts"),
        "utf8",
      );
      const idx = source.indexOf(
        "private async persistActiveCandidateSnapshot(",
      );
      assert.ok(idx > -1);
      const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
      assert.ok(body.includes("await this.cascadeRepo.upsertCandidateState("));
      assert.ok(!body.includes("void this.cascadeRepo.upsertCandidateState("));
    },
  );

  await scenario(
    "structural: a unique index on cascadeId is created in ensureIndexes()",
    () => {
      const source = fs.readFileSync(
        require.resolve("../src/infrastructure/mongo/cascade.repository.ts"),
        "utf8",
      );
      const idx = source.indexOf("async ensureIndexes(");
      assert.ok(idx > -1);
      const body = source.slice(idx, source.indexOf("\n  async ", idx + 50));
      assert.ok(
        body.includes("{ cascadeId: 1 }") && body.includes("{ unique: true }"),
        "must create a unique index on cascadeId",
      );
    },
  );

  await scenario(
    "structural: the orchestrator's own ensureIndexes() calls CascadeRepository's own ensureIndexes() at startup",
    () => {
      const source = fs.readFileSync(
        require.resolve("../src/services/market-data-orchestrator.ts"),
        "utf8",
      );
      const idx = source.indexOf("async ensureIndexes(): Promise<void> {");
      assert.ok(idx > -1);
      const body = source.slice(idx, source.indexOf("\n  async ", idx + 50));
      assert.ok(body.includes("this.cascadeRepo.ensureIndexes()"));
    },
  );

  await scenario(
    "1-4 (operator-requested 1m-only production change). Every new cascade creates EXACTLY ONE candidate, timeframe=1m, UNIT from 1m Wilder ATR(240), and NO 3m/5m candidate is created anywhere in feedCascade()'s own start-branch",
    () => {
      const source = fs.readFileSync(
        require.resolve("../src/services/market-data-orchestrator.ts"),
        "utf8",
      );
      const idx = source.indexOf("private async feedCascade(");
      const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
      const startCascadeCount = (body.match(/\.startCascade\(/g) ?? []).length;
      assert.strictEqual(
        startCascadeCount,
        1,
        "exactly one startCascade() call in feedCascade() -- exactly one candidate ever created per cascade",
      );
      assert.ok(
        body.includes("this.cascadeCandidate1m.startCascade(") &&
          /startCascade\([\s\S]{0,120}?"1m"/.test(body),
        'the single candidate\'s own timeframe must be "1m"',
      );
      assert.ok(
        /getWilderATR\(\s*l\.symbol,\s*"1m",\s*COMMON_HORIZON_PERIODS\.atr1m\s*,?\s*\)/.test(
          body,
        ),
        'UNIT must be read via getWilderATR(symbol, "1m", COMMON_HORIZON_PERIODS.atr1m)',
      );
      assert.ok(
        !body.includes("cascadeCandidate3m") &&
          !body.includes("cascadeCandidate5m"),
        "feedCascade() must never reference the 3m/5m candidates",
      );
    },
  );

  await scenario(
    "structural: tickCascade() ticks ONLY the 1m candidate -- no 3m/5m candidate is ever ticked in live execution",
    () => {
      const source = fs.readFileSync(
        require.resolve("../src/services/market-data-orchestrator.ts"),
        "utf8",
      );
      const idx = source.indexOf("private tickCascade(");
      const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
      const tickCount = (body.match(/handleCascadeTick\(/g) ?? []).length;
      assert.strictEqual(
        tickCount,
        1,
        "exactly one handleCascadeTick() call per victim-loop iteration -- only the 1m candidate is ticked",
      );
      assert.ok(
        body.includes("this.handleCascadeTick(") &&
          body.includes("this.cascadeCandidate1m") &&
          /handleCascadeTick\(\s*"1m"/.test(body),
      );
      assert.ok(
        !body.includes("cascadeCandidate3m") &&
          !body.includes("cascadeCandidate5m"),
        "tickCascade() must never reference the 3m/5m candidates",
      );
    },
  );

  await scenario(
    "operator-requested (fixed 0.30% risk model): handleCandlePhysicsEntry() computes executable SL/TP from a FIXED 0.30% risk, never from deriveLastTwoWaveTradePlan()'s own stopLoss/takeProfit, and never rejects or clamps based on the structural diagnostics",
    () => {
      const source = fs.readFileSync(
        require.resolve("../src/services/market-data-orchestrator.ts"),
        "utf8",
      );
      const idx = source.indexOf("private async handleCandlePhysicsEntry(");
      assert.ok(idx > -1, "handleCandlePhysicsEntry must be defined");
      const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
      assert.ok(
        /FIXED_SL_PCT\s*=\s*0\.003/.test(body),
        "must use a fixed 0.30% SL constant",
      );
      assert.ok(
        /REWARD_RISK_RATIO\s*=\s*2\.2/.test(body),
        "must keep TP at exactly 2.2R",
      );
      assert.ok(
        /const\s+sl\s*=[\s\S]{0,120}?FIXED_SL_PCT/.test(body) &&
          body.includes('event.victim === "LONG"'),
        "SL must be derived from FIXED_SL_PCT directly, not from any structural wave computation",
      );
      assert.ok(
        !body.includes("sl: structuralDiagnostics.stopLoss") &&
          !body.includes("sl: planCalc.stopLoss"),
        "the executable SL must NEVER be assigned from the structural (last-two-wave) computation",
      );
      assert.ok(
        !body.includes("tp: structuralDiagnostics.takeProfit") &&
          !body.includes("tp: planCalc.takeProfit"),
        "the executable TP must NEVER be assigned from the structural (last-two-wave) computation",
      );
      assert.ok(
        body.includes("deriveLastTwoWaveTradePlan("),
        "the structural computation must still be present, but as a diagnostic only",
      );
      assert.ok(
        body.includes("DIAGNOSTICS_ONLY_NOT_EXECUTABLE"),
        "the structural computation's own log line must be clearly labeled as non-executable",
      );
      assert.ok(
        !/if\s*\(\s*structuralDiagnostics/.test(body),
        "must never branch/reject/clamp based on the structural diagnostics",
      );
    },
  );

  await scenario(
    "operator-requested (P95 now qualifies W1 at the engine level, NOT a final entry-time gate): handleCandlePhysicsEntry() no longer performs its own P95 comparison -- it only LOGS the engine's own p95AtW1Qualification/maxIndividualEventUsdAtW1, never a second, redundant gate",
    () => {
      const source = fs.readFileSync(
        require.resolve("../src/services/market-data-orchestrator.ts"),
        "utf8",
      );
      const idx = source.indexOf("private async handleCandlePhysicsEntry(");
      assert.ok(idx > -1);
      const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
      assert.ok(
        body.includes("event.p95AtW1Qualification"),
        "must log the engine's own real W1-qualification P95",
      );
      assert.ok(
        body.includes("event.maxIndividualEventUsdAtW1"),
        "must log the engine's own real W1-qualifying individual event",
      );
      assert.ok(
        !body.includes("NO_P95_EVENT"),
        "the OLD final-entry P95 gate/rejection must be gone -- P95 now only qualifies W1, at the engine level, never a second gate here",
      );
      assert.ok(
        !/this\.liquidationStats\.notionalPercentile\(event\.symbol, event\.victim, 95\)/.test(
          body.slice(0, body.indexOf("this.atrTracker.getATR")),
        ),
        "must never independently recompute/compare P95 before ATR/SL/TP construction anymore",
      );
    },
  );

  await scenario(
    "operator-requested: the removed P95 gate touches ONLY handleCandlePhysicsEntry()'s own entry point -- SL/TP construction, hydrateActiveTrade, and distribute() remain completely present and unchanged downstream",
    () => {
      const source = fs.readFileSync(
        require.resolve("../src/services/market-data-orchestrator.ts"),
        "utf8",
      );
      const idx = source.indexOf("private async handleCandlePhysicsEntry(");
      const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
      assert.ok(
        body.includes("FIXED_SL_PCT"),
        "fixed 0.30% SL logic must still be present, untouched",
      );
      assert.ok(
        body.includes("REWARD_RISK_RATIO = 2.2"),
        "TP=2.2R logic must still be present, untouched",
      );
      assert.ok(
        body.includes("this.v5.hydrateActiveTrade("),
        "post-entry TP/SL/CLOSE lifecycle installation must still be present, untouched",
      );
      assert.ok(
        body.includes("this.distributor.distribute("),
        "signal distribution must still be present, untouched",
      );
      assert.ok(
        body.includes("this.mainSymbolLocks.add("),
        "symbol-lock behavior must still be present, untouched",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
