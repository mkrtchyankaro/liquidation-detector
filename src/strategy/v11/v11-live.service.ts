import { childLogger } from "../../infrastructure/logging/logger";
import { getSymbolFilters, roundToStep, runEntrySequence } from "../../execution/entry-sequence";
import { ourIds, positionAmt, recoverEntry, settle, symbolClear, type SettleRest } from "../../execution/real-settle";
import { strategyClientOrderId } from "../../execution/client-order-id";
import { withSymbolLock } from "../../execution/other-trades";
import { simTrade } from "../lib/sltp";
import { estimateFeesUsd } from "../shared/fees";
import type { MinBarLoader } from "../shared/minute-loader";
import { v11RulesFor, type V11Settings } from "./v11-config";
import type { V11Source } from "./v11-data";
import { decideAt, H, tpFor, type V11Side, type V11Signal } from "./v11-engine";
import type { V11SignalDoc, V11Store, V11TradeDoc } from "./v11-repository";
import { formatV11Close, formatV11Entry, formatV11Failure, v11SignalLine, V11_HEAD } from "./v11-telegram";

const log = childLogger({ mod: "v11-live" });

/**
 * V11 LIVE -- "squeeze wick" (Johnny, Oct 12 2026). Separate from V10: own settings ("v11"), own collections
 * (v11_signals / v11_trades), own messages ("V11").
 *
 *  every minute at hh:mm:45
 *    1. once per closed 1h candle (from 90 s after the hour, at most STALE_MS late), every coin of "v11.symbols":
 *       the coin's last ~100 closed 1h bars (Binance price + Binance OI + our liquidations) -> v11-engine decideAt
 *       (= the research test's rules, checked against its 112 wicks and 44 entries). A SIGNAL -> one trade per user.
 *       Each signal is handled once (unique signalId in v11_signals, across restarts).
 *    2. PAPER trades: SL / TP on our minute bars (SL first on a same-minute tie); still open at timeoutAt -> closed at
 *       that minute's close.
 *  every 15 s
 *    REAL trades: Binance position flat? -> cancel our leftovers -> exact close from Binance fills; past timeoutAt ->
 *    a reduce-only market close of our quantity.
 *
 * Prices: the signal price = the open of the entry hour (Binance 1h kline, as tested). SL = the wick's high (+ the
 * user's slBufferPct), TP = signal price - tpR x (SL - signal price) -- the SAME prices for PAPER and REAL. REAL: the size
 * is set at the executable price so the $ risk stays riskUsd; a price already at / beyond the SL or the TP -> not
 * opened. Before a REAL entry the symbol must be completely clear on that account (no position, no order, no stop) and
 * the user must not have a REAL V10 trade on it (checked under a per-(user, symbol) lock shared with V10). An entry that
 * did not finish (crash, an error after the order may have been sent) is recovered by the 15 s monitor: our SL resting
 * -> the trade is adopted; no SL -> the position is closed at market. Never unprotected. Users are independent.
 */
export interface V11UserRef {
  userId: string;
  /** OFF users are listed too (when they have Binance keys) so their earlier REAL trades are still watched */
  mode: "OFF" | "PAPER" | "REAL";
  riskUsd: number;
  /** REAL entries -- only for mode REAL */
  binanceRest: SettleRest | null;
  /** watching existing REAL trades -- whatever the mode now */
  monitorRest?: SettleRest | null;
  leverage?: number;
  marginMode?: "ISOLATED" | "CROSSED";
  telegram: { sendMessage(text: string): Promise<unknown> } | null;
}

const M = 60_000;
const RUN_OFFSET_MS = 45_000;
/** the hour's last minute rows of ours are written ~20 s after it; Binance's OI history a little later */
const READY_MS = 90_000;
/** never act on an hour more than this after it closed (Binance's OI history can come a few minutes late) */
const STALE_MS = 15 * M;
const REAL_MONITOR_MS = 15_000;
const STUCK_ENTRY_MS = 5 * M;
const MAX_CLOSE_REPORT_ATTEMPTS = 8;
const FAILSAFE_NOTE = "entry without its SL -- closed at market";
const RETRY_ALERT = 20; // x 15 s = 5 min

/** how many closed hours are loaded for one decision (72 h norm + 6 h rally + 12 h watch + 2 confirmations + margin) */
export const historyHours = (s: V11Settings): number => s.rule.normHours + s.rule.rallyHours + s.rule.watchHours + s.rule.confirmCandles + 8;

export class V11LiveService {
  private minuteTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private minuteBusy = false;
  private monitorBusy = false;
  private indexesReady = false;
  /** hour ends fully decided, and `${hourEnd}:${symbol}` decided */
  private done = new Set<number>();
  private doneSym = new Set<string>();
  /** REAL entries running right now -- the 15 s monitor never touches them */
  private entering = new Set<string>();

  constructor(
    private readonly settings: V11Settings,
    private readonly users: () => V11UserRef[],
    private readonly source: V11Source,
    private readonly loadMinutes: MinBarLoader,
    private readonly store: V11Store,
    private readonly now: () => number = Date.now,
  ) {}

  private async ensureIndexes(): Promise<boolean> {
    if (this.indexesReady) return true;
    try { await this.store.ensureIndexes(); this.indexesReady = true; }
    catch (err) { log.error({ err: err instanceof Error ? err.message : String(err) }, "[V11_INDEXES_FAILED] -- no new signals until they exist, retried every minute"); }
    return this.indexesReady;
  }

  /** the sides some user can take right now (a side nobody takes is not even computed) */
  private sides(): V11Side[] {
    const us = this.users().filter((u) => u.mode !== "OFF").map((u) => v11RulesFor(this.settings, u.userId));
    return (["SHORT", "LONG"] as const).filter((sd) => us.some((r) => (sd === "SHORT" ? r.short : r.long)));
  }

  async start(): Promise<void> {
    await this.ensureIndexes();
    const s = this.settings, r = s.rule;
    if (!s.enabled) log.warn(`[V11_MONITOR_ONLY] v11 is disabled -- no new signals; open REAL V11 trades are still watched (users: ${this.users().map((u) => u.userId).join(",") || "none"})`);
    log.warn(`[V11_READY] enabled=${s.enabled} coins=${s.symbols.length} rule: rally ${r.rallyHours}h >= ${r.rallyX}x median(${r.normHours}h), OI type ${r.oiX}x mean|dOI|(${r.oiNormHours}h), watch ${r.watchHours}h, liq >= p${Math.round(r.liqPct * 100)}, meaningful >= $${r.minLiqUsd} & ${r.minLiqX}x, confirm ${r.confirmCandles} candle(s) OI up & move < ${r.maxConfirmMovePct}% users=${this.users().map((u) => {
      const x = v11RulesFor(s, u.userId);
      return `${u.userId}:${u.mode}(${[x.short ? "S" : "", x.long ? "L" : ""].join("") || "none"},tp${x.tpR}R,$${x.riskUsd ?? u.riskUsd},types ${x.rallyTypes.join("/")}${x.meaningfulOnly ? ",meaningful" : ""}${x.slBufferPct ? `,buf${x.slBufferPct}%` : ""}${x.minRiskPct !== null ? `,risk>=${x.minRiskPct}%` : ""}${x.maxRiskPct !== null ? `,risk<=${x.maxRiskPct}%` : ""}${x.maxOpen !== null ? `,max${x.maxOpen}` : ""},timeout ${x.timeoutHours ?? "none"}h)`;
    }).join(" ") || "(none)"}`);
    const tick = (): void => {
      const now = this.now();
      const next = Math.floor(now / M) * M + M + RUN_OFFSET_MS;
      this.minuteTimer = setTimeout(() => { void this.onMinute().finally(tick); }, Math.max(1_000, next - now));
    };
    tick();
    this.monitorTimer = setInterval(() => void this.monitorReal(), REAL_MONITOR_MS);
  }

  stop(): void {
    if (this.minuteTimer) clearTimeout(this.minuteTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.minuteTimer = this.monitorTimer = null;
  }

  /** One round (public for tests). Signals and PAPER exits are isolated from each other. */
  async onMinute(): Promise<void> {
    if (this.minuteBusy) return;
    this.minuteBusy = true;
    try {
      try { if (this.settings.enabled && await this.ensureIndexes()) await this.checkSignals(); }
      catch (err) { log.error({ err: err instanceof Error ? err.message : String(err) }, "[V11_SIGNAL_FAILED] -- retried next minute"); }
      try { await this.monitorPaper(); }
      catch (err) { log.error({ err: err instanceof Error ? err.message : String(err) }, "[V11_PAPER_MONITOR_FAILED] -- retried next minute"); }
    } finally {
      this.minuteBusy = false;
    }
  }

  // ── 1. signals ───────────────────────────────────────────────────────────────────────────────────────────────
  private async checkSignals(): Promise<void> {
    const s = this.settings, now = this.now(), end = Math.floor(now / H) * H;
    if (now - end < READY_MS || now - end > STALE_MS || this.done.has(end)) return;
    const sides = this.sides();
    const finish = (): void => {
      this.done.add(end);
      if (this.done.size > 100) this.done = new Set([...this.done].slice(-50));
      if (this.doneSym.size > 5000) this.doneSym = new Set([...this.doneSym].slice(-2500));
    };
    if (!sides.length) return finish();
    const lastCall = now - end >= STALE_MS - M;   // the last minute this hour is tried
    let pending = 0;
    for (const sym of s.symbols) {
      const key = `${end}:${sym}`;
      if (this.doneSym.has(key)) continue;
      try {
        const n = historyHours(s);
        const bars = await this.source.bars(sym, end - n * H, end);
        const i = bars.length - 1;
        if (!bars[i]) {
          if (!lastCall) { pending++; continue; }   // Binance's OI point or our data not there yet -> next minute
          log.warn({ symbol: sym, hourEnd: new Date(end).toISOString() }, "[V11_DATA_MISSING] -- the last hour is incomplete (price / Binance OI); no V11 decision for this coin this hour");
          this.doneSym.add(key);
          continue;
        }
        for (const side of sides) {
          for (const d of decideAt(bars, i, side, s.rule)) {
            if (d.kind === "WICK") log.info({ symbol: sym, side, wick: new Date(d.wick.t).toISOString(), high: d.wick.h, low: d.wick.l, liqUsd: Math.round(d.wick.liqUsd), p85: Math.round(d.wick.liqNorm), meaningful: d.wick.meaningful, rally: d.wick.rally.type }, "[V11_WICK] -- waiting for the confirmation");
            else if (d.kind === "CANCELLED") log.info({ symbol: sym, side, wick: new Date(d.wick.t).toISOString(), why: d.why }, "[V11_WICK_CANCELLED]");
            else if (d.kind === "EXPIRED") log.info({ symbol: sym, side, wick: new Date(d.wick.t).toISOString() }, "[V11_WICK_NOT_CONFIRMED]");
            else await this.onSignal(sym, d.signal, now);
          }
        }
        this.doneSym.add(key);
      } catch (err) {
        pending++;
        log.error({ symbol: sym, err: err instanceof Error ? err.message : String(err) }, "[V11_COIN_FAILED] -- this coin retried next minute");
      }
    }
    if (pending === 0) finish();
  }

  private async onSignal(symbol: string, x: V11Signal, now: number): Promise<void> {
    // the signal price: the entry hour's open (as tested) -- the candle that just started
    const price = await this.source.hourOpen(symbol, x.entryT);
    if (price === null) throw new Error(`the ${new Date(x.entryT).toISOString()} candle's open is not known yet`);
    const signalId = `v11-${new Date(x.entryT).toISOString().slice(0, 16)}-${symbol.replace(/USDT$/, "")}-${x.side}`;
    const sig: V11SignalDoc = { signalId, symbol, side: x.side, wick: x.wick, confirm: x.confirm, entryT: x.entryT, price, stop: x.stop, createdAt: new Date(now) };
    if (!(await this.store.insertSignal(sig))) return;   // already handled (restart); a DB error throws -> retried
    log.warn({ signalId, line: v11SignalLine(sig) }, "[V11_SIGNAL]");
    await Promise.all(this.users().map((u) => this.openTrade(u, sig).catch((err) =>
      log.error({ userId: u.userId, signalId, err: err instanceof Error ? err.message : String(err) }, "[V11_OPEN_TRADE_UNEXPECTED] -- isolated"))));
  }

  /** the user's levels for a signal (the same for PAPER and REAL) */
  static levels(sig: Pick<V11SignalDoc, "side" | "price" | "stop">, slBufferPct: number, tpR: number): { sl: number; tp: number; riskPct: number } {
    const d = sig.side === "SHORT" ? 1 : -1;
    const sl = sig.stop * (1 + (d * slBufferPct) / 100);
    const tp = tpFor(sig.price, sl, tpR);
    return { sl, tp, riskPct: (100 * d * (sl - sig.price)) / sig.price };
  }

  private async openTrade(u: V11UserRef, sig: V11SignalDoc): Promise<void> {
    if (u.mode === "OFF") return;
    const r = v11RulesFor(this.settings, u.userId);
    if (sig.side === "SHORT" ? !r.short : !r.long) return;
    const riskUsd = r.riskUsd ?? u.riskUsd;
    const lv = V11LiveService.levels(sig, r.slBufferPct, r.tpR);
    const base: V11TradeDoc = {
      tradeId: `${sig.signalId}:${u.userId}`, orderSignalId: sig.signalId, signalId: sig.signalId, userId: u.userId, mode: u.mode,
      symbol: sig.symbol, side: sig.side, state: "OPEN", createdAt: sig.entryT, entryPrice: null, slPrice: lv.sl, tpPrice: null, tpTarget: lv.tp, tpR: r.tpR, riskPct: lv.riskPct,
      quantity: null, plannedRiskUsd: riskUsd, actualRiskUsd: null, binance: null,
      closedAt: null, exitPrice: null, pnlUsd: null, pnlR: null, feesUsd: null, closeReason: null, failureReason: null, closeAttempts: 0, entryInProgress: true, entryStartedAt: null,
      rallyType: sig.wick.rally.type, meaningful: sig.wick.meaningful,
      ...(r.timeoutHours !== null ? { timeoutAt: sig.entryT + r.timeoutHours * H } : {}),
    };
    const skip = async (reason: string, tell: boolean, state: "SKIPPED" | "FAILED" = "SKIPPED"): Promise<void> => {
      const t = { ...base, state, failureReason: reason, entryInProgress: false };
      if (!(await this.store.insertTrade(t))) await this.store.updateTrade(base.tradeId, { state, failureReason: reason, entryInProgress: false });
      log.warn({ userId: u.userId, tradeId: base.tradeId, reason }, `[V11_TRADE_${state}]`);
      if (tell) await this.notify(u, formatV11Failure(t));
    };

    // this user's filters (silent: the user chose them)
    if (!r.rallyTypes.includes(sig.wick.rally.type)) return skip(`rally type ${sig.wick.rally.type} is not in rallyTypes (${r.rallyTypes.join(", ")})`, false);
    if (r.meaningfulOnly && !sig.wick.meaningful) return skip(`the wick's liquidations ($${Math.round(sig.wick.liqUsd)}) are not "meaningful" -- meaningfulOnly`, false);
    if (!(sig.price > 0) || !(lv.riskPct > 0) || !(sig.side === "SHORT" ? lv.tp > 0 : true))
      return skip(`bad levels: price ${sig.price}, SL ${lv.sl}, TP ${lv.tp} (the hour opened beyond the wick?)`, true, "FAILED");
    if (r.minRiskPct !== null && lv.riskPct < r.minRiskPct) return skip(`the SL is only ${lv.riskPct.toFixed(2)}% away (< minRiskPct ${r.minRiskPct}%)`, false);
    if (r.maxRiskPct !== null && lv.riskPct > r.maxRiskPct) return skip(`the SL is ${lv.riskPct.toFixed(2)}% away (> maxRiskPct ${r.maxRiskPct}%)`, false);

    const open = await this.store.findOpenTrades();
    if (open.some((t) => t.userId === u.userId && t.symbol === sig.symbol)) return skip(`a V11 trade on ${sig.symbol} is already open for this user`, false);
    if (r.maxOpen !== null) {
      const mine = open.filter((t) => t.userId === u.userId);
      if (mine.length >= r.maxOpen) return skip(`MAX_OPEN: ${mine.length} V11 trades already open (${mine.map((t) => `${t.symbol} ${t.side}`).join(", ")}), limit ${r.maxOpen}`, true);
    }
    const short = sig.side === "SHORT";

    if (u.mode === "PAPER") {
      const t: V11TradeDoc = { ...base, entryPrice: sig.price, tpPrice: lv.tp, quantity: riskUsd / Math.abs(sig.price - lv.sl), actualRiskUsd: riskUsd, entryInProgress: false };
      if (!(await this.store.insertTrade(t))) return;
      log.warn({ tradeId: t.tradeId, entry: sig.price, sl: lv.sl, tp: lv.tp }, "[V11_PAPER_ENTRY]");
      await this.notify(u, formatV11Entry(sig, t));
      return;
    }

    // REAL
    const rest = u.binanceRest;
    if (u.mode !== "REAL" || !rest) return;   // not REAL-capable (main.ts downgrades such users to PAPER)
    if (this.now() - sig.entryT > STALE_MS) return skip("signal too old for a market entry", true);
    const prep = await withSymbolLock(u.userId, sig.symbol, async (): Promise<{ row: V11TradeDoc; exec: number } | null> => {
      if (await this.store.hasOpenOtherTrade(u.userId, sig.symbol)) { await skip(`a REAL V10 trade on ${sig.symbol} is open for this user -- V11 never trades on top of it`, true); return null; }
      const busy = await symbolClear(rest, sig.symbol);
      if (busy) { await skip(`${busy} -- V11 never trades on top of it`, true); return null; }
      const book = (await rest.getBookTicker?.(sig.symbol).catch(() => null)) as { bidPrice?: string; askPrice?: string } | null;
      const exec = Number(short ? book?.bidPrice : book?.askPrice);
      if (!(exec > 0)) { await skip("no executable price from Binance", true); return null; }
      if (short ? exec >= lv.sl : exec <= lv.sl) { await skip(`the price already reached the SL: now ${exec}, signal ${sig.price}, SL ${+lv.sl.toPrecision(8)} -- the signal is over`, true); return null; }
      if (short ? exec <= lv.tp : exec >= lv.tp) { await skip(`the price already reached the TP: now ${exec}, signal ${sig.price}, TP ${+lv.tp.toPrecision(8)} -- too late`, true); return null; }
      const row: V11TradeDoc = { ...base, entryStartedAt: this.now() };
      if (!(await this.store.insertTrade(row))) return null;   // already handled for this user
      this.entering.add(row.tradeId);
      return { row, exec };
    });
    if (!prep) return;
    const { row, exec } = prep;
    try {
      const out = await runEntrySequence(rest, {
        userId: u.userId, globalSignalId: sig.signalId, symbol: sig.symbol, side: sig.side,
        quantity: riskUsd / Math.abs(exec - lv.sl), entryPriceEstimate: exec,
        slPrice: lv.sl, initialTpPrice: lv.tp,
        riskUsd, leverage: u.leverage, marginMode: u.marginMode,
      });
      if (out.outcome === "ENTRY_FAILED" || out.outcome === "PROTECTION_FAILED_CLOSED") {
        // never trusted blindly: the order may have filled although the call failed. The 15 s monitor looks up OUR
        // entry order on Binance and decides: not opened -> failed (+ message) / filled -> protected or closed.
        await this.store.updateTrade(row.tradeId, { failureReason: out.reason });
        log.error({ tradeId: row.tradeId, reason: out.reason, outcome: out.outcome }, "[V11_ENTRY_NOT_CONFIRMED] -- handed to the recovery");
        return;
      }
      const binance: V11TradeDoc["binance"] = {
        entryClientOrderId: out.entryClientOrderId, slAlgoId: out.slBinanceAlgoId, slClientAlgoId: out.slClientAlgoId,
        ...(out.outcome === "ENTRY_ACTIVE_WITH_TP" ? { tpOrderId: out.tpBinanceOrderId, tpClientOrderId: out.tpClientOrderId } : { tpFailureReason: out.tpFailureReason }),
      };
      const fields: Partial<V11TradeDoc> = { entryPrice: out.entryPrice, quantity: out.quantity, tpPrice: out.tpPrice ?? null, actualRiskUsd: out.actualRiskUsd ?? null, binance, entryInProgress: false };
      await this.store.updateTrade(row.tradeId, fields);
      log.warn({ tradeId: row.tradeId, ...fields }, "[V11_REAL_ENTRY]");
      await this.notify(u, formatV11Entry(sig, { ...row, ...fields } as V11TradeDoc));
    } finally {
      this.entering.delete(row.tradeId);
    }
  }

  // ── 2. PAPER exits ───────────────────────────────────────────────────────────────────────────────────────────
  private async monitorPaper(): Promise<void> {
    const now = this.now();
    const open = (await this.store.findOpenTrades()).filter((t) => t.mode === "PAPER" && !t.entryInProgress && t.entryPrice !== null && t.tpPrice !== null && t.slPrice !== null && t.quantity !== null);
    const bySymbol = new Map<string, V11TradeDoc[]>();
    for (const t of open) bySymbol.set(t.symbol, [...(bySymbol.get(t.symbol) ?? []), t]);
    for (const [symbol, list] of bySymbol) {
      const from = Math.min(...list.map((t) => t.createdAt));
      const bars = (await this.loadMinutes(symbol, from, now)).filter((b) => b.t + M <= now); // closed minutes only
      for (const t of list) {
        const entry = t.entryPrice!, risk = Math.abs(entry - t.slPrice!), rr = Math.abs(t.tpPrice! - entry) / risk;
        const deadline = t.timeoutAt ?? Infinity;
        const use = deadline < Infinity ? bars.filter((b) => b.t < deadline) : bars;
        const tr = simTrade(use, t.createdAt, entry, t.slPrice!, rr, t.side === "SHORT" ? "DOWN" : "UP");
        const fees = estimateFeesUsd(entry * t.quantity!), riskUsd = t.actualRiskUsd ?? t.plannedRiskUsd;
        if (tr.exit === "OPEN") {
          const lastBar = use[use.length - 1] ?? (now >= deadline + 5 * M ? bars[bars.length - 1] : undefined);
          if (deadline < Infinity && lastBar && (lastBar.t + M >= deadline || now >= deadline + 5 * M)) {
            const sg = t.side === "LONG" ? 1 : -1;
            const pnlUsd = sg * (lastBar.close - entry) * t.quantity! - fees.sl;
            await this.closeTrade(t, { closedAt: Math.min(deadline, lastBar.t + M), exitPrice: lastBar.close, pnlUsd, pnlR: pnlUsd / riskUsd, feesUsd: fees.sl, closeReason: "TIMEOUT_CLOSED" });
          }
          continue;
        }
        const feesUsd = tr.exit === "TP" ? fees.tp : fees.sl;
        const pnlUsd = (tr.exit === "TP" ? rr * riskUsd : -riskUsd) - feesUsd;
        await this.closeTrade(t, { closedAt: tr.exitT, exitPrice: tr.exit === "TP" ? t.tpPrice : t.slPrice, pnlUsd, pnlR: pnlUsd / riskUsd, feesUsd, closeReason: tr.exit === "TP" ? "TP_FILLED" : "SL_FILLED" });
      }
    }
  }

  // ── 3. REAL exits ────────────────────────────────────────────────────────────────────────────────────────────
  /** Public for tests. */
  async monitorReal(): Promise<void> {
    if (this.monitorBusy) return;
    this.monitorBusy = true;
    try {
      const users = new Map(this.users().map((u) => [u.userId, u]));
      for (const t of await this.store.findOpenTrades()) {
        if (t.mode !== "REAL" || this.entering.has(t.tradeId)) continue;
        const u = users.get(t.userId);
        const rest = u?.binanceRest ?? u?.monitorRest ?? null;
        if (!u || !rest) {
          log.error({ tradeId: t.tradeId, userId: t.userId }, "[V11_REAL_UNWATCHED] -- no Binance client for this user; check the trade on Binance");
          continue;
        }
        try {
          if (t.entryInProgress) {
            // not running in this process: after a failed call at once, after a crash / restart once it is surely over
            if (t.failureReason !== null || this.now() - (t.entryStartedAt ?? t.createdAt) >= STUCK_ENTRY_MS) await this.recover(t, u, rest);
            continue;
          }
          await this.checkRealTrade(t, u, rest);
        } catch (err) {
          log.error({ tradeId: t.tradeId, err: err instanceof Error ? err.message : String(err) }, "[V11_REAL_MONITOR_FAILED] -- retried next cycle");
        }
      }
    } finally {
      this.monitorBusy = false;
    }
  }

  /** an entry that did not finish normally -- decided from OUR entry order on Binance (see recoverEntry) */
  private async recover(t: V11TradeDoc, u: V11UserRef, rest: SettleRest): Promise<void> {
    const r = await recoverEntry(rest, { userId: t.userId, orderSignalId: t.orderSignalId, symbol: t.symbol, side: t.side, binance: t.binance });
    const head = `⚠️ ${V11_HEAD} · ${t.symbol} · ${t.side} · REAL`;
    if (r.status === "RETRY") return this.retried(t, u, `recovery: ${r.why}`);
    if (t.retries) await this.store.updateTrade(t.tradeId, { retries: 0 });
    if (r.status === "NOT_OPENED") {
      const reason = t.failureReason ?? "entry never completed";
      await this.store.updateTrade(t.tradeId, { state: "FAILED", failureReason: reason, entryInProgress: false });
      log.warn({ tradeId: t.tradeId, reason }, "[V11_TRADE_FAILED]");
      await this.notify(u, formatV11Failure({ ...t, state: "FAILED", failureReason: reason }));
      return;
    }
    if (r.status === "DONE") {
      await this.store.updateTrade(t.tradeId, { entryInProgress: false, entryPrice: r.entryPrice, quantity: r.quantity });
      log.warn({ tradeId: t.tradeId }, "[V11_RECOVERY_DONE] -- settled next cycle");
      return;
    }
    if (r.status === "ADOPTED") {
      let tpOrderId = r.tpOrderId, tpPrice: number | null = null;
      if (tpOrderId === null) ({ tpOrderId, tpPrice } = await this.placeTp(t, rest, r.quantity));
      const binance = { ...(t.binance ?? {}), slAlgoId: r.slAlgoId, ...(tpOrderId !== null ? { tpOrderId } : {}) };
      await this.store.updateTrade(t.tradeId, { entryPrice: r.entryPrice, quantity: r.quantity, entryInProgress: false, binance, failureReason: null, ...(tpPrice !== null ? { tpPrice } : {}) });
      log.warn({ tradeId: t.tradeId, binance }, "[V11_RECOVERY_ADOPTED]");
      await this.notify(u, `${head}\nThe entry did not finish normally${t.failureReason ? ` (${t.failureReason})` : ""}, but it is open on Binance with its SL resting -- the bot follows it as a normal trade${tpOrderId === null ? " (no TP: it closes at the SL or by hand)" : ""}.\n🆔 ${t.orderSignalId}`);
      return;
    }
    await this.store.updateTrade(t.tradeId, { entryInProgress: false, entryPrice: r.entryPrice, quantity: r.quantity, binance: null, failureReason: `${FAILSAFE_NOTE}${t.failureReason ? ` (${t.failureReason})` : ""}` });
    log.error({ tradeId: t.tradeId, quantity: r.quantity }, "[V11_RECOVERY_CLOSED_UNPROTECTED]");
    await this.notify(u, `${head}\nThe entry filled on Binance but its SL was not there -- the position was closed at market. The close report follows.\n🆔 ${t.orderSignalId}`);
  }

  /** an adopted trade without its TP: the planned TP price is placed (reduce-only LIMIT, our deterministic client id) */
  private async placeTp(t: V11TradeDoc, rest: SettleRest, qty: number): Promise<{ tpOrderId: number | null; tpPrice: number | null }> {
    try {
      const f = await getSymbolFilters(rest, t.symbol);
      if (!f) return { tpOrderId: null, tpPrice: null };
      const tp = roundToStep(t.tpTarget, f.tickSize, f.pricePrecision);
      const res = (await rest.createOrder({
        symbol: t.symbol, side: t.side === "LONG" ? "SELL" : "BUY", type: "LIMIT", timeInForce: "GTC", price: tp.toFixed(f.pricePrecision),
        quantity: qty.toFixed(f.qtyPrecision), reduceOnly: "true", newClientOrderId: ourIds(t.userId, t.orderSignalId).tp,
      })) as { orderId?: number };
      return { tpOrderId: Number(res?.orderId) > 0 ? Number(res.orderId) : null, tpPrice: tp };
    } catch (err) {
      log.error({ tradeId: t.tradeId, err: err instanceof Error ? err.message : String(err) }, "[V11_TP_PLACE_FAILED] -- the trade stays under its SL");
      return { tpOrderId: null, tpPrice: null };
    }
  }

  /** a REAL trade that keeps failing to be read / settled: logged every time, the user told once after ~5 min IN A ROW */
  private async retried(t: V11TradeDoc, u: V11UserRef, why: string): Promise<void> {
    const n = (t.retries ?? 0) + 1;
    await this.store.updateTrade(t.tradeId, { retries: n });
    t.retries = n;
    log.warn({ tradeId: t.tradeId, why, retries: n }, "[V11_REAL_RETRY]");
    if (n === RETRY_ALERT) await this.notify(u, `⚠️ ${V11_HEAD} · ${t.symbol} · ${t.side} · REAL\nThe bot cannot settle this trade for ~5 min: ${why}\nPlease look at ${t.symbol} on Binance.\n🆔 ${t.orderSignalId}`);
  }

  /** past its timeout -> a reduce-only MARKET close of what is left of OUR position (the same as V10 · WALL).
   *  Deterministic client ids (MARKET_EXIT revision 0..4): after a crash they are found, never sent twice.
   *  false = do not settle this cycle (retried next cycle). */
  private async timeoutClose(t: V11TradeDoc, u: V11UserRef, rest: SettleRest): Promise<boolean> {
    const ids = [0, 1, 2, 3, 4].map((r) => strategyClientOrderId(t.userId, t.orderSignalId, "MARKET_EXIT", r));
    const find = async (id: string): Promise<{ status?: string; executedQty?: string | number } | null> => {
      try { return (await rest.getOrderByClientId(t.symbol, id)) as { status?: string; executedQty?: string | number }; }
      catch (err) { if (/-2013|does not exist|not found|-2011/i.test(err instanceof Error ? err.message : String(err))) return null; throw err; }
    };
    const mark = async (): Promise<void> => {
      if (t.timeoutSentAt) return;
      const now = this.now();
      await this.store.updateTrade(t.tradeId, { timeoutSentAt: now });
      t.timeoutSentAt = now;
    };
    let ours: Array<{ status?: string; executedQty?: string | number }>, amt: number;
    try {
      ours = [];
      for (const id of ids) { const o = await find(id); if (!o) break; ours.push(o); }
      amt = await positionAmt(rest, t.symbol);
    } catch (err) {
      await this.retried(t, u, `timeout close: Binance unreadable (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
    if (ours.some((o) => Number(o.executedQty) > 0)) await mark();
    const mine = amt !== 0 && Math.sign(amt) === (t.side === "LONG" ? 1 : -1);
    if (!mine) return true;
    if (ours.some((o) => o.status === "NEW" || o.status === "PARTIALLY_FILLED")) return false;
    if (ours.length >= ids.length) { await this.retried(t, u, `timeout close: ${ids.length} market closes sent, the ${t.symbol} position (${amt}) is still there`); return false; }
    if (t.quantity !== null && Math.abs(amt) > t.quantity * 1.001) { await this.retried(t, u, `timeout close: the ${t.symbol} position (${amt}) is bigger than ours (${t.quantity}) -- nothing touched`); return false; }
    const f = await getSymbolFilters(rest, t.symbol);
    if (!f) { await this.retried(t, u, "timeout close: symbol filters unreadable"); return false; }
    const qty = Math.min(Math.abs(amt), t.quantity ?? Math.abs(amt)), id = ids[ours.length];
    await rest.createOrder({ symbol: t.symbol, side: t.side === "LONG" ? "SELL" : "BUY", type: "MARKET", quantity: qty.toFixed(f.qtyPrecision), reduceOnly: "true", newClientOrderId: id });
    log.warn({ tradeId: t.tradeId, quantity: qty, revision: ours.length }, "[V11_TIMEOUT_CLOSE_SENT]");
    const o = await find(id).catch(() => null);
    if (o && Number(o.executedQty) > 0) await mark();
    return true;
  }

  private async checkRealTrade(t: V11TradeDoc, u: V11UserRef, rest: SettleRest): Promise<void> {
    if (t.timeoutAt !== undefined && t.entryPrice !== null && this.now() >= t.timeoutAt) {
      if (!(await this.timeoutClose(t, u, rest))) return;
    }
    const other = await this.store.openOtherTradeSince(t.userId, t.symbol, t.entryStartedAt ?? t.createdAt);
    const r = await settle(rest, { userId: t.userId, orderSignalId: t.orderSignalId, symbol: t.symbol, side: t.side, entryStartedAt: t.entryStartedAt ?? t.createdAt, quantity: t.quantity, binance: t.binance }, this.now(), other);
    if (r.status === "RETRY") return this.retried(t, u, r.why);
    if (t.retries) await this.store.updateTrade(t.tradeId, { retries: 0 });
    if (r.status === "OPEN") return;
    if (r.status === "NO_FILLS") {
      if (t.entryPrice === null && this.now() - t.createdAt >= STUCK_ENTRY_MS) {
        await this.store.updateTrade(t.tradeId, { state: "FAILED", failureReason: "entry never completed (no fill found)", entryInProgress: false });
        return;
      }
      const attempts = t.closeAttempts + 1;
      if (attempts < MAX_CLOSE_REPORT_ATTEMPTS) { await this.store.updateTrade(t.tradeId, { closeAttempts: attempts }); return; }
      await this.closeTrade(t, { closedAt: this.now(), exitPrice: null, pnlUsd: null, pnlR: null, feesUsd: null, closeReason: "CLOSED_NO_FILLS_FOUND" }, u);
      return;
    }
    const risk = t.actualRiskUsd ?? t.plannedRiskUsd;
    const failsafe = r.report.reason === "POSITION_CLOSED_EXTERNALLY" && t.failureReason !== null;
    const timedOut = r.report.reason === "POSITION_CLOSED_EXTERNALLY" && t.timeoutSentAt !== undefined;
    await this.closeTrade(t, {
      closedAt: this.now(), exitPrice: r.report.exitPrice, pnlUsd: r.report.realizedPnlUsd,
      pnlR: risk > 0 ? r.report.realizedPnlUsd / risk : null, feesUsd: r.report.feesUsd, closeReason: timedOut ? "TIMEOUT_CLOSED" : failsafe ? "FAILSAFE_CLOSED" : r.report.reason,
    }, u);
  }

  private async closeTrade(t: V11TradeDoc, c: Pick<V11TradeDoc, "closedAt" | "exitPrice" | "pnlUsd" | "pnlR" | "feesUsd" | "closeReason">, user?: V11UserRef): Promise<void> {
    await this.store.updateTrade(t.tradeId, { state: "CLOSED", entryInProgress: false, ...c });
    log.warn({ tradeId: t.tradeId, ...c }, "[V11_TRADE_CLOSED]");
    const u = user ?? this.users().find((x) => x.userId === t.userId);
    if (u) await this.notify(u, formatV11Close({ ...t, state: "CLOSED", ...c }));
  }

  private async notify(u: V11UserRef, text: string): Promise<void> {
    if (!u.telegram) return;
    try { await u.telegram.sendMessage(text); } catch (err) {
      log.error({ userId: u.userId, err: err instanceof Error ? err.message : String(err) }, "[V11_TELEGRAM_FAILED] -- isolated");
    }
  }
}
