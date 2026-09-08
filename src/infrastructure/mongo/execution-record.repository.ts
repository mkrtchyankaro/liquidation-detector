import type { MongoClientWrapper } from "./mongo.client";
import type {
  ExecutionRecordDoc,
  ExecutionStatus,
} from './execution-record.model';
import { TERMINAL_EXECUTION_STATUSES } from './execution-record.model';
import { childLogger } from '../logging/logger';

const log = childLogger({ mod: "execution-record-repo" });

/**
 * Persistence layer for ExecutionRecordDoc — Aug 2026 live-execution
 * hardening. Completely separate collection/repo from paper-signal
 * logic; nothing in strategy/paper flow reads or writes here.
 *
 * The unique index on signalId is the real idempotency guarantee: it
 * is enforced by MongoDB itself, so it holds even across process
 * restarts, unlike any in-memory Set.
 */
export class ExecutionRecordRepository {
  private indexesEnsured = false;

  /** Sep 8 2026 (Karo), multi-user adaptation -- ONE instance per user,
   *  backed by that user's OWN collection (execution_records_&lt;userId&gt;).
   *  Everything else UNCHANGED from liqwatch-bot's own
   *  db/execution-record.repository.ts. */
  constructor(
    private readonly mongo: MongoClientWrapper,
    private readonly userId: string,
  ) {}

  async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) return;
    const col = await this.mongo.executionRecords(this.userId);
    if (!col) return;
    try {
      await col.createIndexes([
        { key: { signalId: 1 }, name: "execrec_signalId_unique", unique: true },
        { key: { status: 1 }, name: "execrec_status" },
        { key: { symbol: 1, status: 1 }, name: "execrec_symbol_status" },
      ]);
      this.indexesEnsured = true;
      log.info("execution record indexes ensured");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg },
        "FAILED to ensure execution record indexes — live execution must not " +
          "proceed without the unique index; treat as a startup blocker",
      );
      throw err;
    }
  }

  /** Attempts to claim a signalId for execution. Returns true only if
   *  this is the FIRST attempt ever recorded for this signalId — false
   *  means either a duplicate call in this process, or (critically) a
   *  prior attempt from before a restart. Callers MUST treat false as
   *  "refuse to execute", not as an error to retry past. */
  async tryClaim(
    doc: Omit<ExecutionRecordDoc, "status" | "updatedAt" | "notes">,
  ): Promise<boolean> {
    const col = await this.mongo.executionRecords(this.userId);
    if (!col) {
      log.error(
        "Mongo unavailable — cannot claim signalId, refusing execution",
      );
      return false;
    }
    try {
      await col.insertOne({
        ...doc,
        status: "PENDING_ENTRY",
        updatedAt: Date.now(),
        notes: [`claimed at ${new Date().toISOString()}`],
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("E11000") || msg.includes("duplicate key")) {
        log.warn(
          { signalId: doc.signalId },
          "signalId already claimed — refusing duplicate execution",
        );
      } else {
        log.error(
          { signalId: doc.signalId, err: msg },
          "unexpected error claiming signalId — refusing execution",
        );
      }
      return false;
    }
  }

  async updateStatus(
    signalId: string,
    status: ExecutionStatus,
    note?: string,
  ): Promise<void> {
    const col = await this.mongo.executionRecords(this.userId);
    if (!col) return;
    try {
      await col.updateOne(
        { signalId },
        {
          $set: { status, updatedAt: Date.now() },
          ...(note
            ? { $push: { notes: `${new Date().toISOString()}: ${note}` } }
            : {}),
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { signalId, err: msg },
        "failed to update execution record status",
      );
    }
  }

  async updateEntryOrder(
    signalId: string,
    entryOrderId: number,
  ): Promise<void> {
    const col = await this.mongo.executionRecords(this.userId);
    if (!col) return;
    try {
      await col.updateOne(
        { signalId },
        { $set: { entryOrderId, updatedAt: Date.now() } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ signalId, err: msg }, "failed to update entry order id");
    }
  }

  async updateFill(
    signalId: string,
    executedQty: number,
    averageFillPrice: number,
  ): Promise<void> {
    const col = await this.mongo.executionRecords(this.userId);
    if (!col) return;
    try {
      await col.updateOne(
        { signalId },
        {
          $set: {
            executedQty,
            averageFillPrice,
            status: "ENTRY_FILLED",
            updatedAt: Date.now(),
          },
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ signalId, err: msg }, "failed to update fill");
    }
  }

  async updateSl(signalId: string, slOrderId: number): Promise<void> {
    const col = await this.mongo.executionRecords(this.userId);
    if (!col) return;
    try {
      await col.updateOne(
        { signalId },
        { $set: { slOrderId, status: "SL_PLACED", updatedAt: Date.now() } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ signalId, err: msg }, "failed to update SL order id");
    }
  }

  async updateTp(signalId: string, tpOrderId: number): Promise<void> {
    const col = await this.mongo.executionRecords(this.userId);
    if (!col) return;
    try {
      await col.updateOne(
        { signalId },
        { $set: { tpOrderId, status: "TP_PLACED", updatedAt: Date.now() } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ signalId, err: msg }, "failed to update TP order id");
    }
  }

  async findBySignalId(signalId: string): Promise<ExecutionRecordDoc | null> {
    const col = await this.mongo.executionRecords(this.userId);
    if (!col) return null;
    try {
      return await col.findOne({ signalId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ signalId, err: msg }, "failed to read execution record");
      return null;
    }
  }

  /** Sep 4 2026, operator-approved (Karo) -- cross-process ACTIVE-
   *  trade dedup (one active trade per symbol, requirement #2). A
   *  symbol has an active trade iff any record for it is at a status
   *  NOT in TERMINAL_EXECUTION_STATUSES -- this deliberately includes
   *  TP_PLACED/SL_PLACED (order resting =/= position closed), unlike
   *  findAllOpen()'s own narrower "open for entry-reconciliation"
   *  concept below, which already (correctly, for ITS purpose) treats
   *  TP_PLACED as terminal. Reusing findAllOpen() here would be wrong:
   *  it would let a second trade open on a symbol whose TP order is
   *  merely resting, not yet filled. Works across MAIN/FRIEND/BROTHER
   *  by construction -- this queries the SAME Mongo collection every
   *  process shares, not any process-local state. */
  async findActiveBySymbol(symbol: string): Promise<ExecutionRecordDoc[]> {
    const col = await this.mongo.executionRecords(this.userId);
    if (!col) {
      log.error(
        { symbol },
        "Mongo unavailable — cannot check active-trade status for symbol, refusing execution (fail closed)",
      );
      // Fail closed: an unknown active-trade state must never be
      // treated as "symbol is free". Returning a synthetic non-empty
      // result forces the caller's own gate to block, matching
      // tryClaim()'s own fail-closed behavior on Mongo unavailability.
      return [
        {
          signalId: "MONGO_UNAVAILABLE_FAIL_CLOSED",
          status: "PENDING_ENTRY",
        } as ExecutionRecordDoc,
      ];
    }
    try {
      return await col
        .find({
          symbol,
          status: { $nin: Array.from(TERMINAL_EXECUTION_STATUSES) },
        })
        .toArray();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol, err: msg },
        "failed to query active-trade status for symbol — refusing execution (fail closed)",
      );
      return [
        {
          signalId: "QUERY_FAILED_FAIL_CLOSED",
          status: "PENDING_ENTRY",
        } as ExecutionRecordDoc,
      ];
    }
  }

  /** Records still considered "open" for reconciliation purposes —
   *  anything that isn't a clean terminal state. */
  async findAllOpen(): Promise<ExecutionRecordDoc[]> {
    const col = await this.mongo.executionRecords(this.userId);
    if (!col) return [];
    try {
      return await col
        .find({
          status: { $nin: ["TP_PLACED", "ABORTED", "EMERGENCY_CLOSED"] },
        })
        .toArray();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "failed to read open execution records");
      return [];
    }
  }
}
