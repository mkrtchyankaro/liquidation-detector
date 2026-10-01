/**
 * V9 what-if TP / min SL / max open. Usage: npx tsx tests/v9-tp-sim.test.ts
 */
import * as assert from "assert";
import { simPortfolio, simTrade, type TpBar, type TpTrade } from "../src/research/v9-tp-sim";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const M = 60_000, T0 = Date.UTC(2026, 8, 24, 10, 0, 30);
const t = (id: string, symbol: string, createdAt = T0, sl = 99): TpTrade => ({ id, symbol, side: "LONG", createdAt, entry: 100, sl });
const bar = (i: number, high: number, low: number, close = 100): TpBar => ({ t: Math.floor(T0 / M) * M + i * M, high, low, close });
const o = { tpR: 1.5, minSlPct: 0, maxOpen: null, timeStopH: null, riskUsd: 10 };

scenario("TP 1.5R hit before SL; the entry minute is ignored; fees like PAPER (taker + maker)", () => {
  const r = simTrade(t("a", "X"), [bar(0, 90, 90), bar(1, 101.6, 99.5)], o);
  assert.strictEqual(r.status, "TP");
  assert.ok(Math.abs(r.r - (1.5 - (100 * 10 * 0.0007) / 10)) < 1e-9); // notional $1000 -> $0.7 fee
  assert.strictEqual(simTrade(t("a", "X"), [bar(1, 101.6, 99.5)], { ...o, tpR: 2.2 }).status, "OPEN");
});
scenario("SL and TP in the same minute -> SL", () => assert.strictEqual(simTrade(t("a", "X"), [bar(1, 102, 98)], o).status, "SL"));
scenario("time stop closes at the minute close", () => {
  const r = simTrade(t("a", "X"), [bar(1, 100.2, 99.8), bar(90, 100.4, 99.9, 100.3)], { ...o, timeStopH: 1 });
  assert.strictEqual(r.status, "TIME");
});
scenario("min SL filter and max open 2 (a trade frees its slot when it closes)", () => {
  const bars = (s: string): TpBar[] => (s === "A" ? [bar(5, 102, 99.5)] : []); // A hits TP at minute 5, others stay open
  const list = [t("a", "A"), t("b", "B", T0 + M), t("c", "C", T0 + 2 * M), t("tiny", "D", T0 + 3 * M, 99.5), t("d", "E", T0 + 10 * M)];
  const { taken, skipped } = simPortfolio(list, bars, { ...o, minSlPct: 0.7, maxOpen: 2 });
  assert.deepStrictEqual(taken.map((x) => x.trade.id), ["a", "b", "d"]);
  assert.deepStrictEqual(skipped.map((x) => `${x.trade.id}:${x.why}`), ["c:MAX_OPEN", "tiny:MIN_SL"]);
});
scenario("PROFIT LOCK: at +1.5R the SL moves to +1.5R; back there = PROFIT_STOP (+1.5R minus a taker fee); on to 2.2R = TP", () => {
  const lk = { ...o, tpR: 2.2, lockAtR: 1.5 };
  const back = simTrade(t("a", "X"), [bar(1, 101.6, 99.5, 101.6), bar(2, 101.6, 100.5)], lk);
  assert.strictEqual(back.status, "PROFIT_STOP");
  assert.ok(Math.abs(back.r - (1.5 - 0.1)) < 1e-9, `r ${back.r}`); // taker both ways: $1000 x 0.1% = $1 = 0.1R
  assert.strictEqual(simTrade(t("a", "X"), [bar(1, 101.6, 99.5, 101.6), bar(2, 102.3, 101.55)], lk).status, "TP");
  // never locked -> plain SL
  assert.strictEqual(simTrade(t("a", "X"), [bar(1, 101.2, 99.5), bar(2, 100, 98.9)], lk).status, "SL");
  // the lock minute: its low may be from before the lock -> only a close back at the lock = PROFIT_STOP
  assert.strictEqual(simTrade(t("a", "X"), [bar(1, 101.7, 99.5, 101.4)], lk).status, "PROFIT_STOP");
  assert.strictEqual(simTrade(t("a", "X"), [bar(1, 101.7, 99.5, 101.6)], lk).status, "OPEN");
  // lockTo below lockAt
  assert.ok(Math.abs(simTrade(t("a", "X"), [bar(1, 101.6, 99.5, 101.6), bar(2, 101.4, 100.9)], { ...lk, lockToR: 1 }).r - (1 - 0.1)) < 1e-9);
  assert.throws(() => simTrade(t("a", "X"), [], { ...o, tpR: 1.5, lockAtR: 1.5 }), /lock/);
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
