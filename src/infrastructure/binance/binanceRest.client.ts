import axios, { type AxiosInstance, isAxiosError } from "axios";
import crypto from "crypto";
import type { BinanceConfig } from "../config/binance.config";
import type { Candle, KlineInterval } from "../../shared/common.types";
import type { BinanceRestKline } from "./binance.types";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "binance-rest" });

/** Extracts ONLY safe-to-log information from a request error. Never
 *  touches err.config or err.request — those contain the full request
 *  URL (which for signed endpoints includes `signature=` and
 *  `timestamp=` in the query string) and the request headers (which
 *  include `X-MBX-APIKEY`). Binance's own error body (err.response.data,
 *  e.g. `{code: -2015, msg: "Invalid API-key, IP, or permissions..."}`)
 *  is safe — it's Binance describing the problem, not echoing the
 *  credentials back. Falls back to a generic message with no request
 *  details at all if the error shape is unexpected. */
function sanitizeRequestError(err: unknown): {
  status?: number;
  code?: number;
  msg: string;
} {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as
      | { code?: number; msg?: string }
      | undefined;
    if (data?.msg) {
      return { status, code: data.code, msg: data.msg };
    }
    // No response body (network error, timeout, DNS, etc.) — axios's
    // own top-level message is safe (e.g. "timeout of 10000ms exceeded"),
    // it doesn't include the signed query string or headers.
    return { status, msg: err.message.slice(0, 200) };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { msg: msg.slice(0, 200) };
}

/** Aug 2026, CRITICAL production hardening (operator-designed fix).
 *  Root-caused a live incident: setMarginType's "No need to change
 *  margin type" response (Binance error code -4046, genuinely harmless
 *  — it just means the account is already in the requested state) was
 *  being treated as FATAL, aborting every single live signal after the
 *  first successful trade on a symbol. The code-based exemption already
 *  existed (`msg.includes("-4046")`) but could never match: the plain
 *  `Error` thrown by signed*() only ever carried `safe.msg` (the human-
 *  readable text) — `safe.code` (the actual numeric code) was silently
 *  discarded. Same bug affected every other numeric-code check in this
 *  file (`-2013` "order does not exist", used in 2 places for
 *  reconciliation). Fix: throw this structured error class instead of
 *  a plain Error, carrying `code`/`httpStatus` as real properties —
 *  callers check `err.code === -4046`, never fragile string matching. */
export class BinanceApiError extends Error {
  readonly code?: number;
  readonly httpStatus?: number;
  constructor(message: string, code?: number, httpStatus?: number) {
    super(message);
    this.name = "BinanceApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class BinanceRestClient {
  private readonly http: AxiosInstance;

  constructor(private readonly cfg: BinanceConfig) {
    this.http = axios.create({
      baseURL: cfg.restBaseUrl,
      timeout: 10_000,
      headers: cfg.apiKey ? { "X-MBX-APIKEY": cfg.apiKey } : undefined,
    });
  }

  /**
   * Historical klines for seeding candle stores.
   */
  async getKlines(
    symbol: string,
    interval: KlineInterval,
    limit = 500,
    /** Sep 8 2026 (Karo) -- optional, additive. Binance's own
     *  /fapi/v1/klines endpoint already supports these; simply never
     *  exposed here before. Used by tools/verify-binance.ts for
     *  candle-history verification around a specific close time. */
    startTime?: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const params: Record<string, string | number> = { symbol, interval, limit };
    if (startTime !== undefined) params.startTime = startTime;
    if (endTime !== undefined) params.endTime = endTime;
    const res = await this.http.get<BinanceRestKline[]>("/fapi/v1/klines", {
      params,
    });
    return res.data.map((k) => this.parseRestKline(symbol, interval, k));
  }

  /**
   * Exchange info for precision / filters.
   */
  async getExchangeInfo(): Promise<unknown> {
    const res = await this.http.get("/fapi/v1/exchangeInfo");
    return res.data;
  }

  async ping(): Promise<void> {
    await this.http.get("/fapi/v1/ping");
  }

  /** Aug 2026, pre-flight validation prerequisite. Public, unsigned
   *  endpoint — current best bid/ask for a symbol. Used to check the
   *  trade plan against the price the MARKET order would actually
   *  execute at, before sending it (best ask for LONG/BUY, best bid
   *  for SHORT/SELL), rather than only the strategy's planned entry. */
  async getBookTicker(symbol: string): Promise<unknown> {
    const res = await this.http.get("/fapi/v1/ticker/bookTicker", {
      params: { symbol },
    });
    return res.data;
  }

  // ─── Signed endpoints (V1: stubs; wire up when live mode is enabled) ────

  async getAccount(): Promise<unknown> {
    return this.signedGet("/fapi/v2/account");
  }

  /** Aug 2026, connectivity-check only. Read-only signed GET — same
   *  auth pattern as getAccount(). No write/order capability added. */
  async getBalance(): Promise<unknown> {
    return this.signedGet("/fapi/v2/balance");
  }

  /** Account trade history for a symbol (fills), newest-last. Each fill
   *  carries orderId, side, price, qty, realizedPnl and commission -- the
   *  exchange's own record of how and at what price a position closed. */
  async getUserTrades(symbol: string, startTime: number): Promise<unknown> {
    return this.signedGet("/fapi/v1/userTrades", { symbol, startTime, limit: 1000 });
  }

  /** Account position mode. { dualSidePosition: true } = Hedge Mode.
   *  This bot sends one-way orders (no positionSide), which Binance
   *  rejects in Hedge Mode -- checked once at startup for REAL users. */
  async getPositionMode(): Promise<unknown> {
    return this.signedGet("/fapi/v1/positionSide/dual");
  }

  async setLeverage(symbol: string, leverage: number): Promise<unknown> {
    return this.signedPost("/fapi/v1/leverage", { symbol, leverage });
  }

  /** Aug 2026, execution-layer prerequisite. Sets ISOLATED or CROSSED
   *  margin mode for a symbol. Binance returns an error (code -4046)
   *  if margin type is already what was requested — callers should
   *  treat that specific case as success, not failure (see
   *  BinanceExecutionService). */
  async setMarginType(
    symbol: string,
    marginType: "ISOLATED" | "CROSSED",
  ): Promise<unknown> {
    return this.signedPost("/fapi/v1/marginType", { symbol, marginType });
  }

  async createOrder(params: Record<string, string | number>): Promise<unknown> {
    return this.signedPost("/fapi/v1/order", params);
  }

  /** Aug 2026, CRITICAL production hardening. Binance migrated ALL
   *  USDⓈ-M Futures conditional order types (STOP_MARKET, TAKE_PROFIT_
   *  MARKET, STOP, TAKE_PROFIT, TRAILING_STOP_MARKET) to a separate
   *  Algo Order service effective 2025-12-09 — the traditional
   *  POST /fapi/v1/order now REJECTS these types outright with error
   *  -4120 ("Order type not supported for this endpoint. Please use
   *  the Algo Order API endpoints instead."). This is what caused
   *  every SL/TP placement to fail in production (see the Aug 2026
   *  incident: DOGEUSDT EMERGENCY_CLOSED, root-caused via
   *  execution_records.notes). MARKET/LIMIT entry orders are
   *  UNAFFECTED and continue to use createOrder()/`/fapi/v1/order`
   *  above — only conditional (trigger-based) orders moved.
   *  Response field names differ from the old endpoint: `algoId`
   *  (not `orderId`), `clientAlgoId` (not `clientOrderId`),
   *  `algoStatus` (not `status`), `triggerPrice` (not `stopPrice`
   *  as the request param — this method's `params` must use
   *  `triggerPrice`, not `stopPrice`). See
   *  https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Algo-Order */
  async createAlgoOrder(
    params: Record<string, string | number>,
  ): Promise<unknown> {
    return this.signedPost("/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL",
      ...params,
    });
  }

  /** Aug 2026, execution-layer prerequisite. Queries a single algo
   *  (conditional) order's current state by algoId — used to verify
   *  SL/TP orders were actually accepted and are resting. Unlike
   *  getOrder(), this endpoint does not take a symbol parameter. */
  async getAlgoOrder(algoId: number): Promise<unknown> {
    return this.signedGet("/fapi/v1/algoOrder", { algoId });
  }

  /** Aug 2026, production hardening. Queries an algo order by its
   *  client-assigned ID (clientAlgoId) — the algo-order equivalent of
   *  getOrderByClientId(), used for SL/TP ambiguity reconciliation
   *  when a createAlgoOrder() call's response was lost. */
  async getAlgoOrderByClientId(clientAlgoId: string): Promise<unknown> {
    return this.signedGet("/fapi/v1/algoOrder", { clientAlgoId });
  }

  /** Aug 2026, mandatory abort-cleanup prerequisite (closes the XRP
   *  incident gap: SL verification failed → we emergency-closed the
   *  POSITION, but never cancelled the SL algo order itself, leaving
   *  it orphaned and still resting on Binance with nothing left to
   *  protect). Cancels a single algo order by its algoId. "Already
   *  cancelled" / "doesn't exist" is the caller's problem to treat as
   *  success — this method just forwards Binance's response/error. */
  async cancelAlgoOrder(algoId: number): Promise<unknown> {
    return this.signedDelete("/fapi/v1/algoOrder", { algoId });
  }

  /** Aug 2026, mandatory abort-cleanup prerequisite. Lists ALL open
   *  (resting) algo orders for a symbol — used as the final ground-
   *  truth check after an abort/emergency-close: even if we've lost
   *  track of a specific algoId (e.g. verification itself failed
   *  before we could confirm one cleanly), this catches anything left
   *  resting regardless of how we got there. */
  async getOpenAlgoOrders(symbol: string): Promise<unknown> {
    return this.signedGet("/fapi/v1/openAlgoOrders", { symbol });
  }

  /** Aug 2026, execution-layer prerequisite. Queries a single order's
   *  current state — used to confirm fill before placing SL/TP, and to
   *  verify SL/TP orders themselves were actually accepted. */
  async getOrder(symbol: string, orderId: number): Promise<unknown> {
    return this.signedGet("/fapi/v1/order", { symbol, orderId });
  }

  /** Sep 17 2026 (Karo), operator-requested LOX cleanup prerequisite.
   *  Cancels a single REGULAR order (e.g. a TAKE_PROFIT LIMIT order,
   *  which uses this endpoint, not the algo-order one that
   *  cancelAlgoOrder above targets) by its orderId. Mirrors
   *  cancelAlgoOrder's own shape/semantics exactly -- "already
   *  cancelled"/"doesn't exist" is the caller's problem to treat as
   *  success, this method just forwards Binance's response/error. No
   *  existing V3/V5 code path is touched by adding this. */
  async cancelOrder(symbol: string, orderId: number): Promise<unknown> {
    return this.signedDelete("/fapi/v1/order", { symbol, orderId });
  }

  /** Aug 2026, production hardening. Queries an order by the
   *  client-assigned ID (origClientOrderId) instead of Binance's own
   *  orderId — critical for entry-ambiguity reconciliation, where we
   *  may never have received an orderId back from a failed/timed-out
   *  createOrder() call, but DO know the clientOrderId we sent. */
  async getOrderByClientId(
    symbol: string,
    origClientOrderId: string,
  ): Promise<unknown> {
    return this.signedGet("/fapi/v1/order", { symbol, origClientOrderId });
  }

  /** Aug 2026, production hardening. Returns current position size/
   *  entry price for a symbol — the ground truth for "is there
   *  actually an open position", used by startup reconciliation and
   *  emergency-close verification. positionAmt is signed (negative for
   *  SHORT in one-way mode). */
  async getPositionRisk(symbol?: string): Promise<unknown> {
    return this.signedGet("/fapi/v2/positionRisk", symbol ? { symbol } : {});
  }

  async getOpenOrders(symbol: string): Promise<unknown> {
    return this.signedGet("/fapi/v1/openOrders", { symbol });
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private parseRestKline(
    symbol: string,
    interval: KlineInterval,
    k: BinanceRestKline,
  ): Candle {
    return {
      symbol,
      interval,
      openTime: k[0],
      closeTime: k[6],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      quoteVolume: Number(k[7]),
      trades: k[8],
      takerBuyVolume: Number(k[9]),
      takerBuyQuoteVolume: Number(k[10]),
      isClosed: true,
    };
  }

  private sign(queryString: string): string {
    return crypto
      .createHmac("sha256", this.cfg.apiSecret)
      .update(queryString)
      .digest("hex");
  }

  private requireAuth(): void {
    if (!this.cfg.apiKey || !this.cfg.apiSecret) {
      throw new Error("API key/secret required for signed endpoints");
    }
  }

  /** Sep 8 2026 (Karo), multi-user addition -- lets a caller (e.g.
   *  BinanceExecutionService.validateForLiveStart()) check THIS
   *  instance's own credentials, instead of reading a global
   *  process.env var that may be intentionally blank in a multi-user
   *  setup (real per-user keys live in users.config.json, not the
   *  shared .env). Same underlying check as requireAuth() above,
   *  exposed as a non-throwing boolean. */
  hasCredentials(): boolean {
    return Boolean(this.cfg.apiKey) && Boolean(this.cfg.apiSecret);
  }

  private buildSignedQuery(params: Record<string, string | number>): string {
    this.requireAuth();
    const withMeta = {
      ...params,
      timestamp: Date.now(),
      recvWindow: this.cfg.recvWindowMs,
    };
    const qs = new URLSearchParams(
      Object.entries(withMeta).map(([k, v]): [string, string] => [
        k,
        String(v),
      ]),
    ).toString();
    return `${qs}&signature=${this.sign(qs)}`;
  }

  private async signedGet(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<unknown> {
    const qs = this.buildSignedQuery(params);
    try {
      const res = await this.http.get(`${path}?${qs}`);
      return res.data;
    } catch (err) {
      // Never log `err` raw here — see sanitizeRequestError doc comment.
      const safe = sanitizeRequestError(err);
      log.error(
        { path, status: safe.status, code: safe.code, msg: safe.msg },
        "signed GET failed",
      );
      throw new BinanceApiError(
        `Binance signed GET ${path} failed: ${safe.msg}`,
        safe.code,
        safe.status,
      );
    }
  }

  private async signedPost(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<unknown> {
    const qs = this.buildSignedQuery(params);
    try {
      const res = await this.http.post(`${path}?${qs}`);
      return res.data;
    } catch (err) {
      const safe = sanitizeRequestError(err);
      log.error(
        { path, status: safe.status, code: safe.code, msg: safe.msg },
        "signed POST failed",
      );
      throw new BinanceApiError(
        `Binance signed POST ${path} failed: ${safe.msg}`,
        safe.code,
        safe.status,
      );
    }
  }

  /** Aug 2026, abort-cleanup prerequisite (cancelAlgoOrder). */
  private async signedDelete(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<unknown> {
    const qs = this.buildSignedQuery(params);
    try {
      const res = await this.http.delete(`${path}?${qs}`);
      return res.data;
    } catch (err) {
      const safe = sanitizeRequestError(err);
      log.error(
        { path, status: safe.status, code: safe.code, msg: safe.msg },
        "signed DELETE failed",
      );
      throw new BinanceApiError(
        `Binance signed DELETE ${path} failed: ${safe.msg}`,
        safe.code,
        safe.status,
      );
    }
  }
}
