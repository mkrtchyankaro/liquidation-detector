/**
 * Price + OI moves (step 1, finding only). Usage: npx tsx tests/oi-moves.test.ts
 */
import * as assert from "assert";
import { accumulation, findMoves, flowBetween, type MvHour } from "../src/research/oi-moves";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const H = 3_600_000, T0 = Date.UTC(2026, 8, 1);
/** [open, close, oiAtClose]; high/low = body +-0.1 */
function hours(v: Array<[number, number, number]>): MvHour[] {
  return v.map(([o, c, oi], i) => ({ t: T0 + i * H, open: o, close: c, high: Math.max(o, c) + 0.1, low: Math.min(o, c) - 0.1, oi, oiOpen: i ? v[i - 1][2] : oi }));
}
// the market swinging around 100 before the move (bodies do not step one way); the last one is the dip the move starts from
const swing: Array<[number, number, number]> = [[100, 100.3, 1000], [100.3, 99.9, 1000], [99.9, 100.4, 1000], [100.4, 99.8, 1000], [99.8, 100.5, 1000], [100.5, 99.7, 1000]];
const flat = [...swing, ...swing];
const S = flat.length - 1;

scenario("price up with bodies stepping up + OI up then down -> one UP move, built phase then closing phase", () => {
  const h = hours([...flat, [100, 101, 1010], [101, 102, 1025], [102, 102.5, 1030], [102.5, 103, 1020], [103, 102, 1015]]);
  const m = findMoves(h);
  assert.strictEqual(m.length, 1);
  assert.deepStrictEqual([m[0].dir, m[0].s, m[0].e, m[0].startPrice], ["UP", S, S + 4, 99.7]);
  assert.deepStrictEqual(m[0].phases.map((p) => [p.kind, p.from, p.to]), [["PRICE UP + OI UP", T0 + S * H, T0 + (S + 4) * H], ["PRICE UP + OI DOWN", T0 + (S + 4) * H, T0 + (S + 5) * H]]);
  assert.ok(Math.abs(m[0].phases[0].oiPct - 3) < 1e-9);
});

scenario("small steps inside the range the market was swinging in are not a move", () => {
  const h = hours([...flat, [100, 100.1, 1010], [100.1, 100.2, 1020], [100.2, 100.3, 1030], [100.3, 99.9, 1030]]);
  assert.strictEqual(findMoves(h).length, 0);
});

scenario("price down with bodies stepping down + OI up -> DOWN move, OI UP phase to the OI peak", () => {
  const h = hours([...flat, [100, 99, 1010], [99, 98, 1020], [98, 97, 1040], [97, 97.5, 1040]]);
  const m = findMoves(h);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].dir, "DOWN"); assert.strictEqual(m[0].phases[0].kind, "PRICE DOWN + OI UP");
  assert.strictEqual(m[0].phases[0].to, T0 + (S + 4) * H);
});

scenario("OI falling from the start -> one OI DOWN phase", () => {
  const h = hours([...flat, [100, 101, 995], [101, 102, 990], [102, 103, 980], [103, 102, 980]]);
  const m = findMoves(h);
  assert.strictEqual(m.length, 1);
  assert.deepStrictEqual(m[0].phases.map((p) => p.kind), ["PRICE UP + OI DOWN"]);
});

scenario("two candles are not a sequence", () => {
  const h = hours([...flat, [100.2, 100.6, 1000], [100, 102, 1010], [102, 104, 1020], [104, 101.5, 1020]]);
  assert.strictEqual(findMoves(h).length, 0);
});

scenario("flow: OI up/down split by the price direction of each small step, only inside [from, to)", () => {
  const M = 5 * 60_000;
  const b = [[100, 100, 1000], [100, 101, 1010], [101, 100.5, 1015], [100.5, 101, 1012], [101, 100, 1008], [100, 101, 1020]].map(([o, c, oi], i) => ({ t: T0 + i * M, open: o, close: c, oi }));
  assert.deepStrictEqual(flowBetween(b, T0, T0 + 5 * M), { newLong: 10, newShort: 5, longOut: 4, shortOut: 3 });
  assert.deepStrictEqual(flowBetween(b, T0 + 2 * M, T0 + 4 * M), { newLong: 0, newShort: 5, longOut: 0, shortOut: 3 });
});

scenario("accumulation: OI must grow more than it was swinging before; a 1-candle OI peak where the price went nowhere does not count", () => {
  const big = hours([...flat, [100, 101, 1010], [101, 102, 1025], [102, 102.5, 1030], [102.5, 103, 1020], [103, 102, 1015]]);
  assert.deepStrictEqual(accumulation(big, findMoves(big)[0]), { ok: true, ongoing: false });
  const noisyOi = hours([...flat.map(([o, c], i): [number, number, number] => [o, c, i % 2 ? 1040 : 1000]), [100, 101, 1010], [101, 102, 1025], [102, 102.5, 1030], [102.5, 103, 1020], [103, 102, 1015]]);
  assert.strictEqual(accumulation(noisyOi, findMoves(noisyOi)[0]).ok, false); // +30 while it swung 40 before
  const still = hours([...flat, [100, 101, 1010], [101, 102, 1025], [102, 103, 1030]]);
  assert.deepStrictEqual(accumulation(still, findMoves(still)[0]), { ok: true, ongoing: true });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
