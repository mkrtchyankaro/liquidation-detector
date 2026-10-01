import {
  cancelOwnAlgoOrder,
  getSymbolFilters,
  roundToStep,
  runEntrySequence,
  verifyAlgoOrderOpen,
  type BinanceRestLike,
} from "../../execution/entry-sequence";
import { strategyClientOrderId } from "../../execution/client-order-id";
import {
  buildRealCloseReport,
  type UserTradeFill,
} from "../../execution/close-report";
import { childLogger } from "../../infrastructure/logging/logger";
import { MINUTE_MS, type Victim } from "./v9-core";
import {
  DEFAULT_V9_ENGINE_SETTINGS,
  V9CausalEngine,
  type V9Decision,
  type V9EngineSettings,
} from "./v9-causal-engine";
import { moveCase, type V9Settings } from "./v9-config";
import type { V9MongoFeed } from "./v9-feed";
import type { V9DecisionDoc, V9Repository, V9TradeDoc } from "./v9-repository";
import {
  formatV9Close,
  formatV9Entry,
  formatV9Failure,
  formatV9Lock,
} from "./v9-telegram";
import type { V9FrameSource } from "./v9-frame-source";
import { estimateFeesUsd } from "./v9-fees";
import { preMove } from "../../research/v9-own-move";

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
  binanceRest:
    | (BinanceRestLike & {
        getUserTrades(symbol: string, startTime: number): Promise<unknown>;
      })
    | null;
  leverage?: number;
  marginMode?: "ISOLATED" | "CROSSED";
  telegram: { sendMessage(text: string): Promise<unknown> } | null;
}

const fmtPer = (m: Map<string, number> | undefined, unit = ""): string =>
  [...(m ?? new Map<string, number>())]
    .map(([k, n]) => `${k}:${n}${unit}`)
    .join(",") || "none";
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
    /** 4h frame check for tradable signals (null = off; frameOnly users then skip every signal). */
    private readonly frameSource: V9FrameSource | null = null,
  ) {
    for (const s of settings.symbols)
      this.engines.set(s, new V9CausalEngine(s, engineSettings));
  }

  /** Warm-up (history -> reference medians) then start both schedules.
   *  Warm-up decisions are never traded. */
  async start(): Promise<void> {
    await this.repo.ensureIndexes();
    const t0 = this.now();
    for (const [symbol, engine] of this.engines) {
      const loaded = await this.feed.warmUp(
        symbol,
        engine.store,
        t0 - WARMUP_HISTORY_MS,
      );
      let decided = 0;
      for (
        let t = t0 - this.engineSettings.windowMs;
        t <= t0;
        t += WARMUP_STEP_MS
      ) {
        decided += engine.evaluate(t).length;
        await new Promise((r) => setImmediate(r)); // keep the event loop (WS, LOX) responsive
      }
      log.info(
        `[V9_WARMUP] ${symbol} rows liq=${loaded.liq} oi=${loaded.oi} historicalDecisions=${decided}`,
      );
    }
    // Restore which episodes were already traded (exact, from the database)
    // so a re-confirmed episode is never traded twice across restarts.
    for (const t of await this.repo.findTradesSince(
      t0 - this.engineSettings.windowMs,
    )) {
      this.engines.get(t.symbol)?.markTraded(t.side, t.createdAt);
    }
    this.ready = true;
    log.warn(
      `[V9_READY] symbols=${[...this.engines.keys()].join(",")} rr=${this.settings.rr} minSl=${(this.engineSettings.minSlFraction * 100).toFixed(2)}% forcedOnly=${[...(this.settings.forcedOnlyUsers ?? [])].join("+") || "none"} frameOnly=${[...(this.settings.frameOnlyUsers ?? [])].join("+") || "none"} frameCheck=${this.frameSource ? "on" : "off"} timeStop=${this.settings.timeStopHours ? `${this.settings.timeStopHours}h` : "off"} maxOpen=${fmtPer(this.settings.maxOpenPerUser)} rrPerUser=${fmtPer(this.settings.rrPerUser)} minStop=${fmtPer(this.settings.minStopPerUser, "%")} moveFilter=${[...(this.settings.moveFilterUsers ?? [])].join("+") || "none"} moveBlock=${[...(this.settings.moveBlock ?? new Map<string, Set<string>>())].map(([k, v]) => `${k}:${[...v].join("+")}`).join(",") || "none"} profitLock=${this.settings.profitLock ? `at+${this.settings.profitLock.atR}R->SL+${this.settings.profitLock.toR}R` : "off"} lateSl=${this.engineSettings.lateSlPct === null ? "off" : this.engineSettings.lateSlPct === 0 ? "OITURN(always)" : `${this.engineSettings.lateSlPct}%`}${this.engineSettings.lateSlPct !== null && this.engineSettings.lateSlMinPct !== null ? `,min${this.engineSettings.lateSlMinPct}%` : ""} users=${this.users()
        .map((u) => `${u.userId}:${u.mode}`)
        .join(",")}`,
    );
    this.scheduleNextMinute();
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

  private scheduleNextMinute(): void {
    const now = this.now();
    const next =
      Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS + EVAL_OFFSET_MS;
    this.minuteTimer = setTimeout(
      () => {
        void this.onMinute().finally(() => this.scheduleNextMinute());
      },
      Math.max(1_000, next - now),
    );
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
          if (engine.lastSnapshot?.ts === now)
            snapshots.push(engine.lastSnapshot);
          await this.monitorPaper(symbol, engine, now);
        } catch (err) {
          log.error(
            { symbol, err: err instanceof Error ? err.message : String(err) },
            "[V9_SYMBOL_ROUND_FAILED] -- isolated, other symbols continue",
          );
        }
      }
      await this.repo
        .insertTimeline(snapshots)
        .catch((err) =>
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "[V9_TIMELINE_WRITE_FAILED] -- trading unaffected",
          ),
        );
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
      const busy = (await this.repo.findOpenTrades()).filter(
        (t) => t.symbol === d0.symbol,
      );
      if (busy.length > 0) {
        d = {
          ...d0,
          tradable: false,
          reason: "SYMBOL_BUSY" as V9Decision["reason"],
        };
        log.warn(
          { signalId, openSignals: [...new Set(busy.map((t) => t.signalId))] },
          "[V9_SYMBOL_BUSY] previous signal still has open trades -- new signal not opened",
        );
      }
    }
    // The 4h frame (tradable signals only, and only while some user trades with the FRAME filter). Never blocks the round.
    if (
      d.tradable &&
      this.frameSource &&
      (this.settings.frameOnlyUsers?.size ?? 0) > 0
    ) {
      try {
        d = {
          ...d,
          frame: await this.frameSource(
            d.symbol,
            d.tradeSide === "LONG",
            d.episode.start,
            d.evaluatedAt,
          ),
        };
      } catch (err) {
        log.error(
          { signalId, err: err instanceof Error ? err.message : String(err) },
          "[V9_FRAME_CHECK_FAILED] -- frameOnly users skip this signal",
        );
      }
    }
    // Did BTC bring the coin here? (Johnny, Oct 1) -- information for the Telegram message only, never blocks.
    if (d.tradable && d.symbol !== "BTCUSDT")
      d = { ...d, btcCheck: this.btcCheckOf(d) };
    const doc: V9DecisionDoc = {
      signalId,
      symbol: d.symbol,
      victim: d.episode.victim,
      reason: d.reason,
      tradable: d.tradable,
      episodeStart: d.episode.start,
      episodeEnd: d.episode.end,
      confirmTs: d.episode.confirmTs,
      evaluatedAt: d.evaluatedAt,
      checks: d.selection.checks,
      features: {
        dom: d.features.dom,
        dir: d.features.dir,
        exh: d.features.exh,
        dirMove: d.features.dirMove,
        clr: d.features.clr,
        victimLiq: d.features.victimLiq,
        oppLiq: d.features.oppLiq,
        preEff: d.features.preEff,
        postEff: d.features.postEff,
      },
      reference: d.reference,
      episode: {
        longUsd: d.episode.long,
        shortUsd: d.episode.short,
        oiDropPct: d.episode.oiDropPct,
        priceMovePct: d.episode.priceMovePct,
        parts: d.episode.parts,
      },
      stopPrice: d.stopPrice,
      referencePrice: d.referencePrice,
      missingMinutes: d.missingMinutes,
      quality: d.quality ?? null,
      frame: d.frame ?? null,
      btcCheck: d.btcCheck ?? null,
      createdAt: new Date(),
    };
    await this.repo.insertDecision(doc);
    log.info(
      { signalId, reason: d.reason, checks: d.selection.checks },
      "[V9_DECISION]",
    );
    if (!d.tradable) return;
    log.warn(
      { signalId, side: d.tradeSide, stop: d.stopPrice, ref: d.referencePrice },
      "[V9_SIGNAL]",
    );
    await Promise.all(
      this.users().map((u) =>
        this.openTrade(u, d, signalId).catch((err) =>
          log.error(
            {
              userId: u.userId,
              signalId,
              err: err instanceof Error ? err.message : String(err),
            },
            "[V9_OPEN_TRADE_UNEXPECTED] -- isolated",
          ),
        ),
      ),
    );
  }

  /** Over the episode (start -> the last closed minute): how much of the coin's move BTC explains, with the coin's
   *  usual amplification of BTC from the 24h before the episode. Only data already in memory (past only). */
  private btcCheckOf(d: V9Decision): V9Decision["btcCheck"] {
    try {
      const coinEng = this.engines.get(d.symbol),
        btcEng = this.engines.get("BTCUSDT");
      if (!coinEng || !btcEng) return null;
      const from = d.episode.start - 25 * 3_600_000,
        to = d.evaluatedAt - MINUTE_MS;
      const bars = (e: V9CausalEngine) =>
        e.store
          .minuteRange(from, to)
          .map((m) => ({ t: m.ts, high: m.high, low: m.low, close: m.close }));
      const p = preMove(
        {
          id: "",
          symbol: d.symbol,
          side: d.tradeSide,
          createdAt: to,
          entry: d.referencePrice,
          sl: d.stopPrice,
        },
        bars(coinEng),
        bars(btcEng),
        d.episode.start,
        24,
      );
      if (!p) return null;
      const sgn = d.tradeSide === "LONG" ? 1 : -1;
      const moveInTradeDir = p.byBtc ? p.btcPart : p.own; // + = the move went the trade's way
      return {
        byBtc: p.byBtc,
        coinPct: p.coinPct,
        btcPct: p.btcPct,
        btcPart: p.btcPart,
        own: p.own,
        beta: p.beta,
        up: sgn * moveInTradeDir > 0,
        good: p.byBtc ? moveInTradeDir < 0 : moveInTradeDir > 0,
      };
    } catch (err) {
      log.warn(
        {
          symbol: d.symbol,
          err: err instanceof Error ? err.message : String(err),
        },
        "[V9_BTC_CHECK_FAILED] -- no BTC line",
      );
      return null;
    }
  }

  private async openTrade(
    u: V9UserRef,
    d: V9Decision,
    signalId: string,
  ): Promise<void> {
    const side: Victim = d.tradeSide;
    const long = side === "LONG";
    const rr = this.settings.rrPerUser?.get(u.userId) ?? this.settings.rr; // this user's TP in R
    const base: V9TradeDoc = {
      tradeId: `${signalId}:${u.userId}`,
      signalId,
      userId: u.userId,
      mode: u.mode,
      symbol: d.symbol,
      side,
      state: "OPEN",
      createdAt: this.now(),
      entryPrice: null,
      slPrice: d.stopPrice,
      tpPrice: null,
      quantity: null,
      plannedRiskUsd: u.riskUsd,
      actualRiskUsd: null,
      rr,
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
      lock:
        this.settings.profitLock && this.settings.profitLock.atR < rr
          ? { ...this.settings.profitLock }
          : null,
    };
    const fail = async (
      reason: string,
      state: "FAILED" | "SKIPPED" = "FAILED",
    ): Promise<void> => {
      const t = {
        ...base,
        state,
        failureReason: reason,
        entryInProgress: false,
      };
      await this.repo.updateTrade(base.tradeId, {
        state,
        failureReason: reason,
        entryInProgress: false,
      });
      log.warn({ userId: u.userId, signalId, reason }, `[V9_TRADE_${state}]`);
      await this.notify(u, formatV9Failure(t));
    };

    // FORCED filter (per user): only strong, forced cleanings for these users.
    if (this.settings.forcedOnlyUsers?.has(u.userId) && d.quality?.weak) {
      const reason = `FORCED_FILTER: liquidations ${d.quality.forcedPct.toFixed(1)}% of closed OI < coin median ${d.quality.forcedMedianPct.toFixed(1)}%`;
      if (
        !(await this.repo.insertTrade({
          ...base,
          state: "SKIPPED",
          failureReason: reason,
          entryInProgress: false,
        }))
      )
        return;
      log.warn(
        { userId: u.userId, signalId, reason },
        "[V9_TRADE_SKIPPED_FORCED]",
      );
      return; // silent: a filtered user only hears about the signals of its own strategy (Johnny, Sep 28)
    }

    // FRAME filter (per user): only signals whose cleaning reached the edge of the 4h frame.
    if (
      this.settings.frameOnlyUsers?.has(u.userId) &&
      d.frame?.verdict !== "IN_ZONE"
    ) {
      const f = d.frame;
      const reason = !f
        ? "FRAME_FILTER: frame check unavailable"
        : f.verdict === "NO_FRAME"
          ? "FRAME_FILTER: no 4h frame yet"
          : `FRAME_FILTER: middle of the frame (pos ${Math.round(f.pos)}%)`;
      if (
        !(await this.repo.insertTrade({
          ...base,
          state: "SKIPPED",
          failureReason: reason,
          entryInProgress: false,
        }))
      )
        return;
      log.warn(
        { userId: u.userId, signalId, reason },
        "[V9_TRADE_SKIPPED_FRAME]",
      );
      return; // silent: a filtered user only hears about the signals of its own strategy (Johnny, Sep 28)
    }

    // MOVE filter (per user, Johnny Oct 1): skip ⚠️ signals -- BTC brought the coin here and we would trade WITH
    // BTC's push, or the coin came here on its own and we would trade AGAINST it. Silent, like the other filters.
    // moveBlock: only the cases chosen for this user (e.g. COIN_UP_SHORT).
    const mcase = d.btcCheck
      ? moveCase(d.btcCheck.byBtc, d.btcCheck.up, side)
      : null;
    if (
      d.btcCheck &&
      ((this.settings.moveFilterUsers?.has(u.userId) && !d.btcCheck.good) ||
        (mcase !== null && this.settings.moveBlock?.get(u.userId)?.has(mcase)))
    ) {
      const c = d.btcCheck;
      const reason = `MOVE_FILTER: ${mcase} -- ${c.byBtc ? "BTC" : d.symbol.replace(/USDT$/, "")} moved the coin ${c.up ? "up" : "down"} and the trade is ${side}`;
      if (
        !(await this.repo.insertTrade({
          ...base,
          state: "SKIPPED",
          failureReason: reason,
          entryInProgress: false,
        }))
      )
        return;
      log.warn(
        { userId: u.userId, signalId, reason },
        "[V9_TRADE_SKIPPED_MOVE]",
      );
      return;
    }

    // MIN STOP (per user, Johnny Sep 30): a signal whose SL is this % from the entry or closer is skipped -- silent,
    // like the other strategy filters; checked before MAX OPEN so a filtered signal never takes a slot.
    const minStop = this.settings.minStopPerUser?.get(u.userId);
    if (minStop !== undefined) {
      const slPct =
        (100 * Math.abs(d.referencePrice - d.stopPrice)) / d.referencePrice;
      if (!(slPct > minStop)) {
        const reason = `MIN_STOP: SL ${slPct.toFixed(2)}% from the entry <= ${minStop}%`;
        if (
          !(await this.repo.insertTrade({
            ...base,
            state: "SKIPPED",
            failureReason: reason,
            entryInProgress: false,
          }))
        )
          return;
        log.warn(
          { userId: u.userId, signalId, reason },
          "[V9_TRADE_SKIPPED_MIN_STOP]",
        );
        return;
      }
    }

    // MAX OPEN (per user, Johnny Sep 30): at most N V9 trades open at once for this user, all coins together.
    // Decisions are handled one after another, so the count already includes a trade opened a moment ago.
    const maxOpen = this.settings.maxOpenPerUser?.get(u.userId);
    if (maxOpen !== undefined) {
      const mine = (await this.repo.findOpenTrades()).filter(
        (t) => t.userId === u.userId,
      );
      if (mine.length >= maxOpen) {
        const reason = `MAX_OPEN: ${mine.length} V9 trades already open (${mine.map((t) => `${t.symbol} ${t.side}`).join(", ")}), limit ${maxOpen}`;
        if (
          !(await this.repo.insertTrade({
            ...base,
            state: "SKIPPED",
            failureReason: reason,
            entryInProgress: false,
          }))
        )
          return;
        log.warn(
          { userId: u.userId, signalId, reason },
          "[V9_TRADE_SKIPPED_MAX_OPEN]",
        );
        await this.notify(
          u,
          formatV9Failure({ ...base, state: "SKIPPED", failureReason: reason }),
        );
        return;
      }
    }

    // Pre-checks that need no order (both modes).
    if (u.mode === "REAL") {
      if (!u.binanceRest) return; // not REAL-capable (main.ts already downgrades such users)
      if (await this.repo.hasOpenTrade(u.userId, d.symbol)) {
        log.warn(
          { userId: u.userId, signalId },
          "[V9_SKIP] an open V9 trade already exists on this symbol",
        );
        return;
      }
    }
    if (!(await this.repo.insertTrade(base))) return; // this signal was already handled for this user

    if (u.mode === "PAPER") {
      const entry = d.referencePrice;
      const risk = long ? entry - d.stopPrice : d.stopPrice - entry;
      if (!(entry > 0) || !(risk > 0))
        return fail(`price ${entry} already beyond SL ${d.stopPrice}`);
      const qty = u.riskUsd / risk;
      const tp = long ? entry + rr * risk : entry - rr * risk;
      const t: V9TradeDoc = {
        ...base,
        entryPrice: entry,
        tpPrice: tp,
        quantity: qty,
        actualRiskUsd: u.riskUsd,
        entryInProgress: false,
      };
      await this.repo.updateTrade(base.tradeId, {
        entryPrice: entry,
        tpPrice: tp,
        quantity: qty,
        actualRiskUsd: u.riskUsd,
        entryInProgress: false,
      });
      await this.notify(u, formatV9Entry(d, t));
      return;
    }

    // REAL
    const rest = u.binanceRest!;
    try {
      const pos = (
        (await rest.getPositionRisk(d.symbol)) as Array<{
          symbol: string;
          positionAmt: string;
        }>
      ).find((p) => p.symbol === d.symbol);
      if (pos && Number(pos.positionAmt) !== 0)
        return fail(
          `an existing ${d.symbol} position (${pos.positionAmt}) is open on this account -- V9 never trades on top of it`,
          "SKIPPED",
        );
    } catch (err) {
      return fail(
        `could not read positions: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const riskEst = Math.abs(d.referencePrice - d.stopPrice);
    const out = await runEntrySequence(rest, {
      userId: u.userId,
      globalSignalId: signalId,
      symbol: d.symbol,
      side,
      quantity: riskEst > 0 ? u.riskUsd / riskEst : 0,
      entryPriceEstimate: d.referencePrice,
      slPrice: d.stopPrice,
      initialTpPrice: d.referencePrice,
      tpRMultiple: rr,
      riskUsd: u.riskUsd,
      leverage: u.leverage,
      marginMode: u.marginMode,
    });
    if (out.outcome === "ENTRY_FAILED") return fail(out.reason);
    if (out.outcome === "PROTECTION_FAILED_CLOSED") return fail(out.reason);
    const binance = {
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
    const fields: Partial<V9TradeDoc> = {
      entryPrice: out.entryPrice,
      quantity: out.quantity,
      tpPrice: out.tpPrice ?? null,
      actualRiskUsd: out.actualRiskUsd ?? null,
      binance,
      entryInProgress: false,
    };
    await this.repo.updateTrade(base.tradeId, fields);
    await this.notify(
      u,
      formatV9Entry(d, { ...base, ...fields } as V9TradeDoc),
    );
  }

  /** PAPER: first minute (after the entry minute) whose low/high crosses SL
   *  or TP decides; SL wins a same-minute tie (conservative).
   *  PROFIT LOCK (Johnny, Oct 1): once a minute reaches +atR the SL is +toR from the NEXT minute; in the lock minute
   *  itself only a close back at / beyond the moved SL counts (exactly like src/research/v9-tp-sim.ts). The walk
   *  always starts from the ORIGINAL SL (slInitial), so re-running it every minute gives the same answer. */
  private async monitorPaper(
    symbol: string,
    engine: V9CausalEngine,
    now: number,
  ): Promise<void> {
    const open = (await this.repo.findOpenTrades()).filter(
      (t) =>
        t.mode === "PAPER" &&
        t.symbol === symbol &&
        !t.entryInProgress &&
        t.entryPrice !== null &&
        t.tpPrice !== null &&
        t.quantity !== null,
    );
    for (const t of open) {
      const long = t.side === "LONG",
        entry = t.entryPrice!;
      const sl0 = t.slInitial ?? t.slPrice,
        risk0 = Math.abs(entry - sl0);
      const lockPrice = t.lock
        ? long
          ? entry + t.lock.atR * risk0
          : entry - t.lock.atR * risk0
        : NaN;
      const lockSl = t.lock
        ? long
          ? entry + t.lock.toR * risk0
          : entry - t.lock.toR * risk0
        : NaN;
      // Same fee model as Binance (taker entry, maker TP / taker SL) so PAPER net results are comparable with REAL.
      const riskUsd = t.actualRiskUsd ?? t.plannedRiskUsd;
      const fees = estimateFeesUsd(entry * t.quantity!);
      const pnlAt = (exit: number, fee: number): number =>
        (long ? exit - entry : entry - exit) * t.quantity! - fee;
      let sl = sl0,
        lockedTs: number | null = null,
        exit: { ts: number; price: number; reason: string } | null = null;
      for (const m of engine.store.minuteRange(
        t.createdAt + MINUTE_MS,
        now - MINUTE_MS,
      )) {
        // a lock already saved stays, even if its minute is no longer in memory (restart / 3-day window)
        if (t.lock && t.lockedAt && lockedTs === null && m.ts >= t.lockedAt) {
          lockedTs = t.lockedAt;
          sl = lockSl;
        }
        if (long ? m.low <= sl : m.high >= sl) {
          exit = {
            ts: m.ts,
            price: sl,
            reason: lockedTs !== null ? "PROFIT_STOP" : "SL_FILLED",
          };
          break;
        }
        if (long ? m.high >= t.tpPrice! : m.low <= t.tpPrice!) {
          exit = { ts: m.ts, price: t.tpPrice!, reason: "TP_FILLED" };
          break;
        }
        if (
          t.lock &&
          lockedTs === null &&
          (long ? m.high >= lockPrice : m.low <= lockPrice)
        ) {
          lockedTs = m.ts + MINUTE_MS;
          sl = lockSl;
          if (long ? m.close <= sl : m.close >= sl) {
            exit = { ts: m.ts, price: sl, reason: "PROFIT_STOP" };
            break;
          }
        }
      }
      if (lockedTs !== null && !t.lockedAt) {
        await this.repo.updateTrade(t.tradeId, {
          lockedAt: lockedTs,
          slInitial: sl0,
          slPrice: lockSl,
        });
        const locked = {
          ...t,
          lockedAt: lockedTs,
          slInitial: sl0,
          slPrice: lockSl,
        };
        log.warn({ tradeId: t.tradeId, sl: lockSl }, "[V9_PROFIT_LOCK]");
        const u = this.users().find((x) => x.userId === t.userId);
        if (u && !exit) await this.notify(u, formatV9Lock(locked, lockSl)); // closed in the same pass -> the close message says it
        Object.assign(t, locked);
      }
      if (exit) {
        const feesUsd = exit.reason === "TP_FILLED" ? fees.tp : fees.sl;
        const pnlUsd =
          exit.reason === "SL_FILLED"
            ? -riskUsd - feesUsd
            : exit.reason === "TP_FILLED"
              ? t.rr * riskUsd - feesUsd
              : pnlAt(exit.price, feesUsd);
        await this.closeTrade(t, {
          closedAt: exit.ts + MINUTE_MS,
          exitPrice: exit.price,
          pnlUsd,
          pnlR: pnlUsd / riskUsd,
          feesUsd,
          closeReason: exit.reason,
        });
        continue;
      }
      // TIME STOP: neither SL nor TP after timeStopHours -> closed at the last price (taker both ways)
      if (
        this.settings.timeStopHours &&
        now - t.createdAt >= this.settings.timeStopHours * 3_600_000
      ) {
        const last = engine.store.lastPrice(now);
        if (!(last > 0)) continue;
        const feesUsd = fees.sl;
        const pnlUsd = pnlAt(last, feesUsd);
        await this.closeTrade(t, {
          closedAt: now,
          exitPrice: last,
          pnlUsd,
          pnlR: pnlUsd / riskUsd,
          feesUsd,
          closeReason: "TIME_STOP",
        });
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
        if (t.entryInProgress && this.now() - t.createdAt < STUCK_ENTRY_MS)
          continue;
        try {
          await this.checkRealTrade(t, u, u.binanceRest);
        } catch (err) {
          log.error(
            {
              tradeId: t.tradeId,
              err: err instanceof Error ? err.message : String(err),
            },
            "[V9_REAL_MONITOR_FAILED] -- retried next cycle",
          );
        }
      }
    } finally {
      this.monitorBusy = false;
    }
  }

  private async checkRealTrade(
    t: V9TradeDoc,
    u: V9UserRef,
    rest: NonNullable<V9UserRef["binanceRest"]>,
  ): Promise<void> {
    const pos = (
      (await rest.getPositionRisk(t.symbol)) as Array<{
        symbol: string;
        positionAmt: string;
      }>
    ).find((p) => p.symbol === t.symbol);
    if (pos && Number(pos.positionAmt) !== 0) {
      // TIME STOP: still open after timeStopHours -> market close (reduce-only, deterministic id = sent once);
      // the next cycle sees the position flat, cancels TP/SL and reports the close from Binance fills.
      if (
        t.lock &&
        !t.entryInProgress &&
        t.entryPrice !== null &&
        t.quantity !== null
      ) {
        try {
          // isolated: a lock problem must never block the TIME STOP below
          if (!t.lockedAt) await this.tryProfitLockReal(t, u, rest);
          else if (t.binance?.slOldClientAlgoId)
            await this.cancelOldSl(t, rest);
        } catch (err) {
          log.error(
            {
              tradeId: t.tradeId,
              err: err instanceof Error ? err.message : String(err),
            },
            "[V9_PROFIT_LOCK_FAILED] -- the stop on Binance is unchanged, retried next cycle",
          );
        }
      }
      if (
        this.settings.timeStopHours &&
        !t.entryInProgress &&
        this.now() - t.createdAt >= this.settings.timeStopHours * 3_600_000
      ) {
        const filters = await getSymbolFilters(rest, t.symbol);
        if (!filters) return;
        const qty = Math.abs(Number(pos.positionAmt));
        try {
          await rest.createOrder({
            symbol: t.symbol,
            side: t.side === "LONG" ? "SELL" : "BUY",
            type: "MARKET",
            quantity: qty.toFixed(filters.qtyPrecision),
            reduceOnly: "true",
            newClientOrderId: strategyClientOrderId(
              t.userId,
              t.signalId,
              "MARKET_EXIT",
              0,
            ),
          });
          if (!t.timeStopSentAt)
            await this.repo.updateTrade(t.tradeId, {
              timeStopSentAt: this.now(),
            });
          log.warn(
            { tradeId: t.tradeId, hours: this.settings.timeStopHours },
            "[V9_TIME_STOP_SENT]",
          );
        } catch (err) {
          log.error(
            {
              tradeId: t.tradeId,
              err: err instanceof Error ? err.message : String(err),
            },
            "[V9_TIME_STOP_FAILED] -- retried next cycle",
          );
        }
      }
      return; // still open (until Binance reports it flat)
    }
    // Flat: remove whatever of ours is still resting (reduce-only, harmless but must not linger).
    if (t.binance?.tpOrderId)
      await rest
        .cancelOrder(t.symbol, t.binance.tpOrderId)
        .catch(() => undefined);
    if (t.binance?.slOldClientAlgoId)
      await cancelOwnAlgoOrder(
        rest,
        t.symbol,
        t.binance.slOldAlgoId ?? null,
        t.binance.slOldClientAlgoId,
      );
    let slActualOrderId: number | null = null;
    if (t.binance?.slAlgoId) {
      const stop = (await rest
        .getAlgoOrder(t.binance.slAlgoId)
        .catch(() => null)) as {
        actualOrderId?: string | number;
        algoStatus?: string;
      } | null;
      const id = Number(stop?.actualOrderId);
      if (id > 0) slActualOrderId = id;
      if (stop && (stop.algoStatus === "NEW" || stop.algoStatus === "WORKING"))
        await rest.cancelAlgoOrder(t.binance.slAlgoId).catch(() => undefined);
    }
    // PROFIT LOCK: the moved stop (revision 1) may exist on Binance even if it was never saved here (crash between
    // placing and saving, or it fired during its own confirmation) -- never leave it resting, and learn its fill.
    let lockFillId: number | null = null;
    const lockClientId = t.lock
      ? strategyClientOrderId(t.userId, t.signalId, "STOP_LOSS", 1)
      : null;
    if (lockClientId && t.binance?.slClientAlgoId !== lockClientId) {
      const st = (await rest
        .getAlgoOrderByClientId(lockClientId)
        .catch(() => null)) as { actualOrderId?: string | number } | null;
      if (Number(st?.actualOrderId) > 0) lockFillId = Number(st!.actualOrderId);
      await cancelOwnAlgoOrder(rest, t.symbol, null, lockClientId);
    }
    // Do not report the close while one of our stops is still listed on Binance (it could later reduce a NEW
    // position on this symbol) -- retried next cycle. A failing list call does not block the report.
    const ours = [
      t.binance?.slClientAlgoId,
      t.binance?.slOldClientAlgoId,
      lockClientId,
    ].filter((x): x is string => !!x);
    const stillOpen = (await rest
      .getOpenAlgoOrders(t.symbol)
      .catch(() => null)) as Array<{ clientAlgoId?: string }> | null;
    if (
      Array.isArray(stillOpen) &&
      stillOpen.some((o) => o.clientAlgoId && ours.includes(o.clientAlgoId))
    ) {
      log.warn(
        { tradeId: t.tradeId },
        "[V9_STOP_STILL_OPEN_AFTER_FLAT] -- cancel retried next cycle",
      );
      for (const o of stillOpen)
        if (o.clientAlgoId && ours.includes(o.clientAlgoId))
          await cancelOwnAlgoOrder(rest, t.symbol, null, o.clientAlgoId);
      return;
    }
    const fills = (await rest.getUserTrades(
      t.symbol,
      t.createdAt - 60_000,
    )) as UserTradeFill[];
    let report = buildRealCloseReport({
      side: t.side,
      fills: Array.isArray(fills) ? fills : [],
      sinceMs: t.createdAt - 60_000,
      tpOrderId: t.binance?.tpOrderId ?? null,
      slActualOrderId,
    });
    let byLock = false;
    if (
      report?.reason === "POSITION_CLOSED_EXTERNALLY" &&
      lockFillId !== null
    ) {
      const again = buildRealCloseReport({
        side: t.side,
        fills: Array.isArray(fills) ? fills : [],
        sinceMs: t.createdAt - 60_000,
        tpOrderId: t.binance?.tpOrderId ?? null,
        slActualOrderId: lockFillId,
      });
      if (again?.reason === "SL_FILLED") {
        report = again;
        byLock = true;
      }
    }
    if (report === null) {
      if (t.entryPrice === null && this.now() - t.createdAt >= STUCK_ENTRY_MS) {
        await this.repo.updateTrade(t.tradeId, {
          state: "FAILED",
          failureReason: "entry never completed (no fill found)",
          entryInProgress: false,
        });
        return;
      }
      const attempts = t.closeAttempts + 1;
      if (attempts < MAX_CLOSE_REPORT_ATTEMPTS) {
        await this.repo.updateTrade(t.tradeId, { closeAttempts: attempts });
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
    const reason =
      report.reason === "POSITION_CLOSED_EXTERNALLY" && t.timeStopSentAt
        ? "TIME_STOP"
        : report.reason === "SL_FILLED" && (t.lockedAt || byLock)
          ? "PROFIT_STOP"
          : report.reason;
    await this.closeTrade(
      t,
      {
        closedAt: this.now(),
        exitPrice: report.exitPrice,
        pnlUsd: report.realizedPnlUsd,
        pnlR: risk > 0 ? report.realizedPnlUsd / risk : null,
        feesUsd: report.feesUsd,
        closeReason: reason,
      },
      u,
    );
  }

  /**
   * REAL PROFIT LOCK (Johnny, Oct 1). The position is NEVER without a stop:
   *   1. the price (best bid for a LONG / ask for a SHORT) has reached +atR -- else nothing happens
   *   2. the NEW stop (STOP_MARKET reduce-only at +toR, deterministic clientAlgoId revision 1) is placed -- or adopted
   *      if a previous cycle already placed it (crash between placing and saving)
   *   3. only when Binance confirms the new stop resting: saved, THEN the old stop is cancelled
   * Any failure before 3 -> the old stop stays and the next cycle (15 s) tries again; a new stop that could not be
   * confirmed is cancelled. If the price already fell back below +toR Binance rejects the stop ("would immediately
   * trigger") -> the old stop stays (no market close is ever sent here).
   */
  private async tryProfitLockReal(
    t: V9TradeDoc,
    u: V9UserRef,
    rest: NonNullable<V9UserRef["binanceRest"]>,
  ): Promise<void> {
    const lock = t.lock!,
      long = t.side === "LONG",
      entry = t.entryPrice!,
      sl0 = t.slPrice,
      risk0 = Math.abs(entry - sl0);
    if (!(risk0 > 0) || !t.binance?.slClientAlgoId) return;
    const lockPrice = long
      ? entry + lock.atR * risk0
      : entry - lock.atR * risk0;
    const newClientId = strategyClientOrderId(
      t.userId,
      t.signalId,
      "STOP_LOSS",
      1,
    );
    // A moved stop already resting (placed by a cycle that crashed before saving) is adopted whatever the price now:
    // it is a real, tighter stop on Binance and must be known here.
    let newAlgoId: number | null = null;
    let adopted = false;
    if (t.lockPending) {
      try {
        const open = (await rest.getOpenAlgoOrders(t.symbol)) as Array<{
          algoId?: number | string;
          clientAlgoId?: string;
        }>;
        const mine = Array.isArray(open)
          ? open.find((o) => o.clientAlgoId === newClientId)
          : undefined;
        if (mine?.algoId !== undefined) {
          newAlgoId = Number(mine.algoId);
          adopted = true;
        }
      } catch {
        return;
      } // unknown -> try again next cycle (the original SL is still there)
    }
    const filters = await getSymbolFilters(rest, t.symbol);
    if (!filters) return;
    const newSl = roundToStep(
      long ? entry + lock.toR * risk0 : entry - lock.toR * risk0,
      filters.tickSize,
      filters.pricePrecision,
    );
    let px = NaN;
    if (!adopted) {
      const book = (await rest.getBookTicker?.(t.symbol).catch(() => null)) as {
        bidPrice?: string;
        askPrice?: string;
      } | null;
      px = Number(long ? book?.bidPrice : book?.askPrice);
      if (!(px > 0) || (long ? px < lockPrice : px > lockPrice)) return; // not there (or no price) -> nothing to do
      // remember the attempt BEFORE placing, so a crash right after placing is found and adopted next cycle
      if (!t.lockPending) {
        await this.repo.updateTrade(t.tradeId, { lockPending: true });
        t.lockPending = true;
      }
    }
    if (newAlgoId === null) {
      try {
        const res = (await rest.createAlgoOrder({
          symbol: t.symbol,
          side: long ? "SELL" : "BUY",
          type: "STOP_MARKET",
          triggerPrice: newSl.toFixed(filters.pricePrecision),
          quantity: t.quantity!.toFixed(filters.qtyPrecision),
          reduceOnly: "true",
          clientAlgoId: newClientId,
        })) as { algoId: number };
        newAlgoId = Number(res.algoId);
      } catch (err) {
        log.warn(
          {
            tradeId: t.tradeId,
            price: px,
            newSl,
            err: err instanceof Error ? err.message : String(err),
          },
          "[V9_PROFIT_LOCK_REJECTED] -- the original SL stays, retried next cycle",
        );
        return;
      }
    }
    if (
      !(newAlgoId > 0) ||
      !(await verifyAlgoOrderOpen(rest, t.symbol, newAlgoId, newClientId))
    ) {
      log.error(
        { tradeId: t.tradeId, newAlgoId },
        "[V9_PROFIT_LOCK_UNCONFIRMED] -- the original SL stays; the unconfirmed new stop is cancelled",
      );
      await cancelOwnAlgoOrder(
        rest,
        t.symbol,
        newAlgoId && newAlgoId > 0 ? newAlgoId : null,
        newClientId,
      );
      return;
    }
    const binance = {
      ...t.binance,
      slAlgoId: newAlgoId,
      slClientAlgoId: newClientId,
      slOldAlgoId: t.binance.slAlgoId,
      slOldClientAlgoId: t.binance.slClientAlgoId,
    };
    const locked: V9TradeDoc = {
      ...t,
      binance,
      lockedAt: this.now(),
      slInitial: sl0,
      slPrice: newSl,
      lockPending: false,
    };
    await this.repo.updateTrade(t.tradeId, {
      binance,
      lockedAt: locked.lockedAt,
      slInitial: sl0,
      slPrice: newSl,
      lockPending: false,
    });
    log.warn(
      { tradeId: t.tradeId, price: px, newSl, newAlgoId, adopted },
      "[V9_PROFIT_LOCK]",
    );
    await this.notify(u, formatV9Lock(locked, newSl));
    await this.cancelOldSl(locked, rest);
  }

  /** Cancels the replaced (original) stop; kept on the trade until Binance no longer lists it, retried every cycle. */
  private async cancelOldSl(
    t: V9TradeDoc,
    rest: NonNullable<V9UserRef["binanceRest"]>,
  ): Promise<void> {
    const oldId = t.binance?.slOldAlgoId ?? null,
      oldClient = t.binance?.slOldClientAlgoId;
    if (!oldClient) return;
    await cancelOwnAlgoOrder(rest, t.symbol, oldId, oldClient);
    try {
      const open = (await rest.getOpenAlgoOrders(t.symbol)) as Array<{
        algoId?: number | string;
        clientAlgoId?: string;
      }>;
      if (
        Array.isArray(open) &&
        open.some(
          (o) =>
            o.clientAlgoId === oldClient ||
            (oldId !== null && Number(o.algoId) === oldId),
        )
      ) {
        log.warn(
          { tradeId: t.tradeId, oldId },
          "[V9_OLD_SL_STILL_OPEN] -- retried next cycle",
        );
        return;
      }
    } catch {
      return;
    } // unknown -> keep it and retry next cycle
    const { slOldAlgoId: _a, slOldClientAlgoId: _b, ...rest2 } = t.binance!;
    void _a;
    void _b;
    await this.repo.updateTrade(t.tradeId, { binance: rest2 });
  }

  private async closeTrade(
    t: V9TradeDoc,
    c: Pick<
      V9TradeDoc,
      "closedAt" | "exitPrice" | "pnlUsd" | "pnlR" | "feesUsd" | "closeReason"
    >,
    user?: V9UserRef,
  ): Promise<void> {
    await this.repo.updateTrade(t.tradeId, { state: "CLOSED", ...c });
    log.warn({ tradeId: t.tradeId, ...c }, "[V9_TRADE_CLOSED]");
    const u = user ?? this.users().find((x) => x.userId === t.userId);
    if (u) await this.notify(u, formatV9Close({ ...t, state: "CLOSED", ...c }));
  }

  private async notify(u: V9UserRef, text: string): Promise<void> {
    if (!u.telegram) return;
    try {
      await u.telegram.sendMessage(text);
    } catch (err) {
      log.error(
        {
          userId: u.userId,
          err: err instanceof Error ? err.message : String(err),
        },
        "[V9_TELEGRAM_FAILED] -- isolated",
      );
    }
  }
}
