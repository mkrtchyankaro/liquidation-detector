/**
 * OI accumulation story (accumulation -> OI drop -> after). Usage: npx tsx tests/oi-story.test.ts
 */
import * as assert from "assert";
import type { MinuteRow } from "../src/research/oi-accumulation";
import { balance, liqBetween, smallCandles, stories, tradeAtMoment, type Story } from "../src/research/oi-story";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const H = 3_600_000, M = 60_000, T0 = Date.UTC(2026, 8, 1);
/** hours: [open, close, oiAtOpen, oiAtClose, longLiqUsd, shortLiqUsd] -> 60 minutes each, linear */
function minutes(spec: Array<[number, number, number, number, number, number]>): MinuteRow[] {
  const out: MinuteRow[] = [];
  spec.forEach(([o, c, oi0, oi1, ll, sl], i) => {
    for (let k = 0; k < 60; k++) {
      const p0 = o + ((c - o) * k) / 60, p1 = o + ((c - o) * (k + 1)) / 60, q0 = oi0 + ((oi1 - oi0) * k) / 60, q1 = oi0 + ((oi1 - oi0) * (k + 1)) / 60;
      out.push({ ts: T0 + i * H + k * M, open: p0, high: Math.max(p0, p1) + 0.01, low: Math.min(p0, p1) - 0.01, close: p1, oiFirst: q0, oiLast: q1, oiMax: Math.max(q0, q1), longLiqUsd: k === 30 ? ll : 0, shortLiqUsd: k === 30 ? sl : 0 });
    }
  });
  return out;
}
const swing: Array<[number, number, number, number, number, number]> = [
  [100, 100.3, 1000, 1000, 0, 0], [100.3, 99.9, 1000, 1000, 0, 0], [99.9, 100.4, 1000, 1000, 0, 0], [100.4, 99.8, 1000, 1000, 0, 0], [99.8, 100.5, 1000, 1000, 0, 0], [100.5, 99.7, 1000, 1000, 0, 0]];
const flatAfter = (n: number, p: number, oi: number): Array<[number, number, number, number, number, number]> => Array.from({ length: n }, () => [p, p, oi, oi, 0, 0]);

scenario("up move + OI up -> accumulation; OI then falls with long liquidations -> LONGS cleaned; the price afterwards", () => {
  const spec: Array<[number, number, number, number, number, number]> = [...swing, ...swing,
    [100, 101, 1000, 1010, 0, 5000], [101, 102, 1010, 1025, 0, 8000], [102, 103, 1025, 1030, 0, 0], // accumulation 3h
    [103, 102, 1030, 1015, 50000, 1000], [102, 101, 1015, 1005, 30000, 0],                       // OI drop 2h, longs liquidated
    ...flatAfter(30, 101, 1005)];
  const rows = minutes(spec), until = T0 + spec.length * H;
  const s = stories("XUSDT", rows, until);
  assert.strictEqual(s.length, 1);
  const x = s[0];
  assert.strictEqual(x.dir, "UP");
  assert.deepStrictEqual([x.acc.from, x.acc.to, x.acc.oiFrom, x.acc.oiTo], [T0 + 11 * H, T0 + 15 * H, 1000, 1030]);
  assert.ok(Math.abs(x.acc.liq.shortUsd - 13000) < 1e-6);
  assert.ok(x.drop); assert.deepStrictEqual([x.drop!.from, x.drop!.to, x.drop!.cleaned], [T0 + 15 * H, T0 + 17 * H, "LONGS"]);
  assert.ok(Math.abs(x.drop!.cleanedPct - 250 / 3) < 1e-6);   // 25 of the 30 built
  assert.ok(x.drop!.flow.longOut > 24 && x.drop!.flow.shortOut === 0);
  assert.ok(x.after); assert.ok(Math.abs(x.after!.h4!) < 1e-9); assert.strictEqual(x.after!.hoursSeen, 24);
});

scenario("OI still growing at the last closed hour -> no drop, no after", () => {
  const spec: Array<[number, number, number, number, number, number]> = [...swing, ...swing, [100, 101, 1000, 1010, 0, 0], [101, 102, 1010, 1025, 0, 0], [102, 103, 1025, 1040, 0, 0]];
  const s = stories("XUSDT", minutes(spec), T0 + spec.length * H);
  assert.strictEqual(s.length, 1); assert.strictEqual(s[0].drop, null); assert.strictEqual(s[0].ongoing, true);
});

scenario("the price move ends but the OI keeps growing -> the accumulation runs on to the real OI peak", () => {
  const spec: Array<[number, number, number, number, number, number]> = [...swing, ...swing,
    [100, 101, 1000, 1010, 0, 0], [101, 102, 1010, 1025, 0, 0], [102, 103, 1025, 1030, 0, 0],
    [103, 102.2, 1030, 1036, 0, 0],                         // price turns (move over) but the OI still grows
    [102.2, 101, 1036, 1012, 40000, 0], ...flatAfter(26, 101, 1012)];
  const s = stories("XUSDT", minutes(spec), T0 + spec.length * H);
  assert.strictEqual(s.length, 1);
  assert.deepStrictEqual([s[0].acc.to, s[0].acc.oiTo, s[0].drop!.from, s[0].drop!.to, s[0].drop!.cleaned], [T0 + 16 * H, 1036, T0 + 16 * H, T0 + 17 * H, "LONGS"]);
});

scenario("real liquidations in coins = USD / that minute's price, only inside [from, to)", () => {
  const rows = minutes([[100, 100, 1, 1, 1000, 500], [200, 200, 1, 1, 1000, 0]]);
  const l = liqBetween(rows, T0, T0 + H);
  assert.deepStrictEqual([l.longUsd, l.shortUsd, Math.round(l.longCoin), Math.round(l.shortCoin)], [1000, 500, 10, 5]);
});

scenario("15m candles of an hour: price, OI change and real liquidations per quarter", () => {
  const rows = minutes([[100, 104, 1000, 1040, 800, 0]]);        // liquidation at minute 30 -> 3rd quarter
  const q = smallCandles(rows, T0, T0 + H, 15 * M);
  assert.strictEqual(q.length, 4);
  assert.deepStrictEqual(q.map((c) => [c.open, c.close]), [[100, 101], [101, 102], [102, 103], [103, 104]]);
  assert.ok(Math.abs(q[0].oiTo - q[0].oiFrom - 10) < 1e-9);
  assert.deepStrictEqual(q.map((c) => c.liq.longUsd), [0, 0, 800, 0]);
});

const Z = { longUsd: 0, shortUsd: 0, longCoin: 0, shortCoin: 0 };
function story(accFlow: [number, number, number, number], dropFlow: [number, number, number, number], drop: { from: number; to: number; priceTo: number; low: number; high: number }): Story {
  const f = (x: [number, number, number, number]) => ({ newLong: x[0], newShort: x[1], longOut: x[2], shortOut: x[3] });
  const base = { hours: 1, priceFrom: 0, priceTo: 0, pricePct: 0, high: 0, low: 0, oiFrom: 0, oiTo: 0, liq: Z };
  return { symbol: "X", dir: "UP", ongoing: false, acc: { ...base, from: 0, to: drop.from, flow: f(accFlow) },
    drop: { ...base, ...drop, flow: f(dropFlow), cleaned: "LONGS", cleanedPct: 50 }, after: null };
}

scenario("who is left: more shorts left -> LONG; more longs left -> SHORT", () => {
  assert.deepStrictEqual(balance(story([90, 80, 50, 40], [0, 0, 50, 20], { from: 0, to: H, priceTo: 100, low: 99, high: 101 })), { longsLeft: -10, shortsLeft: 20, verdict: "LONG" });
  assert.strictEqual(balance(story([90, 30, 10, 10], [0, 0, 5, 5], { from: 0, to: H, priceTo: 100, low: 99, high: 101 }))!.verdict, "SHORT");
});

scenario("trade at the moment: entry = drop close, SL beyond the drop extreme, 2R / SL first / 24h", () => {
  const st = story([1, 2, 0, 0], [0, 0, 0, 0], { from: T0, to: T0 + H, priceTo: 100, low: 99, high: 101 });
  const up = minutes([[0, 0, 1, 1, 0, 0], [100, 102.5, 1, 1, 0, 0], ...flatAfter(24, 102.5, 1)]);
  const w = tradeAtMoment(up, st, "LONG")!;
  assert.deepStrictEqual([w.result, w.sl, w.hit1R], ["2R", 99, true]); assert.ok(Math.abs(w.r - (2 - 0.1)) < 1e-9);
  const down = minutes([[0, 0, 1, 1, 0, 0], [100, 98, 1, 1, 0, 0], ...flatAfter(24, 98, 1)]);
  assert.strictEqual(tradeAtMoment(down, st, "LONG")!.result, "SL");
  const flat = minutes([[0, 0, 1, 1, 0, 0], ...flatAfter(25, 100.5, 1)]);
  const f = tradeAtMoment(flat, st, "LONG")!;
  assert.strictEqual(f.result, "24h"); assert.ok(Math.abs(f.r - (0.5 - 0.1)) < 1e-9);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
