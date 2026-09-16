import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { MongoClientWrapper, type MongoDetectorConfig } from "../src/infrastructure/mongo/mongo.client";
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

interface CliArgs { symbol: string; fromMs: number; toMs: number; recoveryAtrMultiple: number; confirmationLookaheadMinutes: number }

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
  if (!symbol) { console.error('Usage: research-liquidation-episodes.ts <SYMBOL> --hours 24 | --from "..." --to "..."'); process.exit(1); }
  const get = (flag: string): string | undefined => { const idx = argv.indexOf(flag); return idx >= 0 ? argv[idx + 1] : undefined; };
  let fromMs: number, toMs: number;
  const hoursArg = get("--hours");
  if (hoursArg) { toMs = Date.now(); fromMs = toMs - Number(hoursArg) * 3_600_000; }
  else {
    const fromArg = get("--from"), toArg = get("--to");
    if (!fromArg) { console.error("Must provide --hours or --from/--to"); process.exit(1); }
    fromMs = parseUtcDatetime(fromArg);
    toMs = toArg ? parseUtcDatetime(toArg) : Date.now();
  }
  return {
    symbol, fromMs, toMs,
    recoveryAtrMultiple: Number(get("--recoveryAtrMultiple") ?? 1.0),
    // Sep 16 2026 (Karo), operator-reported -- reduced from 60 to 20.
    // A genuine dead-cat bounce typically re-violates within single-
    // digit-to-~15 minutes; a SEPARATE, later liquidation move (in the
    // reported BTC case, ~40 minutes after the first recovery) should
    // count as its own independent episode, not retroactively
    // invalidate an already-genuine recovery. Still fully configurable.
    confirmationLookaheadMinutes: Number(get("--confirmationLookaheadMinutes") ?? 20),
  };
}

async function fetchKlines(symbol: string, intervalMs: number, fromMs: number, toMs: number): Promise<Candle[]> {
  const interval = intervalMs === 60_000 ? "1m" : intervalMs === 180_000 ? "3m" : "5m";
  const out: Candle[] = [];
  let cursor = fromMs;
  const seedPadMs = ATR_PERIOD * 3 * intervalMs;
  cursor -= seedPadMs;
  while (cursor < toMs) {
    const url = `${BINANCE_KLINES_URL}?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${toMs}&limit=${MAX_KLINES_PER_REQUEST}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance klines HTTP ${res.status} for ${symbol} ${interval}`);
    const rows = (await res.json()) as unknown[][];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        symbol, interval: interval as Candle["interval"],
        openTime: r[0] as number, closeTime: r[6] as number,
        open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
        volume: Number(r[5]), quoteVolume: Number(r[7]), trades: r[8] as number,
        takerBuyVolume: Number(r[9]), takerBuyQuoteVolume: Number(r[10]),
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

export function deriveCandles(oneMin: readonly Candle[], intervalMinutes: number): Candle[] {
  const intervalMs = intervalMinutes * 60_000;
  const out: Candle[] = [];
  let bucket: Candle[] = [];
  let bucketStart: number | null = null;
  for (const c of oneMin) {
    const alignedStart = Math.floor(c.openTime / intervalMs) * intervalMs;
    if (bucketStart === null) bucketStart = alignedStart;
    if (alignedStart !== bucketStart) {
      out.push(mergeCandles(bucket, bucketStart, intervalMs));
      bucket = []; bucketStart = alignedStart;
    }
    bucket.push(c);
  }
  if (bucket.length > 0 && bucketStart !== null) out.push(mergeCandles(bucket, bucketStart, intervalMs));
  return out;
}
function mergeCandles(bucket: Candle[], openTime: number, intervalMs: number): Candle {
  return {
    symbol: bucket[0]!.symbol, interval: (intervalMs === 180_000 ? "3m" : "5m") as Candle["interval"],
    openTime, closeTime: openTime + intervalMs - 1,
    open: bucket[0]!.open, close: bucket[bucket.length - 1]!.close,
    high: Math.max(...bucket.map((c) => c.high)), low: Math.min(...bucket.map((c) => c.low)),
    volume: bucket.reduce((s, c) => s + c.volume, 0), quoteVolume: bucket.reduce((s, c) => s + c.quoteVolume, 0),
    takerBuyVolume: bucket.reduce((s, c) => s + c.takerBuyVolume, 0), takerBuyQuoteVolume: bucket.reduce((s, c) => s + c.takerBuyQuoteVolume, 0),
    trades: bucket.reduce((s, c) => s + c.trades, 0), isClosed: true,
  };
}

export function computeAtrSeries(candles: readonly Candle[], period = ATR_PERIOD): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!, prev = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
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
export function atrAtOrBefore(candles: readonly Candle[], series: readonly (number | null)[], atOrBeforeMs: number): number | null {
  let bestIdx = -1;
  for (let i = 0; i < candles.length; i++) if (candles[i]!.closeTime <= atOrBeforeMs) bestIdx = i; else break;
  return bestIdx >= 0 ? series[bestIdx] ?? null : null;
}

interface RawEvent { _id: string; timestamp: number; victim: Side; price: number; quoteQty: number; marketSnapshot: Record<string, any> | null }

async function loadRawEvents(symbol: string, fromMs: number, toMs: number): Promise<RawEvent[]> {
  const mongoCfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  if (!mongoCfg.enabled) throw new Error("MONGO_URI not set -- this script reuses the project's own env loading (dotenv/config), same as inspect-liquidation-period.ts");
  const mongo = new MongoClientWrapper(mongoCfg);
  const coll = await mongo.rawLiquidationEvents();
  if (!coll) throw new Error("Could not obtain the liq_raw_events collection handle");
  const docs = await coll.find({ symbol, timestamp: { $gte: fromMs, $lte: toMs } }).sort({ timestamp: 1 }).toArray();
  await mongo.close();
  return docs.map((d: any) => ({ _id: d._id.toString(), timestamp: d.timestamp, victim: d.victim, price: d.price, quoteQty: d.quoteQty, marketSnapshot: d.marketSnapshot ?? null }));
}

function get(obj: unknown, path_: string): unknown {
  return path_.split(".").reduce((acc: any, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);
}

interface Atrs { series1m: (number | null)[]; series3m: (number | null)[]; series5m: (number | null)[]; c1m: Candle[]; c3m: Candle[]; c5m: Candle[] }

function atr3mAt(atrs: Atrs, atOrBeforeMs: number): number | null { return atrAtOrBefore(atrs.c3m, atrs.series3m, atOrBeforeMs); }
function atr5mAt(atrs: Atrs, atOrBeforeMs: number): number | null { return atrAtOrBefore(atrs.c5m, atrs.series5m, atOrBeforeMs); }

interface Episode {
  direction: Side; startTime: number; firstPrice: number;
  extremePrice: number; extremeTime: number;
  retrospectiveTrueEnd: number | null;
  sameDirectionEvents: RawEvent[]; oppositeSideEvents: RawEvent[];
  causalDetectedEnd: { A: number | null; B: number | null; C: number | null };
}

export function reconstructRetrospectiveEpisodes(events: RawEvent[], atrs: Atrs, args: CliArgs): Episode[] {
  const episodes: Episode[] = [];
  let i = 0;
  while (i < events.length) {
    const startEvent = events[i]!;
    const direction = startEvent.victim;

    // Sep 16 2026 (Karo), operator-reported FIX. The prior version had
    // a standalone, UNBOUNDED "silence-gap" extreme-tracking loop that
    // ran BEFORE ever attempting a recovery check -- any incidental
    // new low within the confirmation window of the last extreme, even one
    // completely unrelated to liquidation activity, e.g. a broader
    // downtrend drifting to new lows every <25min) reset the clock and
    // kept "extending" the episode indefinitely, silently absorbing a
    // LATER, independent liquidation move. Root cause confirmed on a
    // real BTC episode: 13:32-14:54 was actually two separate moves
    // (true local low ~13:50-13:52, genuine recovery there, then an
    // unrelated later selloff ~14:30-14:52) merged into one.
    //
    // Fix: findConfirmedRecovery() now OWNS extreme-tracking AND
    // recovery-confirmation as one interleaved process -- it extends
    // the extreme only as far as needed to find a confirmed, non-
    // retraced recovery, then STOPS and RETURNS. There is no separate
    // pass that can walk past an already-confirmed recovery.
    const { endTime, finalExtremePrice, finalExtremeTime } = findConfirmedRecovery(atrs, direction, startEvent.price, startEvent.timestamp, args);

    // Events belong to this (now permanently closed, if endTime is
    // non-null) episode only up to the boundary the search actually
    // used. Once resolved, LATER events -- same direction or not --
    // start a brand new episode, per the operator's explicit lifecycle
    // (LIQUIDATION START -> ... -> EPISODE END -> RESET -> WAIT_FOR_NEW_LIQUIDATION).
    const assignBoundary = endTime !== null ? endTime : finalExtremeTime + args.confirmationLookaheadMinutes * 60_000;

    const sameDirectionEvents: RawEvent[] = [startEvent];
    const oppositeSideEvents: RawEvent[] = [];
    let j = i + 1;
    while (j < events.length && events[j]!.timestamp <= assignBoundary) {
      const ev = events[j]!;
      if (ev.victim === direction) sameDirectionEvents.push(ev); else oppositeSideEvents.push(ev);
      j++;
    }

    const causalDetectedEnd = computeCausalDetectedEnds(atrs, direction, startEvent.timestamp, sameDirectionEvents, events, i, j);
    episodes.push({ direction, startTime: startEvent.timestamp, firstPrice: startEvent.price, extremePrice: finalExtremePrice, extremeTime: finalExtremeTime, retrospectiveTrueEnd: endTime, sameDirectionEvents, oppositeSideEvents, causalDetectedEnd });
    i = j;
  }
  return episodes;
}

export function isMoreAdverse(direction: Side, candidatePrice: number, currentExtreme: number): boolean {
  return direction === "LONG" ? candidatePrice < currentExtreme : candidatePrice > currentExtreme;
}


/** Sep 16 2026 (Karo), operator-reported FIX. Extreme-tracking and
 *  recovery-confirmation are now ONE interleaved process, not two
 *  sequential phases -- see reconstructRetrospectiveEpisodes's own
 *  comment for the full root-cause explanation. The confirmation
 *  window RE-ANCHORS to the current extreme every time it deepens
 *  (rather than staying fixed relative to the very first extreme),
 *  so a genuinely evolving cascade lasting longer than
 *  confirmationLookaheadMinutes isn't prematurely marked unresolved
 *  just because the window was anchored too early. Bounded overall by
 *  an absolute safety cap (6h) so this can never scan forever.
 *  Returns the final extreme reached even when unresolved (endTime
 *  null), so the caller can report/bound the episode consistently. */
export function findConfirmedRecovery(atrs: Atrs, direction: Side, initialExtremePrice: number, initialExtremeTime: number, args: CliArgs): { endTime: number | null; finalExtremePrice: number; finalExtremeTime: number } {
  let currentExtreme = initialExtremePrice;
  let currentExtremeTime = initialExtremeTime;
  const ABSOLUTE_SCAN_CAP_MS = 6 * 60 * 60_000;
  const absoluteScanEnd = initialExtremeTime + ABSOLUTE_SCAN_CAP_MS;

  while (currentExtremeTime < absoluteScanEnd) {
    const atr3 = atr3mAt(atrs, currentExtremeTime);
    if (atr3 === null) return { endTime: null, finalExtremePrice: currentExtreme, finalExtremeTime: currentExtremeTime };
    const threshold = args.recoveryAtrMultiple * atr3;
    const lookaheadEnd = Math.min(currentExtremeTime + args.confirmationLookaheadMinutes * 60_000, absoluteScanEnd);
    const candlesAfter = atrs.c1m.filter((c) => c.closeTime > currentExtremeTime && c.closeTime <= lookaheadEnd);
    if (candlesAfter.length === 0) return { endTime: null, finalExtremePrice: currentExtreme, finalExtremeTime: currentExtremeTime };

    let deepened = false;
    for (let k = 0; k < candlesAfter.length; k++) {
      const c = candlesAfter[k]!;
      const adverseCandidate = direction === "LONG" ? c.low : c.high;
      if (isMoreAdverse(direction, adverseCandidate, currentExtreme)) {
        currentExtreme = adverseCandidate; currentExtremeTime = c.closeTime;
        deepened = true;
        break; // restart with a RE-ANCHORED lookahead window from this new, deeper extreme
      }
      const recovery = direction === "LONG" ? c.close - currentExtreme : currentExtreme - c.close;
      if (recovery >= threshold) {
        const violated = candlesAfter.slice(k + 1).some((future) => isMoreAdverse(direction, direction === "LONG" ? future.low : future.high, currentExtreme));
        if (!violated) return { endTime: c.closeTime, finalExtremePrice: currentExtreme, finalExtremeTime: currentExtremeTime };
        // if violated, the violating candle will itself be reached later in this same scan and trigger the "deepened" branch above
      }
    }
    if (!deepened) return { endTime: null, finalExtremePrice: currentExtreme, finalExtremeTime: currentExtremeTime }; // scanned the whole re-anchored window: no deepening, no confirmed recovery -- truly unresolved
  }
  return { endTime: null, finalExtremePrice: currentExtreme, finalExtremeTime: currentExtremeTime };
}

export function computeCausalDetectedEnds(atrs: Atrs, direction: Side, episodeStart: number, sameDirectionEvents: RawEvent[], allEvents: RawEvent[], startIdx: number, endIdx: number): { A: number | null; B: number | null; C: number | null } {
  let causalExtreme = sameDirectionEvents[0]!.price;
  let causalExtremeTime = sameDirectionEvents[0]!.timestamp;
  const result: { A: number | null; B: number | null; C: number | null } = { A: null, B: null, C: null };
  const episodeEventWindow = allEvents.slice(startIdx, endIdx);
  const lastRelevantTs = episodeEventWindow.length > 0 ? episodeEventWindow[episodeEventWindow.length - 1]!.timestamp : episodeStart;
  const searchEnd = lastRelevantTs + 60 * 60_000;
  for (const c of atrs.c1m) {
    if (c.closeTime <= episodeStart) continue;
    if (c.closeTime > searchEnd) break;
    const adverseCandidate = direction === "LONG" ? c.low : c.high;
    if (isMoreAdverse(direction, adverseCandidate, causalExtreme)) { causalExtreme = adverseCandidate; causalExtremeTime = c.closeTime; }
    const recovery = direction === "LONG" ? c.close - causalExtreme : causalExtreme - c.close;
    const atr3 = atr3mAt(atrs, c.closeTime), atr5 = atr5mAt(atrs, c.closeTime);
    if (result.A === null && atr3 !== null && recovery >= 1.0 * atr3) result.A = c.closeTime;
    if (result.B === null && atr3 !== null && atr5 !== null && recovery >= 1.0 * atr3 && recovery >= 0.5 * atr5) result.B = c.closeTime;
    if (result.C === null && atr3 !== null && atr5 !== null && recovery >= 1.0 * atr3 && recovery >= 0.7 * atr5) result.C = c.closeTime;
    if (result.A !== null && result.B !== null && result.C !== null) break;
  }
  void causalExtremeTime;
  return result;
}

export function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(`Symbol: ${args.symbol}`);
  console.log(`Window: ${new Date(args.fromMs).toISOString()} -> ${new Date(args.toMs).toISOString()}`);
  console.log(`Retrospective params: recoveryAtrMultiple=${args.recoveryAtrMultiple} confirmationLookaheadMinutes=${args.confirmationLookaheadMinutes}`);

  console.log("Fetching Binance historical klines (retrospective reconstruction only)...");
  const c1m = await fetchKlines(args.symbol, 60_000, args.fromMs, args.toMs);
  const c3m = await fetchKlines(args.symbol, 180_000, args.fromMs, args.toMs);
  const c5m = await fetchKlines(args.symbol, 300_000, args.fromMs, args.toMs);
  console.log(`Klines: 1m=${c1m.length} 3m=${c3m.length} 5m=${c5m.length}`);
  const atrs: Atrs = { c1m, c3m, c5m, series1m: computeAtrSeries(c1m), series3m: computeAtrSeries(c3m), series5m: computeAtrSeries(c5m) };

  console.log("Loading raw liquidation events from liq_raw_events (READ ONLY)...");
  const events = await loadRawEvents(args.symbol, args.fromMs, args.toMs);
  console.log(`Raw events: ${events.length}`);

  const episodes = reconstructRetrospectiveEpisodes(events, atrs, args);

  const longEpisodes = episodes.filter((e) => e.direction === "LONG");
  const shortEpisodes = episodes.filter((e) => e.direction === "SHORT");
  const sameDirEventCount = episodes.reduce((s, e) => s + e.sameDirectionEvents.length, 0);
  const oppositeEventCount = episodes.reduce((s, e) => s + e.oppositeSideEvents.length, 0);
  const unresolvedCount = episodes.filter((e) => e.retrospectiveTrueEnd === null).length;

  const episodeUsd = (e: Episode): number => e.sameDirectionEvents.reduce((s, ev) => s + ev.quoteQty, 0);
  const usdSorted = episodes.map(episodeUsd).sort((a, b) => a - b);
  const pctTable = { p50: percentile(usdSorted, 0.5), p70: percentile(usdSorted, 0.7), p75: percentile(usdSorted, 0.75), p80: percentile(usdSorted, 0.8), p90: percentile(usdSorted, 0.9), p95: percentile(usdSorted, 0.95), p975: percentile(usdSorted, 0.975), p99: percentile(usdSorted, 0.99) };

  console.log(`\n=== COUNTS ===`);
  console.log(`Total raw events: ${events.length}`);
  console.log(`Total retrospective episodes: ${episodes.length} (LONG=${longEpisodes.length} SHORT=${shortEpisodes.length})`);
  console.log(`Same-direction events: ${sameDirEventCount}  Opposite-side embedded events: ${oppositeEventCount}`);
  console.log(`Unresolved episodes (no confirmed retrospective end within window/lookahead): ${unresolvedCount}`);
  console.log(`\n=== EPISODE USD PERCENTILES (same-direction only) ===`);
  console.log(JSON.stringify(pctTable));

  console.log(`\n=== CAUSAL DETECTOR COMPARISON ===`);
  const problemCases: { episodeIdx: number; rule: string; kind: string; detail: string }[] = [];
  for (const [idx, e] of episodes.entries()) {
    for (const rule of ["A", "B", "C"] as const) {
      const causal = e.causalDetectedEnd[rule];
      if (e.retrospectiveTrueEnd === null) {
        if (causal !== null) problemCases.push({ episodeIdx: idx, rule, kind: "CAUSAL_DETECTED_BUT_RETROSPECTIVE_UNRESOLVED", detail: `causal=${new Date(causal).toISOString()}` });
        continue;
      }
      if (causal === null) { problemCases.push({ episodeIdx: idx, rule, kind: "NEVER_DETECTED", detail: `retrospectiveTrueEnd=${new Date(e.retrospectiveTrueEnd).toISOString()}` }); continue; }
      const lagSeconds = (causal - e.retrospectiveTrueEnd) / 1000;
      if (causal < e.startTime) problemCases.push({ episodeIdx: idx, rule, kind: "IMPOSSIBLE_BEFORE_START", detail: "causal end before episode start" });
      else if (lagSeconds < -300) problemCases.push({ episodeIdx: idx, rule, kind: "DETECTED_TOO_EARLY", detail: `lag=${lagSeconds}s` });
      else if (lagSeconds > 1800) problemCases.push({ episodeIdx: idx, rule, kind: "DETECTED_LATE", detail: `lag=${lagSeconds}s` });
    }
  }
  console.log(`Problem cases found: ${problemCases.length}`);
  const byKind = new Map<string, number>();
  for (const p of problemCases) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
  console.log(JSON.stringify(Object.fromEntries(byKind)));

  const violations: string[] = [];
  const allAssignedIds = new Set<string>();
  for (const e of episodes) for (const ev of [...e.sameDirectionEvents, ...e.oppositeSideEvents]) {
    if (allAssignedIds.has(ev._id)) violations.push(`event ${ev._id} assigned to two episodes`);
    allAssignedIds.add(ev._id);
  }
  if (allAssignedIds.size !== events.length) violations.push(`assigned event count (${allAssignedIds.size}) != raw event count (${events.length})`);
  console.log(`\n=== VALIDATION: ${violations.length === 0 ? "PASS" : "FAIL"} ===`);
  violations.forEach((v) => console.error(`  ${v}`));

  console.log(`\n=== EPISODE TABLE ===`);
  for (const [idx, e] of episodes.entries()) {
    console.log(`[${idx}] ${e.direction} start=${new Date(e.startTime).toISOString()} extreme=${e.extremePrice}@${new Date(e.extremeTime).toISOString()} trueEnd=${e.retrospectiveTrueEnd ? new Date(e.retrospectiveTrueEnd).toISOString() : "UNRESOLVED"} usd=${episodeUsd(e).toFixed(0)} sameEv=${e.sameDirectionEvents.length} oppEv=${e.oppositeSideEvents.length} causalA=${e.causalDetectedEnd.A ? new Date(e.causalDetectedEnd.A).toISOString() : "-"} causalB=${e.causalDetectedEnd.B ? new Date(e.causalDetectedEnd.B).toISOString() : "-"} causalC=${e.causalDetectedEnd.C ? new Date(e.causalDetectedEnd.C).toISOString() : "-"}`);
  }

  const oiContext = episodes.map((e) => {
    const startSnap = e.sameDirectionEvents[0]?.marketSnapshot;
    const extremeEventNearby = [...e.sameDirectionEvents].reverse().find((ev) => Math.abs(ev.timestamp - e.extremeTime) < 5 * 60_000);
    const lastSameDirEvent = e.sameDirectionEvents[e.sameDirectionEvents.length - 1];
    return {
      oiAtStartUsd: get(startSnap, "openInterest.openInterestUsd") ?? null,
      oiNearExtremeUsd: extremeEventNearby ? get(extremeEventNearby.marketSnapshot, "openInterest.openInterestUsd") ?? null : null,
      oiAtLastSameDirEventUsd: lastSameDirEvent ? get(lastSameDirEvent.marketSnapshot, "openInterest.openInterestUsd") ?? null : null,
      oiDelta5s: lastSameDirEvent ? get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta5sPct") ?? null : null,
      oiDelta10s: lastSameDirEvent ? get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta10sPct") ?? null : null,
      oiDelta15s: lastSameDirEvent ? get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta15sPct") ?? null : null,
      oiDelta30s: lastSameDirEvent ? get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta30sPct") ?? null : null,
      oiDelta1m: lastSameDirEvent ? get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta1mPct") ?? null : null,
      oiDelta2m: lastSameDirEvent ? get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta2mPct") ?? null : null,
      oiDelta3m: lastSameDirEvent ? get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta3mPct") ?? null : null,
      oiDelta5m: lastSameDirEvent ? get(lastSameDirEvent.marketSnapshot, "openInterest.oiDelta5mPct") ?? null : null,
    };
  });

  const outDir = path.join(process.cwd(), "research-output");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const tag = `${args.symbol}-${new Date(args.fromMs).toISOString().slice(0, 16).replace(/[:T]/g, "-")}_to_${new Date(args.toMs).toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  const jsonPath = path.join(outDir, `episodes-${tag}.json`);
  const htmlPath = path.join(outDir, `episodes-${tag}.html`);

  const exportPayload = {
    metadata: { symbol: args.symbol, fromMs: args.fromMs, toMs: args.toMs, params: args, generatedAt: new Date().toISOString(), atrFormula: "Wilder ATR(14), identical to src/shared/indicators.ts's atr()" },
    counts: { totalRawEvents: events.length, totalEpisodes: episodes.length, longEpisodes: longEpisodes.length, shortEpisodes: shortEpisodes.length, sameDirectionEvents: sameDirEventCount, oppositeSideEvents: oppositeEventCount, unresolvedEpisodes: unresolvedCount },
    percentiles: pctTable,
    problemCases,
    validation: { violations, pass: violations.length === 0 },
    episodes: episodes.map((e, idx) => ({
      index: idx, direction: e.direction, startTime: e.startTime, firstPrice: e.firstPrice,
      extremePrice: e.extremePrice, extremeTime: e.extremeTime,
      retrospectiveTrueEnd: e.retrospectiveTrueEnd, retrospectiveNote: "MAY use future candles -- historical reconstruction only, never a live-safe timestamp",
      causalDetectedEnd: e.causalDetectedEnd, causalNote: "NEVER uses information after the candle's own closeTime",
      sameDirectionUsd: episodeUsd(e), sameDirectionEventCount: e.sameDirectionEvents.length, oppositeSideEventCount: e.oppositeSideEvents.length,
      largestSameDirectionEventUsd: Math.max(...e.sameDirectionEvents.map((ev) => ev.quoteQty)),
      priceDisplacement: Math.abs(e.extremePrice - e.firstPrice),
      sameDirectionEvents: e.sameDirectionEvents.map((ev) => ({ timestamp: ev.timestamp, price: ev.price, quoteQty: ev.quoteQty })),
      oppositeSideEvents: e.oppositeSideEvents.map((ev) => ({ timestamp: ev.timestamp, price: ev.price, quoteQty: ev.quoteQty })),
      oi: oiContext[idx],
    })),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(exportPayload, null, 2));
  fs.writeFileSync(htmlPath, buildHtmlReport(args.symbol, atrs, episodes, episodeUsd));

  console.log(`\nJSON: ${jsonPath}`);
  console.log(`HTML: ${htmlPath}`);
}

function buildHtmlReport(symbol: string, atrs: Atrs, episodes: Episode[], episodeUsd: (e: Episode) => number): string {
  const candles = atrs.c1m;
  if (candles.length === 0) return `<html><body><h1>${symbol}</h1><p>No candle data.</p></body></html>`;
  const minPrice = Math.min(...candles.map((c) => c.low));
  const maxPrice = Math.max(...candles.map((c) => c.high));
  const t0 = candles[0]!.openTime, t1 = candles[candles.length - 1]!.closeTime;
  const W = 1600, H = 700, PAD = 50;
  const x = (t: number): number => PAD + ((t - t0) / (t1 - t0)) * (W - 2 * PAD);
  const y = (p: number): number => H - PAD - ((p - minPrice) / (maxPrice - minPrice)) * (H - 2 * PAD);

  const candleSvg = candles.map((c) => {
    const cx = x((c.openTime + c.closeTime) / 2);
    const color = c.close >= c.open ? "#26a69a" : "#ef5350";
    const bodyTop = y(Math.max(c.open, c.close)), bodyBot = y(Math.min(c.open, c.close));
    return `<line x1="${cx}" y1="${y(c.high)}" x2="${cx}" y2="${y(c.low)}" stroke="${color}" stroke-width="1"/><rect x="${cx - 2}" y="${bodyTop}" width="4" height="${Math.max(1, bodyBot - bodyTop)}" fill="${color}"/>`;
  }).join("\n");

  const episodeSvg = episodes.map((e, idx) => {
    const startX = x(e.startTime), extremeX = x(e.extremeTime), extremeY = y(e.extremePrice);
    const trueEndX = e.retrospectiveTrueEnd !== null ? x(e.retrospectiveTrueEnd) : null;
    const color = e.direction === "LONG" ? "#2962ff" : "#ff6d00";
    let s = `<circle cx="${startX}" cy="${y(e.firstPrice)}" r="4" fill="${color}" stroke="black"/>`;
    s += `<circle cx="${extremeX}" cy="${extremeY}" r="5" fill="yellow" stroke="${color}" stroke-width="2"/>`;
    if (trueEndX !== null) s += `<line x1="${trueEndX}" y1="0" x2="${trueEndX}" y2="${H}" stroke="green" stroke-width="1" stroke-dasharray="4,2"/>`;
    for (const rule of ["A", "B", "C"] as const) {
      const t = e.causalDetectedEnd[rule];
      if (t !== null) { const cx = x(t); s += `<line x1="${cx}" y1="0" x2="${cx}" y2="${H}" stroke="purple" stroke-width="0.5" stroke-dasharray="2,4"/><text x="${cx}" y="${12 + ["A", "B", "C"].indexOf(rule) * 10}" font-size="8" fill="purple">${rule}</text>`; }
    }
    for (const ev of e.sameDirectionEvents) s += `<circle cx="${x(ev.timestamp)}" cy="${y(ev.price)}" r="2" fill="${color}"/>`;
    for (const ev of e.oppositeSideEvents) s += `<circle cx="${x(ev.timestamp)}" cy="${y(ev.price)}" r="2" fill="gray" stroke="black" stroke-width="0.3"/>`;
    return `<g data-episode="${idx}">${s}</g>`;
  }).join("\n");

  const table = episodes.map((e, idx) => `<tr><td>${idx}</td><td>${e.direction}</td><td>${new Date(e.startTime).toISOString()}</td><td>${e.retrospectiveTrueEnd ? new Date(e.retrospectiveTrueEnd).toISOString() : "UNRESOLVED"}</td><td>$${episodeUsd(e).toFixed(0)}</td><td>${e.sameDirectionEvents.length}</td><td>${e.oppositeSideEvents.length}</td></tr>`).join("\n");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${symbol} liquidation episodes</title>
<style>body{font-family:monospace;background:#111;color:#eee} table{border-collapse:collapse} td,th{border:1px solid #444;padding:4px 8px} svg{background:#1a1a1a}</style>
</head><body>
<h1>${symbol} -- retrospective vs causal liquidation episodes</h1>
<p>Blue dot=LONG episode start, Orange dot=SHORT episode start, Yellow ring=extreme, Green dashed=retrospectiveTrueEnd (future-informed), Purple dotted=causal A/B/C detected end, gray dot=opposite-side event.</p>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${candleSvg}
${episodeSvg}
</svg>
<h2>Episode table</h2>
<table><tr><th>#</th><th>Dir</th><th>Start</th><th>Retrospective True End</th><th>Same-dir USD</th><th>Same-dir events</th><th>Opposite events</th></tr>
${table}
</table>
</body></html>`;
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}