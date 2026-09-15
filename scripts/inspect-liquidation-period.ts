import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import type { RawLiquidationEventDoc } from "../src/infrastructure/mongo/raw-liquidation-event.repository";

/**
 * Sep 15 2026 (Karo), operator-requested. Reusable, READ-ONLY
 * liquidation research/export CLI -- any symbol, any time window, not
 * a one-off BTC script. No writes/updates/deletes/drops/index-creates
 * anywhere in this file; only find()/sort() plus in-memory
 * aggregation.
 *
 *   npx tsx scripts/inspect-liquidation-period.ts BTCUSDT "2026-09-15 13:20" "2026-09-15 15:10"
 *   npx tsx scripts/inspect-liquidation-period.ts BTCUSDT "2026-09-15 13:20" "2026-09-15 15:10" 3m
 *   npx tsx scripts/inspect-liquidation-period.ts BTCUSDT "2026-09-15 13:20" "2026-09-15 15:10" 5m
 *   npx tsx scripts/inspect-liquidation-period.ts XRPUSDT "2026-09-15 12:00" "now"
 *
 * MONGO CONFIG REUSE: constructs the SAME MongoDetectorConfig shape
 * main.ts itself builds (process.env.MONGO_URI/MONGO_SHARED_DB/
 * MONGO_OWN_DB, same defaults), then uses the EXISTING
 * MongoClientWrapper + its EXISTING rawLiquidationEvents() accessor --
 * no parallel connection logic, no new env var names invented. `dotenv/
 * config` import at the top matches main.ts's own first line, so a
 * `.env` in the project root loads automatically -- no MONGO_URI on
 * the command line required.
 *
 * TIME PARSING: bare "YYYY-MM-DD HH:mm[:ss]" (no explicit offset) is
 * treated as UTC, per operator instruction. An explicit "Z" or
 * "+HH:MM"/"-HH:MM" suffix is respected as given. "now" (case-
 * insensitive) resolves to the current instant. Parsed UTC start/end
 * are printed before querying so the window can be verified.
 *
 * RESOLUTION (Sep 15 2026, operator-requested): optional 5th CLI arg,
 * one of "1m"/"3m"/"5m"/"10m"/"15m", defaulting to "1m" when omitted -- and when
 * omitted, output/filenames are byte-identical to the prior 1m-only
 * behavior (no suffix), so nothing that already depends on this
 * script's output breaks. All bucketing is built DIRECTLY from
 * rawEvents (never resampled from a pre-built 1m table) and aligned
 * to true UTC wall-clock boundaries divisible by the resolution
 * (e.g. 3m buckets start at :00/:03/:06/.../:57, never relative to
 * the first event's own timestamp) -- see bucketKey() below.
 */

const RESOLUTION_MINUTES: Record<string, number> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "10m": 10,
  "15m": 15,
};

function parseUtcDatetime(input: string): number {
  if (input.trim().toLowerCase() === "now") return Date.now();
  let s = input.trim();
  const hasExplicitOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!hasExplicitOffset) s = s + "Z"; // bare datetime -> force UTC interpretation
  const ms = Date.parse(s);
  if (Number.isNaN(ms))
    throw new Error(`Could not parse datetime: "${input}" (tried "${s}")`);
  return ms;
}

function fmtUtc(ms: number): string {
  return new Date(ms).toISOString();
}
/** True UTC wall-clock-aligned bucket key for the given resolution.
 *  For resMinutes=1 this is IDENTICAL to the prior fmtMinute() (simple
 *  truncation to the minute) -- for resMinutes=3/5, the minute is
 *  floored to the nearest multiple of resMinutes (0,3,6,... or
 *  0,5,10,...), matching the operator's own examples exactly (13:30-
 *  13:32:59, 13:33-13:35:59, ... for 3m), never a rolling window
 *  relative to the first event. */
function bucketKey(ms: number, resMinutes: number): string {
  const d = new Date(ms);
  const alignedMinute = Math.floor(d.getUTCMinutes() / resMinutes) * resMinutes;
  const aligned = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      alignedMinute,
      0,
      0,
    ),
  );
  return aligned.toISOString().slice(0, 16).replace("T", " ");
}
/** Human-readable end-of-bucket label (e.g. "13:32:59") for console
 *  display only -- purely cosmetic, not used for any bucketing logic. */
function bucketEndLabel(bucketStartKey: string, resMinutes: number): string {
  const startMs = Date.parse(bucketStartKey.replace(" ", "T") + ":00Z");
  const endMs = startMs + resMinutes * 60_000 - 1000;
  return new Date(endMs).toISOString().slice(11, 19);
}
function filenameSafe(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace(/[:T]/g, "-");
}

interface CompactEvent {
  _id: string;
  timestamp: number;
  victim: "LONG" | "SHORT";
  price: number;
  quoteQty: number;
  priceState: Record<string, unknown> | null;
  openInterest: Record<string, unknown> | null;
  takerFlow: Record<string, unknown> | null;
  orderBook: Record<string, unknown> | null;
  atr: Record<string, unknown> | null;
  positioning: Record<string, unknown> | null;
  funding: Record<string, unknown> | null;
  liquidationContext: Record<string, unknown> | null;
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
function n(v: unknown, digits = 2): string {
  return v === null || v === undefined
    ? "-"
    : typeof v === "number"
      ? v.toFixed(digits)
      : String(v);
}

async function main(): Promise<void> {
  const [, , symbolArg, fromArg, toArg, resolutionArgRaw] = process.argv;
  if (!symbolArg || !fromArg) {
    console.error(
      'Usage: inspect-liquidation-period.ts <SYMBOL> "<FROM datetime>" ["<TO datetime>" | "now"] [1m|3m|5m|10m|15m]',
    );
    process.exit(1);
  }
  const resolutionArg = resolutionArgRaw?.trim().toLowerCase();
  if (resolutionArg && !(resolutionArg in RESOLUTION_MINUTES)) {
    console.error(
      `Invalid resolution "${resolutionArgRaw}" -- must be one of: ${Object.keys(RESOLUTION_MINUTES).join(", ")}`,
    );
    process.exit(1);
  }
  const resolution = resolutionArg ?? "1m";
  const resMinutes = RESOLUTION_MINUTES[resolution]!;
  const symbol = symbolArg.toUpperCase();
  const fromMs = parseUtcDatetime(fromArg);
  const toMs = toArg ? parseUtcDatetime(toArg) : Date.now();
  if (fromMs >= toMs) {
    console.error(
      `FROM (${fmtUtc(fromMs)}) must be before TO (${fmtUtc(toMs)})`,
    );
    process.exit(1);
  }

  console.log(`Symbol: ${symbol}`);
  console.log(`Resolution: ${resolution}`);
  console.log(`Parsed UTC window: ${fmtUtc(fromMs)} -> ${fmtUtc(toMs)}`);

  const mongoCfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  if (!mongoCfg.enabled) {
    console.error(
      "MONGO_URI is not set in the environment/.env -- cannot connect. This script reuses the project's own env loading (dotenv/config); it does not invent a new config mechanism.",
    );
    process.exit(1);
  }
  const mongo = new MongoClientWrapper(mongoCfg);

  // READ ONLY: find() + sort() only. No insert/update/delete/drop/createIndex anywhere in this file.
  const coll = await mongo.rawLiquidationEvents();
  if (!coll) {
    console.error(
      "Could not obtain the liq_raw_events collection handle (Mongo connection failed).",
    );
    process.exit(1);
  }

  const docs = await coll
    .find({
      symbol,
      marketSnapshot: { $exists: true },
      timestamp: { $gte: fromMs, $lte: toMs },
    })
    .sort({ timestamp: 1 })
    .toArray();
  await mongo.close();

  console.log(`Event count: ${docs.length}`);
  if (docs.length === 0) {
    console.log("No enriched events found in this window.");
    return;
  }

  // ---- validation (read-only, in-memory only) ----
  const violations: string[] = [];
  const seenIds = new Set<string>();
  let prevTs = -Infinity;
  for (const d of docs) {
    const doc = d as unknown as RawLiquidationEventDoc & {
      _id: { toString(): string };
    };
    const idStr = doc._id.toString();
    if (seenIds.has(idStr)) violations.push(`duplicate _id: ${idStr}`);
    seenIds.add(idStr);
    if (doc.timestamp < prevTs)
      violations.push(`chronological order violated at ${idStr}`);
    prevTs = doc.timestamp;
    if (doc.timestamp < fromMs || doc.timestamp > toMs)
      violations.push(`event ${idStr} outside requested window`);
    if (doc.symbol !== symbol)
      violations.push(`event ${idStr} symbol mismatch: ${doc.symbol}`);
    if (!doc.marketSnapshot)
      violations.push(
        `event ${idStr} missing marketSnapshot (should have been filtered by the query)`,
      );
    const ms = doc.marketSnapshot as Record<string, unknown> | undefined;
    if (ms) {
      const causalChecks: [string, unknown, unknown][] = [
        ["oiUpdatedAt", get(ms, "openInterest.oiUpdatedAt"), doc.timestamp],
        [
          "positioningUpdatedAt",
          get(ms, "positioning.positioningUpdatedAt"),
          doc.timestamp,
        ],
        [
          "fundingUpdatedAt",
          get(ms, "funding.fundingUpdatedAt"),
          doc.timestamp,
        ],
        [
          "orderBookUpdatedAt",
          get(ms, "orderBook.orderBookUpdatedAt"),
          doc.timestamp,
        ],
      ];
      for (const [name, src, evtTs] of causalChecks) {
        if (typeof src === "number" && src > (evtTs as number))
          violations.push(
            `event ${idStr}: ${name}=${src} is AFTER event timestamp ${evtTs}`,
          );
      }
      const ageChecks: [string, unknown][] = [
        ["oiAgeMs", get(ms, "openInterest.oiAgeMs")],
        ["positioningAgeMs", get(ms, "positioning.positioningAgeMs")],
        ["fundingAgeMs", get(ms, "funding.fundingAgeMs")],
        ["orderBookAgeMs", get(ms, "orderBook.orderBookAgeMs")],
      ];
      for (const [name, v] of ageChecks)
        if (typeof v === "number" && v < 0)
          violations.push(`event ${idStr}: ${name}=${v} is negative`);
    }
  }

  // ---- compact events (event-level resolution preserved for export) ----
  const compact: CompactEvent[] = docs.map((d: any) => ({
    _id: d._id.toString(),
    timestamp: d.timestamp,
    victim: d.victim,
    price: d.price,
    quoteQty: d.quoteQty,
    priceState: d.marketSnapshot.priceState ?? null,
    openInterest: d.marketSnapshot.openInterest ?? null,
    takerFlow: d.marketSnapshot.takerFlow ?? null,
    orderBook: d.marketSnapshot.orderBook ?? null,
    atr: d.marketSnapshot.atr ?? null,
    positioning: d.marketSnapshot.positioning ?? null,
    funding: d.marketSnapshot.funding ?? null,
    liquidationContext: d.marketSnapshot.liquidationContext ?? null,
  }));

  // ---- summary ----
  const totalLongUsd = compact
    .filter((e) => e.victim === "LONG")
    .reduce((s, e) => s + e.quoteQty, 0);
  const totalShortUsd = compact
    .filter((e) => e.victim === "SHORT")
    .reduce((s, e) => s + e.quoteQty, 0);
  const prices = compact.map((e) => e.price);
  const summary = {
    symbol,
    requestedUtcFrom: fmtUtc(fromMs),
    requestedUtcTo: fmtUtc(toMs),
    firstEventTimestamp: compact[0]!.timestamp,
    lastEventTimestamp: compact[compact.length - 1]!.timestamp,
    eventCount: compact.length,
    totalLongLiquidationUsd: totalLongUsd,
    totalShortLiquidationUsd: totalShortUsd,
    firstEventPrice: compact[0]!.price,
    lowestEventPrice: Math.min(...prices),
    highestEventPrice: Math.max(...prices),
    lastEventPrice: compact[compact.length - 1]!.price,
  };
  console.log("\n=== SUMMARY ===");
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);

  // ---- buckets, built DIRECTLY from rawEvents at the requested resolution (never resampled from a pre-built table) ----
  interface Bucket {
    bucketStart: string;
    longCount: number;
    longUsd: number;
    shortCount: number;
    shortUsd: number;
    totalUsd: number;
    cumulativeLongUsd: number;
    cumulativeShortUsd: number;
    firstPrice: number;
    lastPrice: number;
    minPrice: number;
    maxPrice: number;
    latestSnapshot: CompactEvent;
  }
  const byBucket = new Map<string, CompactEvent[]>();
  for (const e of compact) {
    const key = bucketKey(e.timestamp, resMinutes);
    let arr = byBucket.get(key);
    if (!arr) {
      arr = [];
      byBucket.set(key, arr);
    }
    arr.push(e);
  }
  const bucketKeys = [...byBucket.keys()].sort();
  let cumLong = 0,
    cumShort = 0;
  const buckets: Bucket[] = bucketKeys.map((bucketStart) => {
    const events = byBucket.get(bucketStart)!;
    const longs = events.filter((e) => e.victim === "LONG"),
      shorts = events.filter((e) => e.victim === "SHORT");
    const longUsd = longs.reduce((s, e) => s + e.quoteQty, 0),
      shortUsd = shorts.reduce((s, e) => s + e.quoteQty, 0);
    cumLong += longUsd;
    cumShort += shortUsd;
    const prices_ = events.map((e) => e.price);
    return {
      bucketStart,
      longCount: longs.length,
      longUsd,
      shortCount: shorts.length,
      shortUsd,
      totalUsd: longUsd + shortUsd,
      cumulativeLongUsd: cumLong,
      cumulativeShortUsd: cumShort,
      firstPrice: events[0]!.price,
      lastPrice: events[events.length - 1]!.price,
      minPrice: Math.min(...prices_),
      maxPrice: Math.max(...prices_),
      latestSnapshot: events[events.length - 1]!,
    };
  });

  // bucket-sum validation
  const bucketLongTotal = buckets.reduce((s, b) => s + b.longUsd, 0);
  const bucketShortTotal = buckets.reduce((s, b) => s + b.shortUsd, 0);
  if (Math.abs(bucketLongTotal - totalLongUsd) > 1e-6)
    violations.push(
      `bucket LONG total (${bucketLongTotal}) != raw LONG total (${totalLongUsd})`,
    );
  if (Math.abs(bucketShortTotal - totalShortUsd) > 1e-6)
    violations.push(
      `bucket SHORT total (${bucketShortTotal}) != raw SHORT total (${totalShortUsd})`,
    );

  // ---- console table ----
  console.log(`\n=== ${resolution.toUpperCase()} BUCKETS ===`);
  for (const b of buckets) {
    const s = b.latestSnapshot;
    console.log(
      `\n-- ${b.bucketStart}:00 to ${bucketEndLabel(b.bucketStart, resMinutes)} UTC --`,
    );
    console.log(
      `  LIQUIDATION  long: ${b.longCount}ev $${n(b.longUsd, 0)}  short: ${b.shortCount}ev $${n(b.shortUsd, 0)}  total: $${n(b.totalUsd, 0)}  cumLong: $${n(b.cumulativeLongUsd, 0)}  cumShort: $${n(b.cumulativeShortUsd, 0)}`,
    );
    console.log(
      `  PRICE        first: ${n(b.firstPrice, 2)}  last: ${n(b.lastPrice, 2)}  min: ${n(b.minPrice, 2)}  max: ${n(b.maxPrice, 2)}`,
    );
    const oiFirst = byBucket.get(b.bucketStart)![0]!.openInterest,
      oiLast = s.openInterest;
    const oiFirstUsd = get(oiFirst, "openInterestUsd") as number | null,
      oiLastUsd = get(oiLast, "openInterestUsd") as number | null;
    const oiAbsChange =
      typeof oiFirstUsd === "number" && typeof oiLastUsd === "number"
        ? oiLastUsd - oiFirstUsd
        : null;
    const oiPctChange =
      typeof oiFirstUsd === "number" &&
      oiFirstUsd > 0 &&
      typeof oiLastUsd === "number"
        ? ((oiLastUsd - oiFirstUsd) / oiFirstUsd) * 100
        : null;
    console.log(
      `  OI           first: ${n(oiFirstUsd, 0)}  last: ${n(oiLastUsd, 0)}  absChange: ${n(oiAbsChange, 0)}  pctChange: ${n(oiPctChange)}  oi1m%: ${n(get(oiLast, "oiChange1mPct"))}  oi3m%: ${n(get(oiLast, "oiChange3mPct"))}  oi5m%: ${n(get(oiLast, "oiChange5mPct"))}`,
    );
    console.log(
      `  TAKER        10s buy/sell/imb: ${n(get(s.takerFlow, "10s.takerBuyPct"), 1)}/${n(get(s.takerFlow, "10s.takerSellPct"), 1)}/${n(get(s.takerFlow, "10s.imbalance"), 3)}  30s: ${n(get(s.takerFlow, "30s.takerBuyPct"), 1)}/${n(get(s.takerFlow, "30s.takerSellPct"), 1)}/${n(get(s.takerFlow, "30s.imbalance"), 3)}  1m: ${n(get(s.takerFlow, "1m.takerBuyPct"), 1)}/${n(get(s.takerFlow, "1m.takerSellPct"), 1)}/${n(get(s.takerFlow, "1m.imbalance"), 3)}  2m: ${n(get(s.takerFlow, "2m.takerBuyPct"), 1)}/${n(get(s.takerFlow, "2m.takerSellPct"), 1)}/${n(get(s.takerFlow, "2m.imbalance"), 3)}  3m: ${n(get(s.takerFlow, "3m.takerBuyPct"), 1)}/${n(get(s.takerFlow, "3m.takerSellPct"), 1)}/${n(get(s.takerFlow, "3m.imbalance"), 3)}  5m: ${n(get(s.takerFlow, "5m.takerBuyPct"), 1)}/${n(get(s.takerFlow, "5m.takerSellPct"), 1)}/${n(get(s.takerFlow, "5m.imbalance"), 3)}`,
    );
    console.log(
      `  ORDERBOOK    bidD5bp: ${n(get(s.orderBook, "bidDepth5bpUsd"), 0)}  askD5bp: ${n(get(s.orderBook, "askDepth5bpUsd"), 0)}  imb5bp: ${n(get(s.orderBook, "imbalance5bp"), 3)}  imbΔ30s: ${n(get(s.orderBook, "bookImbalanceChangeVs30sAgo"), 3)}  imbΔ1m: ${n(get(s.orderBook, "bookImbalanceChangeVs1mAgo"), 3)}  bidΔ30s: ${n(get(s.orderBook, "bidDepthChangeVs30sAgoUsd"), 0)}  askΔ30s: ${n(get(s.orderBook, "askDepthChangeVs30sAgoUsd"), 0)}  bidΔ1m: ${n(get(s.orderBook, "bidDepthChangeVs1mAgoUsd"), 0)}  askΔ1m: ${n(get(s.orderBook, "askDepthChangeVs1mAgoUsd"), 0)}`,
    );
    console.log(
      `  ATR 1m       normal%: ${n(get(s.atr, "1m.normalAtrPct"))}  liq%: ${n(get(s.atr, "1m.liquidationDirectionAtrPct"))}  rec%: ${n(get(s.atr, "1m.recoveryDirectionAtrPct"))}  rec/liq: ${n(get(s.atr, "1m.recoveryToLiquidationAtrRatio"))}`,
    );
    console.log(
      `  ATR 3m       normal%: ${n(get(s.atr, "3m.normalAtrPct"))}  liq%: ${n(get(s.atr, "3m.liquidationDirectionAtrPct"))}  rec%: ${n(get(s.atr, "3m.recoveryDirectionAtrPct"))}  rec/liq: ${n(get(s.atr, "3m.recoveryToLiquidationAtrRatio"))}`,
    );
    console.log(
      `  ATR 5m       normal%: ${n(get(s.atr, "5m.normalAtrPct"))}  liq%: ${n(get(s.atr, "5m.liquidationDirectionAtrPct"))}  rec%: ${n(get(s.atr, "5m.recoveryDirectionAtrPct"))}  rec/liq: ${n(get(s.atr, "5m.recoveryToLiquidationAtrRatio"))}`,
    );
    console.log(
      `  POSITIONING  gLong%: ${n(get(s.positioning, "globalLongPct"), 1)}  gShort%: ${n(get(s.positioning, "globalShortPct"), 1)}  tLong%: ${n(get(s.positioning, "topTraderLongPositionPct"), 1)}  tShort%: ${n(get(s.positioning, "topTraderShortPositionPct"), 1)}`,
    );
    console.log(`  FUNDING      rate: ${n(get(s.funding, "fundingRate"), 6)}`);
    console.log(
      `  LIQ CONTEXT  ss10s: $${n(get(s.liquidationContext, "sameSideLiqUsd10s"), 0)}  ss30s: $${n(get(s.liquidationContext, "sameSideLiqUsd30s"), 0)}  ss1m: $${n(get(s.liquidationContext, "sameSideLiqUsd1m"), 0)}  ss3m: $${n(get(s.liquidationContext, "sameSideLiqUsd3m"), 0)}  ss5m: $${n(get(s.liquidationContext, "sameSideLiqUsd5m"), 0)}  opp1m: $${n(get(s.liquidationContext, "oppositeSideLiqUsd1m"), 0)}`,
    );
  }

  // ---- validation report ----
  console.log(
    `\n=== VALIDATION: ${violations.length === 0 ? "PASS" : "FAIL"} ===`,
  );
  violations.forEach((v) => console.error(`  ${v}`));

  // ---- JSON export ----
  const outDir = path.join(process.cwd(), "research-output");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  // Backward-compat: omitting the resolution arg produces the EXACT
  // same filename as before (no suffix). Explicitly passing a
  // resolution (including "1m") adds a "-Xm" suffix, matching the
  // operator's own example (...-3m.json).
  const resolutionSuffix = resolutionArg ? `-${resolution}` : "";
  const outPath = path.join(
    outDir,
    `${symbol}-${filenameSafe(fromMs)}_to_${filenameSafe(toMs)}${resolutionSuffix}.json`,
  );
  const exportPayload = {
    metadata: {
      symbol,
      resolution,
      requestedUtcFrom: fmtUtc(fromMs),
      requestedUtcTo: fmtUtc(toMs),
      generatedAt: fmtUtc(Date.now()),
      eventCount: compact.length,
      validationViolations: violations,
    },
    summary,
    rawEvents: compact,
    buckets: buckets.map((b) => ({
      bucketStart: b.bucketStart,
      longCount: b.longCount,
      longUsd: b.longUsd,
      shortCount: b.shortCount,
      shortUsd: b.shortUsd,
      totalUsd: b.totalUsd,
      cumulativeLongUsd: b.cumulativeLongUsd,
      cumulativeShortUsd: b.cumulativeShortUsd,
      firstPrice: b.firstPrice,
      lastPrice: b.lastPrice,
      minPrice: b.minPrice,
      maxPrice: b.maxPrice,
      latestSnapshot: b.latestSnapshot,
    })),
  };
  fs.writeFileSync(outPath, JSON.stringify(exportPayload, null, 2));
  console.log(`\nExported: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
