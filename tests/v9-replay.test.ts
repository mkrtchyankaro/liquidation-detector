/**
 * V9 replay trade simulation (entry at first poll at/after the decision,
 * SL = episode extreme, TP = rr x risk).
 * Usage: npx tsx tests/v9-replay.test.ts
 */
import * as assert from "assert";
import { replaySymbol, replaySymbolMulti, simulateTrade, stopForVariant, typicalMinuteRangeBefore, type Poll } from "../src/strategy/v9/v9-replay";
import { DEFAULT_V9_ENGINE_SETTINGS } from "../src/strategy/v9/v9-causal-engine";
import type { LiqEvent, OiObservation } from "../src/strategy/v9/v9-core";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const polls = (prices: number[]): Poll[] => prices.map((price, i) => ({ ts: 1_000 + i * 1_000, price }));

console.log("V9 replay simulation");
scenario("BUY: TP at entry + 2.2R", () => {
  const t = simulateTrade(polls([100, 100.5, 101, 102.3]), { evaluatedAt: 1_000, tradeSide: "LONG", stopPrice: 99 }, 2.2);
  assert.strictEqual(t.result, "TP"); assert.strictEqual(t.r, 2.2); assert.ok(Math.abs(t.tp! - 102.2) < 1e-9);
});
scenario("BUY: SL when price reaches the episode low", () => {
  const t = simulateTrade(polls([100, 99.5, 99]), { evaluatedAt: 1_000, tradeSide: "LONG", stopPrice: 99 }, 2.2);
  assert.strictEqual(t.result, "SL"); assert.strictEqual(t.r, -1);
});
scenario("SELL: mirror image", () => {
  assert.strictEqual(simulateTrade(polls([100, 99, 97.7]), { evaluatedAt: 1_000, tradeSide: "SHORT", stopPrice: 101 }, 2.2).result, "TP");
  assert.strictEqual(simulateTrade(polls([100, 100.5, 101]), { evaluatedAt: 1_000, tradeSide: "SHORT", stopPrice: 101 }, 2.2).result, "SL");
});
scenario("entry already beyond SL -> NO_RISK (never counted as a trade)", () => {
  assert.strictEqual(simulateTrade(polls([98.9, 100]), { evaluatedAt: 1_000, tradeSide: "LONG", stopPrice: 99 }, 2.2).result, "NO_RISK");
});
scenario("entry is the first poll AT/AFTER the decision time (no earlier price)", () => {
  const t = simulateTrade(polls([50, 100, 102.2]), { evaluatedAt: 1_500, tradeSide: "LONG", stopPrice: 99 }, 2.2);
  assert.strictEqual(t.entry, 100);
});
scenario("neither hit -> OPEN", () => {
  assert.strictEqual(simulateTrade(polls([100, 100.2, 99.9]), { evaluatedAt: 1_000, tradeSide: "LONG", stopPrice: 99 }, 2.2).result, "OPEN");
});
scenario("SL sweep: a stop widened x2 survives a dip that hits the current stop, then reaches its own 2.2R TP", () => {
  // entry 100, current SL 99 (1%). Price dips to 98.9 then rallies to 104.5.
  const p = polls([100, 99.5, 98.9, 101, 103, 104.5]);
  const d = { evaluatedAt: 1_000, tradeSide: "LONG" as const, stopPrice: 99 };
  assert.strictEqual(simulateTrade(p, d, 2.2).result, "SL");
  const wide = simulateTrade(p, d, 2.2, (e) => stopForVariant("X2", "LONG", e, 99, 0));
  assert.strictEqual(wide.sl, 98);
  assert.strictEqual(wide.result, "TP", "TP = 100 + 2.2*2 = 104.4");
});
scenario("SL sweep placements (LONG below, SHORT above)", () => {
  assert.strictEqual(stopForVariant("CURRENT", "LONG", 100, 99.9, 0.05), 99.9);
  assert.ok(Math.abs(stopForVariant("MIN_0.33%", "LONG", 100, 99.9, 0.05) - 99.67) < 1e-9, "tight stop widened to 0.33%");
  assert.strictEqual(stopForVariant("MIN_0.33%", "LONG", 100, 99, 0.05), 99, "wide stop unchanged");
  assert.ok(Math.abs(stopForVariant("PLUS_1_MINUTE_RANGE", "SHORT", 100, 101, 0.2) - 101.2) < 1e-9);
  assert.ok(Math.abs(stopForVariant("X1.5", "SHORT", 100, 101, 0) - 101.5) < 1e-9);
});
scenario("typical minute range = mean high-low per minute over the last hour", () => {
  const p: Poll[] = [{ ts: 0, price: 10 }, { ts: 10_000, price: 12 }, { ts: 60_000, price: 11 }, { ts: 70_000, price: 11.5 }];
  assert.ok(Math.abs(typicalMinuteRangeBefore(p, 120_000) - 1.25) < 1e-12);
});


function market(seed: number, minutes: number) {
  let x = seed >>> 0;
  const rnd = (): number => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
  const from = 1_790_000_040_000 - (1_790_000_040_000 % 60_000);
  const liq: LiqEvent[] = [], oi: OiObservation[] = [];
  let level = 100_000, price = 50_000, burst = 0, side: "LONG" | "SHORT" = "LONG";
  let lastUpdated = from - 30_000, lastLevel = level;
  for (let m = 0; m < minutes; m++) {
    const t = from + m * 60_000;
    if (burst === 0 && rnd() < 0.02) { burst = 5 + Math.floor(rnd() * 40); side = rnd() < 0.5 ? "LONG" : "SHORT"; }
    if (burst > 0) {
      burst--; level *= 1 - rnd() * 0.002; price *= side === "LONG" ? 1 - rnd() * 0.002 : 1 + rnd() * 0.002;
      for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) liq.push({ ts: t + Math.floor(rnd() * 59_000), victim: rnd() < 0.85 ? side : (side === "LONG" ? "SHORT" : "LONG"), usd: rnd() * 50_000 });
    } else {
      level *= 1 + (rnd() - 0.45) * 0.0008; price *= 1 + (rnd() - 0.5) * 0.0008;
      if (rnd() < 0.05) liq.push({ ts: t + Math.floor(rnd() * 59_000), victim: rnd() < 0.5 ? "LONG" : "SHORT", usd: rnd() * 5_000 });
    }
    // The collector polls every minute; in ~7% of minutes Binance has no NEW
    // OI update (the poll repeats the previous update time).
    const fresh = rnd() < 0.93;
    const u = fresh ? t + Math.floor(rnd() * 50_000) : lastUpdated;
    if (fresh) { lastUpdated = u; lastLevel = level; }
    for (let p = 0; p < 3; p++) oi.push({ ts: t + 51_000 + p * 2000, updated: u, oi: lastLevel, price: price * (1 + (p - 1) * 1e-4) });
  }
  liq.sort((a, b) => a.ts - b.ts); oi.sort((a, b) => a.ts - b.ts);
  return { liq, oi, from, until: from + minutes * 60_000 - 1 };
}


scenario("multi-variant replay (one shared pass) gives EXACTLY the same decisions and trades as one replay per variant", () => {
  const d = market(7, 1500);
  const variants = [
    { settings: { ...DEFAULT_V9_ENGINE_SETTINGS, minSlFraction: 0.0033 }, rr: 2.2 },
    { settings: { ...DEFAULT_V9_ENGINE_SETTINGS, minSlFraction: 0.0033, lateSlPct: 0 }, rr: 2.2 },
    { settings: { ...DEFAULT_V9_ENGINE_SETTINGS, minSlFraction: 0.0033, minAccumPercentile: 70 }, rr: 2.2 },
    { settings: { ...DEFAULT_V9_ENGINE_SETTINGS, significantOppositeLiq: true }, rr: 2 },
  ];
  const multi = replaySymbolMulti("TESTUSDT", d.liq, d.oi, d.from, d.until, variants);
  variants.forEach((v, k) => {
    const single = replaySymbol("TESTUSDT", d.liq, d.oi, d.from, d.until, v.rr, v.settings);
    const sig = (x: { decisions: Array<{ evaluatedAt: number; reason: string; stopPrice: number }> }) => x.decisions.map((z) => `${z.evaluatedAt}|${z.reason}|${z.stopPrice}`);
    assert.deepStrictEqual(sig(multi[k]), sig(single), `variant ${k}: decisions differ`);
    assert.deepStrictEqual(multi[k].trades.map((t) => t.trade), single.trades.map((t) => t.trade), `variant ${k}: trades differ`);
  });
  assert.ok(multi[0].decisions.length > 3);
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
