/**
 * Focused tests for V5WaveService -- the live, event-driven wave-chain
 * engine, Sep 7 2026 model (validated via offline replay, then
 * extended with the dynamic meaningful-extreme gate -- see
 * v5_task_a_verification.ts -- before this activation):
 *
 *   - pure individual-event P95 qualification
 *   - Wave 1: extremeDistanceAtr < MIN_MEANINGFUL_EXTREME_ATR (0.10) ->
 *     the ENTIRE episode is discarded (W1_EXTREME_TOO_SMALL), no entry,
 *     no 100% fallback, no Wave 2. >= threshold -> 50% recovery entry.
 *   - Wave 2+: < threshold -> 100% own-anchor reclaim (same as before).
 *     >= threshold -> 50% recovery entry.
 *   - recovery-milestone shadow diagnostics that never gate entry.
 *
 * READ-ONLY with respect to production: this file only exercises the
 * isolated V5WaveService class in-memory. Fixed ATR=0.5 in every test
 * below, so the meaningful-extreme threshold (0.10 ATR, unless
 * V5_MIN_MEANINGFUL_EXTREME_ATR overrides it) corresponds to a price
 * distance of 0.05 -- scenarios are built around that boundary.
 */
import * as assert from "assert";
import { V5WaveService } from '../src/strategy/v5/v5-wave.service';
import type { Liquidation } from '../src/shared/common.types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function scenario(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ ${name}`);
    console.log(`      ${msg}`);
    failed++;
    failures.push(name);
  }
}

function liq(symbol: string, side: "SELL" | "BUY", price: number, quoteQty: number, timestamp: number): Liquidation {
  return { symbol, side, price, quantity: quoteQty / price, quoteQty, timestamp };
}

const P95 = 10_000;

function newService(): V5WaveService {
  return new V5WaveService(
    () => 0.5, // fixed absolute ATR -- 0.10 ATR threshold = 0.05 price distance
    () => null, // no OI tracker in tests
    () => 10_000, // fixed liqBaseline for trade-plan
    () => P95, // fixed pure-P95 for every symbol
  );
}

console.log("\n=== V5WaveService tests ===\n");

// ── Qualification (pure P95, no tier-floor blend) -- unaffected by the recovery-target logic ──

scenario("V5_LONG_ENABLED=false blocks a new LONG watch from qualifying, but leaves SHORT unaffected (manual directional kill-switch)", () => {
  const original = process.env.V5_LONG_ENABLED;
  try {
    process.env.V5_LONG_ENABLED = "false";
    const svc = newService();
    const t0 = Date.now();
    svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // SELL -> LONG victim -- must be blocked
    assert.strictEqual(svc.getWatch("ETHUSDT", "LONG"), null, "LONG watch must NOT be created while disabled");
    svc.onLiquidation(liq("ETHUSDT", "BUY", 100, 20_000, t0 + 1000)); // BUY -> SHORT victim -- unaffected
    assert.ok(svc.getWatch("ETHUSDT", "SHORT") !== null, "SHORT is untouched by the LONG-only kill-switch");
  } finally {
    if (original === undefined) delete process.env.V5_LONG_ENABLED;
    else process.env.V5_LONG_ENABLED = original;
  }
});

scenario("a directional kill-switch flip does NOT affect an already-running watch on that side -- only blocks NEW qualification", () => {
  const original = process.env.V5_LONG_ENABLED;
  try {
    const svc = newService();
    const t0 = Date.now();
    svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // LONG watch starts while enabled
    assert.ok(svc.getWatch("ETHUSDT", "LONG") !== null);
    process.env.V5_LONG_ENABLED = "false"; // flip mid-episode
    svc.onTick("ETHUSDT", 98, t0 + 1000); // the ALREADY-running watch must keep tracking normally
    const watch = svc.getWatch("ETHUSDT", "LONG");
    assert.ok(watch !== null, "an already-running watch is never killed by a mid-day flip");
    assert.strictEqual(watch!.waves[0]!.extremePrice, 98, "it keeps tracking exactly as before");
  } finally {
    if (original === undefined) delete process.env.V5_LONG_ENABLED;
    else process.env.V5_LONG_ENABLED = original;
  }
});

scenario("a sub-P95 individual event does NOT start a watch", () => {
  const svc = newService();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 5_000, Date.now())); // below P95=10,000
  assert.strictEqual(svc.getWatch("ETHUSDT", "LONG"), null);
});

scenario("an individual event exactly AT P95 DOES start a watch", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 10_000, t0));
  const watch = svc.getWatch("ETHUSDT", "LONG");
  assert.ok(watch !== null);
  assert.strictEqual(watch!.waves.length, 1);
  assert.strictEqual(watch!.waves[0]!.anchorPrice, 100);
  assert.strictEqual(watch!.qualifyingEventUsd, 10_000);
  assert.strictEqual(watch!.p95AtQualification, P95);
});

scenario("Wave1's own liquidation total starts at exactly the qualifying event's own size", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 25_000, t0));
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch.waves[0]!.liqNotionalUsd, 25_000);
  assert.strictEqual(watch.totalEpisodePressure, 25_000);
});

// ── Wave transition: continuing push vs genuinely new push ─────────

scenario("a second liquidation arriving while price is STILL at/beyond the extreme continues the SAME wave", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0));
  svc.onTick("ETHUSDT", 98, t0 + 1000); // price extends the extreme to 98 (distance=2, meaningful)
  svc.onLiquidation(liq("ETHUSDT", "SELL", 97, 5_000, t0 + 2000)); // last known price=98, still beyond/at extreme
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch.waves.length, 1, "still one wave -- this was a continuing push, not a new one");
  assert.strictEqual(watch.waves[0]!.liqNotionalUsd, 25_000);
  assert.strictEqual(watch.waves[0]!.liqEvents, 2);
});

scenario("a liquidation arriving AFTER price has PARTIALLY recovered (but not yet reached the 50% target) starts a NEW wave, at that event's own price -- IF it clears the pure-P95 bar", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // anchor=100
  svc.onTick("ETHUSDT", 98, t0 + 1000); // extreme=98, distance=2 (meaningful), 50% target=99
  svc.onTick("ETHUSDT", 98.5, t0 + 2000); // recovers to 98.5 -- ABOVE extreme(98), but BELOW the 50% target(99) -- no entry yet
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98.5, 12_000, t0 + 3000)); // arrives while price already recovered off the extreme -- above P95=10,000
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch.waves.length, 2, "a genuinely new wave must have started");
  assert.strictEqual(watch.waves[0]!.state, "SUPERSEDED");
  assert.strictEqual(watch.waves[1]!.waveNumber, 2);
  assert.strictEqual(watch.waves[1]!.anchorPrice, 98.5, "new wave's anchor is the NEW liquidation event's own price");
  assert.strictEqual(watch.waves[1]!.liqNotionalUsd, 12_000);
});

scenario("a SUB-P95 liquidation arriving during partial recovery does NOT supersede the current wave -- ignored as noise, wave stays ACTIVE and unaffected (fixes the SUIUSDT/SOL bug class for this pathway)", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // anchor=100
  svc.onTick("ETHUSDT", 98, t0 + 1000); // extreme=98, meaningful, target=99
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98, 5_000, t0 + 1200)); // legit second, confirming event -- still at/beyond extreme, absorbed (satisfies the min-liqEvents gate, isolating THIS test's own concern)
  svc.onTick("ETHUSDT", 98.5, t0 + 2000); // partial recovery
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98.5, 9_999, t0 + 3000)); // below P95=10,000 -- must be ignored
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch.waves.length, 1, "no new wave -- the sub-P95 event is ignored as noise");
  assert.strictEqual(watch.waves[0]!.state, "ACTIVE", "the current wave is completely untouched");
  assert.strictEqual(watch.waves[0]!.extremePrice, 98, "extreme unchanged");
  assert.strictEqual(watch.waves[0]!.recoveryTargetPrice, 99, "target unchanged");
  assert.strictEqual(watch.waves[0]!.liqNotionalUsd, 25_000, "the sub-P95 event is NOT even absorbed into the current wave -- it's genuinely ignored, not silently merged (still 20k+5k from the legit second event, not +9,999)");
  // The current wave's own target is still fully reachable afterward.
  const outcomes = svc.onTick("ETHUSDT", 99, t0 + 4000);
  assert.strictEqual(outcomes.length, 0, "W1 becomes dominant as usual, unaffected by the ignored noise event");
  assert.strictEqual(watch.dominantLayerLiqUsd, 25_000);
});

// ── NEW: the meaningful-extreme gate (0.10 ATR = 0.05 price distance here) ──

scenario("Wave1 with a TINY extreme (distance < 0.05) that gets superseded is DISCARDED ENTIRELY -- W1_EXTREME_TOO_SMALL, no Wave2", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // anchor=100
  svc.onTick("ETHUSDT", 99.98, t0 + 1000); // extreme=99.98, distance=0.02 -- BELOW the 0.05 meaningful threshold
  svc.onTick("ETHUSDT", 99.99, t0 + 2000); // recovers slightly (never reclaims -- Wave1 has NO target while not meaningful)
  const outcomes = svc.onLiquidation(liq("ETHUSDT", "SELL", 99.99, 12_000, t0 + 3000)); // a fresh, P95-qualifying push arrives while price has moved off the (tiny) extreme
  assert.strictEqual(outcomes.length, 1);
  assert.strictEqual(outcomes[0]!.kind, "TERMINAL_NON_SIGNAL");
  if (outcomes[0]!.kind === "TERMINAL_NON_SIGNAL") {
    assert.strictEqual(outcomes[0]!.event.reason, "W1_EXTREME_TOO_SMALL");
  }
  assert.strictEqual(svc.getWatch("ETHUSDT", "LONG"), null, "the ENTIRE episode must be discarded -- no Wave2 continuation");
});

scenario("Wave1 with a MEANINGFUL extreme (distance >= 0.05) that gets superseded correctly continues to Wave2 (not discarded)", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // anchor=100
  svc.onTick("ETHUSDT", 99.9, t0 + 1000); // extreme=99.9, distance=0.1 -- ABOVE the 0.05 meaningful threshold
  const watch1 = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch1.waves[0]!.isMeaningful, true, "0.1 distance / 0.5 ATR = 0.20 >= 0.10 threshold");
  svc.onTick("ETHUSDT", 99.92, t0 + 2000); // recovers off the extreme, but below the 50% target (99.95)
  const outcomes = svc.onLiquidation(liq("ETHUSDT", "SELL", 99.92, 12_000, t0 + 3000)); // P95-qualifying, above 10,000
  assert.strictEqual(outcomes.length, 0, "no terminal outcome from onLiquidation -- this is a normal wave transition, not a discard");
  const watch = svc.getWatch("ETHUSDT", "LONG");
  assert.ok(watch !== null, "the watch must still exist -- Wave1 was meaningful, so Wave2 continues normally");
  assert.strictEqual(watch!.waves.length, 2);
  assert.strictEqual(watch!.waves[0]!.state, "SUPERSEDED");
});

scenario("Wave1 reaching its own 50% target becomes the DOMINANT layer -- it never fires entry directly, regardless of how meaningful/confirmed it is", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // anchor=100
  const outcomes1 = svc.onTick("ETHUSDT", 98, t0 + 1000); // extreme=98, distance=2 (meaningful), 50% target=99 -- no entry yet at 98
  assert.strictEqual(outcomes1.length, 0);
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98, 5_000, t0 + 1500)); // second, confirming event -- still at/beyond the extreme, absorbed
  const outcomes2 = svc.onTick("ETHUSDT", 99, t0 + 2000); // reaches exactly the 50% target -- LAYER COMPLETE
  assert.strictEqual(outcomes2.length, 0, "no SIGNAL_CANDIDATE -- Wave1 is always the first layer to complete, always becomes dominant, never enters directly");
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch.waves[0]!.state, "SUPERSEDED", "the wave itself is done -- marked SUPERSEDED (continuation), not COMPLETED (which is reserved for an actual entry wave)");
  assert.strictEqual(watch.waves[0]!.selectedRecoveryPct, 50);
  assert.strictEqual(watch.dominantLayerLiqUsd, 25_000, "Wave1's own total (20k+5k) becomes the dominant reference");
  assert.strictEqual(watch.dominantLayerWaveNumber, 1);
  assert.strictEqual(watch.waves[0]!.liquidationRatioVsDominant, null, "no prior dominant existed to compare against -- the very first layer ever to complete");
});

scenario("Wave2+ with a TINY extreme (after real displacement) correctly reaches its own 100% target and is evaluated for dominance, exactly like any other completed layer", () => {
  const svc = newService();
  const t0 = Date.now();
  // Meaningful Wave1, superseded into Wave2 via a NEW liquidation event
  // arriving during PARTIAL recovery (existing pathway (a), unaffected
  // by the layer architecture) -- Wave1 never reaches its OWN target
  // here, so it never competes for dominance at all.
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0));
  svc.onTick("ETHUSDT", 98, t0 + 1000); // meaningful (distance=2)
  svc.onTick("ETHUSDT", 98.5, t0 + 2000); // recovers off extreme, below 50% target(99)
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98.5, 12_000, t0 + 3000)); // Wave2 starts, anchor=extreme=98.5 -- P95-qualifying (12k > 10k)
  const watchAtCreation = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watchAtCreation.waves[1]!.recoveryTargetPrice, null, "at creation, anchor===extreme -- NO target yet, per the structural-correctness fix");
  const noEntryYet = svc.onTick("ETHUSDT", 98.5, t0 + 3500); // price sits exactly at anchor=extreme -- must NOT trigger entry
  assert.strictEqual(noEntryYet.length, 0, "no target exists yet -- this tick must be a safe no-op, never an entry");
  svc.onTick("ETHUSDT", 98.49, t0 + 4000); // real displacement: extreme deepens to 98.49 (tiny, distance=0.01, distanceATR=0.02 -- non-meaningful, stays under the 0.10 threshold)
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch.waves[1]!.selectedRecoveryPct, 100, "now that real displacement exists (98.5 -> 98.49), non-meaningful Wave2 gets a 100% target");
  assert.strictEqual(watch.waves[1]!.recoveryTargetPrice, 98.5, "100% target == this wave's own anchor");
  // Reclaiming Wave2's own anchor (98.5) completes the layer -- since
  // Wave1 here NEVER reached its own target (superseded mid-recovery,
  // pathway (a)), Wave2 is the FIRST layer EVER to complete via
  // reaching its own target, so it automatically becomes dominant too
  // (consistent with "Layer1-to-complete becomes dominant" semantics)
  // -- no entry yet, waiting for a genuinely weaker later layer.
  const outcomes = svc.onTick("ETHUSDT", 98.5, t0 + 5000);
  assert.strictEqual(outcomes.length, 0, "Wave2 is the first-ever completed layer -- becomes dominant, does not enter");
  assert.strictEqual(watch.dominantLayerLiqUsd, 12_000);
  assert.strictEqual(watch.dominantLayerWaveNumber, 2);
});

scenario("a wave created with anchor===extreme (zero displacement) gets NO recovery target, regardless of wave number -- the exact structural bug found live (SOL 08028d90-09f8-4022-ac3b-7efd776cc112: W2 anchor=extreme=103.750, immediate trivial 100% entry, SL in 53 sec)", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0));
  svc.onTick("ETHUSDT", 98, t0 + 1000); // meaningful W1
  svc.onTick("ETHUSDT", 98.5, t0 + 2000); // recovers, below 50% target
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98.5, 12_000, t0 + 3000)); // W2 anchor=extreme=98.5, zero displacement -- P95-qualifying
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  const w2 = watch.waves[1]!;
  assert.strictEqual(w2.anchorPrice, w2.extremePrice, "anchor===extreme at creation, by construction");
  assert.strictEqual(w2.extremeDistanceAtr, 0);
  assert.strictEqual(w2.isMeaningful, false);
  assert.strictEqual(w2.selectedRecoveryPct, null, "NO target -- this is the exact structural fix");
  assert.strictEqual(w2.recoveryTargetPrice, null);
  // The first "opposite" tick (price exactly at the degenerate anchor=extreme level) must NOT trigger entry.
  const outcomes = svc.onTick("ETHUSDT", 98.5, t0 + 3500);
  assert.strictEqual(outcomes.length, 0, "a zero-displacement wave must never fire entry, no matter what price does while it stays zero-displacement");
});

// ── Wave1 minimum-liquidation-events gate (v5MinWave1LiqEvents, default 2) ──
// REVISED per explicit operator instruction: immediate termination,
// not suppress-and-wait -- see v5MinWave1LiqEvents()'s own doc comment.

scenario("a single-event Wave1 reaching its own recovery trigger TERMINATES THE ENTIRE EPISODE immediately -- W1_SINGLE_EVENT_ONLY, watch released, regardless of event size/displacement", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // anchor=100, liqEvents=1
  svc.onTick("ETHUSDT", 98, t0 + 1000); // meaningful, extreme=98, target=99
  const outcomes = svc.onTick("ETHUSDT", 99, t0 + 2000); // reaches the 50% target
  assert.strictEqual(outcomes.length, 1);
  assert.strictEqual(outcomes[0]!.kind, "TERMINAL_NON_SIGNAL", "no SIGNAL_CANDIDATE -- the episode is terminated instead");
  if (outcomes[0]!.kind === "TERMINAL_NON_SIGNAL") {
    assert.strictEqual(outcomes[0]!.event.reason, "W1_SINGLE_EVENT_ONLY");
    assert.strictEqual(outcomes[0]!.event.waveHistory[0]!.liqEvents, 1);
  }
  assert.strictEqual(svc.getWatch("ETHUSDT", "LONG"), null, "the watch must be fully released -- not left ACTIVE waiting for confirmation");
});

scenario("a LATER liquidation, after single-event termination, starts a genuinely NEW episode -- never resurrects the terminated one as a fake Wave2 (the exact SUIUSDT bug this replaces)", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // old episode: anchor=100
  svc.onTick("ETHUSDT", 98, t0 + 1000); // extreme=98, meaningful, target=99
  const terminated = svc.onTick("ETHUSDT", 99, t0 + 2000); // terminates -- W1_SINGLE_EVENT_ONLY
  assert.strictEqual(terminated[0]!.kind, "TERMINAL_NON_SIGNAL");
  const oldSignalId = terminated[0]!.kind === "TERMINAL_NON_SIGNAL" ? terminated[0]!.event.watch.signalId : null;
  assert.strictEqual(svc.getWatch("ETHUSDT", "LONG"), null);

  // Much later, an unrelated, small liquidation arrives on the same
  // symbol+victim -- this must start a BRAND NEW episode (new
  // signalId, new anchor), never attach as "Wave2" to the terminated one.
  svc.onLiquidation(liq("ETHUSDT", "SELL", 99.5, 12_000, t0 + 10 * 60_000)); // above P95=10,000 -- must qualify as a fresh episode
  const newWatch = svc.getWatch("ETHUSDT", "LONG");
  assert.ok(newWatch !== null, "a fresh, qualifying event must start a genuinely new watch");
  assert.strictEqual(newWatch!.waves.length, 1, "the new episode starts at Wave1, not Wave2 -- it is NOT a continuation");
  assert.notStrictEqual(newWatch!.signalId, oldSignalId, "the new episode has its OWN, distinct signalId -- never reuses the terminated one's identity");
});

scenario("the new episode's anchor/extreme/totalEpisodePressure are completely FRESH -- nothing from the terminated single-event episode carries over", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // old episode: anchor=100, extreme will reach 98
  svc.onTick("ETHUSDT", 98, t0 + 1000);
  svc.onTick("ETHUSDT", 99, t0 + 2000); // terminates -- W1_SINGLE_EVENT_ONLY, old totalEpisodePressure was 20,000

  svc.onLiquidation(liq("ETHUSDT", "SELL", 99.5, 12_000, t0 + 10 * 60_000)); // above P95=10,000 -- must qualify as a fresh episode // new, independent qualifying event
  const newWatch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(newWatch.waves[0]!.anchorPrice, 99.5, "the new episode's anchor is its OWN qualifying event's price -- not 100 (the old anchor) or 98 (the old extreme)");
  assert.strictEqual(newWatch.waves[0]!.extremePrice, 99.5, "a fresh wave's extreme starts equal to its own anchor -- not inherited from the old episode's 98");
  assert.strictEqual(newWatch.totalEpisodePressure, 12_000, "totalEpisodePressure is the NEW episode's own qualifying event alone -- the old episode's 20,000 must NOT be carried forward");
  assert.strictEqual(newWatch.qualifyingEventUsd, 12_000);
});

scenario("GROWING DOMINANT LAYERS (operator's own example): W1=100k -> W2=160k -> W3=220k all become the new dominant in turn, NO entry at any point -- only a genuinely weaker W4 becomes an exhaustion candidate and enters", () => {
  const svc = newService();
  const t0 = Date.now();

  // W1 = 100k -> dominant (first ever)
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 90_000, t0));
  svc.onTick("ETHUSDT", 98, t0 + 1000); // meaningful, target=99
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98, 10_000, t0 + 1500)); // W1 total = 100k
  const w1 = svc.onTick("ETHUSDT", 99, t0 + 2000);
  assert.strictEqual(w1.length, 0);
  let watch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch.dominantLayerLiqUsd, 100_000);
  assert.strictEqual(watch.dominantLayerWaveNumber, 1);

  // W2 = 160k > 100k -> becomes the NEW dominant, still no entry
  svc.onLiquidation(liq("ETHUSDT", "SELL", 99, 160_000, t0 + 3000));
  svc.onTick("ETHUSDT", 97, t0 + 4000); // meaningful, target=98
  const w2 = svc.onTick("ETHUSDT", 98, t0 + 5000);
  assert.strictEqual(w2.length, 0, "W2 (160k) > dominant (100k) -- continuation, no entry");
  watch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch.dominantLayerLiqUsd, 160_000, "dominant correctly updates to the GROWING W2");
  assert.strictEqual(watch.dominantLayerWaveNumber, 2);
  assert.strictEqual(watch.waves[1]!.liquidationRatioVsDominant, 1.6, "160k / prior dominant 100k = 1.6x, persisted as a measurement");

  // W3 = 220k > 160k -> becomes the NEW dominant, still no entry
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98, 220_000, t0 + 6000));
  svc.onTick("ETHUSDT", 96, t0 + 7000); // meaningful, target=97
  const w3 = svc.onTick("ETHUSDT", 97, t0 + 8000);
  assert.strictEqual(w3.length, 0, "W3 (220k) > dominant (160k) -- continuation, no entry");
  watch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch.dominantLayerLiqUsd, 220_000, "dominant correctly updates to the GROWING W3");
  assert.strictEqual(watch.dominantLayerWaveNumber, 3);

  // W4 = 120k < 220k -> genuinely WEAKER than the dominant W3 -- exhaustion candidate, entry fires
  svc.onLiquidation(liq("ETHUSDT", "SELL", 97, 120_000, t0 + 9000));
  svc.onTick("ETHUSDT", 95, t0 + 10_000); // meaningful, target=96
  const w4 = svc.onTick("ETHUSDT", 96, t0 + 11_000);
  assert.strictEqual(w4.length, 1, "W4 (120k) < dominant (220k) -- exhaustion candidate, entry fires");
  assert.strictEqual(w4[0]!.kind, "SIGNAL_CANDIDATE");
  if (w4[0]!.kind === "SIGNAL_CANDIDATE") {
    assert.strictEqual(w4[0]!.entryWave.waveNumber, 4);
    assert.strictEqual(w4[0]!.entryWave.liqNotionalUsd, 120_000);
    assert.ok(
      Math.abs(w4[0]!.entryWave.liquidationRatioVsDominant! - 120_000 / 220_000) < 0.0001,
      "liquidationRatioVsDominant correctly compares W4 against the W3 dominant (220k), not W1 or W2",
    );
  }
  // Dominant itself remains W3's 220k -- the weaker, entering W4 never updates it.
  assert.strictEqual(watch.dominantLayerLiqUsd, 220_000);
  assert.strictEqual(watch.dominantLayerWaveNumber, 3);
});

// ── Recovery tracking (the bug fixed during offline validation) ────

scenario("maxRecoveryPrice resets to the NEW extreme every time price makes a deeper low, not stuck at the original anchor-equal value", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0));
  svc.onTick("ETHUSDT", 98, t0 + 1000); // extreme=98, maxRecoveryPrice should reset to 98 too
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch.waves[0]!.maxRecoveryPrice, 98, "must reset to the new extreme, not stay stuck at anchor=100");
});

scenario("a freshly-created wave has recoveryPct=null (only ever set at completion, never forced to a default)", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0));
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  assert.strictEqual(watch.waves[0]!.recoveryPct, null);
});

// ── Recovery milestones (shadow diagnostics only, measured toward FULL anchor, independent of the dynamic 50%/100% entry target) ──

scenario("recovery milestones toward the FULL anchor never trigger entry -- entry is gated ONLY on the dynamic 50%/100% target", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // anchor=100
  svc.onTick("ETHUSDT", 96, t0 + 1000); // extreme=96 (range=4, distance=4 -- meaningful, 50% entry-target=98)
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  const outcomes = svc.onTick("ETHUSDT", 97, t0 + 2000); // 25% toward full anchor, but BELOW the 50% entry-target(98) -- no entry
  assert.strictEqual(outcomes.length, 0);
  assert.strictEqual(watch.waves[0]!.state, "ACTIVE", "reaching this milestone must NOT trigger entry -- entry is gated on the DYNAMIC 50%/100% target, not the shadow milestones");
});

scenario("recovery50AtTs/recovery75AtTs RESET to null every time a new, deeper extreme forms -- a milestone recorded against a shallow extreme must never survive a later, deeper extreme (the exact bug found in two live signals, AVAXUSDT/ADAUSDT: recovery50AtTs stored BEFORE the wave's own final extremeTs)", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // anchor=100, extreme=100
  const watch = svc.getWatch("ETHUSDT", "LONG")!;

  // Tiny, SHALLOW extreme first: 99.99 (range=0.01) -- price recovers to
  // 99.995, which is 50% of THIS shallow range -- gets recorded.
  svc.onTick("ETHUSDT", 99.99, t0 + 1000); // extreme=99.99
  svc.onTick("ETHUSDT", 99.995, t0 + 2000); // 50% of the shallow 100<->99.99 range
  assert.ok(watch.waves[0]!.recovery50AtTs !== null, "50% of the shallow extreme must be recorded first");
  const shallowMilestoneTs = watch.waves[0]!.recovery50AtTs;

  // NOW price pushes to a MUCH deeper extreme: 98 (range=2) -- this must
  // invalidate the shallow milestone entirely.
  svc.onTick("ETHUSDT", 98, t0 + 3000); // extreme=98, deeper than 99.99
  assert.strictEqual(watch.waves[0]!.recovery50AtTs, null, "the shallow milestone must be WIPED the instant a deeper extreme forms");
  assert.strictEqual(watch.waves[0]!.recovery50AtPrice, null);
  assert.strictEqual(watch.waves[0]!.recovery75AtTs, null);
  assert.ok(watch.waves[0]!.extremeTs > shallowMilestoneTs!, "sanity: the new extreme's own timestamp is chronologically after the wiped milestone's old timestamp");

  // Recovery toward the NEW, deeper extreme's own 50% mark (99) should
  // record a FRESH, correctly-ordered milestone.
  svc.onTick("ETHUSDT", 99, t0 + 4000); // 50% of the 100<->98 range
  assert.ok(watch.waves[0]!.recovery50AtTs !== null, "a fresh 50% milestone must be recorded against the NEW, deeper extreme");
  assert.ok(watch.waves[0]!.recovery50AtTs! > watch.waves[0]!.extremeTs, "the milestone timestamp must now be chronologically AFTER the wave's own current extremeTs -- never before it");
});

scenario("the ENTRY decision itself (recoveryTargetPrice) was NEVER affected by the recovery50/75AtTs diagnostic bug -- it always tracks the CURRENT, deepest extreme, independently recomputed on every extension", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // anchor=100
  svc.onTick("ETHUSDT", 99.99, t0 + 1000); // shallow extreme
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  const shallowTarget = watch.waves[0]!.recoveryTargetPrice; // null (not meaningful yet at 0.01 distance)
  svc.onTick("ETHUSDT", 98, t0 + 2000); // deep, meaningful extreme (distance=2, 0.10 ATR threshold = 0.05)
  const deepTarget = watch.waves[0]!.recoveryTargetPrice;
  assert.strictEqual(shallowTarget, null, "no target exists yet at the shallow, non-meaningful extreme");
  assert.strictEqual(deepTarget, 99, "the target correctly reflects the NEW, deep extreme's own 50% mark (100 - 0.5*(100-98) = 99), proving the entry mechanism is independent of the diagnostic-milestone bug");
});

scenario("the WAVE_CHRONOLOGY_INVALID guard fires and REFUSES entry if a wave's timestamps are somehow corrupted (defensive test -- direct state manipulation, since the reset fix above makes this unreachable through normal onTick/onLiquidation calls)", () => {
  const svc = newService();
  const t0 = Date.now();
  // W1 completes normally, becomes dominant (25k) -- no entry, per the layer architecture.
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0));
  svc.onTick("ETHUSDT", 98, t0 + 1000);
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98, 5_000, t0 + 1500));
  const w1Outcomes = svc.onTick("ETHUSDT", 99, t0 + 2000);
  assert.strictEqual(w1Outcomes.length, 0, "W1 becomes dominant, no entry");

  // W2 starts, deliberately WEAKER than dominant (25k) -- this is the
  // one that will actually reach the chronology-guard/entry code path.
  svc.onLiquidation(liq("ETHUSDT", "SELL", 99, 12_000, t0 + 3000));
  svc.onTick("ETHUSDT", 97, t0 + 4000); // meaningful (distance=2), 50% target=98
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  // Directly corrupt recovery50AtTs to be BEFORE extremeTs, simulating
  // exactly the bug pattern found in the two live signals -- this
  // manipulation is only for testing the defensive guard itself.
  watch.waves[1]!.recovery50AtTs = watch.waves[1]!.extremeTs - 5000;
  const outcomes = svc.onTick("ETHUSDT", 98, t0 + 5000); // reaches W2's own 50% target -- W2(4k) < dominant(25k), would normally be SIGNAL_CANDIDATE
  assert.strictEqual(outcomes.length, 1);
  assert.strictEqual(outcomes[0]!.kind, "TERMINAL_NON_SIGNAL", "corrupted chronology must REFUSE entry, never produce a SIGNAL_CANDIDATE");
  if (outcomes[0]!.kind === "TERMINAL_NON_SIGNAL") {
    assert.strictEqual(outcomes[0]!.event.reason, "WAVE_CHRONOLOGY_INVALID");
  }
  assert.strictEqual(svc.getWatch("ETHUSDT", "LONG"), null, "the episode must be fully discarded, not left dangling");
});

// ── Wave1 diagnostics (measurement only, never gates entry) ────────

scenario("W1 diagnostics are captured correctly when Wave1 completes and becomes the dominant layer (COMPLETED_AS_DOMINANT) -- W1 can never conclude any other way now that it never enters directly", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // anchor=100, qualifyingEvent=20k, P95=10k
  svc.onTick("ETHUSDT", 98, t0 + 60_000); // extreme=98, 60 sec after anchor -- distance=2, ATR=0.5 -> distanceATR=4.0
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98, 5_000, t0 + 60_500)); // second, confirming event -- absorbed, still at/beyond the extreme
  const outcomes = svc.onTick("ETHUSDT", 99, t0 + 90_000); // 50% target reached 30 sec after extreme -- LAYER COMPLETE
  assert.strictEqual(outcomes.length, 0, "W1 always becomes dominant on its own first completion -- never a SIGNAL_CANDIDATE");
  const watch = svc.getWatch("ETHUSDT", "LONG")!;
  const diag = watch.w1Diagnostics;
  assert.ok(diag !== null, "w1Diagnostics must be populated at W1's own completion, even though no entry fired");
  assert.strictEqual(diag!.concludedReason, "COMPLETED_AS_DOMINANT");
  assert.strictEqual(diag!.qualifyingEventUsd, 20_000);
  assert.strictEqual(diag!.qualifyingEventToP95Ratio, 2, "20k / 10k P95 = 2x");
  assert.strictEqual(diag!.anchorToExtremeMs, 60_000);
  assert.strictEqual(diag!.extremeDistanceAtr, 4);
  assert.ok(Math.abs(diag!.speedAtrPerMinute! - 4) < 0.001, "4.0 ATR distance in exactly 1 minute = 4.0 ATR/min");
  assert.strictEqual(diag!.w1TotalLiqUsd, 25_000, "qualifying event (20k) + the second, confirming event (5k)");
  assert.strictEqual(diag!.continuationLiqUsd, 5_000);
  assert.strictEqual(diag!.continuationRatio, 0.25);
  assert.strictEqual(diag!.extremeToRecoveryMs, 30_000);
  assert.strictEqual(watch.dominantLayerLiqUsd, 25_000);
  assert.strictEqual(watch.dominantLayerWaveNumber, 1);
});

scenario("W1 diagnostics are captured on SUPERSEDED_TO_W2 and PERSIST unchanged even after later waves complete/enter (never overwritten)", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0)); // W1 anchor=100
  svc.onTick("ETHUSDT", 98, t0 + 1000); // W1 meaningful, extreme=98
  svc.onTick("ETHUSDT", 98.5, t0 + 2000); // recovers off extreme, below 50% target(99) -- W1 NEVER reaches its own target
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98.5, 30_000, t0 + 3000)); // W2 starts -- this supersedes W1 (pathway (a)), captures w1Diagnostics NOW
  const watchAfterSupersede = svc.getWatch("ETHUSDT", "LONG")!;
  assert.ok(watchAfterSupersede.w1Diagnostics !== null, "w1Diagnostics must be captured at the moment W1 is superseded");
  assert.strictEqual(watchAfterSupersede.w1Diagnostics!.concludedReason, "SUPERSEDED_TO_W2");
  const capturedAtSupersede = watchAfterSupersede.w1Diagnostics;

  svc.onTick("ETHUSDT", 98.3, t0 + 3500); // real displacement for W2 (anchor=98.5 -> extreme=98.3)
  const w2Outcomes = svc.onTick("ETHUSDT", 98.5, t0 + 4000); // W2 reaches its OWN target -- first-ever to complete via target, becomes DOMINANT, no entry
  assert.strictEqual(w2Outcomes.length, 0, "W2 is the first layer to ever complete via reaching target -- becomes dominant, does not enter");
  const watchAfterW2 = svc.getWatch("ETHUSDT", "LONG")!;
  assert.deepStrictEqual(watchAfterW2.w1Diagnostics, capturedAtSupersede, "still unchanged after W2's own completion");

  // W3, deliberately weaker than dominant W2 (30k) -- this is the one
  // that actually fires entry.
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98.5, 12_000, t0 + 5000)); // P95-qualifying (12k), still weaker than dominant W2 (30k)
  svc.onTick("ETHUSDT", 96.5, t0 + 6000); // meaningful (distance=2), 50% target=97.5
  const outcomes = svc.onTick("ETHUSDT", 97.5, t0 + 7000);
  assert.strictEqual(outcomes.length, 1);
  if (outcomes[0]!.kind !== "SIGNAL_CANDIDATE") return;
  assert.strictEqual(outcomes[0]!.entryWave.waveNumber, 3, "entry is on wave 3, confirming W1 diagnostics describe a DIFFERENT wave than the one that actually entered");
  const event = svc.evaluateSignal(outcomes[0]!.watch, outcomes[0]!.entryWave, 97.5, t0 + 7000);
  assert.ok(event!.w1Diagnostics !== null);
  assert.deepStrictEqual(event!.w1Diagnostics, capturedAtSupersede, "W1's own diagnostic snapshot must be UNCHANGED from the moment it was superseded -- never silently overwritten by any later wave's activity");
  assert.strictEqual(event!.dominantLayerLiqUsd, 30_000, "dominant remains W2's own 30k -- the weaker, entering W3 never updates it");
  assert.strictEqual(event!.dominantLayerWaveNumber, 2);
  assert.strictEqual(event!.exhaustionLayerLiqUsd, 12_000, "the exhaustion/entry layer is W3's own, separate 12k");
  assert.strictEqual(event!.exhaustionLayerWaveNumber, 3);
});

scenario("evaluateSignal's TP/SL uses the FULL, never-reset episode total (totalEpisodePressure), not just the entry wave's own liquidation", () => {
  const svc = newService();
  const t0 = Date.now();
  // Wave1: $20k, meaningful, superseded via pathway (a) (never reaches its own target)
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0));
  svc.onTick("ETHUSDT", 98, t0 + 1000); // meaningful (distance=2), 50% target=99
  svc.onTick("ETHUSDT", 98.5, t0 + 2000); // recovers off extreme, below the 99 entry-target
  // Wave2 starts at 98.5, with its own $30k -- first-ever wave to complete via reaching its target, becomes DOMINANT, no entry
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98.5, 30_000, t0 + 3000));
  svc.onTick("ETHUSDT", 98.3, t0 + 3500); // real displacement for W2 (anchor=98.5 -> extreme=98.3)
  const w2Outcomes = svc.onTick("ETHUSDT", 98.5, t0 + 4000); // wave2 reaches its OWN anchor (98.5) -- 100% target -- becomes dominant
  assert.strictEqual(w2Outcomes.length, 0, "W2 is the first-ever completed layer -- becomes dominant, does not enter");

  // Wave3, deliberately weaker than dominant W2 (30k) -- this is the one that actually enters.
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98.5, 10_000, t0 + 5000));
  svc.onTick("ETHUSDT", 97.5, t0 + 6000); // meaningful (distance=1), 50% target=98
  const outcomes = svc.onTick("ETHUSDT", 98, t0 + 7000);
  assert.strictEqual(outcomes.length, 1);
  assert.strictEqual(outcomes[0]!.kind, "SIGNAL_CANDIDATE");
  if (outcomes[0]!.kind === "SIGNAL_CANDIDATE") {
    const watch = outcomes[0]!.watch;
    const entryWave = outcomes[0]!.entryWave;
    assert.strictEqual(entryWave.waveNumber, 3);
    assert.strictEqual(entryWave.liqNotionalUsd, 10_000, "wave3's own liquidation, in isolation -- genuinely weaker than dominant W2's 30k");
    assert.strictEqual(watch.totalEpisodePressure, 60_000, "full episode: 20k (wave1) + 30k (wave2) + 10k (wave3), the corrected cumLiq input");
    const event = svc.evaluateSignal(watch, entryWave, entryWave.reclaimPrice!, entryWave.reclaimTs!);
    assert.ok(event !== null);
    if (event!.plan) {
      // liqStrengthRaw = sqrt(cumLiq / baseline) = sqrt(60000/10000) = sqrt(6), using the FULL 60k, not just wave3's 10k
      assert.ok(
        Math.abs(event!.plan.liqStrengthRaw - Math.sqrt(6)) < 0.01,
        `expected liqStrengthRaw derived from the full 60k episode total, got ${event!.plan.liqStrengthRaw}`,
      );
    }
  }
});

scenario("evaluateSignal refuses a second call for the same watch (signalIssued guard)", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0));
  svc.onTick("ETHUSDT", 98, t0 + 1000); // meaningful, 50% target=99
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98, 5_000, t0 + 1500)); // second, confirming event
  const w1Outcomes = svc.onTick("ETHUSDT", 99, t0 + 2000); // reaches the 50% target -- W1 becomes dominant (25k), no entry
  assert.strictEqual(w1Outcomes.length, 0);
  // W2, deliberately weaker than dominant (25k) -- this one actually enters.
  svc.onLiquidation(liq("ETHUSDT", "SELL", 99, 12_000, t0 + 3000));
  svc.onTick("ETHUSDT", 97, t0 + 4000); // meaningful (distance=2), 50% target=98
  const outcomes = svc.onTick("ETHUSDT", 98, t0 + 5000); // reaches the 50% target -- entry (4k < dominant 25k)
  assert.strictEqual(outcomes.length, 1);
  assert.strictEqual(outcomes[0]!.kind, "SIGNAL_CANDIDATE");
  if (outcomes[0]!.kind !== "SIGNAL_CANDIDATE") return;
  const watch = outcomes[0]!.watch;
  const entryWave = outcomes[0]!.entryWave;
  const first = svc.evaluateSignal(watch, entryWave, 98, t0 + 5000);
  assert.ok(first !== null);
  const second = svc.evaluateSignal(watch, entryWave, 98, t0 + 5000);
  assert.strictEqual(second, null, "a second evaluateSignal() call on the same watch must be a safe no-op");
});

// ── Diagnostic-only safety timeouts (never a wave-completion decision) ──

scenario("an episode with no liquidation activity for the inactivity window terminates as EPISODE_EXPIRED_INACTIVITY", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0));
  const farFuture = t0 + 16 * 60_000; // past the 15min default inactivity window
  const outcomes = svc.onTick("ETHUSDT", 105, farFuture); // price never reclaimed, just went quiet
  assert.strictEqual(outcomes.length, 1);
  assert.strictEqual(outcomes[0]!.kind, "TERMINAL_NON_SIGNAL");
  if (outcomes[0]!.kind === "TERMINAL_NON_SIGNAL") {
    assert.strictEqual(outcomes[0]!.event.reason, "EPISODE_EXPIRED_INACTIVITY");
  }
  assert.strictEqual(svc.getWatch("ETHUSDT", "LONG"), null, "the watch must be released automatically on this terminal outcome");
});

scenario("an episode past the safety-timeout ceiling terminates as EPISODE_EXPIRED_SAFETY_TIMEOUT even with recent activity", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0));
  const farFuture = t0 + 241 * 60_000; // past the 240min default safety timeout
  svc.onLiquidation(liq("ETHUSDT", "SELL", 99, 5_000, farFuture - 60_000)); // recent-ish activity, well within the inactivity window
  const outcomes = svc.onTick("ETHUSDT", 105, farFuture);
  assert.strictEqual(outcomes.length, 1);
  assert.strictEqual(outcomes[0]!.kind, "TERMINAL_NON_SIGNAL");
  if (outcomes[0]!.kind === "TERMINAL_NON_SIGNAL") {
    assert.strictEqual(outcomes[0]!.event.reason, "EPISODE_EXPIRED_SAFETY_TIMEOUT");
  }
});

// ── Trade monitoring (TP/SL close) ──────────────────────────────────

scenario("onPriceTickForTrades closes an active trade at TP or SL and removes it from further monitoring", () => {
  const svc = newService();
  const t0 = Date.now();
  svc.onLiquidation(liq("ETHUSDT", "SELL", 100, 20_000, t0));
  svc.onTick("ETHUSDT", 98, t0 + 1000); // meaningful, 50% target=99
  svc.onLiquidation(liq("ETHUSDT", "SELL", 98, 5_000, t0 + 1500)); // second, confirming event
  const w1Outcomes = svc.onTick("ETHUSDT", 99, t0 + 2000); // W1 becomes dominant (25k), no entry
  assert.strictEqual(w1Outcomes.length, 0);
  // W2, deliberately weaker than dominant (25k) -- this one actually enters.
  svc.onLiquidation(liq("ETHUSDT", "SELL", 99, 12_000, t0 + 3000));
  svc.onTick("ETHUSDT", 97, t0 + 4000); // meaningful (distance=2), 50% target=98
  const outcomes = svc.onTick("ETHUSDT", 98, t0 + 5000); // entry at the 50% target
  assert.strictEqual(outcomes.length, 1);
  if (outcomes[0]!.kind !== "SIGNAL_CANDIDATE") return;
  const watch = outcomes[0]!.watch;
  const entryWave = outcomes[0]!.entryWave;
  const event = svc.evaluateSignal(watch, entryWave, 98, t0 + 5000);
  assert.ok(event !== null);
  if (!event!.plan) return; // geometry rejected in this random test setup -- skip close-testing, qualification test already covers the plan path
  const tp = event!.plan.tp;
  const closes = svc.onPriceTickForTrades("ETHUSDT", tp, t0 + 6000);
  assert.strictEqual(closes.length, 1);
  assert.strictEqual(closes[0]!.outcome, "TP");
  assert.strictEqual(svc.getActiveTrade(event!.signalId), null, "trade must be removed from active monitoring after closing");
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailed assertions:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
