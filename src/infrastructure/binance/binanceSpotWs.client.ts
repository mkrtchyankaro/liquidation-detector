import WebSocket from "ws";
import { EventEmitter } from "events";
import type { Trade, BookTicker } from "../../shared/common.types";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "binance-spot-ws" });

/**
 * Sep 19 2026 (Karo), operator-requested Spot-vs-Futures order-flow
 * observation.
 * Sep 19 2026 (Karo), operator-requested EXTENSION -- Episode Research
 * capture (episode-research-recorder.ts) needs Spot bid/ask/mid at
 * arbitrary moments (episode start, every liquidation event, every
 * new extreme, episode end, entry) for basis (futuresMid - spotMid)
 * tracking. Extended to ALSO subscribe to @bookTicker, alongside the
 * existing @aggTrade -- still ONE client, ONE connection, per symbol
 * set (Binance's combined-stream endpoint accepts a mixed stream
 * list).
 *
 * Deliberately a SEPARATE, minimal client from BinanceWsClient
 * (binanceWs.client.ts) -- that one is production-critical Futures
 * infrastructure and is NOT modified here. Binance Spot is a
 * genuinely different base URL and endpoint shape.
 *
 * The reconnect/backoff pattern below (exponential, capped at 30s,
 * ping/pong, resubscribe on reconnect via the same combined-stream
 * URL) intentionally MIRRORS BinanceWsClient's own WsConnection
 * class, per the operator's own "reuse the existing lifecycle and
 * reconnection patterns" instruction -- not literally shared code
 * (that class is private/unexported there), but the same behavior.
 *
 * Purely observational: consumers are RecoveryFlowTracker (aggTrade)
 * and MarketSnapshotCache + EpisodeResearchRecorder (aggTrade +
 * bookTicker). No trading decision anywhere reads from this directly.
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

interface BinanceSpotBookTickerEvent {
  u: number;
  s: string;
  b: string;
  B: string;
  a: string;
  A: string;
}

interface SpotCombinedStreamEvent {
  stream?: string;
  data?: unknown;
}

export interface BinanceSpotWsEvents {
  aggTrade: (t: Trade) => void;
  bookTicker: (b: BookTicker) => void;
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
    this.streams = symbols.flatMap((s) => [`${s.toLowerCase()}@aggTrade`, `${s.toLowerCase()}@bookTicker`]);
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
    if (!data) return;

    if (stream.includes("@aggTrade")) {
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
    } else if (stream.includes("@bookTicker")) {
      const ev = data as unknown as BinanceSpotBookTickerEvent;
      const bid = Number(ev.b);
      const ask = Number(ev.a);
      if (!(bid > 0) || !(ask > 0)) return;
      const bt: BookTicker = {
        symbol: ev.s,
        bid,
        bidQty: Number(ev.B),
        ask,
        askQty: Number(ev.A),
        // Sep 19 2026 (Karo) -- Binance's SPOT bookTicker payload
        // carries no exchange timestamp field (unlike Futures' own T);
        // local receipt time is used, and MarketSnapshotCache's own
        // "data age" tracking already accounts for this by comparing
        // against wall-clock at read time regardless of source.
        timestamp: Date.now(),
      };
      this.emit("bookTicker", bt);
    }
  }
}
