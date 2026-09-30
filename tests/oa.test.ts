/**
 * OA (OI accumulation, 1h) -- engine rules, exits, hourly candles from minutes, live PAPER service, config.
 * Usage: npx tsx tests/oa.test.ts
 */
import * as assert from "assert";
import { hoursFromMinutes, oaExit, OA_DEFAULTS, runOa, type MinuteRow, type OaHour, type PathBar } from "../src/research/oi-accumulation";
import { OaPaperService, type OaTradeDoc } from "../src/strategy/oa/oa-paper.service";
import { parseOaSettings } from "../src/strategy/oa/oa-config";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const H = 3_600_000, M = 60_000, T0 = Date.UTC(2026, 8, 20, 0, 0);
type Spec = [number, number, number, number, number, number, number, number]; // o h l c oi0 oi1 liqL liqS

/** 30 calm hours, then a +4.5% rise with OI +2.5% (accumulation UP) */
function base(): Spec[] {
  const s: Spec[] = [];
  for (let i = 0; i < 30; i++) s.push([100, 100.1, 99.9, 100, 1000, 1000, 1000, 1000]);
  let p = 100, oi = 1000;
  for (let i = 0; i < 5; i++) { s.push([p, p + 0.95, p - 0.05, p + 0.9, oi, oi + 5, 1000, 1000]); p += 0.9; oi += 5; }
  s.push([104.5, 104.55, 104.3, 104.5, 1025, 1025, 1000, 1000]);                   // 35 flat
  return s;
}
const hoursOf = (s: Spec[]): OaHour[] => s.map(([o, h, l, c, a, b, ll, ls], i) => ({ openTime: T0 + i * H, open: o, high: h, low: l, close: c, oiOpen: a, oiHigh: Math.max(a, b), oiClose: b, oiChgPct: (100 * (b - a)) / a, liqLongUsd: ll, liqShortUsd: ls, complete: true }));
/** minute path: each hour = 60 flat-ish minutes ending at the close (used for exits) */
const pathOf = (s: Spec[], from = 0): PathBar[] => s.flatMap(([o, h, l, c], i) => i < from ? [] : Array.from({ length: 60 }, (_, m) => {
  const px = o + ((c - o) * (m + 1)) / 60;
  return { ts: T0 + i * H + m * M, high: m === 20 ? h : Math.max(px, o + ((c - o) * m) / 60), low: m === 40 ? l : Math.min(px, o + ((c - o) * m) / 60), close: px };
}));

// B LONG: after the rise, a red hour with OI -0.7% and big LONG liquidations (no new high), then a green confirmation
function scenarioB(confirmGreen = true): Spec[] {
  const s = base();
  s.push([104.5, 104.4, 103.0, 103.5, 1025, 1018, 50_000, 1000]);                 // 36 OI-drop hour (flush)
  s.push(confirmGreen ? [103.5, 104.3, 103.4, 104.2, 1018, 1019, 1000, 1000] : [103.5, 103.6, 103.1, 103.2, 1018, 1019, 1000, 1000]); // 37
  for (let i = 0; i < 4; i++) s.push([104.2 + i, 105.3 + i, 104.1 + i, 105.2 + i, 1019, 1019, 1000, 1000]); // 38.. rally
  return s;
}
// A SHORT: after the rise, a NEW HIGH hour with OI -0.7% and big SHORT liquidations, then a red confirmation
function scenarioA(): Spec[] {
  const s = base();
  s.push([104.5, 105.6, 104.4, 105.2, 1025, 1018, 1000, 60_000]);                 // 36 new high, shorts squeezed, OI down
  s.push([105.2, 105.3, 104.0, 104.3, 1018, 1015, 1000, 1000]);                   // 37 red, below 105.2
  for (let i = 0; i < 4; i++) s.push([104.3 - i, 104.4 - i, 103.2 - i, 103.3 - i, 1015, 1015, 1000, 1000]); // sell-off
  return s;
}

/** minute rows for the live service (hoursFromMinutes must give back the same hours) */
function minutesOf(s: Spec[]): MinuteRow[] {
  return s.flatMap(([o, h, l, c, a, b, ll, ls], i) => Array.from({ length: 60 }, (_, m) => {
    const p0 = o + ((c - o) * m) / 60, p1 = o + ((c - o) * (m + 1)) / 60;
    return { ts: T0 + i * H + m * M, open: p0, high: m === 20 ? h : Math.max(p0, p1), low: m === 40 ? l : Math.min(p0, p1), close: p1,
      oiFirst: a + ((b - a) * m) / 60, oiLast: a + ((b - a) * (m + 1)) / 60, oiMax: a + ((b - a) * (m + 1)) / 60, longLiqUsd: m === 30 ? ll : 0, shortLiqUsd: m === 30 ? ls : 0 };
  }));
}

function fakeDb() {
  const docs: OaTradeDoc[] = [];
  const match = (d: OaTradeDoc, q: Record<string, unknown>) => Object.entries(q).every(([k, v]) => (d as unknown as Record<string, unknown>)[k] === v);
  const col = {
    createIndex: async () => "",
    find: (q: Record<string, unknown>) => ({ toArray: async () => docs.filter((d) => match(d, q)).map((d) => ({ ...d })) }),
    countDocuments: async (q: Record<string, unknown>) => docs.filter((d) => match(d, q)).length,
    updateOne: async (q: Record<string, unknown>, u: { $setOnInsert?: OaTradeDoc; $set?: Partial<OaTradeDoc> }, o?: { upsert?: boolean }) => {
      const d = docs.find((x) => match(x, q));
      if (d && u.$set) Object.assign(d, u.$set);
      if (!d && o?.upsert && u.$setOnInsert) { docs.push({ ...u.$setOnInsert }); return { upsertedCount: 1 }; }
      return { upsertedCount: 0 };
    },
  };
  return { docs, getDb: async () => ({ collection: () => col }) as never };
}

async function run(): Promise<void> {
  console.log("OA (OI accumulation, 1h)");

  await scenario("B continuation: flush against the move + green confirmation -> LONG at the confirmation close, SL = confirmation low, TP 2.5R", () => {
    const s = scenarioB();
    const { trades } = runOa("XUSDT", hoursOf(s), pathOf(s));
    assert.strictEqual(trades.length, 1, JSON.stringify(trades));
    const t = trades[0];
    assert.strictEqual(t.side, "LONG"); assert.strictEqual(t.variant, "B");
    assert.strictEqual(t.oiDropHour, T0 + 36 * H); assert.strictEqual(t.entryTs, T0 + 38 * H); assert.strictEqual(t.entry, 104.2);
    assert.ok(Math.abs(t.slPrice - 103.4 * 0.9995) < 1e-9, `sl ${t.slPrice}`);
    assert.ok(Math.abs(t.tpPrice - (104.2 + 2.5 * (104.2 - 103.4 * 0.9995))) < 1e-9);
    assert.strictEqual(t.result, "TP");
    const risk = 104.2 - 103.4 * 0.9995;
    assert.ok(Math.abs(t.netR - (2.5 - ((0.05 + 0.02) / 100) * 104.2 / risk)) < 1e-9, "net R = 2.5 minus taker+maker fees in R");
  });

  await scenario("no trade when the next hour does not confirm", () => {
    const s = scenarioB(false);
    assert.strictEqual(runOa("XUSDT", hoursOf(s), pathOf(s)).trades.length, 0);
  });

  await scenario("A reversal is NOT traded live (variants B only)", () => {
    const s = scenarioA();
    assert.strictEqual(runOa("XUSDT", hoursOf(s), pathOf(s)).trades.length, 0);
  });

  await scenario("A reversal (research switch): new high + shorts liquidated + OI down, red confirmation -> SHORT, SL above the confirmation high", () => {
    const s = scenarioA();
    const { trades } = runOa("XUSDT", hoursOf(s), pathOf(s), { ...OA_DEFAULTS, variants: ["A", "B"] });
    assert.strictEqual(trades.length, 1, JSON.stringify(trades));
    const t = trades[0];
    assert.strictEqual(t.side, "SHORT"); assert.strictEqual(t.variant, "A"); assert.strictEqual(t.entry, 104.3);
    assert.ok(Math.abs(t.slPrice - 105.3 * 1.0005) < 1e-9, `sl ${t.slPrice}`);
    assert.strictEqual(t.result, "TP");
  });

  await scenario("no signal without OI accumulation first (same hours, OI flat during the rise)", () => {
    const s = scenarioB().map((x, i): Spec => (i >= 30 && i <= 35 ? [x[0], x[1], x[2], x[3], 1000, 1000, x[6], x[7]] : x));
    s[36] = [104.5, 104.4, 103.0, 103.5, 1000, 993, 50_000, 1000];
    assert.strictEqual(runOa("XUSDT", hoursOf(s), pathOf(s)).trades.length, 0);
  });

  await scenario("only data up to an hour is used: cutting the future never changes an earlier decision", () => {
    const s = scenarioB(), full = runOa("XUSDT", hoursOf(s), pathOf(s)).trades[0];
    const cut = s.slice(0, 38), part = runOa("XUSDT", hoursOf(cut), pathOf(cut)).trades[0];
    assert.strictEqual(part.entryTs, full.entryTs); assert.strictEqual(part.entry, full.entry); assert.strictEqual(part.slPrice, full.slPrice);
    assert.strictEqual(part.result, "OPEN");
  });

  await scenario("exit: SL wins a same-bar tie; 48h without SL/TP -> TIME exit at market", () => {
    const tie = oaExit("SHORT", 100, 101, 97.8, 0, [{ ts: 0, high: 101.5, low: 97, close: 99 }]);
    assert.strictEqual(tie!.result, "SL");
    const flat: PathBar[] = Array.from({ length: 49 }, (_, i) => ({ ts: i * H, high: 100.2, low: 99.8, close: 100.1 }));
    const x = oaExit("LONG", 100, 99, 102.2, 0, flat);
    assert.strictEqual(x!.result, "TIME"); assert.ok(Math.abs(x!.grossR - 0.1) < 1e-9);
    assert.strictEqual(oaExit("LONG", 100, 99, 102.2, 0, flat.slice(0, 10))!.result, "OPEN");
  });

  await scenario("hoursFromMinutes rebuilds the hour candles (OHLC, OI open/close, liquidations) and drops the running hour", () => {
    const s = scenarioB(), hrs = hoursFromMinutes(minutesOf(s), T0 + 37 * H + 30 * M);
    assert.strictEqual(hrs.length, 37);
    const h36 = hrs[36];
    assert.ok(Math.abs(h36.open - 104.5) < 1e-9 && h36.high === 104.5 && h36.low === 103.0 && Math.abs(h36.close - 103.5) < 1e-9, JSON.stringify(h36));
    assert.ok(Math.abs(h36.oiOpen - 1025) < 1e-9 && Math.abs(h36.oiClose - 1018) < 1e-9 && h36.liqLongUsd === 50_000 && h36.complete);
  });

  await scenario("live service: opens the SAME trade right after the confirmation hour closes, once, with an OA message", async () => {
    const s = scenarioB(), all = minutesOf(s), f = fakeDb(), sent: string[] = [];
    let now = T0 + 38 * H + 100_000;
    const svc = new OaPaperService({ enabled: true, users: ["main"], symbols: ["XUSDT"], rr: 2.5 },
      () => [{ userId: "main", riskUsd: 10, telegram: { sendMessage: async (m: string) => { sent.push(m); } } }],
      async (_s, from) => all.filter((r) => r.ts >= from && r.ts < now - 20_000), f.getDb, () => now);
    await svc.onMinute();
    assert.strictEqual(f.docs.length, 1);
    const d = f.docs[0];
    assert.strictEqual(d.state, "OPEN"); assert.strictEqual(d.side, "LONG"); assert.strictEqual(d.variant, "B"); assert.ok(Math.abs(d.entry - 104.2) < 1e-9);
    assert.ok(sent[0].includes("OA XUSDT") && sent[0].includes("PAPER") && sent[0].includes("Բ"));
    await svc.onMinute();
    assert.strictEqual(f.docs.length, 1); assert.strictEqual(sent.length, 1);
    // later: TP reached -> closed with a message
    now = T0 + 42 * H + 100_000;
    await svc.onMinute();
    assert.strictEqual(f.docs[0].state, "CLOSED"); assert.strictEqual(f.docs[0].result, "TP");
    assert.ok(sent.some((m) => m.includes("TAKE PROFIT")));
  });

  await scenario("live service: never replays an old signal (started 40 min after the hour)", async () => {
    const s = scenarioB(), all = minutesOf(s), f = fakeDb();
    const now = T0 + 38 * H + 40 * M;
    const svc = new OaPaperService({ enabled: true, users: ["main"], symbols: ["XUSDT"], rr: 2.5 }, () => [], async (_s, from) => all.filter((r) => r.ts >= from && r.ts < now), f.getDb, () => now);
    await svc.onMinute();
    assert.strictEqual(f.docs.length, 0);
  });

  await scenario("config: absent = off; unknown user fails; there is no REAL switch at all", () => {
    assert.strictEqual(parseOaSettings(undefined, ["main"], ["BTCUSDT"]).enabled, false);
    assert.throws(() => parseOaSettings({ enabled: true, users: ["bob"] }, ["main"], ["BTCUSDT"]));
    const s = parseOaSettings({ enabled: true, users: ["main"], mode: "REAL" }, ["main"], ["BTCUSDT"]);
    assert.ok(!("mode" in s) && s.users[0] === "main" && s.symbols[0] === "BTCUSDT" && s.rr === 2.5);
    assert.strictEqual(parseOaSettings({ enabled: true, users: ["main"], rr: 3 }, ["main"], ["BTCUSDT"]).rr, 3);
    assert.throws(() => parseOaSettings({ enabled: true, users: ["main"], rr: 0.5 }, ["main"], ["BTCUSDT"]));
  });

  assert.ok(OA_DEFAULTS.rr === 2.5 && OA_DEFAULTS.minSlPct === 0.3 && OA_DEFAULTS.variants.join() === "B");
  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
