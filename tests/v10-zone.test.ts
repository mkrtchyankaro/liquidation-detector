/**
 * V10 4h zone at the signal (recorded only) + the ALT LONG "flush" message. Usage: npx tsx tests/v10-zone.test.ts
 */
import * as assert from "assert";
import { formatZoneLine, zoneViewOf, V10ZoneFinder } from "../src/strategy/v10/v10-zone";
import { formatV10Entry } from "../src/strategy/v10/v10-telegram";
import type { ZCandle } from "../src/research/zones";
import type { V10SignalDoc, V10TradeDoc } from "../src/strategy/v10/v10-repository";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const H4 = 4 * 3_600_000;
const path = (closes: number[]): ZCandle[] => closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { t: i * H4, open: o, high: Math.max(o, c) + 0.2, low: Math.min(o, c) - 0.2, close: c }; });
const go = (from: number, to: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);
// resistance at ~110 hit 3 times, broken, retested twice from above (a real flip), then up
const C = path([...Array.from({ length: 16 }, (_, i) => 100 + (i % 2)),
  ...go(100, 110, 5), ...go(110, 102, 4), ...go(102, 110.3, 4), ...go(110.3, 101, 4), ...go(101, 109.8, 4), ...go(109.8, 103, 4),
  ...go(103, 120, 6), ...go(120, 110.2, 5), ...go(110.2, 119, 5), ...go(119, 110.4, 5), ...go(110.4, 122, 6)]);
const END = C.length * H4;

async function run(): Promise<void> {
  await scenario("the zone at a signal: a real FLIP (2+ from below and 2+ from above), the entry's distance in ATR", () => {
    const v = zoneViewOf(C, END, 122)!;
    assert.ok(v && v.lo <= 110.3 && v.hi >= 109.8, JSON.stringify(v));
    assert.deepStrictEqual([v.res, v.sup, v.flip], [3, 2, true]);
    assert.ok(v.distAtr > 0);
    const l = formatZoneLine(v);
    assert.ok(l.startsWith("🧱 4h զոնա ") && l.includes("FLIP ✅ (3 ներքևից / 2 վերևից)") && l.includes("ATR վերև"), l);
  });
  await scenario("no look-ahead: before the retests the same zone is not a flip yet", () => {
    const early = C.findIndex((x) => x.close >= 119.9);     // just after the break, before any retest
    const v = zoneViewOf(C, C[early].t + H4, C[early].close);
    assert.ok(!v || !v.flip, JSON.stringify(v));
  });
  await scenario("no zone / not a flip -> said plainly", () => {
    assert.strictEqual(formatZoneLine(null), "🧱 4h զոնա՝ չկա (3+ դիպչումով զոնա չգտնվեց)");
    assert.ok(formatZoneLine({ lo: 1, hi: 1.1, res: 1, sup: 3, flip: false, distAtr: 0 }).includes("FLIP չէ ⚠️ (1 ներքևից / 3 վերևից) · գինը զոնայի մեջ"));
  });
  await scenario("the finder fetches once per 4h candle per symbol", async () => {
    let calls = 0;
    const f = new V10ZoneFinder(async () => { calls++; return C; });
    await f.at("XUSDT", END, 122); await f.at("XUSDT", END + 60_000, 122); await f.at("YUSDT", END, 122);
    assert.strictEqual(calls, 2);
    await f.at("XUSDT", END + H4, 122);
    assert.strictEqual(calls, 3);
  });
  await scenario("ALT LONG 'flush' message: the fall with OI down (RANK 1), the candle with OI up off the low; the zone line", () => {
    const W = 15 * 60_000, t0 = Date.UTC(2026, 9, 4, 10, 0);
    const turn = { candleEnd: t0, side: "LONG", price: 0.4800, candleOiPct: 1.2, label: "", moveStartT: t0 - 12 * W, peakT: t0 - 3 * W, moveOiPct: -7.2,
      extreme: 0.4718, extremeT: t0 - 3 * W, movePct: -7.7, fromPeakOiPct: 1.2, prior: 8, entry: "flush" } as V10SignalDoc["turn"];
    const sig = { signalId: "x", kind: "OWN", side: "LONG", symbol: "ONDOUSDT", turn, own: { how: "OWN", follow: 0.1, coinPct: -7.7, btcPct: -0.5, r2Minutes: 1 }, picks: [], rankWindowHours: 12, createdAt: new Date(t0) } as unknown as V10SignalDoc;
    const t = { tradeId: "x", orderSignalId: "x", signalId: "x", kind: "OWN", userId: "main", mode: "PAPER", symbol: "ONDOUSDT", side: "LONG", pick: { rank: 1, x: 1, follow: 0.1, coinPct: -7.7, btcPct: -0.5 },
      state: "OPEN", createdAt: t0, entryPrice: 0.48, slPrice: 0.4752, tpPrice: 0.4896, slPct: 1, tpPct: 2, quantity: 2083, plannedRiskUsd: 10, actualRiskUsd: 10, binance: null,
      closedAt: null, exitPrice: null, pnlUsd: null, pnlR: null, feesUsd: null, closeReason: null, failureReason: null, closeAttempts: 0, entryInProgress: false, entryStartedAt: null,
      zone4h: { lo: 0.3994, hi: 0.4215, res: 7, sup: 2, flip: true, distAtr: 3.2 } } as V10TradeDoc;
    const m = formatV10Entry(sig, t);
    assert.ok(m.startsWith("🔺 ONDO · LONG · PAPER · 10:00 UTC · V10"), m);
    assert.ok(m.includes("📏 իջել է 7.70%") && m.includes("Գին ⬇️7.70%, OI ⬇️7.20%") && m.includes("մոմ · OI ⬆️1.20% (նոր դիրքեր)") && m.includes("3️⃣ փակվեց հատակից ⬆️1.74% (≥ 1 ATR)"), m);
    assert.ok(m.includes("🧱 4h զոնա\n0.39940 – 0.42150 · FLIP ✅") || m.includes("🧱 4h զոնա\n0.3994 – 0.4215 · FLIP ✅"), m);
    // the zone in the TP's way: a warning only when it is a FLIP built over >= 10 days
    const withZones = (strong: boolean): string => formatV10Entry(sig, { ...t, zone4h: { ...t.zone4h!, zones: [{ lo: 0.485, hi: 0.488, strong }] } } as V10TradeDoc);
    assert.ok(withZones(true).includes("⚠️ TP-ի ճանապարհին FLIP զոնա՝"), withZones(true));
    assert.ok(withZones(false).includes("TP-ի ճանապարհին զոնա՝") && withZones(false).includes("(FLIP չէ)") && !withZones(false).includes("⚠️ TP-ի"), withZones(false));
    assert.ok(formatV10Entry(sig, { ...t, zone4h: { ...t.zone4h!, zones: [] } } as V10TradeDoc).includes("TP-ի ճանապարհին զոնա չկա ✅"));
    if (process.env.SHOW) console.log(m);
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
void run();
