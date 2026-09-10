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
  /** Sep 10 2026 (Karo), operator-requested -- a human-readable
   *  sentence explaining terminalReason in plain language (see
   *  terminalReasonText() below), for Telegram/history/debug display
   *  without the reader needing to know the code's own vocabulary. */
  readonly terminalReasonText: string | null;
  /** Sep 10 2026 (Karo), operator-requested -- exact diagnostics
   *  proving WHY a CANCEL_NO_NEXT_WAVE cancellation happened, captured
   *  at the precise moment of cancellation. Null unless
   *  terminalReason === "CANCEL_NO_NEXT_WAVE". cancelPrice is the live
   *  price at the moment of cancellation; recoveryDistance is
   *  |cancelPrice - the last completed wave's own extreme|;
   *  recoveryUnits is recoveryDistance / frozenUnitAbs (always >= 2.0
   *  by construction, since 2x UNIT is exactly the cancellation
   *  threshold). frozenUnitAbs and currentWaveNumber above already
   *  carry the frozen UNIT and the relevant wave number -- not
   *  duplicated here. */
  readonly cancelPrice: number | null;
  readonly recoveryDistance: number | null;
  readonly recoveryUnits: number | null;
  /** Set only when terminalStatus === "SIGNAL" -- the signalId of the
   *  GlobalSignalDoc this candidate produced in v5_global_signals. */
  readonly signalId: string | null;
  /** Sep 10 2026 (Karo), operator-requested -- the exact moment this
   *  candidate reached its own terminal state (SIGNAL or CANCEL). Null
   *  while still ACTIVE/NOT_STARTED. */
  readonly terminalAt: number | null;
  readonly lastUpdatedTs: number;
}

/** Sep 10 2026 (Karo), operator-requested -- human-readable text for
 *  every terminalReason code, used by Telegram/history/debug output so
 *  the meaningful cause is always visible, not just the machine code.
 *  Deliberately a plain switch (not a Map/Record) so TypeScript itself
 *  enforces a case for every reason code that exists today, and flags
 *  a missing one the moment a new reason is ever added. */
export function terminalReasonText(
  reason: "CANCEL_NO_NEXT_WAVE",
  recoveryUnits: number | null,
): string {
  switch (reason) {
    case "CANCEL_NO_NEXT_WAVE":
      return `No next wave before ${(recoveryUnits ?? 2).toFixed(2)} UNIT recovery`;
  }
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
    terminalReasonText: null,
    cancelPrice: null,
    recoveryDistance: null,
    recoveryUnits: null,
    signalId: null,
    terminalAt: null,
    lastUpdatedTs: now,
  };
}
