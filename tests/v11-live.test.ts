/**
 * V11 LIVE (Oct 12 2026): the whole flow with a fake data source, a fake store and a fake Binance --
 * signal timing, per-user filters, PAPER entry / TP / SL / time-out, REAL entry with SL / TP orders and its settle,
 * the guards (another strategy's REAL trade, the price already beyond the SL), restart safety, the V10 / V11 lock.
 * Usage: npx tsx tests/v11-live.test.ts
 */
import * as assert from "assert";
import type { MinBar } from "../src/strategy/lib/dc15";
import { parseV11Settings } from "../src/strategy/v11/v11-config";
import type { V11Source } from "../src/strategy/v11/v11-data";
import { H, type V11Bar } from "../src/strategy/v11/v11-engine";
import { V11LiveService, type V11UserRef } from "../src/strategy/v11/v11-live.service";
import type { V11SignalDoc, V11Store, V11TradeDoc } from "../src/strategy/v11/v11-repository";
import { withSymbolLock } from "../src/execution/other-trades";
import { fakeBinance } from "./helpers/fake-binance";
import { scene, T0 } from "./helpers/v11-scene";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`); }
}
const M = 60_000;
const SYM = "AAAUSDT";
/** the confirmation hour (93) closes here = the entry hour's open */
const E = T0 + 94 * H;

function source(B: V11Bar[], clock: () => number): V11Source & { calls: number } {
  const src = {
    calls: 0,
    bars: async (_s: string, fromT: number, toT: number) => {
      src.calls++;
      const out: Array<V11Bar | null> = [];
      for (let t = fromT; t < toT; t += H) out.push(B.find((b) => b.t === t && b.t + H <= clock()) ?? null);
      return out;
    },
    hourOpen: async (_s: string, t: number) => B.find((b) => b.t === t)?.o ?? null,
  };
  return src;
}
function fakeStore(): V11Store & { signals: V11SignalDoc[]; trades: V11TradeDoc[]; otherOpen: boolean } {
  const signals: V11SignalDoc[] = [], trades: V11TradeDoc[] = [];
  const s = {
    signals, trades, otherOpen: false,
    ensureIndexes: async () => undefined,
    insertSignal: async (d: V11SignalDoc) => { if (signals.some((x) => x.signalId === d.signalId)) return false; signals.push({ ...d }); return true; },
    insertTrade: async (d: V11TradeDoc) => { if (trades.some((x) => x.tradeId === d.tradeId)) return false; trades.push({ ...d }); return true; },
    updateTrade: async (id: string, f: Partial<V11TradeDoc>) => { const t = trades.find((x) => x.tradeId === id); if (t) Object.assign(t, f); },
    findOpenTrades: async () => trades.filter((t) => t.state === "OPEN").map((t) => ({ ...t })),
    hasOpenOtherTrade: async () => s.otherOpen,
    openOtherTradeSince: async () => null,
  };
  return s;
}
const tg = () => { const msgs: string[] = []; return { msgs, sendMessage: async (t: string) => { msgs.push(t); } }; };
const settings = (o: Record<string, unknown> = {}) => parseV11Settings({ enabled: true, userModes: { main: "PAPER" }, ...o }, ["main", "karo"], [SYM]);
/** minute bars from the entry on, all at `price` unless given */
const minutes = (from: number, n: number, f: (i: number) => Partial<MinBar> = () => ({}), price = 106): MinBar[] =>
  Array.from({ length: n }, (_, i) => ({ t: from + i * M, high: price, low: price, close: price, oiFirst: 1, oiLast: 1, longLiq: 0, shortLiq: 0, ...f(i) }));

async function run(): Promise<void> {
  console.log("V11 live");
  const B = scene();
  const price = B[94].o, SL = 107.5, TP2 = price - 2 * (SL - price);

  await scenario("PAPER: the signal at 94:01:45 -> one trade at the hour's open, SL = the wick's high, TP = 2R; the message tells the story", async () => {
    let now = E + 105_000;
    const store = fakeStore(), t = tg();
    const svc = new V11LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t }], source(B, () => now), async () => [], store, () => now);
    await svc.onMinute();
    assert.strictEqual(store.signals.length, 1);
    assert.strictEqual(store.signals[0].signalId, "v11-2026-10-04T22:00-AAA-SHORT");
    assert.strictEqual(store.trades.length, 1);
    const tr = store.trades[0];
    assert.deepStrictEqual([tr.state, tr.mode, tr.side, tr.entryPrice, tr.slPrice, tr.createdAt], ["OPEN", "PAPER", "SHORT", price, SL, E]);
    assert.ok(Math.abs(tr.tpPrice! - TP2) < 1e-9);
    assert.ok(Math.abs(tr.quantity! * (SL - price) - 10) < 1e-9, "$10 at the SL");
    assert.strictEqual(tr.timeoutAt, E + 48 * H);
    assert.strictEqual(tr.rallyType, "T1");
    const m = t.msgs[0];
    for (const s of ["🔻 AAA · SHORT · PAPER · V11", "📅 04.10.2026 22:00 UTC", "Entry", "TP", "SL    107.500", "RR 2.00", "Ռալի", "OI ⬇️", "T1 squeeze", "Wick", "շորթ լիկվիդացիա $200.0K", "նշանակալի", "Հաստատում", "մուտք 22:00", "✋ Ձեռքով՝ SL 107.500", "Wick՝ 04.10 20:00–21:00 մոմ", "մինչև wick-ի գագաթ ⬆️", "🆔 v11-2026-10-04T22:00-AAA-SHORT"])
      assert.ok(m.includes(s), `missing "${s}" in:\n${m}`);
    // the next minute and a restart: nothing new
    now += M;
    await svc.onMinute();
    const again = new V11LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t }], source(B, () => now), async () => [], store, () => now);
    await again.onMinute();
    assert.strictEqual(store.trades.length, 1);
    assert.strictEqual(t.msgs.length, 1);
  });

  await scenario("timing: nothing before 90 s after the hour, nothing after 15 min (stale)", async () => {
    for (const now of [E + 30_000, E + 16 * M]) {
      const store = fakeStore();
      const svc = new V11LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], source(B, () => now), async () => [], store, () => now);
      await svc.onMinute();
      assert.strictEqual(store.signals.length, 0, new Date(now).toISOString());
    }
  });

  await scenario("data not there yet (the last hour missing) -> retried next minute, then decided", async () => {
    let now = E + 105_000, hide = true;
    const store = fakeStore(), src = source(B, () => now);
    const real = src.bars;
    src.bars = async (s, f, t) => { const out = await real(s, f, t); if (hide) out[out.length - 1] = null; return out; };
    const svc = new V11LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], src, async () => [], store, () => now);
    await svc.onMinute();
    assert.strictEqual(store.signals.length, 0);
    hide = false; now += M;
    await svc.onMinute();
    assert.strictEqual(store.signals.length, 1);
  });

  await scenario("per user: karo only T2 rallies -> SKIPPED (silent); karo OFF / LONG-only -> nothing; riskUsd per user", async () => {
    const now = E + 105_000, store = fakeStore(), tm = tg(), tk = tg();
    const s = settings({ userModes: { main: "PAPER", karo: "PAPER" }, perUser: { karo: { rallyTypes: ["T2"] }, main: { riskUsd: 3 } } });
    const svc = new V11LiveService(s, () => [
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: tm },
      { userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: tk },
    ], source(B, () => now), async () => [], store, () => now);
    await svc.onMinute();
    const main = store.trades.find((x) => x.userId === "main")!, karo = store.trades.find((x) => x.userId === "karo")!;
    assert.strictEqual(main.state, "OPEN");
    assert.ok(Math.abs(main.quantity! * (SL - price) - 3) < 1e-9, "main risks $3 (perUser.riskUsd)");
    assert.strictEqual(karo.state, "SKIPPED");
    assert.ok(/rallyTypes/.test(karo.failureReason!));
    assert.strictEqual(tk.msgs.length, 0);
    const s2 = settings({ userModes: { main: "PAPER" }, short: false, long: true });
    const store2 = fakeStore();
    await new V11LiveService(s2, () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], source(B, () => now), async () => [], store2, () => now).onMinute();
    assert.strictEqual(store2.signals.length, 0, "a LONG-only setup sees no SHORT signal");
  });

  await scenario("maxRiskPct / minRiskPct / meaningfulOnly / slBufferPct per user", async () => {
    const now = E + 105_000, store = fakeStore();
    const risk = (100 * (SL - price)) / price;
    const s = settings({ userModes: { main: "PAPER", karo: "PAPER" }, perUser: { main: { maxRiskPct: risk / 2 }, karo: { slBufferPct: 0.1, tpR: 2.5 } } });
    await new V11LiveService(s, () => [
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null },
      { userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null },
    ], source(B, () => now), async () => [], store, () => now).onMinute();
    const main = store.trades.find((x) => x.userId === "main")!, karo = store.trades.find((x) => x.userId === "karo")!;
    assert.strictEqual(main.state, "SKIPPED");
    assert.ok(/maxRiskPct/.test(main.failureReason!));
    assert.ok(Math.abs(karo.slPrice! - SL * 1.001) < 1e-9);
    assert.ok(Math.abs(karo.tpPrice! - (price - 2.5 * (SL * 1.001 - price))) < 1e-9);
  });

  await scenario("PAPER exits on our minute bars: TP -> +2R minus fees; SL -> -1R minus fees; a same-minute tie = SL", async () => {
    for (const [name, mins, reason, r] of [
      ["TP", minutes(E, 30, (i) => (i === 20 ? { low: TP2 - 0.01 } : {})), "TP_FILLED", 2],
      ["SL", minutes(E, 30, (i) => (i === 5 ? { high: SL } : {})), "SL_FILLED", -1],
      ["tie", minutes(E, 30, (i) => (i === 5 ? { high: SL, low: TP2 - 1 } : {})), "SL_FILLED", -1],
    ] as const) {
      let now = E + 105_000;
      const store = fakeStore(), t = tg();
      const svc = new V11LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t }], source(B, () => now), async (_s, f, to) => mins.filter((b) => b.t >= f && b.t < to), store, () => now);
      await svc.onMinute();
      now = E + 40 * M;
      await svc.onMinute();
      const tr = store.trades[0];
      assert.strictEqual(tr.state, "CLOSED", name);
      assert.strictEqual(tr.closeReason, reason, name);
      assert.ok(tr.pnlR! < r && tr.pnlR! > r - 0.5, `${name}: ${tr.pnlR}R (fees included)`);
      assert.ok(t.msgs[1].includes(reason === "TP_FILLED" ? "✅ TAKE PROFIT · V11" : "❌ STOP LOSS · V11"), t.msgs[1]);
    }
  });

  await scenario("PAPER time-out (timeoutHours 1): still open after 1 h -> closed at that minute's close", async () => {
    let now = E + 105_000;
    const store = fakeStore(), t = tg();
    const mins = minutes(E, 90, () => ({}), price - 0.2);
    const svc = new V11LiveService(settings({ timeoutHours: 1 }), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t }], source(B, () => now), async (_s, f, to) => mins.filter((b) => b.t >= f && b.t < to), store, () => now);
    await svc.onMinute();
    now = E + 30 * M; await svc.onMinute();
    assert.strictEqual(store.trades[0].state, "OPEN");
    now = E + 75 * M; await svc.onMinute();
    const tr = store.trades[0];
    assert.strictEqual(tr.closeReason, "TIMEOUT_CLOSED");
    assert.strictEqual(tr.closedAt, E + H);
    assert.ok(Math.abs(tr.exitPrice! - (price - 0.2)) < 1e-9);
    assert.ok(t.msgs[1].includes("⏱ TIME OUT"));
  });

  await scenario("REAL: market SELL, SL algo at the wick's high, TP limit at 2R; then the TP fills -> settled from Binance fills", async () => {
    let now = E + 105_000;
    const bx = fakeBinance(price, () => now, [SYM]), store = fakeStore(), t = tg();
    const user: V11UserRef = { userId: "karo", mode: "REAL", riskUsd: 5, binanceRest: bx as never, telegram: t, leverage: 10, marginMode: "ISOLATED" };
    const svc = new V11LiveService(settings({ userModes: { karo: "REAL" } }), () => [user], source(B, () => now), async () => [], store, () => now);
    await svc.onMinute();
    const tr = store.trades[0];
    assert.strictEqual(tr.state, "OPEN", tr.failureReason ?? "");
    assert.strictEqual(tr.entryInProgress, false);
    const mk = bx.st.created.find((o) => o.type === "MARKET")!;
    assert.strictEqual(mk.side, "SELL");
    const sl = bx.st.algos[0], tp = bx.st.orders.find((o) => o.type === "LIMIT")!;
    assert.ok(Math.abs(Number(sl.triggerPrice ?? sl.stopPrice) - SL) < 1e-3, JSON.stringify(sl));
    assert.ok(Math.abs(Number(tp.price) - TP2) < 1e-3, `TP ${tp.price} vs ${TP2}`);
    assert.strictEqual(tp.side, "BUY");
    assert.ok(t.msgs[0].includes("🔻 AAA · SHORT · REAL · V11"), t.msgs[0]);
    // the TP fills on Binance -> the 15 s monitor settles it
    now += 30 * M;
    bx.fillTp();
    await svc.monitorReal();
    const done = store.trades[0];
    assert.strictEqual(done.state, "CLOSED");
    assert.strictEqual(done.closeReason, "TP_FILLED");
    assert.ok(done.pnlUsd! > 0);
    assert.ok(t.msgs[t.msgs.length - 1].includes("✅ TAKE PROFIT · V11"));
  });

  await scenario("REAL guards: a REAL V10 trade on the coin / a position on the account / the price already at the SL -> not opened, told, no order", async () => {
    for (const setup of ["v10", "position", "beyondSl"] as const) {
      const now = E + 105_000;
      const bx = fakeBinance(setup === "beyondSl" ? 107.6 : price, () => now, [SYM]), store = fakeStore(), t = tg();
      if (setup === "v10") store.otherOpen = true;
      if (setup === "position") bx.st.position = 3;
      const svc = new V11LiveService(settings({ userModes: { karo: "REAL" } }), () => [{ userId: "karo", mode: "REAL", riskUsd: 5, binanceRest: bx as never, telegram: t }], source(B, () => now), async () => [], store, () => now);
      await svc.onMinute();
      assert.strictEqual(store.trades[0].state, "SKIPPED", setup);
      assert.strictEqual(bx.st.created.length, 0, `${setup}: no order`);
      assert.ok(t.msgs[0].includes("NOT OPENED") && t.msgs[0].includes(setup === "v10" ? "REAL V10 trade" : setup === "position" ? "position" : "reached the SL"), t.msgs[0]);
    }
  });

  await scenario("REAL: the market call throws but the order filled -> recovered by the monitor (SL resting -> adopted), never unprotected", async () => {
    let now = E + 105_000;
    const bx = fakeBinance(price, () => now, [SYM]), store = fakeStore(), t = tg();
    bx.st.marketThrows = true;
    const svc = new V11LiveService(settings({ userModes: { karo: "REAL" } }), () => [{ userId: "karo", mode: "REAL", riskUsd: 5, binanceRest: bx as never, telegram: t }], source(B, () => now), async () => [], store, () => now);
    await svc.onMinute();
    now += 20_000;
    await svc.monitorReal();
    const tr = store.trades[0];
    assert.ok(tr.state === "OPEN" || tr.state === "CLOSED", tr.state);
    assert.strictEqual(tr.entryInProgress, false);
    // never left with a position and no stop
    assert.ok(bx.st.position === 0 || bx.st.algos.length > 0, `position ${bx.st.position}, stops ${bx.st.algos.length}`);
  });

  await scenario("disabled: no signal is made (the monitor of open trades still runs)", async () => {
    const now = E + 105_000, store = fakeStore(), src = source(B, () => now);
    await new V11LiveService(settings({ enabled: false }), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], src, async () => [], store, () => now).onMinute();
    assert.strictEqual(store.signals.length, 0);
    assert.strictEqual(src.calls, 0);
  });

  await scenario("the V10 / V11 lock: two entries on the same (user, coin) never interleave; other coins run in parallel", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => { log.push(`${name}+`); await new Promise((r) => setTimeout(r, ms)); log.push(`${name}-`); };
    await Promise.all([withSymbolLock("karo", SYM, job("a", 30)), withSymbolLock("karo", SYM, job("b", 5)), withSymbolLock("karo", "BBBUSDT", job("c", 1))]);
    assert.deepStrictEqual(log.filter((x) => x[0] !== "c"), ["a+", "a-", "b+", "b-"]);
    assert.ok(log.indexOf("c-") < log.indexOf("a-"), "another coin is not blocked");
    await assert.rejects(withSymbolLock("karo", SYM, async () => { throw new Error("boom"); }));
    assert.strictEqual(await withSymbolLock("karo", SYM, async () => 7), 7, "a failure never jams the lock");
  });


  await scenario("END TO END on the research data (25 coins x 14 days), hour by hour like the live bot: the same 44 signals as the study", async () => {
    const lines = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", "research_1h_clean.csv.gz"))).toString("utf8").trim().split(/\r?\n/);
    const head = lines[0].split(","), ix = (n: string): number => head.indexOf(n);
    const P = (x: string): number => Date.parse(x.replace(" ", "T") + ":00Z");
    const by = new Map<string, Map<number, V11Bar>>();
    for (const l of lines.slice(1)) {
      const r = l.split(",");
      const b: V11Bar = { t: P(r[ix("open_time_utc")]), o: +r[ix("open")], h: +r[ix("high")], l: +r[ix("low")], c: +r[ix("close")], oo: +r[ix("oi_open")], oc: +r[ix("oi_close")], shortLiq: +r[ix("short_liq_usd")], longLiq: +r[ix("long_liq_usd")], liqOk: r[ix("liq_data_ok")] === "1" };
      if (!by.has(r[0])) by.set(r[0], new Map());
      by.get(r[0])!.set(b.t, b);
    }
    const syms = [...by.keys()];
    const all = [...by.values()].flatMap((m) => [...m.keys()]);
    const first = Math.min(...all), last = Math.max(...all);
    let now = 0;
    const src: V11Source = {
      bars: async (sym, f, t) => { const m = by.get(sym)!, out: Array<V11Bar | null> = []; for (let x = f; x < t; x += H) out.push(x + H <= now ? m.get(x) ?? null : null); return out; },
      hourOpen: async (sym, t) => by.get(sym)!.get(t)?.o ?? null,
    };
    const store = fakeStore();
    const s = parseV11Settings({ enabled: true, userModes: { main: "PAPER" } }, ["main"], syms);
    const svc = new V11LiveService(s, () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], src, async () => [], store, () => now);
    for (let end = first + H; end <= last; end += H) { now = end + 105_000; await svc.onMinute(); }
    assert.strictEqual(store.signals.length, 44, `signals ${store.signals.length}`);
    const t1 = store.signals.filter((x) => x.wick.rally.type === "T1").length, mf = store.signals.filter((x) => x.wick.meaningful).length;
    assert.deepStrictEqual([t1, mf], [18, 23]);
    // one PAPER trade per coin at a time (as live): the others are recorded as SKIPPED, never lost
    assert.strictEqual(store.trades.length, 44);
    assert.ok(store.trades.every((t) => t.state === "OPEN" || (t.state === "SKIPPED" && /already open/.test(t.failureReason!))));
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
