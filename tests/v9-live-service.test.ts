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
import {
  V9LiveService,
  type V9UserRef,
} from "../src/strategy/v9/v9-live.service";
import type {
  V9Repository,
  V9TradeDoc,
  V9DecisionDoc,
} from "../src/strategy/v9/v9-repository";
import type { V9MongoFeed } from "../src/strategy/v9/v9-feed";
import type { V9Decision } from "../src/strategy/v9/v9-causal-engine";

let passed = 0,
  failed = 0;
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(
      `  \u2717 ${name}\n      ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
  }
}

class MemRepo {
  trades = new Map<string, V9TradeDoc>();
  decisions: V9DecisionDoc[] = [];
  async ensureIndexes(): Promise<void> {}
  async insertDecision(d: V9DecisionDoc): Promise<void> {
    this.decisions.push(d);
  }
  async insertTrade(t: V9TradeDoc): Promise<boolean> {
    if (this.trades.has(t.tradeId)) return false;
    this.trades.set(t.tradeId, { ...t });
    return true;
  }
  async updateTrade(id: string, f: Partial<V9TradeDoc>): Promise<void> {
    const t = this.trades.get(id)!;
    this.trades.set(id, { ...t, ...f });
  }
  async findOpenTrades(): Promise<V9TradeDoc[]> {
    return [...this.trades.values()]
      .filter((t) => t.state === "OPEN")
      .map((t) => ({ ...t }));
  }
  async hasOpenTrade(u: string, s: string): Promise<boolean> {
    return [...this.trades.values()].some(
      (t) => t.userId === u && t.symbol === s && t.state === "OPEN",
    );
  }
}
const noFeed = {
  warmUp: async () => ({ liq: 0, oi: 0 }),
  poll: async () => ({ liq: 0, oi: 0 }),
} as unknown as V9MongoFeed;

function tg() {
  const msgs: string[] = [];
  return {
    msgs,
    sendMessage: async (t: string) => {
      msgs.push(t);
    },
  };
}

const T0 = 1_790_200_000_000 - (1_790_200_000_000 % 60_000);
function decision(over: Partial<V9Decision> = {}): V9Decision {
  return {
    symbol: "DOGEUSDT",
    episode: {
      start: T0 - 3_600_000,
      end: T0 - 600_000,
      sIdx: 0,
      eIdx: 10,
      victim: "LONG",
      long: 5e6,
      short: 1e5,
      count: 50,
      startOi: 1,
      minOi: 0.99,
      oiDropPct: 1.2,
      startPrice: 0.105,
      endPrice: 0.1,
      extremePrice: 0.099,
      priceMovePct: -4.7,
      confirmTs: T0 - 60_000,
      endReason: "OPPOSITE_EPISODE",
      parts: 2,
      partRanges: [
        [0, 5],
        [5, 10],
      ],
      rightCensored: false,
    },
    features: {
      dom: true,
      dir: true,
      exh: true,
      dirMove: 4.7,
      clr: 0.9,
      victimLiq: 5e6,
      oppLiq: 1e5,
      peakTs: T0 - 1_800_000,
      preEff: 2,
      postEff: 0.1,
    },
    reference: { medianClr: 0.5, medianMove: 0.6, sampleCount: 20 },
    selection: {
      selected: true,
      checks: { DOM: true, DIR: true, CLR: true, MOV: true, EXH: true },
    },
    tradable: true,
    reason: "SELECTED",
    evaluatedAt: T0 + 10_000,
    tradeSide: "LONG",
    stopPrice: 0.099,
    referencePrice: 0.1,
    ...over,
  };
}

function mockRest(
  opts: { positionAmt?: string; fills?: unknown[]; slStatus?: string } = {},
) {
  const calls: Array<{ fn: string; p?: unknown }> = [];
  let position = opts.positionAmt ?? "0";
  const rest = {
    calls,
    setPosition: (v: string) => {
      position = v;
    },
    getExchangeInfo: async () => ({
      symbols: [
        {
          symbol: "DOGEUSDT",
          pricePrecision: 5,
          quantityPrecision: 0,
          filters: [
            { filterType: "PRICE_FILTER", tickSize: "0.00001" },
            { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" },
            { filterType: "MIN_NOTIONAL", notional: "5" },
          ],
        },
      ],
    }),
    getBookTicker: async () => ({ askPrice: "0.1", bidPrice: "0.09999" }),
    setMarginType: async () => ({}),
    setLeverage: async () => ({}),
    createOrder: async (p: Record<string, unknown>) => {
      calls.push({ fn: "createOrder", p });
      if (p.type === "MARKET" && !p.reduceOnly) {
        position = String(p.quantity);
        return { orderId: 1, avgPrice: "0.1", executedQty: String(p.quantity) };
      }
      return { orderId: 77 };
    },
    createAlgoOrder: async (p: unknown) => {
      calls.push({ fn: "createAlgoOrder", p });
      return { algoId: 9 };
    },
    getAlgoOrder: async () => ({
      algoStatus: opts.slStatus ?? "NEW",
      actualOrderId: "",
    }),
    getAlgoOrderByClientId: async () => ({ algoStatus: "NEW" }),
    cancelAlgoOrder: async (id: number) => {
      calls.push({ fn: "cancelAlgoOrder", p: id });
      return {};
    },
    cancelOrder: async (_s: string, id: number) => {
      calls.push({ fn: "cancelOrder", p: id });
      return {};
    },
    getOrder: async () => ({ status: "NEW" }),
    getPositionRisk: async () => [
      { symbol: "DOGEUSDT", positionAmt: position, entryPrice: "0.1" },
    ],
    getOpenOrders: async () => [],
    getOpenAlgoOrders: async () => [],
    getUserTrades: async () => opts.fills ?? [],
  };
  return rest;
}

function service(users: V9UserRef[], repo: MemRepo, now: { t: number }) {
  const svc = new V9LiveService(
    { enabled: true, symbols: ["DOGEUSDT"], rr: 2.2, userModes: new Map() },
    () => users,
    noFeed,
    repo as unknown as V9Repository,
    undefined,
    () => now.t,
  );
  (svc as unknown as { ready: boolean }).ready = true;
  return svc as unknown as {
    handleDecision(d: V9Decision): Promise<void>;
    monitorPaper(symbol: string, engine: unknown, now: number): Promise<void>;
    monitorReal(): Promise<void>;
    engines: Map<
      string,
      {
        store: {
          addOiObservation(ts: number, u: number, oi: number, p: number): void;
        };
      }
    >;
  };
}

async function run(): Promise<void> {
  console.log("V9 live service");

  await scenario(
    "PAPER: opens at the reference price with 2.2R TP; closes on SL from minute lows; Telegram both times",
    async () => {
      const repo = new MemRepo(),
        now = { t: T0 + 10_000 },
        t = tg();
      const svc = service(
        [
          {
            userId: "main",
            mode: "PAPER",
            riskUsd: 10,
            binanceRest: null,
            telegram: t,
          },
        ],
        repo,
        now,
      );
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
      assert.ok(
        Math.abs(closed.pnlUsd! - (-10 - 1)) < 1e-9,
        `pnl ${closed.pnlUsd}`,
      );
      assert.ok(Math.abs(closed.feesUsd! - 1) < 1e-9);
      assert.ok(t.msgs[1].includes("STOP LOSS") && t.msgs[1].includes("❌"));
      assert.ok(t.msgs[0].startsWith("🔵"), "entry is blue");
    },
  );

  await scenario(
    "PAPER: a same-minute SL and TP touch counts as SL (conservative)",
    async () => {
      const repo = new MemRepo(),
        now = { t: T0 + 10_000 };
      const svc = service(
        [
          {
            userId: "main",
            mode: "PAPER",
            riskUsd: 10,
            binanceRest: null,
            telegram: null,
          },
        ],
        repo,
        now,
      );
      await svc.handleDecision(decision());
      const store = svc.engines.get("DOGEUSDT")!.store;
      store.addOiObservation(T0 + 70_000, T0 + 70_000, 1, 0.103);
      store.addOiObservation(T0 + 80_000, T0 + 80_000, 1, 0.0985);
      now.t = T0 + 200_000;
      await svc.monitorPaper("DOGEUSDT", svc.engines.get("DOGEUSDT"), now.t);
      assert.strictEqual([...repo.trades.values()][0].closeReason, "SL_FILLED");
    },
  );

  await scenario(
    "REAL: production entry sequence; TP from the actual fill; close from Binance fills; leftover SL cancelled",
    async () => {
      const repo = new MemRepo(),
        now = { t: T0 + 10_000 },
        t = tg();
      const rest = mockRest({
        fills: [
          {
            orderId: 1,
            side: "BUY",
            price: "0.1",
            qty: "1000",
            realizedPnl: "0",
            commission: "0.04",
            commissionAsset: "USDT",
            time: T0 + 11_000,
          },
          {
            orderId: 77,
            side: "SELL",
            price: "0.1022",
            qty: "1000",
            realizedPnl: "2.2",
            commission: "0.04",
            commissionAsset: "USDT",
            time: T0 + 900_000,
          },
        ],
      });
      const svc = service(
        [
          {
            userId: "karo",
            mode: "REAL",
            riskUsd: 1,
            binanceRest: rest as never,
            telegram: t,
            leverage: 20,
            marginMode: "ISOLATED",
          },
        ],
        repo,
        now,
      );
      await svc.handleDecision(decision());
      const trade = [...repo.trades.values()][0];
      assert.strictEqual(trade.state, "OPEN");
      assert.strictEqual(trade.entryInProgress, false);
      assert.ok(
        Math.abs(trade.tpPrice! - 0.1022) < 1e-12,
        `tp ${trade.tpPrice}`,
      );
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
      assert.ok(
        rest.calls.some((c) => c.fn === "cancelAlgoOrder" && c.p === 9),
        "resting SL cancelled",
      );
      assert.ok(t.msgs[1].includes("TAKE PROFIT"));
    },
  );

  await scenario(
    "REAL: an existing position on the symbol -> SKIPPED, no order sent, user told",
    async () => {
      const repo = new MemRepo(),
        now = { t: T0 + 10_000 },
        t = tg();
      const rest = mockRest({ positionAmt: "500" });
      const svc = service(
        [
          {
            userId: "karo",
            mode: "REAL",
            riskUsd: 1,
            binanceRest: rest as never,
            telegram: t,
          },
        ],
        repo,
        now,
      );
      await svc.handleDecision(decision());
      assert.strictEqual([...repo.trades.values()][0].state, "SKIPPED");
      assert.ok(!rest.calls.some((c) => c.fn === "createOrder"));
      assert.ok(t.msgs[0].includes("NOT OPENED"));
    },
  );

  await scenario(
    "the same signal handled twice -> exactly one trade per user",
    async () => {
      const repo = new MemRepo(),
        now = { t: T0 + 10_000 };
      const svc = service(
        [
          {
            userId: "main",
            mode: "PAPER",
            riskUsd: 10,
            binanceRest: null,
            telegram: null,
          },
        ],
        repo,
        now,
      );
      await svc.handleDecision(decision());
      await svc.handleDecision(decision());
      assert.strictEqual(repo.trades.size, 1);
    },
  );

  await scenario(
    "users are isolated: one Telegram failure does not stop the other user's trade or message",
    async () => {
      const repo = new MemRepo(),
        now = { t: T0 + 10_000 },
        ok = tg();
      const broken = {
        sendMessage: async () => {
          throw new Error("telegram down");
        },
      };
      const svc = service(
        [
          {
            userId: "karo",
            mode: "PAPER",
            riskUsd: 1,
            binanceRest: null,
            telegram: broken,
          },
          {
            userId: "main",
            mode: "PAPER",
            riskUsd: 10,
            binanceRest: null,
            telegram: ok,
          },
        ],
        repo,
        now,
      );
      await svc.handleDecision(decision());
      assert.strictEqual(repo.trades.size, 2);
      assert.strictEqual(ok.msgs.length, 1);
    },
  );

  await scenario(
    "a non-tradable decision is recorded for audit but opens nothing",
    async () => {
      const repo = new MemRepo(),
        now = { t: T0 + 10_000 };
      const svc = service(
        [
          {
            userId: "main",
            mode: "PAPER",
            riskUsd: 10,
            binanceRest: null,
            telegram: null,
          },
        ],
        repo,
        now,
      );
      await svc.handleDecision(
        decision({ tradable: false, reason: "NOT_SELECTED" }),
      );
      assert.strictEqual(repo.decisions.length, 1);
      assert.strictEqual(repo.trades.size, 0);
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
void run();
