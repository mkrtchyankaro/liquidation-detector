import type { Collection, Db } from "mongodb";
import { childLogger } from "../../infrastructure/logging/logger";
import { MINUTE_BARS } from "../../collector/minute-bars";
import { buildChains, buildWaves, DEFAULT_CHAIN_PARAMS, trailingOiNoise, type Chain, type ZBar } from "../../research/oi-zigzag";
import type { ZzSettings } from "./zz-config";
import { formatZzClose, formatZzEntry, formatZzSkip } from "./zz-telegram";

const log = childLogger({ mod: "zz-paper" });

/**
 * ZZ PAPER -- the OI-zigzag strategy running live, PAPER ONLY (Telegram
 * messages, never a Binance order). Completely separate from V9.
 *
 * Every minute at hh:mm:40 (after minute_bars were written at :20), per symbol:
 *   1. load the last 4 days of minute_bars
 *   2. run EXACTLY the research code (src/research/oi-zigzag.ts): OI waves
 *      with the no-look-ahead threshold, cleaning -> accumulation, A/B/C
 *      grade, late entry (TP = remaining expected move, SL = TP / 2.2)
 *   3. an A/B decision made in the minute that just closed -> PAPER trade
 *      (or a short "episode seen, no trade" note with the reason)
 *   4. open PAPER trades: SL / TP checked on each new minute's high/low
 *      (SL first when both are touched in the same minute)
 * One open trade per symbol. Every decision is stored in zz_paper_trades.
 */
export const ZZ_TRADES = "zz_paper_trades";
const MINUTE_MS = 60_000;
const RUN_OFFSET_MS = 40_000;
const HISTORY_MS = 4 * 24 * 3_600_000;
const FRESH_MS = 2 * MINUTE_MS; // only decisions from the minutes that just closed (never replay old ones after a restart)
const K = 4; // wave threshold = K x the coin's normal 15-min OI change (same as the research tool)
const TAKER = 0.05, MAKER = 0.02;

export interface ZzUserRef { userId: string; riskUsd: number; telegram: { sendMessage(text: string): Promise<unknown> } | null }

export interface ZzTradeDoc {
  signalId: string; symbol: string; grade: "A" | "B"; side: "LONG" | "SHORT" | null;
  state: "OPEN" | "CLOSED" | "SKIPPED"; skipReason: string | null;
  decidedTs: number; entry: number; slPrice: number | null; tpPrice: number | null; rr: number;
  expectedPct: number; alreadyMovedPct: number; remainingPct: number;
  cleaning: { victim: "LONG" | "SHORT"; startTs: number; endTs: number; coins: number; movePct: number; liqUsd: number };
  accumulation: { startTs: number; endTs: number; coins: number };
  quality: { speed: number; forcedPct: number; pushAtr: number };
  result: "TP" | "SL" | null; exitPrice: number | null; exitTs: number | null; minutes: number | null; netR: number | null;
  createdAt: Date;
}

export type BarLoader = (symbol: string, fromTs: number) => Promise<ZBar[]>;

/** minute_bars -> dense minute grid (missing minutes carry price/OI forward). */
export function mongoBarLoader(getDb: () => Promise<Db | null>): BarLoader {
  return async (symbol, fromTs) => {
    const db = await getDb();
    if (!db) throw new Error("Mongo unavailable");
    const rows = await db.collection(MINUTE_BARS).find({ symbol, ts: { $gte: new Date(fromTs) } })
      .project({ ts: 1, high: 1, low: 1, close: 1, oiLast: 1, longLiqUsd: 1, shortLiqUsd: 1 }).sort({ ts: 1 }).toArray();
    const out: ZBar[] = [];
    if (!rows.length) return out;
    const by = new Map(rows.map((r) => [new Date(r.ts).getTime(), r]));
    let close = NaN, oi = NaN;
    for (let ts = new Date(rows[0].ts).getTime(); ts <= new Date(rows[rows.length - 1].ts).getTime(); ts += MINUTE_MS) {
      const r = by.get(ts);
      if (r && r.close > 0) close = r.close;
      if (r && r.oiLast > 0) oi = r.oiLast;
      out.push({ ts, close, oi, high: r?.high ?? close, low: r?.low ?? close, longLiq: r?.longLiqUsd ?? 0, shortLiq: r?.shortLiqUsd ?? 0 });
    }
    return out;
  };
}

export class ZzPaperService {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly settings: ZzSettings,
    private readonly users: () => ZzUserRef[],
    private readonly loadBars: BarLoader,
    private readonly getDb: () => Promise<Db | null>,
    private readonly now: () => number = Date.now,
  ) {}

  private async col(): Promise<Collection<ZzTradeDoc>> {
    const db = await this.getDb();
    if (!db) throw new Error("Mongo unavailable");
    return db.collection<ZzTradeDoc>(ZZ_TRADES);
  }

  async start(): Promise<void> {
    const c = await this.col();
    await c.createIndex({ signalId: 1 }, { unique: true });
    await c.createIndex({ state: 1, symbol: 1 });
    log.warn(`[ZZ_PAPER_READY] symbols=${this.settings.symbols.join(",")} users=${this.users().map((u) => u.userId).join(",")} maxDelay=${this.settings.maxDelayMin}m -- PAPER only, no orders`);
    const tick = (): void => {
      const now = this.now();
      const next = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS + RUN_OFFSET_MS;
      this.timer = setTimeout(() => { void this.onMinute().finally(tick); }, Math.max(1_000, next - now));
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One round (public for tests). Each symbol isolated. */
  async onMinute(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const symbol of this.settings.symbols) {
        try { await this.runSymbol(symbol); }
        catch (err) { log.error({ symbol, err: err instanceof Error ? err.message : String(err) }, "[ZZ_SYMBOL_FAILED] -- isolated, V9 and other symbols unaffected"); }
      }
    } finally {
      this.busy = false;
    }
  }

  private async runSymbol(symbol: string): Promise<void> {
    const bars = await this.loadBars(symbol, this.now() - HISTORY_MS);
    if (bars.length < 300) return;
    const noise = trailingOiNoise(bars);
    const waves = buildWaves(bars, noise.map((n) => K * n));
    const chains = buildChains(waves, bars, { ...DEFAULT_CHAIN_PARAMS, noise15Pct: noise, maxConfirmDelayMin: this.settings.maxDelayMin });
    const lastTs = bars[bars.length - 1].ts;
    const col = await this.col();

    // 1. open trades on this symbol: SL / TP on the new minutes
    for (const t of await col.find({ state: "OPEN", symbol }).toArray()) {
      const closed = checkExit(t, bars);
      if (!closed) continue;
      await col.updateOne({ signalId: t.signalId, state: "OPEN" }, { $set: closed });
      const done = { ...t, ...closed };
      log.warn({ signalId: t.signalId, result: done.result, netR: done.netR }, "[ZZ_PAPER_CLOSED]");
      await this.notifyAll((u) => formatZzClose(done, u.riskUsd));
    }

    // 2. new A/B decisions from the minute that just closed
    for (const c of chains) {
      const t = c.trade;
      if (!t || c.quality.grade === "C" || !c.accumulation) continue;
      if (t.decidedTs < lastTs - FRESH_MS || t.decidedTs > lastTs) continue;
      const doc = toDoc(symbol, c);
      if (doc.state === "OPEN" && (await col.countDocuments({ state: "OPEN", symbol })) > 0) {
        doc.state = "SKIPPED"; doc.skipReason = "another ZZ trade is still open on this symbol";
      }
      const res = await col.updateOne({ signalId: doc.signalId }, { $setOnInsert: doc }, { upsert: true });
      if (res.upsertedCount === 0) continue; // already handled (idempotent)
      log.warn({ signalId: doc.signalId, state: doc.state, side: doc.side, reason: doc.skipReason }, "[ZZ_PAPER_DECISION]");
      await this.notifyAll((u) => (doc.state === "OPEN" ? formatZzEntry(doc, u.riskUsd) : formatZzSkip(doc)));
    }
  }

  private async notifyAll(text: (u: ZzUserRef) => string): Promise<void> {
    for (const u of this.users()) {
      if (!u.telegram) continue;
      try { await u.telegram.sendMessage(text(u)); }
      catch (err) { log.error({ userId: u.userId, err: err instanceof Error ? err.message : String(err) }, "[ZZ_TELEGRAM_FAILED] -- isolated"); }
    }
  }
}

export function toDoc(symbol: string, c: Chain): ZzTradeDoc {
  const t = c.trade!, w = c.cleaning, a = c.accumulation!;
  const pct = (v: number): number => (100 * v) / t.entry;
  return {
    signalId: `zz-${symbol}-${new Date(t.decidedTs).toISOString()}`, symbol, grade: c.quality.grade as "A" | "B",
    side: t.side, state: t.skipReason ? "SKIPPED" : "OPEN", skipReason: t.skipReason,
    decidedTs: t.decidedTs, entry: t.entry, slPrice: t.slPrice, tpPrice: t.tpPrice, rr: DEFAULT_CHAIN_PARAMS.rr,
    expectedPct: pct(c.expectedMove ?? 0), alreadyMovedPct: pct(t.alreadyMoved), remainingPct: pct(t.remaining),
    cleaning: { victim: w.kind === "SHORT_CLEANING" ? "SHORT" : "LONG", startTs: w.from.ts, endTs: w.to.ts, coins: w.coins, movePct: (100 * c.cleaningMove) / w.priceStart, liqUsd: w.kind === "SHORT_CLEANING" ? w.shortLiqUsd : w.longLiqUsd },
    accumulation: { startTs: a.from.ts, endTs: a.to.ts, coins: a.coins },
    quality: { speed: c.quality.speed, forcedPct: c.quality.forcedPct, pushAtr: c.quality.pushAtr },
    result: null, exitPrice: null, exitTs: null, minutes: null, netR: null, createdAt: new Date(),
  };
}

/** SL / TP on the minutes after the entry minute (SL first on a same-minute tie). */
export function checkExit(t: ZzTradeDoc, bars: readonly ZBar[]): Partial<ZzTradeDoc> | null {
  if (t.slPrice === null || t.tpPrice === null) return null;
  const long = t.side === "LONG";
  const risk = Math.abs(t.entry - t.slPrice), slPct = (100 * risk) / t.entry, rr = Math.abs(t.tpPrice - t.entry) / risk;
  for (const b of bars) {
    if (b.ts <= t.decidedTs) continue;
    const hitSl = long ? b.low <= t.slPrice : b.high >= t.slPrice;
    const hitTp = long ? b.high >= t.tpPrice : b.low <= t.tpPrice;
    const minutes = Math.round((b.ts - t.decidedTs) / MINUTE_MS);
    if (hitSl) return { state: "CLOSED", result: "SL", exitPrice: t.slPrice, exitTs: b.ts, minutes, netR: -1 - (2 * TAKER) / slPct };
    if (hitTp) return { state: "CLOSED", result: "TP", exitPrice: t.tpPrice, exitTs: b.ts, minutes, netR: rr - (TAKER + MAKER) / slPct };
  }
  return null;
}
