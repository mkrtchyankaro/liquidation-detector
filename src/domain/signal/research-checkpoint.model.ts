/**
 * Sep 8 2026 (Karo). GLOBAL research observations -- explicitly NOT
 * per-user (see GlobalSignalDoc's own doc comment: these are the same
 * market facts for every user, karo/friend/artak alike). Anchored to
 * three moments in an episode's own lifecycle, not only "after a real
 * entry" -- this is what lets rejected/no-entry episodes remain
 * researchable, avoiding selection bias toward only-entered setups.
 *
 * Deliberately SPARSE (5 fixed offsets, never per-tick) -- see
 * ResearchCheckpointTracker's own doc comment for the exact
 * registration/completion lifecycle.
 */

export type ResearchCheckpointAnchor =
  | "EXHAUSTION_CANDIDATE" // a layer became an exhaustion candidate, but no signal ultimately fired (evaluateSignal rejected it, e.g. WAVE_CHRONOLOGY_INVALID)
  | "SIGNAL" // a real signal fired (status="SIGNAL") -- anchored at the canonical entry
  | "EPISODE_END"; // episode terminated without ever reaching an exhaustion-candidate at all (e.g. W1_EXTREME_TOO_SMALL, single-event, inactivity/safety-timeout)

export type ResearchCheckpointOffset =
  | "30s"
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "60m";

export interface ResearchCheckpoint {
  offsetLabel: ResearchCheckpointOffset;
  /** Actual elapsed ms since the anchor at the tick this was recorded
   *  (always >= the offset's own nominal target, e.g. >=30000 for "30s"). */
  atMs: number;
  price: number;
  /** For anchorType="SIGNAL": R-normalized (canonical entry/SL
   *  distance). For "EXHAUSTION_CANDIDATE"/"EPISODE_END": ATR(15m)-
   *  normalized instead (no real SL exists for a non-signal episode).
   *  Either way: cumulative favorable/adverse excursion SINCE the
   *  anchor, up to this checkpoint's own timestamp -- not just the
   *  instantaneous value at this one tick. */
  mfe: number;
  mae: number;
  /** "R" for SIGNAL anchors, "ATR" for the other two -- so a reader
   *  never has to guess which normalization mfe/mae used. */
  normalization: "R" | "ATR";
}

export interface ResearchCheckpointGroup {
  anchorType: ResearchCheckpointAnchor;
  anchorTs: number;
  anchorPrice: number;
  checkpoints: ResearchCheckpoint[];
}
