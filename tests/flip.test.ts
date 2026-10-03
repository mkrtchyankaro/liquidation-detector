/**
 * FLIP (stop and reverse). Usage: npx tsx tests/flip.test.ts
 */
import * as assert from "assert";
import { flipCoin, type FlipSig } from "../src/research/flip";
import type { Candle, MinBar } from "../src/research/dc15";

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
const M = 60_000,
  W = 15 * M;
const cand = (
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  oi0 = 100,
  oi1 = 100,
): Candle => ({
  t: i * W,
  end: (i + 1) * W,
  open,
  high,
  low,
  close,
  oi0,
  oi1,
  liqL: 0,
  liqS: 0,
});
// 20 flat candles (ATR 2), one minute bar per candle carrying its high / low
const flat = (): Candle[] =>
  Array.from({ length: 20 }, (_, i) => cand(i, 100, 101, 99, 100));
const minutes = (c: Candle[]): MinBar[] =>
  c.map((x) => ({
    t: x.t,
    high: x.high,
    low: x.low,
    close: x.close,
    oiFirst: x.oi0,
    oiLast: x.oi1,
  }));
const SHORT: FlipSig = { t: 20 * W, side: "SHORT", price: 100 };

scenario(
  "SHORT closed by a green candle with OI up, 1 ATR above the low (TURN)",
  () => {
    const c = [
      ...flat(),
      cand(20, 100, 100.5, 96, 97),
      cand(21, 97, 99.8, 96.5, 99.5, 100, 103),
      cand(22, 99.5, 99.8, 98, 98),
    ];
    const tr = flipCoin("X", minutes(c), c, [SHORT], 1, 0);
    assert.strictEqual(tr.length, 1);
    assert.deepStrictEqual(
      [tr[0].exit, tr[0].exitT, +tr[0].r.toFixed(2)],
      ["TURN", 22 * W, 0.5],
    );
  },
);
scenario("a green candle 1 ATR up but OI DOWN does not close it", () => {
  const c = [
    ...flat(),
    cand(20, 100, 100.5, 96, 97),
    cand(21, 97, 99.8, 96.5, 99.5, 103, 100),
    cand(22, 99.5, 99.8, 98, 98),
  ];
  const tr = flipCoin("X", minutes(c), c, [SHORT], 1, 0);
  assert.deepStrictEqual([tr.length, tr[0].exit], [1, "OPEN"]);
});
scenario(
  "a green candle with OI up but less than 1 ATR from the low does not close it",
  () => {
    const c = [
      ...flat(),
      cand(20, 100, 100.5, 96, 97),
      cand(21, 97, 97.5, 96.5, 97.3, 100, 103),
    ];
    assert.strictEqual(
      flipCoin("X", minutes(c), c, [SHORT], 1, 0)[0].exit,
      "OPEN",
    );
  },
);
scenario("SL 1% on a minute's high", () => {
  const c = [...flat(), cand(20, 100, 101.2, 99, 100.5)];
  const tr = flipCoin("X", minutes(c), c, [SHORT], 1, 0);
  assert.deepStrictEqual([tr[0].exit, +tr[0].r.toFixed(2)], ["SL", -1]);
});
scenario(
  "the opposite full signal flips: SHORT closed, LONG opened at the same close",
  () => {
    const c = [
      ...flat(),
      cand(20, 100, 100.5, 96, 97),
      cand(21, 97, 98, 96.5, 97.6, 103, 100),
      cand(22, 97.6, 98.5, 97.5, 98.4),
    ];
    const tr = flipCoin(
      "X",
      minutes(c),
      c,
      [SHORT, { t: 22 * W, side: "LONG", price: 97.6 }],
      1,
      0,
    );
    assert.deepStrictEqual(
      tr.map((d) => [d.side, d.exit, d.t]),
      [
        ["SHORT", "FLIP", 20 * W],
        ["LONG", "OPEN", 22 * W],
      ],
    );
  },
);
scenario(
  "LONG closed by a red candle with OI down, 1 ATR below the high",
  () => {
    const c = [
      ...flat(),
      cand(20, 100, 104, 99.5, 103),
      cand(21, 103, 103.5, 100.2, 100.5, 103, 100),
    ];
    const tr = flipCoin(
      "X",
      minutes(c),
      c,
      [{ t: 20 * W, side: "LONG", price: 100 }],
      1,
      0,
    );
    assert.deepStrictEqual([tr[0].exit, +tr[0].r.toFixed(2)], ["TURN", 0.5]);
  },
);
scenario(
  "a same-side signal while in a position is ignored; after the close the next one opens",
  () => {
    const c = [
      ...flat(),
      cand(20, 100, 100.5, 96, 97),
      cand(21, 97, 99.8, 96.5, 99.5, 100, 103),
      cand(22, 99.5, 99.8, 98, 98),
    ];
    const tr = flipCoin(
      "X",
      minutes(c),
      c,
      [
        SHORT,
        { t: 21 * W, side: "SHORT", price: 97 },
        { t: 23 * W, side: "SHORT", price: 98 },
      ],
      1,
      0,
    );
    assert.deepStrictEqual(
      tr.map((d) => [d.t, d.exit]),
      [
        [20 * W, "TURN"],
        [23 * W, "OPEN"],
      ],
    );
  },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
