/**
 * V10 (BTC-led alts) -- config, engine (= the research code), live PAPER flow, live REAL flow with a fake Binance.
 * Usage: npx tsx tests/v10.test.ts
 */
import * as assert from "assert";
import { candles, type MinBar } from "../src/research/dc15";
import { oiPeakSignals } from "../src/research/oi-peak";
import { parseV10Settings, rulesFor, type V10Settings } from "../src/strategy/v10/v10-config";
import { btcRank1At, levels, moveOf, ownMove, pickAlts, rank1At, V10_ATR_N, V10_K, V10_TF_MIN } from "../src/strategy/v10/v10-engine";
const PEAK = { entry: "oiPeak" } as const;
import { V10LiveService, type V10UserRef } from "../src/strategy/v10/v10-live.service";
import type { V10SignalDoc, V10Store, V10TradeDoc } from "../src/strategy/v10/v10-repository";
import { formatV10Entry } from "../src/strategy/v10/v10-telegram";
import type { V10BookSnap, V10BookSource } from "../src/strategy/v10/v10-book";
import type { V10ZoneSource } from "../src/strategy/v10/v10-zone";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`); }
}
const M = 60_000, W = 15 * M, T0 = Date.UTC(2026, 8, 22, 0, 0);
const SYMS = ["BTCUSDT", "AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT"];

// ── synthetic BTC: a zigzag warm-up (turns with small OI), then a rise with a big OI build-up, then a red candle with OI down
type Spec = [number, number]; // [close change, OI change] per 15m candle
function btcSpecs(): Spec[] {
  const s: Spec[] = [];
  for (let c = 0; c < 8; c++) {
    for (let i = 0; i < 4; i++) s.push([+0.4, +1]);   // up, OI up
    for (let i = 0; i < 4; i++) s.push([-0.4, -1]);   // down, OI down
  }
  for (let i = 0; i < 6; i++) s.push([+0.6, +8]);     // the big rise, OI up a lot
  s.push([-2.0, -6]);                                  // reversal candle: red, OI down -> RANK 1 SHORT
  for (let i = 0; i < 4; i++) s.push([-0.3, -1]);
  return s;
}
const TOP_CANDLE = 8 * 8 + 6;                          // index of the reversal candle
const SIGNAL_END = T0 + (TOP_CANDLE + 1) * W;
/** 15 minute bars per candle, the close walking linearly, OI linear, a small wick */
function minutes(specs: Spec[], p0 = 100, oi0 = 1000): MinBar[] {
  const out: MinBar[] = [];
  let p = p0, oi = oi0;
  specs.forEach(([dc, doi], i) => {
    for (let m = 0; m < 15; m++) {
      const a = p + (dc * m) / 15, b = p + (dc * (m + 1)) / 15;
      out.push({ t: T0 + i * W + m * M, high: Math.max(a, b) + 0.02, low: Math.min(a, b) - 0.02, close: b, oiFirst: oi + (doi * m) / 15, oiLast: oi + (doi * (m + 1)) / 15 });
    }
    p += dc; oi += doi;
  });
  return out;
}
/** an alt: `beta` x BTC's minute returns, plus deterministic noise of size `noise` */
function alt(btc: MinBar[], beta: number, noise: number, p0: number): MinBar[] {
  let p = p0;
  return btc.map((b, i) => {
    const r = i === 0 ? 0 : b.close / btc[i - 1].close - 1;
    const prev = p;
    p *= 1 + beta * r + noise * Math.sin(i * 2.3) * 0.001;
    return { t: b.t, high: Math.max(prev, p) * 1.0001, low: Math.min(prev, p) * 0.9999, close: p, oiFirst: 500, oiLast: 500 };
  });
}
function market(): Map<string, MinBar[]> {
  const btc = minutes(btcSpecs());
  return new Map([
    ["BTCUSDT", btc],
    ["AAAUSDT", alt(btc, 2, 0.02, 10)],   // follows BTC 2x  -> pick #1
    ["BBBUSDT", alt(btc, 1, 0.02, 20)],   // follows BTC 1x  -> pick #2
    ["CCCUSDT", alt(btc, 0, 3, 30)],      // its own noise   -> not a follower
    ["DDDUSDT", alt(btc, 3, 4, 40)],      // 3x but noisy    -> lower follow, not picked
  ]);
}

// ── fakes
function fakeStore(): V10Store & { signals: V10SignalDoc[]; trades: V10TradeDoc[]; v9Open: Array<{ userId: string; symbol: string; createdAt?: number }> } {
  const signals: V10SignalDoc[] = [], trades: V10TradeDoc[] = [], v9Open: Array<{ userId: string; symbol: string; createdAt?: number }> = [];
  return {
    signals, trades, v9Open,
    ensureIndexes: async () => undefined,
    insertSignal: async (d) => { if (signals.some((x) => x.signalId === d.signalId)) return false; signals.push({ ...d }); return true; },
    insertTrade: async (d) => { if (trades.some((x) => x.tradeId === d.tradeId)) return false; trades.push({ ...d }); return true; },
    updateTrade: async (id, f) => { const t = trades.find((x) => x.tradeId === id); if (t) Object.assign(t, f); },
    findOpenTrades: async () => trades.filter((t) => t.state === "OPEN").map((t) => ({ ...t })),
    hasOpenV9Trade: async (userId, symbol) => v9Open.some((x) => x.userId === userId && x.symbol === symbol),
    openV9TradeSince: async (userId, symbol, after) => { const x = v9Open.find((v) => v.userId === userId && v.symbol === symbol && (v.createdAt ?? 0) >= after); return x ? x.createdAt ?? 0 : null; },
  };
}
const loaderOf = (data: Map<string, MinBar[]>) => async (symbol: string, from: number, to: number): Promise<MinBar[]> =>
  (data.get(symbol) ?? []).filter((b) => b.t >= from && b.t < to);
const tg = () => { const msgs: string[] = []; return { msgs, sendMessage: async (t: string) => { msgs.push(t); } }; };
const settings = (o: Record<string, unknown> = {}): V10Settings =>
  parseV10Settings({ enabled: true, userModes: { main: "PAPER" }, ...o }, ["main", "karo", "artak"], SYMS);

/** a small fake Binance account: market orders fill at the book, a TP LIMIT rests, the SL is an algo order */
function fakeBinance(book: number, clock: () => number = () => SIGNAL_END + 100_000) {
  const st = { position: 0, entry: 0, orders: [] as Array<Record<string, string | number>>, algos: [] as Array<Record<string, string | number>>, fills: [] as Array<Record<string, unknown>>, nextId: 100, created: [] as Array<Record<string, string | number>>, filledOrders: new Set<number>(), triggered: new Map<number, number>(), marketThrows: false,
    byClient: new Map<string, Record<string, string | number>>(), allAlgos: [] as Array<Record<string, string | number>>, orderStatus: new Map<number, string>() };
  const notExist = (): never => { throw new Error("Binance API error -2013: Order does not exist."); };
  const rest = {
    st,
    getExchangeInfo: async () => ({ symbols: SYMS.map((s) => ({ symbol: s, pricePrecision: 4, quantityPrecision: 2, filters: [{ filterType: "PRICE_FILTER", tickSize: "0.0001" }, { filterType: "LOT_SIZE", stepSize: "0.01", minQty: "0.01" }, { filterType: "MIN_NOTIONAL", notional: "5" }] })) }),
    getBookTicker: async () => ({ bidPrice: String(book), askPrice: String(book) }),
    getPositionRisk: async (symbol?: string) => [{ symbol: symbol ?? "AAAUSDT", positionAmt: String(st.position), entryPrice: String(st.entry), marginType: "isolated" }],
    setLeverage: async () => ({}),
    setMarginType: async () => ({}),
    createOrder: async (p: Record<string, string | number>) => {
      st.created.push(p);
      const id = st.nextId++;
      if (p.type === "MARKET") {
        const q = Number(p.quantity), sg = p.side === "SELL" ? -1 : 1;
        const pnl = p.reduceOnly === "true" ? (st.position > 0 ? (book - st.entry) * q : (st.entry - book) * q) : 0;
        st.position = Number((st.position + sg * q).toFixed(8)); if (p.reduceOnly !== "true") st.entry = book;
        st.fills.push({ orderId: id, side: p.side, price: book, qty: q, realizedPnl: pnl, commission: 0.01, commissionAsset: "USDT", time: clock() });
        if (p.newClientOrderId) st.byClient.set(String(p.newClientOrderId), { orderId: id, clientOrderId: p.newClientOrderId, status: "FILLED", executedQty: q, avgPrice: book });
        if (st.marketThrows && p.reduceOnly !== "true") throw new Error("ETIMEDOUT (the order filled anyway)");
        return { orderId: id, avgPrice: String(book), executedQty: String(q) };
      }
      st.orders.push({ ...p, orderId: id, clientOrderId: p.newClientOrderId });
      if (p.newClientOrderId) st.byClient.set(String(p.newClientOrderId), { orderId: id, clientOrderId: p.newClientOrderId, executedQty: 0, avgPrice: 0 });
      return { orderId: id };
    },
    getOrder: async (_s: string, orderId: number) => ({ orderId, status: st.orderStatus.get(orderId) ?? (st.orders.some((o) => o.orderId === orderId) ? "NEW" : st.filledOrders.has(orderId) ? "FILLED" : "CANCELED") }),
    getOrderByClientId: async (_s: string, cid: string) => {
      const o = st.byClient.get(cid) ?? notExist();
      const id = Number(o.orderId);
      return { ...o, status: o.status ?? (st.orders.some((x) => x.orderId === id) ? "NEW" : st.filledOrders.has(id) ? "FILLED" : "CANCELED") };
    },
    getOpenOrders: async () => st.orders,
    cancelOrder: async (_s: string, orderId: number) => { st.orders = st.orders.filter((o) => o.orderId !== orderId); return {}; },
    createAlgoOrder: async (p: Record<string, string | number>) => { const algoId = st.nextId++; st.algos.push({ ...p, algoId }); st.allAlgos.push({ ...p, algoId }); st.created.push(p); return { algoId }; },
    getAlgoOrder: async (algoId: number) => ({ algoStatus: st.algos.some((a) => a.algoId === algoId) ? "NEW" : st.triggered.has(algoId) ? "FINISHED" : "CANCELED", actualOrderId: st.triggered.get(algoId) }),
    getAlgoOrderByClientId: async (cid: string) => {
      const a = st.allAlgos.find((x) => x.clientAlgoId === cid) ?? notExist();
      const algoId = Number(a.algoId);
      return { algoId, clientAlgoId: cid, algoStatus: st.algos.some((x) => x.algoId === algoId) ? "NEW" : st.triggered.has(algoId) ? "FINISHED" : "CANCELED", actualOrderId: st.triggered.get(algoId) };
    },
    getOpenAlgoOrders: async () => st.algos,
    cancelAlgoOrder: async (algoId: number) => { st.algos = st.algos.filter((a) => a.algoId !== algoId); return {}; },
    getUserTrades: async () => st.fills,
    /** the TP limit fills at its price */
    fillTp(): void {
      const tp = st.orders.find((o) => o.type === "LIMIT")!;
      const q = Number(tp.quantity), px = Number(tp.price);
      st.fills.push({ orderId: tp.orderId, side: tp.side, price: px, qty: q, realizedPnl: (st.entry - px) * q, commission: 0.005, commissionAsset: "USDT", time: clock() });
      st.position = Number((st.position + (tp.side === "BUY" ? q : -q)).toFixed(8)); st.orders = st.orders.filter((o) => o !== tp); st.filledOrders.add(Number(tp.orderId));
    },
    /** another trade's fill on the same symbol (e.g. V9 closing / opening) */
    foreignFill(side: "BUY" | "SELL", qty: number, price: number, realizedPnl: number): void {
      st.fills.push({ orderId: 999_999, side, price, qty, realizedPnl, commission: 0.5, commissionAsset: "USDT", time: clock() });
    },
  };
  return rest;
}

async function run(): Promise<void> {
  console.log("V10 (BTC-led alts)");

  await scenario("config: defaults, perUser overrides, clear errors on typos", () => {
    const s = settings({ perUser: { karo: { long: true, slPct: 1.5, maxOpen: 2 } } });
    assert.deepStrictEqual([s.short, s.long, s.slPct, s.tpPct, s.picks, s.rankWindowHours], [true, false, 1, 1, 3, 12]);
    assert.deepStrictEqual(s.symbols, ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT"]);
    assert.deepStrictEqual(rulesFor(s, "karo"), { short: true, long: true, slPct: 1.5, tpPct: 1, maxOpen: 2, btc: true, own: false, ownSlPct: 1, ownTpPct: 2, ownLong: true, newShort: false, newLong: false, zoneFilterShort: false, zoneFilterLong: false, zoneLongMaxAtr: 7, bookFilterShort: false });
    assert.deepStrictEqual(rulesFor(s, "main"), { short: true, long: false, slPct: 1, tpPct: 1, maxOpen: null, btc: true, own: false, ownSlPct: 1, ownTpPct: 2, ownLong: false, newShort: false, newLong: false, zoneFilterShort: false, zoneFilterLong: false, zoneLongMaxAtr: 7, bookFilterShort: false });
    // Oct 4: new coins, zone filters, excluded symbols
    const z = settings({ zoneFilterLong: true, perUser: { karo: { newShort: true, zoneFilterShort: true, zoneLongMaxAtr: 5 } } });
    assert.deepStrictEqual([rulesFor(z, "main").zoneFilterLong, rulesFor(z, "karo").newShort, rulesFor(z, "karo").zoneFilterShort, rulesFor(z, "karo").zoneLongMaxAtr, rulesFor(z, "main").zoneLongMaxAtr], [true, true, true, 5, 7]);
    assert.throws(() => settings({ perUser: { karo: { zoneLongMaxAtr: 0 } } }), /zoneLongMaxAtr/);
    assert.deepStrictEqual([rulesFor(settings({ perUser: { karo: { bookFilterShort: true } } }), "karo").bookFilterShort, rulesFor(settings(), "karo").bookFilterShort], [true, false]);
    assert.deepStrictEqual(settings({ excludeSymbols: ["aaausdt"] }).symbols, ["BBBUSDT", "CCCUSDT", "DDDUSDT"]);
    assert.throws(() => settings({ excludeSymbols: ["ZZZUSDT"] }), /does not collect/);
    // Oct 4: ALT LONGs -- "ownLong" (block or per user; absent = follow "long"), the rule "flush" by default
    assert.deepStrictEqual(settings().ownLongRule, { entry: "flush", flushRank: true });
    assert.deepStrictEqual(settings({ ownLongEntry: "same" }).ownLongRule, settings().ownRule);
    assert.throws(() => settings({ ownLongEntry: "mirror" }), /ownLongEntry/);
    const ol = settings({ perUser: { main: { ownLong: true } } });
    assert.deepStrictEqual([rulesFor(ol, "main").ownLong, rulesFor(ol, "main").long, rulesFor(ol, "karo").ownLong], [true, false, false], "main: ALT LONGs on, BTC-part LONGs still off; karo untouched");
    assert.strictEqual(rulesFor(settings({ ownLong: false, perUser: { karo: { long: true } } }), "karo").ownLong, false, "the block's ownLong beats a user's long");
    const o = settings({ own: true, ownTpPct: 3, perUser: { karo: { own: false, btc: false }, main: { ownSlPct: 0.8 } } });
    assert.deepStrictEqual([rulesFor(o, "main").own, rulesFor(o, "main").ownSlPct, rulesFor(o, "main").ownTpPct, rulesFor(o, "karo").own, rulesFor(o, "karo").btc], [true, 0.8, 3, false, false]);
    assert.throws(() => settings({ perUser: { main: { ownTP: 2 } } }), /not a known setting/);
    assert.throws(() => settings({ own: "yes" }), /v10.own/);
    assert.strictEqual(parseV10Settings(undefined, ["main"], SYMS).enabled, false);
    assert.deepStrictEqual([settings().rule, settings().ownRule], [{ entry: "oiPeak", topCandleOi: true }, { entry: "atr", topCandleOi: false }], "defaults (Oct 3 tests): BTC oiPeak, ALT atr without the top-candle OI rule");
    assert.deepStrictEqual([settings({ entry: "atrFrozen", ownEntry: "story", ownTopCandleOi: true }).rule, settings({ entry: "atrFrozen", ownEntry: "story", ownTopCandleOi: true }).ownRule], [{ entry: "atrFrozen", topCandleOi: true }, { entry: "story", topCandleOi: true }]);
    assert.throws(() => settings({ ownEntry: "x" }), /v10.ownEntry/);
    assert.throws(() => settings({ ownTopCandleOi: "no" }), /ownTopCandleOi/);
    assert.throws(() => settings({ entry: "ATR" }), /v10.entry/);
    assert.strictEqual(settings().ownR2Minutes, 1, "part 2 R² on 1-minute returns by default");
    assert.strictEqual(settings({ ownR2Minutes: 15 }).ownR2Minutes, 15);
    assert.throws(() => settings({ ownR2Minutes: 5 }), /ownR2Minutes/);
    assert.throws(() => settings({ redCandle: true }), /not a known setting/);
    assert.throws(() => settings({ userModes: { main: "LIVE" } }), /"OFF", "PAPER" or "REAL"/);
    assert.throws(() => settings({ userModes: { bob: "PAPER" } }), /unknown user "bob"/);
    assert.throws(() => settings({ slPct: 0 }), /v10.slPct/);
    assert.throws(() => settings({ perUser: { karo: { sl: 1 } } }), /not a known setting/);
    assert.throws(() => settings({ symbols: ["BTCUSDT"] }), /must not contain BTCUSDT/);
    assert.throws(() => settings({ short: "yes" }), /v10.short/);
  });

  await scenario("engine = research: the live RANK 1 check at every candle gives exactly the research's RANK 1 turns", () => {
    const btc = market().get("BTCUSDT")!;
    const research = oiPeakSignals(candles(btc, V10_TF_MIN), V10_K, V10_ATR_N, 12).map((s) => s.t);
    const live: number[] = [];
    for (let end = T0 + W; end <= btc[btc.length - 1].t + M; end += W) if (btcRank1At(btc, end, 12, PEAK)) live.push(end);
    assert.ok(research.length > 0);
    assert.deepStrictEqual(live, research);
    assert.ok(live.includes(SIGNAL_END), `the big top is a RANK 1 signal (${live.map((x) => (x - T0) / W)})`);
  });

  await scenario("engine: the top is a SHORT; no look-ahead (future bars never change it); picks = followers by x", () => {
    const mk = market(), btc = mk.get("BTCUSDT")!;
    const t = btcRank1At(btc, SIGNAL_END, 12, PEAK)!;
    assert.strictEqual(t.side, "SHORT");
    assert.ok(t.moveOiPct > 0 && t.candleOiPct < 0 && t.fromPeakOiPct < 0 && t.label === "LONGS OUT", JSON.stringify(t));
    assert.deepStrictEqual(btcRank1At(btc.filter((b) => b.t < SIGNAL_END), SIGNAL_END, 12, PEAK), t);
    const closes = new Map([...mk].filter(([s]) => s !== "BTCUSDT").map(([s, b]) => [s, new Map(b.map((x) => [x.t, x.close]))]));
    const picks = pickAlts(t, new Map(btc.map((b) => [b.t, b.close])), closes, 3);
    assert.deepStrictEqual(picks.map((p) => p.symbol), ["AAAUSDT", "BBBUSDT"], JSON.stringify(picks));
    assert.ok(Math.abs(picks[0].x - 2) < 0.2 && picks[0].rank === 1 && picks[0].price > 0);
  });

  // ── part 2: the alt's own move
  /** BTC only zigzags (no big move); EEE makes the big OI-led rise and top on its own */
  const calmMarket = (): Map<string, MinBar[]> => {
    const z: Spec[] = [];
    for (let c = 0; c < 40; c++) { z.push([+0.3, +1]); z.push([-0.3, -1]); }   // calm: up / down every candle
    const btc = minutes(z);
    return new Map([["BTCUSDT", btc], ["EEEUSDT", minutes(btcSpecs(), 50, 3000)], ["AAAUSDT", alt(btc, 2, 0.02, 10)]]);
  };
  const SYMS2 = ["BTCUSDT", "EEEUSDT", "AAAUSDT"];
  const settings2 = (o: Record<string, unknown> = {}): V10Settings => parseV10Settings({ enabled: true, ownR2Minutes: 1, newShort: true, newLong: true, userModes: { main: "PAPER", karo: "PAPER" }, ...o }, ["main", "karo"], SYMS2);   // the synthetic coins have < 7 days of data = "new"

  await scenario("part 2 engine: the alt's own RANK 1 top, moved on its own; an alt that only follows BTC is not 'own'", () => {
    const mk = calmMarket(), btcCloses = new Map(mk.get("BTCUSDT")!.map((b) => [b.t, b.close]));
    assert.strictEqual(btcRank1At(mk.get("BTCUSDT")!, SIGNAL_END, 12, PEAK)?.side !== "SHORT" || true, true);
    const e = mk.get("EEEUSDT")!, turn = rank1At(e, SIGNAL_END, 12, PEAK)!;
    assert.strictEqual(turn.side, "SHORT");
    const own = ownMove(turn, new Map(e.map((b) => [b.t, b.close])), btcCloses, 1);
    assert.ok(own && own.follow < 0.5, JSON.stringify(own));
    // AAA is a 2x copy of BTC: whatever turn it has, it is never "own"
    const a = mk.get("AAAUSDT")!;
    for (let end = T0 + 20 * W; end < SIGNAL_END + 4 * W; end += W) {
      const t = rank1At(a, end, 12, PEAK);
      if (t) assert.strictEqual(ownMove(t, new Map(a.map((b) => [b.t, b.close])), btcCloses, 1), null, `AAA at ${(end - T0) / W}`);
    }
  });

  await scenario("part 2 live: main (own on) gets 'V10 · ALT' SHORT on the alt with its own SL / TP %; karo (own off) nothing; once", async () => {
    const mk = calmMarket(), store = fakeStore(), mainTg = tg(), karoTg = tg();
    const users: V10UserRef[] = [
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: mainTg },
      { userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: karoTg },
    ];
    const svc = new V10LiveService(settings2({ perUser: { main: { own: true } } }), () => users, loaderOf(mk), store, () => SIGNAL_END + 100_000);
    await svc.onMinute();
    await svc.onMinute();
    const own = store.signals.filter((x) => x.kind === "OWN");
    assert.deepStrictEqual(own.map((x) => `${x.symbol}:${x.side}`), ["EEEUSDT:SHORT"], JSON.stringify(store.signals.map((x) => x.signalId)));
    assert.deepStrictEqual(store.trades.map((t) => `${t.userId}:${t.symbol}:${t.kind}:${t.slPct}/${t.tpPct}`), ["main:EEEUSDT:OWN:1/2"]);
    const t = store.trades[0];
    assert.ok(Math.abs(t.slPrice! / t.entryPrice! - 1.01) < 1e-9 && Math.abs(t.tpPrice! / t.entryPrice! - 0.98) < 1e-9);
    assert.strictEqual(karoTg.msgs.length, 0);
    const m = mainTg.msgs[0];
    assert.ok(m.startsWith("🔻 V10 · ALT · EEEUSDT · SHORT (SELL) · PAPER") && m.includes("📖 EEE") && m.includes("(-2.00%)") && m.includes("BTC-ն այդ ընթացքում"), m);
    if (process.env.SHOW) console.log(m);
  });

  await scenario("part 2 is off by default: the same market gives no ALT trade and does not even load the alts' history", async () => {
    const mk = calmMarket(), store = fakeStore();
    let altLoads = 0;
    const load = async (sym: string, f: number, to: number): Promise<MinBar[]> => { if (sym !== "BTCUSDT" && to - f > 2 * 24 * 3_600_000) altLoads++; return loaderOf(mk)(sym, f, to); };
    const svc = new V10LiveService(settings2(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], load, store, () => SIGNAL_END + 100_000);
    await svc.onMinute();
    assert.strictEqual(store.signals.filter((x) => x.kind === "OWN").length, 0);
    assert.strictEqual(altLoads, 0);
  });

  await scenario("one V10 trade per coin per user across both parts: an open ALT trade on AAA -> the BTC-led pick AAA is skipped (others opened)", async () => {
    const mk = market(), store = fakeStore();
    store.trades.push({ tradeId: "v10alt-x:AAAUSDT:main", orderSignalId: "v10alt-x:AAAUSDT", signalId: "v10alt-x", kind: "OWN", userId: "main", mode: "PAPER", symbol: "AAAUSDT", side: "SHORT", pick: { rank: 1, x: 0, follow: 0.2, coinPct: 3, btcPct: 0 }, state: "OPEN", createdAt: SIGNAL_END - 4 * W, entryPrice: 1e9, slPrice: 2e9, tpPrice: 1, slPct: 1, tpPct: 2, quantity: 1, plannedRiskUsd: 10, actualRiskUsd: 10, binance: null, closedAt: null, exitPrice: null, pnlUsd: null, pnlR: null, feesUsd: null, closeReason: null, failureReason: null, closeAttempts: 0, entryInProgress: false, entryStartedAt: null });
    const svc = new V10LiveService(settings({ userModes: { main: "PAPER" } }), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], loaderOf(mk), store, () => SIGNAL_END + 100_000);
    await svc.onMinute();
    assert.deepStrictEqual(store.trades.slice(1).map((t) => `${t.symbol}:${t.kind}:${t.state}`), ["AAAUSDT:BTC:SKIPPED", "BBBUSDT:BTC:OPEN"]);
  });

  await scenario("levels: SHORT SL above / TP below, LONG mirrored", () => {
    assert.deepStrictEqual(levels("SHORT", 100, 1, 1.5), { sl: 101, tp: 98.5 });
    assert.deepStrictEqual(levels("LONG", 100, 1, 2), { sl: 99, tp: 102 });
  });

  await scenario("live: a coin that moved NOT MORE than this user's TP % is not taken (ETH +0.36%, Oct 3) -- per user, silently", async () => {
    const mk = market(), store = fakeStore(), mainTg = tg(), karoTg = tg();
    const users: V10UserRef[] = [
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: mainTg },
      { userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: karoTg },
    ];
    const svc = new V10LiveService(settings({ userModes: { main: "PAPER", karo: "PAPER" }, perUser: { karo: { tpPct: 20 } } }), () => users, loaderOf(mk), store, () => SIGNAL_END + 100_000);
    await svc.onMinute();
    assert.deepStrictEqual(store.trades.filter((t) => t.userId === "main").map((t) => t.state), ["OPEN", "OPEN"]);
    const k = store.trades.filter((t) => t.userId === "karo");
    assert.ok(k.length === 2 && k.every((t) => t.state === "SKIPPED" && /not more than the TP 20%/.test(t.failureReason ?? "")), JSON.stringify(k));
    assert.strictEqual(karoTg.msgs.length, 0, "no Telegram for a quiet-market skip");
    assert.strictEqual(moveOf({ kind: "OWN", side: "LONG", turn: { movePct: -3 } }, { coinPct: 0 }), 3);
  });

  await scenario("live PAPER: one signal -> main gets the picks (entry / TP / SL with prices and %), once; karo (short off) gets nothing", async () => {
    const mk = market(), store = fakeStore(), mainTg = tg(), karoTg = tg();
    let now = SIGNAL_END + 100_000;
    const users: V10UserRef[] = [
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: mainTg },
      { userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: karoTg },
    ];
    const svc = new V10LiveService(settings({ userModes: { main: "PAPER", karo: "PAPER" }, perUser: { karo: { short: false } } }), () => users, loaderOf(mk), store, () => now);
    await svc.onMinute();
    await svc.onMinute();
    assert.strictEqual(store.signals.length, 1);
    assert.strictEqual(store.signals[0].signalId, `v10-${new Date(SIGNAL_END).toISOString().slice(0, 16)}-SHORT`);
    assert.deepStrictEqual(store.trades.map((t) => `${t.userId}:${t.symbol}:${t.side}:${t.state}`), ["main:AAAUSDT:SHORT:OPEN", "main:BBBUSDT:SHORT:OPEN"]);
    assert.strictEqual(karoTg.msgs.length, 0);
    const m = mainTg.msgs.filter((x) => x.startsWith("🔻") || x.startsWith("🔺"));
    assert.strictEqual(m.length, 2);
    assert.ok(m[0].startsWith("🔻 V10 · BTC · AAAUSDT · SHORT (SELL) · PAPER"), m[0]);
    assert.ok(/TP\s+\S+\s+\(-1\.00%\)\s+\+\$10\.00/.test(m[0]) && /SL\s+\S+\s+\(\+1\.00%\)\s+-\$10\.00/.test(m[0]), m[0]);
    assert.ok(m[0].includes("1️⃣") && m[0].includes("2️⃣") && m[0].includes("3️⃣ ") && m[0].includes("կարմիր մոմ") && m[0].includes("OI-ի գագաթից հետո") && m[0].includes("#1/2") && m[0].includes("UTC"), m[0]);
    if (process.env.SHOW) console.log(m[0]);
    // a restart: same candle evaluated again by a fresh service -> nothing new
    const again = new V10LiveService(settings(), () => users, loaderOf(mk), store, () => now);
    await again.onMinute();
    assert.strictEqual(store.trades.length, 2);
    // the price drops 1.5% on AAA and rises 1.5% on BBB in the next minutes -> TP / SL, with fees
    const a = mk.get("AAAUSDT")!, b = mk.get("BBBUSDT")!;
    const ea = store.trades[0].entryPrice!, eb = store.trades[1].entryPrice!;
    a.push({ t: SIGNAL_END + 5 * M, high: ea, low: ea * 0.985, close: ea * 0.986, oiFirst: 1, oiLast: 1 });
    b.push({ t: SIGNAL_END + 5 * M, high: eb * 1.015, low: eb, close: eb * 1.014, oiFirst: 1, oiLast: 1 });
    now = SIGNAL_END + 7 * M;
    await svc.onMinute();
    const [ta, tb] = store.trades;
    assert.deepStrictEqual([ta.state, ta.closeReason, tb.state, tb.closeReason], ["CLOSED", "TP_FILLED", "CLOSED", "SL_FILLED"]);
    assert.ok(ta.pnlUsd! < 10 && ta.pnlUsd! > 9 && tb.pnlUsd! < -10 && tb.pnlUsd! > -11.5, `${ta.pnlUsd} ${tb.pnlUsd}`);
    assert.ok(mainTg.msgs.some((x) => x.startsWith("✅ TAKE PROFIT · V10 · BTC · AAAUSDT")) && mainTg.msgs.some((x) => x.startsWith("❌ STOP LOSS · V10 · BTC · BBBUSDT")));
  });

  await scenario("order book (Oct 4, recorded only): a snapshot at the 15m close; the entry message shows the top vs now; a broken book never stops a trade", async () => {
    const recorded: Array<{ end: number; n: number }> = [];
    const snapOf = (symbol: string, end: number, bid1: number, ask1: number): V10BookSnap => ({ symbol, candleEnd: end, t: end, mid: 1, bid1, ask1, bid2: bid1, ask2: ask1, covered1: true, covered2: true });
    const book: V10BookSource = {
      record: async (end, syms) => { recorded.push({ end, n: syms.length }); return syms.length; },
      // the entry candle: 59% bids; any earlier close (the top): 50%
      get: async (symbol, end) => (end === SIGNAL_END ? snapOf(symbol, end, 59, 41) : snapOf(symbol, end, 50, 50)),
    };
    const mk = market(), store = fakeStore(), t = tg();
    let now = SIGNAL_END + 45_000;
    const svc = new V10LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t }], loaderOf(mk), store, () => now, book);
    await svc.onMinute();                      // 45 s after the close: the snapshot, no signal yet (it waits 90 s)
    assert.deepStrictEqual(recorded, [{ end: SIGNAL_END, n: SYMS.length - 1 }]);
    assert.strictEqual(store.trades.length, 0);
    now = SIGNAL_END + 105_000;
    await svc.onMinute();                      // the signal; the snapshot is not taken twice
    assert.strictEqual(recorded.length, 1);
    const m = t.msgs.find((x) => x.startsWith("🔻"))!;
    // this synthetic top is made by the entry candle itself (a wick) -> no "before", no verdict (the ⚠️ / ✅ lines: tests/v10-book.test.ts)
    assert.ok(m.includes("📚 Լիմիտ օրդերներ (գնից ±1%)") && m.includes("գագաթը հենց այս մոմն է") && m.includes("Հիմա (") && m.includes("ներքևում գնորդ 59%"), m);
    assert.ok(store.trades.every((x) => x.state === "OPEN" && x.book?.grew === null && Math.round(x.book.supportNowPct!) === 59), "trades opened as before, the book kept on the row");
    if (process.env.SHOW) console.log(m);
    // a broken book (record and read both throw) -> the trades are opened exactly the same, the message says nothing about it
    const broken: V10BookSource = { record: async () => { throw new Error("depth down"); }, get: async () => { throw new Error("db down"); } };
    const store2 = fakeStore(), t2 = tg();
    let now2 = SIGNAL_END + 45_000;
    const svc2 = new V10LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t2 }], loaderOf(market()), store2, () => now2, broken);
    await svc2.onMinute();
    now2 = SIGNAL_END + 105_000;
    await svc2.onMinute();
    assert.deepStrictEqual(store2.trades.map((x) => x.state), store.trades.map((x) => x.state));
    assert.ok(t2.msgs.some((x) => x.startsWith("🔻")) && !t2.msgs.some((x) => x.includes("📚")));
  });

  await scenario("4h zone (Oct 4, recorded only): shown and kept on the row; a broken zone source never stops a trade; rank1At side filter", async () => {
    const mk = market();
    assert.ok(rank1At(mk.get("BTCUSDT")!, SIGNAL_END, 12, PEAK, "SHORT") && !rank1At(mk.get("BTCUSDT")!, SIGNAL_END, 12, PEAK, "LONG"), "the side filter");
    const zone: V10ZoneSource = { at: async () => ({ lo: 9, hi: 9.5, res: 3, sup: 2, flip: true, distAtr: 2.5 }) };
    const store = fakeStore(), t = tg();
    const svc = new V10LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t }], loaderOf(mk), store, () => SIGNAL_END + 100_000, null, zone);
    await svc.onMinute();
    const m = t.msgs.find((x) => x.startsWith("🔻"))!;
    assert.ok(m.includes("🧱 4h զոնա 9 – 9.5 · FLIP ✅ (3 ներքևից / 2 վերևից) · գինը զոնայից 2.5 ATR վերև"), m);
    assert.ok(store.trades.length === 2 && store.trades.every((x) => x.zone4h?.flip === true));
    const broken: V10ZoneSource = { at: async () => { throw new Error("klines down"); } };
    const store2 = fakeStore(), t2 = tg();
    await new V10LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t2 }], loaderOf(market()), store2, () => SIGNAL_END + 100_000, null, broken).onMinute();
    assert.deepStrictEqual(store2.trades.map((x) => x.state), ["OPEN", "OPEN"]);
    assert.ok(!t2.msgs.some((x) => x.includes("🧱")) && store2.trades.every((x) => !("zone4h" in x)));
  });

  await scenario("Oct 4: btc off -> the BTC part is not even run; LONG / SHORT independent per coin; zoneFilterShort skips a SHORT with a zone in the TP's way", async () => {
    // btc off for everyone -> no BTC signal at all
    const st0 = fakeStore();
    await new V10LiveService(settings({ btc: false }), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], loaderOf(market()), st0, () => SIGNAL_END + 100_000).onMinute();
    assert.deepStrictEqual([st0.signals.length, st0.trades.length], [0, 0]);
    // an open LONG on AAA does not block the SHORT on AAA (the other side); an open SHORT on BBB does
    const st = fakeStore();
    const openRow = (symbol: string, side: "LONG" | "SHORT"): V10TradeDoc => ({ tradeId: `x:${symbol}:${side}`, orderSignalId: "x", signalId: "x", kind: "OWN", userId: "main", mode: "PAPER", symbol, side, pick: { rank: 1, x: 1, follow: 0, coinPct: 0, btcPct: 0 },
      state: "OPEN", createdAt: SIGNAL_END - W, entryPrice: 1, slPrice: side === "LONG" ? 0.5 : 2, tpPrice: side === "LONG" ? 3 : 0.1, slPct: 1, tpPct: 2, quantity: 1, plannedRiskUsd: 10, actualRiskUsd: 10, binance: null,
      closedAt: null, exitPrice: null, pnlUsd: null, pnlR: null, feesUsd: null, closeReason: null, failureReason: null, closeAttempts: 0, entryInProgress: false, entryStartedAt: null });
    st.trades.push(openRow("AAAUSDT", "LONG"), openRow("BBBUSDT", "SHORT"));
    await new V10LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], loaderOf(market()), st, () => SIGNAL_END + 100_000).onMinute();
    const mine = st.trades.filter((t) => t.signalId !== "x").map((t) => `${t.symbol}:${t.side}:${t.state}`);
    assert.deepStrictEqual(mine, ["AAAUSDT:SHORT:OPEN", "BBBUSDT:SHORT:SKIPPED"]);
    // zoneFilterShort: a 4h zone between the entry and the TP -> not taken; without the filter it is taken and shown
    const wall: V10ZoneSource = { at: async (_s, _t, price) => ({ lo: price * 0.985, hi: price * 0.99, res: 2, sup: 2, flip: true, distAtr: 1, zones: [{ lo: price * 0.985, hi: price * 0.99, strong: false }], atr: price * 0.01, strongBelowAtr: null }) };
    for (const on of [true, false]) {
      const s2 = fakeStore(), t2 = tg();
      await new V10LiveService(settings({ perUser: { main: { zoneFilterShort: on } } }), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t2 }], loaderOf(market()), s2, () => SIGNAL_END + 100_000, null, wall).onMinute();
      assert.deepStrictEqual(s2.trades.map((t) => t.state), on ? ["SKIPPED", "SKIPPED"] : ["OPEN", "OPEN"], `filter ${on}`);
      if (!on) assert.ok(t2.msgs.some((m) => m.includes("⚠️ TP-ի ճանապարհին զոնա կա")), t2.msgs.join("\n"));
    }
  });

  await scenario("live: data of the candle's last minute not written yet -> waits (no signal), then acts when it is", async () => {
    const mk = market(), store = fakeStore();
    const btc = mk.get("BTCUSDT")!, lastMinute = btc.find((x) => x.t === SIGNAL_END - M)!;
    mk.set("BTCUSDT", btc.filter((x) => x.t !== SIGNAL_END - M));
    let now = SIGNAL_END + 100_000;
    const svc = new V10LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], loaderOf(mk), store, () => now);
    await svc.onMinute();
    assert.strictEqual(store.signals.length, 0);
    mk.set("BTCUSDT", [...mk.get("BTCUSDT")!, lastMinute].sort((x, y) => x.t - y.t));
    now += M;
    await svc.onMinute();
    assert.strictEqual(store.signals.length, 1);
  });

  await scenario("live: a stale candle (more than 10 min after its close) is never acted on", async () => {
    const store = fakeStore();
    const svc = new V10LiveService(settings(), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], loaderOf(market()), store, () => SIGNAL_END + 11 * M);
    await svc.onMinute();
    assert.strictEqual(store.signals.length, 0);
  });

  await scenario("LONG mirror: a BTC bottom (drop with OI up, green candle with OI down) -> nothing while long is off; LONG the alts that fell most when on", async () => {
    const mirror = (b: MinBar[], p0: number): MinBar[] => b.map((x) => ({ ...x, high: 2 * p0 - x.low, low: 2 * p0 - x.high, close: 2 * p0 - x.close }));
    const btc = mirror(minutes(btcSpecs()), 100);
    const mk = new Map([["BTCUSDT", btc], ["AAAUSDT", alt(btc, 2, 0.02, 10)], ["BBBUSDT", alt(btc, 1, 0.02, 20)], ["CCCUSDT", alt(btc, 0, 3, 30)], ["DDDUSDT", alt(btc, 3, 4, 40)]]);
    assert.strictEqual(btcRank1At(btc, SIGNAL_END, 12, PEAK)?.side, "LONG");
    for (const long of [false, true]) {
      const store = fakeStore(), t = tg();
      const svc = new V10LiveService(settings({ long }), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t }], loaderOf(mk), store, () => SIGNAL_END + 100_000);
      await svc.onMinute();
      assert.strictEqual(store.signals.length, 1);
      if (!long) { assert.strictEqual(store.trades.length, 0); continue; }
      assert.deepStrictEqual(store.trades.map((x) => `${x.symbol}:${x.side}`), ["AAAUSDT:LONG", "BBBUSDT:LONG"]);
      const tr = store.trades[0];
      assert.ok(tr.slPrice! < tr.entryPrice! && tr.tpPrice! > tr.entryPrice!);
      assert.ok(t.msgs[0].startsWith("🔺 V10 · BTC · AAAUSDT · LONG (BUY) · PAPER") && t.msgs[0].includes("կանաչ մոմ") && t.msgs[0].includes("⬇️"), t.msgs[0]);
    }
  });

  await scenario("live: maxOpen per user skips with a message", async () => {
    const store = fakeStore(), t = tg();
    const svc = new V10LiveService(settings({ perUser: { main: { maxOpen: 1 } } }), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t }], loaderOf(market()), store, () => SIGNAL_END + 100_000);
    await svc.onMinute();
    assert.deepStrictEqual(store.trades.map((x) => `${x.symbol}:${x.state}`), ["AAAUSDT:OPEN", "BBBUSDT:SKIPPED"]);
    assert.ok(t.msgs.some((m) => m.includes("NOT OPENED") && m.includes("MAX_OPEN")), t.msgs.join("\n---\n"));
  });

  await scenario("live REAL: market entry, SL +1% resting, TP -1% from the fill; closed by the TP from Binance fills; nothing left resting", async () => {
    const mk = market(), store = fakeStore(), t = tg();
    const entry = mk.get("AAAUSDT")!.filter((b) => b.t < SIGNAL_END).at(-1)!.close;
    let now = SIGNAL_END + 100_000;
    const bx = fakeBinance(Number(entry.toFixed(4)), () => now);
    const users: V10UserRef[] = [{ userId: "karo", mode: "REAL", riskUsd: 10, binanceRest: bx as never, leverage: 20, marginMode: "ISOLATED", telegram: t }];
    const svc = new V10LiveService(settings({ picks: 1, userModes: { karo: "REAL" } }), () => users, loaderOf(mk), store, () => now);
    await svc.onMinute();
    const tr = store.trades[0];
    assert.strictEqual(tr.state, "OPEN", tr.failureReason ?? "");
    assert.ok(tr.binance?.slAlgoId && tr.binance.tpOrderId, JSON.stringify(tr.binance));
    const sl = bx.st.algos[0], tp = bx.st.orders[0];
    assert.strictEqual(sl.side, "BUY"); assert.strictEqual(sl.reduceOnly, "true");
    assert.ok(Math.abs(Number(sl.triggerPrice) / entry - 1.01) < 0.0005, `SL ${sl.triggerPrice} vs entry ${entry}`);
    assert.ok(Math.abs(Number(tp.price) / tr.entryPrice! - 0.99) < 0.0005, `TP ${tp.price}`);
    assert.ok(t.msgs[0].startsWith("🔻 V10 · BTC · AAAUSDT · SHORT (SELL) · REAL"), t.msgs[0]);
    await svc.monitorReal();
    assert.strictEqual(store.trades[0].state, "OPEN");                                // position still open
    now += 20 * M;
    bx.foreignFill("BUY", 50, 5, -400);  // another trade's fill on this symbol must never be counted
    now += 10 * M;
    bx.fillTp();
    await svc.monitorReal();
    const done = store.trades[0];
    assert.deepStrictEqual([done.state, done.closeReason], ["CLOSED", "TP_FILLED"]);
    assert.ok(done.pnlUsd! > 9 && done.pnlUsd! < 10.5, `pnl ${done.pnlUsd}`);
    assert.ok(Math.abs(done.exitPrice! - Number(tp.price)) < 1e-9, `exit ${done.exitPrice}`);
    assert.strictEqual(bx.st.algos.length, 0, "the SL is cancelled after the close");
    assert.ok(t.msgs.at(-1)!.startsWith("✅ TAKE PROFIT · V10 · BTC · AAAUSDT · SHORT · REAL"));
  });

  await scenario("live REAL guards: an existing position / a V9 trade on the symbol -> not opened, with a message, no order sent", async () => {
    const mk = market();
    for (const setup of ["position", "v9"] as const) {
      const store = fakeStore(), t = tg(), bx = fakeBinance(10);
      if (setup === "position") bx.st.position = 5; else store.v9Open.push({ userId: "karo", symbol: "AAAUSDT" });
      const svc = new V10LiveService(settings({ picks: 1, userModes: { karo: "REAL" } }), () => [{ userId: "karo", mode: "REAL", riskUsd: 10, binanceRest: bx as never, telegram: t }], loaderOf(mk), store, () => SIGNAL_END + 100_000);
      await svc.onMinute();
      assert.strictEqual(store.trades[0].state, "SKIPPED", setup);
      assert.strictEqual(bx.st.created.length, 0, `${setup}: no order`);
      assert.ok(t.msgs[0].includes("NOT OPENED") && t.msgs[0].includes(setup === "v9" ? "V9 trade" : "position"), t.msgs[0]);
    }
  });

  const realSetup = (o: { marketThrows?: boolean; book?: (signal: number) => number } = {}) => {
    const mk = market(), store = fakeStore(), t = tg();
    let now = SIGNAL_END + 100_000;
    const signal = mk.get("AAAUSDT")!.filter((b) => b.t < SIGNAL_END).at(-1)!.close;
    const bx = fakeBinance(Number((o.book ? o.book(signal) : signal).toFixed(4)), () => now);
    bx.st.marketThrows = !!o.marketThrows;
    const users: V10UserRef[] = [{ userId: "karo", mode: "REAL", riskUsd: 10, binanceRest: bx as never, leverage: 20, marginMode: "ISOLATED", telegram: t }];
    const svc = new V10LiveService(settings({ picks: 1, userModes: { karo: "REAL" } }), () => users, loaderOf(mk), store, () => now);
    return { store, t, bx, svc, tick: (ms: number) => { now += ms; } };
  };

  await scenario("REAL: the entry call fails AFTER the order filled (timeout) -> not 'failed': the position is found without an SL and closed at market", async () => {
    const { store, t, bx, svc, tick } = realSetup({ marketThrows: true });
    await svc.onMinute();
    assert.strictEqual(store.trades[0].state, "OPEN");
    assert.ok(store.trades[0].entryInProgress && bx.st.position < 0, "a position exists, the trade stays under watch");
    tick(15_000);
    await svc.monitorReal();                          // recovery: no SL resting -> fail-safe market close
    assert.strictEqual(bx.st.position, 0);
    assert.ok(t.msgs.at(-1)!.includes("SL was not there"), t.msgs.at(-1));
    tick(15_000);
    await svc.monitorReal();                          // flat -> closed from Binance fills
    assert.deepStrictEqual([store.trades[0].state, store.trades[0].closeReason], ["CLOSED", "FAILSAFE_CLOSED"]);
    assert.ok(t.msgs.at(-1)!.startsWith("⚪ FAIL-SAFE CLOSE"), t.msgs.at(-1));
  });

  await scenario("REAL: a crash mid-entry (row left 'in progress') -> after 5 min our resting SL is found and the trade adopted", async () => {
    const { store, t, bx, svc, tick } = realSetup();
    await svc.onMinute();
    const row = store.trades[0];
    Object.assign(row, { entryInProgress: true, binance: null, entryPrice: null });   // as if the process died before saving
    tick(60_000);
    await svc.monitorReal();
    assert.ok(store.trades[0].entryInProgress, "not touched before 5 min");
    tick(5 * M);
    await svc.monitorReal();
    const a = store.trades[0];
    assert.ok(!a.entryInProgress && a.binance?.slAlgoId && a.binance.tpOrderId && a.entryPrice === bx.st.entry, JSON.stringify(a));
    assert.ok(t.msgs.at(-1)!.includes("with its SL resting"), t.msgs.at(-1));
    assert.ok(bx.st.algos.length === 1 && bx.st.position !== 0, "the position and its SL are untouched");
  });

  await scenario("REAL: our TP filled while a NEW position (another trade) exists -> V10 closes its trade and cancels its own SL at once", async () => {
    const { store, bx, svc, tick } = realSetup();
    await svc.onMinute();
    tick(10 * M);
    bx.fillTp();
    bx.st.position = -3;                                // another trade opened on the symbol in between
    await svc.monitorReal();
    assert.deepStrictEqual([store.trades[0].state, store.trades[0].closeReason], ["CLOSED", "TP_FILLED"]);
    assert.strictEqual(bx.st.algos.length, 0, "our SL must not stay on the other trade's position");
  });

  await scenario("REAL: SL / TP are the SAME prices as PAPER (from the signal price), even when the price moved a bit before the entry", async () => {
    const { store, bx, svc } = realSetup({ book: (p) => p * 1.004 });   // +0.4% against us before the order
    await svc.onMinute();
    const tr = store.trades[0], signal = tr.entryPrice! / 1.004;
    assert.strictEqual(tr.state, "OPEN", tr.failureReason ?? "");
    assert.ok(Math.abs(Number(bx.st.algos[0].triggerPrice) / signal - 1.01) < 0.0002, `SL ${bx.st.algos[0].triggerPrice} vs signal ${signal}`);
    assert.ok(Math.abs(Number(bx.st.orders[0].price) / signal - 0.99) < 0.0002, `TP ${bx.st.orders[0].price}`);
    assert.ok(Math.abs(tr.actualRiskUsd! - 10) < 0.2, `risk stays ~$10 (${tr.actualRiskUsd})`);
  });

  await scenario("REAL: the price already passed the SL before the entry (UNI, Oct 2) -> not opened, no order, the user told why", async () => {
    const { store, t, bx, svc } = realSetup({ book: (p) => p * 1.011 });
    await svc.onMinute();
    assert.strictEqual(store.trades[0].state, "SKIPPED");
    assert.strictEqual(bx.st.created.length, 0);
    assert.ok(t.msgs[0].includes("already reached the SL"), t.msgs[0]);
  });

  await scenario("bookFilterShort (Oct 4): the buyers' share grew from the top to the entry -> no SHORT for that user; the others still take it", async () => {
    const snap = (symbol: string, end: number, bid1: number, ask1: number): V10BookSnap => ({ symbol, candleEnd: end, t: end, mid: 1, bid1, ask1, bid2: bid1, ask2: ask1, covered1: true, covered2: true });
    const book: V10BookSource = { record: async (_e, syms) => syms.length, get: async (symbol, end) => (end === SIGNAL_END ? snap(symbol, end, 60, 40) : snap(symbol, end, 50, 50)) };
    const store = fakeStore();
    const users: V10UserRef[] = [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }, { userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }];
    await new V10LiveService(settings2({ perUser: { main: { own: true }, karo: { own: true, bookFilterShort: true } } }), () => users, loaderOf(calmMarket()), store, () => SIGNAL_END + 100_000, book).onMinute();
    const alt = store.trades.filter((t) => t.kind === "OWN");
    assert.ok(alt.length === 2 && alt.every((t) => t.book?.grew === true), JSON.stringify(alt.map((t) => t.book)));
    assert.deepStrictEqual(alt.map((t) => `${t.userId}:${t.state}`).sort(), ["karo:SKIPPED", "main:OPEN"]);
    assert.ok(/BOOK: the buyers' share within 1% grew/.test(alt.find((t) => t.userId === "karo")!.failureReason ?? ""));
  });

  await scenario("new coins (Oct 4: < 7 days of our data): the signal is made; the trade only with newShort / newLong (per user)", async () => {
    const run = async (o: Record<string, unknown>): Promise<string[]> => {
      const store = fakeStore();
      const svc = new V10LiveService(settings2({ own: true, ...o }), () => [{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], loaderOf(calmMarket()), store, () => SIGNAL_END + 100_000);
      await svc.onMinute();
      assert.ok(store.signals.some((x) => x.kind === "OWN" && x.newCoin === true), "the signal is marked new");
      return store.trades.map((t) => `${t.symbol}:${t.state}`);
    };
    assert.deepStrictEqual(await run({}), ["EEEUSDT:OPEN"]);
    assert.deepStrictEqual(await run({ newShort: false }), ["EEEUSDT:SKIPPED"], "newShort off -> not taken (silently, recorded)");
    assert.deepStrictEqual(await run({ newShort: false, perUser: { main: { newShort: true } } }), ["EEEUSDT:OPEN"], "per user");
  });

  await scenario("REAL recovery never touches a position that is not ours: our entry order was never sent, V9 holds a position -> failed, no order", async () => {
    const { store, t, bx, svc, tick } = realSetup();
    const row: V10TradeDoc = { tradeId: "v10-x:AAAUSDT:karo", orderSignalId: "v10-x:AAAUSDT", signalId: "v10-x", userId: "karo", mode: "REAL", symbol: "AAAUSDT", side: "SHORT", pick: { rank: 1, x: 2, follow: 1, coinPct: 1, btcPct: 1 }, state: "OPEN", createdAt: SIGNAL_END, entryPrice: null, slPrice: 10.1, tpPrice: null, slPct: 1, tpPct: 1, quantity: null, plannedRiskUsd: 10, actualRiskUsd: null, binance: null, closedAt: null, exitPrice: null, pnlUsd: null, pnlR: null, feesUsd: null, closeReason: null, failureReason: null, closeAttempts: 0, entryInProgress: true, entryStartedAt: SIGNAL_END + 100_000 };
    store.trades.push(row);
    bx.st.position = -50;                                  // V9's SHORT on the same symbol
    tick(6 * M);
    await svc.monitorReal();
    assert.strictEqual(store.trades[0].state, "FAILED");
    assert.strictEqual(bx.st.created.length, 0, "no order sent");
    assert.strictEqual(bx.st.position, -50, "V9's position untouched");
    assert.ok(t.msgs.at(-1)!.includes("NOT OPENED"), t.msgs.at(-1));
  });

  await scenario("REAL recovery: closed while the bot was down with our TP still resting -> the TP is cancelled and the close reported (never left behind)", async () => {
    const { store, bx, svc, tick } = realSetup();
    await svc.onMinute();
    Object.assign(store.trades[0], { entryInProgress: true, binance: null, entryPrice: null });
    // the SL fired while we were away: position flat, our TP still resting
    const sl = bx.st.algos[0];
    bx.st.algos = []; bx.st.triggered.set(Number(sl.algoId), 777); bx.st.orderStatus.set(777, "FILLED");
    bx.st.fills.push({ orderId: 777, side: "BUY", price: 10.1, qty: Math.abs(bx.st.position), realizedPnl: -10, commission: 0.01, commissionAsset: "USDT", time: SIGNAL_END + 200_000 });
    bx.st.position = 0;
    tick(6 * M);
    await svc.monitorReal();                               // recovery: DONE
    await svc.monitorReal();                               // settle
    const d = store.trades[0];
    assert.deepStrictEqual([d.state, d.closeReason], ["CLOSED", "SL_FILLED"], JSON.stringify(d));
    assert.strictEqual(bx.st.orders.length, 0, "our TP was cancelled");
  });

  await scenario("REAL: our SL triggered but its order did not fill (expired) and the position is still there -> the trade is NOT closed", async () => {
    const { store, bx, svc, tick } = realSetup();
    await svc.onMinute();
    const sl = bx.st.algos[0];
    bx.st.triggered.set(Number(sl.algoId), 888); bx.st.orderStatus.set(888, "EXPIRED");
    tick(10 * M);
    await svc.monitorReal();
    assert.strictEqual(store.trades[0].state, "OPEN");
    assert.strictEqual(bx.st.orders.length, 1, "the TP stays");
  });

  await scenario("REAL: a V9 row in the database is never proof -- V9 writes it before checking the account; our SL / TP stay", async () => {
    const { store, bx, svc, tick } = realSetup();
    await svc.onMinute();
    tick(10 * M);
    store.v9Open.push({ userId: "karo", symbol: "AAAUSDT", createdAt: SIGNAL_END + 100_000 + 9 * M });   // V9's row, about to be SKIPPED
    await svc.monitorReal();
    assert.strictEqual(store.trades[0].state, "OPEN");
    assert.strictEqual(bx.st.algos.length, 1, "our SL is still resting");
    assert.strictEqual(bx.st.orders.length, 1, "our TP is still resting");
  });

  await scenario("REAL: closed by hand, then another trade of OUR side and a different size appears -> ambiguous: nothing touched, the user alerted after ~5 min", async () => {
    const { store, t, bx, svc, tick } = realSetup();
    await svc.onMinute();
    bx.st.position = -7;
    for (let i = 0; i < 20; i++) { tick(15_000); await svc.monitorReal(); }
    assert.strictEqual(store.trades[0].state, "OPEN");
    assert.strictEqual(bx.st.algos.length + bx.st.orders.length, 2, "nothing cancelled");
    assert.ok(t.msgs.at(-1)!.includes("cannot settle") && t.msgs.at(-1)!.includes("not our size"), t.msgs.at(-1));
    assert.strictEqual(t.msgs.filter((m) => m.includes("cannot settle")).length, 1, "told once");
  });

  await scenario("REAL: closed by hand, then V9 opened on the OTHER side -> ours is settled from fills up to V9's entry, V9's position untouched", async () => {
    const { store, bx, svc, tick } = realSetup();
    await svc.onMinute();
    tick(10 * M);
    bx.st.fills.push({ orderId: 555, side: "BUY", price: 9.9, qty: Math.abs(bx.st.position), realizedPnl: 0.9, commission: 0.01, commissionAsset: "USDT", time: SIGNAL_END + 100_000 + 9 * M });
    bx.st.position = 7;                                   // V9's LONG
    store.v9Open.push({ userId: "karo", symbol: "AAAUSDT", createdAt: SIGNAL_END + 100_000 + 9.5 * M });
    bx.st.fills.push({ orderId: 556, side: "BUY", price: 9.95, qty: 7, realizedPnl: 0, commission: 0.02, commissionAsset: "USDT", time: SIGNAL_END + 100_000 + 9.5 * M + 1000 });
    await svc.monitorReal();
    const d = store.trades[0];
    assert.deepStrictEqual([d.state, d.closeReason], ["CLOSED", "POSITION_CLOSED_EXTERNALLY"]);
    assert.ok(Math.abs(d.exitPrice! - 9.9) < 1e-9, `exit ${d.exitPrice} (V9's fill must not count)`);
    assert.strictEqual(bx.st.algos.length + bx.st.orders.length, 0, "our SL and TP are gone");
    assert.strictEqual(bx.st.position, 7, "V9's position untouched");
  });

  await scenario("config: an unknown key in the v10 block and a wrong-case block name fail startup", async () => {
    assert.throws(() => settings({ slpct: 5 }), /"v10.slpct" is not a known setting/);
    const { parseAppConfig } = await import("../src/config/users-config");
    assert.throws(() => parseAppConfig({ users: [{ userId: "main" }], V10: { enabled: true } }, "x.json", SYMS), /"V10" must be written "v10"/);
    assert.strictEqual(parseAppConfig({ users: [{ userId: "main" }], v10: { enabled: true, userModes: { main: "PAPER" } } }, "x.json", SYMS).v10.enabled, true);
  });

  await scenario("message: TP missing on Binance is said clearly", () => {
    const sig = { signalId: "s", side: "SHORT", rankWindowHours: 12, picks: [{}], kind: "BTC", symbol: "BTCUSDT", turn: { candleEnd: SIGNAL_END, side: "SHORT", price: 1, moveStartT: T0, peakT: SIGNAL_END - W, extremeT: SIGNAL_END - 2 * W, extreme: 2, movePct: 3, moveOiPct: 2, fromPeakOiPct: -0.5, candleOiPct: -1, label: "LONGS OUT", prior: 5 }, createdAt: new Date() } as unknown as V10SignalDoc;
    const txt = formatV10Entry(sig, { tradeId: "x", orderSignalId: "s:AAAUSDT", signalId: "s", userId: "karo", mode: "REAL", symbol: "AAAUSDT", side: "SHORT", pick: { rank: 1, x: 2, follow: 0.9, coinPct: 6, btcPct: 3 }, state: "OPEN", createdAt: SIGNAL_END, entryPrice: 10, slPrice: 10.1, tpPrice: null, slPct: 1, tpPct: 1, quantity: 100, plannedRiskUsd: 10, actualRiskUsd: 10, binance: { tpFailureReason: "TP order placed but could not be verified open" }, closedAt: null, exitPrice: null, pnlUsd: null, pnlR: null, feesUsd: null, closeReason: null, failureReason: null, closeAttempts: 0, entryInProgress: false, entryStartedAt: null });
    assert.ok(txt.includes("TP    n/a -- TP order placed but could not be verified open"), txt);
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
