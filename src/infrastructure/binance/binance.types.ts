// Raw Binance Futures WebSocket payload shapes. These are only the fields we use.

export interface BinanceCombinedStreamEvent<T> {
  stream: string;
  data: T;
}

export interface BinanceKlineEvent {
  e: 'kline';
  E: number;
  s: string;
  k: {
    t: number;  // kline start
    T: number;  // kline close time
    s: string;
    i: string;  // interval
    f: number;
    L: number;
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;  // base vol
    n: number;  // trades
    x: boolean; // closed
    q: string;  // quote vol
    V: string;  // taker buy base vol
    Q: string;  // taker buy quote vol
  };
}

export interface BinanceAggTradeEvent {
  e: 'aggTrade';
  E: number;
  s: string;
  a: number;
  p: string;
  q: string;
  f: number;
  l: number;
  T: number;
  m: boolean; // isBuyerMaker
}

export interface BinanceBookTickerEvent {
  e?: 'bookTicker';
  u: number;
  s: string;
  b: string;   // best bid
  B: string;   // best bid qty
  a: string;   // best ask
  A: string;   // best ask qty
  T?: number;
  E?: number;
}

export interface BinanceForceOrderEvent {
  e: 'forceOrder';
  E: number;
  o: {
    s: string;
    S: 'BUY' | 'SELL';
    o: string;
    f: string;
    q: string;
    p: string;
    ap: string;
    X: string;
    l: string;
    z: string;
    T: number;
  };
}

export interface BinanceDepthEvent {
  e?: string;
  E?: number;
  T?: number;
  s?: string;
  U?: number;
  u?: number;
  pu?: number;
  b: [string, string][]; // bids
  a: [string, string][]; // asks
}

export interface BinanceRestKline {
  // /fapi/v1/klines returns an array of arrays
  0: number;   // open time
  1: string;   // open
  2: string;   // high
  3: string;   // low
  4: string;   // close
  5: string;   // volume
  6: number;   // close time
  7: string;   // quote volume
  8: number;   // trades
  9: string;   // taker buy base
  10: string;  // taker buy quote
  11: string;  // ignore
}
