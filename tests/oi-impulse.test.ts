/**
 * LONG after a flush (OI-down fall, then the biggest OI-up green candle). Usage: npx tsx tests/oi-impulse.test.ts
 */
import * as assert from "assert";
import { impulseLongs } from "../src/research/oi-impulse";
import type { Candle } from "../src/research/dc15";

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
const W = 15 * 60_000;
/** candles from [close, oi change %] steps; open = previous close, wicks 0.1 */
function build(steps: Array<[number, number]>): Candle[] {
  let p = 100,
    oi = 1000;
  return steps.map(([cl, d], i) => {
    const o = p,
      oi0 = oi;
    p = cl;
    oi = oi * (1 + d / 100);
    return {
      t: i * W,
      end: (i + 1) * W,
      open: o,
      high: Math.max(o, cl) + 0.1,
      low: Math.min(o, cl) - 0.1,
      close: cl,
      oi0,
      oi1: oi,
      liqL: 0,
      liqS: 0,
    };
  });
}
// warm-up: small wiggles with small OI moves (several moves for the RANK), then a 5% fall with OI -6% (the flush),
// a bounce 1 ATR (the flush is known), quiet at the bottom, then a green candle with the biggest OI rise
const warm: Array<[number, number]> = [];
for (let i = 0; i < 40; i++)
  warm.push([
    100 + (i % 6 < 3 ? (i % 6) * 0.6 : (6 - (i % 6)) * 0.6),
    i % 2 ? 0.1 : -0.1,
  ]);
const fall: Array<[number, number]> = [
  [99, -1],
  [98, -1.5],
  [97, -1.5],
  [96, -1],
  [95.2, -1],
];
const quiet: Array<[number, number]> = [
  [96.2, 0.1],
  [96.3, 0.05],
  [95.9, -0.05],
  [96.1, 0.05],
  [96.0, 0.02],
  [96.2, 0.05],
];

scenario(
  "flush (fall > TP with OI down, RANK 1), quiet bottom, then the biggest OI-up green candle -> LONG at its close",
  () => {
    const c = build([...warm, ...fall, ...quiet, [97.2, 1.5], [97.5, 0.2]]);
    const s = impulseLongs(c, { windowH: 12, lookbackH: 12, minMovePct: 2 });
    assert.strictEqual(s.length, 1, JSON.stringify(s));
    assert.deepStrictEqual([s[0].t, s[0].price], [c[c.length - 2].end, 97.2]);
    assert.ok(
      s[0].fallPct < -2 && s[0].fallOiPct < 0 && s[0].candleOiPct > 1,
      JSON.stringify(s[0]),
    );
  },
);
scenario("the low broken before the impulse -> no LONG", () => {
  const c = build([...warm, ...fall, ...quiet, [94.5, 0.1], [97.2, 1.5]]);
  assert.strictEqual(
    impulseLongs(c, { windowH: 12, lookbackH: 12, minMovePct: 2 }).length,
    0,
  );
});
scenario("a fall with OI UP (new shorts, not a flush) -> no LONG", () => {
  const up: Array<[number, number]> = fall.map(([p, d]) => [p, -d]);
  const c = build([...warm, ...up, ...quiet, [97.2, 1.5]]);
  assert.strictEqual(
    impulseLongs(c, { windowH: 12, lookbackH: 12, minMovePct: 2 }).length,
    0,
  );
});
scenario(
  "no look-ahead: the signal does not change when later candles are added",
  () => {
    const base = [...warm, ...fall, ...quiet, [97.2, 1.5] as [number, number]];
    const a = impulseLongs(build(base), { minMovePct: 2 }),
      b = impulseLongs(build([...base, [90, 3], [99, 2]]), { minMovePct: 2 });
    assert.deepStrictEqual(
      a.map((x) => x.t),
      b.filter((x) => x.t <= base.length * W).map((x) => x.t),
    );
  },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
