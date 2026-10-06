/**
 * The position ledger (estimated liquidation zones). Usage: npx tsx tests/liq-ledger.test.ts
 */
import * as assert from "assert";
import { LiqLedger, type LedgerMinute } from "../src/research/liq-ledger";

let passed = 0,
  failed = 0;
function scenario(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(
      `  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
const m = (x: Partial<LedgerMinute>): LedgerMinute => ({
  t: 0,
  high: 100,
  low: 100,
  close: 100,
  vol: 0,
  oi: 1000,
  dOi: 0,
  ...x,
});
const sum = (a: Float64Array): number => a.reduce((s, v) => s + v, 0);
const near = (a: number, b: number, eps = 1e-6): void =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

scenario(
  "OI up opens longs and shorts at the price; liquidation prices per tier",
  () => {
    const l = new LiqLedger(50, 2000, "oi", 0.1, [10]);
    l.seed(0, [], 100);
    l.step(m({ dOi: 10 }));
    const lm = l.liqMap();
    near(l.price(lm.long.findIndex((v) => v > 0)), 90, 0.1);
    near(l.price(lm.short.findIndex((v) => v > 0)), 110, 0.1);
    near(sum(lm.long), 10);
  },
);
scenario(
  "a reached liquidation price burns, and that part is not closed twice",
  () => {
    const l = new LiqLedger(50, 2000, "oi", 0.1, [10]);
    l.seed(0, [], 100);
    l.step(m({ dOi: 10 }));
    l.step(m({ dOi: 4 }));
    l.step(m({ low: 89, close: 91, dOi: -14 }));
    near(sum(l.burnedLong), 14);
    near(l.total("long"), 0);
    near(l.total("short"), 0);
  },
);
scenario(
  "price up + OI flat (vol model): longs from BELOW are handed to new longs at the price",
  () => {
    const l = new LiqLedger(50, 2000, "vol", 0.1, [100]);
    l.seed(0, [], 100);
    l.step(m({ vol: 10, dOi: 10, close: 100 }));
    l.step(m({ vol: 4, dOi: 0, close: 100.5, high: 100.5 }));
    const e = l.entries();
    near(e.long[l.idx(100)], 8);
    near(e.long[l.idx(100.5)], 2);
  },
);
scenario("closes come from the side the price moved away from first", () => {
  const l = new LiqLedger(50, 2000, "oi", 0.1, [10]);
  l.seed(
    20,
    [
      [95, 1],
      [105, 1],
    ],
    100,
  );
  l.step(m({ close: 101, dOi: -5 }));
  const e = l.entries();
  near(e.long[l.idx(95)], 5);
  near(e.long[l.idx(105)], 10);
});

scenario(
  "calibrated: new positions start at the highest tier; only the REAL liquidations die, the rest moves a tier down",
  () => {
    const l = new LiqLedger(50, 2000, "oi", 0.1, [100, 50, 10], 0, true);
    l.seed(0, [], 100);
    l.step(m({ dOi: 10 })); // 10 longs at 100x -> level ~99
    l.step(m({ low: 98.5, close: 99, dOi: -2, liqL: 2 })); // the level is reached, our DB: 2 longs liquidated
    near(sum(l.burnedLong), 2);
    near(l.long[1][l.idx(100)], 8); // 8 survived -> 50x
    near(l.pDie(0), 0.2);
    near(l.total("short"), 8); // the other side of those 2 closed
  },
);
scenario(
  "calibrated liqMap spreads a position over its tiers with the learned chances",
  () => {
    const l = new LiqLedger(50, 2000, "oi", 0.1, [100, 50, 10], 0, true);
    l.seed(0, [], 100);
    l.step(m({ dOi: 10 }));
    l.step(m({ low: 98.5, close: 99, dOi: -2, liqL: 2 })); // 100x: 20% die
    l.step(m({ dOi: 10, close: 100, low: 100 })); // 10 new at 100x
    const lm = l.liqMap();
    near(lm.long[l.idx(100 * 0.99)], 2); // 10 x 20% at the 100x level
    // untested tiers use the pooled 20%: new 10 -> 2 + 1.6 + 1.28; the 8 survivors at 50x -> 1.6 + 1.28
    near(sum(lm.long), 2 + 1.6 + 1.28 + 1.6 + 1.28);
  },
);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
