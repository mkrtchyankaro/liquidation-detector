import type { Side } from "../../shared/common.types";
import type { Episode, RawEvent } from "./displacement-balanced-core";

/**
 * Sep 16 2026 (Karo), operator-approved (Change 2 of the research-
 * pipeline design). Historical OI only exists at liquidation-event
 * timestamps -- confirmed by inspecting OiTrackerService directly: its
 * history ring is RAM-only, never persisted as its own continuous
 * collection. Every oiDelta-style/velocity field on a liq_raw_events
 * document was captured at THAT event's own write moment, never
 * independently at an arbitrary instant like an episode's END (a
 * candle-close event, not a liquidation event).
 *
 * This module therefore treats OI as a SPARSE set of waypoints, one
 * per liquidation event (same-direction AND opposite-side -- both
 * carry a causally valid marketSnapshot), never interpolated between
 * them. Every "OI near X" lookup returns the CLOSEST waypoint plus an
 * explicit offset and quality bucket -- callers must never treat this
 * as synchronized to X exactly.
 */

function get(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce(
      (acc: any, key) =>
        acc === null || acc === undefined ? undefined : acc[key],
      obj,
    );
}

export interface OiWaypoint {
  timestamp: number;
  side: Side;
  liquidationUsd: number;
  price: number;
  openInterest: number | null;
  openInterestUsd: number | null;
  oiDelta5sPct: number | null;
  oiDelta10sPct: number | null;
  oiDelta15sPct: number | null;
  oiDelta30sPct: number | null;
  oiDelta1mPct: number | null;
  oiDelta2mPct: number | null;
  oiDelta3mPct: number | null;
  oiDelta5mPct: number | null;
  oiDelta10mPct: number | null;
  oiVelocity10sPctPerSec: number | null;
  oiVelocity30sPctPerSec: number | null;
  oiVelocity1mPctPerSec: number | null;
  oiAccelerationPctPerSecSq: number | null;
  oiAgeMs: number | null;
}

export type OiQualityBucket =
  | "<=10s"
  | "<=30s"
  | "<=60s"
  | "<=2m"
  | ">2m"
  | "no_waypoint";

export function oiQualityBucket(offsetMs: number | null): OiQualityBucket {
  if (offsetMs === null) return "no_waypoint";
  const abs = Math.abs(offsetMs);
  if (abs <= 10_000) return "<=10s";
  if (abs <= 30_000) return "<=30s";
  if (abs <= 60_000) return "<=60s";
  if (abs <= 120_000) return "<=2m";
  return ">2m";
}

function toWaypoint(ev: RawEvent): OiWaypoint {
  const snap = ev.marketSnapshot;
  return {
    timestamp: ev.timestamp,
    side: ev.victim,
    liquidationUsd: ev.quoteQty,
    price: ev.price,
    openInterest:
      (get(snap, "openInterest.openInterest") as number | null) ?? null,
    openInterestUsd:
      (get(snap, "openInterest.openInterestUsd") as number | null) ?? null,
    oiDelta5sPct:
      (get(snap, "openInterest.oiDelta5sPct") as number | null) ?? null,
    oiDelta10sPct:
      (get(snap, "openInterest.oiDelta10sPct") as number | null) ?? null,
    oiDelta15sPct:
      (get(snap, "openInterest.oiDelta15sPct") as number | null) ?? null,
    oiDelta30sPct:
      (get(snap, "openInterest.oiDelta30sPct") as number | null) ?? null,
    oiDelta1mPct:
      (get(snap, "openInterest.oiDelta1mPct") as number | null) ?? null,
    oiDelta2mPct:
      (get(snap, "openInterest.oiDelta2mPct") as number | null) ?? null,
    oiDelta3mPct:
      (get(snap, "openInterest.oiDelta3mPct") as number | null) ?? null,
    oiDelta5mPct:
      (get(snap, "openInterest.oiDelta5mPct") as number | null) ?? null,
    oiDelta10mPct:
      (get(snap, "openInterest.oiDelta10mPct") as number | null) ?? null,
    oiVelocity10sPctPerSec:
      (get(snap, "openInterest.oiVelocity10sPctPerSec") as number | null) ??
      null,
    oiVelocity30sPctPerSec:
      (get(snap, "openInterest.oiVelocity30sPctPerSec") as number | null) ??
      null,
    oiVelocity1mPctPerSec:
      (get(snap, "openInterest.oiVelocity1mPctPerSec") as number | null) ??
      null,
    oiAccelerationPctPerSecSq:
      (get(snap, "openInterest.oiAccelerationPctPerSecSq") as number | null) ??
      null,
    oiAgeMs: (get(snap, "openInterest.oiAgeMs") as number | null) ?? null,
  };
}

export function extractOiTrajectory(episode: Episode): OiWaypoint[] {
  const allEvents = [
    ...episode.sameDirectionEvents,
    ...episode.oppositeSideEvents,
  ].sort((a, b) => a.timestamp - b.timestamp);
  return allEvents.map(toWaypoint);
}

export function closestWaypoint(
  trajectory: readonly OiWaypoint[],
  targetMs: number,
): { waypoint: OiWaypoint; offsetMs: number } | null {
  if (trajectory.length === 0) return null;
  let best: OiWaypoint = trajectory[0]!;
  let bestAbs = Math.abs(best.timestamp - targetMs);
  for (const wp of trajectory) {
    const abs = Math.abs(wp.timestamp - targetMs);
    if (abs < bestAbs) {
      best = wp;
      bestAbs = abs;
    }
  }
  return { waypoint: best, offsetMs: best.timestamp - targetMs };
}

export interface ClearingTransitionFeatures {
  mediumHorizonNegative: boolean | null;
  shortHorizonStabilizingOrPositive: boolean | null;
  clearingThenStabilizationPattern: boolean | null;
}
export function clearingTransitionFeatures(
  wp: OiWaypoint | null,
): ClearingTransitionFeatures {
  if (wp === null)
    return {
      mediumHorizonNegative: null,
      shortHorizonStabilizingOrPositive: null,
      clearingThenStabilizationPattern: null,
    };
  const medNegative =
    wp.oiDelta30sPct !== null &&
    wp.oiDelta1mPct !== null &&
    wp.oiDelta3mPct !== null
      ? wp.oiDelta30sPct < 0 && wp.oiDelta1mPct < 0 && wp.oiDelta3mPct < 0
      : null;
  const shortStabilizing =
    wp.oiDelta5sPct !== null && wp.oiDelta10sPct !== null
      ? wp.oiDelta5sPct >= 0 && wp.oiDelta10sPct >= 0
      : null;
  return {
    mediumHorizonNegative: medNegative,
    shortHorizonStabilizingOrPositive: shortStabilizing,
    clearingThenStabilizationPattern:
      medNegative !== null && shortStabilizing !== null
        ? medNegative && shortStabilizing
        : null,
  };
}

export interface OiMovementSummary {
  oiChangeStartToExtremePct: number | null;
  oiChangeStartToEndPct: number | null;
  oiChangeExtremeToEndPct: number | null;
  oiMaxDrawdownPct: number | null;
  oiMaxExpansionPct: number | null;
}
function pctChange(from: number | null, to: number | null): number | null {
  return from !== null && from > 0 && to !== null
    ? ((to - from) / from) * 100
    : null;
}
export function computeOiMovementSummary(
  trajectory: readonly OiWaypoint[],
  startWp: OiWaypoint | null,
  extremeWp: OiWaypoint | null,
  endWp: OiWaypoint | null,
): OiMovementSummary {
  const usdSeries = trajectory
    .map((w) => w.openInterestUsd)
    .filter((v): v is number => v !== null);
  let maxDrawdownPct: number | null = null,
    maxExpansionPct: number | null = null;
  if (usdSeries.length > 0) {
    let peak = usdSeries[0]!,
      trough = usdSeries[0]!;
    let worstDrawdown = 0,
      worstExpansion = 0;
    for (const v of usdSeries) {
      peak = Math.max(peak, v);
      trough = Math.min(trough, v);
      if (peak > 0)
        worstDrawdown = Math.min(worstDrawdown, ((v - peak) / peak) * 100);
      if (trough > 0)
        worstExpansion = Math.max(
          worstExpansion,
          ((v - trough) / trough) * 100,
        );
    }
    maxDrawdownPct = worstDrawdown;
    maxExpansionPct = worstExpansion;
  }
  return {
    oiChangeStartToExtremePct: pctChange(
      startWp?.openInterestUsd ?? null,
      extremeWp?.openInterestUsd ?? null,
    ),
    oiChangeStartToEndPct: pctChange(
      startWp?.openInterestUsd ?? null,
      endWp?.openInterestUsd ?? null,
    ),
    oiChangeExtremeToEndPct: pctChange(
      extremeWp?.openInterestUsd ?? null,
      endWp?.openInterestUsd ?? null,
    ),
    oiMaxDrawdownPct: maxDrawdownPct,
    oiMaxExpansionPct: maxExpansionPct,
  };
}
