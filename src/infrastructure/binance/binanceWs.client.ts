import WebSocket from "ws";
import { EventEmitter } from "events";
import type { BinanceConfig } from '../config/binance.config';
import type {
  Candle,
  Trade,
  Liquidation,
  BookTicker,
  KlineInterval,
  OrderBookSnapshot,
} from '../../shared/common.types';
import type {
  BinanceCombinedStreamEvent,
  BinanceKlineEvent,
  BinanceAggTradeEvent,
  BinanceBookTickerEvent,
  BinanceForceOrderEvent,
  BinanceDepthEvent,
} from "./binance.types";
import { childLogger } from '../logging/logger';

const log = childLogger({ mod: "binance-ws" });
const liqEventLog = childLogger({ mod: "liq-event" });

interface Subscriptions {
  symbols: string[];
  intervals: KlineInterval[];
  aggTrade: boolean;
  bookTicker: boolean;
  depth: boolean;
  forceOrder: boolean;
}

export interface BinanceWsEvents {
  kline: (c: Candle) => void;
  aggTrade: (t: Trade) => void;
  bookTicker: (b: BookTicker) => void;
  liquidation: (l: Liquidation) => void;
  orderbook: (snap: OrderBookSnapshot) => void;
  open: () => void;
  close: (code: number) => void;
  error: (err: Error) => void;
}

export interface BinanceWsClient extends EventEmitter {
  on<K extends keyof BinanceWsEvents>(
    event: K,
    listener: BinanceWsEvents[K],
  ): this;
  emit<K extends keyof BinanceWsEvents>(
    event: K,
    ...args: Parameters<BinanceWsEvents[K]>
  ): boolean;
}

/**
 * Internal helper: a single connection to one of the Binance routed endpoints
 * (/public, /market). Public-facing API stays on BinanceWsClient.
 *
 * IMPORTANT — Binance USDⓈ-M Futures WebSocket migration (2025):
 *   Per official docs (Important WebSocket Change Notice), the legacy URL
 *   `wss://fstream.binance.com/stream?streams=...` is deprecated and traffic
 *   has been split into:
 *     - /public  for high-frequency public market data (bookTicker, depth)
 *     - /market  for regular market data (kline, aggTrade, forceOrder, ...)
 *     - /private for user data
 *   We use stream mode (?streams=) on each endpoint per their recommendation.
 *
 * Endpoint mapping in this client:
 *   forceOrder    → /market   (CRITICAL: legacy endpoint silently drops these)
 *   kline_*       → /market
 *   aggTrade      → /market
 *   bookTicker    → /public
 *   depth20@100ms → /public
 */
class WsConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private shouldRun = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly group: "public" | "market",
    private readonly wsBaseUrl: string,
    private readonly streams: string[],
    private readonly onMessage: (payload: string) => void,
  ) {
    super();
  }

  start(): void {
    this.shouldRun = true;
    this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
    }
    this.ws = null;
  }

  private connect(): void {
    if (!this.shouldRun) return;
    if (this.streams.length === 0) {
      log.debug({ group: this.group }, "no streams in group; skipping");
      return;
    }
    const path = this.streams.join("/");
    const url = `${this.wsBaseUrl}/${this.group}/stream?streams=${path}`;
    log.info(
      {
        group: this.group,
        streamCount: this.streams.length,
        url: url.slice(0, 120),
      },
      "connecting WS",
    );
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      log.info({ group: this.group }, "WS connected");
      this.emit("open");
    });

    ws.on("message", (raw) => this.onMessage(raw.toString()));

    ws.on("ping", (data) => {
      try {
        ws.pong(data);
      } catch {
        /* noop */
      }
    });

    ws.on("close", (code) => {
      log.warn({ group: this.group, code }, "WS closed");
      this.emit("close", code);
      this.ws = null;
      if (this.shouldRun) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      log.error({ group: this.group, err: err.message }, "WS error");
      this.emit("error", err);
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts);
    log.info(
      { group: this.group, attempt: this.reconnectAttempts, delay },
      "scheduling reconnect",
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

export class BinanceWsClient extends EventEmitter {
  private subs: Subscriptions = {
    symbols: [],
    intervals: [],
    aggTrade: false,
    bookTicker: false,
    depth: false,
    forceOrder: false,
  };
  private connections: WsConnection[] = [];

  /** Throttle for the diagnostic [liq-event] log: max 1 line per symbol per 2s. */
  private readonly liqLogLastAt = new Map<string, number>();
  private readonly LIQ_LOG_THROTTLE_MS = 2_000;

  constructor(private readonly cfg: BinanceConfig) {
    super();
  }

  subscribe(subs: Subscriptions): void {
    this.subs = subs;
  }

  /** Build the per-group stream lists according to Binance's 2025 endpoint split. */
  private buildStreamsByGroup(): { market: string[]; public: string[] } {
    const market: string[] = [];
    const pub: string[] = [];
    for (const sym of this.subs.symbols) {
      const s = sym.toLowerCase();
      // /market (regular market data)
      for (const itv of this.subs.intervals) market.push(`${s}@kline_${itv}`);
      if (this.subs.aggTrade) market.push(`${s}@aggTrade`);
      if (this.subs.forceOrder) market.push(`${s}@forceOrder`);
      // /public (high-frequency public data)
      if (this.subs.bookTicker) pub.push(`${s}@bookTicker`);
      if (this.subs.depth) pub.push(`${s}@depth20@100ms`);
    }
    return { market, public: pub };
  }

  start(): void {
    const { market, public: pub } = this.buildStreamsByGroup();
    if (market.length === 0 && pub.length === 0) {
      log.warn("no streams subscribed; not connecting");
      return;
    }

    log.info(
      {
        groups: [
          {
            group: "market",
            path: "/market",
            streamCount: market.length,
            sample: market.slice(0, 3),
          },
          {
            group: "public",
            path: "/public",
            streamCount: pub.length,
            sample: pub.slice(0, 3),
          },
        ],
      },
      "WS routing plan resolved",
    );

    if (market.length > 0) {
      const conn = new WsConnection("market", this.cfg.wsBaseUrl, market, (p) =>
        this.handleMessage(p),
      );
      this.wireConnection(conn);
      conn.start();
      this.connections.push(conn);
    }
    if (pub.length > 0) {
      const conn = new WsConnection("public", this.cfg.wsBaseUrl, pub, (p) =>
        this.handleMessage(p),
      );
      this.wireConnection(conn);
      conn.start();
      this.connections.push(conn);
    }
  }

  stop(): void {
    for (const c of this.connections) c.stop();
    this.connections = [];
  }

  private wireConnection(conn: WsConnection): void {
    conn.on("open", () => this.emit("open"));
    conn.on("close", (...args: unknown[]) => {
      const code = (args[0] ?? 1006) as number;
      this.emit("close", code);
    });
    conn.on("error", (...args: unknown[]) => {
      const err = (args[0] ?? new Error("unknown")) as Error;
      this.emit("error", err);
    });
  }

  private handleMessage(payload: string): void {
    let msg: BinanceCombinedStreamEvent<unknown>;
    try {
      msg = JSON.parse(payload) as BinanceCombinedStreamEvent<unknown>;
    } catch (err) {
      log.warn({ err }, "malformed WS message");
      return;
    }

    const stream = msg.stream ?? "";
    const data = msg.data as Record<string, unknown> | undefined;
    if (!data) return;

    if (stream.includes("@kline_"))
      this.handleKline(data as unknown as BinanceKlineEvent);
    else if (stream.includes("@aggTrade"))
      this.handleAggTrade(data as unknown as BinanceAggTradeEvent);
    else if (stream.includes("@bookTicker"))
      this.handleBookTicker(data as unknown as BinanceBookTickerEvent);
    else if (stream.includes("@depth"))
      this.handleDepth(stream, data as unknown as BinanceDepthEvent);
    else if (stream.includes("@forceOrder"))
      this.handleForceOrder(data as unknown as BinanceForceOrderEvent);
  }

  private handleKline(ev: BinanceKlineEvent): void {
    const k = ev.k;
    const candle: Candle = {
      symbol: ev.s,
      interval: k.i as KlineInterval,
      openTime: k.t,
      closeTime: k.T,
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
      quoteVolume: Number(k.q),
      takerBuyVolume: Number(k.V),
      takerBuyQuoteVolume: Number(k.Q),
      trades: k.n,
      isClosed: k.x,
    };
    this.emit("kline", candle);
  }

  private handleAggTrade(ev: BinanceAggTradeEvent): void {
    const price = Number(ev.p);
    const qty = Number(ev.q);
    const trade: Trade = {
      symbol: ev.s,
      timestamp: ev.T,
      price,
      quantity: qty,
      quoteQty: price * qty,
      isBuyerMaker: ev.m,
      aggressor: ev.m ? "SELL" : "BUY",
    };
    this.emit("aggTrade", trade);
  }

  private handleBookTicker(ev: BinanceBookTickerEvent): void {
    const bt: BookTicker = {
      symbol: ev.s,
      bid: Number(ev.b),
      bidQty: Number(ev.B),
      ask: Number(ev.a),
      askQty: Number(ev.A),
      timestamp: ev.T ?? Date.now(),
    };
    this.emit("bookTicker", bt);
  }

  private handleDepth(stream: string, ev: BinanceDepthEvent): void {
    // stream format: btcusdt@depth20@100ms → extract symbol
    const symbol = (stream.split("@")[0] ?? "").toUpperCase();
    if (!symbol) return;
    const snap: OrderBookSnapshot = {
      symbol,
      timestamp: ev.T ?? ev.E ?? Date.now(),
      bids: ev.b.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
      asks: ev.a.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
    };
    this.emit("orderbook", snap);
  }

  private handleForceOrder(ev: BinanceForceOrderEvent): void {
    const o = ev.o;
    const price = Number(o.ap || o.p);
    const qty = Number(o.q);
    const liq: Liquidation = {
      symbol: o.s,
      side: o.S,
      price,
      quantity: qty,
      quoteQty: price * qty,
      timestamp: o.T,
    };

    // Diagnostic — visible proof that forceOrder events are flowing.
    // Throttled per-symbol so a real liquidation cascade doesn't flood logs.
    // Binance forceOrder.side = SELL means a LONG was force-closed.
    const now = Date.now();
    const lastAt = this.liqLogLastAt.get(liq.symbol) ?? 0;
    if (now - lastAt >= this.LIQ_LOG_THROTTLE_MS) {
      this.liqLogLastAt.set(liq.symbol, now);
      const victim = liq.side === "SELL" ? "LONG" : "SHORT";
      liqEventLog.info(
        `${liq.symbol} victim=${victim} notional=${formatUsd(liq.quoteQty)} price=${liq.price}`,
      );
    }

    this.emit("liquidation", liq);
  }
}

/** Compact USD formatting for the diagnostic log: 12_300 → "12.3k", 2_400_000 → "2.4M". */
function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return Math.round(n).toString();
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(2).replace(/\.00$/, "") + "M";
}
