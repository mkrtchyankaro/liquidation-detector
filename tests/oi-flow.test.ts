/**
 * OI flows (IN / OUT minute by minute). Usage: npx tsx tests/oi-flow.test.ts
 */
import * as assert from "assert";
import {
  flowPoints,
  flowSignals,
  sizeBucket,
  type FlowMinute,
} from "../src/research/oi-flow";

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
const M = 60_000;
const rows = (oi: number[], liq: Array<[number, number]> = []): FlowMinute[] =>
  oi.map((x, i) => ({
    t: i * M,
    oi: x,
    high: 100.5,
    low: 99.5,
    close: 100,
    longLiq: liq[i]?.[0] ?? 0,
    shortLiq: liq[i]?.[1] ?? 0,
  }));

scenario(
  "IN and OUT inside ONE window are both counted (+8 then -7 is not 'net +1')",
  () => {
    const p = flowPoints(rows([100, 108, 101, 101, 101, 101]), 5, 1);
    assert.ok(Number.isNaN(p[4].up)); // window 0 not finished yet
    assert.deepStrictEqual([p[5].up, p[5].down], [8, 7]);
  },
);

const warm = [100, 101, 100, 101, 100, 101, 100];
const drop0 = [98, 96, 94]; // the drop before (shorts liquidated)
const rise = [96, 98, 100, 102, 104]; // new positions
const drop = [102, 100]; // longs liquidated
const story = [...warm, ...drop0, ...rise, ...drop];
const liq = (before: 0 | 1 | null, now: 0 | 1): Array<[number, number]> =>
  story.map((_, i) => {
    const a = warm.length,
      b = a + drop0.length,
      c = b + rise.length;
    if (i >= a && i < b && before !== null)
      return before === 0 ? [900, 0] : [0, 900];
    if (i >= c) return now === 0 ? [500, 0] : [0, 500];
    return [0, 0];
  });
const opts = { tf: 1, n: 2, rev: 1, minSlPct: 0.33, maxGapMin: 15 };

scenario(
  "rise then longs liquidated -> SHORT with the move, at the first minute the drop is known",
  () => {
    const s = flowSignals("X", rows(story, liq(1, 0)), opts);
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].side, "SHORT");
    assert.strictEqual(s[0].victim, "LONG");
    assert.strictEqual(s[0].t, (story.length - 2 + 1) * M);
    assert.strictEqual(s[0].prior, "OTHER_SIDE");
    assert.ok(s[0].sl > s[0].entry && s[0].accIn > 1);
  },
);
scenario(
  "the drop before liquidated the SAME side -> prior SAME_SIDE (CONT keeps it, REV not)",
  () => {
    const s = flowSignals("X", rows(story, liq(0, 0)), opts);
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].prior, "SAME_SIDE");
  },
);
scenario("mirror: shorts liquidated -> LONG", () => {
  const s = flowSignals("X", rows(story, liq(0, 1)), opts);
  assert.strictEqual(s[0].side, "LONG");
  assert.ok(s[0].sl < s[0].entry);
});
scenario("no liquidations in the drop -> no signal", () => {
  assert.strictEqual(flowSignals("X", rows(story), opts).length, 0);
});
scenario("no look-ahead: cut data gives the same signal", () => {
  const full = rows(
    [...story, 98, 95, 99],
    [...liq(1, 0), [0, 0], [0, 0], [0, 0]],
  );
  const cut = full.slice(0, story.length);
  assert.deepStrictEqual(
    flowSignals("X", cut, opts),
    flowSignals("X", full, opts).filter((x) => x.t <= story.length * M),
  );
});
scenario("buckets", () => {
  assert.deepStrictEqual([0.5, 1.5, 2.5, 4, 7, 12].map(sizeBucket), [
    "<1",
    "1-2",
    "2-3",
    "3-5",
    "5-10",
    "10+",
  ]);
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
