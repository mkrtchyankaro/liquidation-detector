import type { Side } from "../../shared/common.types";
import { strategyClientOrderId } from "../../domain/liquidation-oi-strategy/strategy-order-identity";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "lox-user-exec" });

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 5-7.
 *
 * DELIBERATELY ISOLATED from BinanceExecutionService -- that
 * 2900-line class is production-critical to V3/V5's own real trading
 * and is NOT modified anywhere in this file. This service reuses
 * BinanceRestClient's own PUBLIC methods directly (createOrder,
 * createAlgoOrder, getAlgoOrder, getPositionRisk) -- the exact same
 * low-level REST primitives BinanceExecutionService itself wraps,
 * confirmed by direct inspection, but with THIS strategy's own
 * sequencing:
 *
 *   ENTRY fill -> VERIFY position -> place emergency STOP_MARKET
 *   (via createAlgoOrder -- confirmed the ONLY working path for
 *   STOP_MARKET since Binance rejected it on /fapi/v1/order,
 *   error -4120) -> VERIFY the algo order exists -> place initial TP
 *   -> VERIFY it exists -> user ACTIVE.
 *
 * FAIL-SAFE: if emergency-stop placement cannot be verified, the
 * newly-opened position is immediately market-closed rather than
 * left unprotected. If TP placement fails after protection is
 * confirmed, the position remains ACTIVE and protected but without a
 * TP -- Phase 8's DynamicExitController is the eventual TP owner, so
 * this is a safe, recoverable state.
 *
 * Symbol filters are fetched/parsed independently here (via
 * getExchangeInfo(), already public) rather than reaching into
 * BinanceExecutionService's own private getSymbolFilters().
 */

export interface BinanceRestLike {
  getExchangeInfo(): Promise<unknown>;
  createOrder(params: Record<string, string | number>): Promise<unknown>;
  createAlgoOrder(params: Record<string, string | number>): Promise<unknown>;
  getAlgoOrder(algoId: number): Promise<unknown>;
  getAlgoOrderByClientId(clientAlgoId: string): Promise<unknown>;
  cancelAlgoOrder(algoId: number): Promise<unknown>;
  getOrder(symbol: string, orderId: number): Promise<unknown>;
  getPositionRisk(symbol?: string): Promise<unknown>;
}

export interface SymbolFilters {
  tickSize: number;
  stepSize: number;
  pricePrecision: number;
  qtyPrecision: number;
  minQty: number;
  minNotional: number;
}

function roundToStep(value: number, step: number, precision: number): number {
  return Number((Math.round(value / step) * step).toFixed(precision));
}
function floorToStep(value: number, step: number, precision: number): number {
  return Number((Math.floor(value / step) * step).toFixed(precision));
}

export async function getSymbolFilters(
  rest: BinanceRestLike,
  symbol: string,
): Promise<SymbolFilters | null> {
  const info = (await rest.getExchangeInfo()) as {
    symbols?: Array<{
      symbol: string;
      pricePrecision: number;
      quantityPrecision: number;
      filters: Array<{
        filterType: string;
        tickSize?: string;
        stepSize?: string;
        minQty?: string;
        notional?: string;
      }>;
    }>;
  };
  const s = info.symbols?.find((x) => x.symbol === symbol);
  if (!s) return null;
  const priceFilter = s.filters.find((f) => f.filterType === "PRICE_FILTER");
  const lotFilter = s.filters.find((f) => f.filterType === "LOT_SIZE");
  const notionalFilter = s.filters.find((f) => f.filterType === "MIN_NOTIONAL");
  if (!priceFilter?.tickSize || !lotFilter?.stepSize || !lotFilter?.minQty)
    return null;
  return {
    tickSize: Number(priceFilter.tickSize),
    stepSize: Number(lotFilter.stepSize),
    pricePrecision: s.pricePrecision,
    qtyPrecision: s.quantityPrecision,
    minQty: Number(lotFilter.minQty),
    minNotional: notionalFilter?.notional ? Number(notionalFilter.notional) : 0,
  };
}

export interface EntrySequenceInput {
  userId: string;
  globalSignalId: string;
  symbol: string;
  side: Side;
  quantity: number;
  entryPriceEstimate: number;
  emergencyStopPrice: number;
  initialTpPrice: number;
}

export type EntrySequenceOutcome =
  | {
      outcome: "ENTRY_ACTIVE_WITH_TP";
      entryPrice: number;
      quantity: number;
      entryClientOrderId: string;
      emergencyStopClientAlgoId: string;
      emergencyStopBinanceAlgoId: number;
      tpClientOrderId: string;
      tpBinanceOrderId: number;
    }
  | {
      outcome: "ENTRY_ACTIVE_WITHOUT_TP";
      entryPrice: number;
      quantity: number;
      entryClientOrderId: string;
      emergencyStopClientAlgoId: string;
      emergencyStopBinanceAlgoId: number;
      tpFailureReason: string;
    }
  | {
      outcome: "PROTECTION_FAILED_CLOSED";
      entryPrice: number;
      quantity: number;
      entryClientOrderId: string;
      reason: string;
    }
  | { outcome: "ENTRY_FAILED"; reason: string };

/** The full CRITICAL sequence for ONE user. Never throws -- every
 *  failure path is caught and returns an explicit outcome. Callers
 *  run this independently per user; one user's failure has no way to
 *  affect another's call, since this function touches only the ONE
 *  BinanceRestLike instance it was given. */
export async function runEntrySequence(
  rest: BinanceRestLike,
  input: EntrySequenceInput,
): Promise<EntrySequenceOutcome> {
  try {
    const filters = await getSymbolFilters(rest, input.symbol);
    if (!filters)
      return {
        outcome: "ENTRY_FAILED",
        reason: `could not load symbol filters for ${input.symbol}`,
      };

    const roundedQty = floorToStep(
      input.quantity,
      filters.stepSize,
      filters.qtyPrecision,
    );
    if (roundedQty < filters.minQty)
      return {
        outcome: "ENTRY_FAILED",
        reason: `quantity ${roundedQty} below exchange minQty ${filters.minQty}`,
      };
    const estimatedNotional = roundedQty * input.entryPriceEstimate;
    if (estimatedNotional < filters.minNotional)
      return {
        outcome: "ENTRY_FAILED",
        reason: `notional $${estimatedNotional.toFixed(2)} below exchange minNotional $${filters.minNotional}`,
      };

    const entryClientOrderId = strategyClientOrderId(
      input.userId,
      input.globalSignalId,
      "ENTRY",
      0,
    );
    const entrySide = input.side === "LONG" ? "BUY" : "SELL";
    try {
      await rest.createOrder({
        symbol: input.symbol,
        side: entrySide,
        type: "MARKET",
        quantity: roundedQty.toFixed(filters.qtyPrecision),
        newClientOrderId: entryClientOrderId,
      });
    } catch (err) {
      return {
        outcome: "ENTRY_FAILED",
        reason: `entry order rejected: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const position = await verifyPositionOpen(rest, input.symbol, roundedQty);
    if (position === null) {
      return {
        outcome: "ENTRY_FAILED",
        reason:
          "entry order submitted but position could not be verified open on Binance -- treating as failed, never assuming a fill occurred",
      };
    }

    const closeSide = input.side === "LONG" ? "SELL" : "BUY";
    const emergencyStopClientAlgoId = strategyClientOrderId(
      input.userId,
      input.globalSignalId,
      "EMERGENCY_STOP",
      0,
    );
    let emergencyStopAlgoId: number | null = null;
    try {
      const res = (await rest.createAlgoOrder({
        symbol: input.symbol,
        side: closeSide,
        type: "STOP_MARKET",
        triggerPrice: roundToStep(
          input.emergencyStopPrice,
          filters.tickSize,
          filters.pricePrecision,
        ).toFixed(filters.pricePrecision),
        quantity: roundedQty.toFixed(filters.qtyPrecision),
        reduceOnly: "true",
        clientAlgoId: emergencyStopClientAlgoId,
      })) as { algoId: number };
      emergencyStopAlgoId = res.algoId;
    } catch (err) {
      log.error(
        {
          userId: input.userId,
          symbol: input.symbol,
          err: err instanceof Error ? err.message : String(err),
        },
        "[LOX_EMERGENCY_STOP_PLACEMENT_FAILED]",
      );
    }

    const stopVerified =
      emergencyStopAlgoId !== null &&
      (await verifyAlgoOrderOpen(rest, emergencyStopAlgoId));
    if (!stopVerified) {
      log.error(
        { userId: input.userId, symbol: input.symbol },
        "[LOX_PROTECTION_FAILED] emergency stop could not be confirmed -- fail-safe closing the position now",
      );
      await failSafeMarketClose(
        rest,
        input.symbol,
        closeSide,
        position.positionAmt,
        filters,
      );
      return {
        outcome: "PROTECTION_FAILED_CLOSED",
        entryPrice: position.entryPrice,
        quantity: position.positionAmt,
        entryClientOrderId,
        reason:
          "emergency stop placement/verification failed -- position fail-safe closed",
      };
    }

    const tpClientOrderId = strategyClientOrderId(
      input.userId,
      input.globalSignalId,
      "TAKE_PROFIT",
      0,
    );
    try {
      const tpRes = (await rest.createOrder({
        symbol: input.symbol,
        side: closeSide,
        type: "LIMIT",
        timeInForce: "GTC",
        price: roundToStep(
          input.initialTpPrice,
          filters.tickSize,
          filters.pricePrecision,
        ).toFixed(filters.pricePrecision),
        quantity: roundedQty.toFixed(filters.qtyPrecision),
        reduceOnly: "true",
        newClientOrderId: tpClientOrderId,
      })) as { orderId: number };

      const tpVerified = await verifyOrderOpen(
        rest,
        input.symbol,
        tpRes.orderId,
      );
      if (!tpVerified) {
        return {
          outcome: "ENTRY_ACTIVE_WITHOUT_TP",
          entryPrice: position.entryPrice,
          quantity: position.positionAmt,
          entryClientOrderId,
          emergencyStopClientAlgoId,
          emergencyStopBinanceAlgoId: emergencyStopAlgoId!,
          tpFailureReason: "TP order placed but could not be verified open",
        };
      }
      return {
        outcome: "ENTRY_ACTIVE_WITH_TP",
        entryPrice: position.entryPrice,
        quantity: position.positionAmt,
        entryClientOrderId,
        emergencyStopClientAlgoId,
        emergencyStopBinanceAlgoId: emergencyStopAlgoId!,
        tpClientOrderId,
        tpBinanceOrderId: tpRes.orderId,
      };
    } catch (err) {
      return {
        outcome: "ENTRY_ACTIVE_WITHOUT_TP",
        entryPrice: position.entryPrice,
        quantity: position.positionAmt,
        entryClientOrderId,
        emergencyStopClientAlgoId,
        emergencyStopBinanceAlgoId: emergencyStopAlgoId!,
        tpFailureReason: err instanceof Error ? err.message : String(err),
      };
    }
  } catch (err) {
    return {
      outcome: "ENTRY_FAILED",
      reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function verifyPositionOpen(
  rest: BinanceRestLike,
  symbol: string,
  expectedMinQty: number,
): Promise<{ entryPrice: number; positionAmt: number } | null> {
  try {
    const res = (await rest.getPositionRisk(symbol)) as Array<{
      symbol: string;
      positionAmt: string;
      entryPrice: string;
    }>;
    const pos = res.find((p) => p.symbol === symbol);
    if (!pos) return null;
    const amt = Math.abs(Number(pos.positionAmt));
    if (amt < expectedMinQty * 0.99) return null;
    return { entryPrice: Number(pos.entryPrice), positionAmt: amt };
  } catch {
    return null;
  }
}
async function verifyAlgoOrderOpen(
  rest: BinanceRestLike,
  algoId: number,
): Promise<boolean> {
  try {
    const res = (await rest.getAlgoOrder(algoId)) as { algoStatus?: string };
    return res.algoStatus === "WORKING" || res.algoStatus === "NEW";
  } catch {
    return false;
  }
}
async function verifyOrderOpen(
  rest: BinanceRestLike,
  symbol: string,
  orderId: number,
): Promise<boolean> {
  try {
    const res = (await rest.getOrder(symbol, orderId)) as { status?: string };
    return res.status === "NEW" || res.status === "PARTIALLY_FILLED";
  } catch {
    return false;
  }
}
async function failSafeMarketClose(
  rest: BinanceRestLike,
  symbol: string,
  closeSide: "BUY" | "SELL",
  quantity: number,
  filters: SymbolFilters,
): Promise<void> {
  try {
    await rest.createOrder({
      symbol,
      side: closeSide,
      type: "MARKET",
      quantity: quantity.toFixed(filters.qtyPrecision),
      reduceOnly: "true",
    });
  } catch (err) {
    log.error(
      { symbol, err: err instanceof Error ? err.message : String(err) },
      "[LOX_FAILSAFE_CLOSE_FAILED] -- CRITICAL: position may remain open and unprotected, requires immediate manual attention",
    );
  }
}
