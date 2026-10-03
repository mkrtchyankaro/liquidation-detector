/**
 * V10 "atr" entry (Johnny Oct 3): close 1 ATR back from the top + OI down, the move built with OI up, RANK 1;
 * variant: frozen ATR (from the move's start). Usage: npx tsx tests/atr-turn.test.ts
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
const after = <T extends { t: number }>(s: T[]): T[] => s.filter((x) => x.t > W0 * W);
const rel = (t: number): number => t / W - W0;

// the rise with OI up, a small red wiggle inside it (OI down, less than 1 ATR) that must NOT be an entry
const wiggle: Array<[number, number]> = [
  ...warm,
  [+0.6, +8], [+0.6, +8],
  [-0.2, -2],                    // wiggle: red, OI down, but only 0.3 back from the high (< 1 ATR)
  [+0.6, +8], [+0.6, +8],
  [-0.7, -3],                    // closes 0.8 back from the high (>= 1 ATR), OI below its peak -> ENTRY
  [-0.4, -2], [-0.4, -2],
];

scenario("a red candle with OI down inside the rise (less than 1 ATR back) is not an entry; the close 1 ATR back is -- SHORT", () => {
  const s = atrSignals(mk(wiggle), 1, 14, 12).filter((y) => y.t > W0 * W);
  assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
  const x = s[0];
  assert.strictEqual(x.side, "SHORT");
  assert.strictEqual(rel(x.t), 6, "the entry is the close of the 1 ATR candle");
  assert.ok(x.buildOiPct > 0 && x.fromPeakOiPct < 0 && x.prior > 0);
  assert.ok(x.backPct > 0 && x.atr > 0);
});

scenario("the candle that MAKES the top and closes 1 ATR below it is not the entry -- the next candle is", () => {
  // [close change, OI, open gap]: candle 4 opens 1.0 higher (a new high), closes 0.6 below the previous close
  const rows: Array<[number, number, number?]> = [...warm, [+0.6, +8], [+0.6, +8], [+0.6, +8], [+0.6, +8], [-0.6, -3, +1.0], [-0.2, -1], [-0.4, -2], [-0.4, -2]];
  const s = after(atrSignals(mk(rows), 1, 14, 12));
  assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
  assert.strictEqual(rel(s[0].t), 6, "wait for the candle after the one that made the top");
});

scenario("OI fell BEFORE the top (take-profits on the way up) and the entry candle's own OI goes up -> still the entry (OI is below its peak)", () => {
  const rows: Array<[number, number]> = [...warm, [+0.6, +8], [+0.6, +8], [+0.6, -2], [+0.6, -2], [-0.8, +1], [-0.4, -2], [-0.4, -2]];
  const s = after(atrSignals(mk(rows), 1, 14, 12));
  assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
  assert.strictEqual(rel(s[0].t), 5);
  assert.ok(s.map((x) => x as unknown as { candleOiPct: number })[0].candleOiPct > 0, "the candle's own OI went up");
});

scenario("a rise with OI only falling (no growth) is never an entry", () => {
  const rows: Array<[number, number]> = [...warm, [+0.6, -8], [+0.6, -8], [+0.6, -8], [+0.6, -8], [-0.8, -3], [-0.4, +2], [-0.4, -2]];
  assert.strictEqual(after(atrSignals(mk(rows), 1, 14, 12)).length, 0);
});

scenario("not RANK 1 (a smaller OI build than the earlier moves) -> no entry", () => {
  const rows: Array<[number, number]> = [...warm, [+0.6, +8], [+0.6, +8], [+0.6, +8], [+0.6, +8], [-0.7, -3], [-0.7, -3], [-0.7, -3], [-0.4, -2], [-0.4, -2],
    [+0.6, +1], [+0.6, +1], [+0.6, +1], [-0.7, -1], [-0.4, -1]];
  const s = after(atrSignals(mk(rows), 1, 14, 12));
  assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
  assert.ok(rel(s[0].t) < 9, "only the first (big) build-up");
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

scenario("the mirror: a fall with OI growing, OI then below its peak, a close 1 ATR up from the low -> LONG", () => {
  const rows: Array<[number, number]> = [...warm, [-0.6, +8], [-0.6, +8], [-0.6, +8], [-0.6, +8], [+0.7, -3], [+0.4, -2], [+0.4, -2]];
  const s = after(atrSignals(mk(rows), 1, 14, 12));
  assert.strictEqual(s.length, 1); assert.strictEqual((s[0] as unknown as { side: string }).side, "LONG");
  assert.strictEqual(rel(s[0].t), 5);
});

scenario("why no entry (story tool): the wiggle is 'less than 1 ATR back', the top-making candle 'wait for the next one'", () => {
  const why = new Map<number, string>();
  atrSignals(mk(wiggle), 1, 14, 12, { why: (t, m) => why.set(rel(t), m) });
  assert.match(why.get(3) ?? "", /back from the top, 1 ATR/);
  const rows: Array<[number, number, number?]> = [...warm, [+0.6, +8], [+0.6, +8], [+0.6, +8], [+0.6, +8], [-0.6, -3, +1.0], [-0.2, -1], [-0.4, -2]];
  const w2 = new Map<number, string>();
  atrSignals(mk(rows), 1, 14, 12, { why: (t, m) => w2.set(rel(t), m) });
  assert.match(w2.get(5) ?? "", /made the top -> wait/);
});

scenario("SUI (Oct 3): OI grows with the price, then falls BELOW where it started while the price keeps rising (shorts out) -> only 'biggest' growth sees it", () => {
  const rows: Array<[number, number]> = [...warm, [+0.6, +8], [+0.6, -4], [+0.6, -4], [+0.6, -4], [+0.6, -4], [-0.8, -2], [-0.4, -2], [-0.4, -2]];
  assert.strictEqual(after(atrSignals(mk(rows), 1, 14, 12)).length, 0, "afterLow: OI's low is now after the growth -> no growth");
  const s = after(atrSignals(mk(rows), 1, 14, 12, { growth: "biggest" }));
  assert.strictEqual(s.length, 1, JSON.stringify(s.map((x) => rel(x.t))));
  assert.strictEqual(rel(s[0].t), 6);
  assert.ok(Math.abs(s[0].buildOiPct - 0.8) < 0.05, `growth ${s[0].buildOiPct}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
