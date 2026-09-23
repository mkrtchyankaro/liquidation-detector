import type { Side } from "../../shared/common.types";

/**
 * How a REAL position actually closed, computed ONLY from Binance's own
 * fills (GET /fapi/v1/userTrades) -- never estimated.
 *
 *  reason:
 *    TP_FILLED  -- a closing fill belongs to our TP order
 *    SL_FILLED  -- a closing fill belongs to the order our SL algo created
 *    POSITION_CLOSED_EXTERNALLY -- closed by anything else (manual close
 *               in the Binance app, liquidation, another tool)
 *  exitPrice:    quantity-weighted average of the closing fills
 *  realizedPnlUsd: sum of Binance realizedPnl on closing fills minus all
 *               USDT commissions on this trade's fills (entry + exit)
 */
export interface UserTradeFill {
  orderId: number | string;
  side: "BUY" | "SELL";
  price: string | number;
  qty: string | number;
  realizedPnl: string | number;
  commission: string | number;
  commissionAsset: string;
  time: number;
}

export interface RealCloseReport {
  reason: "TP_FILLED" | "SL_FILLED" | "POSITION_CLOSED_EXTERNALLY";
  exitPrice: number;
  closedQty: number;
  realizedPnlUsd: number;
  feesUsd: number;
}

export function buildRealCloseReport(input: {
  side: Side;
  fills: readonly UserTradeFill[];
  sinceMs: number;
  tpOrderId: number | null;
  slActualOrderId: number | null;
}): RealCloseReport | null {
  const closeSide = input.side === "LONG" ? "SELL" : "BUY";
  const own = input.fills.filter((f) => f.time >= input.sinceMs);
  const closing = own.filter((f) => f.side === closeSide);
  const closedQty = closing.reduce((t, f) => t + Number(f.qty), 0);
  if (!(closedQty > 0)) return null;
  const exitPrice =
    closing.reduce((t, f) => t + Number(f.price) * Number(f.qty), 0) /
    closedQty;
  const feesUsd = own
    .filter((f) => f.commissionAsset === "USDT")
    .reduce((t, f) => t + Number(f.commission), 0);
  const grossPnl = closing.reduce((t, f) => t + Number(f.realizedPnl), 0);
  const ids = new Set(closing.map((f) => Number(f.orderId)));
  const reason =
    input.tpOrderId !== null && ids.has(input.tpOrderId)
      ? "TP_FILLED"
      : input.slActualOrderId !== null && ids.has(input.slActualOrderId)
        ? "SL_FILLED"
        : "POSITION_CLOSED_EXTERNALLY";
  return {
    reason,
    exitPrice,
    closedQty,
    realizedPnlUsd: grossPnl - feesUsd,
    feesUsd,
  };
}
