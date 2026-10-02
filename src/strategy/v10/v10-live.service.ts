import type { Db } from "mongodb";
import { childLogger } from "../../infrastructure/logging/logger";
import { MINUTE_BARS } from "../../collector/minute-bars";
import {
  getSymbolFilters,
  roundToStep,
  runEntrySequence,
} from "../../execution/entry-sequence";
import {
  ourIds,
  recoverEntry,
  settle,
  symbolClear,
  type SettleRest,
} from "../../execution/real-settle";
import { simTrade } from "../../research/sltp";
import type { MinBar } from "../../research/dc15";
import { estimateFeesUsd } from "../v9/v9-fees";
import { BTC, rulesFor, type V10Settings } from "./v10-config";
import {
  btcRank1At,
  lastCandleEnd,
  levels,
  ownMove,
  pickAlts,
  rank1At,
  V10_CANDLE_MS,
  V10_HISTORY_MS,
  type V10Pick,
} from "./v10-engine";
import type { V10SignalDoc, V10Store, V10TradeDoc } from "./v10-repository";
import {
  formatV10Close,
  formatV10Entry,
  formatV10Failure,
  v10Head,
} from "./v10-telegram";

const log = childLogger({ mod: "v10-live" });

/**
 * V10 LIVE -- BTC-led alts (Johnny, Oct 2 2026). Completely separate from V9: own settings ("v10"), own collections,
 * own messages. Uses the minute_bars the bot already writes (price + OI + liquidations, 1 row per symbol per minute).
 *
 *  every minute at hh:mm:45
 *    1. once per closed 15m candle (from 90 s after its close, at most 10 min late):
 *       part 1 "V10 · BTC": BTC's turn at that close (src/strategy/v10/v10-engine.ts = the research code). RANK 1 ->
 *         the picks -> one trade per (pick, user), if that user takes part 1 and this side.
 *       part 2 "V10 · ALT" (only while some user has it on): each alt's OWN turn at that close, RANK 1, moved on its own
 *         -> one trade per user on that alt. Only alts with as much history as BTC (new coins wait). Part 1 runs first,
 *         so it has the priority on a coin.
 *       Each signal is handled once (unique signalId in v10_signals, across restarts).
 *    2. PAPER trades: SL / TP on the minute high / low (SL first on a same-minute tie)
 *  every 15 s
 *    REAL trades: Binance position flat? -> cancel our leftovers -> exact close from Binance fills
 *
 * REAL entries reuse the V9 entry sequence (market entry -> SL verified, else fail-safe close -> TP). The SL / TP are
 * the SAME prices as PAPER (the configured % from the signal price); the size is set at the executable price so the $
 * risk stays riskUsd; a price already at / beyond the SL or TP -> not opened. Before a REAL entry the symbol must be
 * completely clear on that account (no position, no order, no stop) and the user must not have a REAL V9 trade open on
 * it. An entry that did not finish (crash, an error after the order may have been sent) is recovered by the 15 s
 * monitor: our SL resting -> the trade is adopted; no SL -> the position is closed at market. Never unprotected.
 * Users are independent: one user's failure never affects another.
 */
export interface V10UserRef {
  userId: string;
  /** OFF users are listed too (when they have Binance keys) so their earlier REAL trades are still watched */
  mode: "OFF" | "PAPER" | "REAL";
  riskUsd: number;
  /** REAL entries -- only for mode REAL */
  binanceRest: SettleRest | null;
  /** watching existing REAL trades -- whatever the mode now (a user switched to PAPER / OFF keeps being watched) */
  monitorRest?: SettleRest | null;
  leverage?: number;
  marginMode?: "ISOLATED" | "CROSSED";
  telegram: { sendMessage(text: string): Promise<unknown> } | null;
}

export type V10BarLoader = (
  symbol: string,
  fromTs: number,
  toTs: number,
) => Promise<MinBar[]>;

export function mongoV10Loader(getDb: () => Promise<Db | null>): V10BarLoader {
  return async (symbol, fromTs, toTs) => {
    const db = await getDb();
    if (!db) throw new Error("Mongo unavailable");
    const rows = await db
      .collection(MINUTE_BARS)
      .find({
        symbol,
        ts: { $gte: new Date(fromTs), $lt: new Date(toTs) },
        high: { $ne: null },
      })
      .project({
        _id: 0,
        ts: 1,
        high: 1,
        low: 1,
        close: 1,
        oiFirst: 1,
        oiLast: 1,
        longLiqUsd: 1,
        shortLiqUsd: 1,
      })
      .sort({ ts: 1 })
      .toArray();
    return rows.map((d) => ({
      t: new Date(d.ts).getTime(),
      high: Number(d.high),
      low: Number(d.low),
      close: Number(d.close),
      oiFirst: Number(d.oiFirst),
      oiLast: Number(d.oiLast),
      longLiq: Number(d.longLiqUsd) || 0,
      shortLiq: Number(d.shortLiqUsd) || 0,
    }));
  };
}

const M = 60_000;
const RUN_OFFSET_MS = 45_000;
const READY_MS = 90_000; // the candle's last minute bar is written ~20 s after that minute
const STALE_MS = 10 * M; // never act on a signal more than 10 min after its candle closed
const REAL_MONITOR_MS = 15_000;
const STUCK_ENTRY_MS = 5 * M;
const MAX_CLOSE_REPORT_ATTEMPTS = 8;
const ALT_LEAD_MS = 10 * M;
const ALT_WAIT_MS = 5 * M;
const OWN_HISTORY_SLACK_MS = 24 * 60 * M;
const FAILSAFE_NOTE = "entry without its SL -- closed at market";
const RETRY_ALERT = 20; // x 15 s = 5 min      // wait up to 5 min after the close for every alt's last minute     // alts' bars from a little before BTC's move start (priceAt looks back up to 6 min)

export class V10LiveService {
  private minuteTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private minuteBusy = false;
  private monitorBusy = false;
  private handled = new Set<number>();
  /** part 2: `${candleEnd}:${symbol}` already decided */
  private handledOwn = new Set<string>();
  /** REAL entries running right now -- the 15 s monitor never touches them */
  private entering = new Set<string>();
  private indexesReady = false;

  constructor(
    private readonly settings: V10Settings,
    private readonly users: () => V10UserRef[],
    private readonly load: V10BarLoader,
    private readonly store: V10Store,
    private readonly now: () => number = Date.now,
  ) {}

  private async ensureIndexes(): Promise<boolean> {
    if (this.indexesReady) return true;
    try {
      await this.store.ensureIndexes();
      this.indexesReady = true;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[V10_INDEXES_FAILED] -- no new signals until they exist, retried every minute",
      );
    }
    return this.indexesReady;
  }

  async start(): Promise<void> {
    await this.ensureIndexes();
    const s = this.settings;
    if (!s.enabled)
      log.warn(
        `[V10_MONITOR_ONLY] v10 is disabled -- no new signals; open REAL V10 trades are still watched (users: ${
          this.users()
            .map((u) => u.userId)
            .join(",") || "none"
        })`,
      );
    log.warn(
      `[V10_READY] short=${s.short} long=${s.long} sl=${s.slPct}% tp=${s.tpPct}% picks=${s.picks} rank=${s.rankWindowHours}h alts=${s.symbols.length} users=${
        this.users()
          .map((u) => {
            const r = rulesFor(s, u.userId);
            return `${u.userId}:${u.mode}(${[r.short ? "S" : "", r.long ? "L" : ""].join("") || "none"},btc:${r.btc ? `sl${r.slPct}/tp${r.tpPct}` : "off"},alt:${r.own ? `sl${r.ownSlPct}/tp${r.ownTpPct}` : "off"}${r.maxOpen ? `,max${r.maxOpen}` : ""})`;
          })
          .join(" ") || "(none)"
      }`,
    );
    const tick = (): void => {
      const now = this.now();
      const next = Math.floor(now / M) * M + M + RUN_OFFSET_MS;
      this.minuteTimer = setTimeout(
        () => {
          void this.onMinute().finally(tick);
        },
        Math.max(1_000, next - now),
      );
    };
    tick();
    this.monitorTimer = setInterval(
      () => void this.monitorReal(),
      REAL_MONITOR_MS,
    );
  }

  stop(): void {
    if (this.minuteTimer) clearTimeout(this.minuteTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.minuteTimer = this.monitorTimer = null;
  }

  /** One round (public for tests). Signal and PAPER exits are isolated from each other. */
  async onMinute(): Promise<void> {
    if (this.minuteBusy) return;
    this.minuteBusy = true;
    try {
      try {
        if (this.settings.enabled && (await this.ensureIndexes()))
          await this.checkSignal();
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[V10_SIGNAL_FAILED] -- retried next minute, V9 unaffected",
        );
      }
      try {
        await this.monitorPaper();
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[V10_PAPER_MONITOR_FAILED] -- retried next minute",
        );
      }
    } finally {
      this.minuteBusy = false;
    }
  }

  // ── 1. signal ────────────────────────────────────────────────────────────────────────────────────────────────
  private async checkSignal(): Promise<void> {
    const now = this.now(),
      end = lastCandleEnd(now);
    if (now - end < READY_MS || now - end > STALE_MS) return;
    const ownOn = this.users().some(
      (u) => u.mode !== "OFF" && rulesFor(this.settings, u.userId).own,
    );
    if (this.handled.has(end) && !ownOn) return;
    const btc = await this.load(BTC, end - V10_HISTORY_MS, end);
    const last = btc[btc.length - 1];
    if (!last || last.t < end - M) {
      // the candle's last minute is not written yet -> try again next minute (until stale)
      log.warn(
        {
          candleEnd: new Date(end).toISOString(),
          lastBar: last ? new Date(last.t).toISOString() : null,
        },
        "[V10_BTC_DATA_NOT_READY]",
      );
      return;
    }
    const btcDone =
      this.handled.has(end) || (await this.checkBtcSignal(end, now, btc));
    // part 2 only after part 1 decided this candle (part 1 has the priority on a coin)
    if (btcDone && ownOn) await this.checkOwnSignals(end, now, btc);
  }

  /** part 1 -- true when this candle is decided (signal handled or none), false = wait for data (retried next minute) */
  private async checkBtcSignal(
    end: number,
    now: number,
    btc: MinBar[],
  ): Promise<boolean> {
    const done = (): boolean => {
      this.handled.add(end);
      if (this.handled.size > 200)
        this.handled = new Set([...this.handled].slice(-100));
      return true;
    };
    const turn = btcRank1At(btc, end, this.settings.rankWindowHours);
    if (!turn) return done();
    const closes = new Map<string, Map<number, number>>();
    const late: string[] = [];
    for (const s of this.settings.symbols) {
      try {
        const bars = await this.load(s, turn.moveStartT - ALT_LEAD_MS, end);
        // late = had data in the last hour but not the candle's last minute yet (a coin without any recent data is not waited for)
        if (
          bars.length &&
          bars[bars.length - 1].t < end - M &&
          bars[bars.length - 1].t >= end - 60 * M
        )
          late.push(s);
        if (bars.length)
          closes.set(s, new Map(bars.map((b) => [b.t, b.close])));
      } catch (err) {
        late.push(s);
        log.error(
          { symbol: s, err: err instanceof Error ? err.message : String(err) },
          "[V10_ALT_LOAD_FAILED]",
        );
      }
    }
    // every alt's last minute should be there (the entry price is that minute's close); wait for it a little
    if (late.length && now - end < ALT_WAIT_MS) {
      log.warn(
        { candleEnd: new Date(end).toISOString(), late },
        "[V10_ALT_DATA_NOT_READY] -- retried next minute",
      );
      return false;
    }
    if (late.length)
      log.warn(
        { late },
        "[V10_ALT_DATA_LATE] -- proceeding; these alts use their last known price or are left out",
      );
    const picks = pickAlts(
      turn,
      new Map(btc.map((b) => [b.t, b.close])),
      closes,
      this.settings.picks,
    );
    const signalId = `v10-${new Date(end).toISOString().slice(0, 16)}-${turn.side}`;
    const sig: V10SignalDoc = {
      signalId,
      kind: "BTC",
      side: turn.side,
      symbol: BTC,
      turn,
      picks,
      rankWindowHours: this.settings.rankWindowHours,
      createdAt: new Date(now),
    };
    const fresh = await this.store.insertSignal(sig); // throws on a DB error -> not marked done, retried next minute
    done();
    if (!fresh) return true; // already handled (restart)
    log.warn(
      {
        signalId,
        side: turn.side,
        picks: picks.map((p) => `${p.symbol} x${p.x.toFixed(2)}`),
      },
      "[V10_SIGNAL]",
    );
    await this.openForAll(sig);
    return true;
  }

  /** part 2 -- each alt's own RANK 1 turn at this close, if it moved on its own. Each (candle, alt) decided once. */
  private async checkOwnSignals(
    end: number,
    now: number,
    btc: MinBar[],
  ): Promise<void> {
    const btcCloses = new Map(btc.map((b) => [b.t, b.close]));
    for (const s of this.settings.symbols) {
      const key = `${end}:${s}`;
      if (this.handledOwn.has(key)) continue;
      try {
        const bars = await this.load(s, end - V10_HISTORY_MS, end);
        // only alts with the same history as BTC (the research rule: its data starts within a day of BTC's) -- a coin
        // added recently has too few moves of its own to compare with (Oct 2: UNI, collected for 1.5 days)
        if (!bars.length || bars[0].t > btc[0].t + OWN_HISTORY_SLACK_MS) {
          this.handledOwn.add(key);
          continue;
        }
        const last = bars[bars.length - 1];
        // the alt's last minute not written yet (but it had data in the last hour) -> retried next minute, a little
        if (
          last &&
          last.t < end - M &&
          last.t >= end - 60 * M &&
          now - end < ALT_WAIT_MS
        )
          continue;
        this.handledOwn.add(key);
        if (this.handledOwn.size > 5000)
          this.handledOwn = new Set([...this.handledOwn].slice(-2500));
        const turn = rank1At(bars, end, this.settings.rankWindowHours);
        if (!turn) continue;
        const own = ownMove(
          turn,
          new Map(bars.map((b) => [b.t, b.close])),
          btcCloses,
        );
        if (!own) {
          log.info(
            { symbol: s, candleEnd: new Date(end).toISOString() },
            "[V10_ALT_TURN_WITH_BTC] -- not a part-2 signal",
          );
          continue;
        }
        const signalId = `v10alt-${new Date(end).toISOString().slice(0, 16)}-${s.replace(/USDT$/, "")}-${turn.side}`;
        const pick: V10Pick = {
          symbol: s,
          rank: 1,
          x: own.btcPct !== 0 ? own.coinPct / own.btcPct : NaN,
          follow: own.follow,
          coinPct: own.coinPct,
          btcPct: own.btcPct,
          price: turn.price,
        };
        const sig: V10SignalDoc = {
          signalId,
          kind: "OWN",
          side: turn.side,
          symbol: s,
          turn,
          own,
          picks: [pick],
          rankWindowHours: this.settings.rankWindowHours,
          createdAt: new Date(now),
        };
        if (!(await this.store.insertSignal(sig))) continue;
        log.warn(
          { signalId, side: turn.side, how: own.how, follow: own.follow },
          "[V10_ALT_SIGNAL]",
        );
        await this.openForAll(sig);
      } catch (err) {
        this.handledOwn.delete(key); // retried next minute (until the candle is stale)
        log.error(
          { symbol: s, err: err instanceof Error ? err.message : String(err) },
          "[V10_ALT_SIGNAL_FAILED] -- this alt retried next minute",
        );
      }
    }
  }

  private async openForAll(sig: V10SignalDoc): Promise<void> {
    for (const p of sig.picks) {
      await Promise.all(
        this.users().map((u) =>
          this.openTrade(u, sig, p).catch((err) =>
            log.error(
              {
                userId: u.userId,
                signalId: sig.signalId,
                symbol: p.symbol,
                err: err instanceof Error ? err.message : String(err),
              },
              "[V10_OPEN_TRADE_UNEXPECTED] -- isolated",
            ),
          ),
        ),
      );
    }
  }

  private async openTrade(
    u: V10UserRef,
    sig: V10SignalDoc,
    p: V10Pick,
  ): Promise<void> {
    if (u.mode === "OFF") return;
    const r = rulesFor(this.settings, u.userId);
    if (sig.kind === "BTC" ? !r.btc : !r.own) return; // this user does not take this part
    if (sig.side === "SHORT" ? !r.short : !r.long) return; // ... or this side
    const rules =
      sig.kind === "BTC"
        ? { ...r }
        : { ...r, slPct: r.ownSlPct, tpPct: r.ownTpPct };
    const orderSignalId = `${sig.signalId}:${p.symbol}`;
    const lv = levels(sig.side, p.price, rules.slPct, rules.tpPct);
    const base: V10TradeDoc = {
      tradeId: `${orderSignalId}:${u.userId}`,
      orderSignalId,
      signalId: sig.signalId,
      kind: sig.kind,
      userId: u.userId,
      mode: u.mode,
      symbol: p.symbol,
      side: sig.side,
      pick: {
        rank: p.rank,
        x: p.x,
        follow: p.follow,
        coinPct: p.coinPct,
        btcPct: p.btcPct,
      },
      state: "OPEN",
      createdAt: sig.turn.candleEnd,
      entryPrice: null,
      slPrice: lv.sl,
      tpPrice: null,
      slPct: rules.slPct,
      tpPct: rules.tpPct,
      quantity: null,
      plannedRiskUsd: u.riskUsd,
      actualRiskUsd: null,
      binance: null,
      closedAt: null,
      exitPrice: null,
      pnlUsd: null,
      pnlR: null,
      feesUsd: null,
      closeReason: null,
      failureReason: null,
      closeAttempts: 0,
      entryInProgress: true,
      entryStartedAt: null,
    };
    const skip = async (
      reason: string,
      tell: boolean,
      state: "SKIPPED" | "FAILED" = "SKIPPED",
    ): Promise<void> => {
      const t = {
        ...base,
        state,
        failureReason: reason,
        entryInProgress: false,
      };
      if (!(await this.store.insertTrade(t))) {
        // the row exists (it was inserted as OPEN before an order) -> mark it
        await this.store.updateTrade(base.tradeId, {
          state,
          failureReason: reason,
          entryInProgress: false,
        });
      }
      log.warn(
        { userId: u.userId, tradeId: base.tradeId, reason },
        `[V10_TRADE_${state}]`,
      );
      if (tell) await this.notify(u, formatV10Failure(t));
    };

    const open = await this.store.findOpenTrades();
    if (open.some((t) => t.userId === u.userId && t.symbol === p.symbol))
      return skip(
        `a V10 trade on ${p.symbol} is already open for this user`,
        false,
      );
    if (rules.maxOpen !== null) {
      const mine = open.filter((t) => t.userId === u.userId);
      if (mine.length >= rules.maxOpen)
        return skip(
          `MAX_OPEN: ${mine.length} V10 trades already open (${mine.map((t) => `${t.symbol} ${t.side}`).join(", ")}), limit ${rules.maxOpen}`,
          true,
        );
    }

    if (u.mode === "PAPER") {
      const entry = p.price,
        risk = Math.abs(entry - lv.sl);
      if (!(entry > 0) || !(risk > 0))
        return skip(`bad entry price ${entry}`, false, "FAILED");
      const t: V10TradeDoc = {
        ...base,
        entryPrice: entry,
        slPrice: lv.sl,
        tpPrice: lv.tp,
        quantity: u.riskUsd / risk,
        actualRiskUsd: u.riskUsd,
        entryInProgress: false,
      };
      if (!(await this.store.insertTrade(t))) return;
      log.warn(
        { tradeId: t.tradeId, entry, sl: lv.sl, tp: lv.tp },
        "[V10_PAPER_ENTRY]",
      );
      await this.notify(u, formatV10Entry(sig, t));
      return;
    }

    // REAL
    const rest = u.binanceRest;
    if (u.mode !== "REAL" || !rest) return; // not REAL-capable (main.ts downgrades such users to PAPER)
    if (this.now() - sig.turn.candleEnd > STALE_MS)
      return skip("signal too old for a market entry", true);
    if (await this.store.hasOpenV9Trade(u.userId, p.symbol))
      return skip(
        `a REAL V9 trade on ${p.symbol} is open for this user -- V10 never trades on top of it`,
        true,
      );
    const busy = await symbolClear(rest, p.symbol);
    if (busy) return skip(`${busy} -- V10 never trades on top of it`, true);
    // SL / TP: the SAME prices as PAPER -- the configured % from the SIGNAL price (Johnny, Oct 2: UNI REAL entered
    // +1.1% above the signal, after PAPER's SL had already been passed, and got its own wider SL). If the price a market
    // order would get NOW is already at / beyond the SL or the TP, the signal is over -> not opened.
    const lvl = levels(sig.side, p.price, rules.slPct, rules.tpPct);
    const book = (await rest.getBookTicker?.(p.symbol).catch(() => null)) as {
      bidPrice?: string;
      askPrice?: string;
    } | null;
    const exec = Number(sig.side === "SHORT" ? book?.bidPrice : book?.askPrice);
    if (!(exec > 0)) return skip("no executable price from Binance", true);
    const short = sig.side === "SHORT";
    if (short ? exec >= lvl.sl : exec <= lvl.sl)
      return skip(
        `the price already reached the SL: now ${exec}, signal ${p.price}, SL ${+lvl.sl.toPrecision(8)} -- the signal is over`,
        true,
      );
    if (short ? exec <= lvl.tp : exec >= lvl.tp)
      return skip(
        `the price already reached the TP: now ${exec}, signal ${p.price}, TP ${+lvl.tp.toPrecision(8)} -- too late`,
        true,
      );
    const ref = exec;
    const startedAt = this.now();
    const row: V10TradeDoc = {
      ...base,
      slPrice: lvl.sl,
      entryStartedAt: startedAt,
    };
    if (!(await this.store.insertTrade(row))) return; // already handled for this user
    this.entering.add(row.tradeId);
    try {
      const out = await runEntrySequence(rest, {
        userId: u.userId,
        globalSignalId: orderSignalId,
        symbol: p.symbol,
        side: sig.side,
        quantity: u.riskUsd / Math.abs(ref - lvl.sl),
        entryPriceEstimate: ref,
        slPrice: lvl.sl,
        initialTpPrice: lvl.tp,
        riskUsd: u.riskUsd,
        leverage: u.leverage,
        marginMode: u.marginMode,
      });
      if (
        out.outcome === "ENTRY_FAILED" ||
        out.outcome === "PROTECTION_FAILED_CLOSED"
      ) {
        // never trusted blindly: the order may have filled although the call failed (timeout). The 15 s monitor looks
        // up OUR entry order on Binance and decides: not opened -> failed (+ message) / filled -> protected or closed.
        await this.store.updateTrade(row.tradeId, {
          failureReason: out.reason,
        });
        log.error(
          { tradeId: row.tradeId, reason: out.reason, outcome: out.outcome },
          "[V10_ENTRY_NOT_CONFIRMED] -- handed to the recovery",
        );
        return;
      }
      const binance: V10TradeDoc["binance"] = {
        entryClientOrderId: out.entryClientOrderId,
        slAlgoId: out.slBinanceAlgoId,
        slClientAlgoId: out.slClientAlgoId,
        ...(out.outcome === "ENTRY_ACTIVE_WITH_TP"
          ? {
              tpOrderId: out.tpBinanceOrderId,
              tpClientOrderId: out.tpClientOrderId,
            }
          : { tpFailureReason: out.tpFailureReason }),
      };
      const fields: Partial<V10TradeDoc> = {
        entryPrice: out.entryPrice,
        quantity: out.quantity,
        tpPrice: out.tpPrice ?? null,
        actualRiskUsd: out.actualRiskUsd ?? null,
        binance,
        entryInProgress: false,
      };
      await this.store.updateTrade(row.tradeId, fields);
      log.warn({ tradeId: row.tradeId, ...fields }, "[V10_REAL_ENTRY]");
      await this.notify(
        u,
        formatV10Entry(sig, { ...row, ...fields } as V10TradeDoc),
      );
    } finally {
      this.entering.delete(row.tradeId);
    }
  }

  // ── 2. PAPER exits ───────────────────────────────────────────────────────────────────────────────────────────
  private async monitorPaper(): Promise<void> {
    const now = this.now();
    const open = (await this.store.findOpenTrades()).filter(
      (t) =>
        t.mode === "PAPER" &&
        !t.entryInProgress &&
        t.entryPrice !== null &&
        t.tpPrice !== null &&
        t.slPrice !== null &&
        t.quantity !== null,
    );
    const bySymbol = new Map<string, V10TradeDoc[]>();
    for (const t of open)
      bySymbol.set(t.symbol, [...(bySymbol.get(t.symbol) ?? []), t]);
    for (const [symbol, list] of bySymbol) {
      const from = Math.min(...list.map((t) => t.createdAt));
      const bars = (await this.load(symbol, from, now)).filter(
        (b) => b.t + M <= now,
      ); // closed minutes only
      for (const t of list) {
        const entry = t.entryPrice!,
          risk = Math.abs(entry - t.slPrice!),
          rr = Math.abs(t.tpPrice! - entry) / risk;
        const tr = simTrade(
          bars,
          t.createdAt,
          entry,
          t.slPrice!,
          rr,
          t.side === "SHORT" ? "DOWN" : "UP",
        );
        if (tr.exit === "OPEN") continue;
        const fees = estimateFeesUsd(entry * t.quantity!),
          riskUsd = t.actualRiskUsd ?? t.plannedRiskUsd;
        const feesUsd = tr.exit === "TP" ? fees.tp : fees.sl;
        const pnlUsd = (tr.exit === "TP" ? rr * riskUsd : -riskUsd) - feesUsd;
        await this.closeTrade(t, {
          closedAt: tr.exitT,
          exitPrice: tr.exit === "TP" ? t.tpPrice : t.slPrice,
          pnlUsd,
          pnlR: pnlUsd / riskUsd,
          feesUsd,
          closeReason: tr.exit === "TP" ? "TP_FILLED" : "SL_FILLED",
        });
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
          log.error(
            { tradeId: t.tradeId, userId: t.userId },
            "[V10_REAL_UNWATCHED] -- no Binance client for this user; check the trade on Binance",
          );
          continue;
        }
        try {
          if (t.entryInProgress) {
            // not running in this process: after a failed call at once, after a crash / restart once it is surely over
            if (
              t.failureReason !== null ||
              this.now() - (t.entryStartedAt ?? t.createdAt) >= STUCK_ENTRY_MS
            )
              await this.recover(t, u, rest);
            continue;
          }
          await this.checkRealTrade(t, u, rest);
        } catch (err) {
          log.error(
            {
              tradeId: t.tradeId,
              err: err instanceof Error ? err.message : String(err),
            },
            "[V10_REAL_MONITOR_FAILED] -- retried next cycle",
          );
        }
      }
    } finally {
      this.monitorBusy = false;
    }
  }

  /** an entry that did not finish normally -- decided from OUR entry order on Binance (see recoverEntry) */
  private async recover(
    t: V10TradeDoc,
    u: V10UserRef,
    rest: SettleRest,
  ): Promise<void> {
    const r = await recoverEntry(rest, {
      userId: t.userId,
      orderSignalId: t.orderSignalId,
      symbol: t.symbol,
      side: t.side,
      binance: t.binance,
    });
    const head = `⚠️ ${v10Head(t)} · ${t.symbol} · ${t.side} · REAL`;
    if (r.status === "RETRY") return this.retried(t, u, `recovery: ${r.why}`);
    if (t.retries) await this.store.updateTrade(t.tradeId, { retries: 0 });
    if (r.status === "NOT_OPENED") {
      const reason = t.failureReason ?? "entry never completed";
      await this.store.updateTrade(t.tradeId, {
        state: "FAILED",
        failureReason: reason,
        entryInProgress: false,
      });
      log.warn({ tradeId: t.tradeId, reason }, "[V10_TRADE_FAILED]");
      await this.notify(
        u,
        formatV10Failure({ ...t, state: "FAILED", failureReason: reason }),
      );
      return;
    }
    if (r.status === "DONE") {
      // our entry filled and the position is already gone (closed while we were away) -> the normal close report
      await this.store.updateTrade(t.tradeId, {
        entryInProgress: false,
        entryPrice: r.entryPrice,
        quantity: r.quantity,
      });
      log.warn(
        { tradeId: t.tradeId },
        "[V10_RECOVERY_DONE] -- settled next cycle",
      );
      return;
    }
    if (r.status === "ADOPTED") {
      let tpOrderId = r.tpOrderId,
        tpPrice: number | null = null;
      if (tpOrderId === null)
        ({ tpOrderId, tpPrice } = await this.placeTp(
          t,
          rest,
          r.entryPrice,
          r.quantity,
        ));
      const binance = {
        ...(t.binance ?? {}),
        slAlgoId: r.slAlgoId,
        ...(tpOrderId !== null ? { tpOrderId } : {}),
      };
      await this.store.updateTrade(t.tradeId, {
        entryPrice: r.entryPrice,
        quantity: r.quantity,
        entryInProgress: false,
        binance,
        failureReason: null,
        ...(tpPrice !== null ? { tpPrice } : {}),
      });
      log.warn({ tradeId: t.tradeId, binance }, "[V10_RECOVERY_ADOPTED]");
      await this.notify(
        u,
        `${head}\nThe entry did not finish normally${t.failureReason ? ` (${t.failureReason})` : ""}, but it is open on Binance with its SL resting -- the bot follows it as a normal trade${tpOrderId === null ? " (no TP: it closes at the SL or by hand)" : ""}.\n🆔 ${t.orderSignalId}`,
      );
      return;
    }
    await this.store.updateTrade(t.tradeId, {
      entryInProgress: false,
      entryPrice: r.entryPrice,
      quantity: r.quantity,
      binance: null,
      failureReason: `${FAILSAFE_NOTE}${t.failureReason ? ` (${t.failureReason})` : ""}`,
    });
    log.error(
      { tradeId: t.tradeId, quantity: r.quantity },
      "[V10_RECOVERY_CLOSED_UNPROTECTED]",
    );
    await this.notify(
      u,
      `${head}\nThe entry filled on Binance but its SL was not there -- the position was closed at market. The close report follows.\n🆔 ${t.orderSignalId}`,
    );
  }

  /** an adopted trade without its TP: the TP is placed (reduce-only LIMIT, our deterministic client id) */
  private async placeTp(
    t: V10TradeDoc,
    rest: SettleRest,
    entry: number,
    qty: number,
  ): Promise<{ tpOrderId: number | null; tpPrice: number | null }> {
    try {
      const f = await getSymbolFilters(rest, t.symbol);
      if (!f) return { tpOrderId: null, tpPrice: null };
      const tp = roundToStep(
        levels(t.side, entry, t.slPct, t.tpPct).tp,
        f.tickSize,
        f.pricePrecision,
      );
      const res = (await rest.createOrder({
        symbol: t.symbol,
        side: t.side === "LONG" ? "SELL" : "BUY",
        type: "LIMIT",
        timeInForce: "GTC",
        price: tp.toFixed(f.pricePrecision),
        quantity: qty.toFixed(f.qtyPrecision),
        reduceOnly: "true",
        newClientOrderId: ourIds(t.userId, t.orderSignalId).tp,
      })) as { orderId?: number };
      return {
        tpOrderId: Number(res?.orderId) > 0 ? Number(res.orderId) : null,
        tpPrice: tp,
      };
    } catch (err) {
      log.error(
        {
          tradeId: t.tradeId,
          err: err instanceof Error ? err.message : String(err),
        },
        "[V10_TP_PLACE_FAILED] -- the trade stays under its SL",
      );
      return { tpOrderId: null, tpPrice: null };
    }
  }

  /** a REAL trade that keeps failing to be read / settled: logged every time, the user told once after ~5 min IN A ROW
   *  (the counter goes back to 0 as soon as a cycle succeeds) */
  private async retried(
    t: V10TradeDoc,
    u: V10UserRef,
    why: string,
  ): Promise<void> {
    const n = (t.retries ?? 0) + 1;
    await this.store.updateTrade(t.tradeId, { retries: n });
    log.warn({ tradeId: t.tradeId, why, retries: n }, "[V10_REAL_RETRY]");
    if (n === RETRY_ALERT)
      await this.notify(
        u,
        `⚠️ ${v10Head(t)} · ${t.symbol} · ${t.side} · REAL\nThe bot cannot settle this trade for ~5 min: ${why}\nPlease look at ${t.symbol} on Binance.\n🆔 ${t.orderSignalId}`,
      );
  }

  private async checkRealTrade(
    t: V10TradeDoc,
    u: V10UserRef,
    rest: SettleRest,
  ): Promise<void> {
    const other = await this.store.openV9TradeSince(
      t.userId,
      t.symbol,
      t.entryStartedAt ?? t.createdAt,
    );
    const r = await settle(
      rest,
      {
        userId: t.userId,
        orderSignalId: t.orderSignalId,
        symbol: t.symbol,
        side: t.side,
        entryStartedAt: t.entryStartedAt ?? t.createdAt,
        quantity: t.quantity,
        binance: t.binance,
      },
      this.now(),
      other,
    );
    if (r.status === "RETRY") return this.retried(t, u, r.why);
    if (t.retries) await this.store.updateTrade(t.tradeId, { retries: 0 });
    if (r.status === "OPEN") return;
    if (r.status === "NO_FILLS") {
      if (t.entryPrice === null && this.now() - t.createdAt >= STUCK_ENTRY_MS) {
        await this.store.updateTrade(t.tradeId, {
          state: "FAILED",
          failureReason: "entry never completed (no fill found)",
          entryInProgress: false,
        });
        return;
      }
      const attempts = t.closeAttempts + 1;
      if (attempts < MAX_CLOSE_REPORT_ATTEMPTS) {
        await this.store.updateTrade(t.tradeId, { closeAttempts: attempts });
        return;
      }
      await this.closeTrade(
        t,
        {
          closedAt: this.now(),
          exitPrice: null,
          pnlUsd: null,
          pnlR: null,
          feesUsd: null,
          closeReason: "CLOSED_NO_FILLS_FOUND",
        },
        u,
      );
      return;
    }
    const risk = t.actualRiskUsd ?? t.plannedRiskUsd;
    // closed by the bot's own fail-safe (not by the user / Binance): an entry problem was the reason it happened
    const failsafe =
      r.report.reason === "POSITION_CLOSED_EXTERNALLY" &&
      t.failureReason !== null;
    await this.closeTrade(
      t,
      {
        closedAt: this.now(),
        exitPrice: r.report.exitPrice,
        pnlUsd: r.report.realizedPnlUsd,
        pnlR: risk > 0 ? r.report.realizedPnlUsd / risk : null,
        feesUsd: r.report.feesUsd,
        closeReason: failsafe ? "FAILSAFE_CLOSED" : r.report.reason,
      },
      u,
    );
  }

  private async closeTrade(
    t: V10TradeDoc,
    c: Pick<
      V10TradeDoc,
      "closedAt" | "exitPrice" | "pnlUsd" | "pnlR" | "feesUsd" | "closeReason"
    >,
    user?: V10UserRef,
  ): Promise<void> {
    await this.store.updateTrade(t.tradeId, {
      state: "CLOSED",
      entryInProgress: false,
      ...c,
    });
    log.warn({ tradeId: t.tradeId, ...c }, "[V10_TRADE_CLOSED]");
    const u = user ?? this.users().find((x) => x.userId === t.userId);
    if (u)
      await this.notify(u, formatV10Close({ ...t, state: "CLOSED", ...c }));
  }

  private async notify(u: V10UserRef, text: string): Promise<void> {
    if (!u.telegram) return;
    try {
      await u.telegram.sendMessage(text);
    } catch (err) {
      log.error(
        {
          userId: u.userId,
          err: err instanceof Error ? err.message : String(err),
        },
        "[V10_TELEGRAM_FAILED] -- isolated",
      );
    }
  }
}

export const V10_INTERNALS = { READY_MS, STALE_MS, V10_CANDLE_MS };
