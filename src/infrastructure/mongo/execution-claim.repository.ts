import type { MongoClientWrapper } from "./mongo.client";
import type { ExecutionClaimDoc } from './execution-claim.model';
import { childLogger } from '../logging/logger';

const log = childLogger({ mod: "execution-claim-repo" });

/**
 * Sep 4 2026, operator-approved (Karo). GLOBAL execution-claim
 * repository -- MAIN/FRIEND/BROTHER all read/write the SAME shared
 * collection (execution_claims, fixed name -- see
 * MongoClientWrapper.executionClaims()). execution_records (audit
 * trail) remains bot-local and untouched.
 *
 * ATOMICITY: tryClaim() is the ONLY safety guarantee. It performs a
 * single insertOne() that Mongo checks against BOTH unique indexes
 * (signalId, and symbol-filtered-to-CLAIMED) atomically. If EITHER
 * index would be violated, the insert fails and tryClaim() returns
 * false -- there is no separate read-then-write window for a race to
 * exploit. findActiveBySymbol() remains available as an early,
 * NON-atomic optimization (skip obviously-doomed work before even
 * computing a trade plan) but callers must never treat it as the
 * actual protection -- only tryClaim()'s own return value is that.
 */
export class ExecutionClaimRepository {
  private indexesEnsured = false;

  /** Sep 8 2026 (Karo), multi-user adaptation -- ONE instance per user
   *  (constructed once per enabled user at startup, see
   *  services/user-runtime-manager.ts), backed by that user's OWN
   *  Mongo collection (execution_claims_&lt;userId&gt;). Everything else
   *  in this class is UNCHANGED from liqwatch-bot's own
   *  db/execution-claim.repository.ts. */
  constructor(
    private readonly mongo: MongoClientWrapper,
    private readonly userId: string,
  ) {}

  async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) return;
    const col = await this.mongo.executionClaims(this.userId);
    if (!col) return;
    try {
      await col.createIndexes([
        {
          key: { signalId: 1 },
          name: "execclaim_signalId_unique",
          unique: true,
        },
        {
          key: { symbol: 1 },
          name: "execclaim_symbol_active_unique",
          unique: true,
          partialFilterExpression: { status: "CLAIMED" },
        },
        // Non-unique, query-performance only (startup reconciliation
        // scan, inspect-execution-claims.ts) -- carries no safety
        // meaning of its own.
        { key: { status: 1 }, name: "execclaim_status" },
      ]);
      this.indexesEnsured = true;
      log.info(
        "execution claim indexes ensured (signalId unique + symbol-active partial unique)",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg },
        "FAILED to ensure execution claim indexes — live execution must not " +
          "proceed without both unique indexes; treat as a startup blocker",
      );
      throw err;
    }
  }

  /** Attempts to claim a signalId GLOBALLY, across every bot process.
   *  A single atomic insertOne(), checked by Mongo against BOTH the
   *  permanent signalId-unique index and the CLAIMED-only
   *  symbol-unique index in the same operation. Returns true only if
   *  neither index was violated -- i.e. this signalId has never been
   *  claimed before, AND no other signalId currently holds an active
   *  (CLAIMED) claim on this symbol. Callers MUST treat false as
   *  "refuse to execute", and must never fall back to
   *  findActiveBySymbol() as a substitute safety check. */
  async tryClaim(doc: {
    signalId: string;
    symbol: string;
    side: "LONG" | "SHORT";
    ownerProcess: string;
  }): Promise<boolean> {
    const col = await this.mongo.executionClaims(this.userId);
    if (!col) {
      log.error(
        "Mongo unavailable — cannot claim signalId globally, refusing execution (fail closed)",
      );
      return false;
    }
    try {
      await col.insertOne({
        ...doc,
        status: "CLAIMED",
        claimedAt: Date.now(),
        updatedAt: Date.now(),
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isDuplicate =
        msg.includes("E11000") || msg.includes("duplicate key");
      if (isDuplicate && msg.includes("execclaim_symbol_active_unique")) {
        log.warn(
          { signalId: doc.signalId, symbol: doc.symbol },
          "another signalId already holds an ACTIVE claim on this symbol — refusing duplicate execution",
        );
      } else if (isDuplicate) {
        log.warn(
          { signalId: doc.signalId },
          "signalId already claimed globally — refusing duplicate execution",
        );
      } else {
        log.error(
          { signalId: doc.signalId, err: msg },
          "unexpected error claiming signalId globally — refusing execution (fail closed)",
        );
      }
      return false;
    }
  }

  /** EARLY, NON-ATOMIC optimization only -- lets a caller skip
   *  obviously-doomed work (trade-plan computation, wall queries)
   *  before even attempting a claim. This is NOT the safety guarantee
   *  -- tryClaim()'s own atomic insert is. Fails closed: any Mongo
   *  error is treated as "assume active, block the new entry", never
   *  as "assume free". */
  async findActiveBySymbol(symbol: string): Promise<ExecutionClaimDoc[]> {
    const col = await this.mongo.executionClaims(this.userId);
    if (!col) {
      log.error(
        { symbol },
        "Mongo unavailable — cannot check global active-claim status for symbol, refusing execution (fail closed)",
      );
      return [
        {
          signalId: "MONGO_UNAVAILABLE_FAIL_CLOSED",
          symbol,
          side: "LONG",
          ownerProcess: "unknown",
          status: "CLAIMED",
          claimedAt: 0,
          updatedAt: 0,
        },
      ];
    }
    try {
      return await col.find({ symbol, status: "CLAIMED" }).toArray();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol, err: msg },
        "failed to query global active-claim status for symbol — refusing execution (fail closed)",
      );
      return [
        {
          signalId: "QUERY_FAILED_FAIL_CLOSED",
          symbol,
          side: "LONG",
          ownerProcess: "unknown",
          status: "CLAIMED",
          claimedAt: 0,
          updatedAt: 0,
        },
      ];
    }
  }

  /** Sep 4 2026, operator-approved (Karo). Terminalizes a claim,
   *  freeing its symbol for a future claim the instant this write
   *  completes (the partial unique index no longer counts a TERMINAL
   *  document). `reason` is forensic only (see
   *  ExecutionClaimDoc.terminalReason's own doc comment) -- never
   *  gates behavior. Safe to call on an already-TERMINAL or
   *  nonexistent signalId (no-op via updateOne matching zero
   *  documents) -- callers never need to check current state first. */
  async releaseClaim(signalId: string, reason: string): Promise<void> {
    const col = await this.mongo.executionClaims(this.userId);
    if (!col) return;
    try {
      await col.updateOne(
        { signalId },
        {
          $set: {
            status: "TERMINAL",
            terminalReason: reason,
            updatedAt: Date.now(),
          },
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { signalId, reason, err: msg },
        "failed to release global execution claim",
      );
    }
  }
}
