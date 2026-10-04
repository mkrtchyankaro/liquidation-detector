/**
 * Zones of interest (bodies, 1-ATR turns). Usage: npx tsx tests/zones.test.ts
 */
import * as assert from "assert";
import {
  pivots,
  sdZones,
  zones,
  atrSeries,
  zoneOfDays,
  type ZCandle,
} from "../src/research/zones";

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
  "one zone per 10 days: the most-touched zone of the last 10 days; old touches outside the 10 days are not counted",
  () => {
    // ~110 touched 4 times (resistance x3, then support once), ~102 touched 3 times; all within the last 10 days (60 x 4h)
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
    const c = path(closes);
    const r = zoneOfDays(c, 10)!;
    assert.ok(
      r && r.z.lo <= 110.3 && r.z.hi >= 109.8,
      JSON.stringify(r?.z && [r.z.lo, r.z.hi]),
    );
    assert.strictEqual(r.z.pivots.length, 4);
    // with only the last 3 days the touches at ~110 from before are dropped -> no zone of 3+ touches
    assert.strictEqual(zoneOfDays(c, 3), null);
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

scenario(
  "supply / demand: small-body base before a strong candle; supply = highest wick .. lowest body; broken on a close above",
  () => {
    const D = 86_400_000,
      k = (
        i: number,
        o: number,
        h: number,
        l: number,
        cl: number,
      ): ZCandle => ({ t: i * D, open: o, high: h, low: l, close: cl });
    const c: ZCandle[] = Array.from({ length: 16 }, (_, i) =>
      k(i, 100, 101, 99, 100 + (i % 2 ? 0.5 : -0.5)),
    ); // ATR ~2
    c.push(k(16, 100, 108, 99.5, 107.5)); // a strong green candle up (a leg-out from the warm-up)
    c.push(k(17, 107.5, 110, 106, 108)); // base: small bodies, long wicks
    c.push(k(18, 108, 111, 106.5, 107.6));
    c.push(k(19, 107.6, 107.8, 101, 101.5)); // the strong drop: body 6.1 of range 6.8, >= ATR -> SUPPLY from the base
    c.push(k(20, 101.5, 104, 101, 103));
    const z = sdZones(c).find((x) => x.kind === "SUPPLY")!;
    assert.ok(z, JSON.stringify(sdZones(c)));
    assert.deepStrictEqual(
      [z.lo, z.hi, z.baseN, z.brokenT],
      [107.5, 111, 2, null],
    );
    c.push(k(21, 103, 108, 102.5, 107.8)); // into the zone (touch), not beyond its top
    c.push(k(22, 107.8, 112, 107, 111.5)); // a close above 111 -> broken
    const z2 = sdZones(c).find((x) => x.kind === "SUPPLY")!;
    assert.deepStrictEqual([z2.touches, z2.brokenT], [1, 22 * D]);
  },
);

scenario(
  "supply from a drop made of several medium candles (none alone 1 ATR, together more)",
  () => {
    const D = 86_400_000,
      k = (
        i: number,
        o: number,
        h: number,
        l: number,
        cl: number,
      ): ZCandle => ({ t: i * D, open: o, high: h, low: l, close: cl });
    const c: ZCandle[] = Array.from({ length: 16 }, (_, i) =>
      k(i, 100, 101, 99, 100 + (i % 2 ? 0.5 : -0.5)),
    ); // ATR ~2
    c.push(k(16, 100, 103, 99.5, 100.3)); // base: a small body, long wicks (with the quiet candles before it)
    c.push(k(17, 100.3, 100.5, 98.9, 99.1)); // -1.2 (decisive, < 1 ATR)
    c.push(k(18, 99.1, 99.2, 97.8, 97.9)); // -1.2 -> together 2.4 >= ATR
    c.push(k(19, 97.9, 98.5, 97.5, 98.2));
    const z = sdZones(c).find((x) => x.kind === "SUPPLY");
    assert.ok(z, JSON.stringify(sdZones(c)));
    assert.deepStrictEqual([z!.lo, z!.hi, z!.legT], [99.5, 103, 18 * D]);
  },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
