/**
 * Sep 8 2026 (Karo). Adapted from liqwatch-bot's own
 * src/tools/binance-execution-v5-dispatch-tests.ts. planForSymbol()
 * here has exactly ONE path -- no per-symbol dispatch branch exists.
 *
 * Sep 9 2026 (Karo), operator-designed structural SL/TP rewrite --
 * planForSymbol() now calls deriveStructuralTradePlan() (w2ExtremePrice/
 * unitAbs), REPLACING the old cumLiq/liqBaseline/atr15mPct/walls-based
 * deriveLiquidityTradePlan() call this file used to test. Updated to
 * the new signature; the "no per-symbol dispatch" invariant itself is
 * unchanged and still verified.
 */
import * as assert from "assert";
import { planForSymbol } from "../src/infrastructure/binance/binance-execution.service";

let passed = 0;
let failed = 0;

function scenario(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

console.log("Running binance-execution planForSymbol tests...\n");

scenario(
  "planForSymbol reaches a VALID plan for a realistic V5-scale signal (SOLUSDT, structural W2extreme/UNIT geometry)",
  () => {
    const result = planForSymbol({
      entry: 102.725,
      side: "LONG",
      symbol: "SOLUSDT",
      w2ExtremePrice: 102.4,
      unitAbs: 0.325,
    });
    assert.strictEqual(
      result.ok,
      true,
      `expected a valid plan, got cancelReason=${!result.ok ? result.cancelReason : "n/a"}`,
    );
  },
);

scenario(
  "planForSymbol correctly rejects invalid/degenerate structural input (entry landing exactly on softExitPrice) as a specific cancelReason, same guard deriveStructuralTradePlan itself enforces",
  () => {
    const unitAbs = 0.325;
    const w2ExtremePrice = 102.4;
    const degenerateEntry = w2ExtremePrice + 0.4 * unitAbs;
    const result = planForSymbol({
      entry: degenerateEntry,
      side: "LONG",
      symbol: "SOLUSDT",
      w2ExtremePrice,
      unitAbs,
    });
    assert.strictEqual(result.ok, false);
  },
);

scenario(
  "planForSymbol behaves identically regardless of symbol -- no per-symbol dispatch branch exists anymore",
  () => {
    const a = planForSymbol({
      entry: 100.6,
      side: "LONG",
      symbol: "BTCUSDT",
      w2ExtremePrice: 100,
      unitAbs: 0.6,
    });
    const b = planForSymbol({
      entry: 100.6,
      side: "LONG",
      symbol: "SOLUSDT",
      w2ExtremePrice: 100,
      unitAbs: 0.6,
    });
    assert.strictEqual(a.ok, b.ok);
    if (a.ok && b.ok) {
      assert.strictEqual(a.tp, b.tp);
      assert.strictEqual(a.sl, b.sl);
    }
  },
);

scenario(
  "planForSymbol's own TP is EXACTLY structuralRisk x 2.2 -- proves the new structural formula, not the old liquidation-intensity one, is what actually runs here",
  () => {
    const w2ExtremePrice = 100;
    const unitAbs = 0.5;
    const entry = w2ExtremePrice + 1.0 * unitAbs;
    const result = planForSymbol({
      entry,
      side: "LONG",
      symbol: "SOLUSDT",
      w2ExtremePrice,
      unitAbs,
    });
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    const softExit = w2ExtremePrice + 0.4 * unitAbs;
    const structuralRiskPct = Math.abs(entry - softExit) / entry;
    const expectedTpPct = structuralRiskPct * 2.2;
    assert.ok(
      Math.abs(result.tpPct - expectedTpPct) < 1e-9,
      `tpPct=${result.tpPct} expected=${expectedTpPct}`,
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
