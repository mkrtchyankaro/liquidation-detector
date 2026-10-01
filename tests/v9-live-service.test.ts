/**
 * V9 live service -- execution and lifecycle with in-memory fakes:
 *  PAPER open -> SL/TP from minute low/high -> close + Telegram
 *  REAL open via the production entry sequence (TP from the actual fill)
 *  REAL close detected from Binance (flat + own fills) + leftover SL cancelled
 *  existing position on the symbol -> SKIPPED, no order
 *  same signal twice -> exactly one trade per user
 *  one user's Telegram failure never affects another user
 *
 * Usage: npx tsx tests/v9-live-service.test.ts
 */
import * as assert from "assert";
import { V9LiveService, type V9UserRef } from "../src/strategy/v9/v9-live.service";
import type { V9Repository, V9TradeDoc, V9DecisionDoc } from "../src/strategy/v9/v9-repository";
import type { V9MongoFeed } from "../src/strategy/v9/v9-feed";
import type { V9Decision } from "../src/strategy/v9/v9-causal-engine";

let passed = 0, failed = 0;
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`); }
}

class MemRepo {
  trades = new Map<string, V9TradeDoc>();
  decisions: V9DecisionDoc[] = [];
  async ensureIndexes(): Promise<void> {}
  async insertDecision(d: V9DecisionDoc): Promise<void> { this.decisions.push(d); }
  async insertTrade(t: V9TradeDoc): Promise<boolean> { if (this.trades.has(t.tradeId)) return false; this.trades.set(t.tradeId, { ...t }); return true; }
  async updateTrade(id: string, f: Partial<V9TradeDoc>): Promise<void> { const t = this.trades.get(id)!; this.trades.set(id, { ...t, ...f }); }
  async findOpenTrades(): Promise<V9TradeDoc[]> { return [...this.trades.values()].filter((t) => t.state === "OPEN").map((t) => ({ ...t })); }
  async insertTimeline(): Promise<void> {}
  async findTradesSince(): Promise<V9TradeDoc[]> { return []; }
  async hasOpenTrade(u: string, s: string): Promise<boolean> { return [...this.trades.values()].some((t) => t.userId === u && t.symbol === s && t.state === "OPEN"); }
}
const noFeed = { warmUp: async () => ({ liq: 0, oi: 0 }), poll: async () => ({ liq: 0, oi: 0 }) } as unknown as V9MongoFeed;

function tg() { const msgs: string[] = []; return { msgs, sendMessage: async (t: string) => { msgs.push(t); } }; }

const T0 = 1_790_200_000_000 - (1_790_200_000_000 % 60_000);
function decision(over: Partial<V9Decision> = {}): V9Decision {
  return {
    symbol: "DOGEUSDT",
    episode: { start: T0 - 3_600_000, end: T0 - 600_000, sIdx: 0, eIdx: 10, victim: "LONG", long: 5e6, short: 1e5, count: 50, startOi: 1, minOi: 0.99, oiDropPct: 1.2, startPrice: 0.105, endPrice: 0.1, extremePrice: 0.099, priceMovePct: -4.7, confirmTs: T0 - 60_000, confirmSide: "SHORT", endReason: "OPPOSITE_EPISODE", parts: 2, partRanges: [[0, 5], [5, 10]], rightCensored: false },
    features: { dom: true, dir: true, exh: true, dirMove: 4.7, clr: 0.9, victimLiq: 5e6, oppLiq: 1e5, peakTs: T0 - 1_800_000, preEff: 2, postEff: 0.1 },
    reference: { medianClr: 0.5, medianMove: 0.6, sampleCount: 20 },
    selection: { selected: true, checks: { DOM: true, DIR: true, CLR: true, MOV: true, EXH: true } },
    tradable: true, reason: "SELECTED", evaluatedAt: T0 + 10_000, missingMinutes: 0, tradeSide: "LONG", stopPrice: 0.099, referencePrice: 0.1,
    ...over,
  };
}

function mockRest(opts: { positionAmt?: string; fills?: unknown[]; slStatus?: string } = {}) {
  const calls: Array<{ fn: string; p?: unknown }> = [];
  let position = opts.positionAmt ?? "0";
  const rest = {
    calls,
    setPosition: (v: string) => { position = v; },
    getExchangeInfo: async () => ({ symbols: [{ symbol: "DOGEUSDT", pricePrecision: 5, quantityPrecision: 0, filters: [{ filterType: "PRICE_FILTER", tickSize: "0.00001" }, { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" }, { filterType: "MIN_NOTIONAL", notional: "5" }] }] }),
    getBookTicker: async () => ({ askPrice: "0.1", bidPrice: "0.09999" }),
    setMarginType: async () => ({}), setLeverage: async () => ({}),
    createOrder: async (p: Record<string, unknown>) => {
      calls.push({ fn: "createOrder", p });
      if (p.type === "MARKET" && !p.reduceOnly) { position = String(p.quantity); return { orderId: 1, avgPrice: "0.1", executedQty: String(p.quantity) }; }
      return { orderId: 77 };
    },
    createAlgoOrder: async (p: unknown) => { calls.push({ fn: "createAlgoOrder", p }); return { algoId: 9 }; },
    getAlgoOrder: async () => ({ algoStatus: opts.slStatus ?? "NEW", actualOrderId: "" }),
    getAlgoOrderByClientId: async () => ({ algoStatus: "NEW" }),
    cancelAlgoOrder: async (id: number) => { calls.push({ fn: "cancelAlgoOrder", p: id }); return {}; },
    cancelOrder: async (_s: string, id: number) => { calls.push({ fn: "cancelOrder", p: id }); return {}; },
    getOrder: async () => ({ status: "NEW" }),
    getPositionRisk: async () => [{ symbol: "DOGEUSDT", positionAmt: position, entryPrice: "0.1" }],
    getOpenOrders: async () => [], getOpenAlgoOrders: async () => [],
    getUserTrades: async () => opts.fills ?? [],
  };
  return rest;
}

function service(users: V9UserRef[], repo: MemRepo, now: { t: number }, extra: Record<string, unknown> = {}) {
  const { frameSource, ...settings } = extra;
  const svc = new V9LiveService({ enabled: true, symbols: ["DOGEUSDT"], rr: 2.2, minSlPct: 0.33, userModes: new Map(), ...settings } as never, () => users, noFeed, repo as unknown as V9Repository, undefined, () => now.t, (frameSource ?? null) as never);
  (svc as unknown as { ready: boolean }).ready = true;
  return svc as unknown as {
    handleDecision(d: V9Decision): Promise<void>;
    monitorPaper(symbol: string, engine: unknown, now: number): Promise<void>;
    monitorReal(): Promise<void>;
    engines: Map<string, { store: { addOiObservation(ts: number, u: number, oi: number, p: number): void } }>;
  };
}

async function run(): Promise<void> {
  console.log("V9 live service");

  await scenario("PAPER: opens at the reference price with 2.2R TP; closes on SL from minute lows; Telegram both times", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 }, t = tg();
    const svc = service([{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t }], repo, now);
    await svc.handleDecision(decision());
    const trade = [...repo.trades.values()][0];
    assert.strictEqual(trade.state, "OPEN");
    assert.strictEqual(trade.entryPrice, 0.1);
    assert.ok(Math.abs(trade.tpPrice! - (0.1 + 2.2 * 0.001)) < 1e-12);
    assert.ok(t.msgs[0].includes("ENTRY") && t.msgs[0].includes("PAPER"));
    const store = svc.engines.get("DOGEUSDT")!.store;
    store.addOiObservation(T0 + 70_000, T0 + 70_000, 1, 0.1005);
    store.addOiObservation(T0 + 130_000, T0 + 130_000, 1, 0.0989); // below SL in the minute after
    now.t = T0 + 190_000;
    await svc.monitorPaper("DOGEUSDT", svc.engines.get("DOGEUSDT"), now.t);
    const closed = repo.trades.get(trade.tradeId)!;
    assert.strictEqual(closed.state, "CLOSED");
    assert.strictEqual(closed.closeReason, "SL_FILLED");
    // -1R minus simulated taker+taker fees on the notional (10 / 0.001 * 0.1 = $1000 -> $1.00)
    assert.ok(Math.abs(closed.pnlUsd! - (-10 - 1)) < 1e-9, `pnl ${closed.pnlUsd}`);
    assert.ok(Math.abs(closed.feesUsd! - 1) < 1e-9);
    assert.ok(t.msgs[1].includes("STOP LOSS") && t.msgs[1].includes("❌"));
    assert.ok(t.msgs[0].startsWith("🔵"), "entry is blue");
  });

  await scenario("FORCED filter: a forcedOnly user skips a weak-cleaning signal silently (no Telegram), others still trade it", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 }, tk = tg(), tm = tg();
    const svc = service([
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: tm },
      { userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: tk },
    ], repo, now, { forcedOnlyUsers: new Set(["karo"]) });
    await svc.handleDecision({ ...decision(), quality: { forcedPct: 1.7, forcedMedianPct: 6.3, weak: true } });
    const byUser = new Map([...repo.trades.values()].map((x) => [x.userId, x]));
    assert.strictEqual(byUser.get("main")!.state, "OPEN");
    assert.strictEqual(byUser.get("karo")!.state, "SKIPPED");
    assert.ok(byUser.get("karo")!.failureReason!.startsWith("FORCED_FILTER"));
    assert.strictEqual(tk.msgs.length, 0, "no Telegram message for a filtered signal");
    // a strong cleaning is taken by both
    const repo2 = new MemRepo(), svc2 = service([{ userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], repo2, now, { forcedOnlyUsers: new Set(["karo"]) });
    await svc2.handleDecision({ ...decision(), quality: { forcedPct: 9, forcedMedianPct: 6.3, weak: false } });
    assert.strictEqual([...repo2.trades.values()][0].state, "OPEN");
  });

  const frame = (verdict: "IN_ZONE" | "MIDDLE" | "NO_FRAME") => async () => ({
    verdict, pierced: false, pos: verdict === "MIDDLE" ? 44 : 5, tested: 0.0985, last: "PEAK" as const,
    top: { lo: 0.11, hi: 0.112 }, bottom: verdict === "NO_FRAME" ? null : { lo: 0.098, hi: 0.099 },
  });

  await scenario("FRAME filter: a frameOnly user skips a signal in the middle of the frame silently (no Telegram), main still trades it", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 }, tk = tg(), tm = tg();
    const svc = service([
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: tm },
      { userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: tk },
    ], repo, now, { frameOnlyUsers: new Set(["karo"]), frameSource: frame("MIDDLE") });
    await svc.handleDecision(decision());
    const byUser = new Map([...repo.trades.values()].map((x) => [x.userId, x]));
    assert.strictEqual(byUser.get("main")!.state, "OPEN");
    assert.strictEqual(byUser.get("karo")!.state, "SKIPPED");
    assert.ok(byUser.get("karo")!.failureReason!.startsWith("FRAME_FILTER: middle"), byUser.get("karo")!.failureReason!);
    assert.strictEqual(tk.msgs.length, 0, "no Telegram message for a filtered signal");
    assert.ok(!tm.msgs[0].includes("📦"), "the frame is not shown in Telegram any more");
    assert.strictEqual(repo.decisions[0].frame!.verdict, "MIDDLE", "the frame is stored with the decision");
  });

  await scenario("FRAME filter: in the zone -> taken by the frameOnly user; no frame / Binance down -> skipped", async () => {
    const now = { t: T0 + 10_000 };
    const repo = new MemRepo(), tk = tg();
    await service([{ userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: tk }], repo, now, { frameOnlyUsers: new Set(["karo"]), frameSource: frame("IN_ZONE") }).handleDecision(decision());
    assert.strictEqual([...repo.trades.values()][0].state, "OPEN");
    assert.ok(!tk.msgs[0].includes("📦"), tk.msgs[0]);
    const repo2 = new MemRepo();
    await service([{ userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], repo2, now, { frameOnlyUsers: new Set(["karo"]), frameSource: frame("NO_FRAME") }).handleDecision(decision());
    assert.strictEqual([...repo2.trades.values()][0].failureReason, "FRAME_FILTER: no 4h frame yet");
    const repo3 = new MemRepo(), tm = tg();
    await service([
      { userId: "karo", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null },
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: tm },
    ], repo3, now, { frameOnlyUsers: new Set(["karo"]), frameSource: async () => { throw new Error("binance down"); } }).handleDecision(decision());
    const by = new Map([...repo3.trades.values()].map((x) => [x.userId, x]));
    assert.strictEqual(by.get("karo")!.failureReason, "FRAME_FILTER: frame check unavailable");
    assert.strictEqual(by.get("main")!.state, "OPEN", "a failed frame check never blocks the others");
  });

  await scenario("TIME STOP (PAPER): no SL/TP after timeStopHours -> closed at the last price, TIME_STOP, taker fees", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 }, t = tg();
    const svc = service([{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t }], repo, now, { timeStopHours: 24 });
    await svc.handleDecision(decision());
    const store = svc.engines.get("DOGEUSDT")!.store;
    store.addOiObservation(T0 + 70_000, T0 + 70_000, 1, 0.1003);          // inside SL/TP
    now.t = T0 + 23 * 3_600_000;
    await svc.monitorPaper("DOGEUSDT", svc.engines.get("DOGEUSDT"), now.t);
    assert.strictEqual([...repo.trades.values()][0].state, "OPEN", "not yet 24h");
    now.t = T0 + 24 * 3_600_000 + 20_000;
    store.addOiObservation(now.t - 5_000, now.t - 5_000, 1, 0.1005);
    await svc.monitorPaper("DOGEUSDT", svc.engines.get("DOGEUSDT"), now.t);
    const c = [...repo.trades.values()][0];
    assert.strictEqual(c.closeReason, "TIME_STOP");
    assert.strictEqual(c.exitPrice, 0.1005);
    // qty 10000 x +0.0005 = +$5, minus taker+taker on $1000 = $1
    assert.ok(Math.abs(c.pnlUsd! - 4) < 1e-9, `pnl ${c.pnlUsd}`);
    assert.ok(t.msgs.at(-1)!.includes("TIME STOP"));
  });

  await scenario("TIME STOP (REAL): reduce-only MARKET close with the MARKET_EXIT id after 24h; reported as TIME_STOP", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 }, t = tg();
    const fills: unknown[] = [{ orderId: 1, side: "BUY", price: "0.1", qty: "1000", realizedPnl: "0", commission: "0.04", commissionAsset: "USDT", time: T0 + 11_000 }];
    const rest = mockRest({ fills: fills as never });
    const svc = service([{ userId: "karo", mode: "REAL", riskUsd: 1, binanceRest: rest as never, telegram: t, leverage: 20, marginMode: "ISOLATED" }], repo, now, { timeStopHours: 24 });
    await svc.handleDecision(decision());
    now.t = T0 + 2 * 3_600_000;
    await svc.monitorReal();
    assert.ok(!rest.calls.some((c) => c.fn === "createOrder" && (c.p as Record<string, unknown>).reduceOnly === "true" && (c.p as Record<string, unknown>).type === "MARKET"), "no close before 24h");
    now.t = T0 + 24 * 3_600_000 + 60_000;
    await svc.monitorReal();
    const close = rest.calls.find((c) => c.fn === "createOrder" && (c.p as Record<string, unknown>).type === "MARKET" && (c.p as Record<string, unknown>).reduceOnly === "true");
    assert.ok(close, "market reduce-only close sent");
    assert.strictEqual((close!.p as Record<string, unknown>).side, "SELL");
    assert.ok(String((close!.p as Record<string, unknown>).newClientOrderId).startsWith("v9"));
    assert.ok([...repo.trades.values()][0].timeStopSentAt! > 0);
    // Binance: flat now, closing fill from the market order
    rest.setPosition("0");
    fills.push({ orderId: 555, side: "SELL", price: "0.1004", qty: "1000", realizedPnl: "0.4", commission: "0.04", commissionAsset: "USDT", time: now.t + 1_000 });
    now.t += 30_000;
    await svc.monitorReal();
    const c = [...repo.trades.values()][0];
    assert.strictEqual(c.state, "CLOSED");
    assert.strictEqual(c.closeReason, "TIME_STOP");
    assert.ok(t.msgs.at(-1)!.includes("TIME STOP"));
  });

  await scenario("PAPER: a same-minute SL and TP touch counts as SL (conservative)", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const svc = service([{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], repo, now);
    await svc.handleDecision(decision());
    const store = svc.engines.get("DOGEUSDT")!.store;
    store.addOiObservation(T0 + 70_000, T0 + 70_000, 1, 0.1030);
    store.addOiObservation(T0 + 80_000, T0 + 80_000, 1, 0.0985);
    now.t = T0 + 200_000;
    await svc.monitorPaper("DOGEUSDT", svc.engines.get("DOGEUSDT"), now.t);
    assert.strictEqual([...repo.trades.values()][0].closeReason, "SL_FILLED");
  });

  await scenario("REAL: production entry sequence; TP from the actual fill; close from Binance fills; leftover SL cancelled", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 }, t = tg();
    const rest = mockRest({ fills: [
      { orderId: 1, side: "BUY", price: "0.1", qty: "1000", realizedPnl: "0", commission: "0.04", commissionAsset: "USDT", time: T0 + 11_000 },
      { orderId: 77, side: "SELL", price: "0.1022", qty: "1000", realizedPnl: "2.2", commission: "0.04", commissionAsset: "USDT", time: T0 + 900_000 },
    ] });
    const svc = service([{ userId: "karo", mode: "REAL", riskUsd: 1, binanceRest: rest as never, telegram: t, leverage: 20, marginMode: "ISOLATED" }], repo, now);
    await svc.handleDecision(decision());
    const trade = [...repo.trades.values()][0];
    assert.strictEqual(trade.state, "OPEN");
    assert.strictEqual(trade.entryInProgress, false);
    assert.ok(Math.abs(trade.tpPrice! - 0.1022) < 1e-12, `tp ${trade.tpPrice}`);
    assert.ok(rest.calls.some((c) => c.fn === "createAlgoOrder"));
    assert.ok(t.msgs[0].includes("REAL"));
    // still open -> nothing happens
    await svc.monitorReal();
    assert.strictEqual(repo.trades.get(trade.tradeId)!.state, "OPEN");
    // TP filled on Binance -> flat
    rest.setPosition("0");
    now.t = T0 + 1_000_000;
    await svc.monitorReal();
    const closed = repo.trades.get(trade.tradeId)!;
    assert.strictEqual(closed.state, "CLOSED");
    assert.strictEqual(closed.closeReason, "TP_FILLED");
    assert.ok(Math.abs(closed.pnlUsd! - (2.2 - 0.08)) < 1e-9);
    assert.ok(rest.calls.some((c) => c.fn === "cancelAlgoOrder" && c.p === 9), "resting SL cancelled");
    assert.ok(t.msgs[1].includes("TAKE PROFIT"));
  });

  await scenario("REAL: an existing position on the symbol -> SKIPPED, no order sent, user told", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 }, t = tg();
    const rest = mockRest({ positionAmt: "500" });
    const svc = service([{ userId: "karo", mode: "REAL", riskUsd: 1, binanceRest: rest as never, telegram: t }], repo, now);
    await svc.handleDecision(decision());
    assert.strictEqual([...repo.trades.values()][0].state, "SKIPPED");
    assert.ok(!rest.calls.some((c) => c.fn === "createOrder"));
    assert.ok(t.msgs[0].includes("NOT OPENED"));
  });

  await scenario("the same signal handled twice -> exactly one trade per user", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const svc = service([{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], repo, now);
    await svc.handleDecision(decision());
    await svc.handleDecision(decision());
    assert.strictEqual(repo.trades.size, 1);
  });

  await scenario("users are isolated: one Telegram failure does not stop the other user's trade or message", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 }, ok = tg();
    const broken = { sendMessage: async () => { throw new Error("telegram down"); } };
    const svc = service([
      { userId: "karo", mode: "PAPER", riskUsd: 1, binanceRest: null, telegram: broken },
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: ok },
    ], repo, now);
    await svc.handleDecision(decision());
    assert.strictEqual(repo.trades.size, 2);
    assert.strictEqual(ok.msgs.length, 1);
  });

  await scenario("a non-tradable decision is recorded for audit but opens nothing", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const svc = service([{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], repo, now);
    await svc.handleDecision(decision({ tradable: false, reason: "NOT_SELECTED" }));
    assert.strictEqual(repo.decisions.length, 1);
    assert.strictEqual(repo.trades.size, 0);
  });

  await scenario("symbol lock: while ANY user's trade on the symbol is open, a new signal (either side) opens nothing for anyone", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const users: V9UserRef[] = [
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null },
      { userId: "karo", mode: "PAPER", riskUsd: 1, binanceRest: null, telegram: null },
    ];
    const svc = service(users, repo, now);
    await svc.handleDecision(decision());
    // karo's trade closes, main's is still open -> structure not finished
    const karo = [...repo.trades.values()].find((t) => t.userId === "karo")!;
    await repo.updateTrade(karo.tradeId, { state: "CLOSED" });
    const later = decision({ episode: { ...decision().episode, confirmTs: T0 + 3_600_000, victim: "SHORT" }, tradeSide: "SHORT", stopPrice: 0.101 });
    await svc.handleDecision(later);
    assert.strictEqual(repo.trades.size, 2, "no new trades while main is still open");
    assert.strictEqual(repo.decisions.at(-1)!.reason, "SYMBOL_BUSY");
    // main closes -> symbol free -> next signal opens for everyone
    const main = [...repo.trades.values()].find((t) => t.userId === "main")!;
    await repo.updateTrade(main.tradeId, { state: "CLOSED" });
    await svc.handleDecision(decision({ episode: { ...decision().episode, confirmTs: T0 + 7_200_000 } }));
    assert.strictEqual(repo.trades.size, 4);
  });

  await scenario("MAX OPEN: karo limited to 2 open trades (all coins) -> the 3rd signal is skipped for karo only, with a Telegram note; main takes everything", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const kt = tg();
    const users: V9UserRef[] = [
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null },
      { userId: "karo", mode: "PAPER", riskUsd: 1, binanceRest: null, telegram: kt },
    ];
    const svc = service(users, repo, now, { maxOpenPerUser: new Map([["karo", 2]]) });
    await svc.handleDecision(decision({ symbol: "DOGEUSDT" }));
    await svc.handleDecision(decision({ symbol: "ETHUSDT" }));
    await svc.handleDecision(decision({ symbol: "SOLUSDT", tradeSide: "SHORT", stopPrice: 0.101 }));
    const of = (u: string) => [...repo.trades.values()].filter((t) => t.userId === u);
    assert.strictEqual(of("main").filter((t) => t.state === "OPEN").length, 3, "main is never limited");
    assert.strictEqual(of("karo").filter((t) => t.state === "OPEN").length, 2);
    const skipped = of("karo").find((t) => t.state === "SKIPPED")!;
    assert.strictEqual(skipped.symbol, "SOLUSDT");
    assert.match(skipped.failureReason!, /^MAX_OPEN: 2 V9 trades already open/);
    assert.ok(kt.msgs.at(-1)!.includes("NOT OPENED") && kt.msgs.at(-1)!.includes("MAX_OPEN"));
    // one of karo's trades closes -> the next signal is taken again
    await repo.updateTrade(of("karo").find((t) => t.symbol === "DOGEUSDT")!.tradeId, { state: "CLOSED" });
    await svc.handleDecision(decision({ symbol: "BTCUSDT" }));
    assert.strictEqual(of("karo").find((t) => t.symbol === "BTCUSDT")!.state, "OPEN");
    assert.strictEqual(of("karo").filter((t) => t.state === "OPEN").length, 2);
  });

  await scenario("PER USER: karo TP 1.5R, main keeps 2.2R; karo's min stop skips a signal with a closer SL silently (no slot, no Telegram)", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const kt = tg();
    const users: V9UserRef[] = [
      { userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null },
      { userId: "karo", mode: "PAPER", riskUsd: 1, binanceRest: null, telegram: kt },
    ];
    const svc = service(users, repo, now, { rrPerUser: new Map([["karo", 1.5]]), minStopPerUser: new Map([["karo", 0.7]]), maxOpenPerUser: new Map([["karo", 1]]) });
    await svc.handleDecision(decision({ symbol: "ETHUSDT", stopPrice: 0.0995 })); // SL 0.5% -> karo skips
    const karoEth = [...repo.trades.values()].find((t) => t.userId === "karo" && t.symbol === "ETHUSDT")!;
    assert.strictEqual(karoEth.state, "SKIPPED");
    assert.match(karoEth.failureReason!, /^MIN_STOP: SL 0\.50%/);
    assert.strictEqual(kt.msgs.length, 0, "min-stop skip is silent");
    await svc.handleDecision(decision()); // SL 1% -> taken, and the skipped ETH did not use karo's only slot
    const karo = [...repo.trades.values()].find((t) => t.userId === "karo" && t.symbol === "DOGEUSDT")!;
    const main = [...repo.trades.values()].find((t) => t.userId === "main" && t.symbol === "DOGEUSDT")!;
    assert.strictEqual(karo.state, "OPEN");
    assert.strictEqual(karo.rr, 1.5);
    assert.ok(Math.abs(karo.tpPrice! - 0.1015) < 1e-12, `karo TP ${karo.tpPrice}`);
    assert.strictEqual(main.rr, 2.2);
    assert.ok(Math.abs(main.tpPrice! - 0.1022) < 1e-12);
    assert.ok(kt.msgs[0].includes("RR 1.5"));
  });

  const LOCK = { profitLock: { atR: 1.5, toR: 1.5 } };

  await scenario("PROFIT LOCK (PAPER): +1.5R reached -> SL moved to +1.5R (Telegram); back there -> PROFIT_STOP at +1.5R", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 }, t = tg();
    const svc = service([{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: t }], repo, now, LOCK);
    await svc.handleDecision(decision()); // entry 0.1, SL 0.099, TP 0.1022, lock at 0.1015
    const id = [...repo.trades.values()][0].tradeId;
    assert.deepStrictEqual(repo.trades.get(id)!.lock, { atR: 1.5, toR: 1.5 });
    const store = svc.engines.get("DOGEUSDT")!.store;
    store.addOiObservation(T0 + 70_000, T0 + 70_000, 1, 0.1016); // minute 1: through +1.5R, closes above it
    now.t = T0 + 130_000;
    await svc.monitorPaper("DOGEUSDT", svc.engines.get("DOGEUSDT"), now.t);
    let tr = repo.trades.get(id)!;
    assert.strictEqual(tr.state, "OPEN");
    assert.ok(Math.abs(tr.slPrice - 0.1015) < 1e-12 && tr.slInitial === 0.099 && tr.lockedAt === T0 + 120_000);
    assert.ok(t.msgs[1].includes("SL MOVED"), t.msgs[1]);
    // the next run must not move / announce it again
    await svc.monitorPaper("DOGEUSDT", svc.engines.get("DOGEUSDT"), now.t);
    assert.strictEqual(t.msgs.length, 2);
    store.addOiObservation(T0 + 130_000, T0 + 130_000, 1, 0.1012); // minute 2: back below +1.5R
    now.t = T0 + 190_000;
    await svc.monitorPaper("DOGEUSDT", svc.engines.get("DOGEUSDT"), now.t);
    tr = repo.trades.get(id)!;
    assert.strictEqual(tr.closeReason, "PROFIT_STOP");
    assert.strictEqual(tr.exitPrice, 0.1015);
    assert.ok(Math.abs(tr.pnlUsd! - (15 - 1)) < 1e-6, `pnl ${tr.pnlUsd}`); // +1.5R minus taker+taker on $1000
    assert.ok(t.msgs[2].includes("PROFIT STOP") && !t.msgs[2].includes("STOP LOSS"));
  });

  await scenario("PROFIT LOCK (PAPER): after the lock the price goes on -> TP 2.2R; without profitLock nothing changes", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const svc = service([{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], repo, now, LOCK);
    await svc.handleDecision(decision());
    const id = [...repo.trades.values()][0].tradeId;
    const store = svc.engines.get("DOGEUSDT")!.store;
    store.addOiObservation(T0 + 70_000, T0 + 70_000, 1, 0.1016);
    store.addOiObservation(T0 + 130_000, T0 + 130_000, 1, 0.1023);
    now.t = T0 + 190_000;
    await svc.monitorPaper("DOGEUSDT", svc.engines.get("DOGEUSDT"), now.t);
    assert.strictEqual(repo.trades.get(id)!.closeReason, "TP_FILLED");
    // rr at or below atR (karo 1.5) -> no lock on that trade
    const repo2 = new MemRepo();
    const svc2 = service([{ userId: "karo", mode: "PAPER", riskUsd: 1, binanceRest: null, telegram: null }], repo2, { t: T0 + 10_000 }, { ...LOCK, rrPerUser: new Map([["karo", 1.5]]) });
    await svc2.handleDecision(decision());
    assert.strictEqual([...repo2.trades.values()][0].lock, null);
  });

  function lockRest(over: { createFails?: boolean; verifyFails?: boolean } = {}) {
    const rest = mockRest({ fills: [
      { orderId: 1, side: "BUY", price: "0.1", qty: "1000", realizedPnl: "0", commission: "0.05", commissionAsset: "USDT", time: T0 + 11_000 },
      { orderId: 555, side: "SELL", price: "0.1015", qty: "1000", realizedPnl: "1.5", commission: "0.05", commissionAsset: "USDT", time: T0 + 900_000 },
    ] });
    let bid = "0.1003", algo = 9;
    const r = rest as unknown as Record<string, unknown>;
    r.getBookTicker = async () => ({ askPrice: bid, bidPrice: bid });
    r.createAlgoOrder = async (p: Record<string, unknown>) => {
      rest.calls.push({ fn: "createAlgoOrder", p });
      if (algo > 9 && over.createFails) throw new Error("Order would immediately trigger.");
      return { algoId: algo++ };
    };
    r.getAlgoOrderByClientId = async () => null;
    r.getAlgoOrder = async (id: number) => (id === 10 && over.verifyFails ? { algoStatus: "CANCELED" } : { algoStatus: "NEW", actualOrderId: id === 10 ? 555 : "" });
    return { rest, setBid: (b: string) => { bid = b; } };
  }

  await scenario("PROFIT LOCK (REAL): new stop placed FIRST, confirmed, saved, THEN the old one cancelled; close reported as PROFIT_STOP", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 }, t = tg();
    const { rest, setBid } = lockRest();
    const svc = service([{ userId: "karo", mode: "REAL", riskUsd: 1, binanceRest: rest as never, telegram: t, leverage: 20, marginMode: "ISOLATED" }], repo, now, LOCK);
    await svc.handleDecision(decision());
    const id = [...repo.trades.values()][0].tradeId;
    await svc.monitorReal(); // bid 0.1003 < 0.1015 -> nothing
    assert.strictEqual(rest.calls.filter((c) => c.fn === "createAlgoOrder").length, 1);
    setBid("0.1016");
    await svc.monitorReal();
    const algos = rest.calls.filter((c) => c.fn === "createAlgoOrder");
    assert.strictEqual(algos.length, 2);
    const p = algos[1].p as Record<string, string>;
    assert.deepStrictEqual([p.type, p.side, p.triggerPrice, p.reduceOnly, p.quantity], ["STOP_MARKET", "SELL", "0.10150", "true", String(repo.trades.get(id)!.quantity)]);
    const iNew = rest.calls.indexOf(algos[1]), iCancel = rest.calls.findIndex((c) => c.fn === "cancelAlgoOrder" && c.p === 9);
    assert.ok(iCancel > iNew, "old SL cancelled only after the new one exists");
    let tr = repo.trades.get(id)!;
    assert.strictEqual(tr.binance!.slAlgoId, 10);
    assert.strictEqual(tr.binance!.slOldAlgoId, undefined, "old SL gone from Binance -> cleared");
    assert.ok(tr.lockedAt && tr.slPrice === 0.1015 && tr.slInitial === 0.099);
    assert.ok(t.msgs.some((m) => m.includes("SL MOVED")));
    // next cycle: already locked -> no new orders
    await svc.monitorReal();
    assert.strictEqual(rest.calls.filter((c) => c.fn === "createAlgoOrder").length, 2);
    // the moved stop fills -> flat
    rest.setPosition("0");
    now.t = T0 + 1_000_000;
    await svc.monitorReal();
    tr = repo.trades.get(id)!;
    assert.strictEqual(tr.closeReason, "PROFIT_STOP");
    assert.ok(t.msgs.at(-1)!.includes("PROFIT STOP"));
  });

  await scenario("PROFIT LOCK (REAL): Binance rejects the new stop -> the original SL stays, nothing cancelled, retried later", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const { rest, setBid } = lockRest({ createFails: true });
    const svc = service([{ userId: "karo", mode: "REAL", riskUsd: 1, binanceRest: rest as never, telegram: null }], repo, now, LOCK);
    await svc.handleDecision(decision());
    const id = [...repo.trades.values()][0].tradeId;
    setBid("0.1016");
    await svc.monitorReal();
    const tr = repo.trades.get(id)!;
    assert.ok(!tr.lockedAt && tr.slPrice === 0.099 && tr.binance!.slAlgoId === 9);
    assert.ok(!rest.calls.some((c) => c.fn === "cancelAlgoOrder"), "the original SL is never touched");
    assert.ok(!rest.calls.some((c) => c.fn === "createOrder" && (c.p as Record<string, unknown>).type === "MARKET" && (c.p as Record<string, unknown>).reduceOnly), "no market close");
  });

  await scenario("PROFIT LOCK (REAL): the new stop cannot be confirmed -> it is cancelled, the original SL stays", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const { rest, setBid } = lockRest({ verifyFails: true });
    const svc = service([{ userId: "karo", mode: "REAL", riskUsd: 1, binanceRest: rest as never, telegram: null }], repo, now, LOCK);
    await svc.handleDecision(decision());
    const id = [...repo.trades.values()][0].tradeId;
    setBid("0.1016");
    await svc.monitorReal();
    const tr = repo.trades.get(id)!;
    assert.ok(!tr.lockedAt && tr.binance!.slAlgoId === 9);
    assert.ok(rest.calls.some((c) => c.fn === "cancelAlgoOrder" && c.p === 10), "unconfirmed new stop cancelled");
    assert.ok(!rest.calls.some((c) => c.fn === "cancelAlgoOrder" && c.p === 9), "original SL kept");
  });

  await scenario("PROFIT LOCK (REAL SHORT): ask at -1.5R -> BUY stop at entry - 1.5R", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const { rest, setBid } = lockRest();
    const svc = service([{ userId: "karo", mode: "REAL", riskUsd: 1, binanceRest: rest as never, telegram: null }], repo, now, LOCK);
    await svc.handleDecision(decision({ tradeSide: "SHORT", stopPrice: 0.101 }));
    const id = [...repo.trades.values()][0].tradeId;
    setBid("0.0990"); // not yet: lock at 0.0985
    await svc.monitorReal();
    assert.strictEqual(rest.calls.filter((c) => c.fn === "createAlgoOrder").length, 1);
    setBid("0.0984");
    await svc.monitorReal();
    const p = rest.calls.filter((c) => c.fn === "createAlgoOrder")[1].p as Record<string, string>;
    assert.deepStrictEqual([p.side, p.triggerPrice], ["BUY", "0.09850"]);
    assert.strictEqual(repo.trades.get(id)!.slPrice, 0.0985);
  });

  await scenario("PROFIT LOCK (REAL): crash after placing the moved stop -> next cycle adopts it even if the price fell back", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const { rest, setBid } = lockRest();
    const svc = service([{ userId: "karo", mode: "REAL", riskUsd: 1, binanceRest: rest as never, telegram: null }], repo, now, LOCK);
    await svc.handleDecision(decision());
    const tr0 = [...repo.trades.values()][0];
    // state after the crash: pending flag saved, rev-1 stop resting on Binance, nothing else saved
    await repo.updateTrade(tr0.tradeId, { lockPending: true });
    const { strategyClientOrderId } = await import("../src/execution/client-order-id");
    const rev1 = strategyClientOrderId("karo", tr0.signalId, "STOP_LOSS", 1);
    (rest as unknown as Record<string, unknown>).getOpenAlgoOrders = async () => [{ algoId: 10, clientAlgoId: rev1 }];
    setBid("0.1005"); // fell back below the lock level
    await svc.monitorReal();
    const tr = repo.trades.get(tr0.tradeId)!;
    assert.strictEqual(rest.calls.filter((c) => c.fn === "createAlgoOrder").length, 1, "not placed twice");
    assert.ok(tr.lockedAt && tr.binance!.slAlgoId === 10 && tr.slPrice === 0.1015 && tr.lockPending === false);
  });

  await scenario("REAL flat: an unrecorded moved stop still resting is cancelled; the close waits until none of our stops is listed", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const { rest } = lockRest();
    const svc = service([{ userId: "karo", mode: "REAL", riskUsd: 1, binanceRest: rest as never, telegram: null }], repo, now, LOCK);
    await svc.handleDecision(decision());
    const tr0 = [...repo.trades.values()][0];
    const { strategyClientOrderId } = await import("../src/execution/client-order-id");
    const rev1 = strategyClientOrderId("karo", tr0.signalId, "STOP_LOSS", 1);
    let listed = true;
    const r = rest as unknown as Record<string, unknown>;
    r.getOpenAlgoOrders = async () => (listed ? [{ algoId: 10, clientAlgoId: rev1 }] : []);
    r.cancelAlgoOrder = async (id: number) => { rest.calls.push({ fn: "cancelAlgoOrder", p: id }); if (id === 10) listed = false; return {}; };
    r.getAlgoOrderByClientId = async () => ({ algoStatus: "NEW" });
    rest.setPosition("0"); // closed by the original TP / SL
    now.t = T0 + 1_000_000;
    await svc.monitorReal();
    assert.ok(rest.calls.some((c) => c.fn === "cancelAlgoOrder" && c.p === 10), "orphan moved stop cancelled");
    assert.strictEqual(repo.trades.get(tr0.tradeId)!.state, "CLOSED");
  });

  await scenario("PROFIT LOCK (PAPER): a saved lock is kept even when its minute is no longer in memory", async () => {
    const repo = new MemRepo(), now = { t: T0 + 10_000 };
    const svc = service([{ userId: "main", mode: "PAPER", riskUsd: 10, binanceRest: null, telegram: null }], repo, now, LOCK);
    await svc.handleDecision(decision());
    const id = [...repo.trades.values()][0].tradeId;
    await repo.updateTrade(id, { lockedAt: T0 + 120_000, slInitial: 0.099, slPrice: 0.1015 }); // locked in a minute we no longer have
    svc.engines.get("DOGEUSDT")!.store.addOiObservation(T0 + 130_000, T0 + 130_000, 1, 0.1005);
    now.t = T0 + 190_000;
    await svc.monitorPaper("DOGEUSDT", svc.engines.get("DOGEUSDT"), now.t);
    assert.strictEqual(repo.trades.get(id)!.closeReason, "PROFIT_STOP");
  });

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
