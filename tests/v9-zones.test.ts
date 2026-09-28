/**
 * v9-zones helpers: candles, swing points, zone distance.
 * Usage: npx tsx tests/v9-zones.test.ts
 */
import * as assert from "assert";
import { candlesOf, turningPoints, withBounce, zoneOf } from "../src/tools/v9-zones";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const H = 3_600_000, M = 60_000;
// one minute bar per 30 minutes, hourly lows follow `lows`
const minutesFromHourLows = (lows: number[]) => lows.flatMap((l, h) => [0, 30].map((m) => ({ ts: h * H + m * M, low: l + (m ? 0.02 : 0), high: l + 0.3 })));

scenario("candles: only finished ones, 4h aligned", () => {
  const bars = minutesFromHourLows([10, 11, 12, 13, 14, 15, 16, 17, 18]);
  const c1 = candlesOf(bars, H, 0, 5 * H + 10 * M);
  assert.strictEqual(c1.length, 5); // hour 5 is not finished
  const c4 = candlesOf(bars, 4 * H, 0, 9 * H);
  assert.strictEqual(c4.length, 2);
  assert.strictEqual(c4[1].low, 14);
});

scenario("turning points: two old lows at ~10.04 form a zone (AVAX-like)", () => {
  const lows = [10.8, 10.5, 10.04, 10.4, 10.7, 10.9, 10.6, 10.05, 10.3, 10.8, 11.0];
  const c1 = candlesOf(minutesFromHourLows(lows), H, 0, lows.length * H);
  const pts = turningPoints(c1, "LOW", 2);
  assert.deepStrictEqual(pts.map((p) => p.price), [10.04, 10.05]);
  const z = zoneOf(pts, 10.07, true, 0.5);
  assert.strictEqual(z.touches, 2);
  assert.ok(z.dist > 0, "held above the zone");
  const far = zoneOf(pts, 10.55, true, 0.5); // the Sep 28 AVAX case: far above the zone
  assert.strictEqual(far.touches, 0);
  assert.ok(far.dist > 4);
});

scenario("zone: went through the level = negative distance; SELL is mirrored", () => {
  const pts = [{ ts: 0, price: 100 }];
  assert.ok(zoneOf(pts, 99.8, true, 0.5).dist < 0);
  assert.ok(zoneOf(pts, 99.8, false, 0.5).dist > 0); // SELL: stopped below the old high
  assert.strictEqual(zoneOf([], 100, true, 0.5).touches, 0);
});

scenario("bounce: a strong swing keeps its bounce until the level breaks", () => {
  const c = [{ ts: 0, low: 10, high: 10.2 }, { ts: 1, low: 10.5, high: 11.2 }, { ts: 2, low: 9.9, high: 12 }];
  const [p] = withBounce(c, [{ ts: 0, price: 10 }], "LOW");
  assert.ok(Math.abs(p.bouncePct - 12) < 1e-9, String(p.bouncePct)); // 11.2, then the low broke (12 not counted)
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
