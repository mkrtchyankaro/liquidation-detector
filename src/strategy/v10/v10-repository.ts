import type { Db } from "mongodb";
import type { V10BtcTurn, V10Pick, V10Side } from "./v10-engine";

/**
 * V10 storage -- its own collections, never V9's:
 *   v10_signals  one row per BTC signal (unique signalId) -- also what makes a signal handled exactly once,
 *                across restarts
 *   v10_trades   one row per (signal, alt, user) (unique tradeId)
 * V9's v9_trades is only READ, to never open a V10 REAL trade on a symbol where the same user has a V9 trade open.
 */
export const V10_SIGNALS = "v10_signals";
export const V10_TRADES = "v10_trades";

export interface V10SignalDoc {
  signalId: string;
  side: V10Side;
  btc: V10BtcTurn;
  picks: V10Pick[];
  rankWindowHours: number;
  createdAt: Date;
}

export type V10TradeState = "OPEN" | "CLOSED" | "FAILED" | "SKIPPED";
export type V10CloseReason =
  | "TP_FILLED"
  | "SL_FILLED"
  | "POSITION_CLOSED_EXTERNALLY"
  | "CLOSED_NO_FILLS_FOUND"
  | "FAILSAFE_CLOSED";

export interface V10TradeDoc {
  /** `${signalId}:${symbol}:${userId}` */
  tradeId: string;
  /** `${signalId}:${symbol}` -- the id the Binance client order ids are made from */
  orderSignalId: string;
  signalId: string;
  userId: string;
  mode: "PAPER" | "REAL";
  symbol: string;
  side: V10Side;
  pick: Pick<V10Pick, "rank" | "x" | "follow" | "coinPct" | "btcPct">;
  state: V10TradeState;
  /** the signal's candle close = the entry time */
  createdAt: number;
  entryPrice: number | null;
  slPrice: number | null;
  tpPrice: number | null;
  slPct: number;
  tpPct: number;
  quantity: number | null;
  plannedRiskUsd: number;
  actualRiskUsd: number | null;
  binance: {
    entryClientOrderId?: string;
    slAlgoId?: number;
    slClientAlgoId?: string;
    tpOrderId?: number;
    tpClientOrderId?: string;
    tpFailureReason?: string;
  } | null;
  closedAt: number | null;
  exitPrice: number | null;
  pnlUsd: number | null;
  pnlR: number | null;
  feesUsd: number | null;
  closeReason: V10CloseReason | null;
  failureReason: string | null;
  closeAttempts: number;
  entryInProgress: boolean;
  /** REAL: just before the entry order was sent (our fills start after it); null for PAPER */
  entryStartedAt: number | null;
  /** REAL: how many monitor cycles in a row could not settle it (the user is told once) */
  retries?: number;
}

export interface V10Store {
  ensureIndexes(): Promise<void>;
  /** false = this signal was already handled */
  insertSignal(doc: V10SignalDoc): Promise<boolean>;
  /** false = this trade already exists */
  insertTrade(doc: V10TradeDoc): Promise<boolean>;
  updateTrade(tradeId: string, fields: Partial<V10TradeDoc>): Promise<void>;
  findOpenTrades(): Promise<V10TradeDoc[]>;
  /** does this user have a REAL V9 trade open on this symbol? */
  hasOpenV9Trade(userId: string, symbol: string): Promise<boolean>;
  /** when a REAL V9 trade of this user, still open on this symbol, was opened at or after `after` (ms), else null */
  openV9TradeSince(
    userId: string,
    symbol: string,
    after: number,
  ): Promise<number | null>;
}

const isDup = (err: unknown): boolean =>
  (err as { code?: number })?.code === 11000;

export class V10Repository implements V10Store {
  constructor(private readonly getDb: () => Promise<Db | null>) {}

  private async db(): Promise<Db> {
    const db = await this.getDb();
    if (!db) throw new Error("Mongo unavailable");
    return db;
  }

  async ensureIndexes(): Promise<void> {
    const db = await this.db();
    await db
      .collection(V10_SIGNALS)
      .createIndex({ signalId: 1 }, { unique: true });
    await db
      .collection(V10_TRADES)
      .createIndex({ tradeId: 1 }, { unique: true });
    await db
      .collection(V10_TRADES)
      .createIndex({ state: 1, userId: 1, symbol: 1 });
  }

  async insertSignal(doc: V10SignalDoc): Promise<boolean> {
    try {
      await (await this.db())
        .collection<V10SignalDoc>(V10_SIGNALS)
        .insertOne({ ...doc });
      return true;
    } catch (err) {
      if (isDup(err)) return false;
      throw err;
    }
  }

  async insertTrade(doc: V10TradeDoc): Promise<boolean> {
    try {
      await (await this.db())
        .collection<V10TradeDoc>(V10_TRADES)
        .insertOne({ ...doc });
      return true;
    } catch (err) {
      if (isDup(err)) return false;
      throw err;
    }
  }

  async updateTrade(
    tradeId: string,
    fields: Partial<V10TradeDoc>,
  ): Promise<void> {
    await (await this.db())
      .collection<V10TradeDoc>(V10_TRADES)
      .updateOne({ tradeId }, { $set: fields });
  }

  async findOpenTrades(): Promise<V10TradeDoc[]> {
    return (await this.db())
      .collection<V10TradeDoc>(V10_TRADES)
      .find({ state: "OPEN" }, { projection: { _id: 0 } })
      .toArray() as Promise<V10TradeDoc[]>;
  }

  async openV9TradeSince(
    userId: string,
    symbol: string,
    after: number,
  ): Promise<number | null> {
    const t = await (
      await this.db()
    )
      .collection("v9_trades")
      .find({
        state: "OPEN",
        mode: "REAL",
        userId,
        symbol,
        createdAt: { $gte: after },
      })
      .sort({ createdAt: 1 })
      .limit(1)
      .toArray();
    return t.length ? Number(t[0].createdAt) : null;
  }

  async hasOpenV9Trade(userId: string, symbol: string): Promise<boolean> {
    return (
      (await (await this.db())
        .collection("v9_trades")
        .countDocuments(
          { state: "OPEN", mode: "REAL", userId, symbol },
          { limit: 1 },
        )) > 0
    );
  }
}
