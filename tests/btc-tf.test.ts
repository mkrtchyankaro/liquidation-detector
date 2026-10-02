/**
 * Coin vs BTC per timeframe. Usage: npx tsx tests/btc-tf.test.ts
 */
import * as assert from "assert";
import { bestTf, resample, tfStat, type Close } from "../src/research/btc-tf";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const M = 60_000;
// BTC: a deterministic wiggle; prices from returns
const btcRet = Array.from({ length: 600 }, (_, i) => 0.001 * Math.sin(i * 1.7) + 0.0004 * Math.cos(i * 0.31));
const path = (r: number[]): Close[] => { let p = 100; return r.map((x, i) => { p *= 1 + x; return { t: i * M, close: p }; }); };
const btc = path(btcRet);

scenario("resample keeps the LAST close of each candle", () => {
  const m = resample([{ t: 0, close: 1 }, { t: M, close: 2 }, { t: 5 * M, close: 3 }], 5);
  assert.deepStrictEqual([...m.entries()], [[0, 2], [5 * M, 3]]);
});
scenario("a coin that moves exactly 1.5x BTC each minute: x BTC ~1.5, R2 ~1 on 1m", () => {
  const s = tfStat(path(btcRet.map((x) => 1.5 * x)), btc, 1);
  assert.ok(Math.abs(s.beta - 1.5) < 0.01, String(s.beta));
  assert.ok(s.r2 > 0.999);
});
scenario("a coin that follows BTC ONE candle later: low R2 same candle, high R2 with the lag", () => {
  const late = path([0, ...btcRet.slice(0, -1)]);
  const s = tfStat(late, btc, 1);
  assert.ok(s.lagR2 > 0.99 && s.r2 < s.lagR2, `${s.r2} ${s.lagR2}`);
});
scenario("best timeframe ignores timeframes with too few candles", () => {
  const coin = path(btcRet.map((x, i) => 1.2 * x + 0.002 * Math.sin(i * 2.9)));
  const stats = [1, 5, 60].map((tf) => tfStat(coin, btc, tf));
  const b = bestTf(stats, 30);
  assert.ok(b !== null && b.tf !== 60, String(b?.tf));            // 60m has only ~9 candles
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
