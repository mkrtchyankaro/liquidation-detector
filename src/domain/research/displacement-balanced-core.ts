import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../../infrastructure/mongo/mongo.client";
import type { Candle, Side } from "../../shared/common.types";

/**
 * Sep 16 2026 (Karo), operator-requested EXTRACTION. This is a
 * VERBATIM extraction of the DISPLACEMENT_BALANCED state machine,
 * ATR series builder, kline/event loaders, and percentile helper from
 * scripts/research-liquidation-episodes.ts -- not a rewrite. The goal
 * is a single shared core that research scripts AND production code
 * both import, so historical research and live production can never
 * drift apart on what DISPLACEMENT_BALANCED actually does.
 *
 * scripts/research-liquidation-episodes.ts and
 * scripts/research-episode-percentiles.ts now import from here
 * instead of defining any of this themselves.
 *
 * ATR FORMULA: Wilder ATR(14), identical to src/shared/indicators.ts's
 * own atr() function -- verified to reproduce it exactly at every
 * index before this was ever used as a research basis.
 */

const ATR_PERIOD = 14;
const MAX_KLINES_PER_REQUEST = 1500;
const BINANCE_KLINES_URL = "https://fapi.binance.com/fapi/v1/klines";

export async function fetchKlines(
  symbol: string,
  intervalMs: number,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const interval =
    intervalMs === 60_000 ? "1m" : intervalMs === 180_000 ? "3m" : "5m";
  const out: Candle[] = [];
  let cursor = fromMs;
  const seedPadMs = ATR_PERIOD * 3 * intervalMs;
  cursor -= seedPadMs;
  while (cursor < toMs) {
    const url = `${BINANCE_KLINES_URL}?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${toMs}&limit=${MAX_KLINES_PER_REQUEST}`;
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(
        `Binance klines HTTP ${res.status} for ${symbol} ${interval}`,
      );
    const rows = (await res.json()) as unknown[][];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        symbol,
        interval: interval as Candle["interval"],
        openTime: r[0] as number,
        closeTime: r[6] as number,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
        quoteVolume: Number(r[7]),
        trades: r[8] as number,
        takerBuyVolume: Number(r[9]),
        takerBuyQuoteVolume: Number(r[10]),
        isClosed: true,
      });
    }
    const lastOpenTime = rows[rows.length - 1]![0] as number;
    if (lastOpenTime <= cursor) break;
    cursor = lastOpenTime + intervalMs;
    if (rows.length < MAX_KLINES_PER_REQUEST) break;
  }
  return out;
}

export function computeAtrSeries(
  candles: readonly Candle[],
  period = ATR_PERIOD,
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!,
      prev = candles[i - 1]!;
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
      ),
    );
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i]!;
  let atrVal = sum / period;
  out[period] = atrVal;
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]!) / period;
    out[i + 1] = atrVal;
  }
  return out;
}
export function atrAtOrBefore(
  candles: readonly Candle[],
  series: readonly (number | null)[],
  atOrBeforeMs: number,
): number | null {
  let bestIdx = -1;
  for (let i = 0; i < candles.length; i++)
    if (candles[i]!.closeTime <= atOrBeforeMs) bestIdx = i;
    else break;
  return bestIdx >= 0 ? (series[bestIdx] ?? null) : null;
}

export interface RawEvent {
  _id: string;
  timestamp: number;
  victim: Side;
  price: number;
  quoteQty: number;
  marketSnapshot: Record<string, any> | null;
}

export async function loadRawEvents(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<RawEvent[]> {
  const mongoCfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  if (!mongoCfg.enabled) throw new Error("MONGO_URI not set");
  const mongo = new MongoClientWrapper(mongoCfg);
  const coll = await mongo.rawLiquidationEvents();
  if (!coll) {
    await mongo.close();
    throw new Error("Could not obtain the liq_raw_events collection handle");
  }
  const docs = await coll
    .find({ symbol, timestamp: { $gte: fromMs, $lte: toMs } })
    .sort({ timestamp: 1 })
    .toArray();
  await mongo.close();
  return docs.map((d: any) => ({
    _id: d._id.toString(),
    timestamp: d.timestamp,
    victim: d.victim,
    price: d.price,
    quoteQty: d.quoteQty,
    marketSnapshot: d.marketSnapshot ?? null,
  }));
}

/** True collection coverage for this symbol -- NOT bounded by any
 *  requested window. READ-ONLY: only ever queries liq_raw_events,
 *  never writes/updates/deletes anything. */
export async function getCollectionCoverage(
  symbol: string,
): Promise<{ earliestMs: number | null; latestMs: number | null }> {
  const mongoCfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  if (!mongoCfg.enabled) throw new Error("MONGO_URI not set");
  const mongo = new MongoClientWrapper(mongoCfg);
  const coll = await mongo.rawLiquidationEvents();
  if (!coll) {
    await mongo.close();
    throw new Error("Could not obtain the liq_raw_events collection handle");
  }
  const earliest = await coll
    .find({ symbol })
    .sort({ timestamp: 1 })
    .limit(1)
    .toArray();
  const latest = await coll
    .find({ symbol })
    .sort({ timestamp: -1 })
    .limit(1)
    .toArray();
  await mongo.close();
  return {
    earliestMs: earliest[0]?.timestamp ?? null,
    latestMs: latest[0]?.timestamp ?? null,
  };
}

export interface Atrs {
  series1m: (number | null)[];
  series3m: (number | null)[];
  series5m: (number | null)[];
  c1m: Candle[];
  c3m: Candle[];
  c5m: Candle[];
}

function atr1mAt(atrs: Atrs, atOrBeforeMs: number): number | null {
  return atrAtOrBefore(atrs.c1m, atrs.series1m, atOrBeforeMs);
}
function atr3mAt(atrs: Atrs, atOrBeforeMs: number): number | null {
  return atrAtOrBefore(atrs.c3m, atrs.series3m, atOrBeforeMs);
}
function atr5mAt(atrs: Atrs, atOrBeforeMs: number): number | null {
  return atrAtOrBefore(atrs.c5m, atrs.series5m, atOrBeforeMs);
}

/** ATR-normalized safeguard (never a raw dollar minimum): the
 *  displacement-fraction condition only APPLIES once the episode's
 *  own displacement reaches at least this many ATR3m units. Below
 *  that, the fraction condition is bypassed, not failed. */
export const MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE = 1.0;

export interface Variant {
  name: string;
  candidate1mAtrMultiple: number;
  confirm3mAtrMultiple: number;
  confirm5mAtrMultiple: number | null;
  recoveryFractionMinimum: number | null;
}

/** The ONE frozen, canonical variant. Config UNCHANGED since the
 *  freeze -- not to be retuned per symbol, per environment, or
 *  silently anywhere else. */
export const PRIMARY_VARIANT: Variant = {
  name: "DISPLACEMENT_BALANCED",
  candidate1mAtrMultiple: 0.75,
  confirm3mAtrMultiple: 1.0,
  confirm5mAtrMultiple: null,
  recoveryFractionMinimum: 0.3,
};

export interface Transition {
  type:
    | "START"
    | "EXTREME_UPDATED"
    | "RECOVERY_CANDIDATE"
    | "RECOVERY_INVALIDATED"
    | "RECOVERY_CONFIRMED"
    | "END";
  time: number;
  price?: number;
  recovery?: number;
  atr1m?: number | null;
  atr3m?: number | null;
  atr5m?: number | null;
  reason?: string;
  startReferencePrice?: number;
  episodeDisplacement?: number;
  episodeDisplacementAtr3m?: number | null;
  recoveryFraction?: number | null;
  requiredRecoveryFraction?: number | null;
  fractionGateActive?: boolean;
  atrConditionPass?: boolean;
  displacementConditionPass?: boolean;
}

export interface Episode {
  variant: string;
  direction: Side;
  startTime: number;
  firstPrice: number;
  extremePrice: number;
  extremeTime: number;
  endTime: number | null;
  transitions: Transition[];
  sameDirectionEvents: RawEvent[];
  oppositeSideEvents: RawEvent[];
}

export function isMoreAdverse(
  direction: Side,
  candidatePrice: number,
  currentExtreme: number,
): boolean {
  return direction === "LONG"
    ? candidatePrice < currentExtreme
    : candidatePrice > currentExtreme;
}

/** Pure causal replay: at every closed 1m candle, in chronological
 *  order, using only information available by that candle's own
 *  closeTime (and, for confirmation, the next 3m candle's own
 *  closeTime) -- NO fixed future lookahead window anywhere. Recovery
 *  candidates are invalidated the instant a new adverse extreme
 *  appears. Confirmation checks the FIRST 3m candle to close after
 *  the candidate -- one confirmation attempt per candidate. */
export function runStateMachine(
  direction: Side,
  startTime: number,
  startReferencePrice: number,
  atrs: Atrs,
  variant: Variant,
): {
  endTime: number | null;
  extremePrice: number;
  extremeTime: number;
  transitions: Transition[];
} {
  const transitions: Transition[] = [
    { type: "START", time: startTime, price: startReferencePrice },
  ];
  let extreme = startReferencePrice,
    extremeTime = startTime;
  let candidate: { time: number } | null = null;
  let c3mIdx = 0;
  let endTime: number | null = null;

  const c1mAfter = atrs.c1m.filter((c) => c.closeTime > startTime);
  for (const c of c1mAfter) {
    const adverseCandidate = direction === "LONG" ? c.low : c.high;
    if (isMoreAdverse(direction, adverseCandidate, extreme)) {
      extreme = adverseCandidate;
      extremeTime = c.closeTime;
      transitions.push({
        type: "EXTREME_UPDATED",
        time: c.closeTime,
        price: extreme,
      });
      if (candidate) {
        transitions.push({
          type: "RECOVERY_INVALIDATED",
          time: c.closeTime,
          reason: "new adverse extreme before 3m confirmation",
        });
        candidate = null;
      }
    } else if (!candidate) {
      const recovery =
        direction === "LONG" ? c.close - extreme : extreme - c.close;
      const atr1 = atr1mAt(atrs, c.closeTime);
      if (atr1 !== null && recovery >= variant.candidate1mAtrMultiple * atr1) {
        candidate = { time: c.closeTime };
        transitions.push({
          type: "RECOVERY_CANDIDATE",
          time: c.closeTime,
          price: c.close,
          recovery,
          atr1m: atr1,
          startReferencePrice,
          episodeDisplacement:
            direction === "LONG"
              ? startReferencePrice - extreme
              : extreme - startReferencePrice,
        });
      }
    }

    while (
      candidate &&
      c3mIdx < atrs.c3m.length &&
      atrs.c3m[c3mIdx]!.closeTime <= c.closeTime
    ) {
      const c3 = atrs.c3m[c3mIdx]!;
      c3mIdx++;
      if (c3.closeTime <= candidate.time) continue;
      const atr3 = atr3mAt(atrs, c3.closeTime);
      const atr5 = atr5mAt(atrs, c3.closeTime);
      const recovery3m =
        direction === "LONG" ? c3.close - extreme : extreme - c3.close;
      const passes3m =
        atr3 !== null && recovery3m >= variant.confirm3mAtrMultiple * atr3;
      const passes5m =
        variant.confirm5mAtrMultiple === null ||
        (atr5 !== null && recovery3m >= variant.confirm5mAtrMultiple * atr5);

      const episodeDisplacement =
        direction === "LONG"
          ? startReferencePrice - extreme
          : extreme - startReferencePrice;
      const episodeDisplacementAtr3m =
        atr3 !== null && atr3 > 0 ? episodeDisplacement / atr3 : null;
      const recoveryFraction =
        episodeDisplacement > 0 ? recovery3m / episodeDisplacement : null;
      const fractionGateActive =
        variant.recoveryFractionMinimum !== null &&
        episodeDisplacementAtr3m !== null &&
        episodeDisplacementAtr3m >= MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE;
      let passesDisplacement = true;
      if (fractionGateActive) {
        passesDisplacement =
          recoveryFraction !== null &&
          recoveryFraction >= variant.recoveryFractionMinimum!;
      }

      const debugFields = {
        startReferencePrice,
        episodeDisplacement,
        episodeDisplacementAtr3m,
        recoveryFraction,
        requiredRecoveryFraction: variant.recoveryFractionMinimum,
        fractionGateActive,
        atrConditionPass: passes3m && passes5m,
        displacementConditionPass: passesDisplacement,
      };
      if (passes3m && passes5m && passesDisplacement) {
        // Invariant assertion (Sep 16 2026, XRP 27.61% investigation):
        // fail loudly rather than silently confirming a violation.
        if (
          fractionGateActive &&
          recoveryFraction !== null &&
          recoveryFraction < variant.recoveryFractionMinimum!
        ) {
          throw new Error(
            `INVARIANT VIOLATED: RECOVERY_CONFIRMED for variant ${variant.name} with fractionGateActive=true and recoveryFraction=${recoveryFraction} < requiredRecoveryFraction=${variant.recoveryFractionMinimum} at ${new Date(c3.closeTime).toISOString()}`,
          );
        }
        const reasons: string[] = [];
        if (fractionGateActive)
          reasons.push(
            `PASS: recovery fraction ${(recoveryFraction! * 100).toFixed(1)}% >= ${(variant.recoveryFractionMinimum! * 100).toFixed(0)}% required (gate active, displacement=${episodeDisplacementAtr3m!.toFixed(2)}xATR3m)`,
          );
        else
          reasons.push(
            `PASS: fraction gate not active (${episodeDisplacementAtr3m !== null ? `displacement=${episodeDisplacementAtr3m.toFixed(2)}xATR3m < ${MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE}x minimum` : "ATR3m unavailable"})`,
          );
        transitions.push({
          type: "RECOVERY_CONFIRMED",
          time: c3.closeTime,
          price: c3.close,
          recovery: recovery3m,
          atr3m: atr3,
          atr5m: atr5,
          reason: reasons.join("; "),
          ...debugFields,
        });
        endTime = c3.closeTime;
        transitions.push({ type: "END", time: c3.closeTime });
      } else {
        const reasons: string[] = [];
        if (!passes3m)
          reasons.push(
            `FAIL: ATR3m recovery insufficient (recovery=${recovery3m.toFixed(6)} < ${variant.confirm3mAtrMultiple}x ATR3m=${atr3 !== null ? (variant.confirm3mAtrMultiple * atr3).toFixed(6) : "n/a"})`,
          );
        if (!passes5m) reasons.push("FAIL: ATR5m recovery insufficient");
        if (fractionGateActive && !passesDisplacement)
          reasons.push(
            `FAIL: recovery fraction insufficient (${recoveryFraction !== null ? (recoveryFraction * 100).toFixed(1) : "?"}% < ${(variant.recoveryFractionMinimum! * 100).toFixed(0)}% required, gate active at displacement=${episodeDisplacementAtr3m!.toFixed(2)}xATR3m)`,
          );
        transitions.push({
          type: "RECOVERY_INVALIDATED",
          time: c3.closeTime,
          reason:
            reasons.join("; ") || "3m close did not sustain required recovery",
          recovery: recovery3m,
          atr3m: atr3,
          atr5m: atr5,
          ...debugFields,
        });
      }
      candidate = null;
      break;
    }
    if (endTime !== null) break;
  }
  return { endTime, extremePrice: extreme, extremeTime, transitions };
}

export function reconstructEpisodesForVariant(
  events: RawEvent[],
  atrs: Atrs,
  variant: Variant,
  windowEndMs: number,
): Episode[] {
  const episodes: Episode[] = [];
  let i = 0;
  while (i < events.length) {
    const startEvent = events[i]!;
    const direction = startEvent.victim;
    const { endTime, extremePrice, extremeTime, transitions } = runStateMachine(
      direction,
      startEvent.timestamp,
      startEvent.price,
      atrs,
      variant,
    );
    const assignBoundary = endTime ?? windowEndMs;

    const sameDirectionEvents: RawEvent[] = [startEvent];
    const oppositeSideEvents: RawEvent[] = [];
    let j = i + 1;
    while (j < events.length && events[j]!.timestamp <= assignBoundary) {
      const ev = events[j]!;
      if (ev.victim === direction) sameDirectionEvents.push(ev);
      else oppositeSideEvents.push(ev);
      j++;
    }
    episodes.push({
      variant: variant.name,
      direction,
      startTime: startEvent.timestamp,
      firstPrice: startEvent.price,
      extremePrice,
      extremeTime,
      endTime,
      transitions,
      sameDirectionEvents,
      oppositeSideEvents,
    });
    i = j;
  }
  return episodes;
}

export function percentile(
  sorted: readonly number[],
  q: number,
): number | null {
  if (sorted.length === 0) return null;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function episodeSummary(e: Episode): {
  startReferencePrice: number;
  finalExtremePrice: number;
  finalExtremeTime: number;
  durationMs: number | null;
  episodeDisplacement: number | null;
  episodeDisplacementAtr3m: number | null;
  recoveryAtEnd: number | null;
  recoveryAtr3m: number | null;
  recoveryAtr5m: number | null;
  recoveryFraction: number | null;
} {
  const confirmed = [...e.transitions]
    .reverse()
    .find((t) => t.type === "RECOVERY_CONFIRMED");
  return {
    startReferencePrice: confirmed?.startReferencePrice ?? e.firstPrice,
    finalExtremePrice: e.extremePrice,
    finalExtremeTime: e.extremeTime,
    durationMs: e.endTime !== null ? e.endTime - e.startTime : null,
    episodeDisplacement: confirmed?.episodeDisplacement ?? null,
    episodeDisplacementAtr3m: confirmed?.episodeDisplacementAtr3m ?? null,
    recoveryAtEnd: confirmed?.recovery ?? null,
    recoveryAtr3m:
      confirmed?.atr3m !== undefined &&
      confirmed?.atr3m !== null &&
      confirmed?.recovery !== undefined
        ? confirmed.recovery / confirmed.atr3m
        : null,
    recoveryAtr5m:
      confirmed?.atr5m !== undefined &&
      confirmed?.atr5m !== null &&
      confirmed?.recovery !== undefined
        ? confirmed.recovery / confirmed.atr5m
        : null,
    recoveryFraction: confirmed?.recoveryFraction ?? null,
  };
}

export function episodeUsd(e: Episode): number {
  return e.sameDirectionEvents.reduce((s, ev) => s + ev.quoteQty, 0);
}

export interface CompleteEpisodesResult {
  episodes: Episode[];
  leftCensoredExcluded: number;
  rightCensoredExcluded: number;
  coverage: { earliestMs: number | null; latestMs: number | null };
}

/** Sep 16 2026 (Karo), operator-requested SHARED boundary-aware
 *  reconstruction -- used identically by both the historical
 *  percentile research script and the production EpisodePercentileService,
 *  so left/right-censoring handling can never drift between the two.
 *
 *  BOUNDARY HANDLING (unchanged from the percentile-research script):
 *   - Fetches klines/events over [fromMs - paddingMs, toMs] so an
 *     episode genuinely active AT fromMs is tracked with its true
 *     extreme/USD total, not miscounted as a fresh start.
 *   - Any episode whose OWN startTime falls before fromMs is EXCLUDED
 *     (left-censored) -- needed for correct causal state, but its own
 *     start isn't within the measured window. Padding is a practical
 *     safeguard (default 6h), not a theoretical guarantee.
 *   - Any episode with endTime === null (still open at toMs) is
 *     EXCLUDED (right-censored) -- its true total isn't known yet.
 *   - Only `fromMs <= startTime AND endTime !== null AND endTime <= toMs`
 *     counts as complete. */
export async function reconstructCompleteEpisodes(
  symbol: string,
  fromMs: number,
  toMs: number,
  paddingMs: number,
): Promise<CompleteEpisodesResult> {
  const coverage = await getCollectionCoverage(symbol);
  const paddedFrom = fromMs - paddingMs;
  const c1m = await fetchKlines(symbol, 60_000, paddedFrom, toMs);
  const c3m = await fetchKlines(symbol, 180_000, paddedFrom, toMs);
  const c5m = await fetchKlines(symbol, 300_000, paddedFrom, toMs);
  const atrs: Atrs = {
    c1m,
    c3m,
    c5m,
    series1m: computeAtrSeries(c1m),
    series3m: computeAtrSeries(c3m),
    series5m: computeAtrSeries(c5m),
  };
  const events = await loadRawEvents(symbol, paddedFrom, toMs);

  const allEpisodes = reconstructEpisodesForVariant(
    events,
    atrs,
    PRIMARY_VARIANT,
    toMs,
  );
  const leftCensoredExcluded = allEpisodes.filter(
    (e) => e.startTime < fromMs,
  ).length;
  const rightCensoredExcluded = allEpisodes.filter(
    (e) => e.endTime === null,
  ).length;
  const episodes = allEpisodes.filter(
    (e) => e.startTime >= fromMs && e.endTime !== null && e.endTime <= toMs,
  );

  return { episodes, leftCensoredExcluded, rightCensoredExcluded, coverage };
}
