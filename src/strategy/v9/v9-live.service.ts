import { runEntrySequence, type BinanceRestLike } from "../../execution/entry-sequence";
import { buildRealCloseReport, type UserTradeFill } from "../../execution/close-report";
import { childLogger } from "../../infrastructure/logging/logger";
import { MINUTE_MS, type Victim } from "./v9-core";
import { DEFAULT_V9_ENGINE_SETTINGS, V9CausalEngine, type V9Decision, type V9EngineSettings } from "./v9-causal-engine";
import type { V9Settings } from "./v9-config";
import type { V9MongoFeed } from "./v9-feed";
import type { V9DecisionDoc, V9Repository, V9TradeDoc } from "./v9-repository";
import { formatV9Close, formatV9Entry, formatV9Failure } from "./v9-telegram";
import { estimateFeesUsd } from "./v9-fees";

const log = childLogger({ mod: "v9-live" });

/**
 * V9 live service.
 *
 *  every minute at hh:mm:10   poll new rows -> evaluate each symbol's engine
 *                              -> persist every decision (audit)
 *                              -> tradable decision: one trade per user
 *                              -> PAPER trades: check TP/SL on minute low/high
 *  every 15 s                  REAL trades: Binance position flat? -> cancel
 *                              leftovers, exact close report, Telegram
 *
 * Users are independent: one user's failure never affects another. Each
 * user gets their own Telegram messages; "main" (PAPER) is always told.
 */
export interface V9UserRef {
  userId: string;
  mode: "PAPER" | "REAL";
  riskUsd: number;
  binanceRest: (BinanceRestLike & { getUserTrades(symbol: string, startTime: number): Promise<unknown> }) | null;
  leverage?: number;
  marginMode?: "ISOLATED" | "CROSSED";
  telegram: { sendMessage(text: string): Promise<unknown> } | null;
}

const REAL_MONITOR_MS = 15_000;
const EVAL_OFFSET_MS = 10_000; // run at hh:mm:10 -- DB batches of the previous minute are flushed by then
const WARMUP_STEP_MS = 5 * MINUTE_MS;
const WARMUP_HISTORY_MS = 4 * 24 * 3_600_000;
const STUCK_ENTRY_MS = 5 * MINUTE_MS;
const MAX_CLOSE_REPORT_ATTEMPTS = 8;

export class V9LiveService {
  private readonly engines = new Map<string, V9CausalEngine>();
  private minuteTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private minuteBusy = false;
  private monitorBusy = false;
  private ready = false;

  constructor(
    private readonly settings: V9Settings,
    private readonly users: () => V9UserRef[],
    private readonly feed: V9MongoFeed,
    private readonly repo: V9Repository,
    private readonly engineSettings: V9EngineSettings = DEFAULT_V9_ENGINE_SETTINGS,
    private readonly now: () => number = Date.now,
  ) {
    for (const s of settings.symbols) this.engines.set(s, new V9CausalEngine(s, engineSettings));
  }

  /** Warm-up (history -> reference medians) then start both schedules.
   *  Warm-up decisions are never traded. */
  async start(): Promise<void> {
    await this.repo.ensureIndexes();
    const t0 = this.now();
    for (const [symbol, engine] of this.engines) {
      const loaded = await this.feed.warmUp(symbol, engine.store, t0 - WARMUP_HISTORY_MS);
      let decided = 0;
      for (let t = t0 - this.engineSettings.windowMs; t <= t0; t += WARMUP_STEP_MS) {
        decided += engine.evaluate(t).length;
        await new Promise((r) => setImmediate(r)); // keep the event loop (WS, LOX) responsive
      }
      log.info(`[V9_WARMUP] ${symbol} rows liq=${loaded.liq} oi=${loaded.oi} historicalDecisions=${decided}`);
    }
    // Restore which episodes were already traded (exact, from the database)
    // so a re-confirmed episode is never traded twice across restarts.
    for (const t of await this.repo.findTradesSince(t0 - this.engineSettings.windowMs)) {
      this.engines.get(t.symbol)?.markTraded(t.side, t.createdAt);
    }
    this.ready = true;
    log.warn(`[V9_READY] symbols=${[...this.engines.keys()].join(",")} rr=${this.settings.rr} users=${this.users().map((u) => `${u.userId}:${u.mode}`).join(",")}`);
    this.scheduleNextMinute();
    this.monitorTimer = setInterval(() => void this.monitorReal(), REAL_MONITOR_MS);
  }

  stop(): void {
    if (this.minuteTimer) clearTimeout(this.minuteTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.minuteTimer = this.monitorTimer = null;
  }

  private scheduleNextMinute(): void {
    const now = this.now();
    const next = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS + EVAL_OFFSET_MS;
    this.minuteTimer = setTimeout(() => {
      void this.onMinute().finally(() => this.scheduleNextMinute());
    }, Math.max(1_000, next - now));
  }

  /** One evaluation round. Public for tests and the replay harness. */
  async onMinute(): Promise<void> {
    if (!this.ready || this.minuteBusy) return;
    this.minuteBusy = true;
    try {
      const now = this.now();
      const snapshots = [];
      for (const [symbol, engine] of this.engines) {
        try {
          await this.feed.poll(symbol, engine.store);
          for (const d of engine.evaluate(now)) await this.handleDecision(d);
          if (engine.lastSnapshot?.ts === now) snapshots.push(engine.lastSnapshot);
          await this.monitorPaper(symbol, engine, now);
        } catch (err) {
          log.error({ symbol, err: err instanceof Error ? err.message : String(err) }, "[V9_SYMBOL_ROUND_FAILED] -- isolated, other symbols continue");
        }
      }
      await this.repo.insertTimeline(snapshots).catch((err) =>
        log.error({ err: err instanceof Error ? err.message : String(err) }, "[V9_TIMELINE_WRITE_FAILED] -- trading unaffected"));
    } finally {
      this.minuteBusy = false;
    }
  }

  private async handleDecision(d0: V9Decision): Promise<void> {
    const signalId = `v9-${d0.symbol}-${new Date(d0.episode.confirmTs).toISOString()}-${d0.episode.victim}`;
    // Symbol lock (decided centrally, for everyone): while ANY user still
    // has a trade open on this symbol -- REAL or PAPER, main included --
    // the previous signal's structure is not finished and no new signal may
    // be opened on the symbol, for any user, in either direction.
    let d = d0;
    if (d0.tradable) {
      const busy = (await this.repo.findOpenTrades()).filter((t) => t.symbol === d0.symbol);
      if (busy.length > 0) {
        d = { ...d0, tradable: false, reason: "SYMBOL_BUSY" as V9Decision["reason"] };
        log.warn({ signalId, openSignals: [...new Set(busy.map((t) => t.signalId))] }, "[V9_SYMBOL_BUSY] previous signal still has open trades -- new signal not opened");
      }
    }
    const doc: V9DecisionDoc = {
      signalId, symbol: d.symbol, victim: d.episode.victim, reason: d.reason, tradable: d.tradable,
      episodeStart: d.episode.start, episodeEnd: d.episode.end, confirmTs: d.episode.confirmTs, evaluatedAt: d.evaluatedAt,
      checks: d.selection.checks,
      features: { dom: d.features.dom, dir: d.features.dir, exh: d.features.exh, dirMove: d.features.dirMove, clr: d.features.clr, victimLiq: d.features.victimLiq, oppLiq: d.features.oppLiq, preEff: d.features.preEff, postEff: d.features.postEff },
      reference: d.reference,
      episode: { longUsd: d.episode.long, shortUsd: d.episode.short, oiDropPct: d.episode.oiDropPct, priceMovePct: d.episode.priceMovePct, parts: d.episode.parts },
      stopPrice: d.stopPrice, referencePrice: d.referencePrice, missingMinutes: d.missingMinutes, createdAt: new Date(),
    };
    await this.repo.insertDecision(doc);
    log.info({ signalId, reason: d.reason, checks: d.selection.checks }, "[V9_DECISION]");
    if (!d.tradable) return;
    log.warn({ signalId, side: d.tradeSide, stop: d.stopPrice, ref: d.referencePrice }, "[V9_SIGNAL]");
    await Promise.all(this.users().map((u) => this.openTrade(u, d, signalId).catch((err) =>
      log.error({ userId: u.userId, signalId, err: err instanceof Error ? err.message : String(err) }, "[V9_OPEN_TRADE_UNEXPECTED] -- isolated"))));
  }

  private async openTrade(u: V9UserRef, d: V9Decision, signalId: string): Promise<void> {
    const side: Victim = d.tradeSide;
    const long = side === "LONG";
    const base: V9TradeDoc = {
      tradeId: `${signalId}:${u.userId}`, signalId, userId: u.userId, mode: u.mode, symbol: d.symbol, side,
      state: "OPEN", createdAt: this.now(), entryPrice: null, slPrice: d.stopPrice, tpPrice: null, quantity: null,
      plannedRiskUsd: u.riskUsd, actualRiskUsd: null, rr: this.settings.rr, binance: null,
      closedAt: null, exitPrice: null, pnlUsd: null, pnlR: null, feesUsd: null, closeReason: null, failureReason: null,
      closeAttempts: 0, entryInProgress: true,
    };
    const fail = async (reason: string, state: "FAILED" | "SKIPPED" = "FAILED"): Promise<void> => {
      const t = { ...base, state, failureReason: reason, entryInProgress: false };
      await this.repo.updateTrade(base.tradeId, { state, failureReason: reason, entryInProgress: false });
      log.warn({ userId: u.userId, signalId, reason }, `[V9_TRADE_${state}]`);
      await this.notify(u, formatV9Failure(t));
    };

    // Pre-checks that need no order (both modes).
    if (u.mode === "REAL") {
      if (!u.binanceRest) return; // not REAL-capable (main.ts already downgrades such users)
      if (await this.repo.hasOpenTrade(u.userId, d.symbol)) {
        log.warn({ userId: u.userId, signalId }, "[V9_SKIP] an open V9 trade already exists on this symbol");
        return;
      }
    }
    if (!(await this.repo.insertTrade(base))) return; // this signal was already handled for this user

    if (u.mode === "PAPER") {
      const entry = d.referencePrice;
      const risk = long ? entry - d.stopPrice : d.stopPrice - entry;
      if (!(entry > 0) || !(risk > 0)) return fail(`price ${entry} already beyond SL ${d.stopPrice}`);
      const qty = u.riskUsd / risk;
      const tp = long ? entry + this.settings.rr * risk : entry - this.settings.rr * risk;
      const t: V9TradeDoc = { ...base, entryPrice: entry, tpPrice: tp, quantity: qty, actualRiskUsd: u.riskUsd, entryInProgress: false };
      await this.repo.updateTrade(base.tradeId, { entryPrice: entry, tpPrice: tp, quantity: qty, actualRiskUsd: u.riskUsd, entryInProgress: false });
      await this.notify(u, formatV9Entry(d, t));
      return;
    }

    // REAL
    const rest = u.binanceRest!;
    try {
      const pos = ((await rest.getPositionRisk(d.symbol)) as Array<{ symbol: string; positionAmt: string }>).find((p) => p.symbol === d.symbol);
      if (pos && Number(pos.positionAmt) !== 0) return fail(`an existing ${d.symbol} position (${pos.positionAmt}) is open on this account -- V9 never trades on top of it`, "SKIPPED");
    } catch (err) {
      return fail(`could not read positions: ${err instanceof Error ? err.message : String(err)}`);
    }
    const riskEst = Math.abs(d.referencePrice - d.stopPrice);
    const out = await runEntrySequence(rest, {
      userId: u.userId, globalSignalId: signalId, symbol: d.symbol, side,
      quantity: riskEst > 0 ? u.riskUsd / riskEst : 0, entryPriceEstimate: d.referencePrice,
      slPrice: d.stopPrice, initialTpPrice: d.referencePrice, tpRMultiple: this.settings.rr,
      riskUsd: u.riskUsd, leverage: u.leverage, marginMode: u.marginMode,
    });
    if (out.outcome === "ENTRY_FAILED") return fail(out.reason);
    if (out.outcome === "PROTECTION_FAILED_CLOSED") return fail(out.reason);
    const binance = {
      entryClientOrderId: out.entryClientOrderId, slAlgoId: out.slBinanceAlgoId, slClientAlgoId: out.slClientAlgoId,
      ...(out.outcome === "ENTRY_ACTIVE_WITH_TP" ? { tpOrderId: out.tpBinanceOrderId, tpClientOrderId: out.tpClientOrderId } : { tpFailureReason: out.tpFailureReason }),
    };
    const fields: Partial<V9TradeDoc> = {
      entryPrice: out.entryPrice, quantity: out.quantity, tpPrice: out.tpPrice ?? null,
      actualRiskUsd: out.actualRiskUsd ?? null, binance, entryInProgress: false,
    };
    await this.repo.updateTrade(base.tradeId, fields);
    await this.notify(u, formatV9Entry(d, { ...base, ...fields } as V9TradeDoc));
  }

  /** PAPER: first minute (after the entry minute) whose low/high crosses SL
   *  or TP decides; SL wins a same-minute tie (conservative). */
  private async monitorPaper(symbol: string, engine: V9CausalEngine, now: number): Promise<void> {
    const open = (await this.repo.findOpenTrades()).filter((t) => t.mode === "PAPER" && t.symbol === symbol && !t.entryInProgress && t.entryPrice !== null && t.tpPrice !== null && t.quantity !== null);
    for (const t of open) {
      const long = t.side === "LONG";
      for (const m of engine.store.minuteRange(t.createdAt + MINUTE_MS, now - MINUTE_MS)) {
        const hitSl = long ? m.low <= t.slPrice : m.high >= t.slPrice;
        const hitTp = long ? m.high >= t.tpPrice! : m.low <= t.tpPrice!;
        if (!hitSl && !hitTp) continue;
        const reason = hitSl ? "SL_FILLED" : "TP_FILLED";
        const exit = hitSl ? t.slPrice : t.tpPrice!;
        // Same fee model as Binance (taker entry, maker TP / taker SL) so
        // PAPER net results are comparable with REAL.
        const risk = t.actualRiskUsd ?? t.plannedRiskUsd;
        const fees = estimateFeesUsd(t.entryPrice! * t.quantity!);
        const feesUsd = hitSl ? fees.sl : fees.tp;
        const pnlUsd = (hitSl ? -risk : t.rr * risk) - feesUsd;
        await this.closeTrade(t, { closedAt: m.ts + MINUTE_MS, exitPrice: exit, pnlUsd, pnlR: pnlUsd / risk, feesUsd, closeReason: reason });
        break;
      }
    }
  }

  /** REAL: Binance is the truth. Flat position -> cancel leftovers ->
   *  exact close from our own fills. */
  private async monitorReal(): Promise<void> {
    if (!this.ready || this.monitorBusy) return;
    this.monitorBusy = true;
    try {
      const users = new Map(this.users().map((u) => [u.userId, u]));
      for (const t of await this.repo.findOpenTrades()) {
        if (t.mode !== "REAL") continue;
        const u = users.get(t.userId);
        if (!u?.binanceRest) continue;
        if (t.entryInProgress && this.now() - t.createdAt < STUCK_ENTRY_MS) continue;
        try {
          await this.checkRealTrade(t, u, u.binanceRest);
        } catch (err) {
          log.error({ tradeId: t.tradeId, err: err instanceof Error ? err.message : String(err) }, "[V9_REAL_MONITOR_FAILED] -- retried next cycle");
        }
      }
    } finally {
      this.monitorBusy = false;
    }
  }

  private async checkRealTrade(t: V9TradeDoc, u: V9UserRef, rest: NonNullable<V9UserRef["binanceRest"]>): Promise<void> {
    const pos = ((await rest.getPositionRisk(t.symbol)) as Array<{ symbol: string; positionAmt: string }>).find((p) => p.symbol === t.symbol);
    if (pos && Number(pos.positionAmt) !== 0) return; // still open
    // Flat: remove whatever of ours is still resting (reduce-only, harmless but must not linger).
    if (t.binance?.tpOrderId) await rest.cancelOrder(t.symbol, t.binance.tpOrderId).catch(() => undefined);
    let slActualOrderId: number | null = null;
    if (t.binance?.slAlgoId) {
      const stop = (await rest.getAlgoOrder(t.binance.slAlgoId).catch(() => null)) as { actualOrderId?: string | number; algoStatus?: string } | null;
      const id = Number(stop?.actualOrderId);
      if (id > 0) slActualOrderId = id;
      if (stop && (stop.algoStatus === "NEW" || stop.algoStatus === "WORKING")) await rest.cancelAlgoOrder(t.binance.slAlgoId).catch(() => undefined);
    }
    const fills = (await rest.getUserTrades(t.symbol, t.createdAt - 60_000)) as UserTradeFill[];
    const report = buildRealCloseReport({ side: t.side, fills: Array.isArray(fills) ? fills : [], sinceMs: t.createdAt - 60_000, tpOrderId: t.binance?.tpOrderId ?? null, slActualOrderId });
    if (report === null) {
      if (t.entryPrice === null && this.now() - t.createdAt >= STUCK_ENTRY_MS) {
        await this.repo.updateTrade(t.tradeId, { state: "FAILED", failureReason: "entry never completed (no fill found)", entryInProgress: false });
        return;
      }
      const attempts = t.closeAttempts + 1;
      if (attempts < MAX_CLOSE_REPORT_ATTEMPTS) { await this.repo.updateTrade(t.tradeId, { closeAttempts: attempts }); return; }
      await this.closeTrade(t, { closedAt: this.now(), exitPrice: null, pnlUsd: null, pnlR: null, feesUsd: null, closeReason: "CLOSED_NO_FILLS_FOUND" }, u);
      return;
    }
    const risk = t.actualRiskUsd ?? t.plannedRiskUsd;
    await this.closeTrade(t, {
      closedAt: this.now(), exitPrice: report.exitPrice, pnlUsd: report.realizedPnlUsd,
      pnlR: risk > 0 ? report.realizedPnlUsd / risk : null, feesUsd: report.feesUsd, closeReason: report.reason,
    }, u);
  }

  private async closeTrade(t: V9TradeDoc, c: Pick<V9TradeDoc, "closedAt" | "exitPrice" | "pnlUsd" | "pnlR" | "feesUsd" | "closeReason">, user?: V9UserRef): Promise<void> {
    await this.repo.updateTrade(t.tradeId, { state: "CLOSED", ...c });
    log.warn({ tradeId: t.tradeId, ...c }, "[V9_TRADE_CLOSED]");
    const u = user ?? this.users().find((x) => x.userId === t.userId);
    if (u) await this.notify(u, formatV9Close({ ...t, state: "CLOSED", ...c }));
  }

  private async notify(u: V9UserRef, text: string): Promise<void> {
    if (!u.telegram) return;
    try { await u.telegram.sendMessage(text); } catch (err) {
      log.error({ userId: u.userId, err: err instanceof Error ? err.message : String(err) }, "[V9_TELEGRAM_FAILED] -- isolated");
    }
  }
}
