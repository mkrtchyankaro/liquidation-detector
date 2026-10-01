/**
 * V9 BTC blame numbers. Usage: npx tsx tests/v9-btc-blame.test.ts
 */
import * as assert from "assert";
import { bestPointTs, blameOf } from "../src/research/v9-btc-blame";

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
const series = (vals: number[]) =>
  vals.map((close, i) => ({ t: i * M, close }));

scenario(
  "a coin that only follows BTC twice as hard: R2 = 1, x = 2; signs are in the trade's direction",
  () => {
    const btc = series([100, 99, 99.5, 98]),
      coin = series([10, 9.8, 9.9, 9.6]);
    const l = blameOf("LONG", coin, btc, 0, 3 * M)!;
    assert.ok(Math.abs(l.r2! - 1) < 0.01, `r2 ${l.r2}`);
    assert.ok(
      Math.abs(l.coinPct - -4) < 1e-9 && Math.abs(l.btcPct - -2) < 1e-9,
    );
    assert.ok(Math.abs(l.ratio! - 2) < 1e-9);
    const s = blameOf("SHORT", coin, btc, 0, 3 * M)!;
    assert.ok(
      s.coinPct > 0 && s.btcPct > 0,
      "for a SHORT the same fall is FOR the trade",
    );
  },
);
scenario("a coin moving on its own while BTC is flat-ish: R2 near 0", () => {
  const btc = series([100, 100.01, 100, 100.01, 100]),
    coin = series([10, 9.9, 10.1, 10.2, 9.8]);
  assert.ok(blameOf("LONG", coin, btc, 0, 4 * M)!.r2! < 0.3);
});
scenario(
  "too little data -> null; only the minutes inside the trade count",
  () => {
    assert.strictEqual(blameOf("LONG", series([1]), series([1]), 0, M), null);
    const b = blameOf(
      "LONG",
      series([10, 11, 12, 13]),
      series([100, 100, 100, 100]),
      M,
      2 * M,
    )!;
    assert.strictEqual(b.minutes, 2);
    assert.strictEqual(b.ratio, null);
  },
);
scenario(
  "best point: highest close for a LONG, lowest for a SHORT, inside the trade only",
  () => {
    const c = series([10, 12, 11, 9, 13]);
    assert.strictEqual(bestPointTs("LONG", c, 0, 3 * M), M);
    assert.strictEqual(bestPointTs("SHORT", c, 0, 3 * M), 3 * M);
  },
);
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
