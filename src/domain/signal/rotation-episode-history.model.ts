import type { Side } from "../../shared/common.types";

/**
 * Sep 14 2026 (Karo), operator-requested. One document per COMPLETED
 * historical ROTATION episode, reconstructed by the offline backfill
 * (scripts/backfill-rotation-episodes.ts) replaying raw liquidation
 * events + closed 1m candles through the EXACT SAME CandlePhysicsEngine
 * ROTATION logic live production uses (mode="ROTATION", same watch
 * semantics, same directional-ATR tracker) -- never a separate,
 * hand-rolled reimplementation that could drift from production.
 *
 * Deliberately a SEPARATE collection from v5_global_signals: old
 * WAVE-mode GlobalSignal records are a structurally different
 * statistical object (Wave1/Wave2-segmented episode totals, a
 * different definition of "episode" entirely) and must never leak
 * into ROTATION's own causal P95 population.
 *
 * SCOPE NOTE: this collection is populated ONLY by the offline
 * backfill script in this patch. Live production's own ROTATION
 * entry/expiry completions continue to persist to v5_global_signals
 * exactly as before (unchanged) -- getRotationCausalP95()'s own
 * query now reads BOTH this collection and v5_global_signals'
 * rotationDiagnostics-tagged records together, so backfilled history
 * and any future live-observed episodes contribute to the same
 * causal P95 population without requiring any change to the
 * already-working live entry/cancel persistence path.
 */
export interface RotationEpisodeHistoryDoc {
  /** Deterministic unique identity for idempotent backfill reruns --
   *  see ensureIndexes()'s own unique index on {symbol, victim,
   *  episodeStartTs}. Never regenerated per insert (e.g. randomUUID())
   *  -- that would defeat idempotency entirely. */
  symbol: string;
  victim: Side;
  episodeStartTs: number;
  episodeEndTs: number;
  cumulativeLiqUsd: number;
  eventCount: number;
  maxSingleLiqUsd: number;
  startPrice: number;
  adverseExtremePrice: number;
  adverseExtremeTs: number;
  preLiqDownAtr: number | null;
  preLiqUpAtr: number | null;
  finalDownAtr: number | null;
  finalUpAtr: number | null;
  durationMs: number;
  /** Always "INACTIVITY" for a backfilled episode -- a historical
   *  replay has no live "ENTRY" concept to retroactively impose, per
   *  explicit operator instruction not to invent one ("do NOT create
   *  fake historical CANCEL signals" applies symmetrically to fake
   *  historical ENTRY outcomes -- history only ever reconstructs the
   *  neutral fact "this much liquidity accumulated over this much
   *  time before going quiet"). */
  completionReason: "INACTIVITY";
  entryMode: "ROTATION";
  /** "backfill-v1" for every episode produced by the current backfill
   *  script version -- if the reconstruction algorithm ever changes
   *  in a way that would produce different episode boundaries for the
   *  SAME raw data, bump this so old and new-algorithm episodes are
   *  distinguishable in the collection rather than silently mixed. */
  algorithmVersion: string;
  /** Final rotation diagnostics at episode completion, for
   *  inspection/debugging -- same shape as CandlePhysicsEngine's own
   *  RotationDiagnosticsSnapshot where applicable. Not read by the
   *  P95 query itself (which only needs cumulativeLiqUsd/episodeEndTs). */
  finalDiagnostics: {
    rotationDeg: number | null;
    shockAtr: number | null;
    rotationForce: number | null;
  } | null;
  source: "backfill";
  createdAt: number;
}
