/** A fake Binance USD-M account (copied from tests/v10-wall.test.ts, Oct 12 2026): market orders fill at `book`, LIMIT / algo orders rest until filled by hand. */
export function fakeBinance(book0: number, clock: () => number, symbols: string[] = ["AAAUSDT", "BBBUSDT"]) {
  let book = book0;
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
      symbols: symbols.map((s) => ({
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
    /** the market moves: market orders now fill here */
    setBook(v: number): void { book = v; },
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
    /** another trade's fill on the same symbol (e.g. V11 closing / opening) */
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
