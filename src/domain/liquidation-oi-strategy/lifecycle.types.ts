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
  | "WAIT_FOR_POST_EPISODE_OI_CREATION"
  | "ENTRY_READY"
  | "ACTIVE"
  | "CLOSING"
  | "CLOSED"
  | "CANCELLED";

const GLOBAL_TRANSITIONS: Record<GlobalLifecycleState, readonly GlobalLifecycleState[]> = {
  IDLE: [],
  EPISODE_TRACKING: ["WATCH_QUALIFIED", "CANCELLED"],
  WATCH_QUALIFIED: ["EXHAUSTION_CANDIDATE", "CANCELLED"],
  // Sep 17 2026 (Karo), operator-requested lifecycle correction --
  // EXHAUSTION_CANDIDATE no longer jumps straight to ENTRY_READY. It
  // now means "watching for the causal, candle-confirmed episode end"
  // (the ported DISPLACEMENT_BALANCED recovery-candidate/confirm
  // structure). Reaching ENTRY_READY directly from here is no longer
  // valid -- see episode-end-detector.ts's own doc comment for why OI
  // clearing/stabilization must never be this gate.
  EXHAUSTION_CANDIDATE: ["WAIT_FOR_POST_EPISODE_OI_CREATION", "CANCELLED"],
  // New state: episode end is CAUSALLY CONFIRMED (candle/ATR
  // structure, never OI) and the post-episode OI baseline is frozen.
  // May persist across many 1m candles -- see
  // post-episode-oi-creation.ts's own doc comment for why there is
  // deliberately NO timeout here (the XRP-type delayed-OI-creation
  // case this state exists to protect).
  // Sep 17 2026 (Karo), operator-approved final capacity architecture,
  // Section 7 -- provisional episode end can be invalidated by
  // continuation liquidation flow, returning to episode-end detection.
  WAIT_FOR_POST_EPISODE_OI_CREATION: ["ENTRY_READY", "EXHAUSTION_CANDIDATE", "CANCELLED"],
  ENTRY_READY: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["CLOSING"],
  CLOSING: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

export function isValidGlobalTransition(from: GlobalLifecycleState, to: GlobalLifecycleState): boolean {
  return GLOBAL_TRANSITIONS[from].includes(to);
}

export function isGlobalTerminal(state: GlobalLifecycleState): boolean {
  return state === "CLOSED" || state === "CANCELLED";
}

/** Symbol ownership held for every non-IDLE, non-terminal state
 *  except EPISODE_TRACKING itself -- ownership begins at
 *  WATCH_QUALIFIED per the approved architecture, and is held through
 *  CLOSING (never released early). WAIT_FOR_POST_EPISODE_OI_CREATION
 *  holds ownership too -- the whole point of freezing the episode end
 *  baseline is to keep watching THIS symbol for post-episode entry
 *  evidence, not to release it. */
export function holdsSymbolOwnership(state: GlobalLifecycleState): boolean {
  return state === "WATCH_QUALIFIED" || state === "EXHAUSTION_CANDIDATE" || state === "WAIT_FOR_POST_EPISODE_OI_CREATION" || state === "ENTRY_READY" || state === "ACTIVE" || state === "CLOSING";
}

export type UserExecutionState = "PENDING" | "ACTIVE" | "TERMINAL";

export type UserTerminalReason =
  | "TP_FILLED"
  | "STRATEGY_INVALIDATION"
  | "DYNAMIC_EXIT"
  | "MANUAL_CLOSE"
  | "EMERGENCY_STOP"
  | "EXECUTION_FAILED"
  | "PROTECTION_FAILED"
  | "USER_STRATEGY_EXECUTION_DISABLED" // Sep 16 2026 (Karo), operator-requested -- this user's own liquidationOiExecutionEnabled=false, MAIN still observing globally, no order ever attempted for this user
  | "ADVERSE_OI_PRICE_EFFICIENCY_FLIP" // Sep 17 2026 (Karo), operator-requested Section J -- MAIN's confirmed adverse OI-price-efficiency thesis flip closed this user
  | "POSITION_CLOSED_EXTERNALLY"; // Sep 17 2026 (Karo), operator-requested Section L -- Binance position found flat but exact cause could not be proven from strategy-owned order status; never invented

export type CleanupState = "PENDING" | "FAILED_RETRYING" | "COMPLETE";

/** Once TERMINAL, never returns to ACTIVE or PENDING -- INVARIANT 1,
 *  enforced structurally rather than only by caller discipline. */
export function isValidUserStateTransition(from: UserExecutionState, to: UserExecutionState): boolean {
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
export function isGlobalCloseEligible(input: GlobalCloseEligibilityInput): GlobalCloseEligibilityResult {
  const reasons: string[] = [];
  const noManageableUserRemains = input.users.every((u) => u.state === "TERMINAL");
  if (!input.mainThesisTerminal && !noManageableUserRemains) reasons.push("main thesis not terminal and at least one user is still manageable");
  const allUsersTerminal = input.users.every((u) => u.state === "TERMINAL");
  if (!allUsersTerminal) reasons.push(`not all users terminal: ${input.users.filter((u) => u.state !== "TERMINAL").map((u) => u.userId).join(",")}`);
  const allCleanupComplete = input.users.every((u) => u.cleanupState === "COMPLETE");
  if (!allCleanupComplete) reasons.push(`not all users have cleanupState=COMPLETE: ${input.users.filter((u) => u.cleanupState !== "COMPLETE").map((u) => `${u.userId}:${u.cleanupState}`).join(",")}`);
  if (input.unresolvedStrategyOrderCount > 0) reasons.push(`${input.unresolvedStrategyOrderCount} unresolved strategy-owned order(s) remain`);
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
