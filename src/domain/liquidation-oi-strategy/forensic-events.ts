import type { Side } from "../../shared/common.types";
import type { ClearingState } from "./oi-clearing-detector";

/**
 * Sep 16 2026 (Karo), operator-requested. STRICTLY OBSERVABILITY.
 * Nothing in this file or its consumers may influence any strategy
 * decision -- LiquidationOiWatchManager emits these as a side effect
 * of decisions it has already made using its own existing logic,
 * unchanged. Every event is emitted only on a MEANINGFUL change (a
 * new episode, a changed watch/entry/clearing result, a progress
 * checkpoint refresh, a state transition, a terminal reason) -- never
 * on every tick, per the operator's own explicit anti-spam requirement.
 */

interface ForensicBase {
  ts: number;
  symbol: string;
  episodeId: string;
  victim: Side;
  state: string;
  episodeAgeSec: number;
}

export interface EpisodeStartEvent extends ForensicBase {
  type: "EPISODE_START";
  triggerUsd: number;
  triggerPrice: number;
  startPrice: number;
  startingOi: number | null;
}

export interface LiqAccumulatedEvent extends ForensicBase {
  type: "LIQ_ACCUMULATED";
  eventUsd: number;
  previousTotal: number;
  newTotal: number;
  meaningfulLiqProgress: boolean;
}

export interface ExtremeUpdateEvent extends ForensicBase {
  type: "EXTREME_UPDATE";
  previousExtreme: number;
  newExtreme: number;
  extensionPrice: number;
  extensionAtr: number | null;
  meaningfulExtremeProgress: boolean;
}

export interface OiProgressEvent extends ForensicBase {
  type: "OI_PROGRESS";
  startingOi: number | null;
  currentOi: number | null;
  minOi: number | null;
  destructionFraction: number | null;
  previousCheckpointDestructionFraction: number | null;
  meaningfulOiProgress: boolean;
}

export interface MeaningfulProgressRefreshEvent extends ForensicBase {
  type: "MEANINGFUL_PROGRESS_REFRESH";
  oldTimestamp: number;
  newTimestamp: number;
  trigger: "LIQ" | "EXTREME" | "OI";
  oldCheckpoint: { liqUsd: number; extreme: number; minOi: number | null };
  newCheckpoint: { liqUsd: number; extreme: number; minOi: number | null };
  thresholdCrossed: string;
}

export interface WatchEvaluationEvent extends ForensicBase {
  type: "WATCH_EVALUATION";
  totalLiqUsd: number;
  percentileRank: number | null;
  requiredPercentile: number;
  displacementAtr: number | null;
  requiredDisplacement: number;
  result: "PASS" | "FAIL";
  reasonCode: string;
  detail: string;
}

export interface StateTransitionEvent extends ForensicBase {
  type: "STATE_TRANSITION";
  from: string;
  to: string;
  reason: string;
}

export interface ClearingEvaluationEvent extends ForensicBase {
  type: "CLEARING_EVALUATION";
  windows: ReadonlyArray<{
    windowSec: number;
    slopeContractsPerSec: number | null;
    sampleCount: number;
  }>;
  peakDestructionSlopeContractsPerSec: number | null;
  windowsPassed: number;
  windowsRequired: number;
  result: "PASS" | "FAIL";
}

export interface EntryGateEvaluationEvent extends ForensicBase {
  type: "ENTRY_GATE_EVALUATION";
  atrReady: { pass: boolean; detail: string };
  oiFresh: { pass: boolean; detail: string };
  clearing: { pass: boolean; detail: string };
  counterMove: { pass: boolean; detail: string };
  distanceFromExtreme: { pass: boolean; detail: string };
  final: "ENTRY_READY" | "NO_ENTRY";
  blockedBy: readonly string[];
}

export interface EntryReadyEvent extends ForensicBase {
  type: "ENTRY_READY";
  entryReferencePrice: number;
  extreme: number;
  totalLiqUsd: number;
  percentileRank: number;
  counterMoveAtr: number;
  distanceFromExtremeAtr: number;
}

export interface EntryReadyResolutionEvent extends ForensicBase {
  type: "ENTRY_READY_RESOLUTION";
  observationEnabled: boolean;
  globalExecutionEnabled: boolean;
  eligibleUsers: number;
  enabledUsers: number;
  attemptedUsers: number;
  activeUsers: number;
  failedUsers: number;
  resolution: "ACTIVE" | "CANCELLED";
  terminalReason: string | null;
}

export interface EpisodeDeathEvaluationEvent extends ForensicBase {
  type: "EPISODE_DEATH_EVALUATION";
  lastMeaningfulProgressAt: number;
  noProgressAgeMs: number;
  noProgressTimeoutMs: number;
  episodeLifetimeMs: number;
  failsafeLifetimeMs: number;
}

export interface EpisodeTerminalEvent extends ForensicBase {
  type: "EPISODE_TERMINAL";
  reason: string;
  detail: string;
  lifetimeMs: number;
  finalTotalLiqUsd: number;
  finalPercentileRank: number | null;
  finalExtreme: number;
  lastMeaningfulProgressAt: number;
  symbolReleased: boolean;
}

// ---------------- Sep 17 2026 (Karo), Section 14: post-entry vocabulary ----------------

export interface RealEntryAttemptEvent extends ForensicBase {
  type: "REAL_ENTRY_ATTEMPT";
  userId: string;
}
export interface RealEntryConfirmedEvent extends ForensicBase {
  type: "REAL_ENTRY_CONFIRMED";
  userId: string;
  entryPrice: number;
  quantity: number;
}
export interface ProtectionConfirmedEvent extends ForensicBase {
  type: "PROTECTION_CONFIRMED";
  userId: string;
  emergencyHardStopPrice: number;
}
export interface TpConfirmedEvent extends ForensicBase {
  type: "TP_CONFIRMED";
  userId: string;
  tpPrice: number;
}
export interface GlobalActiveEvent extends ForensicBase {
  type: "GLOBAL_ACTIVE";
}
export interface ThesisStateChangedEvent extends ForensicBase {
  type: "THESIS_STATE_CHANGED";
  from: string;
  to: string;
}
export interface StrategyInvalidationEvent extends ForensicBase {
  type: "STRATEGY_INVALIDATION";
  currentPrice: number;
  strategyInvalidationPrice: number;
}
export interface OiPriceEfficiencyChangedEvent extends ForensicBase {
  type: "OI_PRICE_EFFICIENCY_CHANGED";
  from: string;
  to: string;
  deltaOiPct: number | null;
  deltaPriceAtr: number | null;
  consecutiveAdverseCount: number;
}
export interface TpRevisionRequestedEvent extends ForensicBase {
  type: "TP_REVISION_REQUESTED";
  decision: string;
  reason: string;
  proposedTargetPrice: number | null;
}
export interface TpRevisionAppliedEvent extends ForensicBase {
  type: "TP_REVISION_APPLIED";
  userId: string;
  revision: number;
  newTargetPrice: number;
}
export interface MarketExitRequestedEvent extends ForensicBase {
  type: "MARKET_EXIT_REQUESTED";
  reason: string;
}
export interface UserMarketExitConfirmedEvent extends ForensicBase {
  type: "USER_MARKET_EXIT_CONFIRMED";
  userId: string;
}
export interface PositionTerminalDetectedEvent extends ForensicBase {
  type: "POSITION_TERMINAL_DETECTED";
  userId: string;
  reason: string;
}
export interface CleanupStartedEvent extends ForensicBase {
  type: "CLEANUP_STARTED";
  userId: string;
}
export interface OrderCancelledEvent extends ForensicBase {
  type: "ORDER_CANCELLED";
  userId: string;
  purpose: string;
}
export interface CleanupCompleteEvent extends ForensicBase {
  type: "CLEANUP_COMPLETE";
  userId: string;
}
export interface CleanupFailedRetryingEvent extends ForensicBase {
  type: "CLEANUP_FAILED_RETRYING";
  userId: string;
  reason: string;
}
export interface GlobalClosingEvent extends ForensicBase {
  type: "GLOBAL_CLOSING";
}
export interface GlobalClosedEvent extends ForensicBase {
  type: "GLOBAL_CLOSED";
}
export interface SymbolReleasedEvent extends ForensicBase {
  type: "SYMBOL_RELEASED";
}
export interface RestartReconciliationEvent extends ForensicBase {
  type: "RESTART_RECONCILIATION";
  outcome: string;
  detail: string;
}

export type ForensicEvent =
  | EpisodeStartEvent
  | LiqAccumulatedEvent
  | ExtremeUpdateEvent
  | OiProgressEvent
  | MeaningfulProgressRefreshEvent
  | WatchEvaluationEvent
  | StateTransitionEvent
  | ClearingEvaluationEvent
  | EntryGateEvaluationEvent
  | EntryReadyEvent
  | EntryReadyResolutionEvent
  | EpisodeDeathEvaluationEvent
  | EpisodeTerminalEvent
  | RealEntryAttemptEvent
  | RealEntryConfirmedEvent
  | ProtectionConfirmedEvent
  | TpConfirmedEvent
  | GlobalActiveEvent
  | ThesisStateChangedEvent
  | StrategyInvalidationEvent
  | OiPriceEfficiencyChangedEvent
  | TpRevisionRequestedEvent
  | TpRevisionAppliedEvent
  | MarketExitRequestedEvent
  | UserMarketExitConfirmedEvent
  | PositionTerminalDetectedEvent
  | CleanupStartedEvent
  | OrderCancelledEvent
  | CleanupCompleteEvent
  | CleanupFailedRetryingEvent
  | GlobalClosingEvent
  | GlobalClosedEvent
  | SymbolReleasedEvent
  | RestartReconciliationEvent;

export type ClearingStateForForensics = ClearingState;
