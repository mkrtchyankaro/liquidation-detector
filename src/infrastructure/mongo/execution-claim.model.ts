/**
 * Sep 4 2026, operator-approved (Karo). Minimal SHARED execution-claim
 * model -- global ownership/dedup ONLY, separate from
 * ExecutionRecordDoc (execution-record.model.ts), which remains
 * bot-local (audit trail: order IDs, fill prices, status history) in
 * execution_records / execution_records_friend / execution_records_brother.
 *
 * Why this split exists (full investigation in the conversation this
 * was built from): execution_records was found to answer only "has
 * this signalId already been armed" -- a narrow, bot-local claim
 * concern -- never "is there a still-open live position" (that
 * question is answered by paper_signals's own findOpenLiveSymbols(),
 * unrelated and untouched by this change). But the SAME collection
 * was also being used, bot-locally, for the one-active-trade-per-
 * symbol gate -- which needs to be GLOBAL (MAIN/FRIEND/BROTHER must
 * all see each other's claims) to actually prevent duplicate real
 * execution once a signalId is shared via candidate consumption. This
 * model is the minimal, purpose-built collection for that global
 * concern ONLY -- it carries no order IDs, no fill data, no status
 * history; that all stays in the existing bot-local
 * ExecutionRecordDoc, completely unchanged.
 *
 * Collection name is FIXED (see mongo.client.ts's own
 * executionClaims() accessor), never configurable per-bot -- mirrors
 * entryCandidates()'s own established pattern for exactly the same
 * reason: a collection that MUST be identical across every bot
 * instance must never be independently overridable, or the exact
 * divergence risk this fix addresses could silently reappear.
 *
 * Sep 4 2026, operator-approved (Karo) -- STATUS MODEL, minimal by
 * design to support both required invariants with ONE document per
 * signalId, never rewritten to a different signalId:
 *   A) PERMANENT same-signal dedup -- a unique index on signalId
 *      alone (execclaim_signalId_unique) blocks this exact signalId
 *      from ever being claimed again, at ANY status, forever.
 *   B) TEMPORARY per-symbol active lock -- a unique index on symbol,
 *      FILTERED (partialFilterExpression) to status="CLAIMED"
 *      (execclaim_symbol_active_unique) blocks a SECOND signalId from
 *      claiming the SAME symbol only WHILE the first one's status is
 *      still CLAIMED. The instant a claim transitions to TERMINAL, it
 *      no longer matches the partial filter, so the index no longer
 *      counts it -- a new signalId on that symbol can claim
 *      immediately, atomically, enforced by Mongo itself.
 * Both constraints are checked by the SAME insertOne() call in
 * tryClaim() -- the atomicity comes from Mongo enforcing both indexes
 * within one write, not from any separate read-then-write step.
 */

export type ExecutionClaimStatus = "CLAIMED" | "TERMINAL";

export interface ExecutionClaimDoc {
  signalId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  /** Which bot process claimed this signal -- "main" / "friend" /
   *  "brother" (or the raw CANDIDATE_CONSUMER_NAME/pm_id fallback),
   *  for forensics only. Never used to gate anything -- the unique
   *  indexes are the actual enforcement mechanism. */
  ownerProcess: string;
  status: ExecutionClaimStatus;
  /** Sep 4 2026, operator-approved (Karo) -- set only when status
   *  transitions to TERMINAL. Forensic only (e.g. "closed-tp",
   *  "closed-sl", "manual-close", "entry-order-not-sent",
   *  "startup-reconciliation-stale") -- never gates behavior; the
   *  status field alone is what the partial index and every caller
   *  check. */
  terminalReason?: string;
  claimedAt: number;
  updatedAt: number;
}
