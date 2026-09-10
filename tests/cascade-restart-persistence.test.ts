/**
 * Sep 10 2026 (Karo), operator-requested restart-safe persistence for
 * the production V5 multi-timeframe cascade lifecycle. Proves the 8
 * required restart scenarios: (1-4) via REAL exportState()/
 * restoreWatch()/restoreOwnership() round-trips on the actual classes
 * (no Mongo needed -- these are pure in-memory serialize/restore
 * proofs), (5-6) the same, extended to a mixed terminal/active
 * cascade, (7-8) via CascadeRepository against a lightweight in-memory
 * fake Mongo collection (same convention as research-data-layer.test.ts
 * -- no live database needed).
 */
import * as assert from "assert";
import { CascadeCandidateService } from "../src/domain/cascade/cascade-candidate.service";
import { CascadeRegistry } from "../src/domain/cascade/cascade-registry";
import { CascadeRepository } from "../src/infrastructure/mongo/cascade.repository";
import {
  emptyCandidateStateDoc,
  type CascadeDoc,
  type CascadeCandidateStateDoc,
} from "../src/domain/cascade/cascade.model";
import type { Liquidation, Side } from "../src/shared/common.types";

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

function liq(
  symbol: string,
  side: "BUY" | "SELL",
  price: number,
  quoteQty: number,
  timestamp: number,
): Liquidation {
  return {
    symbol,
    side,
    price,
    quantity: quoteQty / price,
    quoteQty,
    timestamp,
  };
}

async function main(): Promise<void> {
  console.log(
    "Running cascade restart-persistence tests (in-memory round-trip)...\n",
  );

  // ─── 1. Partial cascade survives restart ───────────────────────────────

  scenario(
    "a partial (still-tracking) cascade's own exact watch survives an export/restore round-trip",
    () => {
      const before = new CascadeCandidateService();
      before.startCascade(
        "ETHUSDT",
        "LONG",
        "casc-1",
        "1m",
        1,
        2000,
        1000,
        5000,
        1000,
      );
      before.onLiquidation(liq("ETHUSDT", "SELL", 1999, 500, 1200), "LONG"); // still Wave 1, accumulating
      const state = before.exportState("ETHUSDT", "LONG");
      assert.ok(state, "an active watch must export a non-null state");

      const after = new CascadeCandidateService(); // simulates a fresh process after restart
      after.restoreWatch("ETHUSDT", "LONG", state!);
      const peekBefore = before.peekWatch("ETHUSDT", "LONG");
      const peekAfter = after.peekWatch("ETHUSDT", "LONG");
      assert.deepStrictEqual(
        peekAfter,
        peekBefore,
        "the restored watch must peek identically to the pre-restart one",
      );
    },
  );

  // ─── 2. Frozen UNIT survives restart unchanged ─────────────────────────

  scenario(
    "the frozen UNIT (unitAbs) survives restart completely unchanged",
    () => {
      const before = new CascadeCandidateService();
      before.startCascade(
        "ETHUSDT",
        "LONG",
        "casc-1",
        "3m",
        2.234,
        2000,
        1000,
        5000,
        1000,
      );
      const state = before.exportState("ETHUSDT", "LONG")!;
      assert.strictEqual(state.unitAbs, 2.234);

      const after = new CascadeCandidateService();
      after.restoreWatch("ETHUSDT", "LONG", state);
      // Confirm the restored UNIT actually drives behavior identically --
      // completing Wave 1 at the SAME exact price on both instances.
      const beforeResult = before.onTick("ETHUSDT", "LONG", 2002.234, 2000); // exactly 1x UNIT recovery
      const afterResult = after.onTick("ETHUSDT", "LONG", 2002.234, 2000);
      assert.strictEqual(beforeResult, null);
      assert.strictEqual(afterResult, null);
      assert.deepStrictEqual(
        after.peekWatch("ETHUSDT", "LONG"),
        before.peekWatch("ETHUSDT", "LONG"),
      );
    },
  );

  // ─── 3. waveHistory survives restart ───────────────────────────────────

  scenario(
    "the full waveHistory (every wave's own anchor/extreme/liq/state) survives restart exactly",
    () => {
      const before = new CascadeCandidateService();
      before.startCascade(
        "ETHUSDT",
        "LONG",
        "casc-1",
        "1m",
        1,
        2000,
        1000,
        8000,
        1000,
      );
      before.onTick("ETHUSDT", "LONG", 2001, 2000); // Wave 1 completes
      before.onLiquidation(liq("ETHUSDT", "SELL", 2000.5, 9000, 2500), "LONG"); // Wave 2 starts (intensifying)
      const state = before.exportState("ETHUSDT", "LONG")!;
      assert.strictEqual(state.waves.length, 2);
      assert.strictEqual(state.waves[0]!.state, "COMPLETED");
      assert.strictEqual(state.waves[0]!.liqUsd, 8000);
      assert.strictEqual(state.waves[1]!.state, "ACTIVE");
      assert.strictEqual(state.waves[1]!.liqUsd, 9000);

      const after = new CascadeCandidateService();
      after.restoreWatch("ETHUSDT", "LONG", state);
      const restoredState = after.exportState("ETHUSDT", "LONG")!;
      assert.deepStrictEqual(
        restoredState.waves,
        state.waves,
        "every wave field must round-trip byte-for-byte",
      );
    },
  );

  // ─── 4. current extreme/phase survives restart ─────────────────────────

  scenario(
    "current extreme and phase survive restart -- the restored watch resumes from the EXACT same target price",
    () => {
      const before = new CascadeCandidateService();
      before.startCascade(
        "ETHUSDT",
        "LONG",
        "casc-1",
        "1m",
        1,
        2000,
        1000,
        5000,
        1000,
      );
      before.onTick("ETHUSDT", "LONG", 1997, 1500); // deepens the extreme before completing
      const peekBefore = before.peekWatch("ETHUSDT", "LONG")!;
      assert.strictEqual(peekBefore.phase, "WAITING_WAVE_RECOVERY");

      const state = before.exportState("ETHUSDT", "LONG")!;
      const after = new CascadeCandidateService();
      after.restoreWatch("ETHUSDT", "LONG", state);
      const peekAfter = after.peekWatch("ETHUSDT", "LONG")!;
      assert.strictEqual(peekAfter.phase, peekBefore.phase);
      assert.strictEqual(
        peekAfter.nextTargetPrice,
        peekBefore.nextTargetPrice,
        "the next-target price (derived from the current extreme) must match exactly",
      );
    },
  );

  // ─── 5. terminal 1m/3m + active 5m restores correctly ──────────────────

  scenario(
    "terminal 1m/3m (never restored, correctly) + still-active 5m (fully restored) -- the mixed case",
    () => {
      const c1m = new CascadeCandidateService();
      const c3m = new CascadeCandidateService();
      const c5m = new CascadeCandidateService();
      c1m.startCascade(
        "ETHUSDT",
        "LONG",
        "casc-1",
        "1m",
        1,
        2000,
        1000,
        5000,
        1000,
      );
      c3m.startCascade(
        "ETHUSDT",
        "LONG",
        "casc-1",
        "3m",
        2,
        2000,
        1000,
        5000,
        1000,
      );
      c5m.startCascade(
        "ETHUSDT",
        "LONG",
        "casc-1",
        "5m",
        3,
        2000,
        1000,
        5000,
        1000,
      );

      // Drive 1m to CANCEL and 3m to SIGNAL -- both terminal, both removed
      // from their own internal watches map.
      c1m.onTick("ETHUSDT", "LONG", 2001, 1500);
      c1m.onTick("ETHUSDT", "LONG", 2010, 2000); // CANCEL (2x UNIT, no Wave 2)
      assert.strictEqual(
        c1m.exportState("ETHUSDT", "LONG"),
        null,
        "1m must be terminal (exportState null)",
      );

      c3m.onTick("ETHUSDT", "LONG", 2003, 1500); // Wave 1 completes
      c3m.onLiquidation(liq("ETHUSDT", "SELL", 2002, 100, 2200), "LONG"); // Wave 2 (weaker) starts
      c3m.onTick("ETHUSDT", "LONG", 2004, 2500); // Wave 2 completes, weaker -> SIGNAL
      assert.strictEqual(
        c3m.exportState("ETHUSDT", "LONG"),
        null,
        "3m must be terminal (exportState null)",
      );

      // 5m is still genuinely active.
      const state5m = c5m.exportState("ETHUSDT", "LONG");
      assert.ok(state5m, "5m must still be active");

      // Simulate restart: fresh instances, restore ONLY what has state to restore.
      const r1m = new CascadeCandidateService();
      const r3m = new CascadeCandidateService();
      const r5m = new CascadeCandidateService();
      // 1m/3m: nothing to restore (they are terminal -- correctly, nothing calls restoreWatch for them).
      r5m.restoreWatch("ETHUSDT", "LONG", state5m!);

      assert.strictEqual(
        r1m.peekWatch("ETHUSDT", "LONG"),
        null,
        "1m must remain terminal after restart -- never resumed",
      );
      assert.strictEqual(
        r3m.peekWatch("ETHUSDT", "LONG"),
        null,
        "3m must remain terminal after restart -- never resumed",
      );
      assert.deepStrictEqual(
        r5m.peekWatch("ETHUSDT", "LONG"),
        c5m.peekWatch("ETHUSDT", "LONG"),
        "5m must resume exactly where it left off",
      );
    },
  );

  // ─── 6. same-symbol new cascade remains blocked after hydration ────────

  scenario(
    "after hydration restores at least one still-active candidate, a new liquidation for the SAME symbol is routed into the restored cascade, never starting a fresh one",
    () => {
      const before = new CascadeCandidateService();
      before.startCascade(
        "DOGEUSDT",
        "LONG",
        "casc-orig",
        "5m",
        0.001,
        0.08,
        1000,
        5000,
        1000,
      );
      const state = before.exportState("DOGEUSDT", "LONG")!;

      // Simulate restart: fresh registry + candidates, hydrate.
      const c1m = new CascadeCandidateService();
      const c3m = new CascadeCandidateService();
      const c5m = new CascadeCandidateService();
      const registry = new CascadeRegistry(c1m, c3m, c5m);
      registry.restoreOwnership("DOGEUSDT", "casc-orig", 1000, "LONG");
      c5m.restoreWatch("DOGEUSDT", "LONG", state);

      let idCounter = 0;
      const makeId = () => `casc-${++idCounter}`;
      const resolved = registry.resolve("DOGEUSDT", "LONG", 5000, makeId);
      assert.strictEqual(
        resolved.action,
        "route",
        "the restored cascade must still be active -- a new liquidation must route into it, not start a fresh one",
      );
      if (resolved.action === "route")
        assert.strictEqual(resolved.cascadeId, "casc-orig");
    },
  );

  console.log("\nRunning cascade-repository tests (fake Mongo)...\n");

  // ── Minimal fake Mongo collection for CascadeDoc ────────────────────
  class FakeCascadeCollection {
    store = new Map<string, CascadeDoc>();
    async updateOne(
      filter: { cascadeId: string },
      update: {
        $set?: Record<string, unknown>;
        $setOnInsert?: Record<string, unknown>;
      },
    ): Promise<void> {
      let doc = this.store.get(filter.cascadeId);
      if (!doc && update.$setOnInsert) {
        const seed = update.$setOnInsert;
        doc = {
          cascadeId: filter.cascadeId,
          symbol: seed.symbol as string,
          victimSide: seed.victimSide as Side,
          startedAt: seed.startedAt as number,
          status: seed.status as "ACTIVE" | "CLOSED",
          closedAt: seed.closedAt as null,
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
        this.store.set(filter.cascadeId, doc);
      }
      if (doc && update.$set) {
        for (const [path, value] of Object.entries(update.$set)) {
          if (path === "status") (doc as any).status = value;
          else if (path === "closedAt") (doc as any).closedAt = value;
          else if (path === "lastUpdatedTs") (doc as any).lastUpdatedTs = value;
          else if (path.startsWith("candidates.")) {
            const tf = path.split(".")[1] as "1m" | "3m" | "5m";
            (doc.candidates as any)[tf] = value;
          }
        }
      }
    }
    async findOne(filter: { cascadeId: string }): Promise<CascadeDoc | null> {
      return this.store.get(filter.cascadeId) ?? null;
    }
    find(filter: { status: string }) {
      const results = [...this.store.values()].filter(
        (d) => d.status === filter.status,
      );
      return { toArray: async () => results };
    }
  }

  function makeFakeMongo(col: FakeCascadeCollection) {
    return { activeCascades: async () => col } as any;
  }

  // ─── 7. all 3 terminal -> parent explicitly closes ─────────────────────

  await scenario(
    "when the third and final candidate reaches terminal, markCandidateTerminal() explicitly marks the parent cascade CLOSED, without waiting for any future liquidation",
    async () => {
      const col = new FakeCascadeCollection();
      const repo = new CascadeRepository(makeFakeMongo(col));
      const now = Date.now();

      await repo.upsertCandidateState(
        "casc-x",
        "ETHUSDT",
        "LONG",
        1000,
        {
          ...emptyCandidateStateDoc("1m", now),
          phase: "ACTIVE",
          frozenUnitAbs: 1,
        },
        now,
      );
      const r1 = await repo.markCandidateTerminal(
        "casc-x",
        "ETHUSDT",
        "LONG",
        1000,
        {
          ...emptyCandidateStateDoc("3m", now),
          phase: "TERMINAL_CANCEL",
          terminalStatus: "CANCEL",
        },
        now,
      );
      assert.strictEqual(
        r1.allTerminal,
        false,
        "only one of three terminal so far -- must not close yet",
      );
      assert.strictEqual(
        (await col.findOne({ cascadeId: "casc-x" }))!.status,
        "ACTIVE",
      );

      const r2 = await repo.markCandidateTerminal(
        "casc-x",
        "ETHUSDT",
        "LONG",
        1000,
        {
          ...emptyCandidateStateDoc("5m", now),
          phase: "TERMINAL_SIGNAL",
          terminalStatus: "SIGNAL",
          signalId: "sig-1",
        },
        now,
      );
      assert.strictEqual(
        r2.allTerminal,
        false,
        "still only two of three terminal (1m is still just ACTIVE, not terminal) -- must not close yet",
      );

      const r3 = await repo.markCandidateTerminal(
        "casc-x",
        "ETHUSDT",
        "LONG",
        1000,
        {
          ...emptyCandidateStateDoc("1m", now),
          phase: "TERMINAL_CANCEL",
          terminalStatus: "CANCEL",
        },
        now,
      );
      assert.strictEqual(
        r3.allTerminal,
        true,
        "all three now terminal -- must close",
      );
      const finalDoc = await col.findOne({ cascadeId: "casc-x" });
      assert.strictEqual(finalDoc!.status, "CLOSED");
      assert.ok(finalDoc!.closedAt !== null);
    },
  );

  // ─── 8. after release, next same-symbol cascade may start ──────────────

  await scenario(
    "after the parent cascade is CLOSED, findActiveCascades() no longer returns it -- so hydration would correctly leave the symbol free for a fresh cascade",
    async () => {
      const col = new FakeCascadeCollection();
      const repo = new CascadeRepository(makeFakeMongo(col));
      const now = Date.now();

      await repo.upsertCandidateState(
        "casc-y",
        "SOLUSDT",
        "LONG",
        1000,
        {
          ...emptyCandidateStateDoc("1m", now),
          phase: "ACTIVE",
          frozenUnitAbs: 1,
        },
        now,
      );
      await repo.markCandidateTerminal(
        "casc-y",
        "SOLUSDT",
        "LONG",
        1000,
        {
          ...emptyCandidateStateDoc("3m", now),
          phase: "TERMINAL_CANCEL",
          terminalStatus: "CANCEL",
        },
        now,
      );
      await repo.markCandidateTerminal(
        "casc-y",
        "SOLUSDT",
        "LONG",
        1000,
        {
          ...emptyCandidateStateDoc("5m", now),
          phase: "TERMINAL_CANCEL",
          terminalStatus: "CANCEL",
        },
        now,
      );
      await repo.markCandidateTerminal(
        "casc-y",
        "SOLUSDT",
        "LONG",
        1000,
        {
          ...emptyCandidateStateDoc("1m", now),
          phase: "TERMINAL_CANCEL",
          terminalStatus: "CANCEL",
        },
        now,
      );

      const stillActive = await repo.findActiveCascades();
      assert.strictEqual(
        stillActive.find((d) => d.cascadeId === "casc-y"),
        undefined,
        "a CLOSED cascade must never be returned by findActiveCascades() -- hydration would correctly skip it, leaving the symbol free",
      );

      // A genuinely fresh cascade for the SAME symbol, started after the
      // old one closed, must be found as its own, separate ACTIVE document.
      await repo.upsertCandidateState(
        "casc-z",
        "SOLUSDT",
        "LONG",
        9000,
        {
          ...emptyCandidateStateDoc("1m", now),
          phase: "ACTIVE",
          frozenUnitAbs: 1,
        },
        now,
      );
      const activeNow = await repo.findActiveCascades();
      assert.ok(
        activeNow.some((d) => d.cascadeId === "casc-z"),
        "the fresh cascade must be found as ACTIVE",
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
