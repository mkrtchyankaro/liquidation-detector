/**
 * Reversal after an OI accumulation (15m inside the OI-drop hour). Usage: npx tsx tests/oi-reversal.test.ts
 */
import * as assert from "assert";
import { findMoves, type MvHour } from "../src/research/oi-moves";
import { reversal, type Minute, type Q15 } from "../src/research/oi-reversal";

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

// a fall with OI up (12..15), then the OI-drop hour 16
const fall: Array<[number, number, number]> = [
  ...swing,
  ...swing,
  [100, 99, 1010],
  [99, 98, 1020],
  [98, 97, 1040],
  [97, 97.5, 1030],
  [97.5, 99.5, 1020],
  [99.5, 100, 1020],
];

scenario(
  "after a fall: the first 15m in the OI-drop hour with OI down and a GREEN close -> LONG, SL = lowest low, TP 2R",
  () => {
    const { h, q } = build(fall, {
      15: [
        [97, 96.8, 1040, 1045],
        [96.8, 96.6, 1045, 1041],
        [96.6, 97.2, 1041, 1035],
        [97.2, 97.5, 1035, 1030],
      ],
    });
    const m = findMoves(h)[0];
    assert.strictEqual(m.dir, "DOWN");
    const r = reversal(m, h, q, path(q));
    assert.ok(r.trade, r.note);
    const t = r.trade!;
    assert.strictEqual(t.side, "LONG");
    assert.strictEqual(t.signal.t, T0 + 15 * H + 2 * M15); // 1st quarter OI up (no), 2nd red (no), 3rd green + OI down (yes)
    assert.strictEqual(t.entry, 97.2);
    assert.ok(
      Math.abs(
        t.sl -
          Math.min(
            ...q
              .filter((x) => x.t >= T0 + 11 * H && x.t <= t.signal.t)
              .map((x) => x.low),
          ),
      ) < 1e-9,
    );
    assert.strictEqual(t.result, "TP");
  },
);

scenario(
  "no 15m that both lost OI and turned (the OI grows again the next hour) -> no trade",
  () => {
    const noMore: Array<[number, number, number]> = [
      ...fall.slice(0, 16),
      [97.5, 99.5, 1045],
      [99.5, 100, 1050],
    ];
    const { h, q } = build(noMore, {
      15: [
        [97, 96.8, 1040, 1045],
        [96.8, 96.6, 1045, 1041],
        [96.6, 96.5, 1041, 1035],
        [96.5, 97.5, 1035, 1036],
      ],
    });
    const r = reversal(findMoves(h)[0], h, q, path(q));
    assert.strictEqual(r.trade, null);
    assert.match(r.note, /no reversal/);
  },
);

scenario("OI still growing at the last hour -> waiting, no trade", () => {
  const { h, q } = build([
    ...swing,
    ...swing,
    [100, 99, 1010],
    [99, 98, 1020],
    [98, 97, 1040],
  ]);
  const r = reversal(findMoves(h)[0], h, q, path(q));
  assert.strictEqual(r.trade, null);
  assert.match(r.note, /still growing/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
