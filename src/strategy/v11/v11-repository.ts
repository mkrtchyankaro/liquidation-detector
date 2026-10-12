import type { Db } from "mongodb";
import { otherOpenRealTrade, otherRealTradeSince } from "../../execution/other-trades";
import type { V11Confirm, V11Side, V11Wick } from "./v11-engine";

/**
 * V11 storage -- its own collections:
 *   v11_signals  one row per signal (unique signalId) -- also what makes a signal handled exactly once, across restarts
 *   v11_trades   one row per (signal, user) (unique tradeId)
 * V10's v10_trades is only READ: never a V11 REAL trade on a symbol where the same user has a REAL V10 trade open.
 */
export const V11_SIGNALS = "v11_signals";
export const V11_TRADES = "v11_trades";

export interface V11SignalDoc {
  /** `v11-2026-10-12T14:00-XRP-SHORT` (the entry hour) */
  signalId: string;
  symbol: string;
  side: V11Side;
  wick: V11Wick;
  confirm: V11Confirm;
  /** the entry hour's open (ms) and its open price (Binance 1h kline) = the signal price */
  entryT: number;
  price: number;
  /** the wick's high (LONG: low) -- before any user's buffer */
  stop: number;
  createdAt: Date;
}

export type V11TradeState = "OPEN" | "CLOSED" | "FAILED" | "SKIPPED";
export type V11CloseReason =
  | "MANUAL_CLOSE"
  | "TP_FILLED"
  | "SL_FILLED"
  | "POSITION_CLOSED_EXTERNALLY"
  | "CLOSED_NO_FILLS_FOUND"
  | "FAILSAFE_CLOSED"
  | "TIMEOUT_CLOSED";

export interface V11TradeDoc {
  /** `${signalId}:${userId}` */
  tradeId: string;
  /** = signalId -- the id the Binance client order ids are made from */
  orderSignalId: string;
  signalId: string;
  userId: string;
  mode: "PAPER" | "REAL";
  symbol: string;
  side: V11Side;
  state: V11TradeState;
  /** the entry hour's open (ms) */
  createdAt: number;
  entryPrice: number | null;
  slPrice: number | null;
  tpPrice: number | null;
  /** the planned TP price (from the signal price) -- also what an adopted REAL trade gets as its TP */
  tpTarget: number;
  tpR: number;
  /** SL distance from the signal price, % */
  riskPct: number;
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
  closeReason: V11CloseReason | null;
  failureReason: string | null;
  closeAttempts: number;
  entryInProgress: boolean;
  /** REAL: just before the entry order was sent (our fills start after it); null for PAPER */
  entryStartedAt: number | null;
  /** REAL: how many monitor cycles in a row could not settle it (the user is told once) */
  retries?: number;
  /** closed at market at this time if still open (absent = no limit); REAL: when our market close filled */
  timeoutAt?: number;
  timeoutSentAt?: number;
  /** copied from the signal for reading the table later */
  rallyType: string;
  meaningful: boolean;
}

export interface V11Store {
  ensureIndexes(): Promise<void>;
  /** false = this signal was already handled */
  insertSignal(doc: V11SignalDoc): Promise<boolean>;
  /** false = this trade already exists */
  insertTrade(doc: V11TradeDoc): Promise<boolean>;
  updateTrade(tradeId: string, fields: Partial<V11TradeDoc>): Promise<void>;
  findOpenTrades(): Promise<V11TradeDoc[]>;
  /** does this user have a REAL trade of another strategy (V10) open on this symbol? */
  hasOpenOtherTrade(userId: string, symbol: string): Promise<boolean>;
  /** when a REAL trade of another strategy (V10), still open on this symbol, was started at or after `after` (ms), else null */
  openOtherTradeSince(userId: string, symbol: string, after: number): Promise<number | null>;
}

const isDup = (err: unknown): boolean => (err as { code?: number })?.code === 11000;

export class V11Repository implements V11Store {
  constructor(private readonly getDb: () => Promise<Db | null>) {}

  private async db(): Promise<Db> {
    const db = await this.getDb();
    if (!db) throw new Error("Mongo unavailable");
    return db;
  }

  async ensureIndexes(): Promise<void> {
    const db = await this.db();
    await db.collection(V11_SIGNALS).createIndex({ signalId: 1 }, { unique: true });
    await db.collection(V11_TRADES).createIndex({ tradeId: 1 }, { unique: true });
    await db.collection(V11_TRADES).createIndex({ state: 1, userId: 1, symbol: 1 });
  }

  async insertSignal(doc: V11SignalDoc): Promise<boolean> {
    try { await (await this.db()).collection<V11SignalDoc>(V11_SIGNALS).insertOne({ ...doc }); return true; }
    catch (err) { if (isDup(err)) return false; throw err; }
  }

  async insertTrade(doc: V11TradeDoc): Promise<boolean> {
    try { await (await this.db()).collection<V11TradeDoc>(V11_TRADES).insertOne({ ...doc }); return true; }
    catch (err) { if (isDup(err)) return false; throw err; }
  }

  async updateTrade(tradeId: string, fields: Partial<V11TradeDoc>): Promise<void> {
    await (await this.db()).collection<V11TradeDoc>(V11_TRADES).updateOne({ tradeId }, { $set: fields });
  }

  async findOpenTrades(): Promise<V11TradeDoc[]> {
    return (await this.db()).collection<V11TradeDoc>(V11_TRADES).find({ state: "OPEN" }, { projection: { _id: 0 } }).toArray() as Promise<V11TradeDoc[]>;
  }

  async hasOpenOtherTrade(userId: string, symbol: string): Promise<boolean> {
    return (await otherOpenRealTrade(await this.db(), "V11", userId, symbol)) !== null;
  }

  async openOtherTradeSince(userId: string, symbol: string, after: number): Promise<number | null> {
    return otherRealTradeSince(await this.db(), "V11", userId, symbol, after);
  }
}
