/**
 * V10 · WALL (Oct 7 2026) -- the engine (= the research test's code), the config, the live PAPER flow, the live REAL flow
 * with a fake Binance, and the 24h time-out close.
 * Usage: npx tsx tests/v10-wall.test.ts
 */
import * as assert from "assert";
import type { MinBar } from "../src/research/dc15";
import { parseV10Settings, rulesFor } from "../src/strategy/v10/v10-config";
import {
  V10LiveService,
  type V10UserRef,
} from "../src/strategy/v10/v10-live.service";
import type {
  V10SignalDoc,
  V10Store,
  V10TradeDoc,
} from "../src/strategy/v10/v10-repository";
import {
  hourCandle,
  wallsAt,
  WallTracker,
  type WallData,
  type WCandle,
  type WLiq,
} from "../src/strategy/v10/wall-engine";
import type { WallSource } from "../src/strategy/v10/wall-data";
import { strategyClientOrderId } from "../src/execution/client-order-id";

let passed = 0,
  failed = 0;
async function scenario(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(
      `  ✗ ${name}\n      ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
  }
}
const M = 60_000,
  Q = 15 * M,
  H = 60 * M,
  D = 24 * H;
/** the end of the signal hour (hour B) */
const E = Date.UTC(2026, 9, 10, 12, 0);
const SYMS = ["BTCUSDT", "AAAUSDT", "BBBUSDT"];
const near = (a: number, b: number, eps = 1e-9): boolean =>
  Math.abs(a - b) <= eps;

/**
 * A market sitting at 105 for 15 days: 4h candles 103-107 (ATR 4 -> bands of 1), daily candles 100-110 (the field is all
 * of it). Longs liquidated at 101.5 / 100.5 -> the lower wall 100-102; shorts at 108.5 / 109.5 -> the upper wall 108-110.
 * Hour A (E-2h) touches the upper wall (high 108.5); hour B (E-1h) is wholly below it (high 107.5), closes 107.
 * After E the price stays at 107 (neither SL 110 nor TP 104.86 is hit).
 */
function market(
  opts: { liqAt?: number; noTouch?: boolean } = {},
): WallData & { firstLiqT: number | null } {
  const d1: WCandle[] = [],
    h4: WCandle[] = [],
    q15: WCandle[] = [];
  const day0 = Math.floor(E / D) * D;
  for (let i = 30; i >= 1; i--)
    d1.push({ t: day0 - i * D, o: 105, h: 110, l: 100, c: 105 });
  for (let t = E - 15 * D; t < E + 2 * D; t += 4 * H)
    h4.push({ t, o: 105, h: 107, l: 103, c: 105 });
  const A: Array<[number, number, number, number]> = opts.noTouch
    ? [
        [105, 105.2, 104.8, 105],
        [105, 105.2, 104.8, 105],
        [105, 105.2, 104.8, 105],
        [105, 107.6, 104.9, 107.1],
      ]
    : [
        [105, 107, 104.9, 106.8],
        [106.8, 108.5, 106.5, 107.5],
        [107.5, 108, 107, 107.2],
        [107.2, 107.6, 106.9, 107.1],
      ];
  const B: Array<[number, number, number, number]> = [
    [107.1, 107.5, 106.8, 107.2],
    [107.2, 107.4, 106.9, 107],
    [107, 107.3, 106.7, 106.9],
    [106.9, 107.2, 106.6, 107],
  ];
  for (let t = E - 15 * D; t < E + 30 * H; t += Q) {
    const k = Math.floor((t - (E - 2 * H)) / Q);
    const row =
      k >= 0 && k < 4
        ? A[k]
        : k >= 4 && k < 8
          ? B[k - 4]
          : t >= E
            ? ([107, 107.3, 106.7, 107] as [number, number, number, number])
            : ([105, 105.2, 104.8, 105] as [number, number, number, number]);
    q15.push({ t, o: row[0], h: row[1], l: row[2], c: row[3] });
  }
  const lt = opts.liqAt ?? E - 5 * D;
  const liqs: WLiq[] = [
    { t: lt, long: true, usd: 1000, p: 101.5 },
    { t: lt + 1, long: true, usd: 800, p: 100.5 },
    { t: lt + 2, long: true, usd: 100, p: 102.5 },
    { t: lt + 3, long: false, usd: 1000, p: 108.5 },
    { t: lt + 4, long: false, usd: 700, p: 109.5 },
    { t: lt + 5, long: false, usd: 100, p: 107.5 },
  ];
  return { d1, h4, q15, liqs, firstLiqT: lt };
}
const source = (a: ReturnType<typeof market>): WallSource => ({
  data: async (s) =>
    s === "AAAUSDT"
      ? a
      : { d1: [], h4: [], q15: [], liqs: [], firstLiqT: null },
});
/** our minute bars (freshness + PAPER exits): AAAUSDT at 107 from 10 min before E on */
function minuteBars(lastAt = E + 30 * H): Map<string, MinBar[]> {
  const a: MinBar[] = [];
  for (let t = E - 10 * M; t < lastAt; t += M)
    a.push({
      t,
      high: 107.1,
      low: 106.9,
      close: 107,
      oiFirst: 500,
      oiLast: 500,
    });
  return new Map([["AAAUSDT", a]]);
}
const loaderOf =
  (data: Map<string, MinBar[]>) =>
  async (symbol: string, from: number, to: number): Promise<MinBar[]> =>
    (data.get(symbol) ?? []).filter((b) => b.t >= from && b.t < to);
function fakeStore(): V10Store & {
  signals: V10SignalDoc[];
  trades: V10TradeDoc[];
} {
  const signals: V10SignalDoc[] = [],
    trades: V10TradeDoc[] = [];
  return {
    signals,
    trades,
    ensureIndexes: async () => undefined,
    insertSignal: async (d) => {
      if (signals.some((x) => x.signalId === d.signalId)) return false;
      signals.push({ ...d });
      return true;
    },
    insertTrade: async (d) => {
      if (trades.some((x) => x.tradeId === d.tradeId)) return false;
      trades.push({ ...d });
      return true;
    },
    updateTrade: async (id, f) => {
      const t = trades.find((x) => x.tradeId === id);
      if (t) Object.assign(t, f);
    },
    findOpenTrades: async () =>
      trades.filter((t) => t.state === "OPEN").map((t) => ({ ...t })),
    hasOpenV9Trade: async () => false,
    openV9TradeSince: async () => null,
  };
}
const tg = () => {
  const msgs: string[] = [];
  return {
    msgs,
    sendMessage: async (t: string) => {
      msgs.push(t);
    },
  };
};
const settings = (o: Record<string, unknown> = {}) =>
  parseV10Settings(
    {
      enabled: true,
      btc: false,
      own: false,
      wall: true,
      userModes: { main: "PAPER" },
      ...o,
    },
    ["main", "karo", "artak"],
    SYMS,
  );
const P = {
  kind: "WICK" as const,
  tpPct: 2,
  roomRatio: 1.33,
  maxStopPct: Infinity,
};

function fakeBinance(book: number, clock: () => number) {
  const st = {
    position: 0,
    entry: 0,
    orders: [] as Array<Record<string, string | number>>,
    algos: [] as Array<Record<string, string | number>>,
    fills: [] as Array<Record<string, unknown>>,
    nextId: 100,
    created: [] as Array<Record<string, string | number>>,
    filledOrders: new Set<number>(),
    triggered: new Map<number, number>(),
    marketThrows: false,
    byClient: new Map<string, Record<string, string | number>>(),
    allAlgos: [] as Array<Record<string, string | number>>,
    orderStatus: new Map<number, string>(),
  };
  const notExist = (): never => {
    throw new Error("Binance API error -2013: Order does not exist.");
  };
  const rest = {
    st,
    getExchangeInfo: async () => ({
      symbols: ["AAAUSDT", "BBBUSDT"].map((s) => ({
        symbol: s,
        pricePrecision: 4,
        quantityPrecision: 2,
        filters: [
          { filterType: "PRICE_FILTER", tickSize: "0.0001" },
          { filterType: "LOT_SIZE", stepSize: "0.01", minQty: "0.01" },
          { filterType: "MIN_NOTIONAL", notional: "5" },
        ],
      })),
    }),
    getBookTicker: async () => ({
      bidPrice: String(book),
      askPrice: String(book),
    }),
    getPositionRisk: async (symbol?: string) => [
      {
        symbol: symbol ?? "AAAUSDT",
        positionAmt: String(st.position),
        entryPrice: String(st.entry),
        marginType: "isolated",
      },
    ],
    setLeverage: async () => ({}),
    setMarginType: async () => ({}),
    createOrder: async (p: Record<string, string | number>) => {
      st.created.push(p);
      const id = st.nextId++;
      if (p.type === "MARKET") {
        const q = Number(p.quantity),
          sg = p.side === "SELL" ? -1 : 1;
        const pnl =
          p.reduceOnly === "true"
            ? st.position > 0
              ? (book - st.entry) * q
              : (st.entry - book) * q
            : 0;
        st.position = Number((st.position + sg * q).toFixed(8));
        if (p.reduceOnly !== "true") st.entry = book;
        st.fills.push({
          orderId: id,
          side: p.side,
          price: book,
          qty: q,
          realizedPnl: pnl,
          commission: 0.01,
          commissionAsset: "USDT",
          time: clock(),
        });
        if (p.newClientOrderId)
          st.byClient.set(String(p.newClientOrderId), {
            orderId: id,
            clientOrderId: p.newClientOrderId,
            status: "FILLED",
            executedQty: q,
            avgPrice: book,
          });
        if (st.marketThrows && p.reduceOnly !== "true")
          throw new Error("ETIMEDOUT (the order filled anyway)");
        return { orderId: id, avgPrice: String(book), executedQty: String(q) };
      }
      st.orders.push({ ...p, orderId: id, clientOrderId: p.newClientOrderId });
      if (p.newClientOrderId)
        st.byClient.set(String(p.newClientOrderId), {
          orderId: id,
          clientOrderId: p.newClientOrderId,
          executedQty: 0,
          avgPrice: 0,
        });
      return { orderId: id };
    },
    getOrder: async (_s: string, orderId: number) => ({
      orderId,
      status:
        st.orderStatus.get(orderId) ??
        (st.orders.some((o) => o.orderId === orderId)
          ? "NEW"
          : st.filledOrders.has(orderId)
            ? "FILLED"
            : "CANCELED"),
    }),
    getOrderByClientId: async (_s: string, cid: string) => {
      const o = st.byClient.get(cid) ?? notExist();
      const id = Number(o.orderId);
      return {
        ...o,
        status:
          o.status ??
          (st.orders.some((x) => x.orderId === id)
            ? "NEW"
            : st.filledOrders.has(id)
              ? "FILLED"
              : "CANCELED"),
      };
    },
    getOpenOrders: async () => st.orders,
    cancelOrder: async (_s: string, orderId: number) => {
      st.orders = st.orders.filter((o) => o.orderId !== orderId);
      return {};
    },
    createAlgoOrder: async (p: Record<string, string | number>) => {
      const algoId = st.nextId++;
      st.algos.push({ ...p, algoId });
      st.allAlgos.push({ ...p, algoId });
      st.created.push(p);
      return { algoId };
    },
    getAlgoOrder: async (algoId: number) => ({
      algoStatus: st.algos.some((a) => a.algoId === algoId)
        ? "NEW"
        : st.triggered.has(algoId)
          ? "FINISHED"
          : "CANCELED",
      actualOrderId: st.triggered.get(algoId),
    }),
    getAlgoOrderByClientId: async (cid: string) => {
      const a = st.allAlgos.find((x) => x.clientAlgoId === cid) ?? notExist();
      const algoId = Number(a.algoId);
      return {
        algoId,
        clientAlgoId: cid,
        algoStatus: st.algos.some((x) => x.algoId === algoId)
          ? "NEW"
          : st.triggered.has(algoId)
            ? "FINISHED"
            : "CANCELED",
        actualOrderId: st.triggered.get(algoId),
      };
    },
    getOpenAlgoOrders: async () => st.algos,
    cancelAlgoOrder: async (algoId: number) => {
      st.algos = st.algos.filter((a) => a.algoId !== algoId);
      return {};
    },
    getUserTrades: async () => st.fills,
    /** the TP limit fills at its price */
    fillTp(): void {
      const tp = st.orders.find((o) => o.type === "LIMIT")!;
      const q = Number(tp.quantity),
        px = Number(tp.price);
      st.fills.push({
        orderId: tp.orderId,
        side: tp.side,
        price: px,
        qty: q,
        realizedPnl: (st.entry - px) * q,
        commission: 0.005,
        commissionAsset: "USDT",
        time: clock(),
      });
      st.position = Number(
        (st.position + (tp.side === "BUY" ? q : -q)).toFixed(8),
      );
      st.orders = st.orders.filter((o) => o !== tp);
      st.filledOrders.add(Number(tp.orderId));
    },
    /** another trade's fill on the same symbol (e.g. V9 closing / opening) */
    foreignFill(
      side: "BUY" | "SELL",
      qty: number,
      price: number,
      realizedPnl: number,
    ): void {
      st.fills.push({
        orderId: 999_999,
        side,
        price,
        qty,
        realizedPnl,
        commission: 0.5,
        commissionAsset: "USDT",
        time: clock(),
      });
    },
  };
  return rest;
}
async function run(): Promise<void> {
  console.log("V10 · WALL");

  await scenario(
    "engine: the walls from our liquidations -- lower 100-102 (longs), upper 108-110 (shorts), the mode 105",
    () => {
      const W = wallsAt(market(), E - H)!;
      assert.ok(W && W.lower && W.upper);
      assert.deepStrictEqual(
        [W.lower!.lo, W.lower!.hi, W.upper!.lo, W.upper!.hi, W.mode],
        [100, 102, 108, 110, 105],
      );
      // nothing known before the liquidations -> no walls
      const early = wallsAt(market({ liqAt: E }), E - H)!;
      assert.deepStrictEqual([early.lower, early.upper], [null, null]);
    },
  );

  await scenario(
    "engine: WICK -- touch the upper wall, then a 1h candle wholly below it -> SHORT at its close, SL = the wall's top, TP 2%",
    () => {
      const m = market(),
        tr = new WallTracker();
      const a = tr.step(
        hourCandle(m.q15, E - 2 * H)!,
        wallsAt(m, E - 2 * H),
        P,
      );
      assert.strictEqual(a.signal, null);
      const b = tr.step(hourCandle(m.q15, E - H)!, wallsAt(m, E - H), P);
      const g = b.signal!;
      assert.ok(g, "a signal");
      assert.deepStrictEqual(
        [g.side, g.entry, g.stop, g.hs, g.candleEnd, g.touchedAt],
        ["SHORT", 107, 110, E - H, E, E - 2 * H],
      );
      assert.ok(
        near(g.tp, 107 * 0.98) &&
          near(g.riskPct, (100 * 3) / 107) &&
          near(g.roomX, 7 / 3),
      );
      // never touched -> no signal
      const n = market({ noTouch: true }),
        t2 = new WallTracker();
      t2.step(hourCandle(n.q15, E - 2 * H)!, wallsAt(n, E - 2 * H), P);
      assert.strictEqual(
        t2.step(hourCandle(n.q15, E - H)!, wallsAt(n, E - H), P).signal,
        null,
      );
    },
  );

  await scenario(
    "engine: no trade when the TP lies beyond the other wall, when the room is too small, or the SL too far; a changed wall forgets the touch",
    () => {
      const m = market(),
        ca = hourCandle(m.q15, E - 2 * H)!,
        cb = hourCandle(m.q15, E - H)!,
        Wa = wallsAt(m, E - 2 * H),
        Wb = wallsAt(m, E - H);
      const tryWith = (p: typeof P) => {
        const t = new WallTracker();
        t.step(ca, Wa, p);
        return t.step(cb, Wb, p);
      };
      const tp = tryWith({ ...P, tpPct: 8 }); // 107 x 0.92 = 98.44 < 100
      assert.deepStrictEqual(
        [tp.signal, tp.skips[0]?.why],
        [null, "TP_BEYOND_WALL"],
      );
      const room = tryWith({ ...P, roomRatio: 3 }); // 7 < 3 x 3
      assert.deepStrictEqual([room.signal, room.skips[0]?.why], [null, "ROOM"]);
      const far = tryWith({ ...P, maxStopPct: 2 }); // SL 2.8% away
      assert.deepStrictEqual([far.signal, far.skips[0]?.why], [null, "ROOM"]);
      // the walls moved between the touch and the exit -> the touch is forgotten
      const t = new WallTracker();
      t.step(ca, Wa, P);
      const moved = { ...Wb!, upper: { lo: 108.5, hi: 110 } };
      assert.strictEqual(t.step(cb, moved, P).signal, null);
      // BODY (tested, not used live): one candle that touches and closes with its body below is enough
      const bt = new WallTracker();
      const one = { t: E - H, o: 107.4, h: 108.3, l: 106.9, c: 107 };
      assert.strictEqual(
        bt.step(one, Wb, { ...P, kind: "BODY" }).signal?.side,
        "SHORT",
      );
    },
  );

  await scenario(
    "engine: a BROKEN wall (a 1h body below the lower wall) voids the field: no signal while waiting, the new walls only from after the break",
    () => {
      const m = market(),
        tr = new WallTracker(),
        P2 = { ...P, rebuildHours: 24 };
      const W = wallsAt(m, E - H, tr.minFieldStart);
      const brk = tr.step({ t: E - H, o: 99.8, h: 100.5, l: 98, c: 99 }, W, P2);
      assert.deepStrictEqual(
        [brk.broken, tr.fieldFrom, brk.signal],
        ["DOWN", E, null],
      );
      // the old liquidations are before the break -> no walls from the new field yet
      const after = wallsAt(m, E + 5 * H, tr.minFieldStart)!;
      assert.deepStrictEqual([after.lower, after.upper], [null, null]);
      // inside the wait: nothing, whatever the candle
      assert.strictEqual(
        tr.step({ t: E + 2 * H, o: 107.4, h: 108.3, l: 106.9, c: 107 }, W, P2)
          .waiting,
        true,
      );
      // off (the live default) -> the same candle is NOT a break
      assert.strictEqual(
        new WallTracker().step(
          { t: E - H, o: 99.8, h: 100.5, l: 98, c: 99 },
          W,
          P,
        ).broken,
        undefined,
      );
      // a wick below with the body back inside the room is NOT a break
      assert.strictEqual(
        new WallTracker().step(
          { t: E - H, o: 103, h: 104, l: 98, c: 103.5 },
          W,
          P2,
        ).broken,
        undefined,
      );
    },
  );

  await scenario("engine: the 1h candle needs all four 15m candles", () => {
    const m = market();
    const c = hourCandle(m.q15, E - H)!;
    assert.deepStrictEqual([c.o, c.h, c.l, c.c], [107.1, 107.5, 106.6, 107]);
    assert.strictEqual(
      hourCandle(
        m.q15.filter((x) => x.t !== E - H + Q),
        E - H,
      ),
      null,
    );
  });

  await scenario(
    "config: WALL off by default; its rule in the block; risk / limit per user; clear errors",
    () => {
      const off = parseV10Settings(
        { enabled: true, userModes: { main: "PAPER" } },
        ["main", "karo"],
        [...SYMS, "ETHUSDT"],
      );
      assert.deepStrictEqual(
        [
          off.wall,
          off.wallTpPct,
          off.wallRoomRatio,
          off.wallMaxStopPct,
          off.wallTimeoutHours,
          off.wallRebuildHours,
          off.wallSymbols,
        ],
        [false, 2, 1.33, null, 24, null, ["AAAUSDT", "BBBUSDT"]],
      );
      assert.strictEqual(
        settings({ wallRebuildHours: 24 }).wallRebuildHours,
        24,
      );
      assert.strictEqual(
        settings({ wallTimeoutHours: null }).wallTimeoutHours,
        null,
      );
      assert.throws(
        () => settings({ wallRebuildHours: 0 }),
        /wallRebuildHours/,
      );
      const s = parseV10Settings(
        {
          enabled: true,
          wall: true,
          wallTpPct: 1.5,
          wallRoomRatio: 1.5,
          wallMaxStopPct: 1,
          wallTimeoutHours: 12,
          wallExcludeSymbols: ["BBBUSDT"],
          perUser: {
            karo: { wallRiskUsd: 5, wallMaxOpen: 3 },
            main: { wall: false },
          },
        },
        ["main", "karo"],
        SYMS,
      );
      assert.deepStrictEqual(
        [
          s.wallTpPct,
          s.wallRoomRatio,
          s.wallMaxStopPct,
          s.wallTimeoutHours,
          s.wallSymbols,
        ],
        [1.5, 1.5, 1, 12, ["AAAUSDT"]],
      );
      assert.deepStrictEqual(
        [
          rulesFor(s, "karo").wall,
          rulesFor(s, "karo").wallRiskUsd,
          rulesFor(s, "karo").wallMaxOpen,
          rulesFor(s, "main").wall,
        ],
        [true, 5, 3, false],
      );
      assert.throws(() => settings({ wallTpPct: 0 }), /wallTpPct/);
      assert.throws(
        () => settings({ perUser: { karo: { wallRiskUsd: -1 } } }),
        /wallRiskUsd/,
      );
      assert.throws(
        () => settings({ wallExcludeSymbols: "ETH" }),
        /wallExcludeSymbols/,
      );
      assert.throws(() => settings({ wallTp: 2 }), /not a known setting/);
    },
  );

  await scenario(
    "live PAPER: the hour closes -> one WALL trade, SL = the wall's top 110, TP 104.86, risk from wallRiskUsd; the message has every price; never twice",
    async () => {
      const store = fakeStore(),
        t = tg();
      let now = E + 100_000;
      const users: V10UserRef[] = [
        {
          userId: "main",
          mode: "PAPER",
          riskUsd: 10,
          binanceRest: null,
          telegram: t,
        },
      ];
      const svc = new V10LiveService(
        settings({ perUser: { main: { wallRiskUsd: 5 } } }),
        () => users,
        loaderOf(minuteBars()),
        store,
        () => now,
        null,
        null,
        source(market()),
      );
      await svc.onMinute();
      assert.strictEqual(store.signals.length, 1);
      assert.strictEqual(store.signals[0].kind, "WALL");
      const tr = store.trades[0];
      assert.deepStrictEqual(
        [
          store.trades.length,
          tr.kind,
          tr.state,
          tr.side,
          tr.entryPrice,
          tr.slPrice,
          tr.plannedRiskUsd,
          tr.timeoutAt,
        ],
        [1, "WALL", "OPEN", "SHORT", 107, 110, 5, E + 24 * H],
      );
      assert.ok(near(tr.tpPrice!, 104.86) && near(tr.quantity!, 5 / 3));
      assert.ok(
        t.msgs[0].includes("V10 · WALL") &&
          t.msgs[0].includes("SL    110.000 (+2.80%) -$5.00") &&
          t.msgs[0].includes("TP    104.860 (-2.00%)") &&
          t.msgs[0].includes("✋ Ձեռքով՝ SL 110.000 · TP 104.860") &&
          t.msgs[0].includes("վերևի  108.000 – 110.000"),
        t.msgs[0],
      );
      now += M;
      await svc.onMinute();
      assert.deepStrictEqual(
        [store.signals.length, store.trades.length],
        [1, 1],
      );
    },
  );

  await scenario(
    "live: a user with WALL off gets nothing; a coin with an open trade of this user is skipped",
    async () => {
      const store = fakeStore();
      const users: V10UserRef[] = [
        {
          userId: "main",
          mode: "PAPER",
          riskUsd: 10,
          binanceRest: null,
          telegram: null,
        },
        {
          userId: "karo",
          mode: "PAPER",
          riskUsd: 10,
          binanceRest: null,
          telegram: null,
        },
      ];
      store.trades.push({
        tradeId: "x",
        orderSignalId: "x",
        signalId: "x",
        kind: "OWN",
        userId: "karo",
        mode: "PAPER",
        symbol: "AAAUSDT",
        side: "LONG",
        pick: { rank: 1, x: 1, follow: 1, coinPct: 1, btcPct: 1 },
        state: "OPEN",
        createdAt: E - 3 * H,
        entryPrice: 105,
        slPrice: 1,
        tpPrice: 1000,
        slPct: 1,
        tpPct: 1,
        quantity: 1,
        plannedRiskUsd: 10,
        actualRiskUsd: 10,
        binance: null,
        closedAt: null,
        exitPrice: null,
        pnlUsd: null,
        pnlR: null,
        feesUsd: null,
        closeReason: null,
        failureReason: null,
        closeAttempts: 0,
        entryInProgress: false,
        entryStartedAt: null,
      });
      const svc = new V10LiveService(
        settings({
          userModes: { main: "PAPER", karo: "PAPER" },
          perUser: { main: { wall: false } },
        }),
        () => users,
        loaderOf(minuteBars()),
        store,
        () => E + 100_000,
        null,
        null,
        source(market()),
      );
      await svc.onMinute();
      const wallTrades = store.trades.filter((x) => x.kind === "WALL");
      assert.deepStrictEqual(
        wallTrades.map((x) => [x.userId, x.state]),
        [["karo", "SKIPPED"]],
      );
    },
  );

  await scenario(
    "live PAPER: still open after 24h -> closed at the last minute's close before the time-out (TIMEOUT_CLOSED)",
    async () => {
      const store = fakeStore(),
        t = tg();
      let now = E + 100_000;
      const users: V10UserRef[] = [
        {
          userId: "main",
          mode: "PAPER",
          riskUsd: 10,
          binanceRest: null,
          telegram: t,
        },
      ];
      const svc = new V10LiveService(
        settings(),
        () => users,
        loaderOf(minuteBars()),
        store,
        () => now,
        null,
        null,
        source(market()),
      );
      await svc.onMinute();
      now = E + 23 * H;
      await svc.onMinute();
      assert.strictEqual(store.trades[0].state, "OPEN");
      now = E + 24 * H + 6 * M;
      await svc.onMinute();
      const tr = store.trades[0];
      assert.deepStrictEqual(
        [tr.state, tr.closeReason, tr.exitPrice, tr.closedAt],
        ["CLOSED", "TIMEOUT_CLOSED", 107, E + 24 * H],
      );
      assert.ok(t.msgs.at(-1)!.startsWith("⏱ TIME OUT"), t.msgs.at(-1));
    },
  );

  await scenario(
    "live PAPER: no time limit (wallTimeoutHours null) -> no timeoutAt, still open after 2 days, no time-out line in the message",
    async () => {
      const store = fakeStore(),
        t = tg();
      let now = E + 100_000;
      const users: V10UserRef[] = [
        {
          userId: "main",
          mode: "PAPER",
          riskUsd: 10,
          binanceRest: null,
          telegram: t,
        },
      ];
      const svc = new V10LiveService(
        settings({ wallTimeoutHours: null }),
        () => users,
        loaderOf(minuteBars()),
        store,
        () => now,
        null,
        null,
        source(market()),
      );
      await svc.onMinute();
      assert.strictEqual(store.trades[0].timeoutAt, undefined);
      assert.ok(!t.msgs[0].includes("⏱"), t.msgs[0]);
      now = E + 29 * H;
      await svc.onMinute();
      assert.strictEqual(store.trades[0].state, "OPEN");
    },
  );

  await scenario(
    "live: stale minute data, or a coin with less than 2 days of our liquidations -> no WALL signal",
    async () => {
      const store = fakeStore();
      const users: V10UserRef[] = [
        {
          userId: "main",
          mode: "PAPER",
          riskUsd: 10,
          binanceRest: null,
          telegram: null,
        },
      ];
      // the collector stopped 20 min before the hour end
      const stale = new V10LiveService(
        settings(),
        () => users,
        loaderOf(
          new Map([
            [
              "AAAUSDT",
              minuteBars()
                .get("AAAUSDT")!
                .filter((b) => b.t < E - 20 * M),
            ],
          ]),
        ),
        store,
        () => E + 6 * M,
        null,
        null,
        source(market()),
      );
      await stale.onMinute();
      assert.strictEqual(store.signals.length, 0);
      const young = market();
      young.firstLiqT = E - 36 * H;
      const svc = new V10LiveService(
        settings(),
        () => users,
        loaderOf(minuteBars()),
        store,
        () => E + 100_000,
        null,
        null,
        source(young),
      );
      await svc.onMinute();
      assert.strictEqual(store.signals.length, 0);
    },
  );

  await scenario(
    "live REAL: market entry, the SL rests at the wall's top 110, the TP at 104.86, the size makes the SL cost wallRiskUsd",
    async () => {
      const store = fakeStore(),
        t = tg();
      let now = E + 100_000;
      const bx = fakeBinance(107, () => now);
      const users: V10UserRef[] = [
        {
          userId: "karo",
          mode: "REAL",
          riskUsd: 10,
          binanceRest: bx as never,
          leverage: 20,
          marginMode: "ISOLATED",
          telegram: t,
        },
      ];
      const svc = new V10LiveService(
        settings({
          userModes: { karo: "REAL" },
          perUser: { karo: { wallRiskUsd: 5 } },
        }),
        () => users,
        loaderOf(minuteBars()),
        store,
        () => now,
        null,
        null,
        source(market()),
      );
      await svc.onMinute();
      const tr = store.trades[0];
      assert.deepStrictEqual(
        [tr.state, tr.mode, tr.entryPrice, tr.slPrice],
        ["OPEN", "REAL", 107, 110],
      );
      const sl = bx.st.algos[0],
        tp = bx.st.orders.find((o) => o.type === "LIMIT")!;
      assert.deepStrictEqual(
        [sl.type, sl.side, Number(sl.triggerPrice), tp.side, Number(tp.price)],
        ["STOP_MARKET", "BUY", 110, "BUY", 104.86],
      );
      assert.ok(near(bx.st.position, -1.66, 1e-9), String(bx.st.position)); // 5 / 3 = 1.666 -> step 0.01
      assert.ok(
        t.msgs[0].includes("REAL") && t.msgs[0].includes("V10 · WALL"),
        t.msgs[0],
      );
    },
  );

  await scenario(
    "live REAL: still open after 24h -> one reduce-only MARKET close (our MARKET_EXIT id), SL / TP cancelled, reported as TIMEOUT_CLOSED; never sent twice",
    async () => {
      const store = fakeStore(),
        t = tg();
      let now = E + 100_000;
      const bx = fakeBinance(107, () => now);
      const users: V10UserRef[] = [
        {
          userId: "karo",
          mode: "REAL",
          riskUsd: 10,
          binanceRest: bx as never,
          leverage: 20,
          marginMode: "ISOLATED",
          telegram: t,
        },
      ];
      const svc = new V10LiveService(
        settings({
          userModes: { karo: "REAL" },
          perUser: { karo: { wallRiskUsd: 5 } },
        }),
        () => users,
        loaderOf(minuteBars()),
        store,
        () => now,
        null,
        null,
        source(market()),
      );
      await svc.onMinute();
      now = E + 23 * H;
      await svc.monitorReal();
      assert.strictEqual(store.trades[0].state, "OPEN");
      now = E + 24 * H + 30_000;
      await svc.monitorReal();
      const tr = store.trades[0];
      const exitId = strategyClientOrderId(
        "karo",
        tr.orderSignalId,
        "MARKET_EXIT",
        0,
      );
      const closes = bx.st.created.filter((o) => o.newClientOrderId === exitId);
      assert.deepStrictEqual(
        [
          closes.length,
          closes[0]?.type,
          closes[0]?.side,
          closes[0]?.reduceOnly,
          closes[0]?.quantity,
        ],
        [1, "MARKET", "BUY", "true", "1.66"],
      );
      assert.deepStrictEqual(
        [
          tr.state,
          tr.closeReason,
          bx.st.position,
          bx.st.orders.length,
          bx.st.algos.length,
        ],
        ["CLOSED", "TIMEOUT_CLOSED", 0, 0, 0],
      );
      assert.ok(t.msgs.at(-1)!.startsWith("⏱ TIME OUT"), t.msgs.at(-1));
      await svc.monitorReal();
      assert.strictEqual(
        bx.st.created.filter((o) => o.newClientOrderId === exitId).length,
        1,
      );
    },
  );

  await scenario(
    "live REAL: our time-out close was already sent before a crash -> found by its id, not sent again",
    async () => {
      const store = fakeStore();
      let now = E + 100_000;
      const bx = fakeBinance(107, () => now);
      const users: V10UserRef[] = [
        {
          userId: "karo",
          mode: "REAL",
          riskUsd: 10,
          binanceRest: bx as never,
          leverage: 20,
          marginMode: "ISOLATED",
          telegram: null,
        },
      ];
      const svc = new V10LiveService(
        settings({ userModes: { karo: "REAL" } }),
        () => users,
        loaderOf(minuteBars()),
        store,
        () => now,
        null,
        null,
        source(market()),
      );
      await svc.onMinute();
      const tr = store.trades[0];
      const exitId = strategyClientOrderId(
        "karo",
        tr.orderSignalId,
        "MARKET_EXIT",
        0,
      );
      // it was sent (and filled) but the bot died before writing timeoutSentAt
      await bx.createOrder({
        symbol: "AAAUSDT",
        side: "BUY",
        type: "MARKET",
        quantity: String(Math.abs(bx.st.position)),
        reduceOnly: "true",
        newClientOrderId: exitId,
      });
      now = E + 24 * H + 30_000;
      await svc.monitorReal();
      assert.strictEqual(
        bx.st.created.filter((o) => o.newClientOrderId === exitId).length,
        1,
      );
      assert.deepStrictEqual(
        [store.trades[0].state, store.trades[0].closeReason],
        ["CLOSED", "TIMEOUT_CLOSED"],
      );
    },
  );

  await scenario(
    "live REAL: our time-out close filled nothing (expired) -> NOT counted as done; the next cycle sends revision 1 and the trade closes TIMEOUT",
    async () => {
      const store = fakeStore();
      let now = E + 100_000;
      const bx = fakeBinance(107, () => now);
      const users: V10UserRef[] = [
        {
          userId: "karo",
          mode: "REAL",
          riskUsd: 10,
          binanceRest: bx as never,
          leverage: 20,
          marginMode: "ISOLATED",
          telegram: null,
        },
      ];
      const svc = new V10LiveService(
        settings({
          userModes: { karo: "REAL" },
          perUser: { karo: { wallRiskUsd: 5 } },
        }),
        () => users,
        loaderOf(minuteBars()),
        store,
        () => now,
        null,
        null,
        source(market()),
      );
      await svc.onMinute();
      const tr0 = store.trades[0];
      const rev0 = strategyClientOrderId(
          "karo",
          tr0.orderSignalId,
          "MARKET_EXIT",
          0,
        ),
        rev1 = strategyClientOrderId(
          "karo",
          tr0.orderSignalId,
          "MARKET_EXIT",
          1,
        );
      const real = bx.createOrder;
      bx.createOrder = async (p: Record<string, string | number>) => {
        if (p.newClientOrderId === rev0) {
          bx.st.created.push(p);
          bx.st.byClient.set(rev0, {
            orderId: 777,
            clientOrderId: rev0,
            status: "EXPIRED",
            executedQty: 0,
            avgPrice: 0,
          });
          return { orderId: 777 };
        }
        return real(p);
      };
      now = E + 24 * H + 30_000;
      await svc.monitorReal();
      assert.deepStrictEqual(
        [store.trades[0].state, store.trades[0].timeoutSentAt, bx.st.position],
        ["OPEN", undefined, -1.66],
      );
      await svc.monitorReal();
      assert.deepStrictEqual(
        [
          bx.st.created.filter((o) => o.newClientOrderId === rev0).length,
          bx.st.created.filter((o) => o.newClientOrderId === rev1).length,
        ],
        [1, 1],
      );
      assert.deepStrictEqual(
        [
          store.trades[0].state,
          store.trades[0].closeReason,
          bx.st.position,
          bx.st.orders.length,
          bx.st.algos.length,
        ],
        ["CLOSED", "TIMEOUT_CLOSED", 0, 0, 0],
      );
    },
  );

  await scenario(
    "live REAL: at the time-out only part of our position is left (our TP partly filled) -> exactly that part is closed, never more",
    async () => {
      const store = fakeStore();
      let now = E + 100_000;
      const bx = fakeBinance(107, () => now);
      const users: V10UserRef[] = [
        {
          userId: "karo",
          mode: "REAL",
          riskUsd: 10,
          binanceRest: bx as never,
          leverage: 20,
          marginMode: "ISOLATED",
          telegram: null,
        },
      ];
      const svc = new V10LiveService(
        settings({
          userModes: { karo: "REAL" },
          perUser: { karo: { wallRiskUsd: 5 } },
        }),
        () => users,
        loaderOf(minuteBars()),
        store,
        () => now,
        null,
        null,
        source(market()),
      );
      await svc.onMinute();
      bx.st.position = -0.66; // 1.00 of our 1.66 was bought back by the TP
      now = E + 24 * H + 30_000;
      await svc.monitorReal();
      const exit = bx.st.created.find(
        (o) =>
          o.newClientOrderId ===
          strategyClientOrderId(
            "karo",
            store.trades[0].orderSignalId,
            "MARKET_EXIT",
            0,
          ),
      )!;
      assert.deepStrictEqual(
        [exit.quantity, exit.reduceOnly, bx.st.position],
        ["0.66", "true", 0],
      );
    },
  );

  await scenario(
    "live: the database fails while storing a signal -> the signal is kept and stored next minute (not lost)",
    async () => {
      const store = fakeStore();
      let now = E + 100_000,
        fail = true;
      const insert = store.insertSignal;
      store.insertSignal = async (d) => {
        if (fail) {
          fail = false;
          throw new Error("Mongo down");
        }
        return insert(d);
      };
      const users: V10UserRef[] = [
        {
          userId: "main",
          mode: "PAPER",
          riskUsd: 10,
          binanceRest: null,
          telegram: null,
        },
      ];
      const svc = new V10LiveService(
        settings(),
        () => users,
        loaderOf(minuteBars()),
        store,
        () => now,
        null,
        null,
        source(market()),
      );
      await svc.onMinute();
      assert.deepStrictEqual(
        [store.signals.length, store.trades.length],
        [0, 0],
      );
      now += M;
      await svc.onMinute();
      assert.deepStrictEqual(
        [
          store.signals.length,
          store.trades.length,
          store.trades[0]?.entryPrice,
        ],
        [1, 1, 107],
      );
    },
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
void run();
