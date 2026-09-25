/**
 * Liquidation episodes (definition of Sep 25 2026) on synthetic minutes.
 * Usage: npx tsx tests/liq-episodes.test.ts
 */
import * as assert from "assert";
import { DEFAULT_EPISODE_PARAMS, findEpisodes, type Bar } from "../src/research/liq-episodes";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const M = 60_000, T0 = Date.UTC(2026, 8, 25, 0, 0);
/** minutes 0..n-1 from price/OI curves; liq = { minute: usd } */
function bars(n: number, price: (m: number) => number, oi: (m: number) => number, longLiq: Record<number, number> = {}, shortLiq: Record<number, number> = {}): Bar[] {
  return Array.from({ length: n }, (_, m) => ({ ts: T0 + m * M, close: price(m), high: price(m), low: price(m), oi: oi(m), longLiq: longLiq[m] ?? 0, shortLiq: shortLiq[m] ?? 0 }));
}
const P = { ...DEFAULT_EPISODE_PARAMS, noiseFloorPct: 0.05 };

// LONG flush: minutes 10..30 price 100 -> 97, OI 1000 -> 980 with a small uptick at 20;
// bottom at 30; then OI rises to 990 by 60 (accumulation), price 97-98.
const price = (m: number): number => (m < 10 ? 100 : m <= 30 ? 100 - (3 * (m - 10)) / 20 : 97 + Math.min(1, (m - 30) / 30));
const oi = (m: number): number => (m < 10 ? 1000 : m <= 30 ? 1000 - (m - 10) + (m >= 20 && m < 23 ? 2 : 0) : m <= 60 ? 980 + (m - 30) / 3 : 990 - (m - 60));
const liq = { 11: 20_000, 14: 30_000, 18: 10_000, 25: 40_000 };

scenario("LONG flush -> one episode: start, bottom, 3 numbers in USD", () => {
  const eps = findEpisodes(bars(120, price, oi, liq), P);
  assert.strictEqual(eps.length, 1);
  const e = eps[0];
  assert.strictEqual(e.victim, "LONG");
  assert.strictEqual(e.startTs, T0 + 11 * M);
  assert.strictEqual(e.bottomTs, T0 + 30 * M);
  assert.strictEqual(e.lastLiqTs, T0 + 25 * M);
  assert.strictEqual(e.liqUsd, 100_000);
  assert.ok(Math.abs(e.oiDropPct - 2) < 0.2, `OI drop ${e.oiDropPct}`);
  assert.ok(Math.abs(e.oiDropUsd - 20 * 97) < 50, `OI drop USD = contracts x price (${e.oiDropUsd})`);
  assert.ok(Math.abs(e.otherClosesUsd - (e.oiDropUsd - e.liqUsd)) < 1e-9);
  assert.strictEqual(e.endReason, "OI_REBOUND");
});

scenario("small OI uptick inside the flush (< 25% of the drop) is noise, not the end", () => {
  const e = findEpisodes(bars(120, price, oi, liq), P)[0];
  assert.ok(e.bottomTs > T0 + 23 * M, "the uptick at minute 20-22 did not end it");
});

scenario("accumulation after the bottom: OI rise measured to its peak, with the price zone", () => {
  const e = findEpisodes(bars(120, price, oi, liq), P)[0];
  assert.strictEqual(e.accumMin, 30);
  assert.ok(Math.abs(e.oiRisePct - (10 / 980) * 100) < 0.01);
  assert.ok(e.zoneLow >= 97 && e.zoneHigh <= 98.01);
});

scenario("SHORT squeeze is the mirror image", () => {
  const up = (m: number): number => 200 - price(m);
  const eps = findEpisodes(bars(120, up, oi, {}, liq), P);
  assert.strictEqual(eps.length, 1);
  assert.strictEqual(eps[0].victim, "SHORT");
  assert.ok(eps[0].movePct > 2.9);
});

scenario("liquidations while OI RISES (new positions, not a flush) -> no episode", () => {
  assert.strictEqual(findEpisodes(bars(120, price, (m) => 1000 + m, liq), P).length, 0);
});

scenario("tiny uptick below the coin's noise floor never ends an episode", () => {
  // drop of only 0.1 contracts then +0.05 uptick: 50% of the drop but << floor
  const o = (m: number): number => (m < 10 ? 1000 : m === 11 ? 999.9 : m === 12 ? 999.95 : m <= 30 ? 1000 - (m - 10) : 980 + (m - 30) / 3);
  const e = findEpisodes(bars(120, price, o, liq), P)[0];
  assert.strictEqual(e.bottomTs, T0 + 30 * M);
});

scenario("episode still running at the end of the data is not reported", () => {
  assert.strictEqual(findEpisodes(bars(28, price, oi, liq), P).length, 0);
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
