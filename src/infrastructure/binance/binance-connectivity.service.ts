import type { BinanceRestClient } from "./binanceRest.client";
import { childLogger } from '../logging/logger';

const log = childLogger({ mod: "binance-connectivity" });

/** Phase 1 — Connectivity only (Aug 2026, operator-scoped).
 *
 *  This service does exactly one thing: confirm the bot CAN talk to
 *  Binance Futures with the configured API key, and CAN read the data
 *  a future execution layer would need (account, balance, exchange
 *  info, symbol filters). It never places an order, never sets
 *  leverage, never touches a position. There is no code path in this
 *  file that calls any write/order endpoint — createOrder/setLeverage
 *  on BinanceRestClient are simply never referenced here, by design,
 *  so a future accidental call from THIS service is structurally
 *  impossible without editing this file.
 *
 *  Fully decoupled from V3 strategy logic: SimpleLiquidationService
 *  holds an optional reference to this service (same pattern as
 *  walls/fundingStats/fundingRate) and fires a single, non-blocking,
 *  try/caught call after a Telegram ENTRY message is sent. If this
 *  service is absent, disabled, or throws, V3's signal generation and
 *  Telegram behavior are completely unaffected — nothing here is ever
 *  awaited by, or allowed to influence, a trading decision.
 *
 *  Order execution (Phase 4) is a separate, not-yet-built module. The
 *  BINANCE_ORDER_EXECUTION_ENABLED flag is read here only to confirm
 *  it defaults to false and is surfaced in logs — no order-placement
 *  code exists yet anywhere in this file or its callers. */
export class BinanceConnectivityService {
  private readonly enabled: boolean;
  private readonly orderExecutionEnabled: boolean;
  /** Prevents overlapping checks if entries fire in quick succession —
   *  a connectivity check is cheap but there's no reason to run two
   *  at once against the same account. */
  private inFlight = false;

  constructor(
    private readonly rest: BinanceRestClient,
    private readonly trackedSymbols: readonly string[],
  ) {
    this.enabled =
      (process.env.BINANCE_CONNECTIVITY_ENABLED ?? "false").toLowerCase() ===
      "true";
    this.orderExecutionEnabled =
      (process.env.BINANCE_ORDER_EXECUTION_ENABLED ?? "false").toLowerCase() ===
      "true";
    if (this.orderExecutionEnabled) {
      // Phase 4 doesn't exist yet — if this flag is ever true this
      // early, that's a config mistake, not a green light. Loud,
      // impossible-to-miss warning at startup.
      log.warn(
        "BINANCE_ORDER_EXECUTION_ENABLED=true but no order-execution " +
          "code exists yet (Phase 1 connectivity-only build) — this flag " +
          "currently does nothing. Safe, but almost certainly not what " +
          "you intended; check .env.",
      );
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Runs the full Phase 1 connectivity sequence once. Safe to call
   *  repeatedly — read-only, no side effects on the Binance account.
   *  Never throws to the caller; all failures are caught and logged as
   *  [BINANCE_CONNECTIVITY_FAILED] with a sanitized message. */
  async checkConnectivity(): Promise<void> {
    if (!this.enabled) return;
    if (this.inFlight) {
      log.info("connectivity check already in flight, skipping this trigger");
      return;
    }
    this.inFlight = true;
    try {
      log.info("[BINANCE_API_CONNECT_START]");

      // ── Exchange info (public, unauthenticated) ─────────────────────
      const exchangeInfo = (await this.rest.getExchangeInfo()) as {
        symbols?: Array<{
          symbol: string;
          filters?: Array<Record<string, unknown>>;
        }>;
      };
      const symbolCount = exchangeInfo.symbols?.length ?? 0;
      if (symbolCount === 0) {
        throw new Error("exchangeInfo returned no symbols");
      }
      log.info({ symbolCount }, "[BINANCE_EXCHANGE_INFO_OK]");

      // ── Symbol filters for our tracked symbols only ─────────────────
      const filterSummary: Record<
        string,
        {
          tickSize?: string;
          stepSize?: string;
          minQty?: string;
          minNotional?: string;
        }
      > = {};
      for (const sym of this.trackedSymbols) {
        const entry = exchangeInfo.symbols?.find((s) => s.symbol === sym);
        if (!entry) {
          log.warn(
            { symbol: sym },
            "tracked symbol not found in exchangeInfo — check symbol name",
          );
          continue;
        }
        const priceFilter = entry.filters?.find(
          (f) => f.filterType === "PRICE_FILTER",
        );
        const lotFilter = entry.filters?.find(
          (f) => f.filterType === "LOT_SIZE",
        );
        const notionalFilter = entry.filters?.find(
          (f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL",
        );
        filterSummary[sym] = {
          tickSize: priceFilter?.tickSize as string | undefined,
          stepSize: lotFilter?.stepSize as string | undefined,
          minQty: lotFilter?.minQty as string | undefined,
          minNotional:
            (notionalFilter?.notional as string | undefined) ??
            (notionalFilter?.minNotional as string | undefined),
        };
      }
      const missingFilters = this.trackedSymbols.filter(
        (s) => !filterSummary[s],
      );
      if (missingFilters.length > 0) {
        log.warn(
          { missingFilters },
          "some tracked symbols missing from exchangeInfo — see above",
        );
      }
      log.info({ filters: filterSummary }, "[BINANCE_SYMBOL_FILTERS_OK]");

      // ── Authenticated account info (confirms API key + signature valid) ──
      const account = (await this.rest.getAccount()) as {
        canTrade?: boolean;
        feeTier?: number;
        assets?: unknown[];
      };
      log.info("[BINANCE_API_AUTH_OK]");

      if (account.canTrade !== true) {
        throw new Error(
          "account.canTrade=false — API key may be missing Futures trading permission",
        );
      }
      log.info({ feeTier: account.feeTier }, "[BINANCE_FUTURES_ACCOUNT_OK]");

      // ── Balance (confirms read access to balance data specifically) ──
      const balance = (await this.rest.getBalance()) as Array<{
        asset: string;
        balance: string;
        availableBalance: string;
      }>;
      const usdt = balance.find((b) => b.asset === "USDT");
      log.info(
        {
          usdtAvailable:
            usdt?.availableBalance ?? "n/a (no USDT asset row found)",
        },
        "[BINANCE_BALANCE_OK]",
      );

      log.info(
        { orderExecutionEnabled: this.orderExecutionEnabled },
        "[BINANCE_CONNECTED] all Phase 1 checks passed — no order placed, " +
          "no position/leverage/margin touched",
      );
    } catch (err) {
      // Sanitize: never let the API key or secret leak into logs, even
      // indirectly via an error message or request-config dump. Only
      // the error's own message string is logged, and even that is
      // truncated defensively.
      const rawMsg = err instanceof Error ? err.message : String(err);
      const safeMsg = rawMsg.slice(0, 300);
      log.error({ errorMessage: safeMsg }, "[BINANCE_CONNECTIVITY_FAILED]");
    } finally {
      this.inFlight = false;
    }
  }
}
