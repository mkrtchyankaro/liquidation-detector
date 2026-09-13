/**
 * Sep 13 2026 (Karo), operator-requested. FINAL READ-ONLY research
 * pass, all 10 production symbols, both victim sides.
 *
 * Question: based on recent real history (never on the current
 * CandlePhysics W1-completion rule, which is exactly what's under
 * investigation), what post-W1 recovery is still "normal breathing",
 * and at what point does a later same-side push deserve to be a NEW
 * W2 rather than being absorbed into W1?
 *
 * Methodology (validated in prior passes, reused not reinvented):
 *   - "Meaningful W1/reference push" = a 5s-clustered same-side raw
 *     liquidation burst with eventCount>=2 AND
 *     maxSingleEvent>=P95(at that moment). Classified independently
 *     of the engine's own wave-merging logic -- avoids circularity.
 *   - P95: per-symbol, LONG+SHORT combined, 5000-event ring buffer,
 *     min 30 samples, pre-seeded with real events before the 72h
 *     window so it never starts cold.
 *   - Recovery: STRICT LIVE-CAUSAL running extreme, walked
 *     minute-by-minute, continuously updated, ATR/UNIT FROZEN at the
 *     reference W1's own start. Never uses the future final episode
 *     extreme to decide anything earlier.
 *   - Thresholds tested are DERIVED from each symbol+side's own
 *     observed recovery-percentile distribution (p10..p95) -- never
 *     an arbitrary fixed grid.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
];
const HOURS = 72;
const SAMPLE_CAPACITY = 5000;
const MIN_SAMPLES_FOR_PERCENTILES = 30;
const BURST_CLUSTER_GAP_MS = 5000;
const PCT_LIST = [10, 25, 50, 60, 70, 75, 80, 85, 90, 95];
const MIN_PAIRS_FOR_TABLE = 8;
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

function fmtUsd(n: number | null) {
  if (n === null || n === undefined) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtPct(n: number | null, d?: number) {
  return n === null || n === undefined ? "n/a" : n.toFixed(d ?? 1) + "%";
}
function fmtDur(ms: number | null) {
  if (ms === null) return "n/a";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(0) + "s";
  if (s < 3600) return (s / 60).toFixed(1) + "m";
  return (s / 3600).toFixed(2) + "h";
}
function sortNum(a: number[]) {
  return [...a]
    .filter((x) => x !== null && x !== undefined && !isNaN(x))
    .sort((x, y) => x - y);
}
function percentile(arr: (number | null)[], p: number): number | null {
  const s = sortNum(arr as number[]);
  if (!s.length) return null;
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
function median(a: (number | null)[]) {
  return percentile(a, 50);
}
function rawPercentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sortedArr[lo]
    : sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
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
function computeWilderAtrSeries(
  candlesAsc: { t: number; high: number; low: number; close: number }[],
  period: number,
) {
  const atrMap = new Map<number, number>();
  if (candlesAsc.length < period + 1) return atrMap;
  const trs: number[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      prev = candlesAsc[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
      ),
    );
  }
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  atrMap.set(candlesAsc[period].t, atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrMap.set(candlesAsc[i + 1].t, atr);
  }
  return atrMap;
}

interface Burst {
  start: number;
  end: number;
  totalUsd: number;
  maxEvent: number;
  count: number;
}
interface Push extends Burst {
  symbol: string;
  victim: "LONG" | "SHORT";
  p95AtStart: number;
}
interface Pair {
  symbol: string;
  victim: "LONG" | "SHORT";
  push1Start: number;
  push1End: number;
  push1TotalUsd: number;
  push1EventCount: number;
  push1MaxEvent: number;
  push1RunningExtreme: number;
  push1RunningExtremeTs: number;
  atrFrozen: number;
  push1DirectionalMoveAtr: number;
  push1Efficiency: number | null; // effort-vs-result for the reference push itself
  push2Start: number;
  push2TotalUsd: number;
  push2EventCount: number;
  push2MaxEvent: number;
  push2LiqRatio: number;
  maxRecoveryAtr: number;
  maxRecoveryPct: number;
  maxRecoveryTs: number;
  timeUntilNextPushMs: number;
  push2NewExtreme: boolean;
  incrementalExtensionAtr: number; // 0 if no new extreme
  incrementalExtensionPct: number;
  push2Efficiency: number | null; // incrementalExtensionAtr / (push2TotalUsd/1e6), null if push2TotalUsd is 0 (never happens)
  negativeDetectionDelay: boolean; // sanity
}

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
  const windowStart = now - HOURS * 3600 * 1000;

  const allPairs: Record<string, Record<"LONG" | "SHORT", Pair[]>> = {};
  SYMBOLS.forEach((s) => (allPairs[s] = { LONG: [], SHORT: [] }));

  let globalNegativeDelayCount = 0;
  let globalNegativeRecoveryCount = 0;

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const preSeed = await col
      .find({ symbol, timestamp: { $lt: windowStart } })
      .sort({ timestamp: -1 })
      .limit(SAMPLE_CAPACITY)
      .toArray();
    preSeed.reverse();
    const windowEvents = await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: now } })
      .sort({ timestamp: 1 })
      .toArray();
    if (windowEvents.length === 0) {
      console.log("  no events in window.\n");
      continue;
    }

    const klines = await fetchKlines(
      symbol,
      windowStart - 5 * 3600000,
      now + 60000,
    );
    const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
    if (candlesAsc.length < 241) {
      console.log("  insufficient candle history -- skipping.\n");
      continue;
    }
    function candleAt(ms: number) {
      return klines.get(Math.floor(ms / 60000) * 60000) || null;
    }
    const atrSeries = computeWilderAtrSeries(candlesAsc, 240);
    function atrAt(ms: number): number | null {
      let t = Math.floor(ms / 60000) * 60000;
      for (let i = 0; i < 300; i++) {
        if (atrSeries.has(t)) return atrSeries.get(t)!;
        t -= 60000;
      }
      return null;
    }

    function clusterBursts(evs: any[], gapMs: number): Burst[] {
      if (!evs.length) return [];
      const out: any[][] = [];
      let c = [evs[0]];
      for (let j = 1; j < evs.length; j++) {
        if (evs[j].timestamp - evs[j - 1].timestamp > gapMs) {
          out.push(c);
          c = [evs[j]];
        } else c.push(evs[j]);
      }
      out.push(c);
      return out.map((b) => ({
        start: b[0].timestamp,
        end: b[b.length - 1].timestamp,
        totalUsd: b.reduce((s: number, e: any) => s + e.quoteQty, 0),
        maxEvent: Math.max(...b.map((e: any) => e.quoteQty)),
        count: b.length,
      }));
    }

    const pushesBySide: Record<"LONG" | "SHORT", Push[]> = {
      LONG: [],
      SHORT: [],
    };
    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEvents = windowEvents.filter((e) => e.victim === victim);
      const bursts = clusterBursts(sideEvents, BURST_CLUSTER_GAP_MS);
      for (const b of bursts) {
        const ringUpToStart = [...preSeed, ...windowEvents]
          .filter((e) => e.timestamp < b.start)
          .slice(-SAMPLE_CAPACITY)
          .map((e) => e.quoteQty);
        if (ringUpToStart.length < MIN_SAMPLES_FOR_PERCENTILES) continue;
        const p95 = rawPercentile(
          [...ringUpToStart].sort((x, y) => x - y),
          95,
        );
        if (b.count < 2 || b.maxEvent < p95) continue;
        pushesBySide[victim].push({ symbol, victim, ...b, p95AtStart: p95 });
      }
    }
    console.log(
      "  meaningful pushes: LONG=" +
        pushesBySide.LONG.length +
        " SHORT=" +
        pushesBySide.SHORT.length,
    );

    for (const victim of ["LONG", "SHORT"] as const) {
      const pushes = pushesBySide[victim];
      for (let i = 0; i < pushes.length - 1; i++) {
        const p1 = pushes[i],
          p2 = pushes[i + 1];
        const atrFrozen = atrAt(p1.start); // FROZEN at reference W1 start, per causality rule
        if (atrFrozen === null || atrFrozen <= 0) continue;

        let runningExtreme: number | null = null,
          runningExtremeTs: number | null = null;
        let maxRecoveryAtr = -Infinity,
          maxRecoveryTs = p1.start;
        for (
          let t = Math.floor(p1.start / 60000) * 60000;
          t <= p2.start;
          t += 60000
        ) {
          const c = candleAt(t);
          if (!c) continue;
          const extremeCandidate = victim === "LONG" ? c.low : c.high;
          if (
            runningExtreme === null ||
            (victim === "LONG"
              ? extremeCandidate < runningExtreme
              : extremeCandidate > runningExtreme)
          ) {
            runningExtreme = extremeCandidate;
            runningExtremeTs = t;
            // CRITICAL FIX: a new, deeper extreme invalidates every
            // recovery value recorded so far -- they were measured
            // against a now-superseded reference point. Reset the
            // running max so it only ever reflects recovery FROM THE
            // CURRENT extreme going forward. This is the same
            // "recovery resets to zero on new extreme" rule already
            // established for this research; the earlier version of
            // this script applied it to the extreme itself but never
            // to the recovery-max tracker, which is exactly what the
            // negativeDetectionDelay sanity check caught.
            maxRecoveryAtr = -Infinity;
            maxRecoveryTs = t;
          }
          const recoveryUsd =
            victim === "LONG"
              ? c.close - runningExtreme
              : runningExtreme - c.close;
          const recoveryAtr = recoveryUsd / atrFrozen;
          if (recoveryAtr > maxRecoveryAtr) {
            maxRecoveryAtr = recoveryAtr;
            maxRecoveryTs = t;
          }
        }
        if (runningExtreme === null || runningExtremeTs === null) continue;

        // push1's own directional move + effort-vs-result efficiency (same formula family as the production engine's own: extensionUnits / (liqUsd/1e6))
        const push1AnchorPrice =
          candleAt(Math.max(p1.start - 60000, windowStart - 60000))?.open ??
          runningExtreme;
        const push1DirectionalMoveAtr =
          Math.abs(push1AnchorPrice - runningExtreme) / atrFrozen;
        const push1Efficiency =
          p1.totalUsd > 0
            ? push1DirectionalMoveAtr / (p1.totalUsd / 1e6)
            : null;

        // push2's own extreme + incremental extension beyond push1's running extreme
        let p2Extreme: number | null = null;
        for (
          let t = Math.floor((p2.start - 60000) / 60000) * 60000;
          t <= p2.end + 60000;
          t += 60000
        ) {
          const c = candleAt(t);
          if (!c) continue;
          const v = victim === "LONG" ? c.low : c.high;
          if (
            p2Extreme === null ||
            (victim === "LONG" ? v < p2Extreme : v > p2Extreme)
          )
            p2Extreme = v;
        }
        const push2NewExtreme =
          p2Extreme !== null
            ? victim === "LONG"
              ? p2Extreme < runningExtreme
              : p2Extreme > runningExtreme
            : false;
        const incrementalExtensionUsd =
          push2NewExtreme && p2Extreme !== null
            ? Math.abs(runningExtreme - p2Extreme)
            : 0;
        const incrementalExtensionAtr = incrementalExtensionUsd / atrFrozen;
        const incrementalExtensionPct =
          (incrementalExtensionUsd / runningExtreme) * 100;
        const push2Efficiency =
          p2.totalUsd > 0
            ? incrementalExtensionAtr / (p2.totalUsd / 1e6)
            : null;

        const maxRecoveryPrice =
          candleAt(maxRecoveryTs)?.close ?? runningExtreme;
        const maxRecoveryPct =
          victim === "LONG"
            ? ((maxRecoveryPrice - runningExtreme) / runningExtreme) * 100
            : ((runningExtreme - maxRecoveryPrice) / runningExtreme) * 100;

        const timeUntilNextPushMs = p2.start - p1.end;
        const negativeDetectionDelay =
          timeUntilNextPushMs < 0 || maxRecoveryTs < runningExtremeTs;
        if (negativeDetectionDelay) globalNegativeDelayCount++;
        if (maxRecoveryAtr < 0 && Number.isFinite(maxRecoveryAtr))
          globalNegativeRecoveryCount++; // recovery itself being negative (price never left the extreme direction) is VALID, not a bug -- only flag if used incorrectly downstream; tracked for visibility

        allPairs[symbol][victim].push({
          symbol,
          victim,
          push1Start: p1.start,
          push1End: p1.end,
          push1TotalUsd: p1.totalUsd,
          push1EventCount: p1.count,
          push1MaxEvent: p1.maxEvent,
          push1RunningExtreme: runningExtreme,
          push1RunningExtremeTs: runningExtremeTs,
          atrFrozen,
          push1DirectionalMoveAtr,
          push1Efficiency,
          push2Start: p2.start,
          push2TotalUsd: p2.totalUsd,
          push2EventCount: p2.count,
          push2MaxEvent: p2.maxEvent,
          push2LiqRatio: p1.totalUsd > 0 ? p2.totalUsd / p1.totalUsd : 0,
          maxRecoveryAtr,
          maxRecoveryPct,
          maxRecoveryTs,
          timeUntilNextPushMs,
          push2NewExtreme,
          incrementalExtensionAtr,
          incrementalExtensionPct,
          push2Efficiency,
          negativeDetectionDelay,
        });
      }
    }
    console.log(
      "  pairs: LONG=" +
        allPairs[symbol].LONG.length +
        " SHORT=" +
        allPairs[symbol].SHORT.length +
        "\n",
    );
  }

  // ═══ MANDATORY SANITY CHECKS ═══
  console.log("=".repeat(100));
  console.log("SANITY CHECKS");
  console.log("=".repeat(100));
  console.log(
    "negativeDetectionDelayCount (should be 0) = " + globalNegativeDelayCount,
  );
  if (globalNegativeDelayCount > 0)
    console.log(
      "*** CAUSALITY BUG DETECTED -- results below should not be trusted until this is fixed. ***",
    );
  console.log("");

  // ═══ Recovery distributions ═══
  console.log("=".repeat(100));
  console.log(
    "RECOVERY-ATR DISTRIBUTION, PER SYMBOL + SIDE (observed, not assumed)",
  );
  console.log("=".repeat(100));
  const recoveryDist: any = {};
  for (const symbol of SYMBOLS) {
    if (!allPairs[symbol]) continue;
    for (const victim of ["LONG", "SHORT"] as const) {
      const pairs = allPairs[symbol][victim];
      const key = symbol + "_" + victim;
      if (pairs.length === 0) {
        console.log(key + ": no pairs.");
        continue;
      }
      const vals = pairs.map((p) => p.maxRecoveryAtr);
      const dist = Object.fromEntries(
        PCT_LIST.map((p) => ["p" + p, percentile(vals, p)]),
      );
      recoveryDist[key] = { n: pairs.length, dist };
      console.log(
        key +
          " (n=" +
          pairs.length +
          "): " +
          Object.entries(dist)
            .map(
              ([k, v]) =>
                k + "=" + (v !== null ? (v as number).toFixed(3) : "n/a"),
            )
            .join(" "),
      );
    }
  }

  // ═══ Threshold table, using OBSERVED percentiles as the tested thresholds ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "THRESHOLD TABLE (thresholds = this symbol+side's OWN observed recovery percentiles p10..p95)",
  );
  console.log("=".repeat(100));
  const thresholdResults: any = {};
  for (const symbol of SYMBOLS) {
    if (!allPairs[symbol]) continue;
    for (const victim of ["LONG", "SHORT"] as const) {
      const pairs = allPairs[symbol][victim];
      const key = symbol + "_" + victim;
      if (pairs.length < MIN_PAIRS_FOR_TABLE) {
        console.log(
          "\n" +
            key +
            ": INSUFFICIENT_SAMPLE (n=" +
            pairs.length +
            " < " +
            MIN_PAIRS_FOR_TABLE +
            ")",
        );
        thresholdResults[key] = "INSUFFICIENT_SAMPLE";
        continue;
      }
      console.log("\n" + key + " (n=" + pairs.length + "):");
      thresholdResults[key] = {};
      for (const p of PCT_LIST) {
        const thr = recoveryDist[key].dist["p" + p];
        if (thr === null) continue;
        const reaching = pairs.filter((pr) => pr.maxRecoveryAtr >= thr);
        const probLaterPush = pairs.length
          ? (reaching.length / pairs.length) * 100
          : null; // every pair HAS a later push by construction; this is really "fraction that recovered to at least this level before that push arrived"
        const newExtCases = reaching.filter((pr) => pr.push2NewExtreme);
        const probNewExtreme = reaching.length
          ? (newExtCases.length / reaching.length) * 100
          : null;
        const liqRatios = reaching.map((pr) => pr.push2LiqRatio);
        const incExtensions = reaching.map((pr) => pr.incrementalExtensionAtr);
        console.log(
          "  p" +
            p +
            " (thr=" +
            thr.toFixed(3) +
            " ATR): n=" +
            reaching.length +
            " P(reached before push2)=" +
            fmtPct(probLaterPush) +
            " P(push2 new extreme | reached)=" +
            fmtPct(probNewExtreme) +
            " medLiqRatio=" +
            (median(liqRatios)?.toFixed(2) ?? "n/a") +
            " medIncExtAtr=" +
            (median(incExtensions)?.toFixed(3) ?? "n/a") +
            " p75IncExtAtr=" +
            (percentile(incExtensions, 75)?.toFixed(3) ?? "n/a") +
            " p90IncExtAtr=" +
            (percentile(incExtensions, 90)?.toFixed(3) ?? "n/a"),
        );
        thresholdResults[key]["p" + p] = {
          thresholdAtr: thr,
          n: reaching.length,
          probLaterPushReached: probLaterPush,
          probNewExtremeGivenReached: probNewExtreme,
          medianLiqRatio: median(liqRatios),
          medianIncExtAtr: median(incExtensions),
          p75IncExtAtr: percentile(incExtensions, 75),
          p90IncExtAtr: percentile(incExtensions, 90),
        };
      }
    }
  }

  // ═══ Hypothesis test: W2 effort vs incremental result (exhaustion vs continuation) ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "HYPOTHESIS TEST: does push2's own effort-vs-incremental-result distinguish exhaustion from continuation?",
  );
  console.log("=".repeat(100));
  const hypothesisResults: any = {};
  for (const symbol of SYMBOLS) {
    if (!allPairs[symbol]) continue;
    for (const victim of ["LONG", "SHORT"] as const) {
      const pairs = allPairs[symbol][victim].filter(
        (p) => p.push2Efficiency !== null,
      );
      const key = symbol + "_" + victim;
      if (pairs.length < MIN_PAIRS_FOR_TABLE) continue;
      const newExt = pairs.filter((p) => p.push2NewExtreme);
      const noNewExt = pairs.filter((p) => !p.push2NewExtreme);
      const w1EffMedian = median(pairs.map((p) => p.push1Efficiency));
      const push2EffMedianNewExt = median(newExt.map((p) => p.push2Efficiency));
      const push2EffMedianNoNewExt = median(
        noNewExt.map((p) => p.push2Efficiency),
      );
      console.log("\n" + key + ":");
      console.log(
        "  W1 own efficiency (median): " + (w1EffMedian?.toFixed(4) ?? "n/a"),
      );
      console.log(
        "  push2 WITH new extreme (n=" +
          newExt.length +
          "): median incremental efficiency = " +
          (push2EffMedianNewExt?.toFixed(4) ?? "n/a") +
          "  median liqRatio=" +
          (median(newExt.map((p) => p.push2LiqRatio))?.toFixed(2) ?? "n/a"),
      );
      console.log(
        "  push2 WITHOUT new extreme, i.e. exhaustion candidate (n=" +
          noNewExt.length +
          "): median incremental efficiency = " +
          (push2EffMedianNoNewExt?.toFixed(4) ?? "n/a") +
          " (0 by definition -- no incremental extension) median liqRatio=" +
          (median(noNewExt.map((p) => p.push2LiqRatio))?.toFixed(2) ?? "n/a"),
      );
      hypothesisResults[key] = {
        n: pairs.length,
        w1EffMedian,
        newExtCount: newExt.length,
        noNewExtCount: noNewExt.length,
        push2EffMedianNewExt,
        push2EffMedianNoNewExt,
        newExtLiqRatioMedian: median(newExt.map((p) => p.push2LiqRatio)),
        noNewExtLiqRatioMedian: median(noNewExt.map((p) => p.push2LiqRatio)),
      };
    }
  }
  console.log(
    "\nInterpretation: if 'noNewExt' cases show a HIGH median liqRatio (push2 spent comparable-or-more liquidation effort than W1) but ZERO incremental extension by definition, that supports the hypothesis -- substantial effort with no new progress IS the exhaustion signature. If 'noNewExt' cases mostly have LOW liqRatio (push2 was just a small residual blip, not a real second push), the exhaustion signal is really just 'no meaningful push2 arrived at all', not a genuine effort-vs-result distinction.",
  );

  // ═══ Global summary ═══
  console.log("\n" + "=".repeat(100));
  console.log("GLOBAL SUMMARY");
  console.log("=".repeat(100));
  const allPairsFlat: Pair[] = SYMBOLS.flatMap((s) =>
    allPairs[s] ? [...allPairs[s].LONG, ...allPairs[s].SHORT] : [],
  );
  console.log("Total pairs across all symbols/sides: " + allPairsFlat.length);
  console.log(
    "Global recoveryATR: median=" +
      (median(allPairsFlat.map((p) => p.maxRecoveryAtr))?.toFixed(3) ?? "n/a") +
      " p75=" +
      (percentile(
        allPairsFlat.map((p) => p.maxRecoveryAtr),
        75,
      )?.toFixed(3) ?? "n/a") +
      " p90=" +
      (percentile(
        allPairsFlat.map((p) => p.maxRecoveryAtr),
        90,
      )?.toFixed(3) ?? "n/a"),
  );

  // Cross-symbol dispersion check: how much do symbol-level medians vary?
  const symbolMedians = SYMBOLS.flatMap((s) =>
    (["LONG", "SHORT"] as const).map((v) =>
      allPairs[s] && allPairs[s][v].length >= MIN_PAIRS_FOR_TABLE
        ? median(allPairs[s][v].map((p) => p.maxRecoveryAtr))
        : null,
    ),
  ).filter((v) => v !== null) as number[];
  if (symbolMedians.length >= 2) {
    const globalMed = median(symbolMedians)!;
    const spread = Math.max(...symbolMedians) - Math.min(...symbolMedians);
    console.log(
      "Per-symbol/side median recoveryATR spread: min=" +
        Math.min(...symbolMedians).toFixed(3) +
        " max=" +
        Math.max(...symbolMedians).toFixed(3) +
        " range=" +
        spread.toFixed(3) +
        " (global median across sides=" +
        globalMed.toFixed(3) +
        ")",
    );
    console.log(
      spread > globalMed
        ? "Spread EXCEEDS the global median itself -- a single universal threshold is NOT well supported; per-symbol/per-side calibration looks materially better."
        : "Spread is modest relative to the global median -- a universal threshold MAY be defensible, but per-symbol calibration still captures real variation seen above.",
    );
  } else {
    console.log(
      "Insufficient symbols with enough samples to assess universal-vs-per-symbol dispersion confidently.",
    );
  }

  const outPath = path.join(
    OUTPUT_DIR,
    "final-w1-w2-all-symbols-" + Date.now() + ".json",
  );
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        recoveryDist,
        thresholdResults,
        hypothesisResults,
        sanity: { globalNegativeDelayCount },
        allPairs,
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
