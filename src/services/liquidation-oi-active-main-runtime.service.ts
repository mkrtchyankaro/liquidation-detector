import type { Side } from "../shared/common.types";
import { LiquidationOiGlobalSignalRepository } from "../infrastructure/mongo/liquidation-oi-global-signal.repository";
import { StrategyOrderRepository } from "../infrastructure/mongo/strategy-order.repository";
import type { LiquidationOiPositionLifecycleService } from "./liquidation-oi-position-lifecycle.service";
import type { LiquidationOiUserRuntimeRef } from "./liquidation-oi-runtime-orchestrator";
import type { LiquidationOiActiveLifecycleConfig } from "../domain/liquidation-oi-strategy/active-lifecycle-config";
import {
  isStrategyInvalidated,
  evaluateOiPriceEfficiency,
  initOiPriceEfficiencyState,
  type OiPriceEfficiencyControllerState,
} from "../domain/liquidation-oi-strategy/active-main-monitor";
import {
  evaluateDynamicExit,
  initDynamicExitState,
  type DynamicExitControllerState,
} from "../domain/liquidation-oi-strategy/dynamic-exit-controller";
import { strategyClientOrderId } from "../domain/liquidation-oi-strategy/strategy-order-identity";
import { computePaperPnl } from "../domain/liquidation-oi-strategy/pnl-calculator";
import {
  deriveOiPhysics,
  deriveOiPhysicsNotional,
  type OiPhysicsState,
} from "../domain/liquidation-oi-strategy/oi-physics";
import {
  computeCapacity,
  computeRemainingCapacity,
  projectTpFromEntry,
  DEFAULT_CAPACITY_MODEL_COEFFICIENTS_2,
} from "../domain/liquidation-oi-strategy/capacity-model";
import {
  formatCloseMessage,
  formatTpUpdateMessage,
} from "../domain/liquidation-oi-strategy/telegram-formatter";
import { sendTelegramWithRetry } from "../domain/liquidation-oi-strategy/telegram-send-retry";
import { displayNameFromUserId } from "../domain/liquidation-oi-strategy/telegram-display-format";
import type { ForensicEvent } from "../domain/liquidation-oi-strategy/forensic-events";
import type { BinanceRestLike } from "../infrastructure/binance/liquidation-oi-user-execution.service";
import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "lox-active-main" });

/**
 * Sep 17 2026 (Karo), operator-requested production-completion pass,
 * Sections J (ACTIVE MAIN monitoring: strategy invalidation + OI-price
 * efficiency) and K (dynamic TP). Reuses the EXISTING live price/OI
 * flow -- the orchestrator calls onActiveTick() from the SAME
 * bookTicker hook already driving pre-entry onTick(), never a new
 * stream. In-memory controller state (per globalSignalId) is small
 * and bounded (evicted the moment a signal leaves ACTIVE), NOT
 * persisted between restarts by design -- Section N's restart
 * recovery re-derives everything it needs from Mongo directly and
 * simply lets these controllers start fresh (NEUTRAL / no revision
 * pending) rather than trying to resurrect exact pre-restart momentum
 * state, which would be unverifiable anyway.
 */

export interface TpRevisionApplyResult {
  userId: string;
  success: boolean;
  detail: string;
}

export class LiquidationOiActiveMainRuntime {
  private readonly oiEfficiencyStates = new Map<
    string,
    OiPriceEfficiencyControllerState
  >();
  private readonly dynamicExitStates = new Map<
    string,
    DynamicExitControllerState
  >();
  /** Sep 17 2026 (Karo), operator-requested Section 9 -- throttled
   *  [LOX ACTIVE] proof-of-monitoring log, at most once per signal per
   *  this interval (never every tick). Bounded (evicted with the rest
   *  of a signal's state on close). */
  private readonly lastActiveLogAt = new Map<string, number>();
  private readonly ACTIVE_LOG_THROTTLE_MS = 15_000;
  /** Sep 19 2026 (Karo), operator-reported CRITICAL FIX -- see the
   *  doc comment right above isStrategyInvalidated's own call site
   *  below for the full incident this guards against. */
  private readonly strategyInvalidationRequested = new Set<string>();

  constructor(
    private readonly globalSignalRepo: LiquidationOiGlobalSignalRepository,
    private readonly strategyOrderRepo: StrategyOrderRepository,
    private readonly positionLifecycle: LiquidationOiPositionLifecycleService,
    private readonly getUserRuntimes: () => readonly LiquidationOiUserRuntimeRef[],
    private readonly config: LiquidationOiActiveLifecycleConfig,
    private readonly forensic: (event: ForensicEvent) => void = () => {},
  ) {}

  async onActiveTick(
    symbol: string,
    globalSignalId: string,
    episodeId: string,
    candidateSide: Side,
    currentPrice: number,
    oiQuantity: number | null,
    atr3m: number | null,
    nowMs: number,
  ): Promise<void> {
    try {
      const signal = await this.globalSignalRepo.findSignal(globalSignalId);
      if (signal === null || signal.state !== "ACTIVE") return;
      if (
        signal.strategyInvalidationPrice === null ||
        signal.initialTpPrice === null ||
        signal.entryPrice === null
      )
        return;
      const base = {
        ts: nowMs,
        symbol,
        episodeId,
        victim: signal.victim,
        state: "ACTIVE",
        episodeAgeSec: 0,
      };

      // Sep 17 2026 (Karo), operator-requested Section 9 -- throttled
      // proof-of-monitoring log. This is the direct answer to "prove
      // whether active ticks are reaching it": if this line is not
      // appearing in logs for a signal you believe is ACTIVE, ticks
      // are NOT reaching onActiveTick for it -- check the call site in
      // liquidation-oi-runtime-orchestrator.ts's onTick() instead.
      const lastLog = this.lastActiveLogAt.get(globalSignalId) ?? 0;
      if (nowMs - lastLog >= this.ACTIVE_LOG_THROTTLE_MS) {
        this.lastActiveLogAt.set(globalSignalId, nowMs);
        const userExecs =
          await this.globalSignalRepo.findUserExecutionsForSignal(
            globalSignalId,
          );
        const activePaperUsers = userExecs.filter(
          (u) => u.mode === "PAPER" && u.state === "ACTIVE",
        ).length;
        const activeRealUsers = userExecs.filter(
          (u) => u.mode === "REAL" && u.state === "ACTIVE",
        ).length;
        log.info(
          `[LOX_ACTIVE] signalId=${globalSignalId} symbol=${symbol} price=${currentPrice} tp=${signal.currentTargetPrice ?? signal.initialTpPrice} strategyInvalidation=${signal.strategyInvalidationPrice} globalState=${signal.state} activePaperUsers=${activePaperUsers} activeRealUsers=${activeRealUsers} tpRevision=${signal.tpRevision}`,
        );
      }

      // Sep 19 2026 (Karo), operator-reported CRITICAL FIX -- CONFIRMED
      // LIVE PRODUCTION INCIDENT: since Sep 19's SL-architecture
      // change made requestUserMarketExit() a no-op for REAL users on
      // this exact reason (Binance's own resting SL order is now the
      // sole mechanism for REAL -- see that function's own doc
      // comment), this check here had NOTHING left to stop it from
      // re-firing on EVERY SINGLE subsequent tick while price remains
      // beyond strategyInvalidationPrice: before that change, calling
      // requestGlobalMarketExit() here actually closed something,
      // moving state out of ACTIVE, which stopped future re-evaluation
      // naturally. For an ALL-REAL-users signal, nothing closes via
      // this path anymore (reconciliation now owns that), so this
      // check kept re-triggering forever -- confirmed live: hundreds
      // of duplicate STRATEGY_INVALIDATION/MARKET_EXIT_REQUESTED log
      // lines per minute for the SAME globalSignalId, non-stop. Fixed
      // with a simple "already requested" guard around ONLY the
      // logging/forensic/exit-request side effects -- evict()+return
      // below still run on EVERY invalidated tick as before (cheap,
      // idempotent, and correctly still skips OI-efficiency/dynamic-TP
      // processing for this tick either way).
      if (
        isStrategyInvalidated(
          candidateSide,
          currentPrice,
          signal.strategyInvalidationPrice,
        )
      ) {
        if (!this.strategyInvalidationRequested.has(globalSignalId)) {
          this.strategyInvalidationRequested.add(globalSignalId);
          this.forensic({
            ...base,
            type: "STRATEGY_INVALIDATION",
            currentPrice,
            strategyInvalidationPrice: signal.strategyInvalidationPrice,
          });
          this.forensic({
            ...base,
            type: "MARKET_EXIT_REQUESTED",
            reason: "STRATEGY_INVALIDATION",
          });
          log.warn(
            `[LOX_STRATEGY_INVALIDATION] ${symbol} globalSignalId=${globalSignalId} currentPrice=${currentPrice} strategyInvalidationPrice=${signal.strategyInvalidationPrice}`,
          );
          await this.positionLifecycle.requestGlobalMarketExit(
            globalSignalId,
            "STRATEGY_INVALIDATION",
            currentPrice,
            nowMs,
          );
        }
        this.evict(globalSignalId);
        return;
      }

      if (oiQuantity === null || atr3m === null || atr3m <= 0) return;

      const prevOiState =
        this.oiEfficiencyStates.get(globalSignalId) ??
        initOiPriceEfficiencyState();
      const oiResult = evaluateOiPriceEfficiency(
        prevOiState,
        candidateSide,
        { ts: nowMs, price: currentPrice, oiQuantity },
        atr3m,
        this.config,
      );
      this.oiEfficiencyStates.set(globalSignalId, oiResult.state);
      if (oiResult.changed) {
        this.forensic({
          ...base,
          type: "OI_PRICE_EFFICIENCY_CHANGED",
          from: prevOiState.state,
          to: oiResult.state.state,
          deltaOiPct: oiResult.deltaOiPct,
          deltaPriceAtr: oiResult.deltaPriceAtr,
          consecutiveAdverseCount: oiResult.state.consecutiveAdverseCount,
        });
      }
      if (oiResult.justConfirmedAdverse) {
        this.forensic({
          ...base,
          type: "MARKET_EXIT_REQUESTED",
          reason: "ADVERSE_OI_PRICE_EFFICIENCY_FLIP",
        });
        log.warn(
          `[LOX_ADVERSE_OI_PRICE_EFFICIENCY_FLIP] ${symbol} globalSignalId=${globalSignalId} consecutiveAdverseCount=${oiResult.state.consecutiveAdverseCount}`,
        );
        await this.positionLifecycle.requestGlobalMarketExit(
          globalSignalId,
          "ADVERSE_OI_PRICE_EFFICIENCY_FLIP",
          currentPrice,
          nowMs,
        );
        this.evict(globalSignalId);
        return;
      }

      // Sections 2/3/8: PAPER TP hit detection. Causal, same bookTicker
      // mid-price stream as every other MAIN decision (Section 15) --
      // no separate price source invented for paper. Strategy-invalidation
      // (paper SL) is ALREADY handled generically above via
      // requestGlobalMarketExit(), which fans out to every ACTIVE user
      // (paper and real alike) -- this block only needs to add the
      // per-user TP check, since TP is a per-user field even though it
      // normally tracks the SAME MAIN target for everyone.
      await this.checkPaperTpHits(
        globalSignalId,
        symbol,
        episodeId,
        candidateSide,
        currentPrice,
        nowMs,
      );

      // Sep 17 2026 (Karo), operator-approved final capacity
      // architecture, Sections 10/19-21 -- CRITICAL FIX + operator
      // semantic correction: capacity is now TOTAL (evidence-based,
      // measured from the episode's own extreme) MINUS capacity
      // ALREADY CONSUMED before entry (extreme -> entryPrice, FROZEN
      // -- computed fresh each call from frozen signal fields, never
      // stored separately, since it never changes once entry happened)
      // -- the REMAINDER is what gets projected, and ALWAYS from the
      // ORIGINAL entryPrice/atr3mAtEntry, never currentPrice. As new
      // post-entry evidence grows predictedTotalCapacityAtr, the
      // target extends -- but the ALREADY-TRAVELLED pre-entry
      // displacement is never double-counted into that extension.
      const prevTpState =
        this.dynamicExitStates.get(globalSignalId) ??
        initDynamicExitState(signal.initialTpPrice, signal.initialCapacityAtr);
      let proposedTargetPrice: number | null = null;
      let proposedRemainingCapacityAtr: number | null = null;
      if (
        (oiResult.state.state === "FAVORABLE" ||
          oiResult.state.state === "ADVERSE_CANDIDATE") &&
        signal.atr3mAtEntry !== null &&
        signal.atr3mAtEntry > 0
      ) {
        const oiPhysicsState: OiPhysicsState = {
          oiStartQuantity: null,
          oiMinQuantity: null, // not needed for the dynamic re-evaluation (destroyed/rebuilt are pre-entry-only concerns)
          oiEndQuantity: signal.episodeEndOiQuantity,
          oiNowQuantity: oiQuantity,
        };
        const derived = deriveOiPhysics(oiPhysicsState);
        const notional = deriveOiPhysicsNotional(
          derived,
          signal.extremePrice,
          signal.episodeEndPrice,
        );
        // Sep 17 2026 (Karo), operator-identified DOUBLE-COUNT FIX --
        // price evidence for predictedTotalCapacityAtr must be
        // favorablePriceMoveAtrSinceEnd (episodeEndPrice -> current),
        // NEVER the extreme-to-current distance -- that would double-
        // count against alreadyConsumedCapacityAtr (extreme -> entry)
        // below, the exact bug found in the pre-entry gate. Two
        // different reference points, kept mathematically distinct.
        const favorablePriceMoveAtrSinceEnd =
          signal.episodeEndPrice !== null
            ? (candidateSide === "LONG"
                ? currentPrice - signal.episodeEndPrice
                : signal.episodeEndPrice - currentPrice) / signal.atr3mAtEntry
            : 0;
        const newTotalCapacity = computeCapacity(
          {
            episodeLiqUsd: signal.sameDirectionLiqUsd,
            oiPhysics: notional,
            favorablePriceMoveAtrSinceEnd,
          },
          DEFAULT_CAPACITY_MODEL_COEFFICIENTS_2,
        );
        const remaining = computeRemainingCapacity(
          newTotalCapacity.predictedTotalCapacityAtr,
          candidateSide,
          signal.entryPrice,
          signal.extremePrice,
          signal.atr3mAtEntry,
        );
        proposedTargetPrice = projectTpFromEntry(
          signal.entryPrice,
          signal.atr3mAtEntry,
          candidateSide,
          remaining.predictedRemainingCapacityAtr,
        );
        proposedRemainingCapacityAtr = remaining.predictedRemainingCapacityAtr;
      }

      const exitResult = evaluateDynamicExit(
        prevTpState,
        {
          candidateSide,
          currentPrice,
          atr3m,
          oiPriceEfficiencyState: oiResult.state.state,
          proposedTargetPrice,
          proposedRemainingCapacityAtr,
          nowMs,
        },
        this.config,
      );
      if (
        exitResult.decision === "MARKET_EXIT" ||
        exitResult.decision === "HOLD"
      )
        return;

      this.dynamicExitStates.set(globalSignalId, exitResult.nextState);
      this.forensic({
        ...base,
        type: "TP_REVISION_REQUESTED",
        decision: exitResult.decision,
        reason: exitResult.reason,
        proposedTargetPrice,
      });
      log.info(
        `[LOX_TP_REVISION_REQUESTED] ${symbol} globalSignalId=${globalSignalId} decision=${exitResult.decision} newTarget=${exitResult.nextState.currentTargetPrice} revision=${exitResult.nextState.revision} reason=${exitResult.reason}`,
      );
      await this.applyTpRevision(
        signal.symbol,
        globalSignalId,
        candidateSide,
        exitResult.nextState.currentTargetPrice,
        exitResult.nextState.revision,
        nowMs,
        prevTpState.lastAcceptedCheckpointCapacityAtr,
        proposedRemainingCapacityAtr,
      );
    } catch (err) {
      log.error(
        {
          symbol,
          globalSignalId,
          err: err instanceof Error ? err.message : String(err),
        },
        "[LOX_ACTIVE_MAIN_TICK_UNEXPECTED_ERROR] -- isolated, thesis monitoring continues next tick",
      );
    }
  }

  private evict(globalSignalId: string): void {
    this.oiEfficiencyStates.delete(globalSignalId);
    this.dynamicExitStates.delete(globalSignalId);
    this.strategyInvalidationRequested.delete(globalSignalId);
  }

  /** Sections 2/3/8: causal, per-user PAPER TP hit detection, driven
   *  from the SAME live tick as every other MAIN decision. Isolated
   *  per user -- one user's TP hit never affects another's, and never
   *  touches a REAL row (REAL TP fills are detected by
   *  LiquidationOiPositionLifecycleService's own Binance-order-status
   *  polling, unchanged). */
  private async checkPaperTpHits(
    globalSignalId: string,
    symbol: string,
    episodeId: string,
    candidateSide: Side,
    currentPrice: number,
    nowMs: number,
  ): Promise<void> {
    const userExecs =
      await this.globalSignalRepo.findUserExecutionsForSignal(globalSignalId);
    const paperActive = userExecs.filter(
      (u) =>
        u.mode === "PAPER" &&
        u.state === "ACTIVE" &&
        u.entryPrice !== null &&
        u.tpPrice !== null &&
        u.quantity !== null,
    );
    for (const userExec of paperActive) {
      const tpPrice = userExec.tpPrice!;
      const hit =
        candidateSide === "LONG"
          ? currentPrice >= tpPrice
          : currentPrice <= tpPrice;
      if (!hit) continue;
      try {
        const pnl = computePaperPnl({
          side: candidateSide,
          entryPrice: userExec.entryPrice!,
          exitPrice: currentPrice,
          quantity: userExec.quantity!,
        });
        const updated = {
          ...userExec,
          state: "TERMINAL" as const,
          terminalReason: "TP_FILLED" as const,
          cleanupState: "COMPLETE" as const,
          exitPrice: currentPrice,
          grossPnlUsd: pnl.grossPnlUsd,
          priceMovePct: pnl.priceMovePct,
          updatedAt: nowMs,
        };
        // Sep 17 2026 (Karo), operator-reported CRITICAL FIX -- ATOMIC
        // compare-and-swap (see the identical fix and full explanation
        // in liquidation-oi-position-lifecycle.service.ts's own
        // requestUserMarketExit). A read-then-write idempotency check
        // is NOT sufficient against two truly overlapping ticks; the
        // filter itself must require state==="ACTIVE" in the SAME
        // atomic operation as the write.
        const won = await this.globalSignalRepo.terminalizeIfActive(updated);
        if (!won) continue;
        this.forensic({
          ts: nowMs,
          symbol,
          episodeId,
          victim: userExec.side,
          state: "TERMINAL",
          episodeAgeSec: 0,
          type: "POSITION_TERMINAL_DETECTED",
          userId: userExec.userId,
          reason: "TP_FILLED",
        } as unknown as ForensicEvent);
        log.info(
          `[LOX_PAPER_TP_HIT] userId=${userExec.userId} symbol=${symbol} entry=${userExec.entryPrice} exit=${currentPrice} tp=${tpPrice} grossPnlUsd=${pnl.grossPnlUsd.toFixed(2)}`,
        );
        const runtime = this.getUserRuntimes().find(
          (r) => r.userId === userExec.userId,
        );
        if (runtime !== undefined && runtime.telegram !== null) {
          try {
            const text = formatCloseMessage({
              symbol,
              candidateSide,
              terminalReason: "TP_FILLED",
              globalSignalId,
              terminalTimestamp: nowMs,
              entryPrice: userExec.entryPrice!,
              exitPrice: currentPrice,
              quantity: userExec.quantity,
              riskUsd: userExec.riskUsd,
              durationMs: nowMs - userExec.createdAt,
              mode: "PAPER",
              paperGrossPnlUsd: pnl.grossPnlUsd,
              displayName: displayNameFromUserId(userExec.userId),
            });
            await sendTelegramWithRetry(
              runtime.telegram,
              text,
              `PAPER_TP_CLOSE userId=${userExec.userId} symbol=${symbol}`,
            );
          } catch (err) {
            log.error(
              {
                userId: userExec.userId,
                err: err instanceof Error ? err.message : String(err),
              },
              "[LOX_TELEGRAM_PAPER_CLOSE_SEND_FAILED] -- isolated, terminal state already persisted",
            );
          }
        }
        await this.positionLifecycle.maybeCloseGlobal(globalSignalId, nowMs);
      } catch (err) {
        log.error(
          {
            userId: userExec.userId,
            symbol,
            err: err instanceof Error ? err.message : String(err),
          },
          "[LOX_PAPER_TP_HIT_UNEXPECTED_ERROR] -- isolated, other users unaffected",
        );
      }
    }
  }

  private async applyTpRevision(
    symbol: string,
    globalSignalId: string,
    candidateSide: Side,
    newTargetPrice: number,
    revision: number,
    nowMs: number,
    oldCapacityAtr: number | null,
    newCapacityAtr: number | null,
  ): Promise<TpRevisionApplyResult[]> {
    const userExecs =
      await this.globalSignalRepo.findUserExecutionsForSignal(globalSignalId);
    const results: TpRevisionApplyResult[] = [];
    for (const userExec of userExecs.filter((u) => u.state === "ACTIVE")) {
      const oldTp = userExec.tpPrice ?? newTargetPrice;
      const runtime = this.getUserRuntimes().find(
        (r) => r.userId === userExec.userId,
      );

      // Sep 17 2026 (Karo), operator-requested CRITICAL SAFETY FIX --
      // mode is checked EXPLICITLY here, never inferred from whether a
      // Binance client happens to be configured. A PAPER user (paper
      // because of THEIR OWN flag, or the GLOBAL safety fallback) may
      // still have a real, working binanceRest client on their runtime
      // -- checking only `binanceRest === null` would have silently
      // placed a REAL Binance TP order for a user who should never see
      // one. mode is the single source of truth.
      if (userExec.mode === "PAPER") {
        const updated = {
          ...userExec,
          tpPrice: newTargetPrice,
          appliedTpRevision: revision,
          updatedAt: nowMs,
        };
        await this.globalSignalRepo.upsertUserExecution(updated);
        this.forensic({
          ts: nowMs,
          symbol,
          episodeId: globalSignalId,
          victim: userExec.side,
          state: "ACTIVE",
          episodeAgeSec: 0,
          type: "TP_REVISION_APPLIED",
          userId: userExec.userId,
          revision,
          newTargetPrice,
        });
        if (
          runtime !== undefined &&
          runtime.telegram !== null &&
          userExec.entryPrice !== null
        ) {
          try {
            const text = formatTpUpdateMessage({
              symbol,
              candidateSide,
              globalSignalId,
              entryPrice: userExec.entryPrice,
              quantity: userExec.quantity ?? 0,
              oldTp,
              newTp: newTargetPrice,
              revision,
              mode: "PAPER",
              realReplaced: null,
              displayName: displayNameFromUserId(userExec.userId),
              oldCapacityAtr,
              newCapacityAtr,
            });
            await sendTelegramWithRetry(
              runtime.telegram,
              text,
              `PAPER_TP_UPDATE userId=${userExec.userId} symbol=${symbol}`,
            );
          } catch (err) {
            log.error(
              {
                userId: userExec.userId,
                err: err instanceof Error ? err.message : String(err),
              },
              "[LOX_TELEGRAM_TP_UPDATE_SEND_FAILED] -- isolated, paper TP already updated",
            );
          }
        }
        results.push({
          userId: userExec.userId,
          success: true,
          detail: "paper TP updated, no Binance call",
        });
        continue;
      }

      if (
        runtime === undefined ||
        runtime.binanceRest === null ||
        userExec.quantity === null
      ) {
        results.push({
          userId: userExec.userId,
          success: false,
          detail: "no binance client or no quantity",
        });
        continue;
      }
      try {
        const rest: BinanceRestLike = runtime.binanceRest;
        if (userExec.tpBinanceOrderId !== null) {
          try {
            await rest.cancelOrder(symbol, userExec.tpBinanceOrderId);
          } catch {
            /* already gone -- fine */
          }
          await this.strategyOrderRepo.setState(
            userExec.userId,
            globalSignalId,
            "TAKE_PROFIT",
            userExec.appliedTpRevision,
            "CANCELLED",
          );
        }
        const closeSide = candidateSide === "LONG" ? "SELL" : "BUY";
        const clientOrderId = strategyClientOrderId(
          userExec.userId,
          globalSignalId,
          "TAKE_PROFIT",
          revision,
        );
        const created = (await rest.createOrder({
          symbol,
          side: closeSide,
          type: "LIMIT",
          timeInForce: "GTC",
          quantity: String(userExec.quantity),
          price: String(newTargetPrice),
          reduceOnly: "true",
          newClientOrderId: clientOrderId,
        })) as { orderId?: number };
        const verify = (await rest.getOrder(symbol, created.orderId ?? -1)) as {
          status?: string;
        };
        if (verify.status !== "NEW" && verify.status !== "PARTIALLY_FILLED") {
          results.push({
            userId: userExec.userId,
            success: false,
            detail: `TP verification returned status=${verify.status}`,
          });
          if (runtime.telegram !== null && userExec.entryPrice !== null) {
            const text = formatTpUpdateMessage({
              symbol,
              candidateSide,
              globalSignalId,
              entryPrice: userExec.entryPrice,
              quantity: userExec.quantity ?? 0,
              oldTp,
              newTp: newTargetPrice,
              revision,
              mode: "REAL",
              realReplaced: false,
              displayName: displayNameFromUserId(userExec.userId),
              oldCapacityAtr,
              newCapacityAtr,
            });
            await sendTelegramWithRetry(
              runtime.telegram,
              text,
              `REAL_TP_UPDATE_FAILED userId=${userExec.userId} symbol=${symbol}`,
            );
          }
          continue;
        }
        await this.strategyOrderRepo.upsert({
          userId: userExec.userId,
          globalSignalId,
          symbol,
          purpose: "TAKE_PROFIT",
          revision,
          clientOrderId,
          clientAlgoId: null,
          binanceOrderId: created.orderId ?? null,
          binanceAlgoId: null,
          state: "OPEN",
        });
        await this.globalSignalRepo.upsertUserExecution({
          ...userExec,
          tpClientOrderId: clientOrderId,
          tpBinanceOrderId: created.orderId ?? null,
          tpPrice: newTargetPrice,
          appliedTpRevision: revision,
          updatedAt: nowMs,
        });
        this.forensic({
          ts: nowMs,
          symbol,
          episodeId: globalSignalId,
          victim: userExec.side,
          state: "ACTIVE",
          episodeAgeSec: 0,
          type: "TP_REVISION_APPLIED",
          userId: userExec.userId,
          revision,
          newTargetPrice,
        });
        results.push({
          userId: userExec.userId,
          success: true,
          detail: "applied",
        });
        if (runtime.telegram !== null && userExec.entryPrice !== null) {
          const text = formatTpUpdateMessage({
            symbol,
            candidateSide,
            globalSignalId,
            entryPrice: userExec.entryPrice,
            quantity: userExec.quantity ?? 0,
            oldTp,
            newTp: newTargetPrice,
            revision,
            mode: "REAL",
            realReplaced: true,
            displayName: displayNameFromUserId(userExec.userId),
            oldCapacityAtr,
            newCapacityAtr,
          });
          await sendTelegramWithRetry(
            runtime.telegram,
            text,
            `REAL_TP_UPDATE userId=${userExec.userId} symbol=${symbol}`,
          );
        }
      } catch (err) {
        log.error(
          {
            userId: userExec.userId,
            symbol,
            err: err instanceof Error ? err.message : String(err),
          },
          "[LOX_TP_REVISION_FAILED] -- this user retains their PREVIOUS TP, other users unaffected",
        );
        results.push({
          userId: userExec.userId,
          success: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const signal = await this.globalSignalRepo.findSignal(globalSignalId);
    if (signal !== null)
      await this.globalSignalRepo.upsertSignal({
        ...signal,
        currentTargetPrice: newTargetPrice,
        tpRevision: revision,
      });
    return results;
  }
}
