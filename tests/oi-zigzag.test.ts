/**
 * OI zigzag: waves cut only by moves > R, noise ignored, cleaning labelled,
 * cleaning -> accumulation -> resolution numbers in coins.
 * Usage: npx tsx tests/oi-zigzag.test.ts
 */
import * as assert from "assert";
import { atr15Before, buildChains, buildWaves, DEFAULT_CHAIN_PARAMS, oiPivots, quality, trailingOiNoise, type ZBar } from "../src/research/oi-zigzag";

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
const P = { ...DEFAULT_CHAIN_PARAMS, noise15Pct: 0.1, slMode: "PCT" as const, maxConfirmDelayMin: 60 };

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
  const [c] = buildChains(buildWaves(bars, R), bars, P);
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

scenario("late entry: direction = move already made when the OI top became known; remaining = expected - that", () => {
  const [c] = buildChains(buildWaves(bars, R), bars, P);
  const t = c.trade!;
  assert.strictEqual((t.decidedTs - T0) / M, 70, "OI fell R from its minute-60 top at minute 70");
  assert.ok(Math.abs(t.alreadyMoved - -(50 * 10) / 30) < 1e-6, "price 2680 -> 2663.3 by then");
  assert.ok(Math.abs(t.remaining - (37.5 - 50 / 3)) < 1e-6);
  assert.strictEqual(t.side, "SHORT");
  assert.strictEqual(t.result, "TP");
  assert.ok(Math.abs(t.netR! - (0.7 / 0.3 - 0.07 / 0.3)) < 1e-9, "RR 2.33 minus fees");
});

scenario("late entry skipped when what remains is smaller than the TP distance", () => {
  const [c] = buildChains(buildWaves(bars, R), bars, { ...P, tpPct: 1.0 });
  assert.strictEqual(c.trade!.skipReason, "remaining < TP");
  assert.strictEqual(c.trade!.result, null);
});

scenario("quality: fast, forced, big-push cleaning = grade A; same wave slow and unforced = C", () => {
  // 4h of calm before (ATR ~ 2), then the flush
  const calm: ZBar[] = Array.from({ length: 240 }, (_, m) => ({ ts: T0 - (240 - m) * M, close: 2700 + (m % 2), high: 2701, low: 2699, oi: 100_000, longLiq: 0, shortLiq: 0 }));
  const all = [...calm, ...bars];
  assert.ok(Math.abs(atr15Before(all, 240) - 2) < 0.5, `ATR ${atr15Before(all, 240)}`);
  const w = buildWaves(all, R).find((x) => x.kind === "LONG_CLEANING")!;
  const strong = quality(all, w, 50, 0.1);
  assert.strictEqual(strong.grade, "A", JSON.stringify(strong));
  const weak = quality(all, { ...w, longLiqUsd: 1_000 }, 50, 0.1); // not forced
  assert.ok(Math.abs(strong.speed - (0.8 * 2) / 12 / (0.1 / 15)) < 1.5, `speed over the active part ${strong.speed}`);
  assert.strictEqual(weak.grade, "C");
});

scenario("NO LOOK-AHEAD: the trade decision is identical when the data is cut right after the decision minute", () => {
  const full = buildChains(buildWaves(bars, R), bars, P)[0].trade!;
  const cutAt = (full.decidedTs - T0) / M + 1;
  const cut = bars.slice(0, cutAt);
  const t = buildChains(buildWaves(cut, R), cut, P)[0].trade!;
  assert.deepStrictEqual([t.decidedTs, t.entry, t.side, t.alreadyMoved, t.remaining], [full.decidedTs, full.entry, full.side, full.alreadyMoved, full.remaining]);
});

scenario("NO LOOK-AHEAD: the coin's normal OI move at a minute ignores everything after it", () => {
  const long: ZBar[] = Array.from({ length: 900 }, (_, m) => ({ ts: T0 + m * M, close: 100, high: 100, low: 100, oi: 1000 + (m % 7), longLiq: 0, shortLiq: 0 }));
  const a = trailingOiNoise(long);
  const wild = long.map((b, m) => (m > 600 ? { ...b, oi: b.oi * (1 + (m % 2) * 0.05) } : b));
  const b = trailingOiNoise(wild);
  assert.deepStrictEqual(a.slice(0, 601), b.slice(0, 601));
  assert.ok(Number.isNaN(a[100]) && a[300] > 0, "no value before 4h of history");
});

scenario("STRUCTURE exits: SL beyond the last extreme since the OI top (+ ATR buffer), TP = 2.2R", () => {
  const [c] = buildChains(buildWaves(bars, R), bars, { ...P, slMode: "STRUCTURE", atrBuffer: 0, minSlPct: 0.05, rr: 2.2 });
  const t = c.trade!;
  // SELL: highest high between the OI top (minute 60, price 2680) and the decision is 2680
  assert.ok(Math.abs(t.slPrice! - 2680) < 1e-9, `SL ${t.slPrice}`);
  const risk = t.slPrice! - t.entry;
  assert.ok(Math.abs(t.entry - t.tpPrice! - 2.2 * risk) < 1e-9);
});

scenario("STRUCTURE exits: SL never closer than the minimum (fees)", () => {
  const [c] = buildChains(buildWaves(bars, R), bars, { ...P, slMode: "STRUCTURE", atrBuffer: 0, minSlPct: 1.0, rr: 0.5 });
  assert.ok(Math.abs(c.trade!.slPrice! - c.trade!.entry * 1.01) < 1e-6);
});

scenario("skip when the OI top became known too late", () => {
  const [c] = buildChains(buildWaves(bars, R), bars, { ...P, maxConfirmDelayMin: 5 });
  assert.ok(c.trade!.skipReason!.includes("late"));
});

scenario("expected move is capped at the cleaning's own move", () => {
  const [c] = buildChains(buildWaves(bars, R), bars, P);
  assert.ok(c.expectedMove! <= c.cleaningMove);
});

scenario("TARGET exits (default): TP = remaining expected move, SL = TP / 2.2", () => {
  const [c] = buildChains(buildWaves(bars, R), bars, { ...P, slMode: "TARGET", rr: 2.2, minSlPct: 0.1 });
  const t = c.trade!;
  assert.ok(Math.abs(t.entry - t.tpPrice! - t.remaining) < 1e-9, "SELL: TP is `remaining` below the entry");
  assert.ok(Math.abs(t.slPrice! - t.entry - t.remaining / 2.2) < 1e-9);
  assert.strictEqual(t.skipReason, null, "TP == remaining must never be skipped as 'remaining < TP' (float rounding)");
  assert.ok(t.result === "TP" || t.result === "SL" || t.result === "OPEN");
});

scenario("TARGET exits: real-world prices (float rounding) are not skipped", () => {
  // ETH 09-23: entry 2669.7, remaining 29.63 -> TP 2640.07
  for (const [entry, rem] of [[2669.7, 29.63], [114.81, 1.4001], [0.23985, 0.00935], [85667.4, 308.4]]) {
    const tp = entry - rem;
    assert.ok(!(rem < Math.abs(tp - entry) - entry * 1e-9), `${entry} / ${rem}`);
  }
});

scenario("TARGET exits: skipped when SL would be tighter than the fee minimum", () => {
  const [c] = buildChains(buildWaves(bars, R), bars, { ...P, slMode: "TARGET", rr: 2.2, minSlPct: 0.5 });
  assert.ok(c.trade!.skipReason!.includes("fees"));
});

scenario("TARGET exits (default): TP = remaining expected move, SL = TP / 2.2", () => {
  const [c] = buildChains(buildWaves(bars, R), bars, { ...P, slMode: "TARGET", rr: 2.2, minSlPct: 0.1 });
  const t = c.trade!;
  assert.ok(Math.abs(t.entry - t.tpPrice! - t.remaining) < 1e-9, "SELL: TP is `remaining` below the entry");
  assert.ok(Math.abs(t.slPrice! - t.entry - t.remaining / 2.2) < 1e-9);
  assert.strictEqual(t.skipReason, null, "TP == remaining must never be skipped as 'remaining < TP' (float rounding)");
  assert.ok(t.result === "TP" || t.result === "SL" || t.result === "OPEN");
});

scenario("TARGET exits: real-world prices (float rounding) are not skipped", () => {
  // ETH 09-23: entry 2669.7, remaining 29.63 -> TP 2640.07
  for (const [entry, rem] of [[2669.7, 29.63], [114.81, 1.4001], [0.23985, 0.00935], [85667.4, 308.4]]) {
    const tp = entry - rem;
    assert.ok(!(rem < Math.abs(tp - entry) - entry * 1e-9), `${entry} / ${rem}`);
  }
});

scenario("TARGET exits: skipped when SL would be tighter than the fee minimum", () => {
  const [c] = buildChains(buildWaves(bars, R), bars, { ...P, slMode: "TARGET", rr: 2.2, minSlPct: 0.5 });
  assert.ok(c.trade!.skipReason!.includes("fees"));
});

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
