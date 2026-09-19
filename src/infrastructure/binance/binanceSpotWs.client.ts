import WebSocket from "ws";
import { EventEmitter } from "events";
import type { Trade } from "../../shared/common.types";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "binance-spot-ws" });

/**
 * Sep 19 2026 (Karo), operator-requested Spot-vs-Futures order-flow
 * observation.
 *
 * Deliberately a SEPARATE, minimal client from BinanceWsClient
 * (binanceWs.client.ts) -- that one is production-critical Futures
 * infrastructure (kline/bookTicker/depth/forceOrder/aggTrade across
 * two routed endpoints) and is NOT modified here. Binance Spot is a
 * genuinely different base URL, a different combined-stream endpoint
 * shape, and this client only ever needs ONE stream type (aggTrade)
 * -- a second full-featured client would be needless surface area.
 *
 * The reconnect/backoff pattern below (exponential, capped at 30s,
 * ping/pong, resubscribe on reconnect via the same combined-stream
 * URL) intentionally MIRRORS BinanceWsClient's own WsConnection
 * class, per the operator's own "reuse the existing lifecycle and
 * reconnection patterns" instruction -- not literally shared code
 * (that class is private/unexported there), but the same behavior.
 *
 * Purely observational: this client's only consumer is
 * OrderFlowEpisodeTracker (order-flow-episode-tracker.ts). No trading
 * decision anywhere reads from it directly.
 */

interface BinanceSpotAggTradeEvent {
  e: "aggTrade";
  E: number;
  s: string;
  a: number;
  p: string;
  q: string;
  f: number;
  l: number;
  T: number;
  m: boolean;
}

interface SpotCombinedStreamEvent {
  stream?: string;
  data?: unknown;
}

export interface BinanceSpotWsEvents {
  aggTrade: (t: Trade) => void;
  open: () => void;
  close: (code: number) => void;
  error: (err: Error) => void;
}

export interface BinanceSpotWsClient extends EventEmitter {
  on<K extends keyof BinanceSpotWsEvents>(event: K, listener: BinanceSpotWsEvents[K]): this;
  emit<K extends keyof BinanceSpotWsEvents>(event: K, ...args: Parameters<BinanceSpotWsEvents[K]>): boolean;
}

export class BinanceSpotWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private shouldRun = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly streams: string[];

  constructor(
    private readonly wsBaseUrl: string,
    symbols: string[],
  ) {
    super();
    this.streams = symbols.map((s) => `${s.toLowerCase()}@aggTrade`);
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
      log.debug("no Spot symbols configured; skipping connection");
      return;
    }
    const path = this.streams.join("/");
    const url = `${this.wsBaseUrl}/stream?streams=${path}`;
    log.info({ streamCount: this.streams.length, url: url.slice(0, 120) }, "connecting Spot WS");
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      log.info("Spot WS connected");
      this.emit("open");
    });

    ws.on("message", (raw) => this.handleMessage(raw.toString()));

    ws.on("ping", (data) => {
      try {
        ws.pong(data);
      } catch {
        /* noop */
      }
    });

    ws.on("close", (code) => {
      log.warn({ code }, "Spot WS closed");
      this.emit("close", code);
      this.ws = null;
      if (this.shouldRun) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      log.error({ err: err.message }, "Spot WS error");
      this.emit("error", err);
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts);
    log.info({ attempt: this.reconnectAttempts, delay }, "scheduling Spot WS reconnect");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private handleMessage(payload: string): void {
    let msg: SpotCombinedStreamEvent;
    try {
      msg = JSON.parse(payload) as SpotCombinedStreamEvent;
    } catch (err) {
      log.warn({ err }, "malformed Spot WS message");
      return;
    }
    const stream = msg.stream ?? "";
    const data = msg.data as Record<string, unknown> | undefined;
    if (!data || !stream.includes("@aggTrade")) return;

    const ev = data as unknown as BinanceSpotAggTradeEvent;
    const price = Number(ev.p);
    const qty = Number(ev.q);
    if (!(price > 0) || !(qty > 0)) return; // defensive -- never happens on a real feed
    const trade: Trade = {
      symbol: ev.s,
      timestamp: ev.T,
      price,
      quantity: qty,
      quoteQty: price * qty,
      isBuyerMaker: ev.m,
      aggressor: ev.m ? "SELL" : "BUY",
      aggTradeId: ev.a,
    };
    this.emit("aggTrade", trade);
  }
}
