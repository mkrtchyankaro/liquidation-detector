/**
 * Live V9 engine:
 *  - the bounded minute store builds the SAME buckets as research on raw rows
 *  - evaluate(now) never uses data after `now` (causality)
 *  - each confirmed episode yields exactly one decision (no duplicates)
 *  - stale confirmations and too-small references are never tradable
 *
 * Usage: npx tsx tests/v9-causal-engine.test.ts
 */
import * as assert from "assert";
import { buildBuckets, type LiqEvent, type OiObservation } from "../src/strategy/v9/v9-core";
import { V9MinuteStore } from "../src/strategy/v9/v9-minute-store";
import { V9CausalEngine, DEFAULT_V9_ENGINE_SETTINGS } from "../src/strategy/v9/v9-causal-engine";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}

function market(seed: number, minutes: number) {
  let x = seed >>> 0;
  const rnd = (): number => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
  const from = 1_790_000_040_000 - (1_790_000_040_000 % 60_000);
  const liq: LiqEvent[] = [], oi: OiObservation[] = [];
  let level = 100_000, price = 50_000, burst = 0, side: "LONG" | "SHORT" = "LONG";
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
    if (rnd() < 0.93) { const u = t + Math.floor(rnd() * 50_000); for (let p = 0; p < 3; p++) oi.push({ ts: u + 200 + p * 1000, updated: u, oi: level, price: price * (1 + (p - 1) * 1e-4) }); }
  }
  liq.sort((a, b) => a.ts - b.ts); oi.sort((a, b) => a.ts - b.ts);
  return { liq, oi, from, until: from + minutes * 60_000 - 1 };
}

function feed(store: V9MinuteStore, d: ReturnType<typeof market>, upTo: number, state: { li: number; oi: number }): void {
  while (state.li < d.liq.length && d.liq[state.li].ts <= upTo) { const e = d.liq[state.li++]; store.addLiquidation(e.ts, e.victim, e.usd); }
  while (state.oi < d.oi.length && d.oi[state.oi].ts <= upTo) { const o = d.oi[state.oi++]; store.addOiObservation(o.ts, o.updated, o.oi, o.price); }
}

console.log("V9 causal engine");

scenario("minute store buckets are identical to research buildBuckets on raw rows", () => {
  for (const seed of [3, 11, 77]) {
    const d = market(seed, 2000);
    const store = new V9MinuteStore();
    feed(store, d, Infinity, { li: 0, oi: 0 });
    const a = store.toBuckets(d.from, d.until);
    const b = buildBuckets(d.liq, d.oi.filter((o) => o.updated >= d.from && o.updated <= d.until), d.from, d.until);
    assert.strictEqual(a.length, b.length);
    a.forEach((x, i) => {
      for (const k of ["ts", "long", "short", "count"] as const) assert.strictEqual(x[k], b[i][k], `seed ${seed} bucket ${i} ${k}`);
      for (const k of ["oi", "price"] as const) assert.ok((Number.isNaN(x[k]) && Number.isNaN(b[i][k])) || x[k] === b[i][k], `seed ${seed} bucket ${i} ${k}`);
    });
  }
});

function replay(seed: number, minutes: number, settings = DEFAULT_V9_ENGINE_SETTINGS) {
  const d = market(seed, minutes);
  const engine = new V9CausalEngine("TESTUSDT", settings);
  const state = { li: 0, oi: 0 };
  const decisions = [];
  for (let t = d.from + 60_000 + 10_000; t <= d.until; t += 60_000) {
    feed(engine.store, d, t, state);
    decisions.push(...engine.evaluate(t));
  }
  return { d, decisions };
}

scenario("replay produces decisions; each confirmed episode is decided exactly once, in time order", () => {
  const { decisions } = replay(5, 1500);
  assert.ok(decisions.length > 5, `expected decisions, got ${decisions.length}`);
  const confirms = decisions.map((x) => x.episode.confirmTs);
  assert.deepStrictEqual(confirms, [...confirms].sort((a, b) => a - b));
  assert.strictEqual(new Set(confirms).size, confirms.length, "no duplicate confirmations");
});

scenario("causality: decisions at time t are unchanged when data after t exists in the dataset", () => {
  const full = replay(9, 1500).decisions;
  const cut = full[Math.floor(full.length / 2)].evaluatedAt;
  const short = (() => {
    const d = market(9, 1500);
    const engine = new V9CausalEngine("TESTUSDT");
    const state = { li: 0, oi: 0 };
    const out = [];
    for (let t = d.from + 70_000; t <= cut; t += 60_000) { feed(engine.store, d, t, state); out.push(...engine.evaluate(t)); }
    return out;
  })();
  const sameWindow = full.filter((x) => x.evaluatedAt <= cut);
  assert.deepStrictEqual(short.map((x) => [x.episode.confirmTs, x.reason]), sameWindow.map((x) => [x.episode.confirmTs, x.reason]));
});

scenario("tradable decisions are fresh (within 2 min of confirmation) and carry a sane trade plan", () => {
  const { decisions } = replay(5, 1500);
  for (const x of decisions) {
    if (x.tradable) assert.ok(x.evaluatedAt - x.episode.confirmTs <= 2 * 60_000, "a tradable signal is always fresh");
    assert.strictEqual(x.tradeSide, x.episode.victim, "fade: LONG victims -> BUY, SHORT victims -> SELL");
    if (x.tradable) {
      assert.ok(x.stopPrice > 0 && x.referencePrice > 0);
      assert.ok(x.tradeSide === "LONG" ? x.stopPrice <= x.referencePrice : x.stopPrice >= x.referencePrice, "stop is beyond price on the losing side");
    }
  }
});

scenario("a reference smaller than minReferenceSamples never produces a tradable signal", () => {
  const { decisions } = replay(5, 1500, { ...DEFAULT_V9_ENGINE_SETTINGS, minReferenceSamples: 10_000 });
  assert.ok(decisions.every((x) => !x.tradable));
});

scenario("confirmations found late (e.g. after a data gap) are STALE and never tradable", () => {
  const { decisions } = replay(5, 1500, { ...DEFAULT_V9_ENGINE_SETTINGS, maxSignalAgeMs: -1 });
  assert.ok(decisions.every((x) => !x.tradable));
  assert.ok(decisions.some((x) => x.reason === "STALE_CONFIRMATION") || decisions.every((x) => x.reason !== "SELECTED"));
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
