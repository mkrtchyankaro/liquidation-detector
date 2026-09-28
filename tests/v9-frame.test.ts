/**
 * v9-frame: the 4h frame (top / bottom zones) and the verdict.
 * Usage: npx tsx tests/v9-frame.test.ts
 */
import * as assert from "assert";
import {
  frameOf,
  verdictOf,
  widenZone,
  widenFrame,
  nearZone,
  K,
} from "../src/tools/v9-frame";

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
let t = 0;
const k = (open: number, high: number, low: number, close: number): K => ({
  ts: (t += 4 * 3_600_000),
  open,
  high,
  low,
  close,
});

// AVAX-like: rally to a peak (11.77 wick, body 11.40), down to ~10.0, turned up, now 10.4
const avax = (): K[] => {
  t = 0;
  return [
    k(9.5, 9.9, 9.4, 9.8),
    k(9.8, 10.9, 9.7, 10.8),
    k(10.8, 11.77, 10.7, 11.4),
    k(11.4, 11.45, 10.9, 11.0),
    k(11.0, 11.1, 10.3, 10.4),
    k(10.4, 10.5, 10.0, 10.15),
    k(10.15, 10.6, 10.1, 10.5),
    k(10.5, 10.9, 10.4, 10.8),
    k(10.8, 11.3, 10.6, 10.7),
    k(10.7, 10.75, 10.35, 10.4),
  ];
};

scenario(
  "peak came last: top = the peak wick, bottom = where it turned up",
  () => {
    const f = frameOf(avax())!;
    assert.strictEqual(f.last, "PEAK");
    assert.deepStrictEqual([f.top!.lo, f.top!.hi], [11.4, 11.77]);
    assert.deepStrictEqual([f.bottom!.lo, f.bottom!.hi], [10.0, 10.15]);
  },
);

scenario(
  "AVAX Sep 28: the cleaning stopped at 10.454 -> MIDDLE, no signal",
  () => {
    const v = verdictOf(frameOf(avax()), true, 10.454);
    assert.strictEqual(v.verdict, "MIDDLE");
    assert.ok(v.pos > 20 && v.pos < 30, String(v.pos));
  },
);

scenario(
  "BUY that reached the bottom zone (and one that pierced it) = IN_ZONE",
  () => {
    assert.strictEqual(
      verdictOf(frameOf(avax()), true, 10.1).verdict,
      "IN_ZONE",
    );
    const p = verdictOf(frameOf(avax()), true, 9.95);
    assert.strictEqual(p.verdict, "IN_ZONE");
    assert.ok(p.pierced);
  },
);

scenario("SELL at the top zone = IN_ZONE, SELL at the bottom = MIDDLE", () => {
  assert.strictEqual(
    verdictOf(frameOf(avax()), false, 11.45).verdict,
    "IN_ZONE",
  );
  assert.strictEqual(verdictOf(frameOf(avax()), false, 10.3).verdict, "MIDDLE");
});

scenario("still falling straight after the peak = NO_FRAME", () => {
  t = 0;
  const c = [
    k(10, 11, 9.9, 10.9),
    k(10.9, 12, 10.8, 11.8),
    k(11.8, 11.9, 11.2, 11.3),
    k(11.3, 11.4, 10.8, 10.9),
    k(10.9, 11, 10.3, 10.4),
  ];
  const f = frameOf(c)!;
  assert.strictEqual(f.bottom, null);
  assert.strictEqual(verdictOf(f, true, 10.3).verdict, "NO_FRAME");
});

scenario(
  "bottom came last: bottom = the low wick, top = where it turned down",
  () => {
    t = 0;
    const c = [
      k(12, 12.1, 11.5, 11.6),
      k(11.6, 11.7, 10.2, 10.4),
      k(10.4, 10.5, 9.8, 10.3),
      k(10.3, 11.2, 10.2, 11.1),
      k(11.1, 11.5, 10.9, 11.0),
      k(11.0, 11.1, 10.6, 10.7),
    ];
    const f = frameOf(c)!;
    assert.strictEqual(f.last, "BOTTOM");
    assert.deepStrictEqual([f.bottom!.lo, f.bottom!.hi], [9.8, 10.3]);
    assert.deepStrictEqual([f.top!.lo, f.top!.hi], [11.1, 11.5]);
  },
);

scenario(
  "top zone = union of touching wicks, from the first candle that reached it",
  () => {
    t = 0;
    const c = [
      k(9, 9.6, 8.9, 9.5),
      k(9.5, 11.5, 9.4, 11.3),
      k(11.3, 11.8, 11.1, 11.2),
      k(11.2, 11.35, 10.9, 11.0),
      k(11.0, 11.1, 10.5, 10.6),
      k(10.6, 11.25, 10.5, 11.15),
    ];
    const z = widenZone(c, 2, "TOP", -1);
    // candle 1 (the rise) leaves the wick 11.3-11.5 -> the peak candle touches it (body top 11.3) -> 11.3-11.8;
    // candle 3 wick 11.2-11.35 touches -> 11.2; candle 4 (11.1) no; candle 5 wick 11.15-11.25 touches the joined zone -> 11.15
    assert.deepStrictEqual(
      [z.lo, z.hi, z.touches, z.ts],
      [11.15, 11.8, 4, c[1].ts],
    );
  },
);

scenario(
  "bottom zone starts at the first wick there, even when a later candle is the lowest (AVAX Sep 23-24)",
  () => {
    t = 0;
    const c = [
      k(11.2, 11.25, 10.3, 10.35),
      k(10.35, 10.4, 10.07, 10.2),
      k(10.2, 10.3, 10.12, 10.25),
      k(10.25, 10.28, 9.97, 10.1),
      k(10.1, 10.5, 10.05, 10.45),
    ];
    const z = widenZone(c, 3, "BOTTOM", -1);
    // the big red candle's body goes through (not a wick); candle 1 leaves 10.07-10.2, candle 2 touches (10.12-10.2),
    // candle 3 (the lowest) touches -> 9.97; candle 4 touches (10.05-10.1)
    assert.deepStrictEqual(
      [z.lo, z.hi, z.touches, z.ts],
      [9.97, 10.2, 4, c[1].ts],
    );
  },
);

scenario("a candle whose body goes through the zone is not a wick", () => {
  t = 0;
  const c = [k(10.5, 10.6, 10.0, 10.1), k(10.1, 10.2, 9.8, 9.85)];
  const z = widenZone(c, 0, "BOTTOM", -1);
  assert.deepStrictEqual([z.lo, z.hi, z.touches], [10.0, 10.1, 1]);
});

scenario("widenFrame keeps the frame, NEAR = within one zone height", () => {
  const f = widenFrame(avax(), frameOf(avax()))!;
  assert.ok(f.top && f.bottom);
  const h = f.bottom!.hi - f.bottom!.lo;
  assert.ok(nearZone(f, true, f.bottom!.hi + h / 2));
  assert.ok(!nearZone(f, true, f.bottom!.hi + 2 * h));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
