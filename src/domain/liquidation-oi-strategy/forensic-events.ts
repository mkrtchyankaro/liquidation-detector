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
  | EpisodeTerminalEvent;

export type ClearingStateForForensics = ClearingState;
