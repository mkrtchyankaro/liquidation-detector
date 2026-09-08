/**
 * Sep 8 2026 (Karo). Adapted from liqwatch-bot's own
 * src/tools/binance-execution-v5-dispatch-tests.ts. That test proved
 * a V3-vs-V5 dispatch distinction (isV5Signal flag routing around a
 * V3-only physics formula) which genuinely does NOT exist in this
 * project -- planForSymbol() here has exactly ONE path
 * (deriveLiquidityTradePlan()), confirmed unreachable-otherwise
 * against the CURRENT deployed main bot (isV5Signal:true is V5's
 * ONLY call shape there too -- see MIGRATION_NOTES.md). This test
 * verifies that single, simplified path directly.
 */
import * as assert from "assert";
import { planForSymbol } from "../src/infrastructure/binance/binance-execution.service";
import type { WallSnapshots } from "../src/domain/trading/trade-plan";

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

const noWalls: WallSnapshots = {
  atEntry: { topBidNotional: 0, topAskNotional: 0, topBidPrice: 0, topAskPrice: 0, imbalance: 0, topBidPersistent: false, topAskPersistent: false },
  atAnchor: { topBidNotional: 0, topAskNotional: 0, topBidPrice: 0, topAskPrice: 0, imbalance: 0, topBidPersistent: false, topAskPersistent: false },
  atSweepStart: null,
};

console.log("Running binance-execution planForSymbol tests...\n");

scenario("planForSymbol reaches a VALID plan for a realistic V5-scale signal (SOLUSDT, no wave1Liq/wave2Liq concept at all)", () => {
  const result = planForSymbol({
    entry: 102.725,
    side: "LONG",
    symbol: "SOLUSDT",
    cumLiq: 175_086,
    liqBaseline: 38_166,
    atr15mPct: 0.362 / 100,
    walls: noWalls,
  });
  assert.strictEqual(result.ok, true, `expected a valid plan, got cancelReason=${!result.ok ? result.cancelReason : "n/a"}`);
});

scenario("planForSymbol correctly rejects invalid input (zero/negative liqBaseline) as invalid-input, same guard deriveLiquidityTradePlan itself enforces", () => {
  const result = planForSymbol({
    entry: 102.725,
    side: "LONG",
    symbol: "SOLUSDT",
    cumLiq: 175_086,
    liqBaseline: 0,
    atr15mPct: 0.362 / 100,
    walls: noWalls,
  });
  assert.strictEqual(result.ok, false);
});

scenario("planForSymbol behaves identically regardless of symbol -- no per-symbol dispatch branch exists anymore", () => {
  const a = planForSymbol({ entry: 100, side: "LONG", symbol: "BTCUSDT", cumLiq: 500_000, liqBaseline: 100_000, atr15mPct: 0.01, walls: noWalls });
  const b = planForSymbol({ entry: 100, side: "LONG", symbol: "SOLUSDT", cumLiq: 500_000, liqBaseline: 100_000, atr15mPct: 0.01, walls: noWalls });
  assert.strictEqual(a.ok, b.ok);
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
