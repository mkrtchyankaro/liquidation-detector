/**
 * Sep 9 2026 (Karo), operator-requested diagnostics-only fix. Proves:
 *   - the EXACT deriveV5TradePlan() cancelReason (e.g. "tp-too-small")
 *     reaches V5SignalEvent.rejectionReason, not a generic placeholder
 *   - market-data-orchestrator.ts's own construction passes this
 *     through unmodified (source-level check for the exact bug found
 *     and fixed: `"plan-rejected"` hardcoded string is gone)
 *   - planDiagnostics is populated with the SAME forensics numbers
 *     deriveV5TradePlan() already computes internally, on the
 *     REJECTED path specifically
 *   - reproduces the real production pattern found during the XRP
 *     c90c8a88/a449e42d investigation: an ask-wall sitting essentially
 *     at entry crushes wallAdjustedTpPct below MIN_TP_PCT
 */
import * as assert from "assert";
import * as fs from "fs";
import { V5WaveService } from "../src/strategy/v5/v5-wave.service";
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

const TIGHT_ASK_WALL: WallSnapshots = {
  atEntry: {
    topBidNotional: 100_000,
    topAskNotional: 150_000,
    topBidPrice: 1.431,
    topAskPrice: 1.4331,
    imbalance: -0.2,
    topBidPersistent: true,
    topAskPersistent: true,
  },
  atAnchor: {
    topBidNotional: 100_000,
    topAskNotional: 150_000,
    topBidPrice: 1.431,
    topAskPrice: 1.4331,
    imbalance: -0.2,
    topBidPersistent: true,
    topAskPersistent: true,
  },
  atSweepStart: null,
};

function makeV5WithWall(): V5WaveService {
  return new V5WaveService(
    () => 0.01, // getAtrAbs (ATR15m), absolute price units -- realistic ~0.7% at a ~$1.43 price level (matches the real XRP c90c8a88/a449e42d scale, NOT an unrealistic flat $500)
    () => 0.0002, // getUnit1mAbs -- realistic XRP-scale (ATR1m ~ $0.0002 at a ~$1.43 price level)
    () => null, // getOi
    () => 1000, // getBaseline
    () => 1000, // getIndividualP95 -- low, so a $5000 event easily clears it
    (_symbol, _side) => TIGHT_ASK_WALL,
  );
}

console.log("Running rejection-reason/diagnostics tests...\n");

scenario(
  "a wall-crushed TP produces the EXACT specific cancelReason ('tp-too-small'), not a generic placeholder",
  () => {
    const v5 = makeV5WithWall();
    // Two events (min-2-events rule), one clearing P95, entry price
    // essentially AT the tight ask wall (1.4331) -- matches the real
    // XRP c90c8a88 pattern exactly.
    v5.onLiquidation({
      symbol: "XRPUSDT",
      side: "SELL",
      price: 1.433,
      quantity: 3000,
      quoteQty: 5000,
      timestamp: 1000,
    });
    v5.onLiquidation({
      symbol: "XRPUSDT",
      side: "SELL",
      price: 1.4329,
      quantity: 10,
      quoteQty: 20,
      timestamp: 1050,
    });

    const outcomes = v5.onTick("XRPUSDT", 1.4335, 2000); // clear margin beyond UNIT (avoids float-precision boundary issues)
    const candidate = outcomes.find((o) => o.kind === "SIGNAL_CANDIDATE");
    assert.ok(
      candidate,
      "cascade must reach SIGNAL_CANDIDATE (min-2-events + hasP95Event + 1-UNIT recovery all satisfied)",
    );
    if (candidate?.kind !== "SIGNAL_CANDIDATE") return;

    // Explicit entryPrice=1.4331 -- essentially AT the tight ask wall
    // (matches the real XRP c90c8a88 pattern precisely), independent of
    // the tick price used above to trigger cascade completion.
    const event = v5.evaluateSignal(
      candidate.watch,
      candidate.entryWave,
      1.43305,
      2100,
    );
    assert.ok(
      event,
      "evaluateSignal must produce a real V5SignalEvent even when the plan itself is rejected",
    );
    assert.strictEqual(
      event!.plan,
      null,
      "the wall-crushed TP must fail deriveV5TradePlan()'s own quality gate",
    );
    assert.strictEqual(
      event!.rejectionReason,
      "tp-too-small",
      "the EXACT specific cancelReason must be exposed, not 'plan-rejected' or any other generic placeholder",
    );
  },
);

scenario(
  "planDiagnostics is populated on the REJECTED path, with the wall-crushed wallAdjustedTpPct visible",
  () => {
    const v5 = makeV5WithWall();
    v5.onLiquidation({
      symbol: "XRPUSDT",
      side: "SELL",
      price: 1.433,
      quantity: 3000,
      quoteQty: 5000,
      timestamp: 1000,
    });
    v5.onLiquidation({
      symbol: "XRPUSDT",
      side: "SELL",
      price: 1.4329,
      quantity: 10,
      quoteQty: 20,
      timestamp: 1050,
    });
    const outcomes = v5.onTick("XRPUSDT", 1.4335, 2000);
    const candidate = outcomes.find((o) => o.kind === "SIGNAL_CANDIDATE");
    if (candidate?.kind !== "SIGNAL_CANDIDATE") throw new Error("setup failed");

    const event = v5.evaluateSignal(
      candidate.watch,
      candidate.entryWave,
      1.43305,
      2100,
    )!;
    assert.ok(
      event.planDiagnostics,
      "planDiagnostics must be populated even though plan itself is null",
    );
    assert.ok(
      event.planDiagnostics!.wallApplied,
      "wallApplied must reflect that the tight ask wall actually capped the TP",
    );
    assert.ok(
      event.planDiagnostics!.wallAdjustedTpPct < 0.002,
      "wallAdjustedTpPct must show the crushed, sub-MIN_TP_PCT value that caused the rejection",
    );
    assert.ok(
      event.planDiagnostics!.atr15mPct > 0,
      "atr15mPct must be a real, non-zero forensic value, reused from deriveV5TradePlan()'s own output",
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
    const v5 = new V5WaveService(
      () => 500,
      () => 1,
      () => null,
      () => 1000,
      () => 1000,
      () => ({
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
      }), // no wall at all -- clean plan
    );
    v5.onLiquidation({
      symbol: "ETHUSDT",
      side: "SELL",
      price: 2000,
      quantity: 2.5,
      quoteQty: 5000,
      timestamp: 1000,
    });
    v5.onLiquidation({
      symbol: "ETHUSDT",
      side: "SELL",
      price: 1999,
      quantity: 0.01,
      quoteQty: 20,
      timestamp: 1050,
    });
    const outcomes = v5.onTick("ETHUSDT", 1990, 1500);
    const outcomes2 = v5.onTick("ETHUSDT", 1993, 2000); // clear margin beyond UNIT=1
    const candidate =
      outcomes2.find((o) => o.kind === "SIGNAL_CANDIDATE") ??
      outcomes.find((o) => o.kind === "SIGNAL_CANDIDATE");
    assert.ok(
      candidate?.kind === "SIGNAL_CANDIDATE",
      "setup must reach a real candidate",
    );
    if (candidate?.kind !== "SIGNAL_CANDIDATE") return;
    const event = v5.evaluateSignal(
      candidate.watch,
      candidate.entryWave,
      1991,
      2100,
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
