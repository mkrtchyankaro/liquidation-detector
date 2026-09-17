import type { Collection } from "mongodb";
import type { Side } from "../../shared/common.types";
import type { MongoClientWrapper } from "./mongo.client";
import type { GlobalLifecycleState } from "../../domain/liquidation-oi-strategy/lifecycle.types";
import type { LiquidationOiUserExecutionState } from "../../domain/liquidation-oi-strategy/user-execution.types";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "lox-global-signal-repo" });

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 5-7.
 * New, dedicated collections -- structurally separate from
 * v5_global_signals/v5_signals_<userId>, never written or read by
 * V3/V5's own code paths.
 */

export interface LiquidationOiGlobalSignalDoc {
  globalSignalId: string;
  symbol: string;
  victim: Side;
  candidateSide: Side;
  state: GlobalLifecycleState;
  ownershipId: string;
  episodePercentileRank: number;
  sameDirectionLiqUsd: number;
  extremePrice: number;
  entryPrice: number | null;
  strategyInvalidationPrice: number | null;
  /** Sep 17 2026 (Karo), operator-requested -- catastrophe-only price,
   *  explicitly OUTSIDE strategyInvalidationPrice. See config.ts's own
   *  emergencyHardStopBufferAtrMultiple doc comment. */
  emergencyHardStopPrice: number | null;
  initialCapacityAtr: number | null;
  initialTpPrice: number | null;
  tpRevision: number;
  createdAt: Date;
  updatedAt: Date;
}

export class LiquidationOiGlobalSignalRepository {
  constructor(private readonly mongo: MongoClientWrapper) {}

  private async getSignalCollection(): Promise<Collection<LiquidationOiGlobalSignalDoc> | null> {
    return this.mongo.liquidationOiGlobalSignals();
  }
  private async getUserExecCollection(): Promise<Collection<LiquidationOiUserExecutionState> | null> {
    return this.mongo.liquidationOiUserExecutions();
  }

  async ensureIndexes(): Promise<boolean> {
    try {
      const sigCol = await this.getSignalCollection();
      const userCol = await this.getUserExecCollection();
      if (!sigCol || !userCol) return false;
      await sigCol.createIndex({ globalSignalId: 1 }, { unique: true });
      await sigCol.createIndex({ symbol: 1, state: 1 });
      await userCol.createIndex(
        { userId: 1, globalSignalId: 1 },
        { unique: true },
      );
      await userCol.createIndex({ globalSignalId: 1, state: 1 });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "[LOX_GLOBAL_SIGNAL_ENSURE_INDEXES_FAILED]");
      return false;
    }
  }

  async upsertSignal(
    doc: Omit<LiquidationOiGlobalSignalDoc, "createdAt" | "updatedAt">,
  ): Promise<boolean> {
    try {
      const col = await this.getSignalCollection();
      if (!col) return false;
      const now = new Date();
      await col.updateOne(
        { globalSignalId: doc.globalSignalId },
        { $set: { ...doc, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, globalSignalId: doc.globalSignalId },
        "[LOX_GLOBAL_SIGNAL_UPSERT_FAILED]",
      );
      return false;
    }
  }

  async findOpenSignals(): Promise<LiquidationOiGlobalSignalDoc[]> {
    const col = await this.getSignalCollection();
    if (!col) return [];
    return col.find({ state: { $nin: ["CLOSED", "CANCELLED"] } }).toArray();
  }

  /** IDEMPOTENCY: used before starting an entry sequence for a user --
   *  if a PENDING/ACTIVE row already exists for this exact (userId,
   *  globalSignalId), the caller must not start a second entry
   *  sequence. */
  async upsertUserExecution(
    doc: LiquidationOiUserExecutionState,
  ): Promise<boolean> {
    try {
      const col = await this.getUserExecCollection();
      if (!col) return false;
      await col.updateOne(
        { userId: doc.userId, globalSignalId: doc.globalSignalId },
        { $set: doc },
        { upsert: true },
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId: doc.userId, globalSignalId: doc.globalSignalId },
        "[LOX_USER_EXECUTION_UPSERT_FAILED]",
      );
      return false;
    }
  }

  async findUserExecution(
    userId: string,
    globalSignalId: string,
  ): Promise<LiquidationOiUserExecutionState | null> {
    const col = await this.getUserExecCollection();
    if (!col) return null;
    return col.findOne({ userId, globalSignalId });
  }

  async findUserExecutionsForSignal(
    globalSignalId: string,
  ): Promise<LiquidationOiUserExecutionState[]> {
    const col = await this.getUserExecCollection();
    if (!col) return [];
    return col.find({ globalSignalId }).toArray();
  }
}
