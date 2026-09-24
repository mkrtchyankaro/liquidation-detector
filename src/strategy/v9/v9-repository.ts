import type { Collection, Db } from "mongodb";
import type { Victim } from "./v9-core";
import type { V9UserMode } from "./v9-config";
import { childLogger } from "../../infrastructure/logging/logger";

const log = childLogger({ mod: "v9-repo" });

/** Every confirmed episode the engine decided on (selected or not): lets
 *  the operator see exactly why a signal did or did not fire. */
export interface V9DecisionDoc {
  signalId: string;
  symbol: string;
  victim: Victim;
  reason: string;
  tradable: boolean;
  episodeStart: number;
  episodeEnd: number;
  confirmTs: number;
  evaluatedAt: number;
  checks: Record<string, boolean>;
  features: Record<string, number | boolean>;
  reference: { medianClr: number; medianMove: number; sampleCount: number };
  episode: { longUsd: number; shortUsd: number; oiDropPct: number; priceMovePct: number; parts: number };
  stopPrice: number;
  referencePrice: number;
  createdAt: Date;
}

export type V9TradeState = "OPEN" | "CLOSED" | "FAILED" | "SKIPPED";

export interface V9TradeDoc {
  tradeId: string; // `${signalId}:${userId}`
  signalId: string;
  userId: string;
  mode: Exclude<V9UserMode, "OFF">;
  symbol: string;
  side: Victim; // trade side: LONG = BUY
  state: V9TradeState;
  createdAt: number;
  entryPrice: number | null;
  slPrice: number;
  tpPrice: number | null;
  quantity: number | null;
  plannedRiskUsd: number;
  actualRiskUsd: number | null;
  rr: number;
  binance: { entryClientOrderId?: string; slAlgoId?: number; slClientAlgoId?: string; tpOrderId?: number; tpClientOrderId?: string; tpFailureReason?: string } | null;
  closedAt: number | null;
  exitPrice: number | null;
  pnlUsd: number | null;
  pnlR: number | null;
  feesUsd: number | null;
  closeReason: string | null;
  failureReason: string | null;
  closeAttempts: number;
  /** true while the entry sequence runs; the monitor never touches such a
   *  trade unless it is stuck (crash mid-entry) for several minutes. */
  entryInProgress: boolean;
}

export class V9Repository {
  private indexesEnsured = false;
  constructor(private readonly getDb: () => Promise<Db | null>) {}

  private async decisions(): Promise<Collection<V9DecisionDoc> | null> {
    const db = await this.getDb();
    return db ? db.collection<V9DecisionDoc>("v9_decisions") : null;
  }
  private async trades(): Promise<Collection<V9TradeDoc> | null> {
    const db = await this.getDb();
    return db ? db.collection<V9TradeDoc>("v9_trades") : null;
  }

  async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) return;
    const d = await this.decisions(), t = await this.trades();
    if (!d || !t) throw new Error("Mongo unavailable for V9 indexes");
    await d.createIndex({ signalId: 1 }, { unique: true });
    await d.createIndex({ symbol: 1, evaluatedAt: -1 });
    await d.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });
    await t.createIndex({ tradeId: 1 }, { unique: true });
    await t.createIndex({ state: 1 });
    await t.createIndex({ userId: 1, symbol: 1, state: 1 });
    this.indexesEnsured = true;
  }

  async insertDecision(doc: V9DecisionDoc): Promise<void> {
    const col = await this.decisions();
    if (!col) throw new Error("Mongo unavailable");
    await col.updateOne({ signalId: doc.signalId }, { $setOnInsert: doc }, { upsert: true });
  }

  /** Insert-once: returns false if this (signal, user) trade already exists
   *  -- the idempotency guard against ever entering the same signal twice. */
  async insertTrade(doc: V9TradeDoc): Promise<boolean> {
    const col = await this.trades();
    if (!col) throw new Error("Mongo unavailable");
    const res = await col.updateOne({ tradeId: doc.tradeId }, { $setOnInsert: doc }, { upsert: true });
    return res.upsertedCount === 1;
  }

  async updateTrade(tradeId: string, fields: Partial<V9TradeDoc>): Promise<void> {
    const col = await this.trades();
    if (!col) throw new Error("Mongo unavailable");
    const { tradeId: _t, ...rest } = fields;
    void _t;
    await col.updateOne({ tradeId }, { $set: rest });
  }

  async findOpenTrades(): Promise<V9TradeDoc[]> {
    const col = await this.trades();
    if (!col) return [];
    return col.find({ state: "OPEN" }, { projection: { _id: 0 } }).toArray() as Promise<V9TradeDoc[]>;
  }

  async hasOpenTrade(userId: string, symbol: string): Promise<boolean> {
    const col = await this.trades();
    if (!col) throw new Error("Mongo unavailable");
    return (await col.countDocuments({ userId, symbol, state: "OPEN" }, { limit: 1 })) > 0;
  }

  async logFailure(context: string, err: unknown): Promise<void> {
    log.error({ context, err: err instanceof Error ? err.message : String(err) }, "[V9_REPO_ERROR]");
  }
}
