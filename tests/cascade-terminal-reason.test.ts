/**
 * Sep 10 2026 (Karo), operator-requested. Proves every cascade
 * candidate terminalization persists an EXPLICIT, precise reason
 * (never a vague "CANCELLED"/"TERMINAL"), with the exact diagnostics
 * proving WHY it happened, and that this data survives restart
 * (persisted in Mongo, never re-derived from live state).
 */
import * as assert from "assert";
import { CascadeCandidateService } from "../src/domain/cascade/cascade-candidate.service";
import { CascadeRepository } from "../src/infrastructure/mongo/cascade.repository";
import {
  terminalReasonText,
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

class FakeCascadeCollection {
  store = new Map<string, CascadeDoc>();
  async updateOne(
    filter: { cascadeId: string },
    update: {
      $set?: Record<string, unknown>;
      $setOnInsert?: Record<string, unknown>;
    },
    opts?: { upsert?: boolean },
  ): Promise<void> {
    let doc = this.store.get(filter.cascadeId);
    if (!doc && opts?.upsert) {
      const seed = update.$setOnInsert ?? {};
      doc = {
        cascadeId: filter.cascadeId,
        symbol: seed.symbol as string,
        victimSide: seed.victimSide as Side,
        startedAt: seed.startedAt as number,
        status: "ACTIVE",
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
      this.store.set(filter.cascadeId, doc);
    }
    if (doc && update.$set) {
      for (const [path, value] of Object.entries(update.$set)) {
        if (path.startsWith("candidates."))
          (doc.candidates as any)[path.split(".")[1]!] = value;
        else (doc as any)[path] = value;
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

async function main(): Promise<void> {
  console.log("Running cascade-terminal-reason tests...\n");

  await scenario(
    "a CANCEL_NO_NEXT_WAVE event carries the EXACT wave extreme, frozen UNIT, cancel price, recovery distance, and recovery units -- all real, captured at the exact moment of cancellation",
    () => {
      const c = new CascadeCandidateService();
      c.startCascade(
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
      c.onTick("ETHUSDT", "LONG", 2001, 2000);
      const cancel = c.onTick("ETHUSDT", "LONG", 2003, 3000) as any;
      assert.ok(cancel && !("entryPrice" in cancel));
      assert.strictEqual(cancel.reason, "CANCEL_NO_NEXT_WAVE");
      assert.strictEqual(
        cancel.waveExtreme,
        2000,
        "must be the LAST completed wave's own real extreme",
      );
      assert.strictEqual(
        cancel.frozenUnitAbs,
        1,
        "must be the real frozen UNIT",
      );
      assert.strictEqual(
        cancel.cancelPrice,
        2003,
        "must be the real price at the moment of cancellation",
      );
      assert.strictEqual(
        cancel.recoveryDistance,
        3,
        "must be |cancelPrice - waveExtreme| = |2003-2000|",
      );
      assert.ok(
        Math.abs(cancel.recoveryUnits - 3) < 1e-9,
        "must be recoveryDistance/unitAbs = 3/1 = 3.0, always >= 2.0",
      );
      assert.strictEqual(cancel.lastCompletedWaveNumber, 1);
    },
  );

  await scenario(
    "terminalReasonText() produces a precise sentence, never the vague code alone",
    () => {
      const text: string = terminalReasonText("CANCEL_NO_NEXT_WAVE", 2.0);
      assert.strictEqual(text, "No next wave before 2.00 UNIT recovery");
      const vagueReasons = ["CANCELLED", "TERMINAL", "INVALID"];
      assert.ok(!vagueReasons.includes(text), "must never be a vague reason");
    },
  );

  console.log(
    "\nRunning persisted-diagnostics + restart-survival tests (fake Mongo)...\n",
  );

  await scenario(
    "a CANCEL terminalization persists the full, precise diagnostic set -- never just a bare status",
    async () => {
      const col = new FakeCascadeCollection();
      const repo = new CascadeRepository(makeFakeMongo(col));
      const now = Date.now();

      const cancelDoc: CascadeCandidateStateDoc = {
        timeframe: "1m",
        phase: "TERMINAL_CANCEL",
        frozenUnitAbs: 1,
        currentWaveNumber: 1,
        waveHistory: [
          {
            waveNumber: 1,
            state: "COMPLETED",
            anchorPrice: 2000,
            anchorTs: 1000,
            extremePrice: 2000,
            extremeTs: 1500,
            liqUsd: 5000,
            liqEvents: 3,
          },
        ],
        currentExtreme: 2000,
        terminalStatus: "CANCEL",
        terminalReason: "CANCEL_NO_NEXT_WAVE",
        terminalReasonText: terminalReasonText("CANCEL_NO_NEXT_WAVE", 2.5),
        cancelPrice: 2002.5,
        recoveryDistance: 2.5,
        recoveryUnits: 2.5,
        signalId: null,
        terminalAt: now,
        lastUpdatedTs: now,
      };
      await repo.markCandidateTerminal(
        "casc-x",
        "ETHUSDT",
        "LONG",
        1000,
        cancelDoc,
        now,
      );

      const persisted = await col.findOne({ cascadeId: "casc-x" });
      assert.ok(persisted);
      const c1m = persisted!.candidates["1m"];
      assert.strictEqual(c1m.terminalStatus, "CANCEL");
      assert.strictEqual(c1m.terminalReason, "CANCEL_NO_NEXT_WAVE");
      assert.strictEqual(
        c1m.terminalReasonText,
        "No next wave before 2.50 UNIT recovery",
      );
      assert.strictEqual(c1m.cancelPrice, 2002.5);
      assert.strictEqual(c1m.recoveryDistance, 2.5);
      assert.strictEqual(c1m.recoveryUnits, 2.5);
      assert.strictEqual(c1m.frozenUnitAbs, 1);
      assert.strictEqual(c1m.currentWaveNumber, 1);
      assert.strictEqual(c1m.terminalAt, now);
    },
  );

  await scenario(
    "a SIGNAL terminalization is distinguishable from a CANCEL terminalization -- different terminalStatus, terminalReason is null (not vague), signalId is set",
    async () => {
      const col = new FakeCascadeCollection();
      const repo = new CascadeRepository(makeFakeMongo(col));
      const now = Date.now();

      const signalDoc: CascadeCandidateStateDoc = {
        timeframe: "5m",
        phase: "TERMINAL_SIGNAL",
        frozenUnitAbs: 3,
        currentWaveNumber: 2,
        waveHistory: [],
        currentExtreme: 1970,
        terminalStatus: "SIGNAL",
        terminalReason: null,
        terminalReasonText: null,
        cancelPrice: null,
        recoveryDistance: null,
        recoveryUnits: null,
        signalId: "sig-abc",
        terminalAt: now,
        lastUpdatedTs: now,
      };
      await repo.markCandidateTerminal(
        "casc-y",
        "SOLUSDT",
        "SHORT",
        1000,
        signalDoc,
        now,
      );

      const persisted = await col.findOne({ cascadeId: "casc-y" });
      const c5m = persisted!.candidates["5m"];
      assert.strictEqual(c5m.terminalStatus, "SIGNAL");
      assert.strictEqual(
        c5m.terminalReason,
        null,
        "SIGNAL termination has no cancel-reason -- distinct from CANCEL",
      );
      assert.strictEqual(c5m.signalId, "sig-abc");
      assert.notStrictEqual(c5m.terminalStatus, "CANCEL");
    },
  );

  await scenario(
    "the persisted CANCEL diagnostics survive a simulated restart -- a fresh CascadeRepository instance reading the SAME underlying store still sees the exact same precise reason and numbers",
    async () => {
      const col = new FakeCascadeCollection();
      const repoBeforeRestart = new CascadeRepository(makeFakeMongo(col));
      const now = Date.now();

      const cancelDoc: CascadeCandidateStateDoc = {
        timeframe: "3m",
        phase: "TERMINAL_CANCEL",
        frozenUnitAbs: 2,
        currentWaveNumber: 1,
        waveHistory: [
          {
            waveNumber: 1,
            state: "COMPLETED",
            anchorPrice: 100,
            anchorTs: 1000,
            extremePrice: 98,
            extremeTs: 1500,
            liqUsd: 10000,
            liqEvents: 5,
          },
        ],
        currentExtreme: 98,
        terminalStatus: "CANCEL",
        terminalReason: "CANCEL_NO_NEXT_WAVE",
        terminalReasonText: terminalReasonText("CANCEL_NO_NEXT_WAVE", 2.0),
        cancelPrice: 102,
        recoveryDistance: 4,
        recoveryUnits: 2.0,
        signalId: null,
        terminalAt: now,
        lastUpdatedTs: now,
      };
      await repoBeforeRestart.markCandidateTerminal(
        "casc-z",
        "DOGEUSDT",
        "SHORT",
        1000,
        cancelDoc,
        now,
      );

      const repoAfterRestart = new CascadeRepository(makeFakeMongo(col));
      const activeCascades = await repoAfterRestart.findActiveCascades();
      const found = activeCascades.find((d) => d.cascadeId === "casc-z");
      assert.ok(
        found,
        "the cascade must still be found after the simulated restart",
      );
      const c3m = found!.candidates["3m"];
      assert.strictEqual(
        c3m.terminalReason,
        "CANCEL_NO_NEXT_WAVE",
        "the precise reason must survive restart, never lost or genericized",
      );
      assert.strictEqual(
        c3m.terminalReasonText,
        "No next wave before 2.00 UNIT recovery",
      );
      assert.strictEqual(c3m.cancelPrice, 102);
      assert.strictEqual(c3m.recoveryDistance, 4);
      assert.strictEqual(c3m.recoveryUnits, 2.0);
      assert.strictEqual(c3m.frozenUnitAbs, 2);
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
