/**
 * Sep 10 2026 (Karo), operator-reported CRITICAL FIX + operator-
 * requested lifecycle correction (symbol-level, not symbol+victim-
 * level, ownership). Proves the ownership invariant
 * CommonHorizonEpisodeRegistry enforces, with REAL
 * UnitResearchShadowService instances (not source-inspection).
 */
import * as assert from "assert";
import { UnitResearchShadowService } from "../src/domain/research/unit-research-shadow.service";
import { CommonHorizonEpisodeRegistry } from "../src/domain/research/common-horizon-episode-registry";
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

/** A fresh trio of shadows + registry, exactly mirroring how
 *  market-data-orchestrator.ts wires them, but standalone/testable. */
function makeHarness(openWinners: Set<string> = new Set()) {
  const shadow1m = new UnitResearchShadowService(() => 1000);
  const shadow3m = new UnitResearchShadowService(() => 1000);
  const shadow5m = new UnitResearchShadowService(() => 1000);
  const registry = new CommonHorizonEpisodeRegistry(
    shadow1m,
    shadow3m,
    shadow5m,
    (signalId) => openWinners.has(signalId),
  );
  let idCounter = 0;
  const makeSignalId = () => `sig-${++idCounter}`;
  return { shadow1m, shadow3m, shadow5m, registry, makeSignalId, openWinners };
}

/** Feeds ONE liquidation event through the SAME decision-flow
 *  market-data-orchestrator.ts's own feedCommonHorizonCompetition()
 *  uses: resolve() first, then route/ignore/start accordingly.
 *  Returns the resolution itself for assertions. */
function feed(
  h: ReturnType<typeof makeHarness>,
  symbol: string,
  victim: Side,
  price: number,
  quoteQty: number,
  ts: number,
) {
  const side = victim === "LONG" ? "SELL" : "BUY";
  const l = liq(symbol, side, price, quoteQty, ts);
  const resolved = h.registry.resolve(symbol, victim, ts, h.makeSignalId);
  if (resolved.action === "ignore") return resolved;
  if (resolved.action === "route") {
    h.shadow1m.onLiquidation(l, victim);
    h.shadow3m.onLiquidation(l, victim);
    h.shadow5m.onLiquidation(l, victim);
    return resolved;
  }
  h.shadow1m.startEpisode(
    symbol,
    victim,
    resolved.signalId,
    1,
    price,
    resolved.episodeStartTs,
    quoteQty,
    resolved.episodeStartTs,
  );
  h.shadow3m.startEpisode(
    symbol,
    victim,
    resolved.signalId,
    2,
    price,
    resolved.episodeStartTs,
    quoteQty,
    resolved.episodeStartTs,
  );
  h.shadow5m.startEpisode(
    symbol,
    victim,
    resolved.signalId,
    3,
    price,
    resolved.episodeStartTs,
    quoteQty,
    resolved.episodeStartTs,
  );
  return resolved;
}

console.log("Running common-horizon-episode-registry tests...\n");

// ─── 1. Repeated liquidations while TRACKING never create a second episode ─

scenario(
  "repeated liquidation events on the same symbol while any candidate is TRACKING do NOT create a second episode",
  () => {
    const h = makeHarness();
    const first = feed(h, "ETHUSDT", "LONG", 2000, 5000, 1000);
    assert.strictEqual(first.action, "start");
    if (first.action !== "start") return;

    for (let i = 0; i < 10; i++) {
      const r = feed(h, "ETHUSDT", "LONG", 2000 - i, 100, 1000 + i * 10);
      assert.strictEqual(
        r.action,
        "route",
        `event #${i} must be ROUTED into the EXISTING episode, not start a new one`,
      );
      if (r.action === "route")
        assert.strictEqual(
          r.signalId,
          first.signalId,
          "signalId must stay the SAME across all these events",
        );
    }
  },
);

// ─── 2. 1m CANCEL + 3m/5m TRACKING still blocks a new episode ──────────────

scenario(
  "1m CANCEL + 3m TRACKING + 5m TRACKING still blocks a new episode -- ONE candidate reaching terminal does not free the symbol",
  () => {
    const h = makeHarness();
    const first = feed(h, "ETHUSDT", "LONG", 2000, 5000, 1000);
    assert.strictEqual(first.action, "start");
    if (first.action !== "start") return;

    h.shadow1m.onTick("ETHUSDT", "LONG", 2001, 1500);
    h.shadow1m.onTick("ETHUSDT", "LONG", 2003, 2000); // now >= 2x -> CANCEL
    assert.strictEqual(
      h.shadow1m.peekWatch("ETHUSDT", "LONG"),
      null,
      "1m must now be terminal",
    );
    assert.notStrictEqual(
      h.shadow3m.peekWatch("ETHUSDT", "LONG"),
      null,
      "3m must still be tracking",
    );
    assert.notStrictEqual(
      h.shadow5m.peekWatch("ETHUSDT", "LONG"),
      null,
      "5m must still be tracking",
    );

    const second = feed(h, "ETHUSDT", "LONG", 2001, 200, 3000);
    assert.strictEqual(
      second.action,
      "route",
      "the symbol must STILL be occupied by the existing episode -- 1m being terminal alone is not enough",
    );
    if (second.action === "route")
      assert.strictEqual(second.signalId, first.signalId);
  },
);

// ─── 3. Winner OPEN blocks a new episode ────────────────────────────────

scenario(
  "an OPEN winner position blocks a new episode, even after ALL THREE candidates have individually gone terminal",
  () => {
    const openWinners = new Set<string>();
    const h = makeHarness(openWinners);
    const first = feed(h, "ETHUSDT", "LONG", 2000, 5000, 1000);
    if (first.action !== "start") throw new Error("setup failed");

    h.shadow1m.onTick("ETHUSDT", "LONG", 2001, 1500);
    h.shadow1m.onTick("ETHUSDT", "LONG", 2010, 2000);
    h.shadow3m.onTick("ETHUSDT", "LONG", 2003, 1500);
    h.shadow3m.onTick("ETHUSDT", "LONG", 2010, 2000);
    h.shadow5m.onTick("ETHUSDT", "LONG", 2004, 1500);
    h.shadow5m.onTick("ETHUSDT", "LONG", 2010, 2000);
    assert.strictEqual(h.shadow1m.peekWatch("ETHUSDT", "LONG"), null);
    assert.strictEqual(h.shadow3m.peekWatch("ETHUSDT", "LONG"), null);
    assert.strictEqual(h.shadow5m.peekWatch("ETHUSDT", "LONG"), null);

    openWinners.add(first.signalId);

    const second = feed(h, "ETHUSDT", "LONG", 2001, 200, 5000);
    assert.strictEqual(
      second.action,
      "route",
      "an OPEN winner must keep the symbol occupied even though every candidate is individually terminal",
    );
    if (second.action === "route")
      assert.strictEqual(second.signalId, first.signalId);
  },
);

// ─── 4. After full terminal close, the next liquidation starts fresh ──────

scenario(
  "after full terminal close (all three candidates terminal AND no open winner), the next liquidation creates a genuinely fresh episode",
  () => {
    const openWinners = new Set<string>();
    const h = makeHarness(openWinners);
    const first = feed(h, "ETHUSDT", "LONG", 2000, 5000, 1000);
    if (first.action !== "start") throw new Error("setup failed");

    h.shadow1m.onTick("ETHUSDT", "LONG", 2001, 1500);
    h.shadow1m.onTick("ETHUSDT", "LONG", 2010, 2000);
    h.shadow3m.onTick("ETHUSDT", "LONG", 2003, 1500);
    h.shadow3m.onTick("ETHUSDT", "LONG", 2010, 2000);
    h.shadow5m.onTick("ETHUSDT", "LONG", 2004, 1500);
    h.shadow5m.onTick("ETHUSDT", "LONG", 2010, 2000);

    const second = feed(h, "ETHUSDT", "LONG", 2001, 200, 5000);
    assert.strictEqual(
      second.action,
      "start",
      "a fully-terminal episode (no open winner) must allow a fresh one to start",
    );
    if (second.action === "start")
      assert.notStrictEqual(
        second.signalId,
        first.signalId,
        "the fresh episode must get its own, NEW signalId",
      );
  },
);

// ─── 5. All three candidates share the identical episodeStartTs ───────────

scenario(
  "all three candidates of ONE episode share the EXACT SAME episodeStartTs",
  () => {
    const h = makeHarness();
    const resolved = feed(h, "ETHUSDT", "LONG", 2000, 5000, 12345);
    if (resolved.action !== "start") throw new Error("setup failed");
    const peek1 = h.shadow1m.peekWatch("ETHUSDT", "LONG");
    const peek3 = h.shadow3m.peekWatch("ETHUSDT", "LONG");
    const peek5 = h.shadow5m.peekWatch("ETHUSDT", "LONG");
    assert.ok(peek1 && peek3 && peek5);
    assert.strictEqual(peek1!.episodeStartTs, resolved.episodeStartTs);
    assert.strictEqual(peek3!.episodeStartTs, resolved.episodeStartTs);
    assert.strictEqual(peek5!.episodeStartTs, resolved.episodeStartTs);
  },
);

// ─── 6. Different symbols run fully independent, simultaneous episodes ────

scenario(
  "different symbols can have independent, simultaneous active episodes -- one symbol's own episode never blocks or interferes with another's",
  () => {
    const h = makeHarness();
    const eth = feed(h, "ETHUSDT", "LONG", 2000, 5000, 1000);
    const sol = feed(h, "SOLUSDT", "LONG", 100, 5000, 1000);
    assert.strictEqual(eth.action, "start");
    assert.strictEqual(sol.action, "start");
    if (eth.action !== "start" || sol.action !== "start") return;
    assert.notStrictEqual(eth.signalId, sol.signalId);

    const ethAgain = feed(h, "ETHUSDT", "LONG", 1999, 100, 2000);
    const solAgain = feed(h, "SOLUSDT", "LONG", 99, 100, 2000);
    assert.strictEqual(ethAgain.action, "route");
    assert.strictEqual(solAgain.action, "route");
    if (ethAgain.action === "route")
      assert.strictEqual(ethAgain.signalId, eth.signalId);
    if (solAgain.action === "route")
      assert.strictEqual(solAgain.signalId, sol.signalId);
  },
);

// ─── 7. Operator-requested: opposite-victim liquidation on the SAME symbol ─

scenario(
  "active LONG-victim DOGE episode + incoming SHORT-victim DOGE liquidation => still exactly ONE DOGE episode (the SHORT event is ignored, never starts a second episode, never becomes Wave 2 for the LONG episode)",
  () => {
    const h = makeHarness();
    const longEpisode = feed(h, "DOGEUSDT", "LONG", 0.085, 5000, 1000);
    assert.strictEqual(longEpisode.action, "start");
    if (longEpisode.action !== "start") return;

    // An OPPOSITE-victim (SHORT) liquidation arrives for the SAME symbol
    // while the LONG episode is still active.
    const shortAttempt = h.registry.resolve(
      "DOGEUSDT",
      "SHORT",
      2000,
      h.makeSignalId,
    );
    assert.strictEqual(
      shortAttempt.action,
      "ignore",
      "the opposite-victim event must be IGNORED, not start a second episode",
    );

    // The SHORT-victim shadow watches must never have been touched --
    // no Wave 2, no new watch, nothing.
    assert.strictEqual(
      h.shadow1m.peekWatch("DOGEUSDT", "SHORT"),
      null,
      "no SHORT-victim watch must ever exist",
    );
    assert.strictEqual(h.shadow3m.peekWatch("DOGEUSDT", "SHORT"), null);
    assert.strictEqual(h.shadow5m.peekWatch("DOGEUSDT", "SHORT"), null);

    // The ORIGINAL LONG episode must be completely unaffected -- still
    // exactly the same, single active episode for DOGEUSDT.
    const longStillActive = h.registry.resolve(
      "DOGEUSDT",
      "LONG",
      3000,
      h.makeSignalId,
    );
    assert.strictEqual(
      longStillActive.action,
      "route",
      "the original LONG episode must be untouched and still active",
    );
    if (longStillActive.action === "route")
      assert.strictEqual(longStillActive.signalId, longEpisode.signalId);

    // A SECOND opposite-victim attempt is ALSO ignored -- not just the first.
    const shortAgain = h.registry.resolve(
      "DOGEUSDT",
      "SHORT",
      4000,
      h.makeSignalId,
    );
    assert.strictEqual(shortAgain.action, "ignore");

    assert.strictEqual(
      h.registry.isActive("DOGEUSDT"),
      true,
      "exactly one DOGE episode (the LONG one) must be active throughout",
    );
  },
);

// ─── Structural: the orchestrator's own wiring uses this registry ─────────

scenario(
  "structural: market-data-orchestrator.ts's own feedCommonHorizonCompetition() delegates ownership entirely to commonHorizonEpisodes.resolve() -- no separate, ad-hoc Map/lock logic remains",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = source.indexOf("private feedCommonHorizonCompetition(");
    assert.ok(idx > -1);
    const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
    assert.ok(
      body.includes("commonHorizonEpisodes.resolve("),
      "must delegate to the registry's own resolve()",
    );
    assert.ok(
      body.includes('"ignore"'),
      "must handle the ignore action (opposite-victim, symbol already occupied)",
    );
    assert.ok(
      !body.includes("this.v5.getWatch("),
      "must never source signalId/episodeStartTs from V5's own watch anymore",
    );
  },
);

scenario(
  "structural: snapshotCommonHorizonPhase() reads the owning signalId from the SAME registry (current()), never from V5's own watch",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/services/market-data-orchestrator.ts"),
      "utf8",
    );
    const idx = source.indexOf("private snapshotCommonHorizonPhase(");
    assert.ok(idx > -1);
    const body = source.slice(idx, source.indexOf("\n  private ", idx + 50));
    assert.ok(
      body.includes("commonHorizonEpisodes.current("),
      "must read the owning episode from the registry's own current()",
    );
    assert.ok(
      !body.includes("this.v5.getWatch("),
      "must never fall back to V5's own watch for the signalId join",
    );
  },
);

scenario(
  "structural: CommonHorizonEpisodeRegistry's own ownership map is keyed by symbol alone, not symbol+victim",
  () => {
    const fs = require("fs") as typeof import("fs");
    const source = fs.readFileSync(
      require.resolve("../src/domain/research/common-horizon-episode-registry.ts"),
      "utf8",
    );
    assert.ok(
      source.includes("this.ownership.get(symbol)"),
      "ownership lookups must be keyed by symbol alone",
    );
    assert.ok(
      !source.includes("this.key(symbol"),
      "no symbol+victim composite-key helper should remain in use",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
