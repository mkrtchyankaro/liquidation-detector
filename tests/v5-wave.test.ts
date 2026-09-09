/**
 * Sep 9 2026 (Karo), operator-designed Wave1/Wave2 requirement.
 * REPLACES the previous "single-wave, signal-eligible-on-1x-UNIT"
 * test suite -- that behavior no longer exists. New invariant:
 *
 *   Wave 1 can NEVER produce a signal. It completes at 1x UNIT
 *   recovery from its own extreme, then either a new same-victim
 *   liquidation starts Wave 2 (which alone is signal-eligible, using
 *   the EXACT SAME qualification/recovery logic Wave 1 used to use),
 *   or price recovers a further 1x UNIT (2x UNIT total from Wave 1's
 *   own fixed extreme) with no Wave 2 ever starting, cancelling the
 *   whole setup (CANCEL_NO_SECOND_WAVE). Purely price-structure-based
 *   -- no time-based timeout anywhere in this logic.
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

const UNIT = 1;
const P95 = 1000;

function makeV5(unit = UNIT, p95 = P95, baseline = 100): V5WaveService {
  return new V5WaveService(
    () => 500,
    () => unit,
    () => null,
    () => baseline,
    () => p95,
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

console.log("Running V5WaveService (Wave1/Wave2 requirement) tests...\n");

scenario(
  "cascade starts from ANY liquidation event, no P95 gate at episode-start (SELL=LONG victim)",
  () => {
    const v5 = makeV5();
    const outcomes = v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 1, 1000));
    assert.strictEqual(outcomes.length, 0);
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
  "running extreme deepens via price ticks too, not just liquidation events (Wave 1, still ACTIVE)",
  () => {
    const v5 = makeV5();
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 100, 1000));
    v5.onTick("ETHUSDT", 1990, 1500);
    const watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(watch.waves[0]!.extremePrice, 1990);
  },
);

scenario(
  "recovery LESS than 1 UNIT never triggers any outcome -- Wave 1 keeps tracking (ACTIVE)",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 1200, 1000));
    v5.onTick("ETHUSDT", 1990, 1500);
    const outcomes = v5.onTick("ETHUSDT", 1990 + UNIT * 0.5, 2000);
    assert.strictEqual(outcomes.length, 0);
    assert.strictEqual(
      v5.getWatch("ETHUSDT", "LONG")!.waves[0]!.state,
      "ACTIVE",
    );
  },
);

scenario(
  "small opposite-direction pullbacks (noise) never end Wave 1 prematurely -- extreme keeps extending through them",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 1200, 1000));
    v5.onTick("ETHUSDT", 1995, 1100);
    v5.onTick("ETHUSDT", 1995.3, 1200);
    assert.strictEqual(
      v5.getWatch("ETHUSDT", "LONG")!.waves[0]!.state,
      "ACTIVE",
    );
    v5.onTick("ETHUSDT", 1985, 1300);
    assert.strictEqual(
      v5.getWatch("ETHUSDT", "LONG")!.waves[0]!.extremePrice,
      1985,
    );
  },
);

scenario(
  "hasP95Event latches true on a LATER event, not just the first -- and never resets once true, even as more small events follow (Wave 1's own accumulation)",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 50, 1000));
    let watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(watch.hasP95Event, false);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 1998, 1500, 1100));
    watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(watch.hasP95Event, true);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 1995, 20, 1200));
    watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(watch.hasP95Event, true);
  },
);

scenario(
  "UNIT is frozen at episode start -- unitAtStart never changes for the life of one watch",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 100, 1000));
    const watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(watch.unitAtStart, 1);
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
    const v5 = makeV5(0, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 1200, 1000));
    const outcomes = v5.onTick("ETHUSDT", 1900, 1500);
    assert.strictEqual(outcomes.length, 0);
    assert.ok(v5.getWatch("ETHUSDT", "LONG"));
  },
);

scenario(
  "W1 + 1 UNIT recovery -> NO ENTRY (no outcome at all, Wave 1 simply completes and waits)",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 5000, 1000));
    v5.onLiquidation(liq("ETHUSDT", "SELL", 1999, 10, 1050));
    v5.onTick("ETHUSDT", 1990, 1500);
    const outcomes = v5.onTick("ETHUSDT", 1990 + UNIT, 2000);
    assert.strictEqual(
      outcomes.length,
      0,
      "Wave 1 reaching 1x UNIT must NEVER produce any outcome, regardless of P95/eventCount",
    );
    const watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(watch.waves.length, 1);
    assert.strictEqual(
      watch.waves[0]!.state,
      "COMPLETED",
      "Wave 1 itself must be marked COMPLETED even though no signal fired",
    );
  },
);

scenario("W1 + 2 UNIT recovery, no W2 -> CANCEL_NO_SECOND_WAVE", () => {
  const v5 = makeV5(1, 1000);
  v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 5000, 1000));
  v5.onTick("ETHUSDT", 1990, 1500);
  const w1complete = v5.onTick("ETHUSDT", 1990 + UNIT, 2000);
  assert.strictEqual(w1complete.length, 0);
  const stillWaiting = v5.onTick("ETHUSDT", 1990 + UNIT * 1.5, 2500);
  assert.strictEqual(
    stillWaiting.length,
    0,
    "between 1x and 2x UNIT, with no Wave 2, nothing fires yet",
  );
  const cancelled = v5.onTick("ETHUSDT", 1990 + 2 * UNIT, 3000);
  assert.strictEqual(cancelled.length, 1);
  if (cancelled[0]!.kind === "TERMINAL_NON_SIGNAL") {
    assert.strictEqual(cancelled[0].event.reason, "CANCEL_NO_SECOND_WAVE");
  } else {
    assert.fail("expected TERMINAL_NON_SIGNAL/CANCEL_NO_SECOND_WAVE");
  }
  assert.strictEqual(
    v5.getWatch("ETHUSDT", "LONG"),
    null,
    "watch must be released after CANCEL_NO_SECOND_WAVE",
  );
});

scenario(
  "W1 + 1 UNIT recovery + same-victim liquidation -> W2 starts (fresh anchor, fresh liqEvents, fresh hasP95Event)",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 5000, 1000));
    v5.onTick("ETHUSDT", 1990, 1500);
    v5.onTick("ETHUSDT", 1990 + UNIT, 2000);

    const outcomes = v5.onLiquidation(liq("ETHUSDT", "SELL", 1991, 30, 2100));
    assert.strictEqual(outcomes.length, 0);
    const watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(watch.waves.length, 2, "Wave 2 must now exist");
    assert.strictEqual(watch.waves[1]!.waveNumber, 2);
    assert.strictEqual(
      watch.waves[1]!.anchorPrice,
      1991,
      "Wave 2's own anchor must be the triggering event's own price, not inherited from Wave 1",
    );
    assert.strictEqual(
      watch.waves[1]!.liqEvents,
      1,
      "Wave 2 starts with a FRESH liqEvents count, not inherited from Wave 1",
    );
    assert.strictEqual(
      watch.hasP95Event,
      false,
      "Wave 2 starts with a FRESH hasP95Event -- the small 30-notional trigger event does not itself clear P95=1000",
    );
  },
);

scenario(
  "W2 completes existing qualification/recovery (min-2-events + hasP95Event + 1x UNIT from Wave 2's own extreme) -> signal can be produced",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 5000, 1000));
    v5.onTick("ETHUSDT", 1990, 1500);
    v5.onTick("ETHUSDT", 1990 + UNIT, 2000);

    v5.onLiquidation(liq("ETHUSDT", "SELL", 1991, 1500, 2100));
    v5.onLiquidation(liq("ETHUSDT", "SELL", 1990.5, 20, 2150));
    v5.onTick("ETHUSDT", 1985, 2200);

    const outcomes = v5.onTick("ETHUSDT", 1985 + UNIT, 2300);
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0]!.kind, "SIGNAL_CANDIDATE");
    if (outcomes[0]!.kind === "SIGNAL_CANDIDATE") {
      assert.strictEqual(
        outcomes[0].entryWave.waveNumber,
        2,
        "the signal-eligible wave must be Wave 2, never Wave 1",
      );
    }
  },
);

scenario(
  "waveCount < 2 -> ENTRY IS IMPOSSIBLE, even with a huge, obviously-serious Wave 1 (structural proof)",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 100_000, 1000));
    v5.onLiquidation(liq("ETHUSDT", "SELL", 1999, 50_000, 1050));
    v5.onTick("ETHUSDT", 1990, 1500);
    const outcomes = v5.onTick("ETHUSDT", 1990 + UNIT, 2000);
    assert.strictEqual(
      outcomes.length,
      0,
      "no matter how large or how well-qualified Wave 1 is, it can NEVER produce a signal",
    );
  },
);

scenario(
  "opposite-victim liquidation does NOT count as Wave 2 -- it starts its own, completely separate SHORT-victim watch",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 5000, 1000));
    v5.onTick("ETHUSDT", 1990, 1500);
    v5.onTick("ETHUSDT", 1990 + UNIT, 2000);

    v5.onLiquidation(liq("ETHUSDT", "BUY", 1991, 5000, 2100));

    const longWatch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(
      longWatch.waves.length,
      1,
      "the LONG-victim watch's own Wave 1 must remain the ONLY wave -- the opposite-victim event must never be treated as its Wave 2",
    );
    assert.strictEqual(
      longWatch.waves[0]!.state,
      "COMPLETED",
      "LONG Wave 1 stays completed, still awaiting its OWN Wave 2 or 2x UNIT cancel",
    );

    const shortWatch = v5.getWatch("ETHUSDT", "SHORT")!;
    assert.ok(
      shortWatch,
      "the BUY (SHORT-victim) event must start its OWN, independent watch",
    );
    assert.strictEqual(shortWatch.waves.length, 1);
    assert.strictEqual(
      shortWatch.waves[0]!.waveNumber,
      1,
      "the SHORT-victim watch's own first wave is ITS OWN Wave 1, unrelated to the LONG watch's Wave 2 concept",
    );
  },
);

scenario(
  "SHORT victim: W1 + 1 UNIT recovery -> NO ENTRY (mirrors LONG exactly, extreme deepens UPWARD, recovers DOWNWARD)",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "BUY", 2000, 5000, 1000));
    v5.onLiquidation(liq("ETHUSDT", "BUY", 2001, 10, 1050));
    const watch = v5.getWatch("ETHUSDT", "SHORT")!;
    assert.strictEqual(watch.victim, "SHORT");
    v5.onTick("ETHUSDT", 2010, 1500);
    const outcomes = v5.onTick("ETHUSDT", 2010 - UNIT, 2000);
    assert.strictEqual(
      outcomes.length,
      0,
      "SHORT-victim Wave 1 must also never produce a signal",
    );
    assert.strictEqual(watch.waves[0]!.state, "COMPLETED");
  },
);

scenario(
  "SHORT victim: W1 + 2 UNIT recovery, no W2 -> CANCEL_NO_SECOND_WAVE",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "BUY", 2000, 5000, 1000));
    v5.onTick("ETHUSDT", 2010, 1500);
    v5.onTick("ETHUSDT", 2010 - UNIT, 2000);
    const cancelled = v5.onTick("ETHUSDT", 2010 - 2 * UNIT, 3000);
    assert.strictEqual(cancelled.length, 1);
    if (cancelled[0]!.kind === "TERMINAL_NON_SIGNAL") {
      assert.strictEqual(cancelled[0].event.reason, "CANCEL_NO_SECOND_WAVE");
    } else {
      assert.fail("expected CANCEL_NO_SECOND_WAVE");
    }
  },
);

scenario(
  "SHORT victim: W1 complete + same-victim liquidation -> W2 starts, then completes with signal",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "BUY", 2000, 5000, 1000));
    v5.onTick("ETHUSDT", 2010, 1500);
    v5.onTick("ETHUSDT", 2010 - UNIT, 2000);

    v5.onLiquidation(liq("ETHUSDT", "BUY", 2009, 1500, 2100));
    v5.onLiquidation(liq("ETHUSDT", "BUY", 2009.5, 20, 2150));
    v5.onTick("ETHUSDT", 2015, 2200);

    const outcomes = v5.onTick("ETHUSDT", 2015 - UNIT, 2300);
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0]!.kind, "SIGNAL_CANDIDATE");
    if (outcomes[0]!.kind === "SIGNAL_CANDIDATE") {
      assert.strictEqual(outcomes[0].entryWave.waveNumber, 2);
      assert.strictEqual(outcomes[0].watch.victim, "SHORT");
    }
  },
);

scenario(
  "min-2-events rule still applies to Wave 2 (unchanged logic, now evaluated at the Wave 2 level): ONE event -> NO SIGNAL",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 5000, 1000));
    v5.onTick("ETHUSDT", 1990, 1500);
    v5.onTick("ETHUSDT", 1990 + UNIT, 2000);

    v5.onLiquidation(liq("ETHUSDT", "SELL", 1991, 5000, 2100));
    v5.onTick("ETHUSDT", 1985, 2200);
    const outcomes = v5.onTick("ETHUSDT", 1985 + UNIT, 2300);
    assert.strictEqual(outcomes.length, 1);
    if (outcomes[0]!.kind === "TERMINAL_NON_SIGNAL") {
      assert.strictEqual(
        outcomes[0].event.reason,
        "CASCADE_NOT_SERIOUS",
        "Wave 2 with only 1 event must still fail min-2-events, exactly like the old single-wave model did",
      );
    } else {
      assert.fail("expected CASCADE_NOT_SERIOUS");
    }
  },
);

scenario(
  "hasP95Event does not carry over cumulatively from Wave 1 into Wave 2 -- many small Wave-2 events whose CUMULATIVE total exceeds P95 must NOT signal if no SINGLE Wave-2 event does",
  () => {
    const v5 = makeV5(1, 1000);
    v5.onLiquidation(liq("ETHUSDT", "SELL", 2000, 5000, 1000));
    v5.onTick("ETHUSDT", 1990, 1500);
    v5.onTick("ETHUSDT", 1990 + UNIT, 2000);

    for (let i = 0; i < 10; i++) {
      v5.onLiquidation(
        liq("ETHUSDT", "SELL", 1991 - i * 0.1, 150, 2100 + i * 10),
      );
    }
    const watch = v5.getWatch("ETHUSDT", "LONG")!;
    assert.strictEqual(
      watch.hasP95Event,
      false,
      "Wave 2's own hasP95Event must be false -- Wave 1's own true state must NOT carry over",
    );

    v5.onTick("ETHUSDT", 1980, 2500);
    const outcomes = v5.onTick("ETHUSDT", 1980 + UNIT, 2600);
    assert.strictEqual(outcomes.length, 1);
    if (outcomes[0]!.kind === "TERMINAL_NON_SIGNAL") {
      assert.strictEqual(outcomes[0].event.reason, "CASCADE_NOT_SERIOUS");
    } else {
      assert.fail(
        "expected CASCADE_NOT_SERIOUS -- a large CUMULATIVE Wave-2 total alone must never satisfy seriousness",
      );
    }
  },
);

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
