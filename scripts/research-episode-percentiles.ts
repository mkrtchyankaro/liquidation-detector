import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import type { Candle, Side } from "../src/shared/common.types";

/**
 * Sep 16 2026 (Karo), operator-requested. READ-ONLY research: no
 * writes/updates/deletes anywhere in this file, no new Mongo
 * collection, no production strategy code touched.
 *
 *   npx tsx scripts/research-liquidation-episodes.ts BTCUSDT --hours 24
 *   npx tsx scripts/research-liquidation-episodes.ts BTCUSDT --from "2026-09-15 00:00" --to "2026-09-16 00:00"
 *
 * TWO DELIBERATELY SEPARATE CONCEPTS (never mixed):
 *   - retrospectiveTrueEnd: MAY use future candles (the whole point of
 *     retrospective research is to look at the completed trajectory).
 *     Reconstructed via Binance historical klines, since liq_raw_events
 *     alone only has sparse, liquidation-moment snapshots -- confirmed
 *     insufficient for continuous candle-close reconstruction in the
 *     prior turn's audit.
 *   - causalDetectedEnd (rules A/B/C): NEVER uses information with a
 *     candle closeTime > the decision instant. Built via a SEPARATE
 *     causal-only extreme-tracking pass, not derived from the
 *     retrospective (future-informed) extreme.
 *
 * ATR FORMULA (documented, per operator instruction): Wilder's
 * standard recursive ATR(14), IDENTICAL to src/shared/indicators.ts's
 * own atr() function (seed = SMA of first 14 true-range values, then
 * atr_t = (atr_{t-1} * 13 + TR_t) / 14). Reimplemented here as an
 * INCREMENTAL per-candle-index series (computeAtrSeries below) purely
 * for O(n) performance across a whole historical window rather than
 * O(n^2) repeated calls -- verified to reproduce atr()'s own output
 * exactly at every index before being used as this script's basis.
 *
 * RETROSPECTIVE TRUE END ALGORITHM (updated Sep 16 2026 after an
 * operator-reported over-merging bug -- see findConfirmedRecovery's
 * own doc comment for the full root-cause explanation):
 *   Extreme-tracking and recovery-confirmation are ONE interleaved
 *   process, not two sequential phases. Starting from the episode's
 *   first liquidation event, the algorithm scans forward: if a deeper
 *   adverse extreme is found before a confirmed recovery, the extreme
 *   updates and the confirmation window RE-ANCHORS from there. The
 *   moment a recovery of `recoveryAtrMultiple` x ATR3m is found AND
 *   never re-violated within `confirmationLookaheadMinutes` of ITS OWN
 *   point, the episode ends there, PERMANENTLY -- no later price
 *   action, however extreme, can reopen it. This directly prevents an
 *   unrelated LATER liquidation move from silently absorbing an
 *   already-completed earlier episode, which is exactly what the
 *   prior "silence gap" design allowed to happen.
 */

const BINANCE_KLINES_URL = "https://fapi.binance.com/fapi/v1/klines";
const ATR_PERIOD = 14;
const MAX_KLINES_PER_REQUEST = 1500;

interface CliArgs {
  symbol: string;
  fromMs: number;
  toMs: number;
}

function parseUtcDatetime(input: string): number {
  if (input.trim().toLowerCase() === "now") return Date.now();
  let s = input.trim();
  const hasExplicitOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!hasExplicitOffset) s = s + "Z";
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Could not parse datetime: "${input}"`);
  return ms;
}

function parseArgs(argv: string[]): CliArgs {
  const symbol = argv[2]?.toUpperCase();
  if (!symbol) {
    console.error(
      'Usage: research-liquidation-episodes.ts <SYMBOL> --hours 24 | --from "..." --to "..."',
    );
    process.exit(1);
  }
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  let fromMs: number, toMs: number;
  const hoursArg = get("--hours");
  if (hoursArg) {
    toMs = Date.now();
    fromMs = toMs - Number(hoursArg) * 3_600_000;
  } else {
    const fromArg = get("--from"),
      toArg = get("--to");
    if (!fromArg) {
      console.error("Must provide --hours or --from/--to");
      process.exit(1);
    }
    fromMs = parseUtcDatetime(fromArg);
    toMs = toArg ? parseUtcDatetime(toArg) : Date.now();
  }
  return { symbol, fromMs, toMs };
}

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

export function deriveCandles(
  oneMin: readonly Candle[],
  intervalMinutes: number,
): Candle[] {
  const intervalMs = intervalMinutes * 60_000;
  const out: Candle[] = [];
  let bucket: Candle[] = [];
  let bucketStart: number | null = null;
  for (const c of oneMin) {
    const alignedStart = Math.floor(c.openTime / intervalMs) * intervalMs;
    if (bucketStart === null) bucketStart = alignedStart;
    if (alignedStart !== bucketStart) {
      out.push(mergeCandles(bucket, bucketStart, intervalMs));
      bucket = [];
      bucketStart = alignedStart;
    }
    bucket.push(c);
  }
  if (bucket.length > 0 && bucketStart !== null)
    out.push(mergeCandles(bucket, bucketStart, intervalMs));
  return out;
}
function mergeCandles(
  bucket: Candle[],
  openTime: number,
  intervalMs: number,
): Candle {
  return {
    symbol: bucket[0]!.symbol,
    interval: (intervalMs === 180_000 ? "3m" : "5m") as Candle["interval"],
    openTime,
    closeTime: openTime + intervalMs - 1,
    open: bucket[0]!.open,
    close: bucket[bucket.length - 1]!.close,
    high: Math.max(...bucket.map((c) => c.high)),
    low: Math.min(...bucket.map((c) => c.low)),
    volume: bucket.reduce((s, c) => s + c.volume, 0),
    quoteVolume: bucket.reduce((s, c) => s + c.quoteVolume, 0),
    takerBuyVolume: bucket.reduce((s, c) => s + c.takerBuyVolume, 0),
    takerBuyQuoteVolume: bucket.reduce((s, c) => s + c.takerBuyQuoteVolume, 0),
    trades: bucket.reduce((s, c) => s + c.trades, 0),
    isClosed: true,
  };
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
  if (!mongoCfg.enabled)
    throw new Error(
      "MONGO_URI not set -- this script reuses the project's own env loading (dotenv/config), same as inspect-liquidation-period.ts",
    );
  const mongo = new MongoClientWrapper(mongoCfg);
  const coll = await mongo.rawLiquidationEvents();
  if (!coll)
    throw new Error("Could not obtain the liq_raw_events collection handle");
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

function get(obj: unknown, path_: string): unknown {
  return path_
    .split(".")
    .reduce(
      (acc: any, key) =>
        acc === null || acc === undefined ? undefined : acc[key],
      obj,
    );
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

/** Sep 16 2026 (Karo), operator-requested REDESIGN. Replaces the prior
 *  fixed-lookahead-window mechanism entirely (that design is what
 *  caused the earlier over-merging bug AND was explicitly rejected as
 *  "not reproducible live"). Named, research-comparable threshold
 *  sets -- not tuned for profitability, purely for episode
 *  segmentation comparison. confirm5mAtrMultiple===null means ATR5m
 *  is recorded as context on every RECOVERY_CONFIRMED/INVALIDATED
 *  transition but does NOT gate the decision (FAST/BALANCED); STRICT
 *  hard-gates on it.
 *
 *  Sep 16 2026 (Karo), operator-requested DISPLACEMENT-AWARE
 *  extension. recoveryFractionMinimum===null means the variant is
 *  displacement-UNAWARE (the three BASELINE variants, unchanged
 *  behavior). When set, an additional condition applies at 3m
 *  confirmation: recovery must also be a large enough FRACTION of the
 *  episode's own total displacement (startReferencePrice -> latest
 *  extreme), not just large relative to current ATR -- a fixed ATR
 *  bar can be trivially easy for a large cascade and structurally
 *  meaningful for a small one. See MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE's
 *  own doc comment for the ATR-normalized safeguard against tiny-
 *  displacement instability. */
export interface Variant {
  name: string;
  candidate1mAtrMultiple: number;
  confirm3mAtrMultiple: number;
  confirm5mAtrMultiple: number | null;
  recoveryFractionMinimum: number | null;
}
/** ATR-normalized safeguard (never a raw dollar minimum, per operator
 *  instruction): the displacement-fraction condition only APPLIES once
 *  the episode's own displacement reaches at least this many ATR3m
 *  units. Below that, a displacement-aware variant behaves exactly
 *  like its ATR-only baseline (the fraction condition is bypassed,
 *  not failed) -- fraction reasoning about "how much of the move has
 *  been recovered" is not yet meaningful for a move that barely
 *  exceeds normal volatility in the first place. */
export const MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE = 1.0;
/** Sep 16 2026 (Karo), operator-requested FREEZE. All other variants
 *  (FAST/BALANCED/STRICT/DISPLACEMENT_FAST/DISPLACEMENT_STRICT) are
 *  removed from this research script entirely -- not just hidden from
 *  output. This directly addresses the confusion that led to the
 *  XRP 27.61% investigation: those baseline variants still reported
 *  episodeDisplacement/episodeDisplacementAtr3m/recoveryFraction on
 *  every episode for cross-variant comparison, even though they never
 *  gated on those values -- making a baseline episode visually
 *  indistinguishable from a genuine DISPLACEMENT_BALANCED one in a
 *  large multi-variant JSON. With exactly one variant, every exported
 *  episode is unambiguously DISPLACEMENT_BALANCED. Config values
 *  UNCHANGED from before -- this is a freeze, not a retune. */
export const PRIMARY_VARIANT: Variant = {
  name: "DISPLACEMENT_BALANCED",
  candidate1mAtrMultiple: 0.75,
  confirm3mAtrMultiple: 1.0,
  confirm5mAtrMultiple: null,
  recoveryFractionMinimum: 0.3,
};
const VARIANTS: Variant[] = [PRIMARY_VARIANT];

interface Transition {
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
  // Sep 16 2026 (Karo), operator-requested debug transparency -- only
  // populated on RECOVERY_CANDIDATE/RECOVERY_CONFIRMED/RECOVERY_INVALIDATED.
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
  endTime: number | null; // null = still open as of the end of the requested data window -- NOT "unresolved forever", just not yet confirmed within available data
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

/** Sep 16 2026 (Karo), operator-requested state machine. Pure causal
 *  replay: at every closed 1m candle, in chronological order, using
 *  only information available by that candle's own closeTime (and,
 *  for confirmation, the next 3m candle's own closeTime) -- NO fixed
 *  future lookahead window anywhere. This is deliberately designed so
 *  the SAME decision could be made live, one candle close at a time --
 *  see this file's own header for the operator's own framing of that
 *  requirement.
 *
 *  Recovery candidates are invalidated the instant a new adverse
 *  extreme appears (extreme always wins over a pending candidate).
 *  Confirmation checks the FIRST 3m candle to close after the
 *  candidate -- exactly one confirmation attempt per candidate; if it
 *  fails, the state machine returns to watching for a fresh 1m
 *  candidate from the (possibly now-deeper) extreme.
 *
 *  `startReferencePrice` is fixed for the whole episode (the first
 *  liquidation event's own price -- see this turn's own written
 *  justification) and is DELIBERATELY tracked separately from
 *  `extreme`, which moves every time a deeper adverse point appears --
 *  episodeDisplacement is the causal distance between these two. */
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
      if (c3.closeTime <= candidate.time) continue; // closed before the candidate existed -- not the relevant one
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
      // Sep 16 2026 (Karo), operator-requested explicit debug field --
      // whether the fraction gate was even APPLICABLE at this instant
      // (variant configured for it AND displacement >= the ATR-
      // normalized minimum), tracked SEPARATELY from whether it PASSED.
      const fractionGateActive =
        variant.recoveryFractionMinimum !== null &&
        episodeDisplacementAtr3m !== null &&
        episodeDisplacementAtr3m >= MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE;
      let passesDisplacement = true; // default: bypassed (gate not active)
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
        // Sep 16 2026 (Karo), operator-requested INVARIANT ASSERTION --
        // triggered by the XRP 27.61% investigation. If this ever
        // throws, that is a REAL bug in the gating logic above, not a
        // display/export issue -- fail loudly rather than silently
        // exporting a confirmation that violates the variant's own
        // configured threshold.
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
    // No fixed lookahead window means: if still open (endTime===null),
    // it genuinely IS still open as of the end of available data -- ALL
    // remaining events belong to it, up to the requested window's end.
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

// ============================================================
// Sep 16 2026 (Karo), operator-requested PHYSICS-based END model
// (Candidate 1 of 3 proposed, recommended and implemented).
// Alongside the unchanged, frozen DISPLACEMENT_BALANCED (control),
// this is the new experimental variant for A/B comparison. Design
// rationale is written up in full in this turn's own response, not
// repeated here -- summary only:
//
//   candidate forms when SAME-DIRECTION liquidation intensity has
//   collapsed relative to the episode's own peak, AND price-extension
//   efficiency has collapsed relative to its own peak, AND price shows
//   at least a small causal recovery -- all three measured causally,
//   no future information. 3m confirmation then requires a modest
//   (not large) ATR3m-normalized hold with no new extreme. Inter-event
//   spacing is reported as a diagnostic (intensity already reflects
//   widening spacing, since spacing directly reduces USD/sec), and
//   episode displacement / recovery fraction are reported as
//   DIAGNOSTIC ONLY, never a hard gate, per operator instruction.
//
// Deliberately kept SEPARATE from Variant/runStateMachine above rather
// than folded into the same abstraction -- this model needs the raw
// SAME-DIRECTION EVENTS array for intensity/efficiency, which the
// ATR-only DISPLACEMENT_BALANCED model never touches. Forcing both
// into one generic function would obscure both.
// ============================================================

interface PhysicsConfig {
  name: string;
  intensityWindowMs: number; // rolling window for "current" liquidation intensity (USD/sec)
  intensityCollapseRatio: number; // candidate eligible once current/peak intensity <= this
  efficiencyCollapseRatio: number; // candidate eligible once current/peak marginal efficiency <= this
  candidateMinRecoveryAtr1m: number; // small causal 1m recovery bar, in ATR1m units
  confirmMinRecoveryAtr3m: number; // modest 3m confirmation bar, in ATR3m units
}
const PHYSICS_CONFIG: PhysicsConfig = {
  name: "PHYSICS_V1",
  intensityWindowMs: 15_000,
  intensityCollapseRatio: 0.3,
  efficiencyCollapseRatio: 0.2,
  candidateMinRecoveryAtr1m: 0.3,
  confirmMinRecoveryAtr3m: 0.5,
};

interface PhysicsTransition {
  type:
    | "START"
    | "EXTREME_UPDATED"
    | "RECOVERY_CANDIDATE"
    | "RECOVERY_INVALIDATED"
    | "RECOVERY_CONFIRMED"
    | "END";
  time: number;
  price?: number;
  reason?: string;
  recovery?: number;
  atr1m?: number | null;
  atr3m?: number | null;
  currentIntensityUsdPerSec?: number;
  peakIntensityUsdPerSec?: number;
  intensityRatio?: number | null;
  currentEfficiencyAtrPerMillion?: number;
  peakEfficiencyAtrPerMillion?: number;
  efficiencyRatio?: number | null;
  typicalActiveSpacingMs?: number | null;
  recentSpacingMs?: number | null;
  episodeDisplacement?: number;
  episodeDisplacementAtr3m?: number | null;
  recoveryFraction?: number | null; // diagnostic only, never gates
}
interface PhysicsEpisode {
  direction: Side;
  startTime: number;
  firstPrice: number;
  extremePrice: number;
  extremeTime: number;
  endTime: number | null;
  transitions: PhysicsTransition[];
  sameDirectionEvents: RawEvent[];
  oppositeSideEvents: RawEvent[];
}

/** USD/sec of SAME-DIRECTION liquidation in the windowMs immediately
 *  before (and including) atOrBeforeMs. Purely causal -- only ever
 *  reads events with timestamp <= atOrBeforeMs. */
function rollingIntensity(
  sameDirEvents: readonly RawEvent[],
  atOrBeforeMs: number,
  windowMs: number,
): number {
  const from = atOrBeforeMs - windowMs;
  let usd = 0;
  for (const ev of sameDirEvents)
    if (ev.timestamp > from && ev.timestamp <= atOrBeforeMs) usd += ev.quoteQty;
  return usd / (windowMs / 1000);
}

export function runPhysicsStateMachine(
  direction: Side,
  startTime: number,
  startReferencePrice: number,
  atrs: Atrs,
  allEventsFromStart: readonly RawEvent[],
  config: PhysicsConfig,
): {
  endTime: number | null;
  extremePrice: number;
  extremeTime: number;
  transitions: PhysicsTransition[];
} {
  const transitions: PhysicsTransition[] = [
    { type: "START", time: startTime, price: startReferencePrice },
  ];
  let extreme = startReferencePrice,
    extremeTime = startTime;
  let candidate: { time: number } | null = null;
  let c3mIdx = 0;
  let endTime: number | null = null;

  const sameDirEvents = allEventsFromStart.filter(
    (ev) => ev.victim === direction,
  );
  let peakIntensity = 0;
  let peakEfficiency = 0;
  let lastEventEfficiency = 0; // the most recently PROCESSED same-direction event's own marginal efficiency, computed once, at the correct causal moment -- never recomputed later against a possibly-stale extreme
  const gapsMs: number[] = [];
  let lastSameDirEventTime = startTime;
  let sameDirIdx = 0; // cursor into sameDirEvents, advanced causally

  const c1mAfter = atrs.c1m.filter((c) => c.closeTime > startTime);
  for (const c of c1mAfter) {
    // Captured BEFORE this candle's own low/high is folded into
    // `extreme` below -- marginal efficiency for any event inside
    // THIS candle must be measured against what was known before this
    // candle's own price action, not after (a bug caught in testing:
    // using the post-update `extreme` made every event's own price
    // look identical to the already-incorporated candle low, zeroing
    // out marginal efficiency for every event).
    const extremeBeforeThisCandle = extreme;
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
    }

    // advance same-direction event cursor causally, updating peak
    // intensity/efficiency/spacing as each new event becomes known
    while (
      sameDirIdx < sameDirEvents.length &&
      sameDirEvents[sameDirIdx]!.timestamp <= c.closeTime
    ) {
      const ev = sameDirEvents[sameDirIdx]!;
      sameDirIdx++;
      const intensityAtEvent = rollingIntensity(
        sameDirEvents.slice(0, sameDirIdx),
        ev.timestamp,
        config.intensityWindowMs,
      );
      if (intensityAtEvent > peakIntensity) peakIntensity = intensityAtEvent;
      const atr3AtEvent = atr3mAt(atrs, ev.timestamp);
      if (atr3AtEvent !== null && atr3AtEvent > 0 && ev.quoteQty > 0) {
        // marginal efficiency: how much NEW adverse extreme (in ATR3m
        // units) this event's own price represents relative to what
        // was known BEFORE this candle's own price action -- clamped
        // >= 0 (no such thing as negative "progress").
        const adverseAtr =
          Math.max(
            0,
            direction === "LONG"
              ? extremeBeforeThisCandle -
                  Math.min(extremeBeforeThisCandle, ev.price)
              : Math.max(extremeBeforeThisCandle, ev.price) -
                  extremeBeforeThisCandle,
          ) / atr3AtEvent;
        const efficiency = adverseAtr / (ev.quoteQty / 1_000_000);
        lastEventEfficiency = efficiency;
        if (efficiency > peakEfficiency) peakEfficiency = efficiency;
      }
      if (sameDirIdx > 1) gapsMs.push(ev.timestamp - lastSameDirEventTime);
      lastSameDirEventTime = ev.timestamp;
    }

    if (!candidate) {
      const recovery =
        direction === "LONG" ? c.close - extreme : extreme - c.close;
      const atr1 = atr1mAt(atrs, c.closeTime);
      const currentIntensity = rollingIntensity(
        sameDirEvents.slice(0, sameDirIdx),
        c.closeTime,
        config.intensityWindowMs,
      );
      const intensityRatio =
        peakIntensity > 0 ? currentIntensity / peakIntensity : null;
      // current efficiency: most recent same-direction event's own marginal efficiency (already folded into peakEfficiency tracking above) -- recompute the LATEST one specifically for the ratio
      let currentEfficiency = lastEventEfficiency;
      const efficiencyRatio =
        peakEfficiency > 0 ? currentEfficiency / peakEfficiency : null;
      const intensityCollapsed =
        intensityRatio !== null &&
        intensityRatio <= config.intensityCollapseRatio;
      const efficiencyCollapsed =
        efficiencyRatio !== null &&
        efficiencyRatio <= config.efficiencyCollapseRatio;
      const hasSmallRecovery =
        atr1 !== null && recovery >= config.candidateMinRecoveryAtr1m * atr1;
      // fallback for the cold-start case (too few same-direction events yet to establish a meaningful peak): require only the small ATR1m recovery, documented explicitly on the transition via null ratios
      const gateEvaluable = intensityRatio !== null && efficiencyRatio !== null;
      const eligible = gateEvaluable
        ? intensityCollapsed && efficiencyCollapsed && hasSmallRecovery
        : hasSmallRecovery;
      if (eligible) {
        candidate = { time: c.closeTime };
        const sortedGaps = [...gapsMs].sort((a, b) => a - b);
        // "typical active spacing" = median of the FASTER half of observed
        // gaps (the burst-phase cadence), not the median of ALL gaps --
        // a cascade's own quiet stretches shouldn't pull this reference
        // value slower and mask a genuine intensity collapse.
        const fasterHalf = sortedGaps.slice(
          0,
          Math.max(1, Math.ceil(sortedGaps.length / 2)),
        );
        const typicalActiveSpacingMs =
          fasterHalf.length > 0
            ? fasterHalf[Math.floor((fasterHalf.length - 1) / 2)]!
            : null;
        transitions.push({
          type: "RECOVERY_CANDIDATE",
          time: c.closeTime,
          price: c.close,
          recovery,
          atr1m: atr1,
          currentIntensityUsdPerSec: currentIntensity,
          peakIntensityUsdPerSec: peakIntensity,
          intensityRatio,
          currentEfficiencyAtrPerMillion: currentEfficiency,
          peakEfficiencyAtrPerMillion: peakEfficiency,
          efficiencyRatio,
          typicalActiveSpacingMs,
          recentSpacingMs: c.closeTime - lastSameDirEventTime,
          reason: gateEvaluable
            ? `intensity collapsed to ${(intensityRatio! * 100).toFixed(1)}% of peak, efficiency collapsed to ${(efficiencyRatio! * 100).toFixed(1)}% of peak, recovery=${recovery.toFixed(6)} >= ${config.candidateMinRecoveryAtr1m}xATR1m`
            : `cold start (insufficient same-direction event history for intensity/efficiency peaks) -- fell back to ATR1m-only trigger`,
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
      const recovery3m =
        direction === "LONG" ? c3.close - extreme : extreme - c3.close;
      const passes3m =
        atr3 !== null && recovery3m >= config.confirmMinRecoveryAtr3m * atr3;

      const episodeDisplacement =
        direction === "LONG"
          ? startReferencePrice - extreme
          : extreme - startReferencePrice;
      const episodeDisplacementAtr3m =
        atr3 !== null && atr3 > 0 ? episodeDisplacement / atr3 : null;
      const recoveryFraction =
        episodeDisplacement > 0 ? recovery3m / episodeDisplacement : null; // DIAGNOSTIC ONLY -- never gates this model, per operator instruction

      const debugFields = {
        recovery: recovery3m,
        atr3m: atr3,
        episodeDisplacement,
        episodeDisplacementAtr3m,
        recoveryFraction,
      };
      if (passes3m) {
        transitions.push({
          type: "RECOVERY_CONFIRMED",
          time: c3.closeTime,
          price: c3.close,
          reason: `PASS: 3m recovery ${recovery3m.toFixed(6)} >= ${config.confirmMinRecoveryAtr3m}xATR3m=${atr3 !== null ? (config.confirmMinRecoveryAtr3m * atr3).toFixed(6) : "n/a"}, no new extreme since candidate`,
          ...debugFields,
        });
        endTime = c3.closeTime;
        transitions.push({ type: "END", time: c3.closeTime });
      } else {
        transitions.push({
          type: "RECOVERY_INVALIDATED",
          time: c3.closeTime,
          reason: `FAIL: 3m recovery ${recovery3m.toFixed(6)} < ${config.confirmMinRecoveryAtr3m}xATR3m=${atr3 !== null ? (config.confirmMinRecoveryAtr3m * atr3).toFixed(6) : "n/a"}`,
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

export function reconstructPhysicsEpisodes(
  events: RawEvent[],
  atrs: Atrs,
  config: PhysicsConfig,
  windowEndMs: number,
): PhysicsEpisode[] {
  const episodes: PhysicsEpisode[] = [];
  let i = 0;
  while (i < events.length) {
    const startEvent = events[i]!;
    const direction = startEvent.victim;
    const eventsFromStart = events.slice(i);
    const { endTime, extremePrice, extremeTime, transitions } =
      runPhysicsStateMachine(
        direction,
        startEvent.timestamp,
        startEvent.price,
        atrs,
        eventsFromStart,
        config,
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

/** Sep 16 2026 (Karo), operator-requested -- adverse price velocity,
 *  derived from the EXTREME_UPDATED transitions already collected by
 *  runPhysicsStateMachine (no new live-loop complexity: this is a
 *  lightweight post-processing pass over data already gathered).
 *  velocity_i = |extreme_i - extreme_{i-1}| / ATR1m(at t_i) / minutes
 *  between the two updates. Reported as peak and "current" (the most
 *  recent such value) -- diagnostic context, not a gating input. */
export function physicsVelocitySummary(
  e: PhysicsEpisode,
  atrs: Atrs,
): {
  peakVelocityAtrPerMin: number | null;
  currentVelocityAtrPerMin: number | null;
} {
  const extremeUpdates = e.transitions.filter(
    (t) => t.type === "EXTREME_UPDATED" || t.type === "START",
  );
  let peak: number | null = null;
  let current: number | null = null;
  for (let i = 1; i < extremeUpdates.length; i++) {
    const prev = extremeUpdates[i - 1]!,
      cur = extremeUpdates[i]!;
    if (prev.price === undefined || cur.price === undefined) continue;
    const atr1 = atr1mAt(atrs, cur.time);
    if (atr1 === null || atr1 <= 0) continue;
    const minutesElapsed = (cur.time - prev.time) / 60_000;
    if (minutesElapsed <= 0) continue;
    const v = Math.abs(cur.price - prev.price) / atr1 / minutesElapsed;
    if (peak === null || v > peak) peak = v;
    current = v;
  }
  return { peakVelocityAtrPerMin: peak, currentVelocityAtrPerMin: current };
}

/** Sep 16 2026 (Karo), operator-requested -- explicit, top-level
 *  summary fields for easy inspection (previously only inside the
 *  transitions array). Generic across every variant -- populated the
 *  same way regardless of whether the variant actually GATES on
 *  displacement/fraction, so BASELINE episodes also get these values
 *  reported (just never used to decide their own END). */
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(`Symbol: ${args.symbol}`);
  console.log(
    `Window: ${new Date(args.fromMs).toISOString()} -> ${new Date(args.toMs).toISOString()}`,
  );
  console.log(
    `Variants: ${VARIANTS.map((v) => `${v.name}(1m>=${v.candidate1mAtrMultiple}xATR1m, 3m>=${v.confirm3mAtrMultiple}xATR3m${v.confirm5mAtrMultiple !== null ? `, 5m>=${v.confirm5mAtrMultiple}xATR5m` : ""}${v.recoveryFractionMinimum !== null ? `, fraction>=${(v.recoveryFractionMinimum * 100).toFixed(0)}% (gated once displacement>=${MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE}xATR3m)` : ""})`).join(" | ")}`,
  );

  console.log("Fetching Binance historical klines...");
  const c1m = await fetchKlines(args.symbol, 60_000, args.fromMs, args.toMs);
  const c3m = await fetchKlines(args.symbol, 180_000, args.fromMs, args.toMs);
  const c5m = await fetchKlines(args.symbol, 300_000, args.fromMs, args.toMs);
  console.log(`Klines: 1m=${c1m.length} 3m=${c3m.length} 5m=${c5m.length}`);
  const atrs: Atrs = {
    c1m,
    c3m,
    c5m,
    series1m: computeAtrSeries(c1m),
    series3m: computeAtrSeries(c3m),
    series5m: computeAtrSeries(c5m),
  };

  console.log(
    "Loading raw liquidation events from liq_raw_events (READ ONLY)...",
  );
  const events = await loadRawEvents(args.symbol, args.fromMs, args.toMs);
  console.log(`Raw events: ${events.length}`);

  const episodeUsd = (e: Episode): number =>
    e.sameDirectionEvents.reduce((s, ev) => s + ev.quoteQty, 0);
  const oiContextFor = (e: Episode): Record<string, unknown> => {
    const startSnap = e.sameDirectionEvents[0]?.marketSnapshot;
    const extremeEventNearby = [...e.sameDirectionEvents]
      .reverse()
      .find((ev) => Math.abs(ev.timestamp - e.extremeTime) < 5 * 60_000);
    const lastSameDirEvent =
      e.sameDirectionEvents[e.sameDirectionEvents.length - 1];
    return {
      oiAtStartUsd: get(startSnap, "openInterest.openInterestUsd") ?? null,
      oiNearExtremeUsd: extremeEventNearby
        ? (get(
            extremeEventNearby.marketSnapshot,
            "openInterest.openInterestUsd",
          ) ?? null)
        : null,
      oiAtLastSameDirEventUsd: lastSameDirEvent
        ? (get(
            lastSameDirEvent.marketSnapshot,
            "openInterest.openInterestUsd",
          ) ?? null)
        : null,
      oiDelta5s: lastSameDirEvent
        ? (get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta5sPct") ??
          null)
        : null,
      oiDelta10s: lastSameDirEvent
        ? (get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta10sPct") ??
          null)
        : null,
      oiDelta15s: lastSameDirEvent
        ? (get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta15sPct") ??
          null)
        : null,
      oiDelta30s: lastSameDirEvent
        ? (get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta30sPct") ??
          null)
        : null,
      oiDelta1m: lastSameDirEvent
        ? (get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta1mPct") ??
          null)
        : null,
      oiDelta2m: lastSameDirEvent
        ? (get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta2mPct") ??
          null)
        : null,
      oiDelta3m: lastSameDirEvent
        ? (get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta3mPct") ??
          null)
        : null,
      oiDelta5m: lastSameDirEvent
        ? (get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta5mPct") ??
          null)
        : null,
    };
  };

  console.log(
    `\n########## VARIANT: ${PRIMARY_VARIANT.name} (the only variant this script now runs) ##########`,
  );
  const episodes = reconstructEpisodesForVariant(
    events,
    atrs,
    PRIMARY_VARIANT,
    args.toMs,
  );
  const longEpisodes = episodes.filter((e) => e.direction === "LONG");
  const shortEpisodes = episodes.filter((e) => e.direction === "SHORT");
  const sameDirEventCount = episodes.reduce(
    (s, e) => s + e.sameDirectionEvents.length,
    0,
  );
  const oppositeEventCount = episodes.reduce(
    (s, e) => s + e.oppositeSideEvents.length,
    0,
  );
  const stillOpenCount = episodes.filter((e) => e.endTime === null).length;

  const usdSorted = episodes.map(episodeUsd).sort((a, b) => a - b);
  const pctTable = {
    p50: percentile(usdSorted, 0.5),
    p70: percentile(usdSorted, 0.7),
    p75: percentile(usdSorted, 0.75),
    p80: percentile(usdSorted, 0.8),
    p90: percentile(usdSorted, 0.9),
    p95: percentile(usdSorted, 0.95),
    p975: percentile(usdSorted, 0.975),
    p99: percentile(usdSorted, 0.99),
  };

  console.log(
    `Episodes: ${episodes.length} (LONG=${longEpisodes.length} SHORT=${shortEpisodes.length})`,
  );
  console.log(
    `Same-direction events: ${sameDirEventCount}  Opposite-side embedded: ${oppositeEventCount}  Still open at window end: ${stillOpenCount}`,
  );
  console.log(`USD percentiles: ${JSON.stringify(pctTable)}`);

  const violations: string[] = [];
  const allAssignedIds = new Set<string>();
  for (const e of episodes)
    for (const ev of [...e.sameDirectionEvents, ...e.oppositeSideEvents]) {
      if (allAssignedIds.has(ev._id))
        violations.push(`event ${ev._id} assigned to two episodes`);
      allAssignedIds.add(ev._id);
    }
  if (allAssignedIds.size !== events.length)
    violations.push(
      `assigned event count (${allAssignedIds.size}) != raw event count (${events.length})`,
    );
  // Sep 16 2026 (Karo), operator-requested -- re-verify the invariant
  // across every exported episode as an EXPORT-TIME check too (the
  // runtime assertion inside runStateMachine already guards this at
  // construction time; this is a second, independent pass over the
  // final transitions array, so a future refactor that bypasses
  // runStateMachine's own check would still be caught here).
  for (const e of episodes) {
    const confirmed = [...e.transitions]
      .reverse()
      .find((t) => t.type === "RECOVERY_CONFIRMED");
    if (
      confirmed &&
      confirmed.fractionGateActive === true &&
      confirmed.recoveryFraction !== null &&
      confirmed.recoveryFraction !== undefined &&
      confirmed.recoveryFraction < PRIMARY_VARIANT.recoveryFractionMinimum!
    ) {
      violations.push(
        `episode starting ${new Date(e.startTime).toISOString()}: RECOVERY_CONFIRMED with fractionGateActive=true and recoveryFraction=${confirmed.recoveryFraction} < required ${PRIMARY_VARIANT.recoveryFractionMinimum}`,
      );
    }
  }
  console.log(`Validation: ${violations.length === 0 ? "PASS" : "FAIL"}`);
  violations.forEach((v) => console.error(`  ${v}`));

  console.log(`\n-- Episode details --`);
  for (const [idx, e] of episodes.entries()) {
    console.log(`\nEpisode #${idx} ${e.direction}`);
    console.log(
      `  START: ${new Date(e.startTime).toISOString()} price=${e.firstPrice}`,
    );
    console.log(
      `  FINAL EXTREME: ${new Date(e.extremeTime).toISOString()} / price ${e.extremePrice}`,
    );
    for (const t of e.transitions) {
      if (t.type === "START") continue;
      const parts = [`  ${t.type}: ${new Date(t.time).toISOString()}`];
      if (t.price !== undefined) parts.push(`price=${t.price}`);
      if (t.recovery !== undefined)
        parts.push(`recovery=${t.recovery.toFixed(2)}`);
      if (t.atr1m !== undefined && t.atr1m !== null)
        parts.push(`ATR1m=${t.atr1m.toFixed(2)}`);
      if (t.atr3m !== undefined && t.atr3m !== null)
        parts.push(`ATR3m=${t.atr3m.toFixed(2)}`);
      if (t.atr5m !== undefined && t.atr5m !== null)
        parts.push(`ATR5m=${t.atr5m.toFixed(2)}`);
      if (t.episodeDisplacement !== undefined)
        parts.push(`episodeDisplacement=${t.episodeDisplacement.toFixed(2)}`);
      if (
        t.episodeDisplacementAtr3m !== undefined &&
        t.episodeDisplacementAtr3m !== null
      )
        parts.push(
          `episodeDisplacementATR3m=${t.episodeDisplacementAtr3m.toFixed(2)}`,
        );
      if (t.recoveryFraction !== undefined && t.recoveryFraction !== null)
        parts.push(
          `recoveryFraction=${(t.recoveryFraction * 100).toFixed(1)}%`,
        );
      if (
        t.requiredRecoveryFraction !== undefined &&
        t.requiredRecoveryFraction !== null
      )
        parts.push(
          `requiredRecoveryFraction=${(t.requiredRecoveryFraction * 100).toFixed(0)}%`,
        );
      if (t.fractionGateActive !== undefined)
        parts.push(`fractionGateActive=${t.fractionGateActive}`);
      if (t.atrConditionPass !== undefined)
        parts.push(`ATRcondition=${t.atrConditionPass ? "PASS" : "FAIL"}`);
      if (t.displacementConditionPass !== undefined)
        parts.push(
          `displacementCondition=${t.displacementConditionPass ? "PASS" : "FAIL"}`,
        );
      if (t.reason) parts.push(`reason="${t.reason}"`);
      console.log(parts.join(" "));
    }
    console.log(
      `  END: ${e.endTime !== null ? new Date(e.endTime).toISOString() : "STILL OPEN at window end"}`,
    );
    const finalTransition = [...e.transitions]
      .reverse()
      .find((t) => t.type === "RECOVERY_CONFIRMED");
    if (finalTransition) {
      console.log(
        `  Episode displacement: ${finalTransition.episodeDisplacement?.toFixed(2)} (${finalTransition.episodeDisplacementAtr3m?.toFixed(2)}x ATR3m)  Recovery fraction at END: ${finalTransition.recoveryFraction !== null && finalTransition.recoveryFraction !== undefined ? (finalTransition.recoveryFraction * 100).toFixed(1) + "%" : "n/a"}`,
      );
    }
    console.log(
      `  Same-direction USD: $${episodeUsd(e).toFixed(0)} (${e.sameDirectionEvents.length} events)  Opposite-side: ${e.oppositeSideEvents.length} events`,
    );
  }

  const outDir = path.join(process.cwd(), "research-output");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const tag = `${args.symbol}-${new Date(args.fromMs).toISOString().slice(0, 16).replace(/[:T]/g, "-")}_to_${new Date(args.toMs).toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  const jsonPath = path.join(outDir, `episodes-${tag}.json`);
  const htmlPath = path.join(outDir, `episodes-${tag}.html`);

  // ---- PHYSICS_V1 run (the new experimental variant, A/B against DISPLACEMENT_BALANCED above) ----
  console.log(
    `\n########## VARIANT: ${PHYSICS_CONFIG.name} (new experimental model) ##########`,
  );
  const physicsEpisodes = reconstructPhysicsEpisodes(
    events,
    atrs,
    PHYSICS_CONFIG,
    args.toMs,
  );
  const physicsLong = physicsEpisodes.filter((e) => e.direction === "LONG");
  const physicsShort = physicsEpisodes.filter((e) => e.direction === "SHORT");
  const physicsSameDirCount = physicsEpisodes.reduce(
    (s, e) => s + e.sameDirectionEvents.length,
    0,
  );
  const physicsOppositeCount = physicsEpisodes.reduce(
    (s, e) => s + e.oppositeSideEvents.length,
    0,
  );
  const physicsStillOpen = physicsEpisodes.filter(
    (e) => e.endTime === null,
  ).length;
  const physicsUsdSorted = physicsEpisodes
    .map(episodeUsd as unknown as (e: PhysicsEpisode) => number)
    .sort((a, b) => a - b);
  const physicsPct = {
    p50: percentile(physicsUsdSorted, 0.5),
    p70: percentile(physicsUsdSorted, 0.7),
    p75: percentile(physicsUsdSorted, 0.75),
    p80: percentile(physicsUsdSorted, 0.8),
    p90: percentile(physicsUsdSorted, 0.9),
    p95: percentile(physicsUsdSorted, 0.95),
    p975: percentile(physicsUsdSorted, 0.975),
    p99: percentile(physicsUsdSorted, 0.99),
  };
  console.log(
    `Episodes: ${physicsEpisodes.length} (LONG=${physicsLong.length} SHORT=${physicsShort.length})  Still open: ${physicsStillOpen}`,
  );
  const physicsViolations: string[] = [];
  const physicsAssignedIds = new Set<string>();
  for (const e of physicsEpisodes)
    for (const ev of [...e.sameDirectionEvents, ...e.oppositeSideEvents]) {
      if (physicsAssignedIds.has(ev._id))
        physicsViolations.push(
          `event ${ev._id} assigned to two physics episodes`,
        );
      physicsAssignedIds.add(ev._id);
    }
  if (physicsAssignedIds.size !== events.length)
    physicsViolations.push(
      `physics-assigned event count (${physicsAssignedIds.size}) != raw event count (${events.length})`,
    );
  console.log(
    `Validation: ${physicsViolations.length === 0 ? "PASS" : "FAIL"}`,
  );
  physicsViolations.forEach((v) => console.error(`  ${v}`));
  for (const [idx, e] of physicsEpisodes.entries()) {
    console.log(
      `\nPhysics Episode #${idx} ${e.direction} START=${new Date(e.startTime).toISOString()}`,
    );
    for (const t of e.transitions) {
      if (t.type === "START") continue;
      const parts = [`  ${t.type}: ${new Date(t.time).toISOString()}`];
      if (t.price !== undefined) parts.push(`price=${t.price}`);
      if (t.reason) parts.push(`reason="${t.reason}"`);
      console.log(parts.join(" "));
    }
    console.log(
      `  END: ${e.endTime !== null ? new Date(e.endTime).toISOString() : "STILL OPEN at window end"}  USD=$${episodeUsd(e as unknown as Episode).toFixed(0)}`,
    );
  }

  // Sep 16 2026 (Karo), operator-requested FREEZE + A/B addition. Flat,
  // per-variant shape -- {metadata, displacementBalanced, physics} --
  // exactly two variants: DISPLACEMENT_BALANCED (control) and
  // PHYSICS_V1 (new experimental model). Every exported episode is
  // unambiguously tagged by which top-level key it lives under.
  const exportPayload = {
    metadata: {
      symbol: args.symbol,
      fromMs: args.fromMs,
      toMs: args.toMs,
      generatedAt: new Date().toISOString(),
      atrFormula:
        "Wilder ATR(14), identical to src/shared/indicators.ts's atr()",
      totalRawEvents: events.length,
    },
    displacementBalanced: {
      configuration: {
        ...PRIMARY_VARIANT,
        minDisplacementAtr3mForFractionGate:
          MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE,
      },
      summary: {
        totalEpisodes: episodes.length,
        longEpisodes: longEpisodes.length,
        shortEpisodes: shortEpisodes.length,
        sameDirectionEvents: sameDirEventCount,
        oppositeSideEvents: oppositeEventCount,
        stillOpenAtWindowEnd: stillOpenCount,
        percentiles: pctTable,
      },
      episodes: episodes.map((e, idx) => ({
        index: idx,
        direction: e.direction,
        startTime: e.startTime,
        firstPrice: e.firstPrice,
        extremePrice: e.extremePrice,
        extremeTime: e.extremeTime,
        endTime: e.endTime,
        endNote:
          e.endTime !== null
            ? "confirmed via causal 1m->3m state machine -- reproducible live"
            : "still open as of the end of the requested data window",
        ...episodeSummary(e),
        transitions: e.transitions,
        sameDirectionUsd: episodeUsd(e),
        sameDirectionEventCount: e.sameDirectionEvents.length,
        oppositeSideEventCount: e.oppositeSideEvents.length,
        largestSameDirectionEventUsd: Math.max(
          ...e.sameDirectionEvents.map((ev) => ev.quoteQty),
        ),
        priceDisplacement: Math.abs(e.extremePrice - e.firstPrice),
        sameDirectionEvents: e.sameDirectionEvents.map((ev) => ({
          timestamp: ev.timestamp,
          price: ev.price,
          quoteQty: ev.quoteQty,
        })),
        oppositeSideEvents: e.oppositeSideEvents.map((ev) => ({
          timestamp: ev.timestamp,
          price: ev.price,
          quoteQty: ev.quoteQty,
        })),
        oi: oiContextFor(e),
      })),
      validation: { violations, pass: violations.length === 0 },
    },
    physics: {
      configuration: PHYSICS_CONFIG,
      summary: {
        totalEpisodes: physicsEpisodes.length,
        longEpisodes: physicsLong.length,
        shortEpisodes: physicsShort.length,
        sameDirectionEvents: physicsSameDirCount,
        oppositeSideEvents: physicsOppositeCount,
        stillOpenAtWindowEnd: physicsStillOpen,
        percentiles: physicsPct,
      },
      episodes: physicsEpisodes.map((e, idx) => {
        const candidateTr = e.transitions.find(
          (t) => t.type === "RECOVERY_CANDIDATE",
        );
        const invalidatedTrs = e.transitions.filter(
          (t) => t.type === "RECOVERY_INVALIDATED",
        );
        const confirmedTr = [...e.transitions]
          .reverse()
          .find((t) => t.type === "RECOVERY_CONFIRMED");
        const velocity = physicsVelocitySummary(e, atrs);
        const eUsd = e.sameDirectionEvents.reduce(
          (s, ev) => s + ev.quoteQty,
          0,
        );
        return {
          index: idx,
          direction: e.direction,
          startTime: e.startTime,
          firstPrice: e.firstPrice,
          extremePrice: e.extremePrice,
          extremeTime: e.extremeTime,
          endTime: e.endTime,
          durationMs: e.endTime !== null ? e.endTime - e.startTime : null,
          endNote:
            e.endTime !== null
              ? "confirmed via causal liq-flow-deceleration + efficiency-collapse + 1m/3m state machine -- reproducible live"
              : "still open as of the end of the requested data window",
          sameDirectionUsd: eUsd,
          sameDirectionEventCount: e.sameDirectionEvents.length,
          oppositeSideEventCount: e.oppositeSideEvents.length,
          liquidationIntensityPeakUsdPerSec:
            candidateTr?.peakIntensityUsdPerSec ??
            confirmedTr?.currentIntensityUsdPerSec ??
            null,
          liquidationIntensityNearEndUsdPerSec:
            candidateTr?.currentIntensityUsdPerSec ?? null,
          intensityCollapseRatio: candidateTr?.intensityRatio ?? null,
          typicalActiveSpacingMs: candidateTr?.typicalActiveSpacingMs ?? null,
          recentSpacingMs: candidateTr?.recentSpacingMs ?? null,
          adversePriceVelocityPeakAtrPerMin: velocity.peakVelocityAtrPerMin,
          adversePriceVelocityCurrentAtrPerMin:
            velocity.currentVelocityAtrPerMin,
          priceImpactEfficiencyPeakAtrPerMillion:
            candidateTr?.peakEfficiencyAtrPerMillion ?? null,
          priceImpactEfficiencyCurrentAtrPerMillion:
            candidateTr?.currentEfficiencyAtrPerMillion ?? null,
          atr1mAtCandidate: candidateTr?.atr1m ?? null,
          atr3mAtEnd: confirmedTr?.atr3m ?? null,
          episodeDisplacement: confirmedTr?.episodeDisplacement ?? null,
          episodeDisplacementAtr3m:
            confirmedTr?.episodeDisplacementAtr3m ?? null,
          recoveryAtrAtCandidate: candidateTr?.recovery ?? null,
          recoveryAtrAtEnd: confirmedTr?.recovery ?? null,
          recoveryFractionAtEnd_diagnosticOnly:
            confirmedTr?.recoveryFraction ?? null,
          candidateReason: candidateTr?.reason ?? null,
          invalidationReasons: invalidatedTrs.map((t) => t.reason),
          endReason: confirmedTr?.reason ?? null,
          sameDirectionEvents: e.sameDirectionEvents.map((ev) => ({
            timestamp: ev.timestamp,
            price: ev.price,
            quoteQty: ev.quoteQty,
          })),
          oppositeSideEvents: e.oppositeSideEvents.map((ev) => ({
            timestamp: ev.timestamp,
            price: ev.price,
            quoteQty: ev.quoteQty,
          })),
        };
      }),
      validation: {
        violations: physicsViolations,
        pass: physicsViolations.length === 0,
      },
    },
  };
  fs.writeFileSync(jsonPath, JSON.stringify(exportPayload, null, 2));
  fs.writeFileSync(
    htmlPath,
    buildHtmlReport(args.symbol, atrs, episodes, episodeUsd),
  );

  console.log(`\nJSON: ${jsonPath}`);
  console.log(`HTML: ${htmlPath}`);

  // ---- BTC debug-window comparison (operator-requested diagnostic
  // print only -- gated on the symbol being BTCUSDT because these are
  // the operator's own named debugging windows, NOT because the
  // segmentation algorithm itself contains any BTC-specific logic;
  // the algorithm above never references this symbol or these times. ----
  if (args.symbol === "BTCUSDT") {
    const dayStart = new Date(args.fromMs);
    dayStart.setUTCHours(0, 0, 0, 0);
    const debugWindows: { label: string; fromMs: number; toMs: number }[] = [
      {
        label: "~14:00-15:00 UTC",
        fromMs: dayStart.getTime() + 14 * 3_600_000,
        toMs: dayStart.getTime() + 15 * 3_600_000,
      },
      {
        label: "~18:30-19:00 UTC",
        fromMs: dayStart.getTime() + 18.5 * 3_600_000,
        toMs: dayStart.getTime() + 19 * 3_600_000,
      },
    ];
    console.log(
      `\n########## BTC DEBUG WINDOW COMPARISON (validation examples only -- not tuned for these) ##########`,
    );
    for (const w of debugWindows) {
      console.log(`\n== ${w.label} ==`);
      const dbOverlap = episodes.filter(
        (e) => e.startTime < w.toMs && (e.endTime ?? args.toMs) > w.fromMs,
      );
      console.log(`  DISPLACEMENT_BALANCED:`);
      for (const e of dbOverlap) {
        const finalTransition = [...e.transitions]
          .reverse()
          .find((t) => t.type === "RECOVERY_CONFIRMED");
        console.log(
          `    ${e.direction} START=${new Date(e.startTime).toISOString().slice(11, 19)} END=${e.endTime !== null ? new Date(e.endTime).toISOString().slice(11, 19) : "OPEN"} usd=$${episodeUsd(e).toFixed(0)} displacement=${finalTransition?.episodeDisplacement?.toFixed(2) ?? "n/a"} recoveryATR3m=${finalTransition?.atr3m !== undefined && finalTransition?.atr3m !== null && finalTransition.recovery !== undefined ? (finalTransition.recovery / finalTransition.atr3m).toFixed(2) : "n/a"} recoveryFraction=${finalTransition?.recoveryFraction !== null && finalTransition?.recoveryFraction !== undefined ? (finalTransition.recoveryFraction * 100).toFixed(1) + "%" : "n/a"}`,
        );
      }
      if (dbOverlap.length === 0)
        console.log(`    (no episode overlaps this window)`);
      const physOverlap = physicsEpisodes.filter(
        (e) => e.startTime < w.toMs && (e.endTime ?? args.toMs) > w.fromMs,
      );
      console.log(`  PHYSICS_V1:`);
      for (const e of physOverlap) {
        const confirmedTr = [...e.transitions]
          .reverse()
          .find((t) => t.type === "RECOVERY_CONFIRMED");
        const candidateTr = e.transitions.find(
          (t) => t.type === "RECOVERY_CANDIDATE",
        );
        console.log(
          `    ${e.direction} START=${new Date(e.startTime).toISOString().slice(11, 19)} END=${e.endTime !== null ? new Date(e.endTime).toISOString().slice(11, 19) : "OPEN"} usd=$${episodeUsd(e as unknown as Episode).toFixed(0)} intensityRatioAtCandidate=${candidateTr?.intensityRatio !== null && candidateTr?.intensityRatio !== undefined ? (candidateTr.intensityRatio * 100).toFixed(1) + "%" : "n/a"} efficiencyRatioAtCandidate=${candidateTr?.efficiencyRatio !== null && candidateTr?.efficiencyRatio !== undefined ? (candidateTr.efficiencyRatio * 100).toFixed(1) + "%" : "n/a"} endReason="${confirmedTr?.reason ?? "n/a"}"`,
        );
      }
      if (physOverlap.length === 0)
        console.log(`    (no episode overlaps this window)`);
      if (dbOverlap.length > 0 && physOverlap.length > 0) {
        const dbEnd = dbOverlap[0]!.endTime,
          physEnd = physOverlap[0]!.endTime;
        if (dbEnd !== null && physEnd !== null)
          console.log(
            `  DIFFERENCE: PHYSICS ended ${((dbEnd - physEnd) / 1000).toFixed(0)}s ${physEnd < dbEnd ? "earlier" : "later"} than DISPLACEMENT_BALANCED in this window`,
          );
      }
    }
  }
}

function buildHtmlReport(
  symbol: string,
  atrs: Atrs,
  episodes: Episode[],
  episodeUsd: (e: Episode) => number,
): string {
  const candles = atrs.c1m;
  if (candles.length === 0)
    return `<html><body><h1>${symbol}</h1><p>No candle data.</p></body></html>`;
  const minPrice = Math.min(...candles.map((c) => c.low));
  const maxPrice = Math.max(...candles.map((c) => c.high));
  const t0 = candles[0]!.openTime,
    t1 = candles[candles.length - 1]!.closeTime;
  const W = 1600,
    H = 500,
    PAD = 50;
  const x = (t: number): number => PAD + ((t - t0) / (t1 - t0)) * (W - 2 * PAD);
  const y = (p: number): number =>
    H - PAD - ((p - minPrice) / (maxPrice - minPrice)) * (H - 2 * PAD);

  const candleSvg = candles
    .map((c) => {
      const cx = x((c.openTime + c.closeTime) / 2);
      const color = c.close >= c.open ? "#26a69a" : "#ef5350";
      const bodyTop = y(Math.max(c.open, c.close)),
        bodyBot = y(Math.min(c.open, c.close));
      return `<line x1="${cx}" y1="${y(c.high)}" x2="${cx}" y2="${y(c.low)}" stroke="${color}" stroke-width="1"/><rect x="${cx - 2}" y="${bodyTop}" width="4" height="${Math.max(1, bodyBot - bodyTop)}" fill="${color}"/>`;
    })
    .join("\n");

  // Sep 16 2026 (Karo), operator-requested -- DISPLACEMENT_BALANCED is
  // now the accepted PRIMARY research variant for cross-symbol
  // validation. Rendered first, full-size, with prominent on-chart
  // "Recovery: X% / ATR3m: Y" text at every confirmed END so manual
  // validation doesn't require reading the table. Every other variant
  // Sep 16 2026 (Karo), operator-requested FREEZE -- only one variant
  // exists now, so the panel is simply rendered directly (the prior
  // "primary panel + collapsed comparison panels" structure is no
  // longer needed since there's nothing else to compare against).
  const episodeSvg = episodes
    .map((e, idx) => {
      const startX = x(e.startTime),
        extremeX = x(e.extremeTime),
        extremeY = y(e.extremePrice);
      const endX = e.endTime !== null ? x(e.endTime) : null;
      const color = e.direction === "LONG" ? "#2962ff" : "#ff6d00";
      let s = `<circle cx="${startX}" cy="${y(e.firstPrice)}" r="4" fill="${color}" stroke="black"/>`;
      s += `<circle cx="${extremeX}" cy="${extremeY}" r="5" fill="yellow" stroke="${color}" stroke-width="2"/>`;
      if (endX !== null) {
        s += `<line x1="${endX}" y1="0" x2="${endX}" y2="${H}" stroke="lime" stroke-width="1.5" stroke-dasharray="4,2"/>`;
        const sum = episodeSummary(e);
        const label =
          sum.recoveryFraction !== null
            ? `Recovery: ${(sum.recoveryFraction * 100).toFixed(1)}% / ATR3m: ${sum.recoveryAtr3m !== null ? sum.recoveryAtr3m.toFixed(2) + "x" : "n/a"}`
            : "";
        if (label)
          s += `<text x="${endX + 4}" y="${20 + (idx % 5) * 12}" font-size="10" fill="lime">${label}</text>`;
      }
      for (const tr of e.transitions) {
        if (tr.type === "RECOVERY_CANDIDATE")
          s += `<circle cx="${x(tr.time)}" cy="${tr.price !== undefined ? y(tr.price) : 0}" r="3" fill="none" stroke="cyan" stroke-width="1"/>`;
        if (tr.type === "RECOVERY_INVALIDATED")
          s += `<circle cx="${x(tr.time)}" cy="${tr.price !== undefined ? y(tr.price) : 0}" r="3" fill="none" stroke="red" stroke-width="1" stroke-dasharray="1,1"/>`;
      }
      for (const ev of e.sameDirectionEvents)
        s += `<circle cx="${x(ev.timestamp)}" cy="${y(ev.price)}" r="2" fill="${color}"/>`;
      for (const ev of e.oppositeSideEvents)
        s += `<circle cx="${x(ev.timestamp)}" cy="${y(ev.price)}" r="2" fill="gray" stroke="black" stroke-width="0.3"/>`;
      return `<g data-episode="${idx}">${s}</g>`;
    })
    .join("\n");
  const table = episodes
    .map((e, idx) => {
      const sum = episodeSummary(e);
      const durationMin =
        sum.durationMs !== null ? (sum.durationMs / 60_000).toFixed(1) : "-";
      const fmt = (v: number | null, digits = 2): string =>
        v !== null ? v.toFixed(digits) : "-";
      return `<tr><td>${idx}</td><td>${e.direction}</td><td>${new Date(e.startTime).toISOString()}</td><td>${e.endTime !== null ? new Date(e.endTime).toISOString() : "STILL OPEN"}</td><td>${durationMin}</td><td>$${episodeUsd(e).toFixed(0)}</td><td>${e.sameDirectionEvents.length}</td><td>${e.oppositeSideEvents.length}</td><td>${fmt(sum.episodeDisplacement)}</td><td>${fmt(sum.episodeDisplacementAtr3m)}</td><td>${fmt(sum.recoveryAtr3m)}</td><td>${fmt(sum.recoveryAtr5m)}</td><td>${sum.recoveryFraction !== null ? (sum.recoveryFraction * 100).toFixed(1) + "%" : "-"}</td></tr>`;
    })
    .join("\n");
  const heading = `${PRIMARY_VARIANT.name} (1m&gt;=${PRIMARY_VARIANT.candidate1mAtrMultiple}xATR1m, 3m&gt;=${PRIMARY_VARIANT.confirm3mAtrMultiple}xATR3m, fraction&gt;=${(PRIMARY_VARIANT.recoveryFractionMinimum! * 100).toFixed(0)}% once displacement&gt;=${MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE}xATR3m) -- ${episodes.length} episodes`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${symbol} liquidation episodes</title>
<style>body{font-family:monospace;background:#111;color:#eee} table{border-collapse:collapse;margin-bottom:20px} td,th{border:1px solid #444;padding:4px 8px} svg{background:#1a1a1a}</style>
</head><body>
<h1>${symbol} -- DISPLACEMENT_BALANCED (the only research variant)</h1>
<p>${heading}</p>
<p>Blue dot=LONG episode start, Orange dot=SHORT episode start, Yellow ring=final extreme, Lime dashed=confirmed END (with recovery%/ATR3m label), Cyan ring=recovery candidate, Red dashed ring=invalidated candidate, gray dot=opposite-side event.</p>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${candleSvg}
${episodeSvg}
</svg>
<table><tr><th>#</th><th>Dir</th><th>Start</th><th>End</th><th>Duration (min)</th><th>Same-dir USD</th><th>Same-dir events</th><th>Opposite events</th><th>Displacement</th><th>Displacement (ATR3m)</th><th>Recovery (ATR3m)</th><th>Recovery (ATR5m)</th><th>Recovery Fraction</th></tr>
${table}
</table>
</body></html>`;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
