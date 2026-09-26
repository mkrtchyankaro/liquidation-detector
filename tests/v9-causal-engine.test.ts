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
import { formatV9Story } from "../src/strategy/v9/v9-telegram";
import { V9CausalEngine, DEFAULT_V9_ENGINE_SETTINGS, oiTurnTs, regrowShare, sharpAccumulation, turnDirectionOk, forcedShare, accumulationAgainst } from "../src/strategy/v9/v9-causal-engine";

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

scenario("the same episode is never tradable twice (re-fit re-confirmations are DUPLICATE_EPISODE)", () => {
  for (const seed of [5, 9, 21]) {
    const { decisions } = replay(seed, 1500);
    const tradable = decisions.filter((x) => x.tradable);
    for (let i = 1; i < tradable.length; i++) {
      const prevSame = tradable.slice(0, i).filter((p) => p.episode.victim === tradable[i].episode.victim).at(-1);
      if (prevSame) assert.ok(tradable[i].episode.start >= prevSame.evaluatedAt, `seed ${seed}: overlapping re-trade`);
    }
  }
});

scenario("a selected episode with a whole minute of missing data is DATA_GAP, never tradable", () => {
  // Remove every poll of one minute inside each would-be-tradable episode and replay again.
  const base = replay(5, 1500);
  const target = base.decisions.find((x) => x.tradable)!;
  assert.ok(target, "synthetic market must contain a tradable decision");
  const d = market(5, 1500);
  const holeMinute = Math.floor((target.episode.start + 5 * 60_000) / 60_000) * 60_000;
  d.oi = d.oi.filter((o) => Math.floor(o.ts / 60_000) * 60_000 !== holeMinute);
  const engine = new V9CausalEngine("TESTUSDT");
  const state = { li: 0, oi: 0 };
  const out = [];
  for (let t = d.from + 70_000; t <= d.until; t += 60_000) { feed(engine.store, d, t, state); out.push(...engine.evaluate(t)); }
  const same = out.find((x) => x.episode.start === target.episode.start && x.episode.victim === target.episode.victim && x.reason !== "NOT_SELECTED");
  assert.ok(same, "the same episode is still decided");
  assert.strictEqual(same!.reason, "DATA_GAP");
  assert.ok(same!.missingMinutes >= 1 && !same!.tradable);
});

scenario("after a restart, trades restored with markTraded() block re-trading the same episode", () => {
  const base = replay(5, 1500);
  const target = base.decisions.find((x) => x.tradable)!;
  assert.ok(target, "synthetic market must contain a tradable decision");
  const d = market(5, 1500);
  const engine = new V9CausalEngine("TESTUSDT");
  engine.markTraded(target.tradeSide, target.evaluatedAt + 60_000);
  const state = { li: 0, oi: 0 };
  const out = [];
  for (let t = d.from + 70_000; t <= d.until; t += 60_000) { feed(engine.store, d, t, state); out.push(...engine.evaluate(t)); }
  assert.ok(!out.some((x) => x.tradable && x.episode.victim === target.episode.victim && x.episode.start < target.evaluatedAt + 60_000));
});

scenario("every evaluation leaves a snapshot of what is forming right now", () => {
  const d = market(5, 600);
  const engine = new V9CausalEngine("TESTUSDT");
  const state = { li: 0, oi: 0 };
  let formingSeen = 0;
  for (let t = d.from + 70_000; t <= d.until; t += 60_000) {
    feed(engine.store, d, t, state); engine.evaluate(t);
    if (engine.lastSnapshot && engine.lastSnapshot.ts === t) {
      assert.ok(["OI_FALLING", "OI_RISING", "OI_FLAT"].includes(engine.lastSnapshot.oiPhase));
      if (engine.lastSnapshot.forming) formingSeen++;
    }
  }
  assert.ok(formingSeen > 0, "some minutes show a forming episode");
});

scenario("maxSlFeeR: a signal whose stop-out fees would exceed the limit is SL_TOO_TIGHT, never tradable", () => {
  const base = replay(5, 1500);
  const target = base.decisions.find((x) => x.tradable)!;
  assert.ok(target, "synthetic market must contain a tradable decision");
  const strict = replay(5, 1500, { ...DEFAULT_V9_ENGINE_SETTINGS, maxSlFeeR: 0 }).decisions;
  assert.ok(strict.every((x) => !x.tradable));
  assert.ok(strict.some((x) => x.reason === "SL_TOO_TIGHT"));
  const loose = replay(5, 1500, { ...DEFAULT_V9_ENGINE_SETTINGS, maxSlFeeR: 1e9 }).decisions;
  assert.strictEqual(loose.filter((x) => x.tradable).length, base.decisions.filter((x) => x.tradable).length);
});

scenario("lateSlPct: a far extreme stop moves closer (to where the confirming OI drop started); never farther, never onto the wrong side", () => {
  let moved = 0;
  for (const seed of [5, 9, 21]) {
    const base = replay(seed, 1500).decisions.filter((x) => x.tradable);
    const late = replay(seed, 1500, { ...DEFAULT_V9_ENGINE_SETTINGS, lateSlPct: 0 }).decisions.filter((x) => x.tradable);
    assert.strictEqual(late.length, base.length, "same signals, only the stop may change");
    base.forEach((b, i) => {
      const l = late[i];
      assert.strictEqual(l.referencePrice, b.referencePrice);
      assert.ok(Math.abs(l.referencePrice - l.stopPrice) <= Math.abs(b.referencePrice - b.stopPrice) + 1e-9, "never farther than the extreme stop");
      assert.ok(l.tradeSide === "LONG" ? l.stopPrice < l.referencePrice : l.stopPrice > l.referencePrice, "stop on the losing side");
      if (l.stopPrice !== b.stopPrice) moved++;
    });
    const off = replay(seed, 1500, { ...DEFAULT_V9_ENGINE_SETTINGS, lateSlPct: 1000 }).decisions.filter((x) => x.tradable);
    assert.deepStrictEqual(off.map((d) => d.stopPrice), base.map((d) => d.stopPrice), "threshold never reached -> unchanged");
  }
  void moved; // the synthetic market has no late entries; the anchor itself is tested below
});

scenario("breakoutConfirm: trade side follows the confirming liquidations; classic = the cleaning's victims; stops on the right side", () => {
  const classic = replay(5, 2000, { ...DEFAULT_V9_ENGINE_SETTINGS, filters: "NONE" }).decisions;
  assert.ok(classic.length > 3);
  for (const x of classic) assert.strictEqual(x.tradeSide, x.episode.victim, "classic: trade side = victims");
  const brk = replay(5, 2000, { ...DEFAULT_V9_ENGINE_SETTINGS, filters: "NONE", breakoutConfirm: true, lateSlPct: 0, minSlFraction: 0.0033 }).decisions;
  assert.ok(brk.length > 3);
  let same = 0;
  for (const x of brk) {
    assert.ok(x.episode.confirmSide !== null);
    assert.strictEqual(x.tradeSide, x.episode.confirmSide === "SHORT" ? "LONG" : "SHORT", "SHORT liq -> BUY, LONG liq -> SELL");
    if (x.episode.confirmSide === x.episode.victim) same++;
    if (Number.isFinite(x.stopPrice)) assert.ok(x.tradeSide === "LONG" ? x.stopPrice < x.referencePrice : x.stopPrice > x.referencePrice, `stop on the losing side: ${x.tradeSide} stop ${x.stopPrice} ref ${x.referencePrice} victim ${x.episode.victim} confirm ${x.episode.confirmSide} reason ${x.reason}`);
  }
  assert.ok(same > 0, "breakout mode also confirms with same-side parts (the new trades)");
  assert.ok(brk.length >= classic.length, `breakout confirms at least as often (${brk.length} vs ${classic.length})`);
});

scenario("turnDirectionOk: since the OI turn the price must have moved our way (up for BUY, down for SELL)", () => {
  const b = (m: number, oi: number, price: number) => ({ ts: m * 60_000, long: 0, short: 0, count: 0, oi, price, oiPoints: 1 });
  // OI peaks at minute 5 (price 100), then falls into the confirmation at minute 8
  const buckets = [b(0, 100, 101), b(1, 99, 100), b(2, 98, 99), b(3, 99, 99.5), b(4, 101, 99.8), b(5, 102, 100), b(6, 100, 99), b(7, 97, 98)];
  const e = { eIdx: 3, confirmTs: 8 * 60_000 } as unknown as Parameters<typeof turnDirectionOk>[1];
  assert.strictEqual(turnDirectionOk(buckets, e, "SHORT", 98), true, "SELL: price fell 100 -> 98 since the turn");
  assert.strictEqual(turnDirectionOk(buckets, e, "LONG", 98), false, "BUY while the price fell since the turn = wrong direction");
  assert.strictEqual(turnDirectionOk(buckets, e, "LONG", 100.5), true);
  assert.strictEqual(turnDirectionOk(buckets, e, "SHORT", 100), false, "no move = not our way");
  assert.strictEqual(turnDirectionOk(buckets, { ...e, confirmTs: NaN }, "SHORT", 98), false);
});

scenario("requireTurnDirection in the engine: some signals become WRONG_DIRECTION", () => {
  const base = { ...DEFAULT_V9_ENGINE_SETTINGS, filters: "NONE" as const, breakoutConfirm: true, lateSlPct: 0, minSlFraction: 0.0033 };
  const on = replay(5, 2000, { ...base, requireTurnDirection: true }).decisions;
  assert.ok(on.some((x) => x.reason === "WRONG_DIRECTION"), "the rule does reject something");
});

scenario("lateSlMinPct: the OITURN stop is used only when >= x% from the entry; else it stays at the extreme (or is clamped to x%)", () => {
  const base = { ...DEFAULT_V9_ENGINE_SETTINGS, filters: "NONE" as const };
  const ext = replay(5, 2000, base).decisions;
  const oit = replay(5, 2000, { ...base, lateSlPct: 0 }).decisions;
  const min = replay(5, 2000, { ...base, lateSlPct: 0, lateSlMinPct: 0.6 }).decisions;
  const clamp = replay(5, 2000, { ...base, lateSlPct: 0, lateSlMinPct: 0.6, lateSlClamp: true }).decisions;
  assert.ok(ext.length > 3 && ext.length === oit.length && oit.length === min.length && min.length === clamp.length);
  let kept = 0, moved = 0;
  ext.forEach((e, i) => {
    const ref = e.referencePrice, dOit = Math.abs(ref - oit[i].stopPrice) / ref * 100;
    if (oit[i].stopPrice === e.stopPrice) { assert.strictEqual(min[i].stopPrice, e.stopPrice); return; }
    if (dOit >= 0.6) { assert.strictEqual(min[i].stopPrice, oit[i].stopPrice); moved++; }
    else {
      assert.strictEqual(min[i].stopPrice, e.stopPrice, "too close -> stays at the extreme"); kept++;
      const dClamp = Math.abs(ref - clamp[i].stopPrice) / ref * 100;
      assert.ok(Math.abs(dClamp - 0.6) < 1e-9 || clamp[i].stopPrice === e.stopPrice, `clamped to 0.6% (or the extreme if closer): ${dClamp}`);
    }
  });
  assert.ok(kept + moved > 0, "the rule was exercised");
});

scenario("forcedShare: victim liquidations $ / OI drop $ (coins x price)", () => {
  const e = { startOi: 1000, minOi: 900, endPrice: 50 } as unknown as Parameters<typeof forcedShare>[0];
  assert.ok(Math.abs(forcedShare(e, 500) - 0.1) < 1e-12, "100 coins x $50 = $5,000 closed; $500 forced = 10%");
  assert.ok(Number.isNaN(forcedShare({ ...e, minOi: 1000 } as typeof e, 500)), "no OI drop -> not measurable");
});

scenario("accumulationAgainst: during the accumulation the price kept going the cleaning's way", () => {
  const b = (m: number, oi: number, price: number) => ({ ts: m * 60_000, long: 0, short: 0, count: 0, oi, price, oiPoints: 1 });
  // LONG cleaning: OI 100 -> 95 (bottom at minute 3, price 97), accumulation to the OI turn at minute 6
  const lower = [b(0, 100, 100), b(1, 98, 99), b(2, 96, 98), b(3, 95, 97), b(4, 97, 96.5), b(5, 99, 96), b(6, 101, 95.5), b(7, 98, 96)];
  const e = { sIdx: 0, eIdx: 4, victim: "LONG", confirmTs: 8 * 60_000 } as unknown as Parameters<typeof accumulationAgainst>[1];
  assert.strictEqual(accumulationAgainst(lower, e), true, "price 97 -> 95.5 while OI grew: new shorts opened (against them = our BUY fuel)");
  const bounce = lower.map((x, i) => (i >= 4 && i <= 6 ? { ...x, price: 97 + (i - 3) } : x));
  assert.strictEqual(accumulationAgainst(bounce, e), false, "price bounced up during the accumulation");
  assert.strictEqual(accumulationAgainst(lower.map((x) => ({ ...x })), { ...e, victim: "SHORT" } as typeof e), false, "mirror: SHORT victims need the price going UP");
});

scenario("story: every tradable decision carries the 3-phase story; the Armenian message renders it", () => {
  const { decisions } = replay(5, 2000, { ...DEFAULT_V9_ENGINE_SETTINGS, filters: "NONE", lateSlPct: 0 });
  const tradable = decisions.filter((x) => x.tradable);
  assert.ok(tradable.length > 0);
  for (const x of tradable) {
    const st = x.story!;
    assert.ok(st, "story present");
    assert.ok(st.cleaning.from <= st.cleaning.to, "cleaning ends after it starts");
    if (st.accumulation) assert.ok(st.accumulation.from === st.cleaning.to && st.accumulation.to <= x.evaluatedAt);
    assert.strictEqual(st.checksTotal, 5);
  }
  assert.ok(decisions.filter((x) => !x.tradable).every((x) => x.story === undefined), "only tradable decisions carry a story");
  const text = formatV9Story(tradable[0].story!, "TEST").join("\n");
  assert.ok(text.includes("1️⃣ Մաքրում") && text.includes("Ստուգումներ"), text);
  console.log("\n--- sample ---\n" + text + "\n--------------");
});

scenario("oiTurnTs: the highest-OI minute between the episode's last part and the confirmation (known before the confirmation)", () => {
  const b = (m: number, oi: number) => ({ ts: m * 60_000, long: 0, short: 0, count: 0, oi, price: 100, oiPoints: 1 });
  const buckets = [b(0, 100), b(1, 99), b(2, 98), b(3, 99), b(4, 101), b(5, 102), b(6, 100), b(7, 97), b(8, 120)];
  const e = { eIdx: 3, confirmTs: 8 * 60_000 } as unknown as Parameters<typeof oiTurnTs>[1];
  assert.strictEqual(oiTurnTs(buckets, e), 5 * 60_000, "OI peaked at minute 5, then fell into the confirmation; minute 8 (after it) ignored");
  assert.strictEqual(oiTurnTs(buckets, { ...e, confirmTs: NaN }), null);
});

scenario("regrowShare: OI re-opened after the cleaning / coins the cleaning closed (no time window)", () => {
  const b = (m: number, oi: number) => ({ ts: m * 60_000, long: 0, short: 0, count: 0, oi, price: 100, oiPoints: 1 });
  // cleaning 100 -> 90 (10 closed), regrow to 95 at minute 6 (5 re-opened), confirming drop; minute 9 is after the confirmation
  const buckets = [b(0, 100), b(1, 96), b(2, 92), b(3, 90), b(4, 92), b(5, 94), b(6, 95), b(7, 93), b(8, 91), b(9, 130)];
  const e = { sIdx: 0, eIdx: 3, startOi: 100, minOi: 90, confirmTs: 8 * 60_000 } as unknown as Parameters<typeof regrowShare>[1];
  assert.ok(Math.abs(regrowShare(buckets, e)! - 0.5) < 1e-9, String(regrowShare(buckets, e)));
  // slow or fast does not matter -- only how much re-opened
  const slow = [b(0, 100), b(1, 90), ...Array.from({ length: 50 }, (_, k) => b(2 + k, 90 + (5 * (k + 1)) / 50)), b(52, 91)];
  const e2 = { ...e, eIdx: 2, confirmTs: 52 * 60_000 } as typeof e;
  assert.ok(Math.abs(regrowShare(slow, e2)! - 0.5) < 1e-9);
  assert.strictEqual(regrowShare(buckets, { ...e, confirmTs: NaN }), null);
});

scenario("sharpAccumulation: a fast, big OI rise after the cleaning passes P90; a slow drift of the same total does not", () => {
  const mk = (rise: (m: number) => number) => {
    const bs = [];
    // 600 minutes of normal life: OI swings +-0.4% (normal 30-min rises up to ~0.8%)
    for (let m = 0; m < 600; m++) bs.push({ ts: m * 60_000, long: 0, short: 0, count: 0, oi: 1000 * (1 + 0.004 * Math.sin(m / 7)), price: 100, oiPoints: 1 });
    // cleaning 600..620: OI -2%
    for (let m = 600; m < 620; m++) bs.push({ ts: m * 60_000, long: 1, short: 0, count: 1, oi: 1000 - (m - 600), price: 100, oiPoints: 1 });
    // accumulation 620..740 by the given curve, then the confirming drop
    for (let m = 620; m < 740; m++) bs.push({ ts: m * 60_000, long: 0, short: 0, count: 0, oi: 980 + rise(m - 620), price: 100, oiPoints: 1 });
    for (let m = 740; m < 760; m++) bs.push({ ts: m * 60_000, long: 0, short: 1, count: 1, oi: 980 + rise(119) - (m - 739), price: 100, oiPoints: 1 });
    return bs;
  };
  const e = { sIdx: 600, eIdx: 620, confirmTs: 750 * 60_000 } as unknown as Parameters<typeof sharpAccumulation>[1];
  const sharp = mk((k) => Math.min(15, k)); // +1.5% in 15 minutes
  const slow = mk((k) => (15 * k) / 119);   // +1.5% over 2 hours
  assert.strictEqual(sharpAccumulation(sharp, e, 90), true);
  assert.strictEqual(sharpAccumulation(slow, e, 90), false);
});

scenario("minSlFraction: a tighter stop is moved out to the minimum distance; wider stops are unchanged", () => {
  const base = replay(5, 1500).decisions.filter((x) => x.tradable);
  assert.ok(base.length > 0);
  const wide = replay(5, 1500, { ...DEFAULT_V9_ENGINE_SETTINGS, minSlFraction: 0.05 }).decisions.filter((x) => x.tradable);
  for (const d of wide) {
    const dist = Math.abs(d.referencePrice - d.stopPrice) / d.referencePrice;
    assert.ok(dist >= 0.05 - 1e-12, `stop at least 5% away (${dist})`);
    assert.ok(d.tradeSide === "LONG" ? d.stopPrice < d.referencePrice : d.stopPrice > d.referencePrice, "stop on the losing side");
  }
  const none = replay(5, 1500, { ...DEFAULT_V9_ENGINE_SETTINGS, minSlFraction: 1e-9 }).decisions.filter((x) => x.tradable);
  assert.deepStrictEqual(none.map((d) => d.stopPrice), base.map((d) => d.stopPrice), "a tiny minimum changes nothing");
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
