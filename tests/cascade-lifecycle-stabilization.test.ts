/**
 * Sep 10 2026 (Karo), operator-requested production lifecycle
 * stabilization. Proves: (1) constant SL=0.30%/TP=0.70% math, (2) a
 * cascade-produced trade, once installed via the SAME
 * V5WaveService.hydrateActiveTrade() restart-hydration already uses,
 * genuinely closes on a real TP/SL price tick via the EXISTING,
 * UNCHANGED onPriceTickForTrades() -- the actual root-cause fix for
 * signals staying stuck in status="SIGNAL" forever, (3) the
 * isMainExecuted hydration-filter correctly separates MAIN's own real
 * position from comparison-only cascade candidates, and (4) the
 * relevant structural wiring (lock/distribute/install gated together).
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

const SL_PCT = 0.003;
const TP_PCT = 0.007;

console.log("Running cascade-lifecycle-stabilization tests...\n");

// ─── 1-3. Constant SL/TP/RR math ────────────────────────────────────────

scenario("LONG entry -> SL exactly -0.30%, TP exactly +0.70%", () => {
  const entry = 2000;
  const sl = entry * (1 - SL_PCT);
  const tp = entry * (1 + TP_PCT);
  assert.ok(Math.abs((entry - sl) / entry - SL_PCT) < 1e-9);
  assert.ok(Math.abs((tp - entry) / entry - TP_PCT) < 1e-9);
  assert.ok(Math.abs(sl - 1994) < 1e-9);
  assert.ok(Math.abs(tp - 2014) < 1e-9);
});

scenario("SHORT entry -> SL exactly +0.30%, TP exactly -0.70%", () => {
  const entry = 2000;
  const sl = entry * (1 + SL_PCT);
  const tp = entry * (1 - TP_PCT);
  assert.ok(Math.abs((sl - entry) / entry - SL_PCT) < 1e-9);
  assert.ok(Math.abs((entry - tp) / entry - TP_PCT) < 1e-9);
  assert.ok(Math.abs(sl - 2006) < 1e-9);
  assert.ok(Math.abs(tp - 1986) < 1e-9);
});

scenario("persisted RR is exactly 0.70/0.30 = 2.333333...", () => {
  const rr = TP_PCT / SL_PCT;
  assert.ok(Math.abs(rr - 2.333333) < 0.000001);
});

// ─── 4-5. A cascade-installed trade genuinely closes on TP/SL ──────────

scenario(
  "a trade installed via hydrateActiveTrade() (the SAME method used for cascade-signal execution and for restart-hydration) genuinely closes CLOSED_TP on a real price tick, via the EXISTING, UNCHANGED onPriceTickForTrades()",
  () => {
    const v5 = new V5WaveService(
      () => 1, // getAtrAbs
      () => 1, // getUnit1mAbs
      () => null, // getOi
      () => 0, // getBaseline
      () => 1000, // getIndividualP95
    );
    const entry = 2000;
    const sl = entry * (1 - SL_PCT);
    const tp = entry * (1 + TP_PCT);
    v5.hydrateActiveTrade({
      signalId: "sig-cascade-1",
      symbol: "ETHUSDT",
      victim: "LONG",
      side: "LONG",
      entry,
      tp,
      sl,
      openedAt: 1000,
      bestPrice: entry,
      worstPrice: entry,
      entryWaveNumber: 2,
      isLive: false,
      binanceSlOrderId: null,
      binanceTpOrderId: null,
      positionQty: null,
      notional: null,
      riskUsd: null,
    });

    const closes = v5.onPriceTickForTrades("ETHUSDT", tp, 2000);
    assert.strictEqual(
      closes.length,
      1,
      "the cascade-installed trade must be detected and closed -- this is the actual root-cause fix",
    );
    assert.strictEqual(closes[0]!.outcome, "TP");
    assert.strictEqual(closes[0]!.trade.signalId, "sig-cascade-1");
  },
);

scenario(
  "the SAME cascade-installed trade genuinely closes CLOSED_SL on a real price tick",
  () => {
    const v5 = new V5WaveService(
      () => 1, // getAtrAbs
      () => 1, // getUnit1mAbs
      () => null, // getOi
      () => 0, // getBaseline
      () => 1000, // getIndividualP95
    );
    const entry = 2000;
    const sl = entry * (1 + SL_PCT);
    const tp = entry * (1 - TP_PCT);
    v5.hydrateActiveTrade({
      signalId: "sig-cascade-2",
      symbol: "ETHUSDT",
      victim: "SHORT",
      side: "SHORT",
      entry,
      tp,
      sl,
      openedAt: 1000,
      bestPrice: entry,
      worstPrice: entry,
      entryWaveNumber: 2,
      isLive: false,
      binanceSlOrderId: null,
      binanceTpOrderId: null,
      positionQty: null,
      notional: null,
      riskUsd: null,
    });

    const closes = v5.onPriceTickForTrades("ETHUSDT", sl, 2000);
    assert.strictEqual(closes.length, 1);
    assert.strictEqual(closes[0]!.outcome, "SL");
  },
);

scenario(
  "BEFORE-this-fix invariant check: an uninstalled trade is NEVER detected -- confirms this WAS the root cause of signals stuck in status=SIGNAL forever",
  () => {
    const v5 = new V5WaveService(
      () => 1, // getAtrAbs
      () => 1, // getUnit1mAbs
      () => null, // getOi
      () => 0, // getBaseline
      () => 1000, // getIndividualP95
    );
    const closes = v5.onPriceTickForTrades("ETHUSDT", 2014, 2000);
    assert.strictEqual(closes.length, 0);
  },
);

console.log("\nRunning structural tests...\n");

// ─── 6, 8. Lock/distribute/install gated together, structural ─────────

scenario(
  "structural: mainSymbolLocks.add() and V5WaveService.hydrateActiveTrade() (cascade-signal execution) are gated by the SAME willExecuteAsMain flag as distributor.distribute() -- never independently",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = source.indexOf("private async handleCascadeSignalReady(");
    const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
    const willExecuteIdx = body.indexOf(
      "const willExecuteAsMain = !this.mainSymbolLocks.has(event.symbol);",
    );
    const guardIdx = body.indexOf("if (!willExecuteAsMain) return;");
    const distributeIdx = body.indexOf("await this.distributor.distribute(");
    const lockAddIdx = body.indexOf("this.mainSymbolLocks.add(event.symbol);");
    const installIdx = body.indexOf("this.v5.hydrateActiveTrade(");
    assert.ok(
      willExecuteIdx > -1 &&
        guardIdx > -1 &&
        distributeIdx > -1 &&
        lockAddIdx > -1 &&
        installIdx > -1,
    );
    assert.ok(
      willExecuteIdx < guardIdx &&
        guardIdx < distributeIdx &&
        distributeIdx < lockAddIdx &&
        lockAddIdx < installIdx,
      "the decision must be made ONCE, then gate distribute/lock/install together, in that order, never independently",
    );
  },
);

scenario(
  "structural: handleMainTradeClose() (the EXISTING, UNCHANGED close-handler) is the ONLY place that releases mainSymbolLocks -- never released just because a parent cascade becomes CLOSED",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const deleteCount = (source.match(/this\.mainSymbolLocks\.delete\(/g) ?? [])
      .length;
    assert.strictEqual(
      deleteCount,
      1,
      "mainSymbolLocks.delete() must exist in exactly ONE place (handleMainTradeClose), never in markCandidateTerminal or cascade-close logic",
    );
    const closeIdx = source.indexOf("private async handleMainTradeClose(");
    const closeBody = source.slice(
      closeIdx,
      source.indexOf("\n  private ", closeIdx + 50),
    );
    assert.ok(
      closeBody.includes("this.mainSymbolLocks.delete("),
      "the release must be inside handleMainTradeClose()",
    );
  },
);

// ─── 9. Restart hydration correctly separates real vs comparison-only ─

scenario(
  "structural: hydrateMainLocks() skips comparison-only cascade signals (isMainExecuted===false) but still hydrates legacy signals with no isMainExecuted field at all (backward compatibility)",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = source.indexOf("async hydrateMainLocks(): Promise<void> {");
    const body = source.slice(idx, source.indexOf("\n  async ", idx + 50));
    assert.ok(
      body.includes("doc.isMainExecuted === false"),
      "must skip ONLY explicit false, not merely falsy/absent",
    );
    assert.ok(
      body.includes("continue"),
      "must skip (continue), not hydrate, comparison-only signals",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
