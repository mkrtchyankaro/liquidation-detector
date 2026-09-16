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

async function fetchKlines(
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

interface RawEvent {
  _id: string;
  timestamp: number;
  victim: Side;
  price: number;
  quoteQty: number;
  marketSnapshot: Record<string, any> | null;
}

async function loadRawEvents(
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

interface Atrs {
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
 *  hard-gates on it. */
interface Variant {
  name: "FAST" | "BALANCED" | "STRICT";
  candidate1mAtrMultiple: number;
  confirm3mAtrMultiple: number;
  confirm5mAtrMultiple: number | null;
}
const VARIANTS: Variant[] = [
  {
    name: "FAST",
    candidate1mAtrMultiple: 0.5,
    confirm3mAtrMultiple: 1.0,
    confirm5mAtrMultiple: null,
  },
  {
    name: "BALANCED",
    candidate1mAtrMultiple: 0.75,
    confirm3mAtrMultiple: 1.0,
    confirm5mAtrMultiple: null,
  },
  {
    name: "STRICT",
    candidate1mAtrMultiple: 1.0,
    confirm3mAtrMultiple: 1.0,
    confirm5mAtrMultiple: 0.5,
  },
];

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
}

interface Episode {
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
 *  candidate from the (possibly now-deeper) extreme. */
export function runStateMachine(
  direction: Side,
  startTime: number,
  startPrice: number,
  atrs: Atrs,
  variant: Variant,
): {
  endTime: number | null;
  extremePrice: number;
  extremeTime: number;
  transitions: Transition[];
} {
  const transitions: Transition[] = [
    { type: "START", time: startTime, price: startPrice },
  ];
  let extreme = startPrice,
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
      if (passes3m && passes5m) {
        transitions.push({
          type: "RECOVERY_CONFIRMED",
          time: c3.closeTime,
          price: c3.close,
          recovery: recovery3m,
          atr3m: atr3,
          atr5m: atr5,
        });
        endTime = c3.closeTime;
        transitions.push({ type: "END", time: c3.closeTime });
      } else {
        transitions.push({
          type: "RECOVERY_INVALIDATED",
          time: c3.closeTime,
          reason: "3m close did not sustain required recovery",
          recovery: recovery3m,
          atr3m: atr3,
          atr5m: atr5,
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(`Symbol: ${args.symbol}`);
  console.log(
    `Window: ${new Date(args.fromMs).toISOString()} -> ${new Date(args.toMs).toISOString()}`,
  );
  console.log(
    `Variants: ${VARIANTS.map((v) => `${v.name}(1m>=${v.candidate1mAtrMultiple}xATR1m, 3m>=${v.confirm3mAtrMultiple}xATR3m${v.confirm5mAtrMultiple !== null ? `, 5m>=${v.confirm5mAtrMultiple}xATR5m` : ""})`).join(" | ")}`,
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

  const variantResults: Record<
    string,
    {
      episodes: Episode[];
      counts: Record<string, unknown>;
      percentiles: Record<string, number | null>;
      violations: string[];
    }
  > = {};

  for (const variant of VARIANTS) {
    console.log(`\n########## VARIANT: ${variant.name} ##########`);
    const episodes = reconstructEpisodesForVariant(
      events,
      atrs,
      variant,
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
    console.log(`Validation: ${violations.length === 0 ? "PASS" : "FAIL"}`);
    violations.forEach((v) => console.error(`  ${v}`));

    console.log(`\n-- Episode details (${variant.name}) --`);
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
        if (t.reason) parts.push(`reason="${t.reason}"`);
        console.log(parts.join(" "));
      }
      console.log(
        `  END: ${e.endTime !== null ? new Date(e.endTime).toISOString() : "STILL OPEN at window end"}`,
      );
      console.log(
        `  Same-direction USD: $${episodeUsd(e).toFixed(0)} (${e.sameDirectionEvents.length} events)  Opposite-side: ${e.oppositeSideEvents.length} events`,
      );
    }

    variantResults[variant.name] = {
      episodes,
      counts: {
        totalEpisodes: episodes.length,
        longEpisodes: longEpisodes.length,
        shortEpisodes: shortEpisodes.length,
        sameDirectionEvents: sameDirEventCount,
        oppositeSideEvents: oppositeEventCount,
        stillOpenAtWindowEnd: stillOpenCount,
      },
      percentiles: pctTable,
      violations,
    };
  }

  const outDir = path.join(process.cwd(), "research-output");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const tag = `${args.symbol}-${new Date(args.fromMs).toISOString().slice(0, 16).replace(/[:T]/g, "-")}_to_${new Date(args.toMs).toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  const jsonPath = path.join(outDir, `episodes-${tag}.json`);
  const htmlPath = path.join(outDir, `episodes-${tag}.html`);

  const exportPayload = {
    metadata: {
      symbol: args.symbol,
      fromMs: args.fromMs,
      toMs: args.toMs,
      generatedAt: new Date().toISOString(),
      atrFormula:
        "Wilder ATR(14), identical to src/shared/indicators.ts's atr()",
      variants: VARIANTS,
      totalRawEvents: events.length,
    },
    variants: Object.fromEntries(
      VARIANTS.map((v) => {
        const r = variantResults[v.name]!;
        return [
          v.name,
          {
            counts: r.counts,
            percentiles: r.percentiles,
            validation: {
              violations: r.violations,
              pass: r.violations.length === 0,
            },
            episodes: r.episodes.map((e, idx) => ({
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
          },
        ];
      }),
    ),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(exportPayload, null, 2));
  fs.writeFileSync(
    htmlPath,
    buildHtmlReport(args.symbol, atrs, variantResults, episodeUsd),
  );

  console.log(`\nJSON: ${jsonPath}`);
  console.log(`HTML: ${htmlPath}`);
}

function buildHtmlReport(
  symbol: string,
  atrs: Atrs,
  variantResults: Record<string, { episodes: Episode[] }>,
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

  const variantPanels = VARIANTS.map((variant) => {
    const episodes = variantResults[variant.name]!.episodes;
    const episodeSvg = episodes
      .map((e, idx) => {
        const startX = x(e.startTime),
          extremeX = x(e.extremeTime),
          extremeY = y(e.extremePrice);
        const endX = e.endTime !== null ? x(e.endTime) : null;
        const color = e.direction === "LONG" ? "#2962ff" : "#ff6d00";
        let s = `<circle cx="${startX}" cy="${y(e.firstPrice)}" r="4" fill="${color}" stroke="black"/>`;
        s += `<circle cx="${extremeX}" cy="${extremeY}" r="5" fill="yellow" stroke="${color}" stroke-width="2"/>`;
        if (endX !== null)
          s += `<line x1="${endX}" y1="0" x2="${endX}" y2="${H}" stroke="lime" stroke-width="1.5" stroke-dasharray="4,2"/>`;
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
      .map(
        (e, idx) =>
          `<tr><td>${idx}</td><td>${e.direction}</td><td>${new Date(e.startTime).toISOString()}</td><td>${e.endTime !== null ? new Date(e.endTime).toISOString() : "STILL OPEN"}</td><td>$${episodeUsd(e).toFixed(0)}</td><td>${e.sameDirectionEvents.length}</td><td>${e.oppositeSideEvents.length}</td></tr>`,
      )
      .join("\n");
    return `<h2>${variant.name} (1m&gt;=${variant.candidate1mAtrMultiple}xATR1m, 3m&gt;=${variant.confirm3mAtrMultiple}xATR3m${variant.confirm5mAtrMultiple !== null ? `, 5m&gt;=${variant.confirm5mAtrMultiple}xATR5m` : ""}) -- ${episodes.length} episodes</h2>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${candleSvg}
${episodeSvg}
</svg>
<table><tr><th>#</th><th>Dir</th><th>Start</th><th>End</th><th>Same-dir USD</th><th>Same-dir events</th><th>Opposite events</th></tr>
${table}
</table>`;
  }).join("\n<hr/>\n");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${symbol} liquidation episodes</title>
<style>body{font-family:monospace;background:#111;color:#eee} table{border-collapse:collapse;margin-bottom:20px} td,th{border:1px solid #444;padding:4px 8px} svg{background:#1a1a1a}</style>
</head><body>
<h1>${symbol} -- causal 1m recovery candidate -> 3m confirmation state machine, by variant</h1>
<p>Blue dot=LONG episode start, Orange dot=SHORT episode start, Yellow ring=final extreme, Lime dashed=confirmed END, Cyan ring=recovery candidate, Red dashed ring=invalidated candidate, gray dot=opposite-side event.</p>
${variantPanels}
</body></html>`;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
