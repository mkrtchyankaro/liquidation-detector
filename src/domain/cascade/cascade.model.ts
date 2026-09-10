import type { Side } from "../../shared/common.types";
import type { CascadeWaveState } from "./cascade-candidate.service";

/**
 * Sep 10 2026 (Karo), operator-requested restart-safe persistence for
 * the production V5 multi-timeframe cascade lifecycle. ONE document per
 * (currently or formerly) active symbol cascade, in a DEDICATED
 * collection (v5_active_cascades) -- v5_global_signals is not
 * sufficient on its own because it only ever gets a row for a
 * candidate that reaches SIGNAL, never for a still-TRACKING or
 * CANCELLED one, and has no notion of "the parent cascade as a whole".
 *
 * Closed cascades are NEVER deleted -- `status` distinguishes
 * "ACTIVE" (hydrated on startup, still governs the CascadeRegistry's
 * own same-symbol block) from "CLOSED" (kept purely for historical
 * inspection, never hydrated again).
 */
export interface CascadeCandidateStateDoc {
  readonly timeframe: "1m" | "3m" | "5m";
  /** Absent (no document written yet) if this timeframe's own
   *  readiness gate (commonHorizonAtrReady) was never satisfied for
   *  this cascade -- structurally different from "NOT_STARTED" below,
   *  which means readiness WAS satisfied but no document has been
   *  written yet (should not normally persist in this state, but the
   *  type allows it defensively). */
  readonly phase:
    | "NOT_STARTED"
    | "ACTIVE"
    | "TERMINAL_SIGNAL"
    | "TERMINAL_CANCEL";
  readonly frozenUnitAbs: number | null;
  readonly currentWaveNumber: number | null;
  readonly waveHistory: readonly CascadeWaveState[];
  /** The most recently completed or active wave's own extreme price --
   *  redundant with waveHistory's own last entry, kept as a direct
   *  field purely for cheap inspection/reporting. */
  readonly currentExtreme: number | null;
  readonly terminalStatus: "SIGNAL" | "CANCEL" | null;
  readonly terminalReason: "CANCEL_NO_NEXT_WAVE" | null;
  /** Set only when terminalStatus === "SIGNAL" -- the signalId of the
   *  GlobalSignalDoc this candidate produced in v5_global_signals. */
  readonly signalId: string | null;
  readonly lastUpdatedTs: number;
}

export interface CascadeDoc {
  readonly cascadeId: string;
  readonly symbol: string;
  readonly victimSide: Side;
  readonly startedAt: number;
  readonly status: "ACTIVE" | "CLOSED";
  readonly closedAt: number | null;
  readonly candidates: {
    readonly "1m": CascadeCandidateStateDoc;
    readonly "3m": CascadeCandidateStateDoc;
    readonly "5m": CascadeCandidateStateDoc;
  };
  readonly lastUpdatedTs: number;
}

export function emptyCandidateStateDoc(
  timeframe: "1m" | "3m" | "5m",
  now: number,
): CascadeCandidateStateDoc {
  return {
    timeframe,
    phase: "NOT_STARTED",
    frozenUnitAbs: null,
    currentWaveNumber: null,
    waveHistory: [],
    currentExtreme: null,
    terminalStatus: null,
    terminalReason: null,
    signalId: null,
    lastUpdatedTs: now,
  };
}
