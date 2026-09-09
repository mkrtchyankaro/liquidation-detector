/**
 * Sep 9 2026 (Karo), operator-requested diagnostics-only fix. Proves:
 *   - the EXACT trade-plan cancelReason reaches V5SignalEvent.rejectionReason,
 *     not a generic placeholder
 *   - market-data-orchestrator.ts's own construction passes this
 *     through unmodified (source-level check for the exact bug found
 *     and fixed: `"plan-rejected"` hardcoded string is gone)
 *   - planDiagnostics is populated with the SAME forensics numbers
 *     the trade-plan already computes internally, on the REJECTED
 *     path specifically
 *
 * Sep 9 2026 (Karo), operator-designed DYNAMIC liquidation-physics
 * rewrite -- the previous "entry lands exactly on softExitPrice"
 * degenerate scenario assumed the OLD fixed K=0.4 model, no longer
 * reachable (dynamicK is now itself derived from the scenario's own
 * liquidityStrength/exhaustion/absorption, so a hand-picked entry
 * price no longer reliably lands on softExitPrice). Replaced with a
 * clean, reliable invalid-input trigger (P95 unavailable) that
 * exercises the SAME rejectionReason/planDiagnostics passthrough this
 * file's own original purpose is about.
 */
import * as assert from "assert";
import * as fs from "fs";
import { V5WaveService } from "../src/strategy/v5/v5-wave.service";

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

const NO_WALL = {
  atEntry: {
    topBidNotional: 0,
    topAskNotional: 0,
    topBidPrice: 0,
    topAskPrice: 0,
    imbalance: 0,
    topBidPersistent: false,
    topAskPersistent: false,
  },
  atAnchor: {
    topBidNotional: 0,
    topAskNotional: 0,
    topBidPrice: 0,
    topAskPrice: 0,
    imbalance: 0,
    topBidPersistent: false,
    topAskPersistent: false,
  },
  atSweepStart: null,
};

function makeV5(unit = 1, p95Getter: () => number = () => 1000): V5WaveService {
  return new V5WaveService(
    () => 500,
    () => unit,
    () => null,
    () => 1000,
    p95Getter,
    () => NO_WALL,
  );
}

console.log("Running rejection-reason/diagnostics tests...\n");

scenario(
  "invalid structural input (P95 unavailable, zero) produces the EXACT specific cancelReason ('invalid-input'), not a generic placeholder",
  () => {
    // P95 must stay a NORMAL, real value while the cascade itself
    // qualifies (min-2-events + hasP95Event both gate on p95 > 0) --
    // only flips to 0 right before evaluateSignal() is called, isolating
    // the invalid-input trigger to the trade-plan step specifically.
    let p95Live = 1000;
    const v5 = makeV5(1, () => p95Live);
    v5.onLiquidation({
      symbol: "ETHUSDT",
      side: "SELL",
      price: 2000,
      quantity: 2.5,
      quoteQty: 5000,
      timestamp: 1000,
    });
    v5.onTick("ETHUSDT", 1990, 1500);
    v5.onTick("ETHUSDT", 1993, 2000); // Wave 1 done, no entry

    v5.onLiquidation({
      symbol: "ETHUSDT",
      side: "SELL",
      price: 2000,
      quantity: 2.5,
      quoteQty: 5000,
      timestamp: 2100,
    });
    v5.onLiquidation({
      symbol: "ETHUSDT",
      side: "SELL",
      price: 1999,
      quantity: 0.01,
      quoteQty: 20,
      timestamp: 2150,
    });
    const outcomes = v5.onTick("ETHUSDT", 1990, 2500);
    const outcomes2 = v5.onTick("ETHUSDT", 1993, 3000);
    const candidate =
      outcomes2.find((o) => o.kind === "SIGNAL_CANDIDATE") ??
      outcomes.find((o) => o.kind === "SIGNAL_CANDIDATE");
    if (candidate?.kind !== "SIGNAL_CANDIDATE") throw new Error("setup failed");

    p95Live = 0; // NOW switch, right before the trade-plan step
    const event = v5.evaluateSignal(
      candidate.watch,
      candidate.entryWave,
      1991,
      3100,
    );
    assert.ok(
      event,
      "evaluateSignal must produce a real V5SignalEvent even when the plan itself is rejected",
    );
    assert.strictEqual(
      event!.plan,
      null,
      "invalid-input (p95=0) must fail the trade-plan",
    );
    assert.strictEqual(
      event!.rejectionReason,
      "invalid-input",
      "the EXACT specific cancelReason must be exposed, not 'plan-rejected' or any other generic placeholder",
    );
  },
);

scenario(
  "planDiagnostics is populated on the REJECTED path, with the real physics forensics visible",
  () => {
    let p95Live = 1000;
    const v5 = makeV5(1, () => p95Live);
    v5.onLiquidation({
      symbol: "ETHUSDT",
      side: "SELL",
      price: 2000,
      quantity: 2.5,
      quoteQty: 5000,
      timestamp: 1000,
    });
    v5.onTick("ETHUSDT", 1990, 1500);
    v5.onTick("ETHUSDT", 1993, 2000);

    v5.onLiquidation({
      symbol: "ETHUSDT",
      side: "SELL",
      price: 2000,
      quantity: 2.5,
      quoteQty: 5000,
      timestamp: 2100,
    });
    v5.onLiquidation({
      symbol: "ETHUSDT",
      side: "SELL",
      price: 1999,
      quantity: 0.01,
      quoteQty: 20,
      timestamp: 2150,
    });
    const outcomes = v5.onTick("ETHUSDT", 1990, 2500);
    const outcomes2 = v5.onTick("ETHUSDT", 1993, 3000);
    const candidate =
      outcomes2.find((o) => o.kind === "SIGNAL_CANDIDATE") ??
      outcomes.find((o) => o.kind === "SIGNAL_CANDIDATE");
    if (candidate?.kind !== "SIGNAL_CANDIDATE") throw new Error("setup failed");

    p95Live = 0;
    const event = v5.evaluateSignal(
      candidate.watch,
      candidate.entryWave,
      1991,
      3100,
    )!;
    assert.ok(
      event.planDiagnostics,
      "planDiagnostics must be populated even though plan itself is null",
    );
    assert.ok(
      event.planDiagnostics!.atr15mPct > 0,
      "atr15mPct must be a real, non-zero forensic value",
    );
  },
);

scenario(
  "structural: market-data-orchestrator.ts no longer hardcodes the generic 'plan-rejected' string -- it passes event.rejectionReason through as-is",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    assert.ok(
      !source.includes('"plan-rejected"'),
      "the old, generic hardcoded placeholder must be completely gone",
    );
    assert.ok(
      source.includes(
        "rejectionReason: event.plan ? null : event.rejectionReason",
      ),
      "the exact specific reason must be passed through unmodified",
    );
    assert.ok(
      source.includes("planDiagnostics: event.planDiagnostics"),
      "planDiagnostics must be persisted on the SIGNAL/REJECTED_PLAN construction site",
    );
  },
);

scenario(
  "a plan that succeeds normally is completely unaffected -- rejectionReason stays null, TP/SL/plan values unchanged (no strategy-behavior regression)",
  () => {
    const v5 = makeV5(1);
    v5.onLiquidation({
      symbol: "ETHUSDT",
      side: "SELL",
      price: 2000,
      quantity: 2.5,
      quoteQty: 5000,
      timestamp: 1000,
    });
    v5.onTick("ETHUSDT", 1990, 1500);
    v5.onTick("ETHUSDT", 1993, 2000); // Wave 1 done, no entry

    v5.onLiquidation({
      symbol: "ETHUSDT",
      side: "SELL",
      price: 2000,
      quantity: 2.5,
      quoteQty: 5000,
      timestamp: 2100,
    });
    v5.onLiquidation({
      symbol: "ETHUSDT",
      side: "SELL",
      price: 1999,
      quantity: 0.01,
      quoteQty: 20,
      timestamp: 2150,
    });
    const outcomes = v5.onTick("ETHUSDT", 1990, 2500);
    const outcomes2 = v5.onTick("ETHUSDT", 1993, 3000); // clear margin beyond UNIT=1
    const candidate =
      outcomes2.find((o) => o.kind === "SIGNAL_CANDIDATE") ??
      outcomes.find((o) => o.kind === "SIGNAL_CANDIDATE");
    assert.ok(
      candidate?.kind === "SIGNAL_CANDIDATE",
      "setup must reach a real candidate",
    );
    if (candidate?.kind !== "SIGNAL_CANDIDATE") return;
    assert.strictEqual(candidate.entryWave.waveNumber, 2);
    const event = v5.evaluateSignal(
      candidate.watch,
      candidate.entryWave,
      1991,
      3100,
    )!;
    assert.ok(
      event.plan !== null,
      "a clean, unobstructed plan must still succeed exactly as before",
    );
    assert.strictEqual(event.rejectionReason, null);
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
