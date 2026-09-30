import type { Collection, Db } from "mongodb";
import { childLogger } from "../../infrastructure/logging/logger";
import { MINUTE_BARS } from "../../collector/minute-bars";
import {
  hoursFromMinutes,
  oaExit,
  OA_DEFAULTS,
  runOa,
  type MinuteRow,
  type OaTrade,
  type PathBar,
} from "../../research/oi-accumulation";
import { oaParamsOf, type OaSettings } from "./oa-config";
import { formatOaClose, formatOaEntry } from "./oa-telegram";

const log = childLogger({ mod: "oa-paper" });

/**
 * OA PAPER -- the OI-accumulation strategy running live, PAPER ONLY (Telegram messages, never a Binance order).
 * Completely separate from V9 and ZZ: own settings, own collection (oa_paper_trades), own messages.
 *
 * Every minute at hh:mm:45 (minute_bars are written at :20):
 *   1. open OA trades: SL / TP / 48h time exit checked on the new minutes (SL first on a same-minute tie)
 *   2. once per hour, shortly after the hour closed (from hh:01:30, at most 30 min late): run EXACTLY the research
 *      engine (src/research/oi-accumulation.ts) on the last 9 days of minute_bars -> closed 1h candles. A trade whose
 *      entry is the close of the hour that just ended -> new PAPER trade + message. Never replays older ones.
 * One open OA trade per symbol (the engine itself never starts a new one while one is open).
 */
export const OA_TRADES = "oa_paper_trades";
const MINUTE_MS = 60_000,
  H = 3_600_000;
const RUN_OFFSET_MS = 45_000;
const HISTORY_MS = 9 * 24 * H;
const HOUR_READY_MS = 90_000; // wait for the hour's last minute bars
const HOUR_STALE_MS = 30 * MINUTE_MS;

export interface OaUserRef {
  userId: string;
  riskUsd: number;
  telegram: { sendMessage(text: string): Promise<unknown> } | null;
}

export interface OaTradeDoc {
  signalId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  variant: "A" | "B";
  state: "OPEN" | "CLOSED";
  episode: {
    dir: "UP" | "DOWN";
    since: number;
    movePct: number;
    oiPct: number;
  };
  oiDrop: { hour: number; pct: number; liqUsd: number; close: number };
  confirmHour: number;
  entryTs: number;
  entry: number;
  slPrice: number;
  tpPrice: number;
  slPct: number;
  rr: number;
  result: "TP" | "SL" | "TIME" | null;
  exitPrice: number | null;
  exitTs: number | null;
  minutes: number | null;
  netR: number | null;
  createdAt: Date;
}

export type MinuteLoader = (
  symbol: string,
  fromTs: number,
) => Promise<MinuteRow[]>;

export function mongoMinuteLoader(
  getDb: () => Promise<Db | null>,
): MinuteLoader {
  return async (symbol, fromTs) => {
    const db = await getDb();
    if (!db) throw new Error("Mongo unavailable");
    const rows = await db
      .collection(MINUTE_BARS)
      .find({ symbol, ts: { $gte: new Date(fromTs) } })
      .project({
        ts: 1,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        oiFirst: 1,
        oiLast: 1,
        oiMax: 1,
        longLiqUsd: 1,
        shortLiqUsd: 1,
      })
      .sort({ ts: 1 })
      .toArray();
    return rows.map((r) => ({
      ts: new Date(r.ts).getTime(),
      open: r.open ?? null,
      high: r.high ?? null,
      low: r.low ?? null,
      close: r.close ?? null,
      oiFirst: r.oiFirst ?? null,
      oiLast: r.oiLast ?? null,
      oiMax: r.oiMax ?? null,
      longLiqUsd: Number(r.longLiqUsd) || 0,
      shortLiqUsd: Number(r.shortLiqUsd) || 0,
    }));
  };
}

const toPath = (rows: readonly MinuteRow[]): PathBar[] =>
  rows
    .filter((r) => r.close !== null && r.close > 0)
    .map((r) => ({
      ts: r.ts,
      high: r.high ?? r.close!,
      low: r.low ?? r.close!,
      close: r.close!,
    }));

export function toOaDoc(t: OaTrade): OaTradeDoc {
  return {
    signalId: `oa-${t.symbol}-${new Date(t.entryTs).toISOString()}-${t.side}`,
    symbol: t.symbol,
    side: t.side,
    variant: t.variant,
    state: "OPEN",
    episode: t.episode,
    oiDrop: {
      hour: t.oiDropHour,
      pct: t.oiDropPct,
      liqUsd: t.oiDropLiqUsd,
      close: t.oiDropClose,
    },
    confirmHour: t.confirmHour,
    entryTs: t.entryTs,
    entry: t.entry,
    slPrice: t.slPrice,
    tpPrice: t.tpPrice,
    slPct: t.slPct,
    rr: t.rr,
    result: null,
    exitPrice: null,
    exitTs: null,
    minutes: null,
    netR: null,
    createdAt: new Date(),
  };
}

export class OaPaperService {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastHourRun = new Map<string, number>();

  constructor(
    private readonly settings: OaSettings,
    private readonly users: () => OaUserRef[],
    private readonly loadMinutes: MinuteLoader,
    private readonly getDb: () => Promise<Db | null>,
    private readonly now: () => number = Date.now,
  ) {}

  private async col(): Promise<Collection<OaTradeDoc>> {
    const db = await this.getDb();
    if (!db) throw new Error("Mongo unavailable");
    return db.collection<OaTradeDoc>(OA_TRADES);
  }

  async start(): Promise<void> {
    const c = await this.col();
    await c.createIndex({ signalId: 1 }, { unique: true });
    await c.createIndex({ state: 1, symbol: 1 });
    log.warn(
      `[OA_PAPER_READY] symbols=${this.settings.symbols.join(",")} users=${this.users()
        .map((u) => u.userId)
        .join(",")} -- PAPER only, no orders`,
    );
    const tick = (): void => {
      const now = this.now();
      const next =
        Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS + RUN_OFFSET_MS;
      this.timer = setTimeout(
        () => {
          void this.onMinute().finally(tick);
        },
        Math.max(1_000, next - now),
      );
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
        try {
          await this.runSymbol(symbol);
        } catch (err) {
          log.error(
            { symbol, err: err instanceof Error ? err.message : String(err) },
            "[OA_SYMBOL_FAILED] -- isolated, V9/ZZ and other symbols unaffected",
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async runSymbol(symbol: string): Promise<void> {
    const col = await this.col(),
      now = this.now();
    // 1. exits of open trades
    for (const t of await col.find({ state: "OPEN", symbol }).toArray()) {
      const path = toPath(await this.loadMinutes(symbol, t.entryTs));
      const x = oaExit(t.side, t.entry, t.slPrice, t.tpPrice, t.entryTs, path, {
        ...OA_DEFAULTS,
        rr: t.rr,
      });
      if (!x || x.result === "OPEN") continue;
      const upd: Partial<OaTradeDoc> = {
        state: "CLOSED",
        result: x.result,
        exitPrice: x.exitPrice,
        exitTs: x.exitTs,
        netR: x.netR,
        minutes: Math.round(
          ((x.exitTs ?? now) + MINUTE_MS - t.entryTs) / MINUTE_MS,
        ),
      };
      await col.updateOne(
        { signalId: t.signalId, state: "OPEN" },
        { $set: upd },
      );
      const done = { ...t, ...upd } as OaTradeDoc;
      log.warn(
        { signalId: t.signalId, result: done.result, netR: done.netR },
        "[OA_PAPER_CLOSED]",
      );
      await this.notifyAll((u) => formatOaClose(done, u.riskUsd));
    }
    // 2. new entries, once per closed hour
    const hourEnd = Math.floor(now / H) * H;
    if (
      this.lastHourRun.get(symbol) === hourEnd ||
      now - hourEnd < HOUR_READY_MS ||
      now - hourEnd > HOUR_STALE_MS
    )
      return;
    this.lastHourRun.set(symbol, hourEnd);
    const rows = await this.loadMinutes(symbol, hourEnd - HISTORY_MS);
    const hours = hoursFromMinutes(rows, hourEnd);
    if (hours.length < OA_DEFAULTS.liqMinHours + 13) return;
    const { trades } = runOa(
      symbol,
      hours,
      toPath(rows.filter((r) => r.ts < hourEnd)),
      { ...OA_DEFAULTS, ...oaParamsOf(this.settings) },
    );
    for (const t of trades.filter((x) => x.entryTs === hourEnd)) {
      if ((await col.countDocuments({ state: "OPEN", symbol })) > 0) continue;
      const doc = toOaDoc(t);
      const res = await col.updateOne(
        { signalId: doc.signalId },
        { $setOnInsert: doc },
        { upsert: true },
      );
      if (res.upsertedCount === 0) continue;
      log.warn(
        {
          signalId: doc.signalId,
          side: doc.side,
          variant: doc.variant,
          entry: doc.entry,
        },
        "[OA_PAPER_ENTRY]",
      );
      await this.notifyAll((u) => formatOaEntry(doc, u.riskUsd));
    }
  }

  private async notifyAll(text: (u: OaUserRef) => string): Promise<void> {
    for (const u of this.users()) {
      if (!u.telegram) continue;
      try {
        await u.telegram.sendMessage(text(u));
      } catch (err) {
        log.error(
          {
            userId: u.userId,
            err: err instanceof Error ? err.message : String(err),
          },
          "[OA_TELEGRAM_FAILED] -- isolated",
        );
      }
    }
  }
}
