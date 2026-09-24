import { BinanceWsClient } from "../infrastructure/binance/binanceWs.client";
import type { BinanceConfig } from "../infrastructure/config/binance.config";
import type { RawLiquidationEventRepository } from "../infrastructure/mongo/raw-liquidation-event.repository";
import type { OiSecondObservationRepository } from "../infrastructure/mongo/oi-second-observation.repository";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "collector" });

const OI_POLL_MS = 1_000;
const OI_FETCH_TIMEOUT_MS = 5_000;
const FEED_SILENCE_ALERT_MS = 2 * 60_000;

/**
 * Market data collector -- the ONLY writer of the two collections V9 reads.
 *
 *  WebSocket  forceOrder -> liq_raw_events (every liquidation, as it happens)
 *             bookTicker -> latest mid price per symbol (in memory)
 *  REST       /fapi/v1/openInterest every second per symbol
 *             -> oi_second_observations (OI + Binance update time + mid price)
 *
 * No candles, depth, trades, ATR or any other stream: V9 needs none of them.
 */
export class MarketCollector {
  private readonly ws: Pick<BinanceWsClient, "on" | "subscribe" | "start" | "stop">;
  private readonly mid = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private pollRunning = false;
  private lastTickAt = Date.now();

  constructor(
    private readonly symbols: readonly string[],
    binanceConfig: BinanceConfig,
    private readonly liquidations: RawLiquidationEventRepository,
    private readonly oi: OiSecondObservationRepository,
    private readonly alert: (text: string) => Promise<void>,
    ws?: Pick<BinanceWsClient, "on" | "subscribe" | "start" | "stop">,
  ) {
    this.ws = ws ?? new BinanceWsClient(binanceConfig);
  }

  start(): void {
    this.ws.on("open", () => log.info("[WS] connected"));
    this.ws.on("close", (code: number) => log.warn({ code }, "[WS] closed (the client reconnects)"));
    this.ws.on("error", (err: Error) => log.error({ err: err.message }, "[WS] error"));
    this.ws.on("bookTicker", (b: { symbol: string; bid: number; ask: number }) => {
      this.mid.set(b.symbol, (b.bid + b.ask) / 2);
      this.lastTickAt = Date.now();
    });
    this.ws.on("liquidation", (l: { symbol: string; side: "BUY" | "SELL"; price: number; quoteQty: number; timestamp: number }) => {
      void this.liquidations.insert({
        symbol: l.symbol,
        victim: l.side === "SELL" ? "LONG" : "SHORT", // a SELL forced order closes a LONG
        price: l.price, quoteQty: l.quoteQty, timestamp: l.timestamp,
      });
    });
    this.ws.subscribe({ symbols: [...this.symbols], intervals: [], aggTrade: false, bookTicker: true, depth: false, forceOrder: true });
    this.ws.start();
    this.oi.start();
    this.pollTimer = setInterval(() => void this.pollOi(), OI_POLL_MS);
    this.watchdogTimer = setInterval(() => void this.watchdog(), 30_000);
    log.info(`[COLLECTOR_STARTED] symbols=${this.symbols.join(",")}`);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.ws.stop();
    await this.oi.stop();
  }

  /** One OI poll round (public for tests). */
  async pollOi(): Promise<void> {
    if (this.pollRunning) return; // never stack polls if one is slow
    this.pollRunning = true;
    try {
      await Promise.all(this.symbols.map((s) => this.pollOne(s)));
    } finally {
      this.pollRunning = false;
    }
  }

  private async pollOne(symbol: string): Promise<void> {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, { signal: AbortSignal.timeout(OI_FETCH_TIMEOUT_MS) });
      if (!res.ok) { log.warn(`[OI_POLL] ${symbol} HTTP ${res.status}`); return; }
      const data = (await res.json()) as { openInterest?: string; time?: number };
      const contracts = Number(data.openInterest);
      if (!(contracts > 0)) return;
      const price = this.mid.get(symbol) ?? null;
      this.oi.add({
        symbol, timestamp: new Date(), oiUpdatedAt: typeof data.time === "number" ? new Date(data.time) : null,
        openInterest: contracts, openInterestUsd: price !== null ? contracts * price : null, price,
      });
    } catch (err) {
      log.warn(`[OI_POLL] ${symbol} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private silentSince: number | null = null;
  private async watchdog(): Promise<void> {
    const silentMs = Date.now() - this.lastTickAt;
    if (silentMs > FEED_SILENCE_ALERT_MS && this.silentSince === null) {
      this.silentSince = this.lastTickAt;
      log.error(`[FEED_SILENT] no market data for ${Math.round(silentMs / 1000)}s`);
      await this.alert(`⚠️ Market data feed silent for ${Math.round(silentMs / 60_000)} min -- signals paused until it recovers`).catch(() => undefined);
    } else if (silentMs <= FEED_SILENCE_ALERT_MS && this.silentSince !== null) {
      this.silentSince = null;
      log.warn("[FEED_RECOVERED]");
      await this.alert("✅ Market data feed recovered").catch(() => undefined);
    }
  }
}
