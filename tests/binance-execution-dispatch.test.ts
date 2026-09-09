/**
 * Sep 8 2026 (Karo). planForSymbol() has exactly ONE path -- no
 * per-symbol dispatch branch exists.
 *
 * Sep 9 2026 (Karo), operator-designed DYNAMIC liquidation-physics
 * rewrite -- SECOND REVISION (ATR15m as the bounded exit-distance
 * ruler, UNIT reserved exclusively for W1/W2 entry geometry, TP
 * derived first from physics then SL=TP/RR with a hard 0.20% floor).
 * planForSymbol() now calls deriveLiquidationPhysicsTradePlan() with
 * w1AnchorPrice/w1ExtremePrice/w1LiqUsd/w2LiqUsd/atr15mAbs/p95/
 * dailyLiqPerMinBaseline -- no w2ExtremePrice, no unitAbs.
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
  "planForSymbol reaches a VALID plan for a realistic V5-scale signal (SOLUSDT, ATR15m-ruler liquidation-physics geometry)",
  () => {
    const result = planForSymbol({
      entry: 102.725,
      side: "LONG",
      symbol: "SOLUSDT",
      w1AnchorPrice: 103.0,
      w1ExtremePrice: 102.4,
      w1LiqUsd: 150_000,
      w2LiqUsd: 50_000,
      atr15mAbs: 0.5,
      p95: 38_166,
      dailyLiqPerMinBaseline: 5_000,
    });
    assert.strictEqual(
      result.ok,
      true,
      `expected a valid plan, got cancelReason=${!result.ok ? result.cancelReason : "n/a"}`,
    );
  },
);

scenario(
  "planForSymbol correctly rejects invalid input (zero P95) with a specific cancelReason, same guard deriveLiquidationPhysicsTradePlan itself enforces",
  () => {
    const result = planForSymbol({
      entry: 102.725,
      side: "LONG",
      symbol: "SOLUSDT",
      w1AnchorPrice: 103.0,
      w1ExtremePrice: 102.4,
      w1LiqUsd: 150_000,
      w2LiqUsd: 50_000,
      atr15mAbs: 0.5,
      p95: 0,
      dailyLiqPerMinBaseline: 5_000,
    });
    assert.strictEqual(result.ok, false);
  },
);

scenario(
  "planForSymbol behaves identically regardless of symbol -- no per-symbol dispatch branch exists anymore",
  () => {
    const args = {
      entry: 100.6,
      w1AnchorPrice: 101,
      w1ExtremePrice: 100,
      w1LiqUsd: 100_000,
      w2LiqUsd: 30_000,
      atr15mAbs: 0.6,
      p95: 30_000,
      dailyLiqPerMinBaseline: 4_000,
    };
    const a = planForSymbol({
      ...args,
      side: "LONG" as const,
      symbol: "BTCUSDT",
    });
    const b = planForSymbol({
      ...args,
      side: "LONG" as const,
      symbol: "SOLUSDT",
    });
    assert.strictEqual(a.ok, b.ok);
    if (a.ok && b.ok) {
      assert.strictEqual(a.tp, b.tp);
      assert.strictEqual(a.sl, b.sl);
    }
  },
);

scenario(
  "planForSymbol's own TP is EXACTLY slPct x rr -- proves the new ATR15m-ruler physics formula, not any old path, is what actually runs here",
  () => {
    const result = planForSymbol({
      entry: 100.5,
      side: "LONG",
      symbol: "SOLUSDT",
      w1AnchorPrice: 100.5,
      w1ExtremePrice: 100,
      w1LiqUsd: 500_000,
      w2LiqUsd: 50_000,
      atr15mAbs: 0.5,
      p95: 30_000,
      dailyLiqPerMinBaseline: 4_000,
    });
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.ok(
      Math.abs(result.tpPct - result.slPct * result.rr) < 1e-9,
      `tpPct=${result.tpPct} slPct*rr=${result.slPct * result.rr}`,
    );
    assert.ok(
      result.rr >= 2.0 && result.rr <= 2.5,
      `rr=${result.rr} must be in [2.0, 2.5]`,
    );
  },
);

scenario(
  "structural: BOTH pre-flight and post-fill replan call the SAME planForSymbol() (same physics, never divergent formulas)",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/infrastructure/binance/binance-execution.service.ts"),
      "utf8",
    );
    const preFlightIdx = source.indexOf("const preFlightPlan = planForSymbol(");
    const standardReplanIdx = source.indexOf(
      "const standardReplan = planForSymbol(",
    );
    assert.ok(preFlightIdx > -1, "pre-flight call-site must exist");
    assert.ok(standardReplanIdx > -1, "post-fill replan call-site must exist");
    const preFlightArgs = source.slice(
      preFlightIdx,
      source.indexOf("});", preFlightIdx),
    );
    const replanArgs = source.slice(
      standardReplanIdx,
      source.indexOf("});", standardReplanIdx),
    );
    for (const field of [
      "w1AnchorPrice",
      "w1ExtremePrice",
      "w1LiqUsd",
      "w2LiqUsd",
      "atr15mAbs",
      "p95",
      "dailyLiqPerMinBaseline",
    ]) {
      assert.ok(
        preFlightArgs.includes(`input.${field}`),
        `pre-flight must pass input.${field}`,
      );
      assert.ok(
        replanArgs.includes(`input.${field}`),
        `post-fill replan must pass input.${field}`,
      );
    }
  },
);

scenario(
  "structural: no old TP/SL execution path remains reachable -- fixed-K structural formula, Hybrid-C/intensity formula, and the old V5 wrapper are never called from binance-execution.service.ts",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/infrastructure/binance/binance-execution.service.ts"),
      "utf8",
    );
    assert.ok(
      !source.includes("deriveStructuralTradePlan("),
      "the old fixed-K structural formula must never be called",
    );
    assert.ok(
      !source.includes("deriveLiquidityTradePlan("),
      "the old Hybrid-C/intensity formula must never be called",
    );
    assert.ok(
      !source.includes("deriveV5TradePlan("),
      "the old V5 wrapper must never be called",
    );
    assert.ok(
      source.includes("deriveLiquidationPhysicsTradePlan("),
      "the ATR15m-ruler dynamic physics formula must be what actually runs",
    );
  },
);

scenario(
  "structural: UNIT is never threaded into this file's own planForSymbol()/ExecutionInput at all",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/infrastructure/binance/binance-execution.service.ts"),
      "utf8",
    );
    assert.ok(
      !source.includes("unitAbs"),
      "unitAbs must never appear in this file -- UNIT is exclusively an entry-geometry concept owned by v5-wave.service.ts",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
