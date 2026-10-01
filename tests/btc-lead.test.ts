/**
 * BTC leads -> coin. Usage: npx tsx tests/btc-lead.test.ts
 */
import * as assert from "assert";
import type { MvHour } from "../src/research/oi-moves";
import {
  afterOf,
  leadSignals,
  pickCoin,
  type Q15,
} from "../src/research/btc-lead";

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
  Q = 15 * 60_000,
  T0 = Date.UTC(2026, 8, 30, 0);
const hr = (
  k: number,
  open: number,
  close: number,
  oiOpen: number,
  oi: number,
): MvHour => ({
  t: T0 + k * H,
  open,
  close,
  high: Math.max(open, close),
  low: Math.min(open, close),
  oiOpen,
  oi,
});
const q = (t: number, from: number, to: number, close = 102): Q15 => ({
  t,
  open: close,
  high: close,
  low: close,
  close,
  oiFrom: from,
  oiTo: to,
});
const quarters = (k: number, oi0: number, steps: number[]): Q15[] => {
  let o = oi0;
  return steps.map((d, i) => q(T0 + k * H + i * Q, o, (o += d)));
};

scenario(
  "start (price up + OI up), next hour goes on, then a 15m OI fall bigger than the biggest 15m rise -> SHORT",
  () => {
    const h = [
      hr(0, 100, 101, 1000, 1040),
      hr(1, 101, 102, 1040, 1060),
      hr(2, 102, 101.5, 1060, 1030),
    ];
    const qs = [
      ...quarters(0, 1000, [10, 15, 5, 10]),
      ...quarters(1, 1040, [5, -8, 13, 10]),
      ...quarters(2, 1060, [4, -10, -16, -8]),
    ];
    const s = leadSignals(h, qs);
    assert.strictEqual(s.length, 1);
    // biggest rise 15; in hour 2: -10 (not > 15), -16 (> 15) -> signal at the 3rd quarter's close
    assert.deepStrictEqual(
      [s[0].side, s[0].ts, s[0].fall, s[0].maxRise, s[0].moveStart],
      ["SHORT", T0 + 2 * H + 3 * Q, 16, 15, T0],
    );
    assert.strictEqual(
      s[0].big,
      false,
      "no hours before the episode -> cannot call it big",
    );
  },
);
scenario(
  "big = the OI built is more than any single-hour OI rise of the 24 hours before the episode",
  () => {
    const before = Array.from({ length: 24 }, (_, i) =>
      hr(i - 24, 100, 100, 1000, 1000 + (i === 5 ? 30 : 2)),
    );
    const h = [
      ...before,
      hr(0, 100, 101, 1000, 1040),
      hr(1, 101, 102, 1040, 1060),
      hr(2, 102, 101.5, 1060, 1030),
    ];
    const qs = [
      ...quarters(0, 1000, [10, 15, 5, 10]),
      ...quarters(1, 1040, [5, -8, 13, 10]),
      ...quarters(2, 1060, [4, -10, -16, -8]),
    ];
    const s = leadSignals(h, qs).filter((x) => x.moveStart === T0);
    assert.deepStrictEqual(
      [s.length, s[0].prevMaxHourRise, s[0].big],
      [1, 30, true],
    ); // built 54 > 30
  },
);
scenario(
  "falls never bigger than the biggest rise and the hour turns -> no signal, episode over",
  () => {
    const h = [
      hr(0, 100, 101, 1000, 1040),
      hr(1, 101, 100.5, 1040, 1030),
      hr(2, 100.5, 100, 1030, 1030),
    ];
    const qs = [
      ...quarters(0, 1000, [10, 15, 5, 10]),
      ...quarters(1, 1040, [-5, -5, 2, -2]),
    ];
    assert.strictEqual(leadSignals(h, qs).length, 0);
  },
);
scenario("price DOWN + OI up -> LONG on the big fall", () => {
  const h = [hr(0, 100, 99, 1000, 1030), hr(1, 99, 99.5, 1030, 1000)];
  const qs = [
    ...quarters(0, 1000, [10, 10, 5, 5]),
    ...quarters(1, 1030, [-12, -5, -8, -5]),
  ];
  const s = leadSignals(h, qs);
  assert.deepStrictEqual(
    [s.length, s[0].side, s[0].ts],
    [1, "LONG", T0 + H + Q],
  );
});
scenario(
  "after: best / worst / close in the trade's direction per window, from the bar closing at the signal",
  () => {
    const M5 = 5 * 60_000,
      b = [
        { t: 0, high: 10, low: 10, close: 10 },
        { t: M5, high: 10.1, low: 9.5, close: 9.6 },
        { t: 2 * M5, high: 9.7, low: 9.4, close: 9.5 },
      ];
    const a = afterOf(b, M5, "SHORT", [1])!;
    assert.strictEqual(a.entry, 10);
    assert.ok(
      Math.abs(a.after[0].best - 6) < 1e-9 &&
        Math.abs(a.after[0].worst - -1) < 1e-9 &&
        a.after[0].close === null,
    );
  },
);
scenario(
  "pick amp: the biggest x BTC among the coins that follow BTC (R2 upper half); r2: best follower",
  () => {
    const rank = [
      { symbol: "ETH", r2: 0.9, beta: 1.0 },
      { symbol: "DOGE", r2: 0.7, beta: 2.0 },
      { symbol: "WLD", r2: 0.2, beta: 3.0 },
      { symbol: "BNB", r2: 0.6, beta: 0.8 },
    ];
    assert.strictEqual(pickCoin(rank, "amp")!.symbol, "DOGE"); // WLD moves most but does not follow BTC
    assert.strictEqual(pickCoin(rank, "r2")!.symbol, "ETH");
  },
);
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
