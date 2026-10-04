/**
 * Zones of interest (bodies, 1-ATR turns). Usage: npx tsx tests/zones.test.ts
 */
import * as assert from "assert";
import { pivots, zones, atrSeries, type ZCandle } from "../src/research/zones";

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
const H4 = 4 * 3_600_000;
/** candles walking through the given closes (open = the previous close, wicks 0.2 beyond the body) */
function path(closes: number[]): ZCandle[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return {
      t: i * H4,
      open: o,
      high: Math.max(o, c) + 0.2,
      low: Math.min(o, c) - 0.2,
      close: c,
    };
  });
}
const go = (from: number, to: number, steps: number): number[] =>
  Array.from(
    { length: steps },
    (_, i) => from + ((to - from) * (i + 1)) / steps,
  );

scenario(
  "resistance hit 3 times from below, broken, retested from above -> one zone, a FLIP (now support)",
  () => {
    // warm-up wiggle, then 3 rejections at ~110, a break to 120, a pullback to ~110, up again
    const closes = [
      ...Array.from({ length: 16 }, (_, i) => 100 + (i % 2)),
      ...go(100, 110, 5),
      ...go(110, 102, 4),
      ...go(102, 110.3, 4),
      ...go(110.3, 101, 4),
      ...go(101, 109.8, 4),
      ...go(109.8, 103, 4),
      ...go(103, 120, 6),
      ...go(120, 110.2, 5),
      ...go(110.2, 121, 5),
    ];
    const c = path(closes),
      ps = pivots(c, 1, 14),
      atr = atrSeries(c, 14);
    const zs = zones(ps, atr[atr.length - 1], 0.5, 2);
    const z = zs.find((x) => x.lo <= 110.3 && x.hi >= 109.8)!;
    assert.ok(z, JSON.stringify(zs.map((x) => [x.lo, x.hi])));
    assert.deepStrictEqual([z.tops, z.bottoms, z.flip], [3, 1, "UP"]);
    assert.ok(z.hi - z.lo < 1, `${z.lo}-${z.hi}`);
    assert.ok(z.wickHi > z.hi, "the wicks are shown beside the body zone");
  },
);
scenario(
  "a turning point is known only after the 1-ATR close (no look-ahead): the last top is not there yet",
  () => {
    const closes = [
      ...Array.from({ length: 16 }, (_, i) => 100 + (i % 2)),
      ...go(100, 110, 5),
    ];
    const ps = pivots(path(closes), 1, 14);
    assert.ok(
      !ps.some((p) => p.kind === "TOP" && p.body >= 109),
      JSON.stringify(ps),
    );
  },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
