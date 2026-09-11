/**
 * Sep 10 2026 (Karo), operator-requested production V5 multi-timeframe
 * cascade lifecycle -- PURELY ADDITIVE feature. Tests the wave-
 * lifecycle state machine (CascadeCandidateService) and the symbol-
 * level ownership registry (CascadeRegistry) directly, plus a
 * structural check confirming mainSymbolLocks is genuinely respected
 * by the new signal-ready path in market-data-orchestrator.ts.
 */
import * as assert from "assert";
import * as fs from "fs";
import { CascadeCandidateService } from "../src/domain/cascade/cascade-candidate.service";
import { CascadeRegistry } from "../src/domain/cascade/cascade-registry";
import type { Liquidation, Side } from "../src/shared/common.types";

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

console.log("Running cascade-candidate tests...\n");

// ─── Wave lifecycle -- W1 never signals ────────────────────────────────

scenario(
  "W1 completing (1x UNIT recovery) never produces a signal-ready or cancel result",
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
    const result = c.onTick("ETHUSDT", "LONG", 2001, 2000); // 1x UNIT recovery -> W1 completes
    assert.strictEqual(
      result,
      null,
      "W1 completing must never itself be a terminal result",
    );
    const peek = c.peekWatch("ETHUSDT", "LONG");
    assert.ok(peek);
    assert.strictEqual(peek!.waveCount, 1);
    assert.strictEqual(peek!.phase, "WAITING_NEXT_WAVE");
  },
);

// ─── Wave lifecycle -- W1 cancel (2x UNIT, no Wave 2) ──────────────────

scenario(
  "W1 completes then 2x-UNIT recovery with no Wave 2 arriving cancels the candidate",
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
    c.onTick("ETHUSDT", "LONG", 2001, 2000); // W1 completes
    const result = c.onTick("ETHUSDT", "LONG", 2002, 3000); // 2x UNIT -> CANCEL
    assert.ok(result && !("entryPrice" in result));
    assert.strictEqual((result as any).reason, "CANCEL_NO_NEXT_WAVE");
    assert.strictEqual(
      c.peekWatch("ETHUSDT", "LONG"),
      null,
      "candidate must now be terminal",
    );
  },
);

// ─── Wave lifecycle -- W2 <= W1 -> SIGNAL_READY ────────────────────────

scenario(
  "Wave 2 completing with liqUsd <= Wave 1's own liqUsd is immediately SIGNAL-READY",
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
      8000,
      1000,
    ); // W1 liq = 8000
    c.onTick("ETHUSDT", "LONG", 2001, 2000); // W1 completes
    c.onLiquidation(liq("ETHUSDT", "SELL", 2001, 3000, 2500), "LONG"); // Wave 2 starts, liq=3000 (<= 8000)
    const result = c.onTick("ETHUSDT", "LONG", 2002, 3000); // Wave 2 completes (1x UNIT recovery)
    assert.ok(
      result && "entryPrice" in result,
      "must be signal-ready, not cancel",
    );
    const signal = result as any;
    assert.strictEqual(signal.waveHistory.length, 2);
    assert.strictEqual(signal.waveHistory[1].liqUsd, 3000);
    assert.strictEqual(signal.entryPrice, 2002);
  },
);

// ─── Operator-requested: 6 dedicated production-wave-rule scenarios ───

function driveCascadeToWave(
  unitAbs: number,
  waveLiqs: number[],
): CascadeCandidateService {
  const c = new CascadeCandidateService();
  c.startCascade(
    "ETHUSDT",
    "LONG",
    "casc-rule",
    "1m",
    unitAbs,
    2000,
    1000,
    waveLiqs[0]!,
    1000,
  );
  let price = 2000;
  let ts = 1000;
  // Complete Wave 1, then every intermediate wave, one at a time --
  // the NEXT wave only genuinely starts (as its own, separate wave)
  // once the PREVIOUS one has actually reached COMPLETED via its own
  // onTick() call; starting it via onLiquidation while the previous
  // wave is still ACTIVE would just accumulate into that SAME wave
  // instead of creating a new one.
  for (let i = 0; i < waveLiqs.length - 1; i++) {
    price += unitAbs; // exactly 1x UNIT recovery from the current extreme -- completes this wave
    ts += 500;
    c.onTick("ETHUSDT", "LONG", price, ts);
    price -= 1; // next wave's own anchor, slightly deeper than the completed wave's own extreme
    ts += 500;
    c.onLiquidation(
      liq("ETHUSDT", "SELL", price, waveLiqs[i + 1]!, ts),
      "LONG",
    );
  }
  return c;
}

scenario("1. W2 < W1 -> SIGNAL_READY", () => {
  const c = driveCascadeToWave(1, [10_000, 5_000]);
  const result = c.onTick("ETHUSDT", "LONG", 2002, 3000);
  assert.ok(result && "entryPrice" in result, "W2 < W1 must signal");
});

scenario(
  "2. W2 = W1 (exact equality) -> SIGNAL_READY -- always signals now, equality is not a special case anymore",
  () => {
    const c = driveCascadeToWave(1, [10_000, 10_000]);
    const result = c.onTick("ETHUSDT", "LONG", 2002, 3000);
    assert.ok(result && "entryPrice" in result, "W2 = W1 must signal");
  },
);

// Sep 10 2026 (Karo), operator-requested DETERMINISTIC production rule
// change -- the recursive Wn<=W(n-1) liquidation-size comparison is
// REMOVED entirely. W2 completing its own 1x-UNIT recovery is now,
// by itself, ALWAYS sufficient for SIGNAL_READY, regardless of W2's
// own size relative to W1. There is no production W3+ path anymore.

scenario(
  "3 (was: W2 > W1 waits for W3). W2 > W1 -> SIGNAL_READY anyway -- W2 liquidation size no longer gates entry at all",
  () => {
    const c = driveCascadeToWave(1, [10_000, 15_000]);
    const result = c.onTick("ETHUSDT", "LONG", 2002, 3000);
    assert.ok(
      result && "entryPrice" in result,
      "W2 > W1 must ALSO signal now -- the recursive comparison is removed",
    );
  },
);

scenario(
  "H. No W3 is required for ENTRY -- a candidate can only ever reach waveHistory.length===2 before becoming terminal (SIGNAL)",
  () => {
    const c = driveCascadeToWave(1, [10_000, 999_999_999]); // W2 enormously larger than W1
    const result = c.onTick("ETHUSDT", "LONG", 2002, 3000) as any;
    assert.ok(result && "entryPrice" in result);
    assert.strictEqual(
      result.waveHistory.length,
      2,
      "W2 completion must signal immediately -- no W3 is ever awaited or required",
    );
  },
);

scenario(
  "E. W2 arrives but has not yet completed its own 1x UNIT recovery -> NO SIGNAL",
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
    c.onTick("ETHUSDT", "LONG", 2001, 2000); // W1 completes
    c.onLiquidation(liq("ETHUSDT", "SELL", 2000, 3000, 2500), "LONG"); // W2 starts
    const result = c.onTick("ETHUSDT", "LONG", 2000.5, 3000); // price has NOT moved 1x UNIT from W2's own extreme yet
    assert.strictEqual(
      result,
      null,
      "an incomplete W2 must never produce a signal",
    );
    const peek = c.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      peek!.waveCount,
      2,
      "W2 must still be tracked as ACTIVE, not yet terminal",
    );
  },
);

scenario(
  "F. Opposite-victim liquidation after W1 does NOT start W2 -- structurally guaranteed by the per-(symbol,victim) keying, never a same-watch cross-victim mutation",
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
    ); // LONG-victim watch
    c.onTick("ETHUSDT", "LONG", 2001, 2000); // W1 completes, waiting for same-victim W2
    // A SHORT-victim liquidation on the SAME symbol is routed to a
    // COMPLETELY SEPARATE (symbol,victim) watch -- it can never reach or
    // mutate the LONG-victim watch's own waves at all.
    c.onLiquidation(liq("ETHUSDT", "BUY", 2000, 3000, 2500), "SHORT");
    const longPeek = c.peekWatch("ETHUSDT", "LONG");
    assert.strictEqual(
      longPeek!.waveCount,
      1,
      "the LONG-victim watch's own wave count must be completely unaffected by a SHORT-victim liquidation",
    );
    // The LONG-victim candidate must still be waiting for a genuine
    // same-victim W2, or eventually cancel at 2x UNIT -- never signal
    // from the opposite-victim event.
    const stillWaiting = c.onTick("ETHUSDT", "LONG", 2001.5, 3000);
    assert.strictEqual(
      stillWaiting,
      null,
      "must still be waiting, not signaling, after an opposite-victim event",
    );
  },
);

// ─── peekWatch is a pure read ──────────────────────────────────────────

scenario(
  "peekWatch() never mutates state -- repeated calls return identical results",
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
    const p1 = c.peekWatch("ETHUSDT", "LONG");
    const p2 = c.peekWatch("ETHUSDT", "LONG");
    const p3 = c.peekWatch("ETHUSDT", "LONG");
    assert.deepStrictEqual(p1, p2);
    assert.deepStrictEqual(p2, p3);
  },
);

// ─── One-event wave preservation (operator-reported check) ────────────

scenario(
  "a wave with exactly ONE liquidation event is a real wave, kept in waveHistory, completes normally, and participates in the W1/W2/W3 comparison",
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
      50_000,
      1000,
    ); // W1: exactly 1 event, $50k
    const peekAfterStart = c.peekWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(
      peekAfterStart.waveHistory[0]!.liqEvents,
      1,
      "Wave 1 must show exactly 1 event, never discarded/zeroed",
    );
    assert.strictEqual(peekAfterStart.waveHistory[0]!.liqUsd, 50_000);

    c.onTick("ETHUSDT", "LONG", 2001, 2000); // Wave 1 completes -- must NOT be dropped for having 1 event
    const peekAfterW1 = c.peekWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(
      peekAfterW1.waveHistory.length,
      1,
      "the one-event Wave 1 must remain in waveHistory after completing",
    );
    assert.strictEqual(peekAfterW1.waveHistory[0]!.liqEvents, 1);

    // Wave 2, ALSO exactly one event, weaker than Wave 1 -- must
    // participate in the comparison normally and reach SIGNAL_READY.
    c.onLiquidation(liq("ETHUSDT", "SELL", 2000, 30_000, 2500), "LONG"); // single event, $30k
    const peekAfterW2Start = c.peekWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(
      peekAfterW2Start.waveHistory[1]!.liqEvents,
      1,
      "Wave 2 must ALSO show exactly 1 event, never discarded",
    );

    const result = c.onTick("ETHUSDT", "LONG", 2001, 3000); // Wave 2 completes: 30k <= 50k -> SIGNAL_READY
    assert.ok(
      result && "entryPrice" in result,
      "a one-event-per-wave cascade must still reach SIGNAL_READY normally",
    );
    const signal = result as any;
    assert.strictEqual(signal.waveHistory.length, 2);
    assert.strictEqual(
      signal.waveHistory[0].liqEvents,
      1,
      "the persisted, final waveHistory must still show Wave 1's real event count (1)",
    );
    assert.strictEqual(
      signal.waveHistory[1].liqEvents,
      1,
      "the persisted, final waveHistory must still show Wave 2's real event count (1)",
    );
  },
);

scenario(
  "structural: no minimum-event-count check exists anywhere in cascade-candidate.service.ts -- liqEvents is only ever set/incremented, never compared or gated",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/domain/cascade/cascade-candidate.service.ts"),
      "utf8",
    );
    assert.ok(
      !/liqEvents\s*[<>=!]=?\s*\d/.test(source),
      "liqEvents must never be compared against any threshold",
    );
    assert.ok(
      !source.includes("minEvents") && !source.includes("MIN_EVENTS"),
      "no min-event-count concept must exist",
    );
  },
);

function makeRegistry() {
  const c1m = new CascadeCandidateService();
  const c3m = new CascadeCandidateService();
  const c5m = new CascadeCandidateService();
  const registry = new CascadeRegistry(c1m, c3m, c5m);
  let idCounter = 0;
  const makeId = () => `casc-${++idCounter}`;
  return { c1m, c3m, c5m, registry, makeId };
}

console.log("\nRunning cascade-registry tests...\n");

// ─── One cascade per symbol, regardless of victim ──────────────────────

scenario(
  "an active LONG-victim cascade blocks a SHORT-victim liquidation on the SAME symbol from starting a second cascade",
  () => {
    const h = makeRegistry();
    const first = h.registry.resolve("DOGEUSDT", "LONG", 1000, h.makeId);
    assert.strictEqual(first.action, "start");
    if (first.action !== "start") return;
    h.c1m.startCascade(
      "DOGEUSDT",
      "LONG",
      first.cascadeId,
      "1m",
      0.001,
      0.08,
      1000,
      5000,
      1000,
    );

    const shortAttempt = h.registry.resolve(
      "DOGEUSDT",
      "SHORT",
      2000,
      h.makeId,
    );
    assert.strictEqual(shortAttempt.action, "ignore");
    assert.strictEqual(h.registry.isActive("DOGEUSDT"), true);
  },
);

// ─── Repeated same-victim liquidations route into the existing cascade ─

scenario(
  "repeated same-victim liquidations while a candidate is still tracking route into the SAME cascade, never a new one",
  () => {
    const h = makeRegistry();
    const first = h.registry.resolve("ETHUSDT", "LONG", 1000, h.makeId);
    if (first.action !== "start") throw new Error("setup failed");
    h.c1m.startCascade(
      "ETHUSDT",
      "LONG",
      first.cascadeId,
      "1m",
      1,
      2000,
      1000,
      5000,
      1000,
    );

    for (let i = 0; i < 5; i++) {
      const r = h.registry.resolve("ETHUSDT", "LONG", 1000 + i * 100, h.makeId);
      assert.strictEqual(r.action, "route");
      if (r.action === "route")
        assert.strictEqual(r.cascadeId, first.cascadeId);
    }
  },
);

// ─── Fresh cascade only after full terminal ────────────────────────────

scenario(
  "a fresh cascade may start only after ALL THREE candidates are terminal",
  () => {
    const h = makeRegistry();
    const first = h.registry.resolve("ETHUSDT", "LONG", 1000, h.makeId);
    if (first.action !== "start") throw new Error("setup failed");
    h.c1m.startCascade(
      "ETHUSDT",
      "LONG",
      first.cascadeId,
      "1m",
      1,
      2000,
      1000,
      5000,
      1000,
    );
    h.c3m.startCascade(
      "ETHUSDT",
      "LONG",
      first.cascadeId,
      "3m",
      2,
      2000,
      1000,
      5000,
      1000,
    );
    h.c5m.startCascade(
      "ETHUSDT",
      "LONG",
      first.cascadeId,
      "5m",
      3,
      2000,
      1000,
      5000,
      1000,
    );

    // Force all three terminal via a large enough move (two ticks each,
    // matching the state machine's own 1x-then-2x rule).
    h.c1m.onTick("ETHUSDT", "LONG", 2001, 1500);
    h.c1m.onTick("ETHUSDT", "LONG", 2010, 2000);
    h.c3m.onTick("ETHUSDT", "LONG", 2003, 1500);
    h.c3m.onTick("ETHUSDT", "LONG", 2010, 2000);
    h.c5m.onTick("ETHUSDT", "LONG", 2004, 1500);
    h.c5m.onTick("ETHUSDT", "LONG", 2010, 2000);

    const second = h.registry.resolve("ETHUSDT", "LONG", 5000, h.makeId);
    assert.strictEqual(
      second.action,
      "start",
      "once every candidate is terminal, a fresh cascade must be allowed",
    );
    if (second.action === "start")
      assert.notStrictEqual(second.cascadeId, first.cascadeId);
  },
);

console.log("\nRunning market-data-orchestrator wiring tests...\n");

// ─── Structural: additive-only wiring, mainSymbolLocks respected ──────

scenario(
  "structural: feedCascade() is called from the liquidation handler, BEFORE the mainSymbolLocks early-return (so cascade tracking is never paused by an existing real position)",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const handlerIdx = source.indexOf('this.ws.on("liquidation"');
    assert.ok(handlerIdx > -1);
    const handlerBody = source.slice(
      handlerIdx,
      source.indexOf('this.ws.on("bookTicker"', handlerIdx),
    );
    const feedIdx = handlerBody.indexOf("this.feedCascade(");
    const lockIdx = handlerBody.indexOf(
      "this.mainSymbolLocks.has(l.symbol)) return;",
    );
    assert.ok(
      feedIdx > -1,
      "feedCascade() call must exist in the liquidation handler",
    );
    assert.ok(
      lockIdx > -1,
      "the existing mainSymbolLocks early-return must still exist, unchanged",
    );
    assert.ok(
      feedIdx < lockIdx,
      "feedCascade() must run BEFORE the mainSymbolLocks early-return",
    );
  },
);

scenario(
  "structural: handleCascadeSignalReady() checks mainSymbolLocks BEFORE calling distributor.distribute() -- MAIN can never hold two simultaneous real positions on the same symbol",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = source.indexOf("private async handleCascadeSignalReady(");
    assert.ok(idx > -1);
    const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
    const lockCheckIdx = body.indexOf("this.mainSymbolLocks.has(event.symbol)");
    const distributeIdx = body.indexOf("this.distributor.distribute(");
    assert.ok(lockCheckIdx > -1, "must check mainSymbolLocks");
    assert.ok(distributeIdx > -1, "must call distribute()");
    assert.ok(
      lockCheckIdx < distributeIdx,
      "the lock check must run BEFORE distribute() is ever called",
    );
    assert.ok(
      body.includes("await this.globalSignalRepo.insert(globalSignal)"),
      "the candidate's own signal doc must ALWAYS be persisted (for comparison), regardless of the lock",
    );
  },
);

scenario(
  "structural: old research code (shadow3m/shadow5m, competitionShadow1m/3m/5m, dragon competition) is NEVER deleted, but its own live call-sites are disconnected -- it can no longer create/update state, influence decisions, send Telegram, declare winners, or persist new results",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    assert.ok(
      source.includes("private readonly shadow3m ="),
      "old unitResearch shadow3m must still exist, not deleted",
    );
    assert.ok(
      source.includes("private readonly shadow5m ="),
      "old unitResearch shadow5m must still exist, not deleted",
    );
    assert.ok(
      source.includes("private readonly competitionShadow1m ="),
      "old dragon-competition shadow1m must still exist, not deleted",
    );
    assert.ok(
      source.includes("private feedUnitResearchShadowAfter("),
      "the method itself must still exist, not deleted",
    );
    assert.ok(
      source.includes("private tickUnitResearchShadow("),
      "the method itself must still exist, not deleted",
    );
    // The call-sites that fed LIVE events into these methods must be
    // commented out (disconnected), never left as active calls.
    assert.ok(
      !/^\s*this\.feedUnitResearchShadowAfter\(/m.test(source),
      "feedUnitResearchShadowAfter() must NOT be actively called anywhere",
    );
    assert.ok(
      !/^\s*this\.tickUnitResearchShadow\(/m.test(source),
      "tickUnitResearchShadow() must NOT be actively called anywhere",
    );
    assert.ok(
      source.includes(
        "// this.feedUnitResearchShadowAfter(l, wasTrackedBeforeProduction);",
      ),
      "the disconnected call must be visibly commented out, not silently removed",
    );
    assert.ok(
      source.includes(
        "// this.tickUnitResearchShadow(b.symbol, mid, b.timestamp);",
      ),
      "the disconnected call must be visibly commented out, not silently removed",
    );
  },
);

scenario(
  "structural: the existing V5 production signal path (handleTickOutcome, v5.onLiquidation/onTick, distributor.distribute for the ORIGINAL path) is completely unchanged in shape",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    assert.ok(source.includes("const outcomes = this.v5.onLiquidation(l);"));
    assert.ok(
      source.includes(
        "const outcomes = this.v5.onTick(b.symbol, mid, b.timestamp);",
      ),
    );
    assert.ok(
      source.includes(
        "const closes = this.v5.onPriceTickForTrades(b.symbol, mid, b.timestamp);",
      ),
    );
    assert.ok(source.includes("private async handleTickOutcome("));
    assert.ok(source.includes("private async handleMainTradeClose("));
  },
);

scenario(
  "structural: SL/TP is derived from deriveEpisodeDisplacementTradePlan() (episode-displacement, 0.20%-0.50% execution envelope, TP=2.2R) -- never the old constant 0.30%/0.70%, never the physics formula; previousWave/triggerWave are still correctly identified for diagnostics",
  () => {
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = source.indexOf("private async handleCascadeSignalReady(");
    assert.ok(idx > -1);
    const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
    assert.ok(
      body.includes("event.waveHistory[event.waveHistory.length - 1]"),
      "triggerWave must be the LAST wave (the one that triggered signal-ready)",
    );
    assert.ok(
      body.includes("event.waveHistory[event.waveHistory.length - 2]"),
      "previousWave must be the wave immediately BEFORE the triggering one, not waveHistory[0]",
    );
    assert.ok(
      body.includes("deriveEpisodeDisplacementTradePlan("),
      "SL/TP must come from the episode-displacement formula",
    );
    assert.ok(
      !body.includes("CASCADE_FIXED_SL_PCT"),
      "the old constant 0.30% SL must be gone",
    );
    assert.ok(
      !body.includes("CASCADE_FIXED_TP_PCT"),
      "the old constant 0.70% TP must be gone",
    );
    assert.ok(
      !body.includes("deriveLiquidationPhysicsTradePlan("),
      "the OLDER physics formula must NEVER be called for cascade-signal execution",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
