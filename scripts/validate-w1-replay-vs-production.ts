/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY validation: does
 * the research replay (research-w1-completion-entry.ts) accurately
 * reproduce ACTUAL production behavior during the post-deployment
 * overlap window?
 *
 * CRITICAL CORRECTION vs the earlier research script: production's
 * live P95 (LiquidationStatsService.notionalPercentile()) is the 95th
 * percentile of a 5,000-EVENT RING BUFFER per symbol, combined across
 * BOTH victim sides (the `victim` parameter to that method is named
 * `_victim` and is completely ignored -- confirmed directly in
 * liquidation-stats.service.ts). It is NOT a 24h time-window and NOT
 * victim-specific, and is gated at a 30-sample minimum
 * (minSamplesForPercentiles). The earlier research script's P95
 * approximation (victim-specific, 24h trailing window) used a
 * DIFFERENT definition. THIS script fixes that, so the comparison
 * below is meaningful.
 *
 * IMPORTANT STRUCTURAL LIMIT (not a bug in this script): production
 * only logs [W1_P95_QUALIFICATION] at the moment of ENTRY. A W1 that
 * forms but never reaches ENTRY has NO per-field log record in
 * production -- only an aggregate `completedWaves` count inside
 * [CANDLE_PHYSICS_CANCEL]. So a full field-by-field MATCH/MISMATCH
 * table is only possible for W1s that led to an ENTRY. For W1s that
 * formed but didn't reach entry, this script can only compare
 * AGGREGATE counts (how many cancels had completedWaves>=1) between
 * production logs and the replay -- not per-W1 fields. This is
 * reported explicitly, not glossed over.
 *
 * Usage:
 *   1. On the production server, dump PM2 logs covering the exact
 *      deployment-to-now window to a file:
 *        pm2 logs liquidation-detector --lines 200000 --nostream > /tmp/prod-logs.txt
 *   2. Run this script with that file + the deployment timestamp:
 *        npx tsx scripts/validate-w1-replay-vs-production.ts /tmp/prod-logs.txt "2026-09-13T00:00:00Z"
 *
 * READ-ONLY. No production code changed. No Mongo writes. No PM2 restart.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import { CandlePhysicsEngine } from "../src/domain/cascade/candle-physics-engine";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "SUIUSDT",
  "AVAXUSDT",
];
const SAMPLE_CAPACITY = 5000; // confirmed: observability.config.ts
const MIN_SAMPLES_FOR_PERCENTILES = 30; // confirmed: observability.config.ts
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

const logPath = process.argv[2];
const deployIso = process.argv[3];
if (!logPath || !deployIso) {
  console.error(
    'Usage: npx tsx scripts/validate-w1-replay-vs-production.ts <pm2-log-file> "<deployment-ISO-timestamp>"',
  );
  process.exit(1);
}
const deployTs = Date.parse(deployIso);
if (isNaN(deployTs)) {
  console.error("Could not parse deployment timestamp: " + deployIso);
  process.exit(1);
}

function fmtTs(ms: number) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function fmtUsd(n: number | null) {
  if (n === null || n === undefined) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}

function httpsGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}
async function fetchKlines(symbol: string, startTime: number, endTime: number) {
  const byOpenTime = new Map<
    number,
    { t: number; open: number; high: number; low: number; close: number }
  >();
  let cursor = startTime;
  while (cursor <= endTime) {
    const chunkEnd = Math.min(cursor + 1499 * 60000, endTime);
    const url =
      "https://fapi.binance.com/fapi/v1/klines?symbol=" +
      symbol +
      "&interval=1m&startTime=" +
      cursor +
      "&endTime=" +
      chunkEnd +
      "&limit=1500";
    const raw = await httpsGetJson(url);
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw)
      byOpenTime.set(k[0], {
        t: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
      });
    cursor = raw[raw.length - 1][0] + 60000;
  }
  return byOpenTime;
}
function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sortedArr[lo]
    : sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

interface ProdDiscard {
  symbol: string;
  victim: string;
  candidateStartTs: number;
  candidateEndTs: number;
  eventCount: number;
  totalLiqUsd: number;
  maxIndividualEventUsd: number;
  p95AtCheck: number | null;
  result: string;
}
interface ProdCancel {
  symbol: string;
  victim: string;
  reason: string;
  episodeStartTs: number;
  cancelTs: number;
  completedWaves: number;
}
interface ProdQualification {
  symbol: string;
  victim: string;
  p95AtW1Qualification: number | null;
  maxIndividualEventUsdAtW1: number | null;
  w1QualificationTs: number | null;
  episodeTotalLiqUsd: number;
  waveCount: number;
  eventCount: number;
  rawLineTime: number;
}

console.log("Reading PM2 log file: " + logPath);
const rawLog = fs.readFileSync(logPath, "utf8");
const lines = rawLog.split("\n");

const prodDiscards: ProdDiscard[] = [];
const prodCancels: ProdCancel[] = [];
const prodQualifications: ProdQualification[] = [];

for (const line of lines) {
  const jsonStart = line.indexOf("{");
  if (jsonStart === -1) continue;
  let parsed: any;
  try {
    parsed = JSON.parse(line.slice(jsonStart));
  } catch {
    continue;
  }
  if (!parsed || typeof parsed !== "object") continue;
  const t = typeof parsed.time === "string" ? Date.parse(parsed.time) : null;
  if (t === null || t < deployTs) continue;

  if (parsed.msg === "[PRE_W1_DISCARD]") {
    prodDiscards.push({
      symbol: parsed.symbol,
      victim: parsed.victim,
      candidateStartTs: parsed.candidateStartTs,
      candidateEndTs: parsed.candidateEndTs,
      eventCount: parsed.eventCount,
      totalLiqUsd: parsed.totalLiqUsd,
      maxIndividualEventUsd: parsed.maxIndividualEventUsd,
      p95AtCheck: parsed.p95AtCheck,
      result: parsed.result,
    });
  } else if (
    typeof parsed.msg === "string" &&
    parsed.msg.startsWith("[CANDLE_PHYSICS_CANCEL]")
  ) {
    const m = parsed.msg.match(
      /\[CANDLE_PHYSICS_CANCEL\] (\S+) (\S+) reason=(\S+) episodeStartTs=(\d+) cancelTs=(\d+) completedWaves=(\d+)/,
    );
    if (m)
      prodCancels.push({
        symbol: m[1],
        victim: m[2],
        reason: m[3],
        episodeStartTs: Number(m[4]),
        cancelTs: Number(m[5]),
        completedWaves: Number(m[6]),
      });
  } else if (parsed.msg === "[W1_P95_QUALIFICATION]") {
    prodQualifications.push({
      symbol: parsed.symbol,
      victim: parsed.victim,
      p95AtW1Qualification: parsed.p95AtW1Qualification,
      maxIndividualEventUsdAtW1: parsed.maxIndividualEventUsdAtW1,
      w1QualificationTs: parsed.w1QualificationTs,
      episodeTotalLiqUsd: parsed.episodeTotalLiqUsd,
      waveCount: parsed.waveCount,
      eventCount: parsed.eventCount,
      rawLineTime: t,
    });
  }
}

console.log("Parsed from production logs (since " + fmtTs(deployTs) + "):");
console.log(
  "  PRE_W1_DISCARD lines: " +
    prodDiscards.length +
    " (single=" +
    prodDiscards.filter((d) => d.result === "DISCARDED_SINGLE_EVENT").length +
    ", noP95=" +
    prodDiscards.filter((d) => d.result === "DISCARDED_NO_P95").length +
    ")",
);
console.log(
  "  CANDLE_PHYSICS_CANCEL lines: " +
    prodCancels.length +
    " (completedWaves=0: " +
    prodCancels.filter((c) => c.completedWaves === 0).length +
    ", =1: " +
    prodCancels.filter((c) => c.completedWaves === 1).length +
    ", >=2: " +
    prodCancels.filter((c) => c.completedWaves >= 2).length +
    ")",
);
console.log(
  "  W1_P95_QUALIFICATION (= ENTRY) lines: " + prodQualifications.length,
);

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  const col = db.collection("liq_raw_events");

  const now = Date.now();
  console.log(
    "\nReplaying " +
      SYMBOLS.length +
      " symbols for the SAME window (" +
      fmtTs(deployTs) +
      " -> " +
      fmtTs(now) +
      "), using the CORRECTED P95 definition (5000-event combined ring, per symbol)...\n",
  );

  const replayDiscards: ProdDiscard[] = [];
  const replayCancels: ProdCancel[] = [];
  const replayQualifications: ProdQualification[] = [];
  const p95Comparisons: {
    symbol: string;
    victim: string;
    ts: number;
    prodP95: number;
    replayP95: number;
    diffPct: number;
  }[] = [];

  for (const symbol of SYMBOLS) {
    const allEvents = await col
      .find({ symbol, timestamp: { $lte: now } })
      .sort({ timestamp: -1 })
      .limit(SAMPLE_CAPACITY * 4)
      .toArray();
    allEvents.reverse();
    if (allEvents.length === 0) continue;

    const klines = await fetchKlines(
      symbol,
      deployTs - 5 * 3600000 - 20 * 60000,
      now + 60000,
    );
    const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
    if (candlesAsc.length < 241) {
      console.log(symbol + ": insufficient candle history -- skipping.");
      continue;
    }
    function simpleAtr240(uptoMs: number): number | null {
      const before = candlesAsc.filter((c) => c.t < uptoMs);
      if (before.length < 241) return null;
      const w = before.slice(-241);
      let sum = 0;
      for (let i = 1; i < w.length; i++)
        sum += Math.max(
          w[i].high - w[i].low,
          Math.abs(w[i].high - w[i - 1].close),
          Math.abs(w[i].low - w[i - 1].close),
        );
      return sum / (w.length - 1);
    }

    let ringIdx = 0;
    const ring: number[] = [];
    function ingestIntoRing(notional: number) {
      if (ring.length < SAMPLE_CAPACITY) ring.push(notional);
      else {
        ring[ringIdx] = notional;
        ringIdx = (ringIdx + 1) % SAMPLE_CAPACITY;
      }
    }
    function currentP95(): number | null {
      if (ring.length < MIN_SAMPLES_FOR_PERCENTILES) return 0;
      return percentile(
        [...ring].sort((a, b) => a - b),
        95,
      );
    }

    const engineLong = new CandlePhysicsEngine();
    const engineShort = new CandlePhysicsEngine();
    const relevantCandles = candlesAsc.filter(
      (c) => c.t >= deployTs - 20 * 60000 && c.t <= now,
    );
    let eventIdx = 0;

    for (const candle of relevantCandles) {
      while (
        eventIdx < allEvents.length &&
        allEvents[eventIdx].timestamp < candle.t
      ) {
        const e = allEvents[eventIdx];
        ingestIntoRing(e.quoteQty);
        const unit = simpleAtr240(e.timestamp);
        const engine = e.victim === "LONG" ? engineLong : engineShort;
        if (unit && unit > 0) {
          engine.onLiquidation(
            symbol,
            e.victim,
            {
              symbol,
              side: e.victim === "LONG" ? "SELL" : "BUY",
              price: e.price,
              quantity: e.quoteQty / e.price,
              quoteQty: e.quoteQty,
              timestamp: e.timestamp,
            },
            unit,
            e.price,
            e.timestamp,
          );
        }
        eventIdx++;
      }
      const p95 = currentP95();
      for (const victim of ["LONG", "SHORT"] as const) {
        const engine = victim === "LONG" ? engineLong : engineShort;
        const result = engine.onClosedCandle(
          symbol,
          victim,
          candle.t,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          p95 === 0 ? null : p95,
        );
        if (candle.t < deployTs) continue;
        if (result?.kind === "PRE_W1_DISCARD")
          replayDiscards.push({
            symbol: result.symbol,
            victim: result.victim,
            candidateStartTs: result.candidateStartTs,
            candidateEndTs: result.candidateEndTs,
            eventCount: result.eventCount,
            totalLiqUsd: result.totalLiqUsd,
            maxIndividualEventUsd: result.maxIndividualEventUsd,
            p95AtCheck: result.p95AtCheck,
            result: result.reason,
          });
        else if (result?.kind === "CANCEL")
          replayCancels.push({
            symbol: result.symbol,
            victim: result.victim,
            reason: result.reason,
            episodeStartTs: result.episodeStartTs,
            cancelTs: result.cancelTs,
            completedWaves: result.allWaves.length,
          });
        else if (result?.kind === "ENTRY")
          replayQualifications.push({
            symbol: result.symbol,
            victim: result.victim,
            p95AtW1Qualification: result.p95AtW1Qualification,
            maxIndividualEventUsdAtW1: result.maxIndividualEventUsdAtW1,
            w1QualificationTs: result.w1QualificationTs,
            episodeTotalLiqUsd: result.allWaves.reduce(
              (s, w) => s + w.totalLiqUsd,
              0,
            ),
            waveCount: result.allWaves.length,
            eventCount: result.allWaves.reduce((s, w) => s + w.totalEvents, 0),
            rawLineTime: candle.t,
          });
      }
    }

    for (const d of [
      ...prodDiscards,
      ...prodQualifications.map((q) => ({
        symbol: q.symbol,
        victim: q.victim,
        candidateEndTs: q.w1QualificationTs as number,
        p95AtCheck: q.p95AtW1Qualification,
      })),
    ]) {
      if (
        d.symbol !== symbol ||
        d.p95AtCheck === null ||
        d.candidateEndTs === undefined
      )
        continue;
      const beforeTs = allEvents
        .filter((e) => e.timestamp < d.candidateEndTs)
        .slice(-SAMPLE_CAPACITY)
        .map((e) => e.quoteQty);
      if (beforeTs.length < MIN_SAMPLES_FOR_PERCENTILES) continue;
      const replayP95AtTs = percentile(
        [...beforeTs].sort((a, b) => a - b),
        95,
      );
      const diffPct =
        d.p95AtCheck > 0
          ? ((replayP95AtTs - d.p95AtCheck) / d.p95AtCheck) * 100
          : 0;
      p95Comparisons.push({
        symbol,
        victim: d.victim,
        ts: d.candidateEndTs,
        prodP95: d.p95AtCheck,
        replayP95: replayP95AtTs,
        diffPct,
      });
    }

    console.log(
      symbol +
        ": replay discards=" +
        replayDiscards.filter((r) => r.symbol === symbol).length +
        " cancels=" +
        replayCancels.filter((r) => r.symbol === symbol).length +
        " entries=" +
        replayQualifications.filter((r) => r.symbol === symbol).length,
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log(
    "AGGREGATE COUNT COMPARISON (production log vs corrected replay, same window)",
  );
  console.log("=".repeat(100));
  function cmpRow(label: string, prodN: number, replayN: number) {
    const match = prodN === replayN ? "MATCH" : "MISMATCH";
    console.log(
      label.padEnd(45) +
        " prod=" +
        String(prodN).padEnd(6) +
        " replay=" +
        String(replayN).padEnd(6) +
        " " +
        match,
    );
  }
  cmpRow(
    "PRE_W1_DISCARD (single-event)",
    prodDiscards.filter((d) => d.result === "DISCARDED_SINGLE_EVENT").length,
    replayDiscards.filter((d) => d.result === "DISCARDED_SINGLE_EVENT").length,
  );
  cmpRow(
    "PRE_W1_DISCARD (no-P95)",
    prodDiscards.filter((d) => d.result === "DISCARDED_NO_P95").length,
    replayDiscards.filter((d) => d.result === "DISCARDED_NO_P95").length,
  );
  cmpRow("CANCEL total", prodCancels.length, replayCancels.length);
  cmpRow(
    "CANCEL with completedWaves=0",
    prodCancels.filter((c) => c.completedWaves === 0).length,
    replayCancels.filter((c) => c.completedWaves === 0).length,
  );
  cmpRow(
    "CANCEL with completedWaves=1 (W1-formed-no-entry)",
    prodCancels.filter((c) => c.completedWaves === 1).length,
    replayCancels.filter((c) => c.completedWaves === 1).length,
  );
  cmpRow(
    "CANCEL with completedWaves>=2",
    prodCancels.filter((c) => c.completedWaves >= 2).length,
    replayCancels.filter((c) => c.completedWaves >= 2).length,
  );
  cmpRow("ENTRY total", prodQualifications.length, replayQualifications.length);

  console.log("\n" + "=".repeat(100));
  console.log(
    "FIELD-BY-FIELD MATCH TABLE -- ENTRY-producing W1s only (the only ones with a full production log record)",
  );
  console.log("=".repeat(100));
  for (const pq of prodQualifications) {
    const match = replayQualifications.find(
      (rq) =>
        rq.symbol === pq.symbol &&
        rq.victim === pq.victim &&
        Math.abs((rq.w1QualificationTs ?? 0) - (pq.w1QualificationTs ?? 0)) <
          120000,
    );
    console.log(
      "\n" +
        pq.symbol +
        " " +
        pq.victim +
        " @ " +
        fmtTs(pq.w1QualificationTs ?? 0) +
        ":",
    );
    if (!match) {
      console.log("  NO REPLAY MATCH FOUND within +/-2min -- MISMATCH");
      continue;
    }
    function field(name: string, p: any, r: any) {
      console.log(
        "  " +
          name.padEnd(28) +
          " prod=" +
          p +
          "  replay=" +
          r +
          "  " +
          (p === r ? "MATCH" : "MISMATCH"),
      );
    }
    field(
      "p95AtW1Qualification",
      fmtUsd(pq.p95AtW1Qualification),
      fmtUsd(match.p95AtW1Qualification),
    );
    field(
      "maxIndividualEventUsdAtW1",
      fmtUsd(pq.maxIndividualEventUsdAtW1),
      fmtUsd(match.maxIndividualEventUsdAtW1),
    );
    field("waveCount", pq.waveCount, match.waveCount);
    field("eventCount", pq.eventCount, match.eventCount);
  }

  console.log("\n" + "=".repeat(100));
  console.log(
    "P95 DEFINITION MATCH QUANTIFICATION (corrected replay vs production, at every discard/qualification timestamp)",
  );
  console.log("=".repeat(100));
  console.log("n=" + p95Comparisons.length + " direct comparisons.");
  const diffs = p95Comparisons.map((c) => Math.abs(c.diffPct));
  const exactMatches = p95Comparisons.filter(
    (c) => Math.abs(c.diffPct) < 0.01,
  ).length;
  console.log(
    "exact matches (< 0.01% diff): " +
      exactMatches +
      "/" +
      p95Comparisons.length,
  );
  if (diffs.length) {
    diffs.sort((a, b) => a - b);
    console.log(
      "abs(diffPct) distribution: median=" +
        diffs[Math.floor(diffs.length / 2)].toFixed(4) +
        "%  max=" +
        diffs[diffs.length - 1].toFixed(4) +
        "%",
    );
  }
  const mismatches = p95Comparisons.filter((c) => Math.abs(c.diffPct) >= 0.01);
  if (mismatches.length > 0) {
    console.log("\nNon-exact examples (first 10):");
    mismatches
      .slice(0, 10)
      .forEach((c) =>
        console.log(
          "  " +
            c.symbol +
            " " +
            c.victim +
            " @ " +
            fmtTs(c.ts) +
            ": prod=" +
            fmtUsd(c.prodP95) +
            " replay=" +
            fmtUsd(c.replayP95) +
            " diff=" +
            c.diffPct.toFixed(3) +
            "%",
        ),
      );
  }

  console.log("\n" + "=".repeat(100));
  console.log("FINAL ANSWER");
  console.log("=".repeat(100));
  const countMismatches = [
    prodDiscards.filter((d) => d.result === "DISCARDED_SINGLE_EVENT").length !==
      replayDiscards.filter((d) => d.result === "DISCARDED_SINGLE_EVENT")
        .length,
    prodDiscards.filter((d) => d.result === "DISCARDED_NO_P95").length !==
      replayDiscards.filter((d) => d.result === "DISCARDED_NO_P95").length,
    prodCancels.length !== replayCancels.length,
    prodQualifications.length !== replayQualifications.length,
  ].filter(Boolean).length;
  const p95MismatchPct = p95Comparisons.length
    ? (mismatches.length / p95Comparisons.length) * 100
    : 0;

  if (countMismatches === 0 && p95MismatchPct < 5) {
    console.log(
      "(A) Replay matches production closely enough -- the 72h research is trustworthy for strategy decisions.",
    );
    console.log(
      "    All aggregate counts matched, and P95 values matched within tolerance in " +
        (100 - p95MismatchPct).toFixed(1) +
        "% of direct comparisons.",
    );
  } else {
    console.log(
      "(B) Replay differs materially -- see the mismatch rows above for exactly which counts/fields disagree, and the P95 comparison table for exactly how large the P95-definition gap is, BEFORE using the 72h results for a strategy decision.",
    );
    console.log(
      "    countMismatches=" +
        countMismatches +
        "  P95 mismatch rate=" +
        p95MismatchPct.toFixed(1) +
        "%",
    );
  }

  const outPath = path.join(
    OUTPUT_DIR,
    "w1-validation-" + Date.now() + ".json",
  );
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        prodDiscards,
        prodCancels,
        prodQualifications,
        replayDiscards,
        replayCancels,
        replayQualifications,
        p95Comparisons,
      },
      null,
      2,
    ),
  );
  console.log("\nFull data: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
