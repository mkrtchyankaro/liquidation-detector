/** Aug 2026, live-execution idempotency (production hardening).
 *
 *  One document per attempted execution, keyed uniquely by signalId.
 *  The INSERT of this document (with a unique index on signalId) is
 *  the actual idempotency anchor — it survives PM2 restarts, unlike
 *  an in-memory Set. If a second execution attempt for the same
 *  signalId is ever made (e.g. from a future retry path, or a
 *  restart-timing edge case), the insert fails on the unique
 *  constraint and execution refuses to proceed for that signal, full
 *  stop — regardless of what's in any in-memory state.
 *
 *  status values:
 *    PENDING_ENTRY   — record created, entry order not yet confirmed
 *    ENTRY_AMBIGUOUS — entry order response was lost (timeout/error)
 *                      and reconciliation could not yet confirm either
 *                      way; execution is halted until resolved
 *    ENTRY_FILLED    — entry confirmed filled (fully or partially)
 *    SL_PLACED       — stop-loss confirmed resting
 *    TP_PLACED       — take-profit confirmed resting (terminal-success)
 *    ABORTED         — execution stopped cleanly before any real
 *                      position was opened (e.g. plan invalid, entry
 *                      genuinely never sent)
 *    ABORTED_LOW_RR  — entry filled, but the ACTUAL risk/reward
 *                      recalculated from the real fill price fell
 *                      below the minimum threshold; position was
 *                      market-closed immediately, before SL/TP were
 *                      ever placed
 *    EMERGENCY_CLOSED — SL failed verification; position was
 *                      force-closed at market
 *    ORPHAN_HALT     — reconciliation found a position/order this
 *                      record can't account for; global halt engaged
 *    CLOSED_TP       — Sep 4 2026, operator-approved (Karo) --
 *                      cross-process ACTIVE-trade dedup. Position
 *                      confirmed CLOSED via TP, per
 *                      BinanceExecutionService.reconcileLivePosition()
 *                      (or reconcileMicroLivePosition()). Genuinely
 *                      terminal -- distinct from TP_PLACED, which only
 *                      means the TP order is resting, not that it has
 *                      fired. This is what makes a symbol "no longer
 *                      ACTIVE" for the one-active-trade-per-symbol
 *                      gate; TP_PLACED alone does NOT.
 *    CLOSED_SL       — same as CLOSED_TP, for a confirmed SL fire.
 *    CLOSED_PRE_DEPLOYMENT_BACKLOG — Sep 4 2026, operator-approved
 *                      (Karo). ONE-TIME BACKLOG CLEANUP ONLY. Applied
 *                      to legacy execution records that predate the
 *                      CLOSED_TP/CLOSED_SL mechanism (i.e. every
 *                      record created before this session's own
 *                      recordConfirmedClose() existed): those records
 *                      could never have transitioned past
 *                      TP_PLACED/SL_PLACED, since nothing in the old
 *                      code ever moved them further, even though the
 *                      real position had long since closed on Binance.
 *                      Deliberately DISTINCT from CLOSED_TP/CLOSED_SL
 *                      -- we have no trustworthy record of which side
 *                      actually fired for these, and never guess that.
 *                      Terminal (frees the one-active-trade-per-symbol
 *                      slot) but must NEVER be used for a NEW trade's
 *                      close going forward -- new trades always close
 *                      as CLOSED_TP or CLOSED_SL via the real
 *                      reconciliation path. Only ever written by the
 *                      one-time remediation script
 *                      (remediate-stale-execution-records.ts), never
 *                      by any live trading code path.
 */
export type ExecutionStatus =
  | "PENDING_ENTRY"
  | "ENTRY_AMBIGUOUS"
  | "ENTRY_FILLED"
  | "SL_PLACED"
  | "TP_PLACED"
  | "ABORTED"
  | "ABORTED_LOW_RR"
  | "EMERGENCY_CLOSED"
  | "ORPHAN_HALT"
  | "CLOSED_TP"
  | "CLOSED_SL"
  | "CLOSED_PRE_DEPLOYMENT_BACKLOG";

/** Sep 4 2026, operator-approved (Karo). Statuses that mean "this
 *  symbol's execution slot is free" for the one-active-trade-per-symbol
 *  gate. A position is considered ACTIVE (still occupying the symbol's
 *  slot) at every OTHER status, including TP_PLACED/SL_PLACED --
 *  placing an exit order does not mean the position is closed, only
 *  that an order is resting. Exported so both the repository query and
 *  any test/verification code share a single definition of "closed",
 *  never two independently-maintained lists that could drift apart. */
export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> =
  new Set([
    "ABORTED",
    "ABORTED_LOW_RR",
    "EMERGENCY_CLOSED",
    "CLOSED_TP",
    "CLOSED_SL",
    "CLOSED_PRE_DEPLOYMENT_BACKLOG",
  ]);

export interface ExecutionRecordDoc {
  signalId: string;
  executionId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  status: ExecutionStatus;

  entryClientOrderId: string;
  entryOrderId: number | null;
  /** Aug 2026: since the Algo Order migration, slOrderId/tpOrderId
   *  actually store the Algo Order system's `algoId` (not a regular
   *  `orderId` — that field doesn't apply to conditional orders
   *  anymore). Field names kept as slOrderId/tpOrderId for schema
   *  stability; the value's meaning changed. entryOrderId is
   *  unaffected — MARKET entry orders still use the regular order
   *  system's orderId. */
  slClientOrderId: string;
  slOrderId: number | null;
  tpClientOrderId: string;
  tpOrderId: number | null;

  executedQty: number | null;
  averageFillPrice: number | null;

  plannedQuantity: number;
  plannedEntry: number;
  plannedSl: number;
  plannedTp: number;

  createdAt: number;
  updatedAt: number;
  /** Free-text notes for forensics — e.g. why ABORTED, what
   *  reconciliation found, retry counts. Append-only, never parsed
   *  back into logic. */
  notes: string[];
}
