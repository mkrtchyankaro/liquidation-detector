/**
 * Johnny's V10 rule (OI up -> OI peak -> first red candle with OI down). Usage: npx tsx tests/oi-peak.test.ts
 */
import * as assert from "assert";
import type { Candle } from "../src/research/dc15";
import { oiPeakSignals } from "../src/research/oi-peak";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const W = 15 * 60_000;
/** candles from [close change, OI change]; the open is the previous close */
function mk(rows: Array<[number, number]>): Candle[] {
  let p = 100, oi = 1000;
  return rows.map(([dc, d], i) => {
    const o = p, oi0 = oi; p += dc; oi += d;
    return { t: i * W, end: (i + 1) * W, open: o, high: Math.max(o, p) + 0.1, low: Math.min(o, p) - 0.1, close: p, oi0, oi1: oi, liqL: 0, liqS: 0 };
  });
}
// warm-up: small zigzags with small OI (accepted moves to compare with), then the story
const warm: Array<[number, number]> = [];
for (let c = 0; c < 5; c++) { for (let i = 0; i < 4; i++) warm.push([+0.4, +1]); for (let i = 0; i < 4; i++) warm.push([-0.4, -1]); }
const W0 = warm.length;
const story: Array<[number, number]> = [
  ...warm,
  [-0.3, -3], [-0.3, -3],                          // OI falls first (the move's start is not OI's low)
  [+0.6, +8], [+0.6, +8], [+0.6, +8], [+0.6, +8],  // 1: price up + OI up
  [+0.2, -2],                                      // 2: OI falls at the top, the candle still GREEN -> no entry
  [-0.5, -3],                                      // 3: the first RED candle with OI down -> ENTRY
  [-0.4, -2], [-0.4, -2],
];

scenario("the 3 points: OI up from its low to the peak, OI falling at the top (green candle = no entry), the first red candle with OI down = SHORT at its close", () => {
  const s = oiPeakSignals(mk(story), 1, 14, 12).filter((x) => x.t > W0 * W);
  assert.strictEqual(s.length, 1, JSON.stringify(s));
  const x = s[0];
  assert.strictEqual(x.side, "SHORT");
  assert.strictEqual(x.t, (W0 + 8) * W, `entry at the close of the first red candle (${(x.t / W) - W0})`);
  assert.strictEqual(x.startT, (W0 + 2) * W, "1 starts at OI's LOW (the close of the last OI-down candle), not at the move's start");
  assert.strictEqual(x.peakT, (W0 + 6) * W);
  assert.ok(Math.abs(x.buildOiPct - (100 * 32) / 994) < 1e-9, `build ${x.buildOiPct}`);
  assert.ok(x.fromPeakOiPct < 0 && x.candleOiPct < 0 && x.label === "LONGS OUT");
});
scenario("a red candle whose OI goes UP is not the entry; the next red one with OI down is", () => {
  const st = story.slice(); st[W0 + 7] = [-0.5, +1];
  const s = oiPeakSignals(mk(st), 1, 14, 12).filter((x) => x.t > W0 * W);
  assert.strictEqual(s[0]?.t, (W0 + 9) * W, JSON.stringify(s));
});
scenario("no entry when the rise was NOT built with OI up (OI fell all the way up)", () => {
  const st = story.map(([dc, d], i): [number, number] => (i >= W0 + 2 && i < W0 + 6 ? [dc, -2] : [dc, d]));
  assert.strictEqual(oiPeakSignals(mk(st), 1, 14, 12).filter((x) => x.t > W0 * W && x.side === "SHORT").length, 0);
});
scenario("RANK 1: a build-up not bigger than the earlier moves of the window gives no signal", () => {
  const st = story.map(([dc, d], i): [number, number] => (i >= W0 + 2 && i < W0 + 6 ? [dc, +0.2] : [dc, d]));
  assert.strictEqual(oiPeakSignals(mk(st), 1, 14, 12).filter((x) => x.t > W0 * W && x.side === "SHORT").length, 0);
});
scenario("one signal per move; no look-ahead (cut data gives the same signals up to the cut)", () => {
  const full = oiPeakSignals(mk(story), 1, 14, 12);
  const cut = oiPeakSignals(mk(story).slice(0, W0 + 8), 1, 14, 12);
  assert.deepStrictEqual(cut, full.filter((x) => x.t <= (W0 + 8) * W));
  assert.strictEqual(full.filter((x) => x.t > W0 * W && x.side === "SHORT").length, 1);
});
scenario("LONG mirror: a fall built with OI up, then the first GREEN candle with OI down", () => {
  const st = story.map(([dc, d]): [number, number] => [-dc, d]);
  const s = oiPeakSignals(mk(st), 1, 14, 12).filter((x) => x.t > W0 * W);
  assert.strictEqual(s[0]?.side, "LONG");
  assert.strictEqual(s[0].t, (W0 + 8) * W);
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
