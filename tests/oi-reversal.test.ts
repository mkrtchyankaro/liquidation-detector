/**
 * Reversal after an OI accumulation (15m inside the OI-drop hour). Usage: npx tsx tests/oi-reversal.test.ts
 */
import * as assert from "assert";
import type { MvHour } from "../src/research/oi-moves";
import {
  liveReversals,
  type Minute,
  type Q15,
} from "../src/research/oi-reversal";

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
const H = 3_600_000,
  M15 = 15 * 60_000,
  T0 = Date.UTC(2026, 8, 1);
const swing: Array<[number, number, number]> = [
  [100, 100.3, 1000],
  [100.3, 99.9, 1000],
  [99.9, 100.4, 1000],
  [100.4, 99.8, 1000],
  [99.8, 100.5, 1000],
  [100.5, 99.7, 1000],
];
/** hours [open, close, oiClose]; each hour = 4 identical-ish 15m candles unless given */
function build(
  hs: Array<[number, number, number]>,
  quarters: Record<number, Array<[number, number, number, number]>> = {},
): { h: MvHour[]; q: Q15[] } {
  const h: MvHour[] = hs.map(([o, c, oi], i) => ({
    t: T0 + i * H,
    open: o,
    close: c,
    high: Math.max(o, c) + 0.1,
    low: Math.min(o, c) - 0.1,
    oi,
    oiOpen: i ? hs[i - 1][2] : oi,
  }));
  const q: Q15[] = [];
  h.forEach((k, i) => {
    const qs =
      quarters[i] ??
      [0, 1, 2, 3].map((j): [number, number, number, number] => {
        const a = k.open + ((k.close - k.open) * j) / 4,
          b = k.open + ((k.close - k.open) * (j + 1)) / 4;
        return [
          a,
          b,
          k.oiOpen + ((k.oi - k.oiOpen) * j) / 4,
          k.oiOpen + ((k.oi - k.oiOpen) * (j + 1)) / 4,
        ];
      });
    qs.forEach(([o, c, oo, oc], j) =>
      q.push({
        t: k.t + j * M15,
        open: o,
        close: c,
        high: Math.max(o, c) + 0.05,
        low: Math.min(o, c) - 0.05,
        oiOpen: oo,
        oiClose: oc,
      }),
    );
  });
  return { h, q };
}
const path = (q: readonly Q15[]): Minute[] =>
  q.map((x) => ({ t: x.t, high: x.high, low: x.low, close: x.close }));

// a fall with OI up over the closed hours 11..14; hour 15 is watched 15m by 15m
const fall: Array<[number, number, number]> = [
  ...swing,
  ...swing,
  [100, 99, 1010],
  [99, 98, 1020],
  [98, 97, 1040],
  [97, 97.5, 1030],
  [97.5, 99.5, 1020],
  ...Array.from({ length: 8 }, (): [number, number, number] => [
    99.5, 99.5, 1020,
  ]),
];

scenario(
  "LIVE: in the hour after the closed move, the first 15m with OI down + a strong GREEN candle -> LONG; SL = lowest low so far",
  () => {
    const { h, q } = build(fall, {
      15: [
        [97, 96.8, 1040, 1045],
        [96.8, 96.6, 1045, 1041],
        [96.6, 97.2, 1041, 1035],
        [97.2, 97.5, 1035, 1030],
      ],
    });
    const s = liveReversals(h, q, path(q));
    assert.strictEqual(s.length, 1);
    const x = s[0];
    assert.deepStrictEqual(
      [x.dir, x.side, x.signal.t, x.entry],
      ["DOWN", "LONG", T0 + 15 * H + 2 * M15, 97.2],
    ); // 1st: OI up, 2nd: red
    assert.ok(
      Math.abs(
        x.sl -
          Math.min(
            ...q
              .filter((y) => y.t >= x.moveStart && y.t <= x.signal.t)
              .map((y) => y.low),
          ),
      ) < 1e-9,
    );
    assert.strictEqual(x.result, "TP");
  },
);

scenario(
  "LIVE: a green 15m that is WEAK (body not bigger than the move's average) is not a signal",
  () => {
    const { h, q } = build(fall, {
      15: [
        [97, 96.8, 1040, 1041],
        [96.8, 96.85, 1041, 1038],
        [96.85, 96.7, 1038, 1036],
        [96.7, 96.72, 1036, 1035],
      ],
      16: [
        [96.72, 96.7, 1035, 1036],
        [96.7, 96.69, 1036, 1037],
        [96.69, 96.7, 1037, 1037],
        [96.7, 96.7, 1037, 1037],
      ],
    });
    assert.strictEqual(liveReversals(h, q, path(q)).length, 0);
  },
);

scenario(
  "LIVE: nothing is used from the future -- cutting the data right after the signal gives the same signal",
  () => {
    const { h, q } = build(fall, {
      15: [
        [97, 96.8, 1040, 1045],
        [96.8, 96.6, 1045, 1041],
        [96.6, 97.2, 1041, 1035],
        [97.2, 97.5, 1035, 1030],
      ],
    });
    const cut = T0 + 15 * H + 3 * M15;
    const a = liveReversals(h, q, path(q))[0],
      b = liveReversals(
        h.filter((k) => k.t + H <= cut),
        q.filter((y) => y.t < cut),
        path(q),
      )[0];
    assert.deepStrictEqual(
      [b.signal.t, b.entry, b.sl, b.side],
      [a.signal.t, a.entry, a.sl, a.side],
    );
  },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
