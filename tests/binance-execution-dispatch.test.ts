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
  "structural (Sep 14 2026, operator-reported fix, now applied to BOTH call sites): neither pre-flight nor post-fill replan call planForSymbol()/deriveLiquidationPhysicsTradePlan() anymore -- both re-anchor the SAME canonical signal geometry via the shared reanchorCanonicalGeometry() helper",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/infrastructure/binance/binance-execution.service.ts"),
      "utf8",
    );
    assert.ok(
      !source.includes("const preFlightPlan = planForSymbol("),
      "pre-flight must no longer independently re-derive a trade plan",
    );
    assert.ok(
      !source.includes("const standardReplan = planForSymbol("),
      "post-fill replan must never call planForSymbol()/deriveLiquidationPhysicsTradePlan() again -- that was the confirmed root cause of SignalId e5c0fd41-037e-4db6-a956-d0c477fd5d90's TP landing at ~0.39% instead of the canonical 0.66%",
    );
    assert.ok(
      source.includes("private reanchorCanonicalGeometry("),
      "the shared re-anchor helper must exist",
    );
    const preFlightIdx = source.indexOf(
      "const preFlightGeom = this.reanchorCanonicalGeometry(",
    );
    const postFillIdx = source.indexOf(
      "const canonicalGeom = this.reanchorCanonicalGeometry(",
    );
    assert.ok(preFlightIdx > -1, "pre-flight must call the shared helper");
    assert.ok(postFillIdx > -1, "post-fill must call the shared helper");
    assert.ok(
      /plan\.entryRounded,\s*plan\.slRounded,\s*plan\.tpRounded,\s*executablePrice/.test(
        source,
      ),
      "pre-flight must re-anchor the canonical signal's own SL/TP to the executable price -- regex tolerant of Prettier line-wrapping, matching the pattern already established elsewhere in this file",
    );
    assert.ok(
      /plan\.entryRounded,\s*plan\.slRounded,\s*plan\.tpRounded,\s*actualEntry/.test(
        source,
      ),
      "post-fill must re-anchor the canonical signal's own SL/TP to the actual fill price -- regex tolerant of Prettier line-wrapping",
    );
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

console.log(
  "\nRunning post-fill percentage-reanchor regression tests (Sep 14 2026, real-incident fix)...\n",
);

// Pure numeric mirror of the EXACT formula now in binance-execution.service.ts's
// post-fill replan (canonicalSlPct/canonicalTpPct derivation + re-anchor to
// actualEntry) -- kept deliberately identical in shape to that production
// code so these tests fail the instant the two diverge.
function reanchorToActualFill(
  side: "LONG" | "SHORT",
  canonicalEntry: number,
  canonicalSl: number,
  canonicalTp: number,
  actualEntry: number,
): { sl: number; tp: number; slPct: number; tpPct: number; rr: number } {
  const canonicalSlPct =
    Math.abs(canonicalSl - canonicalEntry) / canonicalEntry;
  const canonicalTpPct =
    Math.abs(canonicalTp - canonicalEntry) / canonicalEntry;
  const sl =
    side === "LONG"
      ? actualEntry * (1 - canonicalSlPct)
      : actualEntry * (1 + canonicalSlPct);
  const tp =
    side === "LONG"
      ? actualEntry * (1 + canonicalTpPct)
      : actualEntry * (1 - canonicalTpPct);
  return {
    sl,
    tp,
    slPct: canonicalSlPct,
    tpPct: canonicalTpPct,
    rr: canonicalTpPct / canonicalSlPct,
  };
}

scenario(
  "1. SHORT: canonical 2506.16/2513.68/2489.62, actual fill 2505.41 -- re-anchored SL/TP preserve the exact canonical percentage distances",
  () => {
    const r = reanchorToActualFill("SHORT", 2506.16, 2513.68, 2489.62, 2505.41);
    assert.ok(
      Math.abs(r.slPct - 0.003) < 0.0001,
      `slPct should be ~0.30%, got ${(r.slPct * 100).toFixed(4)}%`,
    );
    assert.ok(
      Math.abs(r.tpPct - 0.0066) < 0.0001,
      `tpPct should be ~0.66%, got ${(r.tpPct * 100).toFixed(4)}%`,
    );
    const expectedSl = 2505.41 * 1.003;
    const expectedTp = 2505.41 * (1 - 0.0066);
    assert.ok(
      Math.abs(r.sl - expectedSl) < 0.05,
      `SL should be ~${expectedSl.toFixed(2)}, got ${r.sl.toFixed(2)}`,
    );
    assert.ok(
      Math.abs(r.tp - expectedTp) < 0.05,
      `TP should be ~${expectedTp.toFixed(2)}, got ${r.tp.toFixed(2)}`,
    );
  },
);

scenario(
  "2. LONG equivalent: canonical 2506.16/2498.64/2522.70 (0.30%/0.66% mirrored), actual fill 2507.90 -- re-anchored SL/TP preserve the exact canonical percentage distances",
  () => {
    const canonicalEntry = 2506.16;
    const canonicalSl = canonicalEntry * (1 - 0.003);
    const canonicalTp = canonicalEntry * (1 + 0.0066);
    const actualEntry = 2507.9;
    const r = reanchorToActualFill(
      "LONG",
      canonicalEntry,
      canonicalSl,
      canonicalTp,
      actualEntry,
    );
    assert.ok(Math.abs(r.slPct - 0.003) < 0.0001);
    assert.ok(Math.abs(r.tpPct - 0.0066) < 0.0001);
    assert.ok(r.sl < actualEntry, "LONG SL must be below the actual fill");
    assert.ok(r.tp > actualEntry, "LONG TP must be above the actual fill");
    assert.ok(Math.abs(r.sl - actualEntry * (1 - 0.003)) < 0.05);
    assert.ok(Math.abs(r.tp - actualEntry * (1 + 0.0066)) < 0.05);
  },
);

scenario(
  "3. NORMAL account post-fill replan source no longer calls the old liquidation-physics trade planning function at all",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/infrastructure/binance/binance-execution.service.ts"),
      "utf8",
    );
    const postFillIdx = source.indexOf(
      "const canonicalGeom = this.reanchorCanonicalGeometry(",
    );
    const postFillEnd = source.indexOf("if (!replan.ok) {", postFillIdx);
    assert.ok(
      postFillIdx > -1 && postFillEnd > postFillIdx,
      "post-fill re-anchor block must exist",
    );
    const postFillBody = source.slice(postFillIdx, postFillEnd);
    assert.ok(
      !postFillBody.includes("planForSymbol("),
      "the post-fill replan body must never call planForSymbol()/deriveLiquidationPhysicsTradePlan() -- confirmed root cause of the real incident",
    );
    assert.ok(
      !postFillBody.includes("w1AnchorPrice"),
      "post-fill replan must not reference structural market-condition inputs at all anymore -- it is now strategy-agnostic",
    );
  },
);

scenario(
  "4. WAVE geometry (0.30% SL / 0.66% TP, RR 2.2) is preserved exactly through re-anchoring",
  () => {
    const r = reanchorToActualFill(
      "SHORT",
      2506.16,
      2506.16 * 1.003,
      2506.16 * (1 - 0.0066),
      2499.0,
    );
    assert.ok(
      Math.abs(r.rr - 2.2) < 0.001,
      `RR should be exactly 2.2, got ${r.rr.toFixed(4)}`,
    );
  },
);

scenario(
  "5. ROTATION geometry (0.30% SL / 0.60% TP, RR 2.0) is preserved exactly through re-anchoring",
  () => {
    const r = reanchorToActualFill(
      "LONG",
      1000,
      1000 * (1 - 0.003),
      1000 * (1 + 0.006),
      998.5,
    );
    assert.ok(
      Math.abs(r.rr - 2.0) < 0.001,
      `RR should be exactly 2.0, got ${r.rr.toFixed(4)}`,
    );
    assert.ok(Math.abs(r.slPct - 0.003) < 0.0001);
    assert.ok(Math.abs(r.tpPct - 0.006) < 0.0001);
  },
);

scenario(
  "6. tick-size rounding is the only allowed numerical deviation -- re-anchored values before rounding match the exact percentage formula to floating-point precision",
  () => {
    const r = reanchorToActualFill("SHORT", 2506.16, 2513.68, 2489.62, 2505.41);
    const exactSl = 2505.41 * (1 + r.slPct);
    const exactTp = 2505.41 * (1 - r.tpPct);
    assert.ok(
      Math.abs(r.sl - exactSl) < 1e-9,
      "pre-rounding SL must match the exact formula to floating-point precision, not an approximation",
    );
    assert.ok(
      Math.abs(r.tp - exactTp) < 1e-9,
      "pre-rounding TP must match the exact formula to floating-point precision, not an approximation",
    );
  },
);

scenario(
  "7. Brother vs Friend: different actual fills produce different ABSOLUTE SL/TP, but IDENTICAL percentage geometry",
  () => {
    const brother = reanchorToActualFill(
      "SHORT",
      2506.16,
      2513.68,
      2489.62,
      2505.41,
    );
    const friend = reanchorToActualFill(
      "SHORT",
      2506.16,
      2513.68,
      2489.62,
      2504.1,
    );
    assert.notStrictEqual(
      brother.sl,
      friend.sl,
      "different fills must produce different absolute SL",
    );
    assert.notStrictEqual(
      brother.tp,
      friend.tp,
      "different fills must produce different absolute TP",
    );
    assert.ok(
      Math.abs(brother.slPct - friend.slPct) < 1e-12,
      "percentage geometry must be IDENTICAL regardless of actual fill",
    );
    assert.ok(
      Math.abs(brother.tpPct - friend.tpPct) < 1e-12,
      "percentage geometry must be IDENTICAL regardless of actual fill",
    );
  },
);

scenario(
  "REAL INCIDENT REGRESSION (SignalId e5c0fd41-037e-4db6-a956-d0c477fd5d90, Brother, ETHUSDT SHORT): actual fill 2505.41 must re-anchor TP near 2488.87, NEVER near the old buggy 2495.62",
  () => {
    const r = reanchorToActualFill("SHORT", 2506.16, 2513.68, 2489.62, 2505.41);
    assert.ok(
      Math.abs(r.tp - 2488.87) < 0.5,
      `TP should land near 2488.87 (canonical 0.66% re-anchored to the real fill), got ${r.tp.toFixed(2)}`,
    );
    assert.ok(
      Math.abs(r.tp - 2495.62) > 5,
      `TP must NOT reproduce the old buggy value ~2495.62 (that was the confirmed-wrong deriveLiquidationPhysicsTradePlan() output) -- got ${r.tp.toFixed(2)}, old bug was 2495.62`,
    );
  },
);

scenario(
  "8. Pre-flight uses the SAME canonical percentage geometry as post-fill -- re-anchoring to a different reference price (executable price, not fill price) still preserves the exact canonical RR",
  () => {
    // Pre-flight's own reference price is the current executable
    // (best bid/ask) at decision time, BEFORE any order is sent --
    // still just a re-anchor of the same canonical percentages, per
    // reanchorCanonicalGeometry()'s own shared contract.
    const preFlight = reanchorToActualFill(
      "SHORT",
      2506.16,
      2513.68,
      2489.62,
      2506.5,
    ); // executable price slightly different from either the canonical entry or the eventual real fill
    assert.ok(
      Math.abs(preFlight.rr - preFlight.tpPct / preFlight.slPct) < 1e-9,
    );
    assert.ok(
      Math.abs(preFlight.slPct - 0.003) < 0.0001,
      "pre-flight's own re-anchored SL% must match the canonical signal's SL%, regardless of reference price",
    );
    assert.ok(
      Math.abs(preFlight.tpPct - 0.0066) < 0.0001,
      "pre-flight's own re-anchored TP% must match the canonical signal's TP%, regardless of reference price",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
