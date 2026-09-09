// Common domain types used across the whole application.

export type Side = "LONG" | "SHORT";
export type OrderSide = "BUY" | "SELL";
export type Direction = "BULLISH" | "BEARISH";
export type TradingMode = "paper" | "live";

export type KlineInterval =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "4h"
  | "1d";

export interface Candle {
  symbol: string;
  interval: KlineInterval;
  openTime: number; // ms
  closeTime: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // base asset
  quoteVolume: number; // quote asset (USDT)
  takerBuyVolume: number; // base
  takerBuyQuoteVolume: number; // quote
  trades: number;
  isClosed: boolean;
}

export interface Trade {
  symbol: string;
  timestamp: number; // trade time (ms)
  price: number;
  quantity: number; // base
  quoteQty: number; // quote (price * quantity)
  /**
   * Binance `m` flag. true => the buyer was the MAKER, so the aggressor was a SELLER.
   * false => the buyer was the TAKER, so the aggressor was a BUYER.
   */
  isBuyerMaker: boolean;
  aggressor: OrderSide; // derived: BUY if !isBuyerMaker, SELL otherwise
}

export interface Liquidation {
  symbol: string;
  side: OrderSide; // side of the liquidation order (SELL = long liquidated, BUY = short liquidated)
  price: number;
  quantity: number;
  quoteQty: number;
  timestamp: number;
}

export interface BookTicker {
  symbol: string;
  bid: number;
  bidQty: number;
  ask: number;
  askQty: number;
  timestamp: number;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  bids: OrderBookLevel[]; // sorted desc by price
  asks: OrderBookLevel[]; // sorted asc by price
  timestamp: number;
}
