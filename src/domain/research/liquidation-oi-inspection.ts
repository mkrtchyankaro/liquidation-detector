import type { Side, Candle } from "../../shared/common.types";

/**
 * Sep 16 2026 (Karo), operator-requested + corrected. READ-ONLY
 * inspection tool support -- pure computation only, no Mongo/Binance
 * calls in this file (those live in the CLI script itself).
 *
 * SCHEMA CORRECTION (operator-verified against a real document):
 * oi_second_observations.openInterestUsd and .price are effectively
 * ALWAYS null in practice (OiTrackerService's causal-price callback
 * rarely has a fresh mid-price at poll time) -- every function here
 * treats them as absent by design, never assumes they're populated.
 * Raw `openInterest` (contracts/base-asset quantity) is the PRIMARY
 * measurement throughout, exactly as instructed: it is not distorted
 * by price revaluation, unlike a USD figure would be. Price is
 * obtained INDEPENDENTLY from historical candles by the CLI script
 * and passed into these functions as a separate causal price series --
 * never read from the OI documents themselves.
 *
 * CAUSALITY: every "price at timestamp T" and "OI at timestamp T"
 * lookup in this file uses the most recent observation AT OR BEFORE T
 * -- never a future observation, never interpolated between real
 * samples. A missing observation yields null, never a fabricated
 * value.
 */

export interface OiObservation {
  symbol: string;
  timestamp: number; // ms epoch, derived from the stored Date
  oiUpdatedAtMs: number | null;
  openInterest: number;
}

export interface LiquidationEvent {
  timestamp: number;
  victim: Side;
  price: number;
  quoteQty: number;
}

/** Most recent candle whose closeTime <= atOrBeforeMs; that candle's
 *  own close price is used as the causal price reference. Null if no
 *  such candle exists (e.g. before the earliest fetched candle). */
export function causalPriceAtOrBefore(
  candles: readonly Candle[],
  atOrBeforeMs: number,
): number | null {
  let best: Candle | null = null;
  for (const c of candles) {
    if (
      c.closeTime <= atOrBeforeMs &&
      (best === null || c.closeTime > best.closeTime)
    )
      best = c;
  }
  return best ? best.close : null;
}

/** Most recent OI observation with timestamp <= atOrBeforeMs. Null if
 *  none exists in the given (already time-filtered) list. */
export function oiAtOrBefore(
  observations: readonly OiObservation[],
  atOrBeforeMs: number,
): OiObservation | null {
  let best: OiObservation | null = null;
  for (const o of observations) {
    if (
      o.timestamp <= atOrBeforeMs &&
      (best === null || o.timestamp > best.timestamp)
    )
      best = o;
  }
  return best;
}

/** First OI observation with timestamp >= atOrAfterMs (never
 *  fabricates one at the exact target -- reports the true observation
 *  it found). Null if none exists on or after that instant within the
 *  given list. */
export function firstOiAtOrAfter(
  observations: readonly OiObservation[],
  atOrAfterMs: number,
): OiObservation | null {
  let best: OiObservation | null = null;
  for (const o of observations) {
    if (
      o.timestamp >= atOrAfterMs &&
      (best === null || o.timestamp < best.timestamp)
    )
      best = o;
  }
  return best;
}

export interface MinuteTimelineRow {
  minuteStartMs: number;
  priceOpen: number | null;
  priceHigh: number | null;
  priceLow: number | null;
  priceClose: number | null;
  priceChangePct: number | null;
  oiStart: number | null;
  oiEnd: number | null;
  oiMin: number | null;
  oiMax: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  longLiqUsd: number;
  shortLiqUsd: number;
  longLiqCount: number;
  shortLiqCount: number;
}

/** One row per calendar minute across [fromMs, toMs] INCLUSIVE of the
 *  boundary minutes, regardless of whether any liquidation or OI
 *  observation falls inside it -- the requested window is the
 *  authority, not the last liquidation. Price OHLC comes from 1m
 *  candles falling within the minute (closeTime bucketed to its own
 *  minute); OI start/end/min/max comes from OI observations whose
 *  timestamp falls within the minute. A minute with no observations of
 *  either kind gets nulls for those columns, never a fabricated
 *  carry-forward value within THIS row (oiStart/oiEnd carrying the
 *  last-known value across minutes is the CLI's own display concern,
 *  not this function's). */
export function buildMinuteTimeline(
  fromMs: number,
  toMs: number,
  candles: readonly Candle[],
  oiObservations: readonly OiObservation[],
  liquidations: readonly LiquidationEvent[],
): MinuteTimelineRow[] {
  const rows: MinuteTimelineRow[] = [];
  const minuteMs = 60_000;
  const firstMinute = Math.floor(fromMs / minuteMs) * minuteMs;
  const lastMinute = Math.floor(toMs / minuteMs) * minuteMs;

  for (let m = firstMinute; m <= lastMinute; m += minuteMs) {
    const minuteEnd = m + minuteMs;
    const candlesInMinute = candles.filter(
      (c) => c.openTime >= m && c.openTime < minuteEnd,
    );
    const oiInMinute = oiObservations.filter(
      (o) => o.timestamp >= m && o.timestamp < minuteEnd,
    );
    const liqInMinute = liquidations.filter(
      (l) => l.timestamp >= m && l.timestamp < minuteEnd,
    );

    let priceOpen: number | null = null,
      priceHigh: number | null = null,
      priceLow: number | null = null,
      priceClose: number | null = null;
    if (candlesInMinute.length > 0) {
      const sorted = [...candlesInMinute].sort(
        (a, b) => a.openTime - b.openTime,
      );
      priceOpen = sorted[0]!.open;
      priceClose = sorted[sorted.length - 1]!.close;
      priceHigh = Math.max(...sorted.map((c) => c.high));
      priceLow = Math.min(...sorted.map((c) => c.low));
    }
    const priceChangePct =
      priceOpen !== null && priceClose !== null && priceOpen !== 0
        ? ((priceClose - priceOpen) / priceOpen) * 100
        : null;

    let oiStart: number | null = null,
      oiEnd: number | null = null,
      oiMin: number | null = null,
      oiMax: number | null = null;
    if (oiInMinute.length > 0) {
      const sorted = [...oiInMinute].sort((a, b) => a.timestamp - b.timestamp);
      oiStart = sorted[0]!.openInterest;
      oiEnd = sorted[sorted.length - 1]!.openInterest;
      oiMin = Math.min(...sorted.map((o) => o.openInterest));
      oiMax = Math.max(...sorted.map((o) => o.openInterest));
    }
    const oiChange =
      oiStart !== null && oiEnd !== null ? oiEnd - oiStart : null;
    const oiChangePct =
      oiStart !== null && oiStart !== 0 && oiChange !== null
        ? (oiChange / oiStart) * 100
        : null;

    const longLiq = liqInMinute.filter((l) => l.victim === "LONG");
    const shortLiq = liqInMinute.filter((l) => l.victim === "SHORT");

    rows.push({
      minuteStartMs: m,
      priceOpen,
      priceHigh,
      priceLow,
      priceClose,
      priceChangePct,
      oiStart,
      oiEnd,
      oiMin,
      oiMax,
      oiChange,
      oiChangePct,
      longLiqUsd: longLiq.reduce((s, l) => s + l.quoteQty, 0),
      shortLiqUsd: shortLiq.reduce((s, l) => s + l.quoteQty, 0),
      longLiqCount: longLiq.length,
      shortLiqCount: shortLiq.length,
    });
  }
  return rows;
}

const ANCHOR_HORIZONS_SEC = [5, 10, 15, 30, 60, 120, 180, 300, 600] as const;

export interface AnchorHorizonPoint {
  targetOffsetSeconds: number;
  actualTimestamp: number | null;
  actualOffsetSeconds: number | null;
  price: number | null;
  priceChangeFromLastLiqPct: number | null;
  openInterest: number | null;
  oiChangeFromLastLiq: number | null;
  oiChangeFromLastLiqPct: number | null;
}

export interface LastLiquidationAnchor {
  lastLiquidationTs: number;
  victim: Side;
  liquidationUsd: number;
  priceAtLastLiquidation: number;
  nearestCausalOi: OiObservation | null;
  nearestCausalOiOffsetMs: number | null;
  horizons: AnchorHorizonPoint[];
}

/** Builds the "last liquidation anchor" view: nearest causal OI at or
 *  before the liquidation, then the first REAL observation at or after
 *  each target horizon (never fabricated to land exactly on the
 *  target) -- only for horizons that actually fall within
 *  windowEndMs (the requested TO), per operator instruction to never
 *  reach past what was actually requested/available. */
export function buildLastLiquidationAnchor(
  lastLiq: LiquidationEvent,
  oiObservations: readonly OiObservation[],
  candles: readonly Candle[],
  windowEndMs: number,
): LastLiquidationAnchor {
  const nearestOi = oiAtOrBefore(oiObservations, lastLiq.timestamp);
  const baseOi = nearestOi?.openInterest ?? null;

  const horizons: AnchorHorizonPoint[] = [];
  for (const sec of ANCHOR_HORIZONS_SEC) {
    const targetMs = lastLiq.timestamp + sec * 1000;
    if (targetMs > windowEndMs) {
      horizons.push({
        targetOffsetSeconds: sec,
        actualTimestamp: null,
        actualOffsetSeconds: null,
        price: null,
        priceChangeFromLastLiqPct: null,
        openInterest: null,
        oiChangeFromLastLiq: null,
        oiChangeFromLastLiqPct: null,
      });
      continue;
    }
    const obs = firstOiAtOrAfter(oiObservations, targetMs);
    if (obs === null) {
      horizons.push({
        targetOffsetSeconds: sec,
        actualTimestamp: null,
        actualOffsetSeconds: null,
        price: null,
        priceChangeFromLastLiqPct: null,
        openInterest: null,
        oiChangeFromLastLiq: null,
        oiChangeFromLastLiqPct: null,
      });
      continue;
    }
    const price = causalPriceAtOrBefore(candles, obs.timestamp);
    const priceChangePct =
      price !== null && lastLiq.price !== 0
        ? ((price - lastLiq.price) / lastLiq.price) * 100
        : null;
    const oiChange = baseOi !== null ? obs.openInterest - baseOi : null;
    const oiChangePct =
      baseOi !== null && baseOi !== 0 && oiChange !== null
        ? (oiChange / baseOi) * 100
        : null;
    horizons.push({
      targetOffsetSeconds: sec,
      actualTimestamp: obs.timestamp,
      actualOffsetSeconds: (obs.timestamp - lastLiq.timestamp) / 1000,
      price,
      priceChangeFromLastLiqPct: priceChangePct,
      openInterest: obs.openInterest,
      oiChangeFromLastLiq: oiChange,
      oiChangeFromLastLiqPct: oiChangePct,
    });
  }

  return {
    lastLiquidationTs: lastLiq.timestamp,
    victim: lastLiq.victim,
    liquidationUsd: lastLiq.quoteQty,
    priceAtLastLiquidation: lastLiq.price,
    nearestCausalOi: nearestOi,
    nearestCausalOiOffsetMs:
      nearestOi !== null ? nearestOi.timestamp - lastLiq.timestamp : null,
    horizons,
  };
}

export interface OiObservationWithDeltas extends OiObservation {
  estimatedOiUsd: number | null; // openInterest * causal price -- explicitly derived, never stored
  causalPrice: number | null;
  deltaOiFromPrevious: number | null;
  deltaOiPctFromPrevious: number | null;
  deltaOiFromPeriodStart: number | null;
  deltaOiPctFromPeriodStart: number | null;
  deltaOiFromLastLiquidation: number | null;
  deltaOiPctFromLastLiquidation: number | null;
}

/** Annotates the raw OI observation series with deltas. Never
 *  interpolates missing seconds -- operates strictly on the
 *  observations actually present, in timestamp order. `lastLiqTs`
 *  (nullable) gates the from-last-liquidation deltas: only computed
 *  for observations at or after it. */
export function annotateOiObservations(
  observationsSortedByTime: readonly OiObservation[],
  candles: readonly Candle[],
  lastLiqTs: number | null,
): OiObservationWithDeltas[] {
  if (observationsSortedByTime.length === 0) return [];
  const periodStartOi = observationsSortedByTime[0]!.openInterest;
  const lastLiqOi =
    lastLiqTs !== null
      ? (oiAtOrBefore(observationsSortedByTime, lastLiqTs)?.openInterest ??
        null)
      : null;

  const out: OiObservationWithDeltas[] = [];
  for (let i = 0; i < observationsSortedByTime.length; i++) {
    const o = observationsSortedByTime[i]!;
    const prev = i > 0 ? observationsSortedByTime[i - 1]! : null;
    const causalPrice = causalPriceAtOrBefore(candles, o.timestamp);

    const deltaFromPrev =
      prev !== null ? o.openInterest - prev.openInterest : null;
    const deltaFromStart = o.openInterest - periodStartOi;
    const deltaFromLastLiq =
      lastLiqOi !== null && o.timestamp >= lastLiqTs!
        ? o.openInterest - lastLiqOi
        : null;

    out.push({
      ...o,
      estimatedOiUsd:
        causalPrice !== null ? o.openInterest * causalPrice : null,
      causalPrice,
      deltaOiFromPrevious: deltaFromPrev,
      deltaOiPctFromPrevious:
        prev !== null && prev.openInterest !== 0 && deltaFromPrev !== null
          ? (deltaFromPrev / prev.openInterest) * 100
          : null,
      deltaOiFromPeriodStart: deltaFromStart,
      deltaOiPctFromPeriodStart:
        periodStartOi !== 0 ? (deltaFromStart / periodStartOi) * 100 : null,
      deltaOiFromLastLiquidation: deltaFromLastLiq,
      deltaOiPctFromLastLiquidation:
        lastLiqOi !== null && lastLiqOi !== 0 && deltaFromLastLiq !== null
          ? (deltaFromLastLiq / lastLiqOi) * 100
          : null,
    });
  }
  return out;
}
