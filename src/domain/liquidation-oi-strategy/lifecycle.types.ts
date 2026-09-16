import type { Side } from "../../shared/common.types";

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 1
 * (domain types / state machine / persistence / order identity).
 * Pure -- no Mongo, no Binance, no timers. State transitions are
 * validated here so nothing elsewhere can mutate lifecycle state
 * arbitrarily.
 */

export type GlobalLifecycleState =
  | "IDLE"
  | "EPISODE_TRACKING"
  | "WATCH_QUALIFIED"
  | "EXHAUSTION_CANDIDATE"
  | "ENTRY_READY"
  | "ACTIVE"
  | "CLOSING"
  | "CLOSED"
  | "CANCELLED";

const GLOBAL_TRANSITIONS: Record<
  GlobalLifecycleState,
  readonly GlobalLifecycleState[]
> = {
  IDLE: [],
  EPISODE_TRACKING: ["WATCH_QUALIFIED", "CANCELLED"],
  WATCH_QUALIFIED: ["EXHAUSTION_CANDIDATE", "CANCELLED"],
  EXHAUSTION_CANDIDATE: ["ENTRY_READY", "CANCELLED"],
  ENTRY_READY: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["CLOSING"],
  CLOSING: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

export function isValidGlobalTransition(
  from: GlobalLifecycleState,
  to: GlobalLifecycleState,
): boolean {
  return GLOBAL_TRANSITIONS[from].includes(to);
}

export function isGlobalTerminal(state: GlobalLifecycleState): boolean {
  return state === "CLOSED" || state === "CANCELLED";
}

/** Symbol ownership held for every non-IDLE, non-terminal state
 *  except EPISODE_TRACKING itself -- ownership begins at
 *  WATCH_QUALIFIED per the approved architecture, and is held through
 *  CLOSING (never released early). */
export function holdsSymbolOwnership(state: GlobalLifecycleState): boolean {
  return (
    state === "WATCH_QUALIFIED" ||
    state === "EXHAUSTION_CANDIDATE" ||
    state === "ENTRY_READY" ||
    state === "ACTIVE" ||
    state === "CLOSING"
  );
}

export type UserExecutionState = "PENDING" | "ACTIVE" | "TERMINAL";

export type UserTerminalReason =
  | "TP_FILLED"
  | "STRATEGY_INVALIDATION"
  | "DYNAMIC_EXIT"
  | "MANUAL_CLOSE"
  | "EMERGENCY_STOP"
  | "EXECUTION_FAILED"
  | "PROTECTION_FAILED";

export type CleanupState = "PENDING" | "FAILED_RETRYING" | "COMPLETE";

/** Once TERMINAL, never returns to ACTIVE or PENDING -- INVARIANT 1,
 *  enforced structurally rather than only by caller discipline. */
export function isValidUserStateTransition(
  from: UserExecutionState,
  to: UserExecutionState,
): boolean {
  if (from === "TERMINAL") return false;
  if (from === "PENDING") return to === "ACTIVE" || to === "TERMINAL";
  if (from === "ACTIVE") return to === "TERMINAL";
  return false;
}

/** INVARIANT 2: eligible for a new TP revision only when genuinely
 *  ACTIVE. */
export function isEligibleForTpRevision(state: UserExecutionState): boolean {
  return state === "ACTIVE";
}

export interface UserExecutionSummary {
  userId: string;
  state: UserExecutionState;
  cleanupState: CleanupState;
}

export interface GlobalCloseEligibilityInput {
  mainThesisTerminal: boolean;
  users: readonly UserExecutionSummary[];
  unresolvedStrategyOrderCount: number;
}

export interface GlobalCloseEligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/** CLOSED requires ALL of: (thesis terminal OR no manageable user
 *  remains) AND every user TERMINAL AND every user cleanupState
 *  COMPLETE AND zero unresolved strategy-owned orders. Never returns
 *  eligible=true on partial satisfaction. */
export function isGlobalCloseEligible(
  input: GlobalCloseEligibilityInput,
): GlobalCloseEligibilityResult {
  const reasons: string[] = [];
  const noManageableUserRemains = input.users.every(
    (u) => u.state === "TERMINAL",
  );
  if (!input.mainThesisTerminal && !noManageableUserRemains)
    reasons.push(
      "main thesis not terminal and at least one user is still manageable",
    );
  const allUsersTerminal = input.users.every((u) => u.state === "TERMINAL");
  if (!allUsersTerminal)
    reasons.push(
      `not all users terminal: ${input.users
        .filter((u) => u.state !== "TERMINAL")
        .map((u) => u.userId)
        .join(",")}`,
    );
  const allCleanupComplete = input.users.every(
    (u) => u.cleanupState === "COMPLETE",
  );
  if (!allCleanupComplete)
    reasons.push(
      `not all users have cleanupState=COMPLETE: ${input.users
        .filter((u) => u.cleanupState !== "COMPLETE")
        .map((u) => `${u.userId}:${u.cleanupState}`)
        .join(",")}`,
    );
  if (input.unresolvedStrategyOrderCount > 0)
    reasons.push(
      `${input.unresolvedStrategyOrderCount} unresolved strategy-owned order(s) remain`,
    );
  return { eligible: reasons.length === 0, reasons };
}

/** SHORT liquidation -> candidate SHORT; LONG liquidation -> candidate
 *  LONG, per the operator's own explicit philosophy (a reversal AFTER
 *  the squeeze/flush exhausts, in the SAME direction as the victim,
 *  not a reversal-of-the-liquidated-side model). Named explicitly so
 *  this is never silently inverted by a future edit. */
export function candidateTradeSideForVictim(victim: Side): Side {
  return victim;
}
