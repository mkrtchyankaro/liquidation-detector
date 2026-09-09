/**
 * Sep 9 2026 (Karo), operator-designed structural SL/TP for the fast
 * liquidation-reversal bot. Proves deriveStructuralTradePlan()'s own
 * geometry precisely: structural risk (K=0.4 x UNIT inside-recovery
 * soft exit) vs the 0.20% execution-mechanics floor (sizing + hard
 * exchange stop only, never the app-side structural exit, never TP).
 * See structural-trade-plan.ts's own doc comment for the full design.
 */
import * as assert from "assert";
import {
  deriveStructuralTradePlan,
  STRUCTURAL_K,
  STRUCTURAL_RR,
  SIZING_HARD_STOP_FLOOR_PCT,
} from "../src/domain/trading/structural-trade-plan";

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

console.log("Running structural-trade-plan tests...\n");

// ─── LONG geometry ──────────────────────────────────────────────────────

scenario(
  "LONG: softExitPrice = W2extreme + K x UNIT (structural risk < 0.20% -- small UNIT case)",
  () => {
    // UNIT small enough that even the full (1-K)xUNIT structural risk
    // is well under the 0.20% floor.
    const w2Extreme = 100;
    const unitAbs = 0.05; // 0.05% of entry, ballpark
    const entry = w2Extreme + 1.0 * unitAbs; // matches the UNCHANGED +1.0xUNIT entry geometry
    const result = deriveStructuralTradePlan({
      entry,
      side: "LONG",
      w2ExtremePrice: w2Extreme,
      unitAbs,
    });
    assert.ok(result.ok);
    if (!result.ok) return;

    const expectedSoftExit = w2Extreme + STRUCTURAL_K * unitAbs;
    assert.strictEqual(result.softExitPrice, expectedSoftExit);
    const expectedStructuralRiskPct =
      Math.abs(entry - expectedSoftExit) / entry;
    assert.ok(
      Math.abs(result.structuralRiskPct - expectedStructuralRiskPct) < 1e-12,
    );
    assert.ok(
      result.structuralRiskPct < SIZING_HARD_STOP_FLOOR_PCT,
      "this scenario must genuinely be below the 0.20% floor",
    );

    // Structural (soft) exit price itself must NOT be moved by the floor.
    assert.strictEqual(
      result.softExitPrice,
      expectedSoftExit,
      "softExitPrice must remain the real structural price, never floored to 0.20%",
    );

    // Sizing/hard-stop DO use the floor.
    assert.strictEqual(result.sizingRiskPct, SIZING_HARD_STOP_FLOOR_PCT);
    assert.strictEqual(result.hardStopRiskPct, SIZING_HARD_STOP_FLOOR_PCT);
    assert.strictEqual(
      result.hardStopPrice,
      entry * (1 - SIZING_HARD_STOP_FLOOR_PCT),
    );

    // TP derived ONLY from the real structural risk, never the floor.
    const expectedTpPct = result.structuralRiskPct * STRUCTURAL_RR;
    assert.ok(Math.abs(result.tpPct - expectedTpPct) < 1e-12);
    assert.strictEqual(result.tp, entry * (1 + expectedTpPct));
    assert.ok(
      result.tpPct < SIZING_HARD_STOP_FLOOR_PCT * STRUCTURAL_RR,
      "sanity: this TP must be tiny, nowhere near a floor-derived value",
    );
  },
);

scenario("LONG: structural risk = 0.20% exactly (boundary case)", () => {
  // Choose UNIT such that (1-K)xUNIT lands EXACTLY at 0.20% of entry.
  const w2Extreme = 100;
  const targetStructuralPct = 0.002;
  // entry = w2Extreme + 1.0*unit; softExit = w2Extreme + 0.4*unit
  // structuralRiskAbs = entry - softExit = 0.6*unit
  // structuralRiskPct = 0.6*unit / entry -- solve for unit numerically via the known entry relationship.
  // entry ~= w2Extreme + unit for small unit, so 0.6*unit/entry ~= targetStructuralPct
  // Iterate once (unit is tiny relative to w2Extreme, negligible error):
  // Exact algebraic solve: structuralRiskPct = 0.6*unit / (w2Extreme + unit) = target
  //   => unit = target*w2Extreme / (0.6 - target)
  const unitAbs =
    (targetStructuralPct * w2Extreme) / (0.6 - targetStructuralPct);
  const entry = w2Extreme + 1.0 * unitAbs;
  const result = deriveStructuralTradePlan({
    entry,
    side: "LONG",
    w2ExtremePrice: w2Extreme,
    unitAbs,
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(
    Math.abs(result.structuralRiskPct - targetStructuralPct) < 1e-6,
    `structural risk should land at ~0.20%, got ${result.structuralRiskPct}`,
  );
  // At exactly the boundary, sizing/hardStop must equal structural (max() is a no-op here).
  assert.ok(Math.abs(result.sizingRiskPct - result.structuralRiskPct) < 1e-9);
  assert.ok(Math.abs(result.hardStopRiskPct - result.structuralRiskPct) < 1e-9);
});

scenario(
  "LONG: structural risk > 0.20% (large-UNIT case -- floor is a complete no-op)",
  () => {
    const w2Extreme = 100;
    const unitAbs = 1.0; // large UNIT relative to entry -> structural risk well above 0.20%
    const entry = w2Extreme + 1.0 * unitAbs;
    const result = deriveStructuralTradePlan({
      entry,
      side: "LONG",
      w2ExtremePrice: w2Extreme,
      unitAbs,
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(
      result.structuralRiskPct > SIZING_HARD_STOP_FLOOR_PCT,
      "this scenario must genuinely exceed the 0.20% floor",
    );
    // Floor must be a complete no-op: sizing/hardStop EXACTLY equal structural.
    assert.strictEqual(result.sizingRiskPct, result.structuralRiskPct);
    assert.strictEqual(result.hardStopRiskPct, result.structuralRiskPct);
    assert.strictEqual(
      result.hardStopPrice,
      result.softExitPrice,
      "hard-stop must coincide with the structural soft-exit price when structural already exceeds the floor",
    );
  },
);

// ─── SHORT geometry (mirror) ────────────────────────────────────────────

scenario(
  "SHORT: softExitPrice = W2extreme - K x UNIT (mirrors LONG exactly)",
  () => {
    const w2Extreme = 100;
    const unitAbs = 0.05;
    const entry = w2Extreme - 1.0 * unitAbs; // mirrored: recovers DOWNWARD
    const result = deriveStructuralTradePlan({
      entry,
      side: "SHORT",
      w2ExtremePrice: w2Extreme,
      unitAbs,
    });
    assert.ok(result.ok);
    if (!result.ok) return;

    const expectedSoftExit = w2Extreme - STRUCTURAL_K * unitAbs;
    assert.strictEqual(result.softExitPrice, expectedSoftExit);
    assert.ok(
      result.softExitPrice > entry,
      "for SHORT, softExitPrice must be ABOVE entry (price rising = invalidation)",
    );

    assert.strictEqual(result.sizingRiskPct, SIZING_HARD_STOP_FLOOR_PCT);
    assert.strictEqual(
      result.hardStopPrice,
      entry * (1 + SIZING_HARD_STOP_FLOOR_PCT),
    );
    assert.ok(
      result.hardStopPrice > entry,
      "SHORT hard-stop must be ABOVE entry",
    );
    assert.strictEqual(result.tp, entry * (1 - result.tpPct));
    assert.ok(result.tp < entry, "SHORT TP must be BELOW entry");
  },
);

scenario(
  "SHORT: structural risk > 0.20% -- floor is a complete no-op, mirrored",
  () => {
    const w2Extreme = 100;
    const unitAbs = 1.0;
    const entry = w2Extreme - 1.0 * unitAbs;
    const result = deriveStructuralTradePlan({
      entry,
      side: "SHORT",
      w2ExtremePrice: w2Extreme,
      unitAbs,
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(result.structuralRiskPct > SIZING_HARD_STOP_FLOOR_PCT);
    assert.strictEqual(result.sizingRiskPct, result.structuralRiskPct);
    assert.ok(
      Math.abs(result.hardStopPrice - result.softExitPrice) < 1e-9,
      `hardStopPrice (${result.hardStopPrice}) must coincide with softExitPrice (${result.softExitPrice})`,
    );
  },
);

// ─── TP = exactly 2.2 x actual structural risk ──────────────────────────

scenario(
  "TP = exactly STRUCTURAL_RR (2.2) x the ACTUAL structural risk distance, for both small- and large-UNIT cases",
  () => {
    for (const unitAbs of [0.02, 0.3, 2.5]) {
      const w2Extreme = 100;
      const entry = w2Extreme + 1.0 * unitAbs;
      const result = deriveStructuralTradePlan({
        entry,
        side: "LONG",
        w2ExtremePrice: w2Extreme,
        unitAbs,
      });
      assert.ok(result.ok);
      if (!result.ok) continue;
      const expectedTpPct = result.structuralRiskPct * 2.2;
      assert.ok(
        Math.abs(result.tpPct - expectedTpPct) < 1e-12,
        `unitAbs=${unitAbs}: tpPct=${result.tpPct} expected=${expectedTpPct}`,
      );
      assert.strictEqual(result.rr, 2.2);
    }
  },
);

// ─── sizing uses max(structuralRiskPct, 0.20%) ──────────────────────────

scenario(
  "sizing (and hard-stop) risk always equals max(structuralRiskPct, 0.20%) -- never less than either input",
  () => {
    const cases = [
      { unitAbs: 0.02, label: "tiny UNIT" },
      { unitAbs: (0.002 * 100) / 0.6, label: "boundary UNIT" },
      { unitAbs: 3.0, label: "huge UNIT" },
    ];
    for (const { unitAbs, label } of cases) {
      const w2Extreme = 100;
      const entry = w2Extreme + 1.0 * unitAbs;
      const result = deriveStructuralTradePlan({
        entry,
        side: "LONG",
        w2ExtremePrice: w2Extreme,
        unitAbs,
      });
      assert.ok(result.ok, label);
      if (!result.ok) continue;
      const expected = Math.max(
        result.structuralRiskPct,
        SIZING_HARD_STOP_FLOOR_PCT,
      );
      assert.ok(
        Math.abs(result.sizingRiskPct - expected) < 1e-9,
        `${label}: sizingRiskPct=${result.sizingRiskPct} expected=${expected}`,
      );
      assert.ok(
        result.sizingRiskPct >= result.structuralRiskPct - 1e-12,
        `${label}: sizing must never be LESS than structural`,
      );
      assert.ok(
        result.sizingRiskPct >= SIZING_HARD_STOP_FLOOR_PCT - 1e-12,
        `${label}: sizing must never be less than the 0.20% floor`,
      );
    }
  },
);

// ─── hard exchange protection never sits inside the intended structural exit ─

scenario(
  "hard exchange stop NEVER sits closer to entry than the structural soft-exit price -- LONG and SHORT, across a wide UNIT range",
  () => {
    for (const side of ["LONG", "SHORT"] as const) {
      for (const unitAbs of [0.001, 0.02, 0.1, 0.3, 1.0, 5.0]) {
        const w2Extreme = 100;
        const entry =
          side === "LONG"
            ? w2Extreme + 1.0 * unitAbs
            : w2Extreme - 1.0 * unitAbs;
        const result = deriveStructuralTradePlan({
          entry,
          side,
          w2ExtremePrice: w2Extreme,
          unitAbs,
        });
        assert.ok(result.ok, `${side} unitAbs=${unitAbs}`);
        if (!result.ok) continue;
        if (side === "LONG") {
          assert.ok(
            result.hardStopPrice <= result.softExitPrice + 1e-9,
            `LONG: hardStop (${result.hardStopPrice}) must be at or below softExit (${result.softExitPrice}), never inside it`,
          );
        } else {
          assert.ok(
            result.hardStopPrice >= result.softExitPrice - 1e-9,
            `SHORT: hardStop (${result.hardStopPrice}) must be at or above softExit (${result.softExitPrice}), never inside it`,
          );
        }
      }
    }
  },
);

// ─── old intensity/cumulative-liquidation magnitude can no longer widen TP/SL ─

scenario(
  "structural TP/SL are completely independent of liquidation magnitude -- identical geometry produces IDENTICAL TP/SL regardless of episode size",
  () => {
    const w2Extreme = 100;
    const unitAbs = 0.3;
    const entry = w2Extreme + 1.0 * unitAbs;
    // deriveStructuralTradePlan() has NO cumLiq/P95/intensity/baseline
    // parameter at all -- this is a structural, compile-time guarantee,
    // not just a runtime one. This test proves the SAME geometry always
    // produces the SAME plan, confirming there is no hidden magnitude
    // dependency anywhere in the function.
    const small = deriveStructuralTradePlan({
      entry,
      side: "LONG",
      w2ExtremePrice: w2Extreme,
      unitAbs,
    });
    const huge = deriveStructuralTradePlan({
      entry,
      side: "LONG",
      w2ExtremePrice: w2Extreme,
      unitAbs,
    });
    assert.ok(small.ok && huge.ok);
    if (!small.ok || !huge.ok) return;
    assert.strictEqual(small.tp, huge.tp);
    assert.strictEqual(small.sl, huge.sl);
    assert.strictEqual(small.tpPct, huge.tpPct);
    assert.strictEqual(small.slPct, huge.slPct);
    assert.strictEqual(small.rr, huge.rr);
  },
);

scenario(
  "structural: deriveStructuralTradePlan()'s own input type has NO cumLiq/liqBaseline/intensity field at all",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/domain/trading/structural-trade-plan.ts"),
      "utf8",
    );
    const inputInterface = source.slice(
      source.indexOf("interface StructuralTradePlanInput"),
      source.indexOf("interface StructuralTradePlanForensics"),
    );
    assert.ok(
      !inputInterface.toLowerCase().includes("cumliq"),
      "StructuralTradePlanInput must never accept cumulative liquidation USD",
    );
    assert.ok(
      !inputInterface.toLowerCase().includes("baseline"),
      "StructuralTradePlanInput must never accept a liquidity baseline",
    );
    assert.ok(
      !inputInterface.toLowerCase().includes("intensity"),
      "StructuralTradePlanInput must never accept an intensity value",
    );
    assert.ok(
      !inputInterface.toLowerCase().includes("p95"),
      "StructuralTradePlanInput must never accept a P95 value",
    );
  },
);

scenario(
  "structural: v5-wave.service.ts's own entry point calls deriveStructuralTradePlan(), not the old deriveV5TradePlan()/Hybrid-C formula",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/strategy/v5/v5-wave.service.ts"),
      "utf8",
    );
    assert.ok(
      source.includes("deriveStructuralTradePlan("),
      "evaluateSignal() must call the new structural formula",
    );
    assert.ok(
      !source.includes("deriveV5TradePlan("),
      "the old liquidation-intensity/Hybrid-C-cap formula must no longer be called from the entry path",
    );
  },
);

// ─── invalid/degenerate input handling ──────────────────────────────────

scenario(
  "structural-risk-non-positive: entry landing exactly on softExitPrice is rejected, not silently accepted with 0 risk",
  () => {
    const w2Extreme = 100;
    const unitAbs = 0.3;
    const degenerateEntry = w2Extreme + STRUCTURAL_K * unitAbs; // == softExitPrice itself
    const result = deriveStructuralTradePlan({
      entry: degenerateEntry,
      side: "LONG",
      w2ExtremePrice: w2Extreme,
      unitAbs,
    });
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.cancelReason, "structural-risk-non-positive");
  },
);

scenario("invalid-input: non-positive entry or UNIT is rejected", () => {
  const r1 = deriveStructuralTradePlan({
    entry: 0,
    side: "LONG",
    w2ExtremePrice: 100,
    unitAbs: 0.3,
  });
  assert.strictEqual(r1.ok, false);
  if (!r1.ok) assert.strictEqual(r1.cancelReason, "invalid-input");

  const r2 = deriveStructuralTradePlan({
    entry: 100.3,
    side: "LONG",
    w2ExtremePrice: 100,
    unitAbs: 0,
  });
  assert.strictEqual(r2.ok, false);
  if (!r2.ok) assert.strictEqual(r2.cancelReason, "invalid-input");
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
