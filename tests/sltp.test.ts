/**
 * SL / TP simulation. Usage: npx tsx tests/sltp.test.ts
 */
import * as assert from "assert";
import { armedTurn, extremeIn, simTrade, stopFor } from "../src/research/sltp";
import type { MinBar } from "../src/research/dc15";

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
const bar = (i: number, high: number, low: number, close: number): MinBar => ({
  t: i * M,
  high,
  low,
  close,
  oiFirst: 1,
  oiLast: 1,
});

scenario("SHORT: TP at 2R when the low reaches it", () => {
  const bars = [
    bar(0, 101, 99, 100),
    bar(1, 100.5, 98, 98.5),
    bar(2, 99, 97.9, 98),
  ];
  const tr = simTrade(bars, M, 100, 101, 2, "DOWN"); // risk 1 -> TP 98
  assert.deepStrictEqual([tr.exit, tr.r, tr.exitT], ["TP", 2, 2 * M]);
});
scenario(
  "SHORT: SL when the high reaches it; the signal minute itself is not used",
  () => {
    const bars = [bar(0, 105, 90, 100), bar(1, 101.2, 99.5, 101)];
    const tr = simTrade(bars, M, 100, 101, 2, "DOWN");
    assert.deepStrictEqual([tr.exit, tr.r], ["SL", -1]);
  },
);
scenario("both in the same minute -> SL (careful side)", () => {
  const tr = simTrade([bar(1, 102, 97, 99)], M, 100, 101, 2, "DOWN");
  assert.strictEqual(tr.exit, "SL");
});
scenario("no exit -> OPEN at the last close, in R", () => {
  const tr = simTrade([bar(1, 100.5, 99.2, 99.5)], M, 100, 101, 2.5, "DOWN");
  assert.strictEqual(tr.exit, "OPEN");
  assert.ok(Math.abs(tr.r - 0.5) < 1e-9);
});
scenario("LONG mirrors SHORT", () => {
  const tr = simTrade([bar(1, 102.2, 99.5, 102)], M, 100, 99, 2.2, "UP"); // TP 102.2
  assert.deepStrictEqual([tr.exit, tr.r], ["TP", 2.2]);
});
scenario("extremeIn: highest high before `to` only", () => {
  const bars = [
    bar(0, 101, 99, 100),
    bar(1, 103, 99, 100),
    bar(2, 109, 99, 100),
  ];
  assert.strictEqual(extremeIn(bars, 0, 2 * M, "DOWN"), 103);
  assert.strictEqual(extremeIn(bars, 0, 3 * M, "UP"), 99);
});
scenario("stopFor: the move's high, but never closer than 1 ATR", () => {
  assert.strictEqual(stopFor(100, 100.1, 0.5, "DOWN"), 100.5); // high too close -> 1 ATR
  assert.strictEqual(stopFor(100, 102, 0.5, "DOWN"), 102); // high far enough -> the high
  assert.strictEqual(stopFor(100, 99.9, 0.5, "UP"), 99.5);
});
scenario(
  "armedTurn: the alt's first accepted turn the same way, from BTC's signal to BTC's next turn",
  () => {
    const T = (t: number, newDir: "UP" | "DOWN", accepted = true) => ({
      t,
      newDir,
      accepted,
    });
    const alt = [
      T(5, "DOWN"),
      T(10, "UP"),
      T(12, "DOWN", false),
      T(14, "DOWN"),
      T(30, "DOWN"),
    ];
    assert.strictEqual(armedTurn(alt, "DOWN", 10, 20)?.t, 14); // before 10 is too early, the rejected 12 does not count
    assert.strictEqual(armedTurn(alt, "DOWN", 15, 20), undefined); // nothing before BTC's next turn
    assert.strictEqual(armedTurn(alt, "DOWN", 14, 20)?.t, 14); // at the same candle close counts
  },
);
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
