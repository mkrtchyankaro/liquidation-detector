import type { Collection } from "mongodb";
import type { Side } from "../../shared/common.types";
import type { MongoClientWrapper } from "./mongo.client";
import type { GlobalLifecycleState } from "../../domain/liquidation-oi-strategy/lifecycle.types";
import type { LiquidationOiUserExecutionState } from "../../domain/liquidation-oi-strategy/user-execution.types";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "lox-global-signal-repo" });

/** A document read from Mongo carries _id; never send it back in $set. */
function withoutId<T extends object>(doc: T): T {
  const { _id, ...rest } = doc as T & { _id?: unknown };
  void _id;
  return rest as T;
}

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
  initialCapacityAtr: number | null;
  initialTpPrice: number | null;
  tpRevision: number;
  /** Sep 17 2026 (Karo), operator-requested Section K -- the CURRENT
   *  live TP target, distinct from initialTpPrice (which stays the
   *  original, never-mutated value from ENTRY_READY). */
  currentTargetPrice: number | null;
  /** Sep 17 2026 (Karo), operator-requested Section E -- captured at
   *  ENTRY_READY. Strictly observational; never read by any decision. */
  orderBookAtEntryReady: import("../../domain/liquidation-oi-strategy/order-book-observation").OrderBookObservation | null;
  /** Sep 17 2026 (Karo), operator-approved final capacity architecture,
   *  Section 19 -- FROZEN at the instant of ENTRY_READY, the live
   *  atr3m value used as the TP coordinate system's normalization
   *  reference. Every subsequent TP projection (initial AND dynamic)
   *  must use THIS value, never a later, changed live ATR -- see
   *  capacity-model.ts's own projectTpFromEntry(). null only before a
   *  signal has ever reached ENTRY_READY (never null afterward). */
  atr3mAtEntry: number | null;
  /** Sep 17 2026 (Karo), operator-approved final capacity architecture,
   *  Section 22 -- OI physics baselines carried forward from the
   *  pre-entry WAIT phase, preserved through ACTIVE and restart. */
  episodeEndOiQuantity: number | null;
  episodeEndPrice: number | null;
  episodeEndTime: number | null;
  oiAtEntryQuantity: number | null;
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
      await userCol.createIndex({ userId: 1, globalSignalId: 1 }, { unique: true });
      await userCol.createIndex({ globalSignalId: 1, state: 1 });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "[LOX_GLOBAL_SIGNAL_ENSURE_INDEXES_FAILED]");
      return false;
    }
  }

  async upsertSignal(doc: Omit<LiquidationOiGlobalSignalDoc, "createdAt" | "updatedAt">): Promise<boolean> {
    try {
      const col = await this.getSignalCollection();
      if (!col) return false;
      const now = new Date();
      // Callers often pass a document they just READ from Mongo
      // ({ ...signal, state: "CLOSED" }), which still carries _id and
      // createdAt. Putting createdAt in BOTH $set and $setOnInsert makes
      // MongoDB reject the whole update ("would create a conflict at
      // 'createdAt'") -- in production every global CLOSE silently
      // failed this way and signals stayed ACTIVE. Strip them here, once.
      const { _id, createdAt, updatedAt, ...fields } = doc as typeof doc & { _id?: unknown; createdAt?: unknown; updatedAt?: unknown };
      void _id; void createdAt; void updatedAt;
      await col.updateOne({ globalSignalId: doc.globalSignalId }, { $set: { ...fields, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, globalSignalId: doc.globalSignalId }, "[LOX_GLOBAL_SIGNAL_UPSERT_FAILED]");
      return false;
    }
  }

  async findOpenSignals(): Promise<LiquidationOiGlobalSignalDoc[]> {
    const col = await this.getSignalCollection();
    if (!col) return [];
    return col.find({ state: { $nin: ["CLOSED", "CANCELLED"] } }).toArray();
  }

  /** Sep 17 2026 (Karo), operator-requested Section O. Single-doc
   *  lookup by globalSignalId, used when a decision (MAIN market exit,
   *  global close) needs to read/update ONE signal's own state. */
  async findSignal(globalSignalId: string): Promise<LiquidationOiGlobalSignalDoc | null> {
    const col = await this.getSignalCollection();
    if (!col) return null;
    return col.findOne({ globalSignalId });
  }

  /** IDEMPOTENCY: used before starting an entry sequence for a user --
   *  if a PENDING/ACTIVE row already exists for this exact (userId,
   *  globalSignalId), the caller must not start a second entry
   *  sequence. */
  async upsertUserExecution(doc: LiquidationOiUserExecutionState): Promise<boolean> {
    try {
      const col = await this.getUserExecCollection();
      if (!col) return false;
      await col.updateOne({ userId: doc.userId, globalSignalId: doc.globalSignalId }, { $set: withoutId(doc) }, { upsert: true });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, userId: doc.userId, globalSignalId: doc.globalSignalId }, "[LOX_USER_EXECUTION_UPSERT_FAILED]");
      return false;
    }
  }

  /** Sep 17 2026 (Karo), operator-reported CRITICAL FIX -- ATOMIC
   *  compare-and-swap terminal transition. A plain read-then-write
   *  (findUserExecution() followed by upsertUserExecution()) is
   *  racy: two concurrent callers can BOTH read state==="ACTIVE"
   *  before EITHER writes, since the read and the write are two
   *  separate round-trips with a window between them -- this is
   *  exactly the mechanism proven live (a fast BTCUSDT move produced
   *  overlapping ticks, and some users' close either duplicated or
   *  silently lost a write). This method makes the transition
   *  atomic at the database level: the update's FILTER itself
   *  requires state==="ACTIVE", so MongoDB guarantees only ONE
   *  concurrent caller's update can ever match and apply for a given
   *  document -- the loser's matchedCount is 0, and callers use that
   *  to skip all further processing (Telegram send, forensic events)
   *  for their own race-losing attempt, cleanly, with no separate
   *  read needed first. */
  async terminalizeIfActive(doc: LiquidationOiUserExecutionState): Promise<boolean> {
    try {
      const col = await this.getUserExecCollection();
      if (!col) return false;
      const result = await col.updateOne({ userId: doc.userId, globalSignalId: doc.globalSignalId, state: "ACTIVE" }, { $set: withoutId(doc) });
      return result.matchedCount > 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, userId: doc.userId, globalSignalId: doc.globalSignalId }, "[LOX_USER_EXECUTION_TERMINALIZE_IF_ACTIVE_FAILED]");
      return false;
    }
  }

  async findUserExecution(userId: string, globalSignalId: string): Promise<LiquidationOiUserExecutionState | null> {
    const col = await this.getUserExecCollection();
    if (!col) return null;
    return col.findOne({ userId, globalSignalId });
  }

  async findUserExecutionsForSignal(globalSignalId: string): Promise<LiquidationOiUserExecutionState[]> {
    const col = await this.getUserExecCollection();
    if (!col) return [];
    return col.find({ globalSignalId }).toArray();
  }

  /** Sep 17 2026 (Karo), operator-requested Section L/M. Every user
   *  execution row whose OWN state is still "ACTIVE", OR whose
   *  cleanupState is "FAILED_RETRYING" (needs another cleanup attempt)
   *  -- the two categories the periodic reconciler must act on. Rows
   *  already TERMINAL+COMPLETE are never re-touched. */
  async findNonTerminalUserExecutions(): Promise<LiquidationOiUserExecutionState[]> {
    const col = await this.getUserExecCollection();
    if (!col) return [];
    return col.find({ $or: [{ state: "ACTIVE" }, { cleanupState: "FAILED_RETRYING" }] }).toArray();
  }
}
