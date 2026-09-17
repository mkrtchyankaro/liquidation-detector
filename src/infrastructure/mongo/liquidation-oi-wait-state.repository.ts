import type { Collection } from "mongodb";
import type { Side } from "../../shared/common.types";
import type { MongoClientWrapper } from "./mongo.client";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "lox-wait-state-repo" });

/**
 * Sep 17 2026 (Karo), operator-approved final capacity architecture,
 * Section 31 -- restart-safe WAIT persistence. One doc per symbol
 * currently in WAIT_FOR_POST_EPISODE_OI_CREATION; deleted the instant
 * the symbol leaves that state (forward to ENTRY_READY, back to
 * EXHAUSTION_CANDIDATE via provisional-end reopen, or CANCELLED).
 */
export interface LiquidationOiWaitStateDoc {
  symbol: string;
  ownershipId: string;
  episodeId: string;
  victim: Side;
  firstLiqTs: number;
  latestLiqTs: number;
  eventCount: number;
  sameDirectionLiqUsd: number;
  startPrice: number;
  extremePrice: number;
  extremeTs: number;
  startOiQuantity: number | null;
  currentOiQuantity: number | null;
  currentOiTs: number | null;
  minOiQuantity: number | null;
  minOiTs: number | null;
  episodeEndOiQuantity: number | null;
  episodeEndPrice: number | null;
  episodeEndTime: number | null;
  updatedAt: Date;
}

export class LiquidationOiWaitStateRepository {
  constructor(private readonly mongo: MongoClientWrapper) {}

  private async getCollection(): Promise<Collection<LiquidationOiWaitStateDoc> | null> {
    return this.mongo.liquidationOiWaitStates();
  }

  async ensureIndexes(): Promise<boolean> {
    try {
      const col = await this.getCollection();
      if (!col) return false;
      await col.createIndex({ symbol: 1 }, { unique: true });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "[LOX_WAIT_STATE_ENSURE_INDEXES_FAILED]");
      return false;
    }
  }

  async upsert(doc: Omit<LiquidationOiWaitStateDoc, "updatedAt">): Promise<boolean> {
    try {
      const col = await this.getCollection();
      if (!col) return false;
      await col.updateOne({ symbol: doc.symbol }, { $set: { ...doc, updatedAt: new Date() } }, { upsert: true });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, symbol: doc.symbol }, "[LOX_WAIT_STATE_UPSERT_FAILED]");
      return false;
    }
  }

  async delete(symbol: string): Promise<boolean> {
    try {
      const col = await this.getCollection();
      if (!col) return false;
      await col.deleteOne({ symbol });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, symbol }, "[LOX_WAIT_STATE_DELETE_FAILED]");
      return false;
    }
  }

  async findAll(): Promise<LiquidationOiWaitStateDoc[]> {
    try {
      const col = await this.getCollection();
      if (!col) return [];
      return await col.find({}).toArray();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "[LOX_WAIT_STATE_FIND_ALL_FAILED]");
      return [];
    }
  }
}
