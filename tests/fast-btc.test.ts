/**
 * FAST BTC 15m -> coin. Usage: npx tsx tests/fast-btc.test.ts
 */
import * as assert from "assert";
import {
  candles15,
  fastTrades,
  sideOf,
  type FBar,
} from "../src/research/fast-btc";

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
  T0 = Date.UTC(2026, 8, 30, 12, 0);
const bar = (
  i: number,
  close: number,
  oi: number,
  longLiq = 0,
  shortLiq = 0,
  hi = close,
  lo = close,
): FBar => ({
  t: T0 + i * M,
  open: close,
  high: hi,
  low: lo,
  close,
  oiFirst: oi,
  oiLast: oi,
  longLiq,
  shortLiq,
});
const o = {
  tpR: 2.5,
  minSlPct: 0,
  maxOpen: null,
  timeStopH: null,
  riskUsd: 10,
};

scenario(
  "BTC 15m: price down + OI down + long liquidations > short -> SHORT; up + OI down + shorts -> LONG; OI up -> nothing",
  () => {
    const down = candles15(
      Array.from({ length: 15 }, (_, i) =>
        bar(i, 100 - i * 0.1, 1000 - i, i === 5 ? 5e5 : 0),
      ),
    )[0];
    assert.strictEqual(sideOf(down), "SHORT");
    const up = candles15(
      Array.from({ length: 15 }, (_, i) =>
        bar(i, 100 + i * 0.1, 1000 - i, 0, i === 5 ? 5e5 : 0),
      ),
    )[0];
    assert.strictEqual(sideOf(up), "LONG");
    const oiUp = candles15(
      Array.from({ length: 15 }, (_, i) =>
        bar(i, 100 - i * 0.1, 1000 + i, 5e5),
      ),
    )[0];
    assert.strictEqual(sideOf(oiUp), null);
    assert.strictEqual(
      sideOf(candles15([bar(0, 100, 1000, 5e5), bar(1, 99, 999)])[0]),
      null,
      "a partial candle never signals",
    );
  },
);
scenario(
  "coin trade: entry at the coin's 15m close, SL at its 15m high, TP 2.5R, decided on the minutes AFTER",
  () => {
    const btc = candles15(
      Array.from({ length: 15 }, (_, i) =>
        bar(i, 100 - i * 0.1, 1000 - i, 5e5),
      ),
    );
    const coin = [
      ...Array.from({ length: 15 }, (_, i) =>
        bar(i, 10 - i * 0.01, 1, 0, 0, i === 3 ? 10.1 : 10 - i * 0.01),
      ),
      bar(15, 9.6, 1),
      bar(16, 9.2, 1, 0, 0, 9.3, 9.2),
    ];
    const { trades } = fastTrades(btc, coin, o);
    assert.strictEqual(trades.length, 1);
    const t = trades[0];
    assert.deepStrictEqual(
      [t.side, t.trade.entry, t.trade.sl],
      ["SHORT", 9.86, 10.1],
    );
    assert.strictEqual(t.res.status, "TP"); // risk 0.24 -> TP 9.26, reached in minute 16
  },
);
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
