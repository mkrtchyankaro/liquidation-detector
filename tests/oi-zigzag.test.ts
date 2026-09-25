/**
 * OI zigzag: waves cut only by moves > R, noise ignored, cleaning labelled,
 * cleaning -> accumulation -> resolution numbers in coins.
 * Usage: npx tsx tests/oi-zigzag.test.ts
 */
import * as assert from "assert";
import { buildChains, buildWaves, oiPivots, type ZBar } from "../src/research/oi-zigzag";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const M = 60_000, T0 = Date.UTC(2026, 8, 23, 14, 0);
// OI (coins): 100,000 flat -> down to 98,000 by minute 20 (cleaning, with a
// small +0.1% wiggle at 10) -> up to 99,500 by 60 -> down to 98,200 by 90.
// Price: 2700 -> 2650 in the cleaning, 2650-2680 zone, then down to 2630.
function oiAt(m: number): number {
  if (m <= 5) return 100_000;
  if (m <= 20) return 100_000 - (2000 * (m - 5)) / 15 + (m === 10 ? 150 : 0);
  if (m <= 60) return 98_000 + (1500 * (m - 20)) / 40;
  if (m <= 90) return 99_500 - (1300 * (m - 60)) / 30;
  return 98_200 + (m - 90) * 5;
}
function priceAt(m: number): number {
  if (m <= 5) return 2700;
  if (m <= 20) return 2700 - (50 * (m - 5)) / 15;
  if (m <= 60) return 2650 + (30 * (m - 20)) / 40;
  if (m <= 90) return 2680 - (50 * (m - 60)) / 30;
  return 2630;
}
const bars: ZBar[] = Array.from({ length: 100 }, (_, m) => ({
  ts: T0 + m * M, close: priceAt(m), high: priceAt(m), low: priceAt(m), oi: oiAt(m),
  longLiq: m >= 6 && m <= 18 && m % 3 === 0 ? 1_000_000 : 0, shortLiq: 0,
}));
const R = 0.4; // %

scenario("pivots at the real turns only; the +0.15% wiggle (< R) is noise", () => {
  const { pivots, lastExtreme } = oiPivots(bars, R);
  assert.deepStrictEqual(pivots.map((p) => [(p.ts - T0) / M, p.kind]), [[0, "HIGH"], [20, "LOW"], [60, "HIGH"]]);
  // minute 90 is the lowest so far but OI has not risen R yet -> not a confirmed pivot
  assert.strictEqual(((lastExtreme!.ts - T0) / M), 90);
});

scenario("a pivot is only KNOWN later: confirmed when OI moved back by R", () => {
  const low = oiPivots(bars, R).pivots.find((p) => p.kind === "LOW")!;
  const conf = (low.confirmedTs - T0) / M;
  assert.ok(conf > 20 && oiAt(conf) >= 98_000 * 1.004 && oiAt(conf - 1) < 98_000 * 1.004, `confirmed at minute ${conf}`);
});

scenario("waves alternate and are labelled: LONG cleaning, OI up, then down (still running)", () => {
  const w = buildWaves(bars, R);
  assert.strictEqual(w[2].confirmed, false);
  assert.deepStrictEqual(w.map((x) => x.kind).slice(0, 3), ["LONG_CLEANING", "OI_UP", "OI_DOWN"]);
  assert.ok(Math.abs(w[0].coins - 2000) < 1e-6);
  assert.ok(Math.abs(w[1].coins - 1500) < 1e-6);
});

scenario("chain in coins: depth = move / closed coins; expected = depth x opened coins", () => {
  const [c] = buildChains(buildWaves(bars, R));
  assert.ok(Math.abs(c.cleaningMove - 50) < 1e-6);
  assert.ok(Math.abs(c.depthPer1k - 25) < 1e-6, "50 / 2 thousand coins = 25 per 1,000");
  assert.ok(Math.abs(c.expectedMove! - 37.5) < 1e-6, "25 x 1.5 thousand");
  assert.ok(Math.abs(c.actualDown! - 50) < 1e-6 && c.actualUp === 0, "real next wave: 2680 -> 2630");
});

scenario("OI falling WITHOUT liquidations is not a cleaning", () => {
  const quiet = bars.map((b) => ({ ...b, longLiq: 0 }));
  assert.strictEqual(buildWaves(quiet, R)[0].kind, "OI_DOWN");
});

scenario("bigger R -> fewer waves (the 1.3% resolution wave survives, nothing smaller)", () => {
  assert.ok(buildWaves(bars, 1.4).length < buildWaves(bars, R).length);
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
