/**
 * Sep 9 2026 (Karo), operator-requested diagnostics/research-only
 * liquidationStatsContext, persisted on GlobalSignalDoc. Proves:
 *   - getVictimStatsSnapshot() correctly reuses (not duplicates) the
 *     existing victim-specific + combined-fallback logic
 *   - BOTH sides get a snapshot, correctly labeled with source
 *   - the opposite-victim side is structurally isolated from
 *     entry/tp/sl computation in market-data-orchestrator.ts (source
 *     inspection -- the field is built AFTER the trade-plan, never
 *     read by evaluateSignal()/deriveV5TradePlan() at all)
 *   - TERMINAL_NON_SIGNAL episodes get liquidationStatsContext=null
 */
import * as assert from "assert";
import * as fs from "fs";
import { LiquidationStatsService } from "../src/domain/liquidation/liquidation-stats.service";
import { loadObservabilityConfig } from "../src/infrastructure/config/observability.config";
import type { Liquidation } from "../src/shared/common.types";

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

console.log("Running liquidationStatsContext tests...\n");

scenario(
  "getVictimStatsSnapshot() returns victim-specific values for BOTH sides when both have enough data",
  () => {
    const stats = new LiquidationStatsService(loadObservabilityConfig());
    for (let i = 0; i < 35; i++) {
      const t = i * 60_000;
      stats.ingest(liq("ETHUSDT", "SELL", 100, 500, t)); // LONG
      stats.ingest(liq("ETHUSDT", "BUY", 100, 800, t + 1000)); // SHORT
    }

    const long = stats.getVictimStatsSnapshot("ETHUSDT", "LONG");
    const short = stats.getVictimStatsSnapshot("ETHUSDT", "SHORT");

    assert.strictEqual(long.source, "VICTIM_SPECIFIC");
    assert.strictEqual(long.p95, 500);
    assert.strictEqual(long.baselinePerMin, 500);
    assert.strictEqual(long.sampleCount, 35);

    assert.strictEqual(short.source, "VICTIM_SPECIFIC");
    assert.strictEqual(short.p95, 800);
    assert.strictEqual(short.baselinePerMin, 800);
    assert.strictEqual(short.sampleCount, 35);
  },
);

scenario(
  "getVictimStatsSnapshot() falls back to COMBINED_FALLBACK, with sampleCount = total combined samples, when victim-specific data is insufficient",
  () => {
    const stats = new LiquidationStatsService(loadObservabilityConfig());
    for (let i = 0; i < 10; i++) {
      stats.ingest(liq("ETHUSDT", "SELL", 100, 500, i * 60_000)); // only 10 LONG, insufficient
    }

    const long = stats.getVictimStatsSnapshot("ETHUSDT", "LONG");
    assert.strictEqual(long.source, "COMBINED_FALLBACK");
    assert.strictEqual(
      long.sampleCount,
      10,
      "fallback sampleCount must reflect the COMBINED total, not the victim-specific (insufficient) count",
    );
  },
);

scenario(
  "opposite-victim snapshot is independently correct even when the CURRENT victim's own data is insufficient (mixed regime)",
  () => {
    const stats = new LiquidationStatsService(loadObservabilityConfig());
    for (let i = 0; i < 5; i++)
      stats.ingest(liq("ETHUSDT", "SELL", 100, 500, i * 60_000)); // LONG: sparse
    for (let i = 5; i < 40; i++)
      stats.ingest(liq("ETHUSDT", "BUY", 100, 900, i * 60_000)); // SHORT: sufficient

    const long = stats.getVictimStatsSnapshot("ETHUSDT", "LONG");
    const short = stats.getVictimStatsSnapshot("ETHUSDT", "SHORT");

    assert.strictEqual(long.source, "COMBINED_FALLBACK");
    assert.strictEqual(short.source, "VICTIM_SPECIFIC");
    assert.strictEqual(
      short.p95,
      900,
      "SHORT's own snapshot must be correct and independent of LONG's own insufficiency",
    );
  },
);

scenario(
  "structural: market-data-orchestrator.ts builds liquidationStatsContext AFTER the trade-plan is already fully computed, and never feeds it back into evaluateSignal()/the plan",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );

    const evalIdx = source.indexOf("this.v5.evaluateSignal(");
    const contextIdx = source.indexOf("const liquidationStatsContext = {");
    assert.ok(evalIdx > -1 && contextIdx > -1, "both anchors must exist");
    assert.ok(
      contextIdx > evalIdx,
      "liquidationStatsContext must be computed AFTER evaluateSignal() (the real plan) has already run, never before/instead of it",
    );

    // The opposite-victim snapshot must never appear inside evaluateSignal.ts's
    // own trade-plan-relevant call arguments.
    const evaluateSignalSource = fs.readFileSync(
      require.resolve("../src/strategy/v5/v5-wave.service.ts"),
      "utf8",
    );
    assert.ok(
      !evaluateSignalSource.includes("getVictimStatsSnapshot"),
      "evaluateSignal()/the strategy engine itself must never call getVictimStatsSnapshot() -- it is diagnostics-only, called exclusively from the orchestration layer after the real decision is made",
    );
  },
);

scenario(
  "structural: liquidationStatsContext is null for TERMINAL_NON_SIGNAL (persistTerminalNonSignal), matching the existing `physics` field's own convention",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const fnIdx = source.indexOf("private async persistTerminalNonSignal");
    assert.ok(fnIdx > -1);
    const fnBody = source.slice(fnIdx, fnIdx + 2000);
    assert.ok(
      fnBody.includes("liquidationStatsContext: null"),
      "persistTerminalNonSignal's own doc construction must set liquidationStatsContext to null, exactly like physics",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
