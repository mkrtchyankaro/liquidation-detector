/**
 * Sep 8 2026 (Karo), operator-designed minimal-cascade model. REPLACES
 * the old W1/W2/W3 SUPERSEDE-based test suite entirely -- that model
 * no longer exists (see v5-wave.service.ts's own module doc comment
 * for the full design/rationale). Tests here cover exactly the
 * operator's own final, deliberately minimal specification: any
 * liquidation starts tracking, price+liquidation continuously extend
 * one running extreme, ~1 UNIT recovery from the latest extreme means
 * the push is finished, and CUMULATIVE liquidation pressure (not a
 * per-event P95 requirement) decides seriousness.
 */
import * as assert from "assert";
import { V5WaveService } from "../src/strategy/v5/v5-wave.service";
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

const UNIT = 1; // fixed, simple ATR1m-equivalent for every test below
const P95 = 1000; // fixed individual-event P95 for every test below

function makeV5(unit = UNIT, p95 = P95, baseline = 100): V5WaveService {
  return new V5WaveService(
    () => 500, // getAtrAbs (ATR15m) -- unused by these tests, trade-plan-only
    () => unit, // getUnit1mAbs -- the new structural UNIT
    () => null, // getOi
    () => baseline, // getBaseline
    () => p95, // getIndividualP95
  );
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

console.log("Running V5WaveService (minimal-cascade model) tests...\n");

scenario(
  "cascade starts from ANY liquidation event, no P95 gate at episode-start (SELL=LONG victim)",
  () => {
    const v5 = makeV5();
    const outcomes = v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 1, 1000)); // tiny, far below P95=1000
    assert.strictEqual(outcomes.length, 0); // no immediate outcome, just starts tracking
    const watch = v5.getWatch("ETHUSDT", "LONG");
    assert.ok(
      watch,
      "a watch must exist after even a tiny first liquidation event",
    );
    assert.strictEqual(watch!.waves[0]!.liqNotionalUsd, 1);
  },
);

scenario(
  "cascade accumulates liquidation pressure across MANY small events (not one giant print)",
  () => {
    const v5 = makeV5();
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 200, 1000));
    v5.onLiquidation(liq("ETHUSDT", "SELL", 1999, 300, 1100));
    v5.onLiquidation(liq("ETHUSDT", "SELL", 1998, 400, 1200));
    const watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(watch.totalEpisodePressure, 900);
    assert.strictEqual(watch.waves[0]!.liqNotionalUsd, 900);
  },
);

scenario(
  "running extreme deepens via price ticks too, not just liquidation events",
  () => {
    const v5 = makeV5();
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 100, 1000));
    v5.onTick("ETHUSDT", 1990, 1500); // price ticks deeper, no liq-event
    const watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(watch.waves[0]!.extremePrice, 1990);
  },
);

scenario(
  "recovery ~1 UNIT + a single event that itself was >= P95 -> SIGNAL_CANDIDATE (hasP95Event)",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 1200, 1000)); // this ONE event itself clears P95=1000
    v5.onTick("ETHUSDT", 1990, 1500); // extreme deepens to 1990
    const outcomes = v5.onTick("ETHUSDT", 1990 + UNIT, 2000); // recovers exactly 1 UNIT
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0]!.kind, "SIGNAL_CANDIDATE");
  },
);

scenario(
  "recovery ~1 UNIT + a single event that never reached P95 -> CASCADE_NOT_SERIOUS (terminal, watch released)",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 50, 1000)); // well below P95
    v5.onTick("ETHUSDT", 1990, 1500);
    const outcomes = v5.onTick("ETHUSDT", 1990 + UNIT, 2000);
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0]!.kind, "TERMINAL_NON_SIGNAL");
    if (outcomes[0]!.kind === "TERMINAL_NON_SIGNAL") {
      assert.strictEqual(outcomes[0].event.reason, "CASCADE_NOT_SERIOUS");
    }
    assert.strictEqual(
      v5.getWatch("ETHUSDT", "LONG"),
      null,
      "watch must be released after a terminal outcome",
    );
  },
);

scenario(
  "operator-corrected model: MANY small events whose CUMULATIVE total exceeds P95, but NO SINGLE event ever does, must NOT trigger SIGNAL_CANDIDATE -- this is the exact distinction from the earlier (rejected) cumulative-vs-P95 design",
  () => {
    const v5 = makeV5(1, 1000);
    // 10 events of 150 each = 1500 cumulative (>> P95=1000), but every
    // single event is well under P95 individually.
    for (let i = 0; i < 10; i++) {
      v5.onLiquidation(liq("ETHUSDT", "SELL", 2000 - i, 150, 1000 + i * 10));
    }
    const watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(
      watch.totalEpisodePressure,
      1500,
      "small events must still accumulate normally for the trade-plan",
    );
    assert.strictEqual(
      watch.hasP95Event,
      false,
      "no individual event ever reached P95, so hasP95Event must stay false despite the large cumulative total",
    );

    v5.onTick("ETHUSDT", 1985, 1500);
    const outcomes = v5.onTick("ETHUSDT", 1985 + UNIT, 2000);
    assert.strictEqual(outcomes[0]!.kind, "TERMINAL_NON_SIGNAL");
    if (outcomes[0]!.kind === "TERMINAL_NON_SIGNAL") {
      assert.strictEqual(
        outcomes[0].event.reason,
        "CASCADE_NOT_SERIOUS",
        "a large CUMULATIVE total alone must never satisfy seriousness -- only a genuine single-event P95 clearance does",
      );
    }
  },
);

scenario(
  "hasP95Event latches true on a LATER event, not just the first -- and never resets once true, even as more small events follow",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 50, 1000)); // small, hasP95Event stays false
    let watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(watch.hasP95Event, false);

    v5.onLiquidation(liq("ETHUSDT", "SELL", 1998, 1500, 1100)); // THIS one clears P95
    watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(
      watch.hasP95Event,
      true,
      "a later, qualifying event must latch hasP95Event true",
    );

    v5.onLiquidation(liq("ETHUSDT", "SELL", 1995, 20, 1200)); // another tiny event afterward
    watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(
      watch.hasP95Event,
      true,
      "hasP95Event must never reset to false once latched true",
    );
  },
);

scenario(
  "recovery LESS than 1 UNIT never triggers any outcome -- cascade keeps tracking",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 1200, 1000));
    v5.onTick("ETHUSDT", 1990, 1500);
    const outcomes = v5.onTick("ETHUSDT", 1990 + UNIT * 0.5, 2000); // only half a UNIT
    assert.strictEqual(outcomes.length, 0);
    assert.ok(
      v5.getWatch("ETHUSDT", "LONG"),
      "watch must still be active, no premature completion",
    );
  },
);

scenario(
  "small opposite-direction pullbacks (noise) never end the cascade prematurely -- extreme keeps extending through them",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 1200, 1000));
    v5.onTick("ETHUSDT", 1995, 1100); // extreme -> 1995
    v5.onTick("ETHUSDT", 1995.3, 1200); // tiny pullback, well under 1 UNIT -- must NOT trigger completion
    const stillActive = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(
      stillActive.waves[0]!.state,
      "ACTIVE",
      "a sub-UNIT pullback must never complete the cascade",
    );
    v5.onTick("ETHUSDT", 1985, 1300); // resumes, deeper than original extreme
    const watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(
      watch.waves[0]!.extremePrice,
      1985,
      "extreme must reflect the DEEPEST price reached, unaffected by the intermediate small pullback",
    );
  },
);

scenario(
  "entryWaveNumber is always 1 -- no W1/W2/W3 segmentation in the minimal model",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 1200, 1000));
    v5.onTick("ETHUSDT", 1990, 1500);
    const outcomes = v5.onTick("ETHUSDT", 1990 + UNIT, 2000);
    assert.strictEqual(outcomes[0]!.kind, "SIGNAL_CANDIDATE");
    if (outcomes[0]!.kind === "SIGNAL_CANDIDATE") {
      assert.strictEqual(outcomes[0].entryWave.waveNumber, 1);
    }
  },
);

scenario(
  "SHORT victim (BUY liquidation) mirrors LONG victim correctly -- extreme deepens UPWARD, recovers DOWNWARD",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "BUY", 2000, 1200, 1000));
    const watch = v5.getWatch("ETHUSDT", "SHORT")!;
    assert.strictEqual(watch.victim, "SHORT");
    v5.onTick("ETHUSDT", 2010, 1500); // deeper = HIGHER for a short-victim cascade
    assert.strictEqual(watch.waves[0]!.extremePrice, 2010);
    const outcomes = v5.onTick("ETHUSDT", 2010 - UNIT, 2000); // recovers DOWNWARD
    assert.strictEqual(outcomes[0]!.kind, "SIGNAL_CANDIDATE");
  },
);

scenario(
  "UNIT is frozen at episode start -- unitAtStart never changes for the life of one watch",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 100, 1000));
    const watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(watch.unitAtStart, 1); // frozen at creation, from getUnit1mAbs() at that moment
  },
);

scenario("independent symbols/victims never interfere with each other", () => {
  const v5 = makeV5(1, 1000);
  v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 1200, 1000));
  v5.onLiquidation(liq("ADAUSDT", "BUY", 0.5, 1200, 1000));
  assert.ok(v5.getWatch("ETHUSDT", "LONG"));
  assert.ok(v5.getWatch("ADAUSDT", "SHORT"));
  assert.strictEqual(v5.getWatch("ETHUSDT", "SHORT"), null);
  assert.strictEqual(v5.getWatch("ADAUSDT", "LONG"), null);
});

scenario(
  "episode safety-timeout still terminates a stuck cascade (unchanged diagnostic-only valve, never a completion decision)",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 100, 1000));
    // Tick far in the future, well past the inactivity window, with price
    // that never reached 1 UNIT of recovery -- must terminate via
    // EPISODE_EXPIRED_INACTIVITY, not CASCADE_NOT_SERIOUS.
    const outcomes = v5.onTick("ETHUSDT", 2000, 1000 + 30 * 60_000);
    assert.strictEqual(outcomes.length, 1);
    if (outcomes[0]!.kind === "TERMINAL_NON_SIGNAL") {
      assert.strictEqual(
        outcomes[0].event.reason,
        "EPISODE_EXPIRED_INACTIVITY",
      );
    } else {
      assert.fail("expected TERMINAL_NON_SIGNAL");
    }
  },
);

scenario(
  "unitAtStart <= 0 (ATR1m not warm yet) never crashes, simply defers any completion decision",
  () => {
    const v5 = makeV5(0, 1000); // UNIT not warm
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 1200, 1000));
    const outcomes = v5.onTick("ETHUSDT", 1900, 1500); // huge recovery, but UNIT is 0
    assert.strictEqual(
      outcomes.length,
      0,
      "must not fire a completion decision while UNIT is unavailable",
    );
    assert.ok(
      v5.getWatch("ETHUSDT", "LONG"),
      "watch must remain active, not crash or silently drop",
    );
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
