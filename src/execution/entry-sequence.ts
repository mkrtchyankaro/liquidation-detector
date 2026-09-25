type Side = "LONG" | "SHORT";
import { strategyClientOrderId } from "./client-order-id";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "entry" });

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 5-7.
 * Sep 19 2026 (Karo), operator-requested REVISION -- the resting
 * STOP_MARKET is no longer a wide, catastrophe-only "emergency"
 * buffer: it now sits at our own calculated strategyInvalidationPrice
 * itself (the same price PAPER users are monitored against). The
 * operator's own reasoning: if we can place a real resting SL order
 * at entry, we ARE protected -- there is no longer a distinct
 * "emergency" tier, and no in-process STRATEGY_INVALIDATION
 * monitoring for REAL users (see
 * liquidation-oi-active-main-runtime.service.ts's onActiveTick --
 * that check now no-ops for REAL, Binance's own resting order is the
 * sole mechanism). PAPER users are unaffected: no real order exists
 * for them, so they are still monitored the same causal, in-process
 * way as before.
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
 *   ENTRY fill -> VERIFY position -> place SL STOP_MARKET
 *   (via createAlgoOrder -- confirmed the ONLY working path for
 *   STOP_MARKET since Binance rejected it on /fapi/v1/order,
 *   error -4120) -> VERIFY the algo order exists -> place initial TP
 *   -> VERIFY it exists -> user ACTIVE.
 *
 * FAIL-SAFE: if SL placement cannot be verified, the
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
  /** Sep 17 2026 (Karo), operator-requested Section M/N additions --
   *  cancelOrder is the REGULAR-order counterpart to cancelAlgoOrder
   *  (needed to cancel a TAKE_PROFIT LIMIT order during cleanup/TP
   *  revision). getOpenOrders/getOpenAlgoOrders are the ground-truth
   *  scans used by restart orphan-recovery (Section N) and cleanup's
   *  own final verification. */
  cancelOrder(symbol: string, orderId: number): Promise<unknown>;
  getOpenOrders(symbol: string): Promise<unknown>;
  getOpenAlgoOrders(symbol: string): Promise<unknown>;
  /** Optional capabilities (present on the real BinanceRestClient). When
   *  a method is missing (older test doubles), the corresponding step is
   *  skipped and the sequence behaves exactly as before. */
  getBookTicker?(symbol: string): Promise<unknown>;
  getUserTrades?(symbol: string, startTime: number): Promise<unknown>;
  setLeverage?(symbol: string, leverage: number): Promise<unknown>;
  setMarginType?(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<unknown>;
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
  // 1e-9 absorbs float noise (e.g. 1/(0.199-0.198) = 999.9999999999991)
  // so an exact step count is never floored one step short.
  return Number((Math.floor(value / step + 1e-9) * step).toFixed(precision));
}

export async function getSymbolFilters(rest: BinanceRestLike, symbol: string): Promise<SymbolFilters | null> {
  const info = (await rest.getExchangeInfo()) as { symbols?: Array<{ symbol: string; pricePrecision: number; quantityPrecision: number; filters: Array<{ filterType: string; tickSize?: string; stepSize?: string; minQty?: string; notional?: string }> }> };
  const s = info.symbols?.find((x) => x.symbol === symbol);
  if (!s) return null;
  const priceFilter = s.filters.find((f) => f.filterType === "PRICE_FILTER");
  const lotFilter = s.filters.find((f) => f.filterType === "LOT_SIZE");
  const notionalFilter = s.filters.find((f) => f.filterType === "MIN_NOTIONAL");
  if (!priceFilter?.tickSize || !lotFilter?.stepSize || !lotFilter?.minQty) return null;
  return {
    tickSize: Number(priceFilter.tickSize), stepSize: Number(lotFilter.stepSize),
    pricePrecision: s.pricePrecision, qtyPrecision: s.quantityPrecision,
    minQty: Number(lotFilter.minQty), minNotional: notionalFilter?.notional ? Number(notionalFilter.notional) : 0,
  };
}

export interface EntrySequenceInput {
  userId: string;
  globalSignalId: string;
  symbol: string;
  side: Side;
  quantity: number;
  entryPriceEstimate: number;
  slPrice: number;
  initialTpPrice: number;
  /** When set, quantity is RE-SIZED at the executable price (best ask for
   *  LONG, best bid for SHORT) so the dollar risk to SL stays riskUsd even
   *  if price moved between the signal and the order. */
  riskUsd?: number;
  /** When set, applied to the symbol before the entry order. */
  leverage?: number;
  marginMode?: "ISOLATED" | "CROSSED";
  /** When set, the TP is NOT initialTpPrice but is computed from the ACTUAL
   *  fill: fill ± tpRMultiple x |fill - slPrice| (keeps the planned R:R
   *  exact whatever the fill price). */
  tpRMultiple?: number;
}

export type EntrySequenceOutcome =
  | { outcome: "ENTRY_ACTIVE_WITH_TP"; entryPrice: number; quantity: number; actualRiskUsd?: number; tpPrice?: number; entryClientOrderId: string; slClientAlgoId: string; slBinanceAlgoId: number; tpClientOrderId: string; tpBinanceOrderId: number }
  | { outcome: "ENTRY_ACTIVE_WITHOUT_TP"; entryPrice: number; quantity: number; actualRiskUsd?: number; tpPrice?: number; entryClientOrderId: string; slClientAlgoId: string; slBinanceAlgoId: number; tpFailureReason: string }
  | { outcome: "PROTECTION_FAILED_CLOSED"; entryPrice: number; quantity: number; entryClientOrderId: string; reason: string }
  | { outcome: "ENTRY_FAILED"; reason: string };

/** The full CRITICAL sequence for ONE user. Never throws -- every
 *  failure path is caught and returns an explicit outcome. Callers
 *  run this independently per user; one user's failure has no way to
 *  affect another's call, since this function touches only the ONE
 *  BinanceRestLike instance it was given. */
export async function runEntrySequence(rest: BinanceRestLike, input: EntrySequenceInput): Promise<EntrySequenceOutcome> {
  try {
    const filters = await getSymbolFilters(rest, input.symbol);
    if (!filters) return { outcome: "ENTRY_FAILED", reason: `could not load symbol filters for ${input.symbol}` };
    const long = input.side === "LONG";

    // ── 1. Pre-flight at the EXECUTABLE price ───────────────────────
    // The signal price can be seconds old. Re-check geometry and re-size
    // at the price a MARKET order would actually cross, so the SL still
    // costs riskUsd, and never enter when price already passed SL or TP.
    let quantity = input.quantity;
    let referencePrice = input.entryPriceEstimate;
    const exec = await executablePrice(rest, input.symbol, input.side);
    if (exec !== null) {
      if (long ? exec <= input.slPrice : exec >= input.slPrice) {
        return { outcome: "ENTRY_FAILED", reason: `pre-flight: executable price ${exec} already beyond SL ${input.slPrice}` };
      }
      if (input.tpRMultiple === undefined && (long ? exec >= input.initialTpPrice : exec <= input.initialTpPrice)) {
        return { outcome: "ENTRY_FAILED", reason: `pre-flight: executable price ${exec} already beyond TP ${input.initialTpPrice}` };
      }
      referencePrice = exec;
      if (input.riskUsd !== undefined && input.riskUsd > 0) {
        quantity = input.riskUsd / Math.abs(exec - input.slPrice);
      }
      log.info({
        userId: input.userId, symbol: input.symbol, side: input.side,
        signalPrice: input.entryPriceEstimate, executablePrice: exec,
        deviationPct: Number((((exec - input.entryPriceEstimate) / input.entryPriceEstimate) * 100).toFixed(4)),
        plannedQty: input.quantity, resizedQty: quantity,
      }, "[PRE_FLIGHT]");
    }

    // ── 2. Account setup for this symbol (before any order) ──────────
    // In ISOLATED mode the exchange liquidates at roughly 1/leverage away
    // from entry. The configured leverage is treated as a CAP: it is
    // lowered so the strategy SL always sits well inside the liquidation
    // price (SL distance <= 70% of 1/leverage). Otherwise a wide SL
    // would be pre-empted by liquidation, losing the whole margin.
    // Margin mode first: the leverage cap depends on the mode the symbol
    // is ACTUALLY in (Binance refuses a mode change while the symbol has
    // open orders or a position -- then the current mode is kept).
    const margin = await applyMarginMode(rest, input);
    if ("error" in margin) return { outcome: "ENTRY_FAILED", reason: margin.error };
    const slDistancePct = Math.abs(referencePrice - input.slPrice) / referencePrice * 100;
    const effectiveLeverage = input.leverage ? safeLeverage(input.leverage, slDistancePct, margin.mode) : undefined;
    if (effectiveLeverage !== undefined && effectiveLeverage !== input.leverage) {
      log.warn({ userId: input.userId, symbol: input.symbol, configuredLeverage: input.leverage, effectiveLeverage, slDistancePct: Number(slDistancePct.toFixed(3)) }, "[LEVERAGE_CAPPED] configured leverage would put liquidation before the SL -- using a lower leverage");
    }
    const setup = await applyLeverage(rest, input.symbol, effectiveLeverage);
    if (setup !== null) return { outcome: "ENTRY_FAILED", reason: setup };

    const roundedQty = floorToStep(quantity, filters.stepSize, filters.qtyPrecision);
    if (roundedQty < filters.minQty) return { outcome: "ENTRY_FAILED", reason: `quantity ${roundedQty} below exchange minQty ${filters.minQty}` };
    const estimatedNotional = roundedQty * referencePrice;
    if (estimatedNotional < filters.minNotional) return { outcome: "ENTRY_FAILED", reason: `notional $${estimatedNotional.toFixed(2)} below exchange minNotional $${filters.minNotional} (raise riskUsd or this SL is too wide)` };

    // ── 3. Entry (MARKET, full fill result requested) ────────────────
    const entryClientOrderId = strategyClientOrderId(input.userId, input.globalSignalId, "ENTRY", 0);
    const entrySide = long ? "BUY" : "SELL";
    let fill: { avgPrice: number; executedQty: number } | null = null;
    try {
      const res = (await rest.createOrder({
        symbol: input.symbol, side: entrySide, type: "MARKET",
        quantity: roundedQty.toFixed(filters.qtyPrecision), newClientOrderId: entryClientOrderId,
        newOrderRespType: "RESULT",
      })) as { avgPrice?: string; executedQty?: string };
      const avg = Number(res?.avgPrice), qty = Number(res?.executedQty);
      if (avg > 0 && qty > 0) fill = { avgPrice: avg, executedQty: qty };
    } catch (err) {
      return { outcome: "ENTRY_FAILED", reason: `entry order rejected: ${err instanceof Error ? err.message : String(err)}` };
    }

    // ── 4. Confirm the position (retries: positionRisk can lag a fill) ─
    let position = await verifyPositionOpen(rest, input.symbol, roundedQty);
    if (position === null && fill !== null) {
      // The exchange itself reported a fill. NEVER leave a filled position
      // unprotected just because positionRisk lagged -- protect the filled qty.
      log.warn({ userId: input.userId, symbol: input.symbol, fill }, "[POSITION_VERIFY_LAGGED] using the order's own fill result to place protection");
      position = { entryPrice: fill.avgPrice, positionAmt: fill.executedQty };
    }
    if (position === null) {
      return { outcome: "ENTRY_FAILED", reason: "entry order submitted but no fill was reported and the position could not be verified open on Binance -- treating as failed, never assuming a fill occurred" };
    }
    // OUR order's own fill is the truth for OUR trade: positionRisk is the
    // symbol aggregate and would include any unrelated (e.g. manual)
    // position on the same symbol.
    if (fill !== null) position = { entryPrice: fill.avgPrice, positionAmt: fill.executedQty };
    const protectQty = floorToStep(fill !== null ? fill.executedQty : roundedQty, filters.stepSize, filters.qtyPrecision) || roundedQty;
    const actualRiskUsd = Math.abs(position.entryPrice - input.slPrice) * protectQty;
    log.info({ userId: input.userId, symbol: input.symbol, fillPrice: position.entryPrice, qty: protectQty, sl: input.slPrice, tp: input.initialTpPrice, actualRiskUsd: Number(actualRiskUsd.toFixed(4)) }, "[ENTRY_FILLED]");

    // ── 5. Stop loss (algo STOP_MARKET) -> verify, else fail-safe close ─
    const closeSide = long ? "SELL" : "BUY";
    const slClientAlgoId = strategyClientOrderId(input.userId, input.globalSignalId, "STOP_LOSS", 0);
    let slAlgoId: number | null = null;
    try {
      const res = (await rest.createAlgoOrder({
        symbol: input.symbol, side: closeSide, type: "STOP_MARKET",
        triggerPrice: roundToStep(input.slPrice, filters.tickSize, filters.pricePrecision).toFixed(filters.pricePrecision),
        quantity: protectQty.toFixed(filters.qtyPrecision), reduceOnly: "true", clientAlgoId: slClientAlgoId,
      })) as { algoId: number };
      slAlgoId = res.algoId;
    } catch (err) {
      log.error({ userId: input.userId, symbol: input.symbol, err: err instanceof Error ? err.message : String(err) }, "[SL_PLACEMENT_FAILED]");
    }

    const stopVerified = slAlgoId !== null && await verifyAlgoOrderOpen(rest, input.symbol, slAlgoId, slClientAlgoId);
    if (!stopVerified) {
      log.error({ userId: input.userId, symbol: input.symbol }, "[PROTECTION_FAILED] SL could not be confirmed -- fail-safe closing the position now");
      await failSafeMarketClose(rest, input.symbol, closeSide, protectQty, filters);
      // The SL may exist even though verification failed -- never leave it
      // resting on Binance after the position it protected is gone.
      await cancelOwnAlgoOrder(rest, input.symbol, slAlgoId, slClientAlgoId);
      return { outcome: "PROTECTION_FAILED_CLOSED", entryPrice: position.entryPrice, quantity: protectQty, entryClientOrderId, reason: "SL placement/verification failed -- position fail-safe closed" };
    }

    // ── 6. Take profit (reduce-only LIMIT) -> verify ─────────────────
    const tpPrice = input.tpRMultiple !== undefined
      ? (long ? position.entryPrice + input.tpRMultiple * (position.entryPrice - input.slPrice) : position.entryPrice - input.tpRMultiple * (input.slPrice - position.entryPrice))
      : input.initialTpPrice;
    const tpClientOrderId = strategyClientOrderId(input.userId, input.globalSignalId, "TAKE_PROFIT", 0);
    try {
      const tpRes = (await rest.createOrder({
        symbol: input.symbol, side: closeSide, type: "LIMIT", timeInForce: "GTC",
        price: roundToStep(tpPrice, filters.tickSize, filters.pricePrecision).toFixed(filters.pricePrecision),
        quantity: protectQty.toFixed(filters.qtyPrecision), reduceOnly: "true", newClientOrderId: tpClientOrderId,
      })) as { orderId: number };

      const tpVerified = await verifyOrderOpen(rest, input.symbol, tpRes.orderId);
      if (!tpVerified) {
        return { outcome: "ENTRY_ACTIVE_WITHOUT_TP", entryPrice: position.entryPrice, quantity: protectQty, actualRiskUsd, tpPrice, entryClientOrderId, slClientAlgoId, slBinanceAlgoId: slAlgoId!, tpFailureReason: "TP order placed but could not be verified open" };
      }
      return { outcome: "ENTRY_ACTIVE_WITH_TP", entryPrice: position.entryPrice, quantity: protectQty, actualRiskUsd, tpPrice, entryClientOrderId, slClientAlgoId, slBinanceAlgoId: slAlgoId!, tpClientOrderId, tpBinanceOrderId: tpRes.orderId };
    } catch (err) {
      return { outcome: "ENTRY_ACTIVE_WITHOUT_TP", entryPrice: position.entryPrice, quantity: protectQty, actualRiskUsd, tpPrice, entryClientOrderId, slClientAlgoId, slBinanceAlgoId: slAlgoId!, tpFailureReason: err instanceof Error ? err.message : String(err) };
    }
  } catch (err) {
    return { outcome: "ENTRY_FAILED", reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

type MarginMode = "ISOLATED" | "CROSSED";

/** The symbol's current margin mode from positionRisk (v2 reports
 *  marginType "isolated" | "cross"), or null when it cannot be read. */
async function currentMarginMode(rest: BinanceRestLike, symbol: string): Promise<MarginMode | null> {
  try {
    const res = (await rest.getPositionRisk(symbol)) as Array<{ symbol: string; marginType?: string }>;
    const t = (Array.isArray(res) ? res.find((p) => p.symbol === symbol) : undefined)?.marginType?.toLowerCase();
    if (t === "isolated") return "ISOLATED";
    if (t === "cross" || t === "crossed") return "CROSSED";
  } catch { /* unknown -- decided below */ }
  return null;
}

/** Puts the symbol in the requested margin mode. Returns the mode the
 *  trade will ACTUALLY run in, or an error when it cannot be known.
 *  - already in the requested mode -> no call at all;
 *  - Binance refuses the change because the symbol has open orders or a
 *    position (e.g. a manual order on the same symbol) -> the CURRENT
 *    mode is kept and the trade proceeds; the SL still caps the loss and
 *    the leverage cap is computed for the real mode. */
async function applyMarginMode(rest: BinanceRestLike, input: EntrySequenceInput): Promise<{ mode: MarginMode | undefined } | { error: string }> {
  if (!input.marginMode || typeof rest.setMarginType !== "function") return { mode: input.marginMode };
  const current = await currentMarginMode(rest, input.symbol);
  if (current === input.marginMode) return { mode: current };
  try {
    await rest.setMarginType(input.symbol, input.marginMode);
    return { mode: input.marginMode };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // -4046 "No need to change margin type" = already correct.
    if (msg.includes("-4046") || /no need to change margin type/i.test(msg)) return { mode: input.marginMode };
    if (current !== null) {
      log.warn({ userId: input.userId, symbol: input.symbol, requested: input.marginMode, kept: current, err: msg }, "[MARGIN_MODE_KEPT] Binance refused the margin-mode change (open orders / position on this symbol?) -- trading in the current mode");
      return { mode: current };
    }
    return { error: `setMarginType(${input.marginMode}) failed: ${msg}` };
  }
}

async function applyLeverage(rest: BinanceRestLike, symbol: string, leverage: number | undefined): Promise<string | null> {
  if (!leverage || typeof rest.setLeverage !== "function") return null;
  try {
    await rest.setLeverage(symbol, leverage);
  } catch (err) {
    return `setLeverage(${leverage}) failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

async function executablePrice(rest: BinanceRestLike, symbol: string, side: Side): Promise<number | null> {
  if (typeof rest.getBookTicker !== "function") return null;
  try {
    const t = (await rest.getBookTicker(symbol)) as { askPrice?: string; bidPrice?: string };
    const p = Number(side === "LONG" ? t?.askPrice : t?.bidPrice);
    return p > 0 ? p : null;
  } catch {
    return null; // market-data hiccup: fall back to the signal price, post-fill values are still exact
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function verifyPositionOpen(rest: BinanceRestLike, symbol: string, expectedMinQty: number, attempts = 4, delayMs = 400): Promise<{ entryPrice: number; positionAmt: number } | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = (await rest.getPositionRisk(symbol)) as Array<{ symbol: string; positionAmt: string; entryPrice: string }>;
      const pos = res.find((p) => p.symbol === symbol);
      const amt = pos ? Math.abs(Number(pos.positionAmt)) : 0;
      if (pos && amt >= expectedMinQty * 0.99) return { entryPrice: Number(pos.entryPrice), positionAmt: amt };
    } catch {
      // transient API error -- retry
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return null;
}
/** A freshly created algo order is not always queryable by id right away
 *  (Binance returned -2013 "Order does not exist" ~0.5s after creation in
 *  production). Retry, and accept the symbol's open-algo-order list as
 *  equally authoritative proof that the order is resting. */
async function verifyAlgoOrderOpen(rest: BinanceRestLike, symbol: string, algoId: number, clientAlgoId: string, attempts = 5, delayMs = 400): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = (await rest.getAlgoOrder(algoId)) as { algoStatus?: string };
      if (res?.algoStatus === "WORKING" || res?.algoStatus === "NEW") return true;
    } catch { /* not queryable yet -- fall through to the open list */ }
    try {
      const open = (await rest.getOpenAlgoOrders(symbol)) as Array<{ algoId?: number | string; clientAlgoId?: string }>;
      if (Array.isArray(open) && open.some((o) => Number(o.algoId) === algoId || o.clientAlgoId === clientAlgoId)) return true;
    } catch { /* retry */ }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}

/** Best-effort: cancel our own SL algo order by id, then sweep the open
 *  list for our clientAlgoId in case the id was never learned. */
async function cancelOwnAlgoOrder(rest: BinanceRestLike, symbol: string, algoId: number | null, clientAlgoId: string): Promise<void> {
  if (algoId !== null) {
    try { await rest.cancelAlgoOrder(algoId); return; } catch { /* sweep below */ }
  }
  try {
    const open = (await rest.getOpenAlgoOrders(symbol)) as Array<{ algoId?: number | string; clientAlgoId?: string }>;
    for (const o of Array.isArray(open) ? open : []) {
      if (o.clientAlgoId === clientAlgoId && o.algoId !== undefined) {
        try { await rest.cancelAlgoOrder(Number(o.algoId)); } catch { /* logged below if still open */ }
      }
    }
  } catch (err) {
    log.error({ symbol, clientAlgoId, err: err instanceof Error ? err.message : String(err) }, "[ORPHAN_SL_CANCEL_FAILED] -- a stop order may remain resting on Binance; cancel it manually");
  }
}

/** Highest leverage <= configured such that, in ISOLATED mode, the SL
 *  distance is at most 70% of the ~1/leverage liquidation distance. */
export function safeLeverage(configured: number, slDistancePct: number, marginMode?: MarginMode): number {
  if (marginMode !== "ISOLATED" || !(slDistancePct > 0)) return configured;
  const maxByLiquidation = Math.floor((0.7 * 100) / slDistancePct);
  return Math.max(1, Math.min(configured, maxByLiquidation));
}
async function verifyOrderOpen(rest: BinanceRestLike, symbol: string, orderId: number): Promise<boolean> {
  try {
    const res = (await rest.getOrder(symbol, orderId)) as { status?: string };
    return res.status === "NEW" || res.status === "PARTIALLY_FILLED";
  } catch {
    return false;
  }
}
async function failSafeMarketClose(rest: BinanceRestLike, symbol: string, closeSide: "BUY" | "SELL", quantity: number, filters: SymbolFilters): Promise<void> {
  try {
    await rest.createOrder({ symbol, side: closeSide, type: "MARKET", quantity: quantity.toFixed(filters.qtyPrecision), reduceOnly: "true" });
  } catch (err) {
    log.error({ symbol, err: err instanceof Error ? err.message : String(err) }, "[FAILSAFE_CLOSE_FAILED] -- CRITICAL: position may remain open and unprotected, requires immediate manual attention");
  }
}
