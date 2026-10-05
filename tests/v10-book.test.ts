/**
 * V10 order book snapshot (recorded only) -- bands, the "grew" verdict, the Armenian lines.
 * Usage: npx tsx tests/v10-book.test.ts
 */
import * as assert from "assert";
import { bookBands, bookView, bookWalls, formatBookLines, formatWallLines, supportPct, type BookBands } from "../src/strategy/v10/v10-book";
import { roomLine } from "../src/strategy/v10/v10-telegram";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const M = 60_000, W = 15 * M, T = Date.UTC(2026, 9, 4, 12, 0);
const snap = (bid1: number, ask1: number): BookBands => ({ mid: 100, bid1, ask1, bid2: bid1, ask2: ask1, covered1: true, covered2: true });

scenario("bands: $ within 1% / 2% of the mid, each side; covered when the levels reach that far", () => {
  // mid 100: bids 99.9 (x10), 99.5 (x10), 98.5 (x10), 97 (x10); asks 100.1 (x10), 100.9 (x10), 101.5 (x10)
  const b = bookBands([[99.9, 10], [99.5, 10], [98.5, 10], [97, 10]], [[100.1, 10], [100.9, 10], [101.5, 10]])!;
  assert.strictEqual(b.mid, 100);
  assert.strictEqual(+b.bid1.toFixed(2), 999 + 995);
  assert.strictEqual(+b.ask1.toFixed(2), 1001 + 1009);
  assert.strictEqual(+b.bid2.toFixed(2), 999 + 995 + 985);
  assert.deepStrictEqual([b.covered1, b.covered2], [true, false]);   // asks stop at 101.5 < 102
  assert.strictEqual(bookBands([], [[1, 1]]), null);
});
scenario("support = bids for a SHORT, asks for a LONG", () => {
  assert.strictEqual(supportPct(snap(60, 40), "SHORT"), 60);
  assert.strictEqual(supportPct(snap(60, 40), "LONG"), 40);
});
scenario("SHORT: bids' share grew from the top to the entry -> ⚠️ with the change; not grown -> ✅", () => {
  const up = bookView("SHORT", T - 2 * W, T, snap(50, 50), snap(59, 41));
  assert.deepStrictEqual([up.grew, Math.round(up.supportTopPct!), Math.round(up.supportNowPct!)], [true, 50, 59]);
  const l = formatBookLines(up, "SHORT").join("\n");
  assert.ok(l.includes("📚 Լիմիտ օրդերներ (գնից ±1%)") && l.includes("Գագաթին (11:30)՝ ներքևում գնորդ 50% · վերևում վաճառող 50%") && l.includes("Հիմա (12:00)՝ ներքևում գնորդ 59%"), l);
  assert.ok(l.includes("⚠️ Գագաթից հետո ներքևում գնորդներն ավելացան (50% → 59%)") && l.includes("Թեստում այսպիսիները հաճախ SL են եղել"), l);
  const down = formatBookLines(bookView("SHORT", T - 2 * W, T, snap(55, 45), snap(52, 48)), "SHORT").join("\n");
  assert.ok(down.includes("✅ Գագաթից հետո ներքևում գնորդները չավելացան → գինը պաշտպանող չկա") && !down.includes("⚠️"), down);
  if (process.env.SHOW) console.log(`${l}\n\n${down}`);
});
scenario("LONG mirrored: the asks above are the support side", () => {
  const v = bookView("LONG", T - W, T, snap(55, 45), snap(45, 55));
  assert.strictEqual(v.grew, true);
  const l = formatBookLines(v, "LONG").join("\n");
  assert.ok(l.includes("Հատակին (11:45)՝ վերևում վաճառող 45%") && l.includes("⚠️ Հատակից հետո վերևում վաճառողներն ավելացան (45% → 55%)"), l);
});
scenario("no top snapshot / the top is the entry candle / nothing at all -> said plainly, no verdict", () => {
  const a = formatBookLines(bookView("SHORT", T - W, T, null, snap(50, 50)), "SHORT").join("\n");
  assert.ok(a.includes("տվյալ չկա (բոտը այդ պահին չէր գրանցում)") && !a.includes("⚠️") && !a.includes("✅"), a);
  const b = formatBookLines(bookView("SHORT", T, T, snap(50, 50), snap(50, 50)), "SHORT").join("\n");
  assert.ok(b.includes("գագաթը հենց այս մոմն է") && !b.includes("⚠️") && !b.includes("✅"), b);
  assert.deepStrictEqual(formatBookLines(null, "SHORT"), ["📚 Լիմիտ օրդերներ (գնից ±1%)՝ տվյալ չկա"]);
});
scenario("shares that round to the same integer are shown with one decimal", () => {
  const l = formatBookLines(bookView("SHORT", T - W, T, snap(5020, 4980), snap(5040, 4960)), "SHORT").join("\n");
  assert.ok(l.includes("50.2% → 50.4%"), l);
});

scenario("walls: 0.1% slices summed (a wall spread over ticks counts as one), the biggest first, only within 3%", () => {
  // mid 100. bids: 99.95 x1, 99.42 + 99.45 (same slice 0.5-0.6%) x30 each, 98.0 x40, 96.5 x500 (beyond 3% -> ignored)
  const w = bookWalls([[99.95, 1], [99.45, 30], [99.42, 30], [98.0, 40], [96.5, 500]], [[100.05, 1], [100.8, 50], [102.9, 5]])!;
  assert.strictEqual(w.bids.length, 3);
  assert.ok(w.bids[0].price > 99.4 && w.bids[0].price < 99.46 && Math.round(w.bids[0].usd) === Math.round(99.45 * 30 + 99.42 * 30), JSON.stringify(w.bids));
  assert.strictEqual(w.bids[1].price, 98.0);
  assert.ok(!w.bids.some((b) => b.price < 97), "beyond 3% is not counted");
  assert.strictEqual(w.asks[0].price, 100.8);
  assert.ok(Math.abs(w.reachBidPct - 3.5) < 1e-9 && Math.abs(w.reachAskPct - 2.9) < 1e-9);
});
scenario("wall lines: the biggest buyer / seller with x the 15m volume; the biggest support wall on the way to the TP", () => {
  const walls = bookWalls([[99.95, 1], [99.45, 30], [99.42, 30], [98.0, 40]], [[100.05, 1], [100.8, 50]])!;
  const v = bookView("SHORT", T - W, T, snap(50, 50), { ...snap(50, 50), walls }, 2000);
  const l = formatWallLines(v, { side: "SHORT", entry: 100, tp: 98 }).join("\n");
  assert.ok(l.includes("Ներքևում ամենամեծ գնորդ՝ $6k") && l.includes("15ր առևտրի 3.0×"), l);
  assert.ok(l.includes("TP-ի ճանապարհին ամենամեծ գնորդը՝ $6k"), l);
  const none = formatWallLines(v, { side: "SHORT", entry: 100, tp: 99.97 }).join("\n");
  assert.ok(none.includes("TP-ի ճանապարհին գնորդների մեծ պատ չկա"), none);
  assert.deepStrictEqual(formatWallLines(bookView("SHORT", T - W, T, null, snap(50, 50)), { side: "SHORT", entry: 100, tp: 98 }), []);
  if (process.env.SHOW) console.log(l);
});
scenario("room: the TP beyond the move's start -> ⚠️ (ADA 10-04 20:15: +4.17% to the top, entry 2.17% off it)", () => {
  const start = 0.24, top = start * 1.0417, entry = top * (1 - 0.0217);
  const l = roomLine({ extreme: top, movePct: 4.17 }, "SHORT", entry, entry * 0.98).join("");
  assert.ok(l.includes("սկզբից մինչև մուտք +1.91%") && l.includes("շարժման 54%-ն արդեն հետ է եկել ⚠️") && l.includes("⚠️ TP-ն շարժման սկզբից էլ անդին է"), l);
  const ok = roomLine({ extreme: start * 1.06, movePct: 6 }, "SHORT", start * 1.05, start * 1.05 * 0.98).join("");
  assert.ok(ok.includes("TP-ն շարժման մեջ է ✅"), ok);
  const lg = roomLine({ extreme: 90, movePct: -10 }, "LONG", 92, 92 * 1.02).join("");
  assert.ok(lg.includes("սկզբից մինչև մուտք -8.00%") && lg.includes("✅"), lg);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
