import type { Collection } from "mongodb";
import type { MongoClientWrapper } from "./mongo.client";
import type { StrategyOrderPurpose } from "../../domain/liquidation-oi-strategy/strategy-order-identity";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "strategy-order-repo" });

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 1.
 * INVARIANT 3: every strategy-created Binance order must be traceable
 * to userId + globalSignalId + purpose + revision. This collection is
 * that trace. Every terminal-cleanup and orphan-recovery decision
 * queries this table -- never infers ownership from symbol alone.
 *
 * Production-critical, NOT observational data -- no TTL. Additive,
 * new collection; does not touch execution_records_<userId> or
 * execution_claims_<userId>, which remain untouched.
 */

export type StrategyOrderState = "OPEN" | "FILLED" | "CANCELLED" | "REJECTED";

export interface StrategyOrderDoc {
  userId: string;
  globalSignalId: string;
  symbol: string;
  purpose: StrategyOrderPurpose;
  revision: number;
  clientOrderId: string;
  clientAlgoId: string | null;
  binanceOrderId: number | null;
  binanceAlgoId: number | null;
  state: StrategyOrderState;
  createdAt: Date;
  updatedAt: Date;
}

export class StrategyOrderRepository {
  constructor(private readonly mongo: MongoClientWrapper) {}

  private async getCollection(): Promise<Collection<StrategyOrderDoc> | null> {
    return this.mongo.strategyOrders();
  }

  async ensureIndexes(): Promise<boolean> {
    try {
      const col = await this.getCollection();
      if (!col) return false;
      await col.createIndex(
        { userId: 1, globalSignalId: 1, purpose: 1, revision: 1 },
        { unique: true },
      );
      await col.createIndex({ globalSignalId: 1, state: 1 });
      await col.createIndex({ state: 1 });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "[STRATEGY_ORDER_ENSURE_INDEXES_FAILED]");
      return false;
    }
  }

  async upsert(
    doc: Omit<StrategyOrderDoc, "createdAt" | "updatedAt">,
  ): Promise<boolean> {
    try {
      const col = await this.getCollection();
      if (!col) return false;
      const now = new Date();
      await col.updateOne(
        {
          userId: doc.userId,
          globalSignalId: doc.globalSignalId,
          purpose: doc.purpose,
          revision: doc.revision,
        },
        { $set: { ...doc, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err: msg,
          userId: doc.userId,
          globalSignalId: doc.globalSignalId,
          purpose: doc.purpose,
        },
        "[STRATEGY_ORDER_UPSERT_FAILED]",
      );
      return false;
    }
  }

  async setState(
    userId: string,
    globalSignalId: string,
    purpose: StrategyOrderPurpose,
    revision: number,
    state: StrategyOrderState,
  ): Promise<boolean> {
    try {
      const col = await this.getCollection();
      if (!col) return false;
      const res = await col.updateOne(
        { userId, globalSignalId, purpose, revision },
        { $set: { state, updatedAt: new Date() } },
      );
      return res.matchedCount > 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId, globalSignalId, purpose },
        "[STRATEGY_ORDER_SET_STATE_FAILED]",
      );
      return false;
    }
  }

  async findUnresolved(
    userId: string,
    globalSignalId: string,
  ): Promise<StrategyOrderDoc[]> {
    const col = await this.getCollection();
    if (!col) return [];
    return col
      .find({ userId, globalSignalId, state: { $in: ["OPEN", "FILLED"] } })
      .toArray();
  }

  async findAllUnresolved(): Promise<StrategyOrderDoc[]> {
    const col = await this.getCollection();
    if (!col) return [];
    return col.find({ state: { $in: ["OPEN", "FILLED"] } }).toArray();
  }

  async countUnresolved(globalSignalId: string): Promise<number> {
    const col = await this.getCollection();
    if (!col) return 0;
    return col.countDocuments({
      globalSignalId,
      state: { $in: ["OPEN", "FILLED"] },
    });
  }
}
