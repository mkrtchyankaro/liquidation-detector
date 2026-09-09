import * as crypto from "crypto";
import { type BinanceRestClient, BinanceApiError } from "./binanceRest.client";
import type { ExecutionRecordRepository } from "../mongo/execution-record.repository";
import type { ExecutionClaimRepository } from "../mongo/execution-claim.repository";
import type { TelegramClient } from "../telegram/telegram.client";
import { childLogger } from "../logging/logger";
import { type LiquidityPlanResult } from "../../domain/trading/trade-plan";
import { deriveLiquidationPhysicsTradePlan } from "../../domain/trading/liquidation-physics-trade-plan";

const log = childLogger({ mod: "binance-execution" });

/** Sep 9 2026 (Karo), operator-designed DYNAMIC liquidation-physics
 *  rewrite -- REPLACES the previous FIXED K=0.4/RR=2.2
 *  the fixed-K structural formula call here (itself a replacement for
 *  the even-older Hybrid-C intensity formula). This
 *  function is the pre-flight AND post-fill REPLAN path (see both
 *  call-sites below) -- it must use EXACTLY the same physics as
 *  evaluateSignal()'s own original plan, per the operator's own
 *  explicit requirement, so a fill-price-slippage-triggered replan
 *  can never silently diverge onto old/different geometry. Returns a
 *  LiquidityPlanResult-shaped object (the SAME discriminated-union
 *  type every existing downstream consumer in this file already
 *  expects) so this remains a minimal, surgical swap -- zero-filled
 *  forensics fields that no longer apply. */
export function planForSymbol(input: {
  entry: number;
  side: "LONG" | "SHORT";
  symbol: string;
  w1AnchorPrice: number;
  w1ExtremePrice: number;
  w1LiqUsd: number;
  w2LiqUsd: number;
  atr15mAbs: number;
  p95: number;
  dailyLiqPerMinBaseline: number;
}): LiquidityPlanResult {
  const result = deriveLiquidationPhysicsTradePlan({
    entry: input.entry,
    side: input.side,
    w1AnchorPrice: input.w1AnchorPrice,
    w1ExtremePrice: input.w1ExtremePrice,
    w1LiqUsd: input.w1LiqUsd,
    w2LiqUsd: input.w2LiqUsd,
    atr15mAbs: input.atr15mAbs,
    p95: input.p95,
    dailyLiqPerMinBaseline: input.dailyLiqPerMinBaseline,
  });
  const zeroForensics = {
    intensityRaw: result.liquidityStrengthP95,
    intensity: result.liquidityStrength,
    atr15mPct: result.atr15mPct,
    rawTpPct: 0,
    wallAdjustedTpPct: 0,
    wallApplied: false,
    rrCandidate: result.selectedRR,
    slCapApplied: false,
    slCapValue: 0,
    profitWallNotionalAtEntry: 0,
    profitWallNotionalAtAnchor: 0,
    profitWallNotionalAtSweepStart: 0,
    finalTpPct: result.ok ? result.tpPct : 0,
    finalSlPct: result.ok ? result.slPct : 0,
  };
  if (!result.ok) {
    return { ...zeroForensics, ok: false, cancelReason: "invalid-input" };
  }
  return {
    ...zeroForensics,
    ok: true,
    sl: result.sl,
    tp: result.tp,
    slPct: result.slPct,
    tpPct: result.tpPct,
    rr: result.rr,
  };
}

export interface ExecutionInput {
  symbol: string;
  side: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskUsd: number;
  positionSizeUsdt: number;
  signalId: string;
  /** Sep 9 2026 (Karo), operator-designed DYNAMIC liquidation-physics
   *  plan -- the EXACT SAME values (Wave 1's own anchor/extreme/liq,
   *  Wave 2's own liq/extreme, frozen UNIT, P95-at-entry,
   *  dailyLiqPerMinBaseline-at-entry) that evaluateSignal() originally
   *  used to plan this signal. Frozen at signal time
   *  (GlobalSignalDoc.waveHistory / unitAtStart / p95AtEntry /
   *  dailyLiqPerMinBaselineAtEntry), not re-fetched here --
   *  BinanceExecutionService has no market-data dependencies, and
   *  reusing the frozen context keeps the post-fill replan measuring
   *  the exact same physics the strategy actually evaluated, rather
   *  than a different market moment. */
  w1AnchorPrice: number;
  w1ExtremePrice: number;
  w1LiqUsd: number;
  w2LiqUsd: number;
  atr15mAbs: number;
  p95: number;
  dailyLiqPerMinBaseline: number;
  /** Aug 28 2026, operator-approved (Karo) -- MICRO's own compressed-
   *  exit override. When present, SKIPS the standard post-fill replan
   *  (the old formula's own re-derivation from cumLiq/liqBaseline/
   *  atr15mPct/walls) entirely -- instead computes SL/TP directly as
   *  fixed PERCENTAGE DISTANCES from the actual fill price. This is
   *  the ONLY way MICRO's own compressed TP/SL (NORMAL's own distances
   *  divided by V3_MICRO_EXIT_DIVISOR) survives the post-fill step --
   *  without this override, the standard replan below would silently
   *  re-derive NORMAL-sized TP/SL from market conditions, completely
   *  discarding the compression (confirmed real risk, operator's own
   *  finding). Absent (undefined) for every NORMAL call -- ZERO
   *  behavioral change to NORMAL's own execution; the standard replan
   *  runs exactly as before. */
  fixedExitPct?: { tpPct: number; slPct: number };
}

/** Aug 2026, execution-first architecture (operator-designed). The
 *  discriminated result of a run() call — SimpleLiquidationService now
 *  awaits this directly in live mode to decide whether Mongo/Telegram
 *  ENTRY should ever be written, instead of firing run() and forgetting
 *  it. SUCCESS carries every ACTUAL value (fill price, filled qty,
 *  replanned SL/TP/RR, real risk/notional, leverage/margin mode, and
 *  the three real Binance order ids) — these, not the pre-fill planned
 *  numbers, are what the caller should persist and display. ABORTED
 *  covers every failure path that used to just `return;` — the
 *  position has already been safely closed/reconciled (or, for the
 *  TP-unconfirmed case, left intentionally open and SL-protected — see
 *  executeLive()'s TP section) by the time this is returned. SHADOW
 *  means execution is not live-armed at all (paper/shadow config) —
 *  not a failure, just "nothing to gate on". */
export type ExecutionResult =
  | {
      status: "SUCCESS";
      actualEntry: number;
      actualQty: number;
      replannedSl: number;
      replannedTp: number;
      replannedRR: number;
      actualRiskUsd: number;
      actualNotionalUsdt: number;
      leverage: number;
      marginMode: "ISOLATED" | "CROSSED";
      entryOrderId: number;
      slOrderId: number;
      tpOrderId: number;
    }
  | {
      status: "ABORTED";
      reason: string;
      /** Sep 4 2026, operator-approved (Karo) -- true ONLY for abort
       *  paths that occur strictly BEFORE the entry-order creation
       *  call (setMarginType/setLeverage/pre-flight validation
       *  failures) -- i.e. it is CERTAIN no Binance order was ever
       *  sent for this signalId. run() uses this to decide whether it
       *  is safe to immediately release the global execution claim.
       *  Omitted/false/undefined for every abort at or after the
       *  entry-order call, where the outcome is genuinely uncertain
       *  and the claim must NOT be auto-released -- see
       *  reconcileOnStartup()'s own stale-claim reconciliation for
       *  that case instead. */
      entryOrderNotSent?: boolean;
      /** Sep 5 2026, operator-approved (Karo) -- true ONLY when this
       *  ABORTED result came specifically from losing the GLOBAL
       *  execution-claim race (another process already held
       *  execution_claims for this signalId) -- i.e. tryClaim() never
       *  even ran, execution never reached setMarginType, and
       *  entryOrderNotSent is trivially true here too. Distinguished
       *  from other ABORTED reasons with its own dedicated boolean
       *  (never string-matched on `reason`) so callers can react to
       *  "another bot process is executing this signal for real" as
       *  its own case, distinct from a genuine execution failure. */
      globalClaimLost?: boolean;
    }
  | { status: "SHADOW" };

/** Aug 2026, execution-first architecture. The SINGLE predicate that
 *  decides whether a live execution result is allowed to become a real
 *  ACTIVE trade (actives.set(), Mongo paper_signals ACTIVE doc,
 *  Telegram ENTRY). SimpleLiquidationService.fireEntry() calls this
 *  exact function rather than repeating the `status === "SUCCESS"`
 *  check inline — so this file's test suite can verify the invariant
 *  ("ABORTED/SHADOW never installs a trade, therefore can never later
 *  produce a V3 CLOSE") against the SAME function the real code path
 *  uses, with no risk of the two silently drifting apart. Written as a
 *  TypeScript type predicate (not just `: boolean`) so callers get the
 *  same `result.actualEntry`/`.replannedSl`/etc. narrowing they would
 *  from an inline `result.status === "SUCCESS"` check. */
export function shouldInstallActiveTrade(
  result: ExecutionResult,
): result is Extract<ExecutionResult, { status: "SUCCESS" }> {
  return result.status === "SUCCESS";
}

interface SymbolFilters {
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
  pricePrecision: number;
  qtyPrecision: number;
}

interface OrderPlan {
  symbol: string;
  side: "LONG" | "SHORT";
  entrySide: "BUY" | "SELL";
  closeSide: "BUY" | "SELL";
  entryRounded: number;
  slRounded: number;
  tpRounded: number;
  quantityRaw: number;
  quantityRounded: number;
  slStr: string;
  tpStr: string;
  quantityStr: string;
  notionalUsdt: number;
  valid: boolean;
  invalidReason?: string;
}

/** Aug 2026, operator-designed + production-hardening audit (P0
 *  fixes). Phase 2 (position calculator) + Phase 3 (shadow dry-run) +
 *  Phase 4 (live execution), hardened per the Aug 2026 production
 *  readiness audit. Live order code is inert unless BOTH:
 *    BINANCE_EXECUTION_MODE=live
 *    BINANCE_ORDER_EXECUTION_ENABLED=true
 *  are set. No strategy/filter/Telegram logic lives here or is
 *  touched by this file.
 *
 *  P0 hardening summary (see production-readiness audit report):
 *   1. Entry network-timeout ambiguity — never assumes "nothing was
 *      opened" on a createOrder() failure; reconciles against Binance
 *      via clientOrderId + position query before concluding anything.
 *   2. Persistent idempotency — every execution attempt is claimed via
 *      a Mongo unique-index insert (ExecutionRecordRepository) BEFORE
 *      any order is sent. Survives restarts; an in-memory Set alone
 *      cannot.
 *   3. clientOrderId — deterministic per signalId/order-type, so even
 *      Binance-side dedup (where supported) has a stable key.
 *   4. Startup fail-fast + reconciliation — see validateForLiveStart()
 *      and reconcileOnStartup(), called from app.ts before strategy
 *      start when live-armed.
 *   5. Partial-fill handling — SL/TP quantity is built from the
 *      ACTUAL executedQty, never the originally planned quantity.
 *   6. Emergency-close retries — 3 attempts with backoff, each
 *      verified against a live position query; global halt + critical
 *      Telegram alert if the position is still open after all
 *      retries.
 */
export class BinanceExecutionService {
  private readonly mode: "shadow" | "live";
  private readonly orderExecutionEnabled: boolean;
  private readonly leverage: number;
  private readonly marginMode: "ISOLATED" | "CROSSED";
  /** Aug 2026, post-fill validation (operator-designed). After a
   *  MARKET entry fills, risk/RR is recalculated from the ACTUAL fill
   *  price against the strategy's original (structural, fill-
   *  independent) SL/TP levels. If the resulting actual RR falls
   *  below this threshold, the position is closed immediately —
   *  before SL/TP are ever placed — rather than either blindly
   *  entering at any slippage or rejecting good trades on a rigid
   *  pre-entry slippage cutoff. */
  private readonly minRRAfterFill: number;
  /** Aug 2026, pre-flight audit only — NOT used in any trading
   *  decision. Rough taker-fee-rate estimate (as a fraction, e.g.
   *  0.0005 = 0.05%) used purely to log an estimated round-trip fee
   *  cost alongside every SKIP_BEFORE_ORDER / forced-close decision,
   *  so the operator can see roughly how much a given decision was
   *  worth avoiding. Not account-specific (doesn't query actual VIP
   *  tier / BNB-discount rate) — a deliberately simple estimate. */
  private readonly takerFeeRateEstimate: number;
  private readonly riskUsdForValidation: number;
  private readonly filterCache = new Map<string, SymbolFilters>();
  private filterCacheLoadedAt = 0;
  private filterCacheLoading: Promise<void> | null = null;
  private static readonly FILTER_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

  /** Global halt (P0 #4/#6). Once set, EVERY subsequent run() refuses
   *  immediately — no new live orders of any kind — until the process
   *  is restarted after an operator has investigated. Deliberately
   *  does not auto-clear; a halt means something needs human eyes. */
  private haltReason: string | null = null;

  /** Sep 4 2026, operator-approved (Karo) -- production dedup
   *  requirement #2 (one active trade per symbol, cross-process).
   *  Records a CONFIRMED live-trade close so the symbol's execution
   *  slot is freed for MAIN/FRIEND/BROTHER alike. Called ONLY from the
   *  confirmed-close paths in SimpleLiquidationService's
   *  reconcileLiveTrade()/reconcileMicroLiveTrade() -- i.e. only after
   *  reconcileLivePosition()/reconcileMicroLivePosition() has itself
   *  confirmed positionAmt=0 on Binance, never from a paper/simulated
   *  close. A no-op (logged, not thrown) if no execution record exists
   *  for this signalId -- this deliberately covers MAIN's own paper
   *  trades on physics-formula symbols, which never called tryClaim()
   *  in the first place and therefore have nothing to update; that is
   *  expected, not an error. */
  async recordConfirmedClose(
    signalId: string,
    reason: "TP" | "SL",
  ): Promise<void> {
    // Bot-local audit trail (unchanged) -- order IDs, status history.
    await this.executionRecordRepo.updateStatus(
      signalId,
      reason === "TP" ? "CLOSED_TP" : "CLOSED_SL",
      `confirmed ${reason} close`,
    );
    // Sep 4 2026, operator-approved (Karo) -- ALSO free the GLOBAL
    // claim, so a future signal on this symbol can be claimed by any
    // process, not just this one. This is the "confirmed TP" and
    // "confirmed SL" release path; the "manual Binance close detected
    // by reconcile" path also flows through here (see
    // simple-liquidation.service.ts's reconcileLiveTrade()'s own
    // best-effort-reason branch, which still calls this function).
    await this.executionClaimRepo.releaseClaim(
      signalId,
      `closed-${reason.toLowerCase()}`,
    );
  }

  /** Sep 4 2026, operator-approved (Karo) -- the pre-entry half of
   *  requirement #2. True iff ANY process (MAIN, FRIEND, or BROTHER)
   *  currently holds an active GLOBAL claim on this symbol -- queries
   *  the shared execution_claims collection, not the bot-local
   *  executionRecordRepo (which cannot see another process's claims).
   *  Fails closed: any Mongo error is treated as "assume active, block
   *  the new entry", never as "assume free". */
  async hasActiveTradeForSymbol(symbol: string): Promise<boolean> {
    const active = await this.executionClaimRepo.findActiveBySymbol(symbol);
    return active.length > 0;
  }

  constructor(
    private readonly rest: BinanceRestClient,
    private readonly executionRecordRepo: ExecutionRecordRepository,
    /** Sep 4 2026, operator-approved (Karo) -- GLOBAL execution-claim
     *  repository (execution_claims, shared across MAIN/FRIEND/BROTHER).
     *  Used ONLY for tryClaim()/hasActiveTradeForSymbol() -- every other
     *  method on this class continues to use executionRecordRepo above
     *  (bot-local audit trail, unchanged). See execution-claim.model.ts
     *  for the full architectural rationale. */
    private readonly executionClaimRepo: ExecutionClaimRepository,
    /** Optional — used only for critical safety alerts (orphan
     *  position, emergency-close failure, global halt). Never used
     *  for strategy Telegram messages; those remain entirely in V3. */
    private readonly telegram: TelegramClient | null = null,
    /** Sep 8 2026 (Karo), multi-user adaptation -- REQUIRED, not a
     *  redesign. The original liqwatch-bot version of this class read
     *  mode/orderExecutionEnabled/leverage/marginMode/minRRAfterFill
     *  directly from process.env -- correct for a single-process,
     *  single-account bot, but WRONG once one process constructs one
     *  BinanceExecutionService PER USER: every user would silently
     *  share ONE global mode/leverage/marginMode from one .env file,
     *  making "karo=live, friend=shadow, artak=disabled" impossible to
     *  express. Each field is now an explicit, optional constructor
     *  parameter -- caller supplies that user's OWN
     *  UserConfig.binance.{mode,leverage,marginMode} (see
     *  services/user-runtime.ts). Every field defaults to the EXACT
     *  SAME fallback value the original process.env read used, so a
     *  caller that omits this parameter entirely gets byte-identical
     *  behavior to before. All comparison/execution logic below this
     *  point is otherwise completely unchanged. */
    perUserConfig?: {
      mode?: "shadow" | "live";
      orderExecutionEnabled?: boolean;
      leverage?: number;
      marginMode?: "ISOLATED" | "CROSSED";
      minRRAfterFill?: number;
      takerFeeRateEstimate?: number;
      /** Sep 8 2026 (Karo) -- used ONLY by validateForLiveStart()'s
       *  own sanity check (is the configured risk-per-trade a
       *  reasonable number) -- NOT the actual per-trade risk amount
       *  used for position sizing (that comes from the caller's own
       *  UserConfig.risk.riskUsd at execution time, in
       *  execute-for-user.usecase.ts). Defaults to 10, matching the
       *  original's own fallback. */
      riskUsdForValidation?: number;
    },
  ) {
    this.mode = perUserConfig?.mode ?? "shadow";
    this.orderExecutionEnabled = perUserConfig?.orderExecutionEnabled ?? false;
    this.leverage = perUserConfig?.leverage ?? 20;
    this.minRRAfterFill = perUserConfig?.minRRAfterFill ?? 2.0;
    this.takerFeeRateEstimate = perUserConfig?.takerFeeRateEstimate ?? 0.0005;
    this.riskUsdForValidation = perUserConfig?.riskUsdForValidation ?? 10;
    this.marginMode = perUserConfig?.marginMode ?? "ISOLATED";
    if (this.isLiveArmed) {
      log.warn(
        { leverage: this.leverage, marginMode: this.marginMode },
        "BINANCE EXECUTION IS LIVE-ARMED — real orders WILL be placed on the next signal.",
      );
    } else {
      log.info(
        { mode: this.mode, orderExecutionEnabled: this.orderExecutionEnabled },
        "Binance execution service ready in SHADOW mode — no real orders will be placed",
      );
    }
  }

  get isLiveArmed(): boolean {
    return (
      this.mode === "live" &&
      this.orderExecutionEnabled &&
      this.haltReason === null
    );
  }

  /** Aug 2026, sibling-order cleanup (operator-designed fix). Public
   *  entry point for SimpleLiquidationService's closeActive() — called
   *  the moment a LIVE trade closes via TP or SL, to cancel whichever
   *  algo order did NOT fire. Binance has no native OCO for Futures
   *  conditional orders: when SL triggers, the TP order is left
   *  resting indefinitely (and vice versa) unless explicitly
   *  cancelled — confirmed in production (ADAUSDT, Aug 2026: SL closed
   *  the position, the sibling TP order stayed open on Binance for
   *  minutes, undiscovered until a manual account check).
   *
   *  Best-effort by design: "-2013"/"already gone" is treated as
   *  success (the order may have already been cancelled by a prior
   *  attempt, or never existed if placement itself failed earlier —
   *  either way, nothing left to clean up). Any OTHER failure is
   *  logged loudly but does NOT throw — closeActive()'s paper-tracking
   *  bookkeeping (Mongo/Telegram) must complete regardless; an
   *  operator can always cancel a stray order manually from the logs.
   *  Returns true if confirmed cancelled/already-gone, false if the
   *  attempt failed for an unknown reason (caller should alert). */
  async cancelResidualOrder(
    symbol: string,
    algoId: number,
    signalId: string,
  ): Promise<boolean> {
    try {
      await this.rest.cancelAlgoOrder(algoId);
      log.info(
        { symbol, algoId, signalId },
        "[BINANCE_RESIDUAL_ORDER_CANCELED] sibling SL/TP cancelled after the other side closed the position",
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const alreadyGone =
        (err instanceof BinanceApiError && err.code === -2013) ||
        msg.toLowerCase().includes("not exist");
      if (alreadyGone) {
        log.info(
          { symbol, algoId, signalId },
          "[BINANCE_RESIDUAL_ORDER_ALREADY_GONE] sibling order was already cancelled/never existed — nothing to clean up",
        );
        return true;
      }
      log.error(
        { symbol, algoId, signalId, err: msg },
        "[BINANCE_RESIDUAL_ORDER_CANCEL_FAILED] manual check required — a resting sibling order may remain on Binance",
      );
      await this.sendCriticalAlert(
        `⚠️ RESIDUAL_ORDER_CANCEL_FAILED\n\nSymbol: ${symbol}\nalgoId: ${algoId}\nsignalId: ${signalId}\n\nCould not cancel the sibling SL/TP order after the position closed. Please check Binance's "Условные" tab manually and cancel it if still resting.`,
      );
      return false;
    }
  }

  get isHalted(): boolean {
    return this.haltReason !== null;
  }

  /** Aug 2026, live-close reconciliation (operator-designed, root fix
   *  for the ADAUSDT/ETHUSDT incident — Telegram close 15-25 MINUTES
   *  late, exit price wrong, because closeActive() was firing off pure
   *  price-tick simulation, NEVER querying Binance's actual state).
   *
   *  This is now the ONLY thing allowed to decide a LIVE trade has
   *  closed. It asks Binance three questions, in order, and nothing
   *  else:
   *    1. Is the position still open? (getPositionRisk — ground truth)
   *    2. If not, which of the two algo orders actually fired?
   *       (getAlgoOrder on both — TRIGGERED, or a non-empty
   *       actualOrderId, means THAT one executed)
   *    3. At what price did it fire? (actualPrice on the triggered
   *       order — the REAL fill, not a simulated crossing)
   *
   *  Returns:
   *   - { stillOpen: true } — position is genuinely still open, do
   *     nothing.
   *   - { stillOpen: false, reason: "TP"|"SL", actualPrice, ... } —
   *     confirmed which side fired and at what real price.
   *   - { stillOpen: false, reason: "UNKNOWN" } — position is
   *     confirmed CLOSED (positionAmt=0) but which order fired
   *     couldn't be determined (both queries failed, both/neither show
   *     triggered, or an id was never known). The caller must still
   *     close its own tracking — the position is definitively gone —
   *     but cannot claim a precise reason/price; it should fall back
   *     to its best-effort price and say so plainly in the logs. */
  /** Aug 28 2026, operator-approved (Karo) -- MICRO's own, DEDICATED
   *  live-position reconciler. Deliberately a SEPARATE function from
   *  reconcileLivePosition() (NORMAL's own), NOT a modification of it
   *  -- isolation requested explicitly, to introduce zero regression
   *  risk into NORMAL's already-working live reconciliation.
   *
   *  CRITICAL DIFFERENCE from reconcileLivePosition(): this function
   *  NEVER uses aggregate symbol positionAmt as proof of MICRO's own
   *  open/closed status -- NORMAL and MICRO INTENTIONALLY share the
   *  same aggregate Binance position in One-Way mode (confirmed: no
   *  positionSide is ever sent, so Hedge Mode's per-side position
   *  tracking isn't available). Checking positionAmt===0 would
   *  incorrectly report MICRO as "still open" whenever NORMAL's own
   *  larger quantity keeps the aggregate position non-zero after
   *  MICRO's own (smaller) protective order has ALREADY fired --
   *  this is the exact confirmed bug that reusing reconcileLivePosition()
   *  as-is would introduce.
   *
   *  Instead, reconciles PURELY from MICRO's own order-IDs (slOrderId/
   *  tpOrderId), querying each directly via getAlgoOrder() -- the SAME
   *  per-order-ID query reconcileLivePosition()'s own Step 2 already
   *  uses, just without Step 1's aggregate-position gate. On a
   *  confirmed single-sided fire, cancels the sibling (now-orphaned)
   *  protective order, since it references MICRO's own quantity which
   *  no longer exists after the fire. */
  async reconcileMicroLivePosition(
    slOrderId: number | null,
    tpOrderId: number | null,
    microSignalId: string,
  ): Promise<
    | { stillOpen: true }
    | { stillOpen: false; reason: "TP" | "SL"; actualPrice: number }
    | { stillOpen: false; reason: "AMBIGUOUS" }
  > {
    interface AlgoOrderQueryResult {
      algoStatus?: string;
      actualOrderId?: string;
      actualPrice?: string;
    }
    let slInfo: AlgoOrderQueryResult | null = null;
    let tpInfo: AlgoOrderQueryResult | null = null;
    if (slOrderId !== null) {
      try {
        slInfo = (await this.rest.getAlgoOrder(
          slOrderId,
        )) as AlgoOrderQueryResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          `[MICRO_RECONCILE_QUERY_FAILED] microSignalId=${microSignalId} leg=SL orderId=${slOrderId} ` +
            `err=${msg} -- treating as not-yet-fired, will retry next cycle`,
        );
      }
    }
    if (tpOrderId !== null) {
      try {
        tpInfo = (await this.rest.getAlgoOrder(
          tpOrderId,
        )) as AlgoOrderQueryResult;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          `[MICRO_RECONCILE_QUERY_FAILED] microSignalId=${microSignalId} leg=TP orderId=${tpOrderId} ` +
            `err=${msg} -- treating as not-yet-fired, will retry next cycle`,
        );
      }
    }

    const fired = (info: AlgoOrderQueryResult | null): boolean =>
      info !== null &&
      (info.algoStatus === "TRIGGERED" ||
        (info.actualOrderId !== undefined &&
          info.actualOrderId !== "" &&
          Number(info.actualOrderId) > 0));

    const slFired = fired(slInfo);
    const tpFired = fired(tpInfo);

    if (!slFired && !tpFired) {
      return { stillOpen: true };
    }

    if (slFired && tpFired) {
      // Explicitly-flagged race condition, per operator's own explicit
      // "audit what happens if both protective orders trigger around
      // the same time" requirement -- NEVER silently guessed. Both
      // orders share the SAME price (inherited trade plan), so a
      // near-simultaneous cross is possible in fast-moving markets.
      log.error(
        `[MICRO_RECONCILE_AMBIGUOUS] microSignalId=${microSignalId} slOrderId=${slOrderId} ` +
          `tpOrderId=${tpOrderId} -- BOTH protective orders appear fired, cannot determine true close ` +
          `reason from order data alone -- flagging for manual review, NOT auto-resolved`,
      );
      return { stillOpen: false, reason: "AMBIGUOUS" };
    }

    const firedInfo = slFired ? slInfo : tpInfo;
    const reason: "TP" | "SL" = slFired ? "SL" : "TP";
    const actualPrice = Number(firedInfo?.actualPrice ?? 0);
    const siblingOrderId = slFired ? tpOrderId : slOrderId;

    if (siblingOrderId !== null) {
      try {
        await this.rest.cancelAlgoOrder(siblingOrderId);
        log.info(
          `[MICRO_RECONCILE] microSignalId=${microSignalId} reason=${reason} cancelled sibling ` +
            `orderId=${siblingOrderId}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `[MICRO_RECONCILE] microSignalId=${microSignalId} failed to cancel sibling orderId=` +
            `${siblingOrderId}: ${msg} -- may already be filled/cancelled/expired, not treated as fatal`,
        );
      }
    }

    return { stillOpen: false, reason, actualPrice };
  }

  async reconcileLivePosition(
    symbol: string,
    slOrderId: number | null,
    tpOrderId: number | null,
    signalId: string,
  ): Promise<
    | { stillOpen: true }
    | {
        stillOpen: false;
        reason: "TP" | "SL";
        actualPrice: number;
        firedOrderId: number;
        siblingOrderId: number | null;
      }
    | { stillOpen: false; reason: "UNKNOWN" }
  > {
    // Step 1 — is the position still open? Ground truth.
    let positionAmt = 0;
    try {
      const positions = (await this.rest.getPositionRisk(symbol)) as Array<{
        symbol: string;
        positionAmt: string;
      }>;
      const pos = positions.find((p) => p.symbol === symbol);
      positionAmt = pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol, signalId, err: msg },
        "[BINANCE_RECONCILE_LIVE_POSITION_QUERY_FAILED] could not check position — treating as still open, will retry next cycle",
      );
      return { stillOpen: true }; // fail safe: never claim closed on a query error
    }
    if (positionAmt > 0) {
      return { stillOpen: true };
    }

    // Step 2 — position is confirmed closed. Which order fired?
    interface AlgoOrderQueryResult {
      algoStatus?: string;
      actualOrderId?: string;
      actualPrice?: string;
    }
    let slInfo: AlgoOrderQueryResult | null = null;
    let tpInfo: AlgoOrderQueryResult | null = null;
    if (slOrderId !== null) {
      try {
        slInfo = (await this.rest.getAlgoOrder(
          slOrderId,
        )) as AlgoOrderQueryResult;
      } catch {
        // couldn't query — leave null, handled below
      }
    }
    if (tpOrderId !== null) {
      try {
        tpInfo = (await this.rest.getAlgoOrder(
          tpOrderId,
        )) as AlgoOrderQueryResult;
      } catch {
        // couldn't query — leave null, handled below
      }
    }

    const fired = (info: AlgoOrderQueryResult | null): boolean =>
      info !== null &&
      (info.algoStatus === "TRIGGERED" ||
        (info.actualOrderId !== undefined &&
          info.actualOrderId !== "" &&
          Number(info.actualOrderId) > 0));

    const slFired = fired(slInfo);
    const tpFired = fired(tpInfo);

    log.info(
      {
        symbol,
        signalId,
        slOrderId,
        tpOrderId,
        slInfo,
        tpInfo,
        slFired,
        tpFired,
      },
      "[BINANCE_RECONCILE_LIVE_POSITION_CHECK] position confirmed closed — determining which order fired",
    );

    if (slFired && !tpFired) {
      const actualPrice = Number(slInfo?.actualPrice) || 0;
      return {
        stillOpen: false,
        reason: "SL",
        actualPrice,
        firedOrderId: slOrderId!,
        siblingOrderId: tpOrderId,
      };
    }
    if (tpFired && !slFired) {
      const actualPrice = Number(tpInfo?.actualPrice) || 0;
      return {
        stillOpen: false,
        reason: "TP",
        actualPrice,
        firedOrderId: tpOrderId!,
        siblingOrderId: slOrderId,
      };
    }

    // Both fired, neither fired, or a query failed — genuinely
    // ambiguous. The caller MUST still close its own tracking (the
    // position is definitively gone per Step 1), but cannot claim a
    // precise reason/price.
    log.error(
      { symbol, signalId, slOrderId, tpOrderId, slFired, tpFired },
      "[BINANCE_RECONCILE_LIVE_POSITION_AMBIGUOUS] position closed but could not determine which order fired — caller must use a best-effort fallback",
    );
    return { stillOpen: false, reason: "UNKNOWN" };
  }

  /** Engages the global halt. Idempotent — a second halt call just
   *  logs, doesn't overwrite the original reason (the FIRST problem
   *  is usually the one that matters most for diagnosis). */
  /** Sep 8 2026 (Karo), multi-user adaptation -- made PUBLIC (was
   *  private) so per-user startup-safety wiring (services/
   *  startup-safety.ts) can halt THIS specific user's own instance
   *  when validateForLiveStart() fails, without needing to crash the
   *  whole process (the original single-account bot's own
   *  process.exit(1) reaction is architecturally wrong here -- one
   *  user's own invalid config/credentials must never stop "main" or
   *  any other correctly-configured user). reconcileOnStartup() itself
   *  already calls this internally on its own failure paths,
   *  unchanged.
   */
  setHalt(reason: string): void {
    if (this.haltReason !== null) {
      log.error(
        { reason, existing: this.haltReason },
        "[BINANCE_HALT_ALREADY_ENGAGED]",
      );
      return;
    }
    this.haltReason = reason;
    log.error(
      { reason },
      "[BINANCE_GLOBAL_HALT_ENGAGED] no further live orders will be placed until restart",
    );
    void this.sendCriticalAlert(
      `🛑 EXECUTION HALTED\n\nReason: ${reason}\n\nNo new live orders will be placed until this is investigated and the process is restarted.`,
    );
  }

  private async sendCriticalAlert(text: string): Promise<void> {
    if (!this.telegram) {
      log.warn(
        "no telegram client wired for critical alerts — alert NOT sent, log only",
      );
      return;
    }
    try {
      await this.telegram.sendMessage(text, { silent: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "failed to send critical Telegram alert");
    }
  }

  // ─── clientOrderId generation (P0 #3) ────────────────────────────────

  private clientOrderId(signalId: string, kind: "e" | "s" | "t"): string {
    const clean = signalId.replace(/-/g, "").slice(0, 32);
    return `v3${kind}${clean}`;
  }

  // ─── P0 #4a — startup fail-fast validation ──────────────────────────

  /** Called from app.ts BEFORE strategy start, only when live-armed.
   *  Returns false if ANY critical check fails — caller must exit(1)
   *  rather than let the strategy start with a broken execution
   *  layer. Never places any order. */
  async validateForLiveStart(): Promise<boolean> {
    log.warn(
      "[BINANCE_LIVE_STARTUP_VALIDATION_START] live mode is armed — running fail-fast checks",
    );
    let ok = true;

    if (!this.rest.hasCredentials()) {
      log.error(
        "[BINANCE_LIVE_VALIDATION_FAILED] this user's own Binance API key/secret missing",
      );
      ok = false;
    }

    if (!["ISOLATED", "CROSSED"].includes(this.marginMode)) {
      log.error(
        { marginMode: this.marginMode },
        "[BINANCE_LIVE_VALIDATION_FAILED] invalid BINANCE_MARGIN_MODE",
      );
      ok = false;
    }

    if (
      !Number.isFinite(this.leverage) ||
      this.leverage < 1 ||
      this.leverage > 125
    ) {
      log.error(
        { leverage: this.leverage },
        "[BINANCE_LIVE_VALIDATION_FAILED] BINANCE_LIVE_LEVERAGE out of sane range (1-125)",
      );
      ok = false;
    }

    const riskUsd = this.riskUsdForValidation;
    if (!Number.isFinite(riskUsd) || riskUsd <= 0 || riskUsd > 1000) {
      log.error(
        { riskUsd },
        "[BINANCE_LIVE_VALIDATION_FAILED] risk-per-trade looks unreasonable",
      );
      ok = false;
    }

    // Connectivity + canTrade — reuses the same read-only endpoints as
    // Phase 1 connectivity, but BLOCKING here (awaited, not fire-and-
    // forget) since this gates strategy start.
    try {
      const account = (await this.rest.getAccount()) as { canTrade?: boolean };
      if (account.canTrade !== true) {
        log.error("[BINANCE_LIVE_VALIDATION_FAILED] account.canTrade=false");
        ok = false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg },
        "[BINANCE_LIVE_VALIDATION_FAILED] could not reach Binance account endpoint",
      );
      ok = false;
    }

    // Mongo availability — the idempotency anchor is useless if we
    // can't actually create its unique index.
    try {
      await this.executionRecordRepo.ensureIndexes();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg },
        "[BINANCE_LIVE_VALIDATION_FAILED] could not ensure execution-record indexes (Mongo unavailable?)",
      );
      ok = false;
    }

    // Sep 4 2026, operator-approved (Karo) -- SAME requirement for the
    // GLOBAL execution-claim collection's own unique index. This is the
    // collection that actually enforces cross-process dedup now, so it
    // must be just as much of a startup blocker as the bot-local one.
    try {
      await this.executionClaimRepo.ensureIndexes();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg },
        "[BINANCE_LIVE_VALIDATION_FAILED] could not ensure execution-claim indexes (Mongo unavailable?)",
      );
      ok = false;
    }

    if (ok) {
      log.warn("[BINANCE_LIVE_STARTUP_VALIDATION_PASSED]");
    } else {
      log.error(
        "[BINANCE_LIVE_STARTUP_VALIDATION_FAILED] — process must not start with live execution armed",
      );
    }
    return ok;
  }

  // ─── P0 #4b — startup reconciliation ─────────────────────────────────

  /** Called from app.ts after validateForLiveStart() passes. Compares
   *  Binance's actual open positions/orders against our local record
   *  of genuinely-open live trades. Any position/order we can't
   *  account for engages the global halt and sends a critical alert —
   *  new entries are refused until an operator investigates and
   *  restarts. Never attempts to auto-fix a mismatch.
   *
   *  Aug 2026 CRITICAL FIX (operator-designed, found after a droplet
   *  resize reboot orphaned two real, correctly-protected positions):
   *  this used to check executionRecordRepo.findAllOpen(), which
   *  EXCLUDES status="TP_PLACED" as "terminal-success" — but
   *  TP_PLACED is the NORMAL state for a live trade for its ENTIRE
   *  open lifetime (both SL and TP resting, position genuinely open
   *  on Binance) until it actually closes. executionRecordRepo tracks
   *  execution-CLAIM idempotency (a different, narrower concern — "has
   *  this signalId already been armed") and was never meant to answer
   *  "is there a still-open live position for this symbol" — that
   *  question belongs to paper_signals (status stays ACTIVE until
   *  reconcileLiveTrade() confirms a real close), which is what
   *  openLiveSymbols (passed in from app.ts via
   *  PaperSignalRepository.findOpenLiveSymbols()) now answers. This
   *  means EVERY restart with a genuinely open live position would
   *  have halted the bot — it simply never manifested before because
   *  no restart had previously coincided with an open live trade. */
  async reconcileOnStartup(
    trackedSymbols: readonly string[],
    openLiveSymbols: ReadonlySet<string>,
  ): Promise<void> {
    log.warn("[BINANCE_STARTUP_RECONCILIATION_START]");
    const openRecordSymbols = openLiveSymbols;

    for (const symbol of trackedSymbols) {
      let positionAmt = 0;
      try {
        const positions = (await this.rest.getPositionRisk(symbol)) as Array<{
          symbol: string;
          positionAmt: string;
        }>;
        const pos = positions.find((p) => p.symbol === symbol);
        positionAmt = pos ? parseFloat(pos.positionAmt) : 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          { symbol, err: msg },
          "[BINANCE_RECONCILIATION_QUERY_FAILED]",
        );
        this.setHalt(
          `Startup reconciliation could not query position for ${symbol}: ${msg}`,
        );
        return;
      }

      const hasOpenPosition = Math.abs(positionAmt) > 0;
      const hasLocalRecord = openRecordSymbols.has(symbol);

      if (hasOpenPosition && !hasLocalRecord) {
        log.error(
          { symbol, positionAmt },
          "[BINANCE_ORPHAN_POSITION_DETECTED] real position with no local execution record",
        );
        this.setHalt(
          `Orphan position on ${symbol} (amt=${positionAmt}) with no matching local execution record.`,
        );
        return;
      }

      if (hasOpenPosition && hasLocalRecord) {
        // Verify SL exists for this protected-in-theory position.
        // Aug 2026 FIX: was checking getOpenOrders() (the regular order
        // endpoint) for type==="STOP_MARKET" — but SL/TP moved to the
        // Algo Order system during the 2025-12-09 Binance migration and
        // NEVER appear there anymore. This meant hasSlOrder was
        // ALWAYS false for any genuinely-protected live position,
        // which would have falsely halted on the very next restart
        // with an open position — caught before it ever fired in
        // production, but this was a live landmine. Must query
        // getOpenAlgoOrders() instead.
        let hasSlOrder = false;
        try {
          // Aug 2026, CRITICAL FIX (found via live diagnostic during
          // the resize-reboot incident): the response field is
          // `orderType`, NOT `type` — a live getOpenAlgoOrders() call
          // confirmed the real shape is
          // { orderType: "STOP_MARKET", ... }. Checking `o.type` was
          // always undefined, so hasSlOrder was ALWAYS false
          // regardless of whether an SL was genuinely resting — this
          // meant ANY restart with a real, correctly-protected live
          // position would ALWAYS falsely halt as "unprotected",
          // layered on top of the separate executionRecordRepo bug
          // fixed the same day. Never verified against a real
          // response until this incident, since restarts had never
          // previously coincided with a genuinely open live position.
          const openAlgoOrders = (await this.rest.getOpenAlgoOrders(
            symbol,
          )) as Array<{ orderType: string }>;
          hasSlOrder = openAlgoOrders.some(
            (o) => o.orderType === "STOP_MARKET",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            { symbol, err: msg },
            "[BINANCE_RECONCILIATION_QUERY_FAILED] could not verify SL presence",
          );
          this.setHalt(
            `Could not verify SL presence for ${symbol} during startup reconciliation: ${msg}`,
          );
          return;
        }
        if (!hasSlOrder) {
          log.error(
            { symbol },
            "[BINANCE_ORPHAN_UNPROTECTED_POSITION] open position with NO stop-loss resting",
          );
          this.setHalt(
            `${symbol} has an open position with no resting stop-loss order — needs immediate manual attention.`,
          );
          return;
        }
        log.info(
          { symbol, positionAmt },
          "[BINANCE_RECONCILIATION_OK] position matches local record and SL is present",
        );
      }

      if (!hasOpenPosition && hasLocalRecord) {
        log.warn(
          { symbol },
          "[BINANCE_RECONCILIATION_STALE_RECORD] local record marks this symbol open but no real position exists — " +
            "likely closed while bot was down; not treated as a halt condition, but flagged for review",
        );
      }

      // Sep 4 2026, operator-approved (Karo) -- GLOBAL execution-claim
      // stale-claim reconciliation. Reuses positionAmt/hasOpenPosition
      // already fetched above for THIS symbol -- no extra Binance call.
      // If Binance confirms no real position exists for this symbol
      // right now, but the shared execution_claims collection still
      // holds a CLAIMED document for it (e.g. this process crashed or
      // was restarted after tryClaim() succeeded but before the entry
      // order's outcome was ever confirmed), release it here so the
      // symbol isn't permanently blocked for every process. If a real
      // position DOES exist, the claim (if any) is left untouched --
      // it is presumably the legitimate claim for that genuinely still-
      // open trade. This never halts the bot and never touches
      // execution_records/openLiveSymbols/hasLocalRecord above -- a
      // fully separate, additive check.
      if (!hasOpenPosition) {
        const staleClaims =
          await this.executionClaimRepo.findActiveBySymbol(symbol);
        for (const claim of staleClaims) {
          log.warn(
            { symbol, signalId: claim.signalId },
            "[BINANCE_STALE_GLOBAL_CLAIM_RELEASED] no real Binance position for this symbol, " +
              "but a global execution claim was still CLAIMED — releasing at startup reconciliation",
          );
          await this.executionClaimRepo.releaseClaim(
            claim.signalId,
            "startup-reconciliation-stale: no Binance position found for this symbol",
          );
        }
      }
    }

    log.warn("[BINANCE_STARTUP_RECONCILIATION_COMPLETE]");
  }

  // ─── Entry point ──────────────────────────────────────────────────────

  async run(input: ExecutionInput): Promise<ExecutionResult> {
    try {
      const filters = await this.getSymbolFilters(input.symbol);
      if (!filters) {
        log.error(
          { symbol: input.symbol },
          "[BINANCE_ORDER_SHADOW] could not load symbol filters — skipping plan",
        );
        return {
          status: "ABORTED",
          reason: "could not load symbol filters",
        };
      }
      const plan = this.computeOrderPlan(input, filters);
      this.logShadow(input, plan);

      if (this.mode !== "live" || !this.orderExecutionEnabled) {
        // Not live-armed by configuration — this is the normal
        // shadow/paper path, not a failure. Distinct from the halted
        // case below, which IS a live-armed intent being refused.
        return { status: "SHADOW" };
      }
      if (this.isHalted) {
        log.error(
          {
            symbol: input.symbol,
            signalId: input.signalId,
            haltReason: this.haltReason,
          },
          "[BINANCE_EXECUTION_REFUSED_HALTED]",
        );
        return {
          status: "ABORTED",
          reason: `execution halted: ${this.haltReason ?? "unknown"}`,
        };
      }
      if (!plan.valid) {
        log.error(
          { symbol: input.symbol, reason: plan.invalidReason },
          "[BINANCE_LIVE_ABORTED] plan failed validation",
        );
        return {
          status: "ABORTED",
          reason: `plan invalid: ${plan.invalidReason ?? "unknown"}`,
        };
      }

      // Sep 4 2026, operator-approved (Karo) -- GLOBAL claim FIRST,
      // before any bot-local write or order is sent. This is the
      // actual cross-process enforcement: if another process (MAIN,
      // FRIEND, or BROTHER) already claimed this signalId, refuse
      // immediately, before touching the bot-local execution_records*
      // collection at all -- avoids ever reaching a state where the
      // bot-local record says "claimed" while the global ledger
      // already belongs to someone else.
      const ownerProcess =
        process.env.CANDIDATE_CONSUMER_NAME ??
        process.env.pm_id ??
        "main-or-unnamed";
      const globallyClaimed = await this.executionClaimRepo.tryClaim({
        signalId: input.signalId,
        symbol: plan.symbol,
        side: plan.side,
        ownerProcess,
      });
      if (!globallyClaimed) {
        log.error(
          { signalId: input.signalId, symbol: plan.symbol },
          "[BINANCE_GLOBAL_CLAIM_FAILED] another process already holds the global " +
            "execution claim for this signalId — refusing duplicate execution",
        );
        return {
          status: "ABORTED",
          reason: "global execution claim already held by another process",
          entryOrderNotSent: true,
          globalClaimLost: true,
        };
      }

      // P0 #2 — persistent idempotency claim, BEFORE any order is sent.
      // Bot-local audit trail (unchanged) -- order IDs, fill data,
      // status history. The global claim above is what actually
      // prevents cross-process duplicate execution now; this remains
      // for THIS process's own forensic record-keeping.
      const entryClientOrderId = this.clientOrderId(input.signalId, "e");
      const slClientOrderId = this.clientOrderId(input.signalId, "s");
      const tpClientOrderId = this.clientOrderId(input.signalId, "t");
      const claimed = await this.executionRecordRepo.tryClaim({
        signalId: input.signalId,
        executionId: crypto.randomUUID(),
        symbol: plan.symbol,
        side: plan.side,
        entryClientOrderId,
        entryOrderId: null,
        slClientOrderId,
        slOrderId: null,
        tpClientOrderId,
        tpOrderId: null,
        executedQty: null,
        averageFillPrice: null,
        plannedQuantity: plan.quantityRounded,
        plannedEntry: plan.entryRounded,
        plannedSl: plan.slRounded,
        plannedTp: plan.tpRounded,
        createdAt: Date.now(),
      });
      if (!claimed) {
        log.error(
          { signalId: input.signalId },
          "[BINANCE_DUPLICATE_EXECUTION_REFUSED]",
        );
        // Sep 4 2026, operator-approved (Karo) -- safe to release
        // immediately: executeLive() (where the entry order is
        // actually sent to Binance) has not been called yet at this
        // point, so no Binance order could possibly exist for this
        // signalId. Frees the symbol for a future, different signalId.
        await this.executionClaimRepo.releaseClaim(
          input.signalId,
          "entry-order-not-sent: bot-local claim failed before executeLive()",
        );
        return {
          status: "ABORTED",
          reason: "duplicate execution refused (signalId already claimed)",
        };
      }

      const execResult = await this.executeLive(
        input,
        plan,
        filters,
        entryClientOrderId,
        slClientOrderId,
        tpClientOrderId,
      );
      // Sep 4 2026, operator-approved (Karo) -- release the global
      // claim ONLY when executeLive() itself confirms the entry order
      // was never sent (entryOrderNotSent === true). Every other
      // ABORTED outcome (entry order sent but ambiguous, SL/TP
      // placement failed post-fill, etc.) leaves the claim CLAIMED --
      // deliberately fail closed, since a real Binance position may
      // exist. reconcileOnStartup() is the safety net that later
      // verifies and releases any claim that turns out to have no
      // real position behind it.
      if (execResult.status === "ABORTED" && execResult.entryOrderNotSent) {
        await this.executionClaimRepo.releaseClaim(
          input.signalId,
          "entry-order-not-sent: aborted before Binance entry order was created",
        );
      }
      return execResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol: input.symbol, err: msg },
        "[BINANCE_EXECUTION_ERROR] run() failed",
      );
      // Deliberately does NOT release the claim here -- this catch
      // wraps executeLive() too, so we cannot be certain whether an
      // entry order was sent before the exception occurred. Leaves the
      // claim CLAIMED; reconcileOnStartup() verifies against Binance
      // and releases it if no real position actually exists.
      return { status: "ABORTED", reason: `run() threw: ${msg}` };
    }
  }

  // ─── Phase 2 — position/order plan calculation ───────────────────────

  private computeOrderPlan(input: ExecutionInput, f: SymbolFilters): OrderPlan {
    const entrySide: "BUY" | "SELL" = input.side === "LONG" ? "BUY" : "SELL";
    const closeSide: "BUY" | "SELL" = input.side === "LONG" ? "SELL" : "BUY";

    const entryRounded = this.roundToTick(
      input.entry,
      f.tickSize,
      f.pricePrecision,
    );
    const slRounded = this.roundToTick(
      input.stopLoss,
      f.tickSize,
      f.pricePrecision,
    );
    const tpRounded = this.roundToTick(
      input.takeProfit,
      f.tickSize,
      f.pricePrecision,
    );

    const quantityRaw = input.positionSizeUsdt / entryRounded;
    const quantityRounded = this.floorToStep(
      quantityRaw,
      f.stepSize,
      f.qtyPrecision,
    );
    const notionalUsdt = quantityRounded * entryRounded;

    let valid = true;
    let invalidReason: string | undefined;
    if (quantityRounded < f.minQty) {
      valid = false;
      invalidReason = `quantity ${quantityRounded} below exchange minQty ${f.minQty}`;
    } else if (notionalUsdt < f.minNotional) {
      valid = false;
      invalidReason = `notional $${notionalUsdt.toFixed(2)} below exchange minNotional $${f.minNotional}`;
    } else if (quantityRounded <= 0) {
      valid = false;
      invalidReason = "rounded quantity is zero or negative";
    }

    return {
      symbol: input.symbol,
      side: input.side,
      entrySide,
      closeSide,
      entryRounded,
      slRounded,
      tpRounded,
      quantityRaw,
      quantityRounded,
      slStr: slRounded.toFixed(f.pricePrecision),
      tpStr: tpRounded.toFixed(f.pricePrecision),
      quantityStr: quantityRounded.toFixed(f.qtyPrecision),
      notionalUsdt,
      valid,
      invalidReason,
    };
  }

  private logShadow(input: ExecutionInput, plan: OrderPlan): void {
    const expectedLossUsd =
      Math.abs(plan.entryRounded - plan.slRounded) * plan.quantityRounded;
    const expectedProfitUsd =
      Math.abs(plan.tpRounded - plan.entryRounded) * plan.quantityRounded;
    const marginRequired = plan.notionalUsdt / this.leverage;
    const feeEstimate = plan.notionalUsdt * 0.0005 * 2;

    log.info(
      {
        symbol: plan.symbol,
        side: plan.side,
        signalId: input.signalId,
        riskUsd: input.riskUsd,
        positionSizeUsdt: input.positionSizeUsdt,
        entry: plan.entryRounded,
        sl: plan.slRounded,
        tp: plan.tpRounded,
        quantity: plan.quantityRounded,
        marginRequired: Number(marginRequired.toFixed(2)),
        leverage: this.leverage,
        marginMode: this.marginMode,
        expectedLossUsd: Number(expectedLossUsd.toFixed(2)),
        expectedProfitUsd: Number(expectedProfitUsd.toFixed(2)),
        feeEstimate: Number(feeEstimate.toFixed(2)),
        valid: plan.valid,
        invalidReason: plan.invalidReason,
        orderSent: false,
      },
      "[BINANCE_ORDER_SHADOW]",
    );
  }

  // ─── Self-test (unchanged contract — never reaches live code) ────────

  async runSelfTest(input: ExecutionInput): Promise<void> {
    log.info({ symbol: input.symbol }, "[BINANCE_EXECUTION_SELF_TEST_START]");
    try {
      const filters = await this.getSymbolFilters(input.symbol);
      if (!filters) {
        log.error(
          { symbol: input.symbol },
          "[BINANCE_EXECUTION_SELF_TEST_FAILED] could not load symbol filters",
        );
        return;
      }
      const plan = this.computeOrderPlan(input, filters);
      this.logShadow(input, plan);
      log.info(
        {
          symbol: input.symbol,
          tickSize: filters.tickSize,
          stepSize: filters.stepSize,
          minQty: filters.minQty,
          minNotional: filters.minNotional,
          pricePrecision: filters.pricePrecision,
          qtyPrecision: filters.qtyPrecision,
        },
        "[BINANCE_EXECUTION_SELF_TEST_FILTERS]",
      );
      log.info(
        {
          symbol: input.symbol,
          valid: plan.valid,
          invalidReason: plan.invalidReason,
        },
        "[BINANCE_EXECUTION_SELF_TEST_COMPLETE] — no order was sent, this call has no live code path",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol: input.symbol, err: msg },
        "[BINANCE_EXECUTION_SELF_TEST_FAILED]",
      );
    }
  }

  // ─── Phase 4 — live execution (inert unless isLiveArmed) ─────────────

  private async executeLive(
    input: ExecutionInput,
    plan: OrderPlan,
    f: SymbolFilters,
    entryClientOrderId: string,
    slClientOrderId: string,
    tpClientOrderId: string,
  ): Promise<ExecutionResult> {
    const signalId = input.signalId;
    log.warn(
      {
        symbol: plan.symbol,
        side: plan.side,
        quantity: plan.quantityRounded,
        signalId,
      },
      "[BINANCE_LIVE_EXECUTION_START]",
    );

    try {
      await this.rest.setMarginType(plan.symbol, this.marginMode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAlreadyCorrect =
        err instanceof BinanceApiError && err.code === -4046;
      if (!isAlreadyCorrect) {
        log.error(
          { symbol: plan.symbol, err: msg },
          "[BINANCE_LIVE_ABORTED] setMarginType failed",
        );
        await this.executionRecordRepo.updateStatus(
          signalId,
          "ABORTED",
          `setMarginType failed: ${msg}`,
        );
        return {
          status: "ABORTED",
          reason: `setMarginType failed: ${msg}`,
          entryOrderNotSent: true,
        };
      }
    }

    try {
      await this.rest.setLeverage(plan.symbol, this.leverage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol: plan.symbol, err: msg },
        "[BINANCE_LIVE_ABORTED] setLeverage failed",
      );
      await this.executionRecordRepo.updateStatus(
        signalId,
        "ABORTED",
        `setLeverage failed: ${msg}`,
      );
      return {
        status: "ABORTED",
        reason: `setLeverage failed: ${msg}`,
        entryOrderNotSent: true,
      };
    }

    // ── PRE-FLIGHT validation (Aug 2026, operator-designed) ─────────────
    // Goal: minimize unnecessary OPEN→immediate-CLOSE round trips. Every
    // such round trip costs real fees + spread + slippage even when
    // there's zero price loss — not acceptable as routine behavior.
    // Uses the CURRENT EXECUTABLE price (best ask for LONG/BUY, best
    // bid for SHORT/SELL — the price the MARKET order would actually
    // cross at, NOT the strategy's planned/mid entry) to re-run the
    // SAME planner (planForSymbol -> deriveLiquidationPhysicsTradePlan —
    // zero duplication) used for both the original pre-fill plan and the
    // post-fill replan below. If the trade is already invalid AT THE EXECUTABLE PRICE —
    // geometry floors, or RR below the execution-layer floor — skip
    // sending the MARKET order entirely: zero round-trip fee, nothing
    // opened, nothing to close.
    //
    // This does NOT replace the post-fill replan below — price can
    // still move between this check and the real fill, so post-fill
    // replan remains the FINAL safety net against actual slippage.
    // Pre-flight only removes the PREDICTABLE case: signals that were
    // already doomed before the order was ever sent.
    const bookTicker = await this.getBookTicker(plan.symbol);
    if (bookTicker === null) {
      // Market-data hiccup — proceed to the real order rather than
      // block indefinitely; post-fill replan still protects the trade.
      log.warn(
        { symbol: plan.symbol, signalId },
        "[BINANCE_PRE_FLIGHT_SKIPPED] bookTicker unavailable — proceeding without pre-flight check",
      );
    } else {
      const executablePrice =
        input.side === "LONG" ? bookTicker.askPrice : bookTicker.bidPrice;
      const preFlightPlan = planForSymbol({
        entry: executablePrice,
        side: input.side,
        symbol: plan.symbol,
        w1AnchorPrice: input.w1AnchorPrice,
        w1ExtremePrice: input.w1ExtremePrice,
        w1LiqUsd: input.w1LiqUsd,
        w2LiqUsd: input.w2LiqUsd,
        atr15mAbs: input.atr15mAbs,
        p95: input.p95,
        dailyLiqPerMinBaseline: input.dailyLiqPerMinBaseline,
      });
      const deviationPct =
        ((executablePrice - plan.entryRounded) / plan.entryRounded) * 100;
      const estimatedRoundTripFeeUsd =
        plan.quantityRounded * executablePrice * this.takerFeeRateEstimate * 2;
      const preFlightPass =
        preFlightPlan.ok && preFlightPlan.rr >= this.minRRAfterFill;
      const preFlightDecision: "ENTER" | "SKIP" = preFlightPass
        ? "ENTER"
        : "SKIP";
      const preFlightReason = preFlightPlan.ok
        ? preFlightPass
          ? "ok"
          : `RR ${preFlightPlan.rr.toFixed(3)} < minRRAfterFill ${this.minRRAfterFill}`
        : `plan invalid: ${preFlightPlan.cancelReason}`;

      log.info(
        {
          symbol: plan.symbol,
          signalId,
          plannedEntry: plan.entryRounded,
          executablePrice,
          deviationPct: Number(deviationPct.toFixed(4)),
          estimatedRR: preFlightPlan.ok
            ? Number(preFlightPlan.rr.toFixed(3))
            : null,
          estimatedRiskUsd: preFlightPlan.ok
            ? Number(
                (
                  Math.abs(executablePrice - preFlightPlan.sl) *
                  plan.quantityRounded
                ).toFixed(2),
              )
            : null,
          estimatedRoundTripFeeUsd: Number(estimatedRoundTripFeeUsd.toFixed(4)),
          decision: preFlightDecision,
          reason: preFlightReason,
        },
        "[BINANCE_PRE_FLIGHT]",
      );

      if (preFlightDecision === "SKIP") {
        const fullReason = `SKIP_BEFORE_ORDER: pre-flight failed at executable price ${executablePrice} — ${preFlightReason}`;
        await this.executionRecordRepo.updateStatus(
          signalId,
          "ABORTED",
          fullReason,
        );
        return {
          status: "ABORTED",
          reason: fullReason,
          entryOrderNotSent: true,
        };
      }
    }

    // ── Entry order (P0 #1 — ambiguity-safe) ───────────────────────────
    let entryOrderId: number | null = null;
    let entryPlacementError: string | null = null;
    try {
      const res = (await this.rest.createOrder({
        symbol: plan.symbol,
        side: plan.entrySide,
        type: "MARKET",
        quantity: plan.quantityStr,
        newClientOrderId: entryClientOrderId,
      })) as { orderId: number };
      entryOrderId = res.orderId;
      log.info(
        { symbol: plan.symbol, orderId: entryOrderId, signalId },
        "[BINANCE_ENTRY_ORDER_SENT]",
      );
    } catch (err) {
      entryPlacementError = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol: plan.symbol, err: entryPlacementError, signalId },
        "[BINANCE_ENTRY_ORDER_ERROR] reconciling before concluding anything",
      );
    }

    // Unified confirmed-fill state (Aug 2026). Populated either by the
    // normal createOrder()+pollForFill() success path below, or by
    // reconcileEntryState() whenever either step was inconclusive —
    // both the original P0 #1 case (createOrder itself errored) AND
    // the Aug 2026 ETHUSDT-incident fix (pollForFill exhausted its
    // attempts without seeing FILLED, even though the order DID fill).
    // Every downstream step (replan, SL/TP sizing) reads from this ONE
    // place — no separate "actualQty from fillResult" vs "actualQty
    // from reconciliation" branches to keep in sync.
    let confirmedFill: {
      executedQty: number;
      avgPrice: number;
      orderId: number | null;
    } | null = null;

    if (entryOrderId === null) {
      // P0 #1 — DO NOT assume "nothing was opened". Reconcile.
      const recon = await this.reconcileEntryState(
        plan.symbol,
        entryClientOrderId,
        null,
      );
      if (recon.outcome === "UNKNOWN") {
        log.error(
          { symbol: plan.symbol, signalId },
          "[BINANCE_ENTRY_STATE_UNKNOWN] reconciliation inconclusive after entry placement error",
        );
        await this.executionRecordRepo.updateStatus(
          signalId,
          "ENTRY_AMBIGUOUS",
          `entry error: ${entryPlacementError}; reconciliation inconclusive`,
        );
        this.setHalt(
          `Entry order state unknown for ${plan.symbol} (signalId=${signalId}) after a failed entry order AND inconclusive reconciliation. Manual account check required immediately.`,
        );
        return {
          status: "ABORTED",
          reason:
            "entry order state unknown — reconciliation inconclusive, halted",
        };
      }
      if (recon.outcome === "FLAT") {
        // Confirmed via Binance itself (order AND position both
        // checked): the order genuinely never went through.
        log.info(
          { symbol: plan.symbol, signalId },
          "[BINANCE_ENTRY_CONFIRMED_NOT_OPENED] reconciliation confirms no order/position exists",
        );
        await this.executionRecordRepo.updateStatus(
          signalId,
          "ABORTED",
          `entry order confirmed never placed: ${entryPlacementError}`,
        );
        return {
          status: "ABORTED",
          reason: `entry order confirmed never placed: ${entryPlacementError}`,
        };
      }
      // recon.outcome === "FILLED" — a real fill exists on Binance's
      // side despite our local error, confirmed via order query,
      // position query, or both. Continue the protection flow with
      // the RECONSTRUCTED fill — never re-derive from plan.entryRounded.
      confirmedFill = {
        executedQty: recon.executedQty,
        avgPrice: recon.avgPrice,
        orderId: recon.orderId,
      };
      entryOrderId = recon.orderId;
      log.warn(
        {
          symbol: plan.symbol,
          orderId: entryOrderId,
          executedQty: confirmedFill.executedQty,
          avgPrice: confirmedFill.avgPrice,
          signalId,
        },
        "[BINANCE_ENTRY_RECOVERED_VIA_RECONCILIATION] fill exists on Binance despite local error — continuing protection flow",
      );
    } else {
      // Normal path — order was accepted locally, poll for fill
      // confirmation.
      await this.executionRecordRepo.updateEntryOrder(signalId, entryOrderId);
      const fillResult = await this.pollForFill(plan.symbol, entryOrderId);
      if (fillResult !== null && fillResult.executedQty > 0) {
        confirmedFill = {
          executedQty: fillResult.executedQty,
          avgPrice: fillResult.avgPrice,
          orderId: entryOrderId,
        };
        if (fillResult.partial) {
          log.warn(
            {
              symbol: plan.symbol,
              orderId: entryOrderId,
              planned: plan.quantityRounded,
              actual: fillResult.executedQty,
              signalId,
            },
            "[BINANCE_PARTIAL_FILL] protecting only the actually-filled quantity",
          );
        }
      } else {
        // Aug 2026 fix (ETHUSDT incident) — poll timeout is NOT the
        // same as "did not fill". The order was genuinely SENT and
        // ACCEPTED (entryOrderId is real); a timed-out poll only means
        // we never SAW a FILLED response — Binance may have filled it
        // regardless. Reconcile via the SAME shared function used for
        // placement errors, now passing the known orderId so it's
        // checked first before falling back to a position query.
        log.error(
          { symbol: plan.symbol, orderId: entryOrderId, signalId },
          "[BINANCE_ENTRY_FILL_TIMEOUT] poll exhausted without confirming FILLED — reconciling before concluding anything",
        );
        const recon = await this.reconcileEntryState(
          plan.symbol,
          entryClientOrderId,
          entryOrderId,
        );
        if (recon.outcome === "UNKNOWN") {
          // True unknown state with a REAL order already sent. Cannot
          // determine actual quantity, so the defensive close uses the
          // PLANNED quantity as a reduceOnly best-effort — Binance caps
          // a reduceOnly MARKET close to whatever position actually
          // exists, so over-specifying qty here is safe.
          log.error(
            { symbol: plan.symbol, orderId: entryOrderId, signalId },
            "[BINANCE_ENTRY_STATE_UNKNOWN] reconciliation inconclusive after poll timeout — closing defensively",
          );
          await this.executionRecordRepo.updateStatus(
            signalId,
            "ENTRY_AMBIGUOUS",
            "poll timeout; reconciliation inconclusive — defensive close attempted",
          );
          await this.closePositionWithRetries(
            plan,
            plan.quantityStr,
            signalId,
            "EMERGENCY_CLOSED",
          );
          this.setHalt(
            `Entry fill state unknown for ${plan.symbol} (signalId=${signalId}) after a poll timeout AND inconclusive reconciliation. A defensive close was attempted; investigate before restarting.`,
          );
          return {
            status: "ABORTED",
            reason:
              "entry fill state unknown after poll timeout — reconciliation inconclusive, closed defensively and halted",
          };
        }
        if (recon.outcome === "FLAT") {
          log.info(
            { symbol: plan.symbol, orderId: entryOrderId, signalId },
            "[BINANCE_ENTRY_CONFIRMED_NOT_OPENED] reconciliation confirms no fill occurred despite the order being sent",
          );
          await this.executionRecordRepo.updateStatus(
            signalId,
            "ABORTED",
            "poll timeout; reconciliation confirms no fill occurred",
          );
          return {
            status: "ABORTED",
            reason: "poll timeout; reconciliation confirms no fill occurred",
          };
        }
        // recon.outcome === "FILLED" — the ETHUSDT scenario exactly:
        // the order DID fill, we just never saw the confirmation.
        confirmedFill = {
          executedQty: recon.executedQty,
          avgPrice: recon.avgPrice,
          orderId: recon.orderId ?? entryOrderId,
        };
        log.warn(
          {
            symbol: plan.symbol,
            orderId: entryOrderId,
            executedQty: confirmedFill.executedQty,
            avgPrice: confirmedFill.avgPrice,
            signalId,
          },
          "[BINANCE_ENTRY_RECOVERED_VIA_RECONCILIATION] fill confirmed via reconciliation after poll timeout — continuing protection flow",
        );
      }
    }

    // confirmedFill is now guaranteed non-null on every path that
    // reaches here — every ABORT path above already returned.
    const actualQty: number = confirmedFill!.executedQty;
    const actualQtyStr = actualQty.toFixed(
      plan.quantityStr.split(".")[1]?.length ?? 0,
    );
    await this.executionRecordRepo.updateFill(
      signalId,
      actualQty,
      confirmedFill!.avgPrice,
    );
    log.info(
      { symbol: plan.symbol, orderId: entryOrderId, actualQty, signalId },
      "[BINANCE_ENTRY_FILL_CONFIRMED]",
    );

    // ── Post-fill REPLAN (Aug 2026, operator-designed rewrite) ──────────
    // The previous version of this block recalculated RR against the
    // OLD, PLANNED (percentage-based) SL/TP — i.e. it kept the absolute
    // SL/TP price levels fixed and only asked "does the actual fill
    // still clear RR against those fixed levels?". That's wrong: SL/TP
    // are themselves a function of entry (ATR%, wall distance, RR-flex
    // all key off entry price), so a fixed-level comparison compounds
    // slippage into an artificial RR distortion instead of measuring
    // whether the STRATEGY still likes this trade at the price it
    // actually got filled at.
    //
    // Fix: re-run the exact same planner (planForSymbol —
    // same formulas, same thresholds, zero duplication, imported from
    // ../strategy-v2/trade-plan) with the ACTUAL fill price substituted
    // for entry, reusing the FROZEN cumLiq/liqBaseline/atr15mPct/walls
    // captured at signal time (NOT re-fetched here — BinanceExecutionService
    // has no market-data dependencies and none are needed; re-fetching
    // live context at fill time would also compare the trade against a
    // different market moment than the strategy actually evaluated).
    // Position size is NEVER touched by this replan — actualQty/
    // actualQtyStr from the confirmed fill above are what SL/TP get
    // sized against below, unchanged.
    const actualEntry =
      confirmedFill!.avgPrice > 0 ? confirmedFill!.avgPrice : plan.entryRounded;
    if (confirmedFill!.avgPrice <= 0) {
      log.warn(
        { symbol: plan.symbol, signalId },
        "[BINANCE_FILL_PRICE_MISSING] exchange did not return a usable avgPrice — falling back to planned entry for replan, treat with caution",
      );
    }
    const plannedSlDistance = Math.abs(plan.entryRounded - plan.slRounded);
    const plannedTpDistance = Math.abs(plan.tpRounded - plan.entryRounded);
    const plannedRR =
      plannedSlDistance > 0 ? plannedTpDistance / plannedSlDistance : Infinity;
    const slippagePct =
      ((actualEntry - plan.entryRounded) / plan.entryRounded) * 100;

    const standardReplan = planForSymbol({
      entry: actualEntry,
      side: input.side,
      symbol: plan.symbol,
      w1AnchorPrice: input.w1AnchorPrice,
      w1ExtremePrice: input.w1ExtremePrice,
      w1LiqUsd: input.w1LiqUsd,
      w2LiqUsd: input.w2LiqUsd,
      atr15mAbs: input.atr15mAbs,
      p95: input.p95,
      dailyLiqPerMinBaseline: input.dailyLiqPerMinBaseline,
    });
    // Aug 28 2026, operator-approved (Karo) -- CRITICAL FIX. Without
    // this override, MICRO's own compressed TP/SL (NORMAL's own
    // distances divided by V3_MICRO_EXIT_DIVISOR) would be silently
    // DISCARDED here: the standard replan above completely ignores
    // input.stopLoss/takeProfit and RE-DERIVES fresh TP%/SL% from
    // structural market conditions (w1AnchorPrice/w1ExtremePrice/atr15mAbs) -- since
    // MICRO passes the SAME structural context NORMAL used, that
    // re-derivation would silently regenerate NORMAL-SIZED TP/SL again
    // (confirmed real bug, operator's own finding). When fixedExitPct
    // is present, SL/TP are instead computed as FIXED PERCENTAGE
    // DISTANCES from the actual fill price -- never re-derived from
    // structural conditions, never re-running the structural trade-
    // plan's own strategy logic for a "new" trade plan. Absent for
    // every NORMAL call, so standardReplan is used completely
    // unchanged there.
    const replan: LiquidityPlanResult = input.fixedExitPct
      ? ({
          ok: true,
          sl:
            input.side === "LONG"
              ? actualEntry * (1 - input.fixedExitPct.slPct)
              : actualEntry * (1 + input.fixedExitPct.slPct),
          tp:
            input.side === "LONG"
              ? actualEntry * (1 + input.fixedExitPct.tpPct)
              : actualEntry * (1 - input.fixedExitPct.tpPct),
          slPct: input.fixedExitPct.slPct,
          tpPct: input.fixedExitPct.tpPct,
          rr:
            input.fixedExitPct.slPct > 0
              ? input.fixedExitPct.tpPct / input.fixedExitPct.slPct
              : Infinity,
          // Forensics-only fields (LiquidityPlanForensics) -- never
          // read by any downstream logic in this function, only
          // potentially by external logging; zero-filled since MICRO's
          // own exit isn't derived from this market-condition formula
          // at all.
          intensityRaw: 0,
          intensity: 0,
          atr15mPct: 0,
          rawTpPct: input.fixedExitPct.tpPct,
          wallAdjustedTpPct: input.fixedExitPct.tpPct,
          wallApplied: false,
          rrCandidate:
            input.fixedExitPct.slPct > 0
              ? input.fixedExitPct.tpPct / input.fixedExitPct.slPct
              : Infinity,
          slCapApplied: false,
          slCapValue: input.fixedExitPct.slPct,
          profitWallNotionalAtEntry: 0,
          profitWallNotionalAtAnchor: 0,
        } as LiquidityPlanResult)
      : standardReplan;
    // Two independent floors, deliberately kept separate:
    //   replan.ok            — the STRATEGY's own geometry floors
    //                          (MIN_TP_PCT, MIN_SL_PCT, RR_MIN inside
    //                          planForSymbol/deriveLiquidationPhysicsTradePlan).
    //   this.minRRAfterFill  — the EXECUTION layer's own, independently
    //                          env-configurable safety floor
    //                          (BINANCE_MIN_RR_AFTER_FILL). Currently
    //                          the same numeric value as the strategy's
    //                          RR_MIN, but kept as a separate check so
    //                          an operator can tighten execution-side
    //                          risk tolerance without touching strategy
    //                          constants, or vice versa.
    const decision: "CONTINUE" | "ABORT" =
      replan.ok && replan.rr >= this.minRRAfterFill ? "CONTINUE" : "ABORT";

    log.info(
      {
        symbol: plan.symbol,
        signalId,
        plannedEntry: plan.entryRounded,
        actualFill: actualEntry,
        plannedSl: plan.slRounded,
        plannedTp: plan.tpRounded,
        replannedSl: replan.ok ? replan.sl : null,
        replannedTp: replan.ok ? replan.tp : null,
        plannedRR: Number(plannedRR.toFixed(3)),
        replannedRR: replan.ok ? Number(replan.rr.toFixed(3)) : null,
        slippagePct: Number(slippagePct.toFixed(4)),
        decision,
        replanCancelReason: replan.ok ? undefined : replan.cancelReason,
        minRRAfterFill: this.minRRAfterFill,
      },
      "[BINANCE_POST_FILL_REPLAN]",
    );

    if (!replan.ok) {
      const abortReason = `replan invalid: ${replan.cancelReason}`;
      log.error(
        { symbol: plan.symbol, signalId, abortReason },
        "[BINANCE_ENTRY_ABORTED_AFTER_FILL] post-fill replan rejected — closing immediately, SL/TP were never placed",
      );
      await this.executionRecordRepo.updateStatus(
        signalId,
        "ABORTED_LOW_RR",
        `${abortReason}; actualFill=${actualEntry}; slippagePct=${slippagePct.toFixed(4)}`,
      );
      await this.closePositionWithRetries(
        plan,
        actualQtyStr,
        signalId,
        "ABORTED_LOW_RR",
      );
      await this.sendCriticalAlert(
        `⚠️ ENTRY_ABORTED_AFTER_FILL\n\nSymbol: ${plan.symbol} ${plan.side}\nReason: ${abortReason}\n\nPlanned entry: ${plan.entryRounded}\nActual fill: ${actualEntry}\nSlippage: ${slippagePct.toFixed(3)}%\n\nPlanned RR: ${plannedRR.toFixed(2)}\nReplanned RR: n/a (min required: ${this.minRRAfterFill})\n\nPosition was closed immediately. No SL/TP was ever placed.`,
      );
      return { status: "ABORTED", reason: abortReason };
    }
    // From this point on, replan.ok === true is proven to TypeScript —
    // replan.sl/tp/rr are all safely accessible below.
    if (replan.rr < this.minRRAfterFill) {
      const abortReason = `replanned RR ${replan.rr.toFixed(3)} < minRRAfterFill ${this.minRRAfterFill}`;
      log.error(
        { symbol: plan.symbol, signalId, abortReason },
        "[BINANCE_ENTRY_ABORTED_AFTER_FILL] post-fill replan rejected — closing immediately, SL/TP were never placed",
      );
      await this.executionRecordRepo.updateStatus(
        signalId,
        "ABORTED_LOW_RR",
        `${abortReason}; actualFill=${actualEntry}; slippagePct=${slippagePct.toFixed(4)}`,
      );
      await this.closePositionWithRetries(
        plan,
        actualQtyStr,
        signalId,
        "ABORTED_LOW_RR",
      );
      await this.sendCriticalAlert(
        `⚠️ ENTRY_ABORTED_AFTER_FILL\n\nSymbol: ${plan.symbol} ${plan.side}\nReason: ${abortReason}\n\nPlanned entry: ${plan.entryRounded}\nActual fill: ${actualEntry}\nSlippage: ${slippagePct.toFixed(3)}%\n\nPlanned RR: ${plannedRR.toFixed(2)}\nReplanned RR: ${replan.rr.toFixed(2)} (min required: ${this.minRRAfterFill})\n\nPosition was closed immediately. No SL/TP was ever placed.`,
      );
      return { status: "ABORTED", reason: abortReason };
    }

    // Replan is valid and clears both floors — round the REPLANNED
    // SL/TP to this symbol's tick size (same rounding path as the
    // original plan) and use THESE, not the stale planned levels, for
    // the orders placed below. Quantity is untouched.
    const replannedSlRounded = this.roundToTick(
      replan.sl,
      f.tickSize,
      f.pricePrecision,
    );
    const replannedTpRounded = this.roundToTick(
      replan.tp,
      f.tickSize,
      f.pricePrecision,
    );
    const replannedSlStr = replannedSlRounded.toFixed(f.pricePrecision);
    const replannedTpStr = replannedTpRounded.toFixed(f.pricePrecision);

    // ── Stop loss — placed FIRST, sized to ACTUAL filled quantity ──────
    // Aug 2026: migrated to createAlgoOrder() (POST /fapi/v1/algoOrder)
    // — STOP_MARKET is a conditional order type and Binance rejects it
    // on the old /fapi/v1/order endpoint since 2025-12-09 (error -4120).
    // Field names differ from the old endpoint: algoId (not orderId),
    // clientAlgoId (not newClientOrderId), triggerPrice (not stopPrice).
    let slOrderId: number | null = null;
    let slPlacementError: string | null = null;
    try {
      const res = (await this.rest.createAlgoOrder({
        symbol: plan.symbol,
        side: plan.closeSide,
        type: "STOP_MARKET",
        triggerPrice: replannedSlStr,
        quantity: actualQtyStr,
        reduceOnly: "true",
        clientAlgoId: slClientOrderId,
      })) as { algoId: number };
      slOrderId = res.algoId;
    } catch (err) {
      slPlacementError = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol: plan.symbol, err: slPlacementError, signalId },
        "[BINANCE_SL_PLACEMENT_ERROR] reconciling before concluding SL failed",
      );
    }

    if (slOrderId === null) {
      // SL/TP ambiguity closure — same treatment as entry (P0 #1).
      // Never assume "SL was not placed" on a bare error; check
      // Binance's own record via clientOrderId first.
      const slRecon = await this.reconcileOrderAmbiguity(
        plan.symbol,
        slClientOrderId,
        "algo",
      );
      if (slRecon === null) {
        // True unknown state for the STOP order specifically. Emergency
        // -close is still the safe default here (flattening the
        // position makes a possibly-resting SL moot rather than
        // dangerous), but this also needs a halt for investigation —
        // a reconciliation query failing points at a deeper
        // connectivity problem, not just this one order.
        log.error(
          { symbol: plan.symbol, signalId },
          "[BINANCE_SL_STATE_UNKNOWN] reconciliation query failed after SL placement error — closing defensively",
        );
        await this.executionRecordRepo.updateStatus(
          signalId,
          "ENTRY_AMBIGUOUS",
          `SL placement error: ${slPlacementError}; reconciliation query also failed`,
        );
        await this.closePositionWithRetries(
          plan,
          actualQtyStr,
          signalId,
          "EMERGENCY_CLOSED",
        );
        // Aug 2026 (XRP incident fix) — the position close alone does
        // NOT guarantee no SL algo order is left resting on Binance.
        // slOrderId is still null here (that's WHY we're in this
        // branch), but a "-2013"/error response from createAlgoOrder
        // doesn't rule out Binance having accepted it anyway before
        // the response was lost — finalizeAbortCleanup's untracked-
        // order sweep (step 2) is what actually catches this case.
        const cleanClean = await this.finalizeAbortCleanup(plan, signalId, [
          slOrderId,
        ]);
        if (!cleanClean) {
          await this.executionRecordRepo.updateStatus(
            signalId,
            "ORPHAN_HALT",
            "post-abort cleanup could not confirm a clean final state (position and/or orphan algo orders)",
          );
          this.setHalt(
            `SL order state unknown for ${plan.symbol} (signalId=${signalId}) AND post-abort cleanup could not confirm a clean final state. Manual account check required immediately — do not assume the position or SL is handled.`,
          );
          return {
            status: "ABORTED",
            reason:
              "SL state unknown, cleanup verification failed — halted, manual check required",
          };
        }
        this.setHalt(
          `SL order state unknown for ${plan.symbol} (signalId=${signalId}) after a failed SL placement AND a failed reconciliation query. Position was closed defensively and cleanup verified clean; investigate the connectivity issue before restarting.`,
        );
        return {
          status: "ABORTED",
          reason:
            "SL state unknown — reconciliation query also failed, closed defensively and halted",
        };
      }
      if (slRecon.exists) {
        slOrderId = slRecon.orderId;
        log.warn(
          { symbol: plan.symbol, orderId: slOrderId, signalId },
          "[BINANCE_SL_RECOVERED_VIA_RECONCILIATION] SL order exists on Binance despite local error",
        );
      }
      // else: confirmed genuinely not placed — falls through to the
      // verify check below, which will fail and trigger emergency close.
    }

    const slVerified =
      slOrderId !== null &&
      (await this.verifyOrderResting(plan.symbol, slOrderId));
    if (!slVerified) {
      log.error(
        { symbol: plan.symbol, signalId },
        "[BINANCE_SL_VERIFICATION_FAILED] no confirmed stop-loss — emergency close",
      );
      await this.closePositionWithRetries(
        plan,
        actualQtyStr,
        signalId,
        "EMERGENCY_CLOSED",
      );
      // Aug 2026 (XRP incident fix). Verification failing does NOT
      // mean the SL algo order doesn't exist — it may well be resting
      // on Binance despite our query not confirming it (exactly what
      // happened: position closed to 0, but the STOP_MARKET algo
      // order was left orphaned and still open afterward). Cancel it
      // explicitly, then sweep for anything else untracked, then
      // re-verify a fully clean state before calling this "handled".
      const cleanupOk = await this.finalizeAbortCleanup(plan, signalId, [
        slOrderId,
      ]);
      if (!cleanupOk) {
        await this.executionRecordRepo.updateStatus(
          signalId,
          "ORPHAN_HALT",
          "SL verification failed; post-close cleanup could not confirm a clean final state",
        );
        this.setHalt(
          `SL verification failed for ${plan.symbol} (signalId=${signalId}) and post-close cleanup could not confirm no position/orphan algo orders remain. Manual account check required immediately.`,
        );
        await this.sendCriticalAlert(
          `🛑 CLEANUP_VERIFICATION_FAILED\n\nSymbol: ${plan.symbol} ${plan.side}\nsignalId: ${signalId}\n\nSL verification failed and the position was emergency-closed, but post-abort cleanup could NOT confirm the account is fully clean (position=0 AND no resting algo orders). Manual account check required immediately — do not assume this is handled.`,
        );
        return {
          status: "ABORTED",
          reason:
            "SL verification failed, cleanup verification failed — halted, manual check required",
        };
      }
      return {
        status: "ABORTED",
        reason:
          "SL verification failed — emergency close engaged, cleanup verified clean",
      };
    }
    await this.executionRecordRepo.updateSl(signalId, slOrderId!);
    log.info(
      { symbol: plan.symbol, orderId: slOrderId, signalId },
      "[BINANCE_SL_PLACED_AND_VERIFIED]",
    );

    // ── Take profit — only after SL confirmed resting ──────────────────
    // Aug 2026: migrated to createAlgoOrder() — see SL section above for
    // the full rationale (Binance's 2025-12-09 Algo Order migration).
    let tpOrderId: number | null = null;
    let tpPlacementError: string | null = null;
    try {
      const res = (await this.rest.createAlgoOrder({
        symbol: plan.symbol,
        side: plan.closeSide,
        type: "TAKE_PROFIT_MARKET",
        triggerPrice: replannedTpStr,
        quantity: actualQtyStr,
        reduceOnly: "true",
        clientAlgoId: tpClientOrderId,
      })) as { algoId: number };
      tpOrderId = res.algoId;
    } catch (err) {
      tpPlacementError = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol: plan.symbol, err: tpPlacementError, signalId },
        "[BINANCE_TP_PLACEMENT_ERROR] reconciling before concluding TP failed (SL already protects the position)",
      );
    }

    if (tpOrderId === null) {
      // TP ambiguity closure. The position is already protected by a
      // verified SL either way, so this does NOT emergency-close or
      // halt — but per the Aug 2026 execution-first architecture, an
      // unconfirmed TP now DOES mean this execution is not "complete":
      // no normal Mongo/Telegram ENTRY should be written for a
      // half-protected position, even though Binance itself is fine
      // leaving it SL-only pending manual follow-up.
      const tpRecon = await this.reconcileOrderAmbiguity(
        plan.symbol,
        tpClientOrderId,
        "algo",
      );
      if (tpRecon === null) {
        log.error(
          { symbol: plan.symbol, signalId },
          "[BINANCE_TP_STATE_UNKNOWN] reconciliation query failed after TP placement error — SL still protects the position; manual check needed for TP specifically",
        );
      } else if (tpRecon.exists) {
        tpOrderId = tpRecon.orderId;
        log.warn(
          { symbol: plan.symbol, orderId: tpOrderId, signalId },
          "[BINANCE_TP_RECOVERED_VIA_RECONCILIATION] TP order exists on Binance despite local error",
        );
      } else {
        log.error(
          { symbol: plan.symbol, signalId },
          "[BINANCE_TP_CONFIRMED_NOT_PLACED] reconciliation confirms no TP order exists — SL still protects the position; manual follow-up needed to add a TP",
        );
      }
    }

    let tpVerified = false;
    if (tpOrderId !== null) {
      tpVerified = await this.verifyOrderResting(plan.symbol, tpOrderId);
      if (tpVerified) {
        await this.executionRecordRepo.updateTp(signalId, tpOrderId);
        log.info(
          { symbol: plan.symbol, orderId: tpOrderId, signalId },
          "[BINANCE_TP_PLACED_AND_VERIFIED]",
        );
      } else {
        log.error(
          { symbol: plan.symbol, orderId: tpOrderId, signalId },
          "[BINANCE_TP_VERIFICATION_FAILED] TP sent but not confirmed resting — manual check needed",
        );
      }
    }

    if (!tpVerified) {
      // Position is real and open on Binance, protected by a verified
      // SL — NOT emergency-closed (closing a perfectly fine SL-only
      // position over a TP hiccup would be the wrong tradeoff). But
      // this execution is not "complete" by the execution-first
      // contract: the caller must not write a normal Mongo/Telegram
      // ENTRY for it. The execution-record status stays at SL_PLACED
      // (accurately reflecting reality) rather than being force-set to
      // ABORTED, which would misleadingly imply nothing is open.
      const reason =
        "TP placement/verification failed — position remains open on Binance, protected by SL only; manual follow-up required";
      await this.sendCriticalAlert(
        `⚠️ TP_NOT_CONFIRMED\n\nSymbol: ${plan.symbol} ${plan.side}\nEntry: ${actualEntry}\nSL: ${replannedSlStr} (placed & verified)\nTP: NOT confirmed.\n\nPosition remains OPEN on Binance, protected by SL only. No normal ENTRY was recorded — this alert is the only record until resolved manually. signalId=${signalId}`,
      );
      return { status: "ABORTED", reason };
    }

    log.warn(
      { symbol: plan.symbol, entryOrderId, slOrderId, tpOrderId, signalId },
      "[BINANCE_LIVE_EXECUTION_COMPLETE]",
    );

    const confirmedEntryOrderId2: number = entryOrderId!;
    const confirmedSlOrderId: number = slOrderId!;
    const confirmedTpOrderId: number = tpOrderId!;
    return {
      status: "SUCCESS",
      actualEntry,
      actualQty,
      replannedSl: replannedSlRounded,
      replannedTp: replannedTpRounded,
      replannedRR: replan.rr,
      actualRiskUsd: Math.abs(actualEntry - replannedSlRounded) * actualQty,
      actualNotionalUsdt: actualQty * actualEntry,
      leverage: this.leverage,
      marginMode: this.marginMode,
      entryOrderId: confirmedEntryOrderId2,
      slOrderId: confirmedSlOrderId,
      tpOrderId: confirmedTpOrderId,
    };
  }

  /** P0 #1 — reconciles an ambiguous entry-order outcome against
   *  Binance's own records. Returns null if the reconciliation QUERY
   *  itself fails (true unknown state — caller must halt). Otherwise
   *  returns whether the order actually exists and, if so, its id. */
  /** P0 #1 + SL/TP ambiguity closure (Aug 2026). Generic reconciliation
   *  for ANY order type — used for entry, SL, and TP alike. Returns
   *  null only when the query itself fails (true unknown state). */
  /** Aug 2026: `kind` parameter added. "regular" (default) queries the
   *  old /fapi/v1/order endpoint via getOrderByClientId() — used for
   *  entry-order ambiguity (MARKET orders are unaffected by the Algo
   *  Order migration). "algo" queries the new /fapi/v1/algoOrder
   *  endpoint via getAlgoOrderByClientId() — used for SL/TP ambiguity,
   *  since those are conditional orders and live in the Algo system.
   *  The -2013 "Order does not exist" check is kept as a heuristic for
   *  the algo path too (Binance commonly reuses this generic code
   *  across order systems) — but treat this as unverified against real
   *  Algo Order error responses until confirmed in production; any
   *  OTHER error still falls through to the safe "unknown" (null)
   *  return, exactly as the regular path already does. */
  /** Aug 2026, unified entry-state reconciliation (operator-designed —
   *  closes the ETHUSDT poll-timeout gap). Used for BOTH: (a) the
   *  initial createOrder() call itself throwing/erroring, and (b)
   *  pollForFill() exhausting its attempts without ever confirming
   *  FILLED/PARTIALLY_FILLED. One shared function, no duplicated
   *  reconciliation logic between the two call sites.
   *
   *  In BOTH cases the entry MARKET order may have ACTUALLY succeeded
   *  on Binance's side even though this process couldn't locally
   *  confirm it — this function is the single source of truth for
   *  "what actually happened", checked in order:
   *   1. Query the order itself (by orderId if known, else by
   *      clientOrderId). FILLED/PARTIALLY_FILLED with executedQty > 0
   *      -> outcome FILLED, using the order's own executedQty/avgPrice.
   *   2. If the order query is inconclusive (a genuine query failure,
   *      not a confirmed "doesn't exist") or didn't return a usable
   *      fill, fall back to querying the ACTUAL POSITION — the
   *      ultimate ground truth. A nonzero position means a real fill
   *      happened regardless of what the order record says, and the
   *      fill is RECONSTRUCTED directly from the position itself
   *      (positionAmt for qty, entryPrice for avgPrice).
   *   3. Only if the position query also confirms zero (flat) is the
   *      outcome FLAT.
   *   4. Any genuine query failure at the position-check step (not a
   *      confirmed flat) is UNKNOWN — caller must halt defensively,
   *      never assume FLAT and never assume FILLED. */
  private async reconcileEntryState(
    symbol: string,
    entryClientOrderId: string,
    knownOrderId: number | null,
  ): Promise<
    | {
        outcome: "FILLED";
        executedQty: number;
        avgPrice: number;
        orderId: number | null;
      }
    | { outcome: "FLAT" }
    | { outcome: "UNKNOWN" }
  > {
    // Step 1 — order query (most precise source when it works).
    try {
      const res = (
        knownOrderId !== null
          ? await this.rest.getOrder(symbol, knownOrderId)
          : await this.rest.getOrderByClientId(symbol, entryClientOrderId)
      ) as {
        orderId?: number;
        status?: string;
        executedQty?: string;
        avgPrice?: string;
      };
      if (
        (res.status === "FILLED" || res.status === "PARTIALLY_FILLED") &&
        Number(res.executedQty ?? 0) > 0
      ) {
        return {
          outcome: "FILLED",
          executedQty: Number(res.executedQty),
          avgPrice: Number(res.avgPrice ?? 0),
          orderId: res.orderId ?? knownOrderId,
        };
      }
      // Order exists but shows no fill (NEW/CANCELED/EXPIRED/REJECTED,
      // or FILLED-with-zero-qty which shouldn't happen but is treated
      // conservatively) — do NOT conclude FLAT from this alone. A
      // MARKET order genuinely shouldn't linger unfilled, but the
      // position query below is the real ground truth; fall through.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // -2013 ("Order does not exist") and any other error are treated
      // identically here: fall through to the position check. Even a
      // confirmed "-2013" on the ORDER doesn't rule out a position
      // existing via some other path — the position check is the
      // final word either way, so there's no need to branch on the
      // error type before falling through (unlike reconcileOrderAmbiguity,
      // which stops at "-2013" because it has no cheaper ground-truth
      // check available for SL/TP algo orders).
      log.warn(
        { symbol, entryClientOrderId, knownOrderId, err: msg },
        "[BINANCE_ENTRY_RECON_ORDER_QUERY_INCONCLUSIVE] falling back to position query",
      );
    }

    // Step 2 — position query (ground truth: a real fill leaves a real
    // position regardless of what the order record shows or whether
    // the order query itself failed).
    try {
      const positions = (await this.rest.getPositionRisk(symbol)) as Array<{
        symbol: string;
        positionAmt: string;
        entryPrice: string;
      }>;
      const pos = positions.find((p) => p.symbol === symbol);
      const amt = pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
      if (amt > 0) {
        return {
          outcome: "FILLED",
          executedQty: amt,
          avgPrice: pos ? parseFloat(pos.entryPrice) : 0,
          orderId: knownOrderId,
        };
      }
      return { outcome: "FLAT" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol, entryClientOrderId, knownOrderId, err: msg },
        "[BINANCE_ENTRY_RECONCILIATION_FAILED] both order and position queries inconclusive",
      );
      return { outcome: "UNKNOWN" };
    }
  }

  private async reconcileOrderAmbiguity(
    symbol: string,
    clientOrderId: string,
    kind: "regular" | "algo" = "regular",
  ): Promise<{ exists: boolean; orderId: number | null } | null> {
    try {
      if (kind === "algo") {
        const res = (await this.rest.getAlgoOrderByClientId(clientOrderId)) as {
          algoId?: number;
        };
        if (res.algoId !== undefined) {
          return { exists: true, orderId: res.algoId };
        }
        return { exists: false, orderId: null };
      }
      const res = (await this.rest.getOrderByClientId(
        symbol,
        clientOrderId,
      )) as {
        orderId?: number;
        status?: string;
      };
      if (res.orderId !== undefined) {
        return { exists: true, orderId: res.orderId };
      }
      return { exists: false, orderId: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof BinanceApiError && err.code === -2013) {
        // "Order does not exist" — Binance's own confirmation that
        // this clientOrderId was never actually placed.
        return { exists: false, orderId: null };
      }
      // Any other error (network, auth, etc.) means we genuinely don't
      // know — true ambiguity, must be surfaced to the caller as such.
      log.error(
        { symbol, clientOrderId, kind, err: msg },
        "reconcileOrderAmbiguity query failed",
      );
      return null;
    }
  }

  /** P0 #6 — emergency close with retries + verification. */
  private async closePositionWithRetries(
    plan: OrderPlan,
    qtyStr: string,
    signalId: string,
    onSuccessStatus: "EMERGENCY_CLOSED" | "ABORTED_LOW_RR",
  ): Promise<void> {
    const delays = [1000, 2000, 4000];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.rest.createOrder({
          symbol: plan.symbol,
          side: plan.closeSide,
          type: "MARKET",
          quantity: qtyStr,
          reduceOnly: "true",
        });
        log.warn(
          { symbol: plan.symbol, attempt, signalId },
          "[BINANCE_CLOSE_ATTEMPT_SENT]",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          { symbol: plan.symbol, attempt, err: msg, signalId },
          "[BINANCE_CLOSE_ATTEMPT_FAILED]",
        );
      }

      const stillOpen = await this.positionStillOpen(plan.symbol);
      if (stillOpen === false) {
        log.warn(
          { symbol: plan.symbol, attempt, signalId, onSuccessStatus },
          "[BINANCE_CLOSE_VERIFIED] position confirmed closed",
        );
        await this.executionRecordRepo.updateStatus(
          signalId,
          onSuccessStatus,
          `closed on attempt ${attempt}`,
        );
        return;
      }
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      }
    }

    log.error(
      { symbol: plan.symbol, signalId },
      "[BINANCE_CLOSE_EXHAUSTED] position still open after 3 attempts",
    );
    await this.executionRecordRepo.updateStatus(
      signalId,
      "ORPHAN_HALT",
      "close failed after 3 attempts — position may still be open with no stop-loss",
    );
    this.setHalt(
      `Emergency close failed 3 times for ${plan.symbol} (signalId=${signalId}) — position may still be open with NO stop-loss. Manual intervention required immediately.`,
    );
  }

  /** Aug 2026, pre-flight validation prerequisite. Returns the current
   *  best bid/ask, or null on any failure (caller treats null as "skip
   *  pre-flight, proceed to the real order" rather than blocking). */
  private async getBookTicker(
    symbol: string,
  ): Promise<{ bidPrice: number; askPrice: number } | null> {
    try {
      const res = (await this.rest.getBookTicker(symbol)) as {
        bidPrice?: string;
        askPrice?: string;
      };
      const bidPrice = Number(res.bidPrice);
      const askPrice = Number(res.askPrice);
      if (
        !Number.isFinite(bidPrice) ||
        !Number.isFinite(askPrice) ||
        bidPrice <= 0 ||
        askPrice <= 0
      ) {
        return null;
      }
      return { bidPrice, askPrice };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ symbol, err: msg }, "getBookTicker query failed");
      return null;
    }
  }

  /** Aug 2026, mandatory abort cleanup (operator-designed — closes the
   *  XRP incident gap). Called whenever execution aborts AFTER an SL
   *  or TP algo order MAY have already been created on Binance — even
   *  when local verification failed, the order can still genuinely be
   *  resting there (that's exactly what happened: SL verification
   *  failed, the position was emergency-closed, but the STOP_MARKET
   *  algo order itself was left orphaned and still open afterward).
   *
   *  Order of operations:
   *   1. Cancel every KNOWN algoId (SL, TP — whichever are non-null).
   *      "Already cancelled / doesn't exist" is treated as success.
   *   2. Query ALL open algo orders for the symbol — catches anything
   *      we don't have a tracked algoId for (e.g. verification failed
   *      before an id was ever cleanly captured), and cancel those too.
   *   3. Re-verify: position must be 0 AND open algo orders must be
   *      empty.
   *  Returns true only if the final state is confirmed fully clean.
   *  Returns false if ANY step is inconclusive (a query itself fails)
   *  OR the final re-verification still shows a live position or a
   *  resting algo order — the caller MUST treat false as "unknown/
   *  incomplete", never as "probably fine". */
  private async finalizeAbortCleanup(
    plan: OrderPlan,
    signalId: string,
    knownAlgoIds: Array<number | null>,
  ): Promise<boolean> {
    // Step 1 — cancel known algo ids.
    for (const algoId of knownAlgoIds) {
      if (algoId === null) continue;
      try {
        await this.rest.cancelAlgoOrder(algoId);
        log.info(
          { symbol: plan.symbol, algoId, signalId },
          "[BINANCE_CLEANUP_ALGO_CANCELED]",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const alreadyGone =
          (err instanceof BinanceApiError && err.code === -2013) ||
          msg.toLowerCase().includes("not exist");
        if (!alreadyGone) {
          log.error(
            { symbol: plan.symbol, algoId, signalId, err: msg },
            "[BINANCE_CLEANUP_CANCEL_FAILED]",
          );
        }
        // "-2013"/"doesn't exist" = already gone, that's success too —
        // no special handling needed, fall through either way.
      }
    }

    // Aug 2026, hardening — confirmed via a live diagnostic (real
    // Binance API, zero-risk test order) that the Algo Order system has
    // an eventual-consistency lag of a few hundred ms after BOTH create
    // AND cancel — a query issued immediately can still show a just-
    // cancelled order as resting. Give the cancels above a moment to
    // propagate before Step 2's "what's still out there" query, so it
    // doesn't misread lag as an actual orphan.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Step 2 — query + cancel ANY remaining open algo orders for this
    // symbol, regardless of whether we had a tracked id for them.
    try {
      const remaining = (await this.rest.getOpenAlgoOrders(
        plan.symbol,
      )) as Array<{ algoId: number }>;
      for (const o of remaining) {
        try {
          await this.rest.cancelAlgoOrder(o.algoId);
          log.warn(
            { symbol: plan.symbol, algoId: o.algoId, signalId },
            "[BINANCE_CLEANUP_ORPHAN_ALGO_CANCELED] found and cancelled an untracked resting algo order",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            { symbol: plan.symbol, algoId: o.algoId, signalId, err: msg },
            "[BINANCE_CLEANUP_CANCEL_FAILED]",
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol: plan.symbol, signalId, err: msg },
        "[BINANCE_CLEANUP_ALGO_QUERY_FAILED] could not enumerate open algo orders — cleanup state unknown",
      );
      return false;
    }

    // Step 3 — re-verify a fully clean final state. Retries with the
    // same propagation-lag reasoning as above: a query right after
    // Step 2's cancels can still show a just-cancelled order as
    // present. Only conclude "still not clean" if the LAST attempt
    // still shows something — an early attempt seeing stale state is
    // expected, not a real failure.
    const stillOpenPosition = await this.positionStillOpen(plan.symbol);
    let stillHasAlgoOrders: boolean | null = null;
    const verifyAttempts = 3;
    for (let attempt = 1; attempt <= verifyAttempts; attempt++) {
      try {
        const check = (await this.rest.getOpenAlgoOrders(
          plan.symbol,
        )) as unknown[];
        stillHasAlgoOrders = check.length > 0;
      } catch {
        stillHasAlgoOrders = null;
      }
      log.info(
        { symbol: plan.symbol, signalId, attempt, stillHasAlgoOrders },
        "[BINANCE_CLEANUP_VERIFY_ATTEMPT]",
      );
      if (stillHasAlgoOrders === false) {
        break; // confirmed clean — no need for further attempts
      }
      if (attempt < verifyAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (stillOpenPosition === null || stillHasAlgoOrders === null) {
      log.error(
        { symbol: plan.symbol, signalId },
        "[BINANCE_CLEANUP_VERIFICATION_UNKNOWN] final state could not be confirmed clean",
      );
      return false;
    }
    if (stillOpenPosition === true || stillHasAlgoOrders === true) {
      log.error(
        {
          symbol: plan.symbol,
          signalId,
          stillOpenPosition,
          stillHasAlgoOrders,
        },
        "[BINANCE_CLEANUP_VERIFICATION_FAILED] position or orphan algo order still present after cleanup",
      );
      return false;
    }
    log.info(
      { symbol: plan.symbol, signalId },
      "[BINANCE_CLEANUP_VERIFIED_CLEAN] no position, no resting algo orders",
    );
    return true;
  }

  private async positionStillOpen(symbol: string): Promise<boolean | null> {
    try {
      const positions = (await this.rest.getPositionRisk(symbol)) as Array<{
        symbol: string;
        positionAmt: string;
      }>;
      const pos = positions.find((p) => p.symbol === symbol);
      return pos ? Math.abs(parseFloat(pos.positionAmt)) > 0 : false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ symbol, err: msg }, "positionStillOpen query failed");
      return null; // unknown — caller treats conservatively (keeps retrying / eventually halts)
    }
  }

  private async pollForFill(
    symbol: string,
    orderId: number,
    attempts = 10,
    delayMs = 500,
  ): Promise<{
    executedQty: number;
    avgPrice: number;
    partial: boolean;
  } | null> {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = (await this.rest.getOrder(symbol, orderId)) as {
          status?: string;
          executedQty?: string;
          avgPrice?: string;
        };
        if (res.status === "FILLED") {
          return {
            executedQty: Number(res.executedQty ?? 0),
            avgPrice: Number(res.avgPrice ?? 0),
            partial: false,
          };
        }
        if (res.status === "PARTIALLY_FILLED" && i === attempts - 1) {
          // Only accept a partial fill as final on the LAST attempt —
          // earlier attempts keep waiting in case it completes to FILLED.
          return {
            executedQty: Number(res.executedQty ?? 0),
            avgPrice: Number(res.avgPrice ?? 0),
            partial: true,
          };
        }
      } catch {
        // transient query failure — keep polling until attempts exhausted
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return null;
  }

  /** Aug 2026: migrated to the Algo Order query, since this function is
   *  ONLY ever called for SL/TP verification (never for entry — entry
   *  uses pollForFill() against the regular order endpoint instead).
   *  "NEW" means still resting/untriggered (the expected state right
   *  after placement); "TRIGGERED" is also accepted — it means the
   *  order already fired, which still counts as "was successfully
   *  placed and worked", not a verification failure.
   *
   *  Aug 2026, hardening (production observation: 4/6 live SL
   *  verifications failed in one session — far too frequent to be a
   *  genuine placement problem, especially since post-failure cleanup
   *  consistently found the position/orders already clean, meaning
   *  the SL likely WAS resting and the verification query itself was
   *  the unreliable part). Two suspected causes, addressed together
   *  since we don't yet have confirmed real-API evidence for either:
   *   1. Eventual-consistency race — verifyOrderResting() was called
   *      with ZERO delay after createAlgoOrder() returned. Now retries
   *      with a short backoff instead of a single immediate check.
   *   2. Unconfirmed algoId type from the real API (never verified
   *      against production — the "NEW"/"TRIGGERED" strings and
   *      numeric algoId were inferred from documentation, not a real
   *      response). Comparison now coerces both sides to Number rather
   *      than relying on strict `===`, and every attempt logs the RAW
   *      response so the NEXT failure (if this retry fix doesn't fully
   *      resolve it) tells us exactly what Binance actually returned. */
  private async verifyOrderResting(
    symbol: string,
    orderId: number,
    attempts = 3,
    delayMs = 400,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = (await this.rest.getAlgoOrder(orderId)) as {
          algoStatus?: string;
          algoId?: number | string;
        };
        const idMatches = Number(res.algoId) === orderId;
        const statusOk =
          res.algoStatus === "NEW" || res.algoStatus === "TRIGGERED";
        log.info(
          {
            symbol,
            orderId,
            attempt,
            rawAlgoId: res.algoId,
            rawAlgoIdType: typeof res.algoId,
            rawAlgoStatus: res.algoStatus,
            idMatches,
            statusOk,
          },
          "[BINANCE_VERIFY_ORDER_RESTING_ATTEMPT]",
        );
        if (idMatches && statusOk) {
          return true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          { symbol, orderId, attempt, err: msg },
          "[BINANCE_VERIFY_ORDER_RESTING_ATTEMPT] query failed",
        );
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return false;
  }

  // ─── symbol filter cache ──────────────────────────────────────────────

  private async getSymbolFilters(
    symbol: string,
  ): Promise<SymbolFilters | null> {
    const stale =
      Date.now() - this.filterCacheLoadedAt >
      BinanceExecutionService.FILTER_CACHE_TTL_MS;
    if (!this.filterCache.has(symbol) || stale) {
      // Single in-flight refresh guard — concurrent callers await the
      // same promise instead of each triggering their own exchangeInfo
      // fetch.
      if (!this.filterCacheLoading) {
        this.filterCacheLoading = this.refreshFilterCache().finally(() => {
          this.filterCacheLoading = null;
        });
      }
      await this.filterCacheLoading;
    }
    return this.filterCache.get(symbol) ?? null;
  }

  private async refreshFilterCache(): Promise<void> {
    try {
      const info = (await this.rest.getExchangeInfo()) as {
        symbols?: Array<{
          symbol: string;
          pricePrecision?: number;
          quantityPrecision?: number;
          filters?: Array<Record<string, unknown>>;
        }>;
      };
      this.filterCache.clear();
      for (const s of info.symbols ?? []) {
        const priceFilter = s.filters?.find(
          (f) => f.filterType === "PRICE_FILTER",
        );
        const lotFilter = s.filters?.find((f) => f.filterType === "LOT_SIZE");
        const notionalFilter = s.filters?.find(
          (f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL",
        );
        this.filterCache.set(s.symbol, {
          tickSize: Number(priceFilter?.tickSize ?? 0.01),
          stepSize: Number(lotFilter?.stepSize ?? 0.001),
          minQty: Number(lotFilter?.minQty ?? 0),
          minNotional: Number(
            (notionalFilter?.notional as string | undefined) ??
              (notionalFilter?.minNotional as string | undefined) ??
              5,
          ),
          pricePrecision:
            s.pricePrecision ??
            this.decimalsFromStep(Number(priceFilter?.tickSize ?? 0.01)),
          qtyPrecision:
            s.quantityPrecision ??
            this.decimalsFromStep(Number(lotFilter?.stepSize ?? 0.001)),
        });
      }
      this.filterCacheLoadedAt = Date.now();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "failed to refresh symbol filter cache");
    }
  }

  private decimalsFromStep(step: number): number {
    if (!Number.isFinite(step) || step <= 0) return 8;
    const s = step.toString();
    const dot = s.indexOf(".");
    return dot === -1 ? 0 : s.length - dot - 1;
  }

  private roundToTick(value: number, tick: number, precision: number): number {
    if (!(tick > 0)) return Number(value.toFixed(precision));
    const rounded = Math.round(value / tick) * tick;
    return Number(rounded.toFixed(precision));
  }

  private floorToStep(value: number, step: number, precision: number): number {
    if (!(step > 0)) return Number(value.toFixed(precision));
    const floored = Math.floor(value / step) * step;
    return Number(floored.toFixed(precision));
  }
}
