import type { RealCloseReport, UserTradeFill } from "./close-report";
import {
  cancelOwnAlgoOrder,
  getSymbolFilters,
  type BinanceRestLike,
} from "./entry-sequence";
import { strategyClientOrderId } from "./client-order-id";

/**
 * REAL TRADE SAFETY, shared (Oct 2 2026; used by V10 -- V9 keeps its own copy of its rules).
 *
 * Our orders are found by their DETERMINISTIC client ids (userId + orderSignalId + purpose), never only by the ids we
 * managed to save -- a crash between placing an order and saving it can never leave it resting unseen.
 *
 * settle -- our trade is OVER only when BINANCE proves it: the position is flat, or OUR TP order is FILLED, or the order
 *   our SL triggered is FILLED, or the position now points the other way (never from our own database: another
 *   strategy's row is written before it checks the account). A position of our side but of a different size is
 *   AMBIGUOUS -> nothing is touched, RETRY (the user is alerted after a while). Then everything of ours still resting is
 *   cancelled -- and the close is
 *   reported only once both open-order lists were READ and contain nothing of ours (else RETRY). The close is computed
 *   only from fills inside the trade's own time window, our exit orders first.
 * recoverEntry -- an entry that never finished: decided from OUR entry order (looked up by its client id), never from
 *   the position alone -- a position that is not ours is never touched.
 * symbolClear -- before a NEW real entry nothing of anyone may be on the symbol (position, order, stop).
 */
export interface SettleRest extends BinanceRestLike {
  getUserTrades(symbol: string, startTime: number): Promise<unknown>;
  getOrderByClientId(
    symbol: string,
    origClientOrderId: string,
  ): Promise<unknown>;
}

export interface SettleTrade {
  userId: string;
  /** the id our client order ids were made from */
  orderSignalId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  /** just before our entry order was sent (ms) -- our fills start after it */
  entryStartedAt: number;
  /** our position size (null = unknown) */
  quantity: number | null;
  binance: { tpOrderId?: number; slAlgoId?: number } | null;
}

export type SettleResult =
  | { status: "OPEN" }
  | { status: "RETRY"; why: string }
  | { status: "NO_FILLS" }
  | { status: "CLOSED"; report: RealCloseReport };

export const ourIds = (
  userId: string,
  orderSignalId: string,
): { tp: string; sl: string; entry: string; failsafe: string } => ({
  tp: strategyClientOrderId(userId, orderSignalId, "TAKE_PROFIT", 0),
  sl: strategyClientOrderId(userId, orderSignalId, "STOP_LOSS", 0),
  entry: strategyClientOrderId(userId, orderSignalId, "ENTRY", 0),
  failsafe: strategyClientOrderId(userId, orderSignalId, "FAILSAFE_CLOSE", 0),
});

type OrderInfo = {
  orderId?: number | string;
  clientOrderId?: string;
  status?: string;
  executedQty?: string | number;
  avgPrice?: string | number;
};
type AlgoInfo = {
  algoId?: number | string;
  clientAlgoId?: string;
  algoStatus?: string;
  actualOrderId?: number | string;
};
const notFound = (err: unknown): boolean =>
  /-2013|does not exist|not found|-2011/i.test(
    err instanceof Error ? err.message : String(err),
  );
const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export async function positionAmt(
  rest: BinanceRestLike,
  symbol: string,
): Promise<number> {
  const pos = (
    (await rest.getPositionRisk(symbol)) as Array<{
      symbol: string;
      positionAmt: string;
    }>
  ).find((p) => p.symbol === symbol);
  return pos ? Number(pos.positionAmt) : 0;
}

/** one of our orders by its client id: the order, null = Binance says it does not exist; throws when unknown */
async function orderByClientId(
  rest: SettleRest,
  symbol: string,
  clientId: string,
): Promise<OrderInfo | null> {
  try {
    return (await rest.getOrderByClientId(symbol, clientId)) as OrderInfo;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}
async function algoByClientId(
  rest: SettleRest,
  clientId: string,
): Promise<AlgoInfo | null> {
  try {
    const a = (await rest.getAlgoOrderByClientId(clientId)) as AlgoInfo;
    return a && (a.algoId !== undefined || a.algoStatus) ? a : null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

/** our TP / SL as they are on Binance (by saved id, else by client id). Throws when Binance cannot be read. */
async function ourExits(
  rest: SettleRest,
  t: SettleTrade,
): Promise<{
  tpOrderId: number | null;
  tpFilled: boolean;
  slActualOrderId: number | null;
  slFilled: boolean;
}> {
  const ids = ourIds(t.userId, t.orderSignalId);
  let tp: OrderInfo | null = null;
  if (t.binance?.tpOrderId) {
    try {
      tp = (await rest.getOrder(t.symbol, t.binance.tpOrderId)) as OrderInfo;
    } catch (err) {
      if (!notFound(err)) throw err;
    }
  } else tp = await orderByClientId(rest, t.symbol, ids.tp);
  const sl = t.binance?.slAlgoId
    ? ((await rest.getAlgoOrder(t.binance.slAlgoId).catch((err) => {
        if (notFound(err)) return null;
        throw err;
      })) as AlgoInfo | null)
    : await algoByClientId(rest, ids.sl);
  const slActualOrderId =
    Number(sl?.actualOrderId) > 0 ? Number(sl!.actualOrderId) : null;
  let slFilled = false;
  if (slActualOrderId !== null) {
    const o = (await rest.getOrder(t.symbol, slActualOrderId).catch((err) => {
      if (notFound(err)) return null;
      throw err;
    })) as OrderInfo | null;
    slFilled = o?.status === "FILLED";
  }
  const tpOrderId =
    t.binance?.tpOrderId ??
    (tp?.orderId !== undefined ? Number(tp.orderId) : null);
  return {
    tpOrderId,
    tpFilled: tp?.status === "FILLED",
    slActualOrderId,
    slFilled,
  };
}

/** cancels every resting order of ours; true only if both lists were read afterwards and none of ours is left */
async function cancelOurs(
  rest: SettleRest,
  t: Pick<SettleTrade, "userId" | "orderSignalId" | "symbol" | "binance">,
): Promise<boolean> {
  const ids = ourIds(t.userId, t.orderSignalId);
  if (t.binance?.tpOrderId)
    await rest
      .cancelOrder(t.symbol, t.binance.tpOrderId)
      .catch(() => undefined);
  if (t.binance?.slAlgoId)
    await rest.cancelAlgoOrder(t.binance.slAlgoId).catch(() => undefined);
  try {
    const orders = (await rest.getOpenOrders(t.symbol)) as OrderInfo[];
    for (const o of Array.isArray(orders) ? orders : [])
      if (o.clientOrderId === ids.tp && o.orderId !== undefined)
        await rest
          .cancelOrder(t.symbol, Number(o.orderId))
          .catch(() => undefined);
    await cancelOwnAlgoOrder(rest, t.symbol, null, ids.sl);
    const again = (await rest.getOpenOrders(t.symbol)) as OrderInfo[];
    const algos = (await rest.getOpenAlgoOrders(t.symbol)) as AlgoInfo[];
    if (!Array.isArray(again) || !Array.isArray(algos)) return false;
    return (
      !again.some(
        (o) =>
          o.clientOrderId === ids.tp ||
          (t.binance?.tpOrderId !== undefined &&
            Number(o.orderId) === t.binance.tpOrderId),
      ) &&
      !algos.some(
        (a) =>
          a.clientAlgoId === ids.sl ||
          (t.binance?.slAlgoId !== undefined &&
            Number(a.algoId) === t.binance.slAlgoId),
      )
    );
  } catch {
    return false; // unknown -> not proven clean
  }
}

/**
 * @param otherTradeSince  when another REAL trade (V9) of this user was opened on this symbol after our entry, else
 *                         null -- used ONLY to end the fill window once Binance proved our trade is over
 */
export async function settle(
  rest: SettleRest,
  t: SettleTrade,
  now: number,
  otherTradeSince: number | null,
): Promise<SettleResult> {
  let exits: Awaited<ReturnType<typeof ourExits>>, amt: number;
  try {
    amt = await positionAmt(rest, t.symbol);
    exits = await ourExits(rest, t);
  } catch (err) {
    return { status: "RETRY", why: `Binance unreadable: ${errText(err)}` };
  }
  const ourSign = t.side === "LONG" ? 1 : -1;
  const over =
    amt === 0 || exits.tpFilled || exits.slFilled || Math.sign(amt) !== ourSign;
  if (!over) {
    if (
      t.quantity !== null &&
      Math.abs(Math.abs(amt) - t.quantity) > t.quantity * 0.001
    ) {
      return {
        status: "RETRY",
        why: `the ${t.symbol} position (${amt}) is not our size (${t.side === "LONG" ? "" : "-"}${t.quantity}) -- another trade may be on it; nothing touched`,
      };
    }
    return { status: "OPEN" };
  }
  if (!(await cancelOurs(rest, t)))
    return {
      status: "RETRY",
      why: "could not prove that none of our orders is still resting",
    };

  const since = t.entryStartedAt - 5_000,
    end = otherTradeSince ?? now;
  let entryOrderId: number | null = null;
  let all: UserTradeFill[];
  try {
    const eo = await orderByClientId(
      rest,
      t.symbol,
      ourIds(t.userId, t.orderSignalId).entry,
    );
    entryOrderId = eo?.orderId !== undefined ? Number(eo.orderId) : null;
    all = (await rest.getUserTrades(t.symbol, since)) as UserTradeFill[];
  } catch (err) {
    return { status: "RETRY", why: `fills unreadable: ${errText(err)}` };
  }
  const fills = (Array.isArray(all) ? all : []).filter(
    (f) => f.time >= since && f.time <= end,
  );
  const closeSide = t.side === "LONG" ? "SELL" : "BUY";
  const exitIds = new Set(
    [exits.tpOrderId, exits.slActualOrderId].filter(
      (x): x is number => typeof x === "number" && x > 0,
    ),
  );
  const allClosing = fills.filter(
    (f) => f.side === closeSide && Number(f.orderId) !== entryOrderId,
  );
  let closing = allClosing.filter((f) => exitIds.has(Number(f.orderId)));
  const exitQty = closing.reduce((s, f) => s + Number(f.qty), 0);
  // our exits closed only part (or nothing) of our quantity -> the rest was closed otherwise inside our window
  if (!(t.quantity !== null && exitQty >= t.quantity * 0.999))
    closing = allClosing;
  const reason: RealCloseReport["reason"] = closing.some(
    (f) => Number(f.orderId) === exits.tpOrderId,
  )
    ? "TP_FILLED"
    : closing.some((f) => Number(f.orderId) === exits.slActualOrderId)
      ? "SL_FILLED"
      : "POSITION_CLOSED_EXTERNALLY";
  const closedQty = closing.reduce((s, f) => s + Number(f.qty), 0);
  if (!(closedQty > 0)) return { status: "NO_FILLS" };
  const firstClose = Math.min(...closing.map((f) => f.time));
  const opening =
    entryOrderId !== null
      ? fills.filter((f) => Number(f.orderId) === entryOrderId)
      : fills.filter((f) => f.side !== closeSide && f.time <= firstClose);
  const exitPrice =
    closing.reduce((s, f) => s + Number(f.price) * Number(f.qty), 0) /
    closedQty;
  const feesUsd = [...opening, ...closing]
    .filter((f) => f.commissionAsset === "USDT")
    .reduce((s, f) => s + Number(f.commission), 0);
  const grossPnl = closing.reduce((s, f) => s + Number(f.realizedPnl), 0);
  return {
    status: "CLOSED",
    report: {
      reason,
      exitPrice,
      closedQty,
      realizedPnlUsd: grossPnl - feesUsd,
      feesUsd,
    },
  };
}

/**
 * An entry that never finished (crash / restart mid-entry, or an entry call that returned an error). Decided from OUR
 * entry order, looked up by its client id:
 *   NOT_OPENED   our entry order does not exist / filled nothing -> nothing of ours is left resting (proven) -> failed
 *   DONE         our entry filled, but the position is flat now / not ours any more -> the trade is over: settle it
 *   ADOPTED      our entry filled, the position is ours and OUR SL rests -> a normal trade
 *   CLOSED_UNPROTECTED  our entry filled, the position is ours, NO SL of ours -> our filled quantity is closed at
 *                market (reduce-only), never more than we bought / sold
 *   RETRY        Binance unreadable, or the position is ambiguous -> nothing is done, tried again next cycle
 */
export type RecoverResult =
  | { status: "NOT_OPENED" }
  | { status: "DONE"; entryPrice: number; quantity: number }
  | {
      status: "ADOPTED";
      entryPrice: number;
      quantity: number;
      slAlgoId: number;
      tpOrderId: number | null;
    }
  | { status: "CLOSED_UNPROTECTED"; entryPrice: number; quantity: number }
  | { status: "RETRY"; why: string };

export async function recoverEntry(
  rest: SettleRest,
  t: Pick<
    SettleTrade,
    "userId" | "orderSignalId" | "symbol" | "side" | "binance"
  >,
): Promise<RecoverResult> {
  const ids = ourIds(t.userId, t.orderSignalId);
  let eo: OrderInfo | null;
  try {
    eo = await orderByClientId(rest, t.symbol, ids.entry);
  } catch (err) {
    return { status: "RETRY", why: `entry order unreadable: ${errText(err)}` };
  }
  const filled = Number(eo?.executedQty) || 0;
  if (!eo || filled === 0) {
    if (eo && (eo.status === "NEW" || eo.status === "PARTIALLY_FILLED"))
      return { status: "RETRY", why: "our entry order is still working" };
    return (await cancelOurs(rest, t))
      ? { status: "NOT_OPENED" }
      : {
          status: "RETRY",
          why: "could not prove that none of our orders is resting",
        };
  }
  const entryPrice = Number(eo.avgPrice);
  let amt: number;
  try {
    amt = await positionAmt(rest, t.symbol);
  } catch (err) {
    return { status: "RETRY", why: `position unreadable: ${errText(err)}` };
  }
  const ourSign = t.side === "LONG" ? 1 : -1;
  if (amt === 0 || Math.sign(amt) !== ourSign)
    return { status: "DONE", entryPrice, quantity: filled };
  if (Math.abs(Math.abs(amt) - filled) > filled * 0.001)
    return {
      status: "RETRY",
      why: `the position (${amt}) is not the size our entry filled (${filled}) -- nothing touched`,
    };
  let sl: AlgoInfo | null,
    tpId: number | null = null;
  try {
    sl = await algoByClientId(rest, ids.sl);
    const tp = await orderByClientId(rest, t.symbol, ids.tp);
    if (
      tp &&
      (tp.status === "NEW" || tp.status === "PARTIALLY_FILLED") &&
      tp.orderId !== undefined
    )
      tpId = Number(tp.orderId);
  } catch (err) {
    return { status: "RETRY", why: `our stop unreadable: ${errText(err)}` };
  }
  if (
    sl &&
    sl.algoId !== undefined &&
    (sl.algoStatus === "NEW" || sl.algoStatus === "WORKING")
  ) {
    return {
      status: "ADOPTED",
      entryPrice,
      quantity: filled,
      slAlgoId: Number(sl.algoId),
      tpOrderId: tpId,
    };
  }
  const filters = await getSymbolFilters(rest, t.symbol).catch(() => null);
  if (!filters) return { status: "RETRY", why: "symbol filters unreadable" };
  const qty = Math.min(Math.abs(amt), filled);
  try {
    await rest.createOrder({
      symbol: t.symbol,
      side: t.side === "LONG" ? "SELL" : "BUY",
      type: "MARKET",
      quantity: qty.toFixed(filters.qtyPrecision),
      reduceOnly: "true",
      newClientOrderId: ids.failsafe,
    });
  } catch (err) {
    return {
      status: "RETRY",
      why: `fail-safe close rejected: ${errText(err)}`,
    };
  }
  if (tpId !== null)
    await rest.cancelOrder(t.symbol, tpId).catch(() => undefined);
  return { status: "CLOSED_UNPROTECTED", entryPrice, quantity: qty };
}

export async function symbolClear(
  rest: BinanceRestLike,
  symbol: string,
): Promise<string | null> {
  try {
    const amt = await positionAmt(rest, symbol);
    if (amt !== 0)
      return `an existing ${symbol} position (${amt}) is open on this account`;
    const orders = (await rest.getOpenOrders(symbol)) as unknown[];
    if (!Array.isArray(orders)) return "open orders unreadable";
    if (orders.length > 0)
      return `${orders.length} open order(s) on ${symbol} on this account`;
    const algos = (await rest.getOpenAlgoOrders(symbol)) as unknown[];
    if (!Array.isArray(algos)) return "open stop orders unreadable";
    if (algos.length > 0)
      return `${algos.length} open stop order(s) on ${symbol} on this account`;
    return null;
  } catch (err) {
    return `could not read the account (${errText(err)})`;
  }
}
