/**
 * V10 "atr" entry (Johnny Oct 3): close 1 ATR back from the top + OI down, the move built with OI up, RANK 1;
 * variants: frozen ATR (from the move's start), red candle. Usage: npx tsx tests/atr-turn.test.ts
 */
import * as assert from "assert";
import type { Candle } from "../src/research/dc15";
import { atrSignals } from "../src/research/atr-turn";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const W = 15 * 60_000;
/** candles from [close change, OI change, optional open change (a gap inside the candle -> its colour)] */
function mk(rows: Array<[number, number, number?]>): Candle[] {
  let p = 100, oi = 1000;
  return rows.map(([dc, d, og], i) => {
    const o = p + (og ?? 0), oi0 = oi; p += dc; oi += d;
    return { t: i * W, end: (i + 1) * W, open: o, high: Math.max(o, p) + 0.1, low: Math.min(o, p) - 0.1, close: p, oi0, oi1: oi, liqL: 0, liqS: 0 };
  });
}
const warm: Array<[number, number]> = [];
for (let c = 0; c < 5; c++) { for (let i = 0; i < 4; i++) warm.push([+0.4, +1]); for (let i = 0; i < 4; i++) warm.push([-0.4, -1]); }
const W0 = warm.length;
const after = (s: { t: number }[]): Array<{ t: number }> => s.filter((x) => x.t > W0 * W);
const rel = (t: number): number => t / W - W0;

// the rise with OI up, a small red wiggle inside it (OI down, less than 1 ATR) that must NOT be an entry
const wiggle: Array<[number, number]> = [
  ...warm,
  [+0.6, +8], [+0.6, +8],
  [-0.2, -2],                    // wiggle: red, OI down, but only 0.3 back from the high (< 1 ATR)
  [+0.6, +8], [+0.6, +8],
  [-0.7, -3],                    // closes 0.8 back from the high (>= 1 ATR) with OI down -> ENTRY
  [-0.4, -2], [-0.4, -2],
];

scenario("a red candle with OI down inside the rise (less than 1 ATR back) is not an entry; the close 1 ATR back with OI down is -- SHORT", () => {
  const s = after(atrSignals(mk(wiggle), 1, 14, 12));
  assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
  const x = atrSignals(mk(wiggle), 1, 14, 12).find((y) => y.t > W0 * W)!;
  assert.strictEqual(x.side, "SHORT");
  assert.strictEqual(rel(x.t), 6, "the entry is the close of the 1 ATR candle");
  assert.ok(x.buildOiPct > 0 && x.candleOiPct < 0 && x.prior > 0);
  assert.ok(x.backPct > 0 && x.atr > 0);
});

scenario("a rise built with OI DOWN (shorts closing) is never an entry -- not even when the turn candle's OI goes up", () => {
  const rows: Array<[number, number]> = [...warm, [+0.6, -8], [+0.6, -8], [+0.6, -8], [+0.6, -8], [-0.7, +3], [-0.4, +2], [-0.4, -2]];
  assert.strictEqual(after(atrSignals(mk(rows), 1, 14, 12)).length, 0);
});

scenario("not RANK 1 (a smaller OI build than the earlier moves) -> no entry", () => {
  const rows: Array<[number, number]> = [...warm, [+0.6, +8], [+0.6, +8], [+0.6, +8], [+0.6, +8], [-0.7, -3], [-0.7, -3], [-0.7, -3], [-0.4, -2], [-0.4, -2],
    [+0.6, +1], [+0.6, +1], [+0.6, +1], [-0.7, -1], [-0.4, -1]];
  const s = after(atrSignals(mk(rows), 1, 14, 12));
  assert.ok(s.every((x) => rel(x.t) < 9), JSON.stringify(s.map((x) => rel(x.t))));
});

// a fast rise: the live ATR grows, the frozen ATR stays at its size before the move
const fast: Array<[number, number]> = [...warm, [+2, +8], [+2, +8], [+2, +8], [+2, +8], [+2, +8], [+2, +8], [-0.75, -3], [-0.6, -3], [-0.6, -3], [-0.4, -2]];

scenario("frozen ATR (from the move's start) enters earlier than the live ATR after a fast rise", () => {
  const live = after(atrSignals(mk(fast), 1, 14, 12, { atr: "live" }));
  const frozen = after(atrSignals(mk(fast), 1, 14, 12, { atr: "frozen" }));
  assert.strictEqual(frozen.length, 1); assert.strictEqual(live.length, 1);
  assert.ok(frozen[0].t < live[0].t, `frozen ${rel(frozen[0].t)} live ${rel(live[0].t)}`);
  assert.strictEqual(rel(frozen[0].t), 7);
});

scenario("red: a GREEN candle that closes 1 ATR below the high (a big drop, then up inside the candle) is an entry only without --red", () => {
  // [close change, OI, open gap]: the candle opens 1.3 lower and closes 0.3 up from its open -> green, 1.0 below the high
  const rows: Array<[number, number, number?]> = [...warm, [+0.6, +8], [+0.6, +8], [+0.6, +8], [+0.6, +8], [-1.0, -3, -1.3], [-0.6, -3], [-0.4, -2], [-0.4, -2]];
  const plain = after(atrSignals(mk(rows), 1, 14, 12));
  const red = after(atrSignals(mk(rows), 1, 14, 12, { red: true }));
  assert.strictEqual(plain.length, 1); assert.strictEqual(rel(plain[0].t), 5);
  assert.strictEqual(red.length, 1); assert.strictEqual(rel(red[0].t), 6, "with red: the next (red) candle");
});

scenario("the mirror: a fall built with OI up, then a close 1 ATR up with OI down -> LONG", () => {
  const rows: Array<[number, number]> = [...warm, [-0.6, +8], [-0.6, +8], [-0.6, +8], [-0.6, +8], [+0.7, -3], [+0.4, -2], [+0.4, -2]];
  const s = atrSignals(mk(rows), 1, 14, 12).filter((x) => x.t > W0 * W);
  assert.strictEqual(s.length, 1); assert.strictEqual(s[0].side, "LONG");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
