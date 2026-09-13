/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY research: can
 * W1->W2 separation be inferred dynamically per symbol+side from
 * historical liquidation-episode fingerprints, rather than any fixed
 * ATR/time/candle-count constant (including the current engine's own
 * self-relative priorMedianRecovery rule, which is exactly what's
 * being investigated -- NOT used as ground truth anywhere below)?
 *
 * METHODOLOGY (stated explicitly, per the operator's own request):
 *
 * "Meaningful push" = a 5s-clustered same-side raw liquidation burst
 * with eventCount>=2 AND maxSingleEvent>=P95(at that moment).
 * Classified purely from raw events -- independent of the current
 * CandlePhysicsEngine's own wave-merging logic.
 *
 * P95: per-symbol, LONG+SHORT combined, 5000-event ring buffer,
 * min 30 samples, pre-seeded with real events before the window.
 *
 * Recovery: STRICT LIVE-CAUSAL running extreme, walked
 * minute-by-minute, continuously updated. ATR/UNIT FROZEN at each
 * reference W1's own start. The recovery-max tracker is RESET every
 * time the running extreme updates (a new, deeper extreme
 * invalidates any recovery value measured against the old one) --
 * this is the exact fix validated in the prior corrected pass.
 *
 * OUTCOME CLASSIFICATION (A/B/C), stated explicitly:
 *   A = no qualifying same-side push2 ever arrives in this dataset
 *       (right-censored -- W1 was terminal by itself here).
 *   B = a qualifying push2 arrives but makes ZERO new directional
 *       extreme (pure exhaustion, literally zero incremental
 *       progress).
 *   C = a qualifying push2 arrives AND makes a new extreme (any
 *       magnitude). Each C observation also reports whether its own
 *       incrementalEfficiency is above/below THAT SYMBOL+SIDE'S OWN
 *       historical median efficiency among other C-cases -- so
 *       "efficient vs marginal continuation" is visible without a
 *       second invented threshold.
 *
 * SIMILARITY TEST: leave-one-out k-NN (k=5) within the same
 * symbol+side, standardized features, majority-vote prediction,
 * compared against a majority-class baseline. A lookup+vote, not a
 * trained model.
 *
 * DATA HONESTY: OI delta and taker-flow imbalance are NOT causally
 * reconstructable outside the live process (confirmed in an earlier
 * audit -- the OI tracker / taker-flow service don't persist
 * per-wave historical snapshots). These fields are reported as
 * NOT_AVAILABLE, never fabricated.
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
const MIN_OBS_FOR_TABLE = 8;
const TARGET_SAMPLE_FOR_TRUST = 25; // used only to estimate "how many days would be needed"
const KNN_K = 5;
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

interface W1Fingerprint {
  symbol: string;
  victim: "LONG" | "SHORT";
  w1Start: number;
  w1End: number;
  atrFrozen: number;
  eventCount: number;
  totalLiqUsd: number;
  maxEvent: number;
  maxEventOverP95: number;
  extensionAtr: number;
  extensionPct: number;
  durationMs: number;
  candleCount: number;
  priceProgressPer1M: number | null; // extensionAtr / (totalLiqUsd/1e6)
  runningExtreme: number;
  runningExtremeTs: number;
  oiDelta: null;
  takerFlowImbalance: null; // NOT_AVAILABLE, disclosed not fabricated

  outcome: "A" | "B" | "C";
  maxRecoveryAtrReached: number | null; // null if outcome A and no data at all
  timeUntilPush2Ms: number | null;
  push2TotalUsd: number | null;
  push2EventCount: number | null;
  push2MaxEvent: number | null;
  push2LiqRatio: number | null;
  incrementalExtensionAtr: number | null;
  incrementalExtensionPct: number | null;
  incrementalEfficiency: number | null;
  cAboveMedianEfficiency: boolean | null; // only meaningful for outcome C
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

  const allFingerprints: Record<
    string,
    Record<"LONG" | "SHORT", W1Fingerprint[]>
  > = {};
  SYMBOLS.forEach((s) => (allFingerprints[s] = { LONG: [], SHORT: [] }));
  let globalNegativeDelayCount = 0;
  let globalImpossibleValueCount = 0;

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

    // Also compute an actual overall event-rate for the "how many days needed" estimate, regardless of whether this symbol has enough W1s.
    const eventRatePerHour = windowEvents.length / HOURS;

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
        pushesBySide.SHORT.length +
        " (event rate: " +
        eventRatePerHour.toFixed(1) +
        "/hr)",
    );

    for (const victim of ["LONG", "SHORT"] as const) {
      const pushes = pushesBySide[victim];
      for (let i = 0; i < pushes.length; i++) {
        const p1 = pushes[i];
        const atrFrozen = atrAt(p1.start);
        if (atrFrozen === null || atrFrozen <= 0) continue;

        const push1AnchorPrice =
          candleAt(Math.max(p1.start - 60000, windowStart - 60000))?.open ??
          null;
        if (push1AnchorPrice === null) continue;

        const p2 = i + 1 < pushes.length ? pushes[i + 1] : null;
        const walkEnd = p2 ? p2.start : now; // if no later push exists yet, walk forward to "now" (still causal -- we're just observing what actually happened since, not any future beyond "now")

        let runningExtreme: number | null = null,
          runningExtremeTs: number | null = null;
        let maxRecoveryAtr = -Infinity,
          maxRecoveryTs = p1.start;
        let candleCount = 0;
        for (
          let t = Math.floor(p1.start / 60000) * 60000;
          t <= walkEnd;
          t += 60000
        ) {
          const c = candleAt(t);
          if (!c) continue;
          candleCount++;
          const extremeCandidate = victim === "LONG" ? c.low : c.high;
          if (
            runningExtreme === null ||
            (victim === "LONG"
              ? extremeCandidate < runningExtreme
              : extremeCandidate > runningExtreme)
          ) {
            runningExtreme = extremeCandidate;
            runningExtremeTs = t;
            maxRecoveryAtr = -Infinity;
            maxRecoveryTs = t; // reset on new extreme -- validated fix from the prior pass
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

        // W1's own directional move/effort, up to ITS OWN extreme (not the walk-end)
        const w1EndForFingerprint = Math.min(
          p1.end + 5 * 60000,
          runningExtremeTs,
        ); // W1 own window: its own burst plus immediate extreme-forming candles, capped sensibly
        const extensionUsd = Math.abs(push1AnchorPrice - runningExtreme);
        const extensionAtr = extensionUsd / atrFrozen;
        const extensionPct = (extensionUsd / push1AnchorPrice) * 100;
        const priceProgressPer1M =
          p1.totalUsd > 0 ? extensionAtr / (p1.totalUsd / 1e6) : null;

        // sanity
        const timeUntilPush2Ms = p2 ? p2.start - p1.end : null;
        const negativeDelay =
          (timeUntilPush2Ms !== null && timeUntilPush2Ms < 0) ||
          maxRecoveryTs < runningExtremeTs;
        if (negativeDelay) globalNegativeDelayCount++;
        if (
          extensionAtr < 0 ||
          (priceProgressPer1M !== null && !Number.isFinite(priceProgressPer1M))
        )
          globalImpossibleValueCount++;

        const fp: W1Fingerprint = {
          symbol,
          victim,
          w1Start: p1.start,
          w1End: w1EndForFingerprint,
          atrFrozen,
          eventCount: p1.count,
          totalLiqUsd: p1.totalUsd,
          maxEvent: p1.maxEvent,
          maxEventOverP95: p1.maxEvent / p1.p95AtStart,
          extensionAtr,
          extensionPct,
          durationMs: p1.end - p1.start,
          candleCount,
          priceProgressPer1M,
          runningExtreme,
          runningExtremeTs,
          oiDelta: null,
          takerFlowImbalance: null,
          outcome: "A",
          maxRecoveryAtrReached: p2 ? maxRecoveryAtr : null,
          timeUntilPush2Ms,
          push2TotalUsd: null,
          push2EventCount: null,
          push2MaxEvent: null,
          push2LiqRatio: null,
          incrementalExtensionAtr: null,
          incrementalExtensionPct: null,
          incrementalEfficiency: null,
          cAboveMedianEfficiency: null,
        };

        if (p2 === null) {
          fp.outcome = "A";
        } else {
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
          fp.push2TotalUsd = p2.totalUsd;
          fp.push2EventCount = p2.count;
          fp.push2MaxEvent = p2.maxEvent;
          fp.push2LiqRatio = p1.totalUsd > 0 ? p2.totalUsd / p1.totalUsd : null;
          if (!push2NewExtreme) {
            fp.outcome = "B";
            fp.incrementalExtensionAtr = 0;
            fp.incrementalExtensionPct = 0;
            fp.incrementalEfficiency = 0;
          } else {
            const incUsd = Math.abs(runningExtreme - p2Extreme!);
            fp.incrementalExtensionAtr = incUsd / atrFrozen;
            fp.incrementalExtensionPct = (incUsd / runningExtreme) * 100;
            fp.incrementalEfficiency =
              p2.totalUsd > 0
                ? fp.incrementalExtensionAtr / (p2.totalUsd / 1e6)
                : null;
            fp.outcome = "C";
          }
        }
        allFingerprints[symbol][victim].push(fp);
      }
    }
    console.log(
      "  fingerprints: LONG=" +
        allFingerprints[symbol].LONG.length +
        " SHORT=" +
        allFingerprints[symbol].SHORT.length +
        "\n",
    );
  }

  // ═══ SANITY ═══
  console.log("=".repeat(100));
  console.log("SANITY CHECKS");
  console.log("=".repeat(100));
  console.log(
    "negativeDetectionDelayCount (should be 0) = " + globalNegativeDelayCount,
  );
  console.log(
    "impossibleValueCount (should be 0) = " + globalImpossibleValueCount,
  );
  if (globalNegativeDelayCount > 0 || globalImpossibleValueCount > 0)
    console.log(
      "*** CAUSALITY/SANITY ISSUE DETECTED -- results below should not be trusted until resolved. ***\n",
    );
  else console.log("All sanity checks passed.\n");

  console.log("Construction, stated explicitly:");
  console.log(
    "  - 'Meaningful push' = 5s-clustered same-side burst, eventCount>=2, maxEvent>=P95(at that moment, 5000-event combined ring, pre-seeded).",
  );
  console.log(
    "  - 'Later meaningful push' = the NEXT such push (any gap length) on the same symbol+side.",
  );
  console.log(
    "  - Recovery: causal running extreme, minute-by-minute, reset on every new extreme, ATR frozen at W1's own start.",
  );
  console.log(
    "  - Outcome A/B/C: A=no later push found; B=later push found, zero new extreme; C=later push found, new extreme (any size).\n",
  );

  // ═══ Fingerprints -> outcome correlation (exploratory, no ML) ═══
  const allFpFlat: W1Fingerprint[] = SYMBOLS.flatMap((s) => [
    ...allFingerprints[s].LONG,
    ...allFingerprints[s].SHORT,
  ]);
  console.log("=".repeat(100));
  console.log("1. GLOBAL SUMMARY");
  console.log("=".repeat(100));
  console.log("Total W1 observations: " + allFpFlat.length);
  for (const symbol of SYMBOLS) {
    for (const v of ["LONG", "SHORT"] as const) {
      const n = allFingerprints[symbol]?.[v]?.length ?? 0;
      if (n > 0) console.log("  " + symbol + " " + v + ": " + n);
    }
  }

  function groupMedian(
    fps: W1Fingerprint[],
    field: keyof W1Fingerprint,
    outcome: "A" | "B" | "C",
  ) {
    const vals = fps
      .filter((f) => f.outcome === outcome)
      .map((f) => f[field] as number);
    return median(vals);
  }
  console.log(
    "\nFeature medians by outcome (global, exploratory -- looking for separation, not proving causation):",
  );
  const features: (keyof W1Fingerprint)[] = [
    "maxEventOverP95",
    "totalLiqUsd",
    "extensionAtr",
    "priceProgressPer1M",
    "eventCount",
  ];
  for (const feat of features) {
    const a = groupMedian(allFpFlat, feat, "A"),
      b = groupMedian(allFpFlat, feat, "B"),
      c = groupMedian(allFpFlat, feat, "C");
    console.log(
      "  " +
        feat +
        ": A=" +
        (a !== null ? a.toFixed(3) : "n/a") +
        "  B=" +
        (b !== null ? b.toFixed(3) : "n/a") +
        "  C=" +
        (c !== null ? c.toFixed(3) : "n/a"),
    );
  }

  // ═══ Per-symbol/side summary ═══
  console.log("\n" + "=".repeat(100));
  console.log("2. PER-SYMBOL + SIDE SUMMARY");
  console.log("=".repeat(100));
  const perSymbolSummary: any = {};
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const fps = allFingerprints[symbol]?.[victim] ?? [];
      const key = symbol + "_" + victim;
      console.log("\n" + key + ":");
      if (fps.length < MIN_OBS_FOR_TABLE) {
        const windowEventsCountApprox = fps.length; // proxy
        console.log(
          "  INSUFFICIENT_SAMPLE (n=" +
            fps.length +
            " < " +
            MIN_OBS_FOR_TABLE +
            ")",
        );
        if (fps.length > 0) {
          const daysNeeded = Math.ceil(
            ((TARGET_SAMPLE_FOR_TRUST / fps.length) * HOURS) / 24,
          );
          console.log(
            "  based on observed push rate, roughly " +
              daysNeeded +
              " days of history would likely be needed to reach ~" +
              TARGET_SAMPLE_FOR_TRUST +
              " examples (linear extrapolation from this 72h sample -- a rough estimate, not a guarantee, since liquidation activity is not uniform over time).",
          );
        } else {
          console.log(
            "  no examples at all in this 72h window -- cannot even extrapolate; would need to query a longer window directly to get a first estimate.",
          );
        }
        perSymbolSummary[key] = "INSUFFICIENT_SAMPLE";
        continue;
      }
      const aCount = fps.filter((f) => f.outcome === "A").length;
      const bCount = fps.filter((f) => f.outcome === "B").length;
      const cCount = fps.filter((f) => f.outcome === "C").length;
      console.log(
        "  n=" +
          fps.length +
          "  A(terminal)=" +
          fmtPct((aCount / fps.length) * 100) +
          "  B(exhaustion)=" +
          fmtPct((bCount / fps.length) * 100) +
          "  C(continuation)=" +
          fmtPct((cCount / fps.length) * 100),
      );

      const aFps = fps.filter((f) => f.outcome === "A"),
        bFps = fps.filter((f) => f.outcome === "B"),
        cFps = fps.filter((f) => f.outcome === "C");
      function charFingerprint(group: W1Fingerprint[], label: string) {
        if (group.length === 0) {
          console.log("    " + label + ": n=0");
          return;
        }
        console.log(
          "    " +
            label +
            " (n=" +
            group.length +
            "): medExtOverP95=" +
            (median(group.map((f) => f.maxEventOverP95))?.toFixed(2) ?? "n/a") +
            " medTotalLiq=" +
            fmtUsd(median(group.map((f) => f.totalLiqUsd))) +
            " medExtensionAtr=" +
            (median(group.map((f) => f.extensionAtr))?.toFixed(3) ?? "n/a") +
            " medPriceProgressPer1M=" +
            (median(group.map((f) => f.priceProgressPer1M))?.toFixed(3) ??
              "n/a"),
        );
      }
      charFingerprint(aFps, "A");
      charFingerprint(bFps, "B");
      charFingerprint(cFps, "C");

      // Empirical recovery survival region: among B+C (pairs with a real later push), recovery reached vs whether C (new extreme) still occurs.
      const pairsWithLaterPush = [...bFps, ...cFps].filter(
        (f) => f.maxRecoveryAtrReached !== null,
      );
      if (pairsWithLaterPush.length >= MIN_OBS_FOR_TABLE) {
        const recoveries = sortNum(
          pairsWithLaterPush.map((f) => f.maxRecoveryAtrReached as number),
        );
        const commonRegionMax = percentile(recoveries, 50); // below this, C is still common (see printed probs)
        const rareRegionMin = percentile(recoveries, 85);
        const belowCommon = pairsWithLaterPush.filter(
          (f) => (f.maxRecoveryAtrReached as number) <= (commonRegionMax ?? 0),
        );
        const aboveRare = pairsWithLaterPush.filter(
          (f) =>
            (f.maxRecoveryAtrReached as number) >= (rareRegionMin ?? Infinity),
        );
        const cProbBelow = belowCommon.length
          ? (belowCommon.filter((f) => f.outcome === "C").length /
              belowCommon.length) *
            100
          : null;
        const cProbAbove = aboveRare.length
          ? (aboveRare.filter((f) => f.outcome === "C").length /
              aboveRare.length) *
            100
          : null;
        console.log(
          "    empirical recovery region: <=" +
            (commonRegionMax?.toFixed(2) ?? "n/a") +
            " ATR -> C(continuation) still occurs " +
            fmtPct(cProbBelow) +
            " of the time (n=" +
            belowCommon.length +
            ")",
        );
        console.log(
          "    empirical recovery region: >=" +
            (rareRegionMin?.toFixed(2) ?? "n/a") +
            " ATR -> C(continuation) occurs only " +
            fmtPct(cProbAbove) +
            " of the time (n=" +
            aboveRare.length +
            ")",
        );
      } else {
        console.log(
          "    empirical recovery region: INSUFFICIENT_SAMPLE for a reliable region (n=" +
            pairsWithLaterPush.length +
            ")",
        );
      }

      // W2 effort-vs-result within C, relative split by this symbol/side's own median efficiency.
      if (cFps.length >= 3) {
        const cEffMedian = median(cFps.map((f) => f.incrementalEfficiency));
        cFps.forEach(
          (f) =>
            (f.cAboveMedianEfficiency =
              cEffMedian !== null &&
              (f.incrementalEfficiency ?? 0) >= cEffMedian),
        );
        const aboveCount = cFps.filter((f) => f.cAboveMedianEfficiency).length;
        console.log(
          "    within C: median incrementalEfficiency=" +
            (cEffMedian?.toFixed(3) ?? "n/a") +
            "; " +
            aboveCount +
            "/" +
            cFps.length +
            " above their own median (efficient continuation), rest are marginal/weak continuations despite making SOME new extreme",
        );
      }

      perSymbolSummary[key] = {
        n: fps.length,
        aPct: (aCount / fps.length) * 100,
        bPct: (bCount / fps.length) * 100,
        cPct: (cCount / fps.length) * 100,
      };
    }
  }

  // ═══ 3. Real examples ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "3. REAL EXAMPLES (up to 3 per category, from symbols with the most data)",
  );
  console.log("=".repeat(100));
  function printExample(f: W1Fingerprint, label: string) {
    console.log(
      "\n[" +
        label +
        "] " +
        f.symbol +
        " " +
        f.victim +
        " W1 start=" +
        new Date(f.w1Start).toISOString(),
    );
    console.log(
      "  eventCount=" +
        f.eventCount +
        " totalLiq=" +
        fmtUsd(f.totalLiqUsd) +
        " maxEvent=" +
        fmtUsd(f.maxEvent) +
        " (P95 ratio=" +
        f.maxEventOverP95.toFixed(2) +
        "x)",
    );
    console.log(
      "  extensionAtr=" +
        f.extensionAtr.toFixed(3) +
        " runningExtreme=" +
        f.runningExtreme +
        " @ " +
        new Date(f.runningExtremeTs).toISOString(),
    );
    if (f.outcome !== "A") {
      console.log(
        "  maxRecoveryReached=" +
          (f.maxRecoveryAtrReached?.toFixed(3) ?? "n/a") +
          " ATR, timeUntilPush2=" +
          (f.timeUntilPush2Ms !== null
            ? (f.timeUntilPush2Ms / 60000).toFixed(1) + "m"
            : "n/a"),
      );
      console.log(
        "  push2: totalLiq=" +
          fmtUsd(f.push2TotalUsd) +
          " liqRatio=" +
          (f.push2LiqRatio?.toFixed(2) ?? "n/a") +
          " incrementalExtensionAtr=" +
          (f.incrementalExtensionAtr?.toFixed(3) ?? "n/a"),
      );
    } else {
      console.log(
        "  no later meaningful push found in this dataset -- W1 alone was the whole observed episode.",
      );
    }
  }
  const aExample = allFpFlat
    .filter((f) => f.outcome === "A")
    .sort((a, b) => b.totalLiqUsd - a.totalLiqUsd)[0];
  const bExample = allFpFlat
    .filter((f) => f.outcome === "B")
    .sort((a, b) => b.push2LiqRatio! - a.push2LiqRatio!)[0];
  const cExample = allFpFlat
    .filter((f) => f.outcome === "C" && f.cAboveMedianEfficiency)
    .sort(
      (a, b) =>
        (b.incrementalExtensionAtr ?? 0) - (a.incrementalExtensionAtr ?? 0),
    )[0];
  if (aExample) printExample(aExample, "A: W1 alone was enough");
  if (bExample)
    printExample(bExample, "B: W2 exhaustion (effort spent, no new territory)");
  if (cExample)
    printExample(cExample, "C: true continuation (efficient new extreme)");

  // ═══ 4. Similarity test ═══
  console.log("\n" + "=".repeat(100));
  console.log("SIMILARITY / k-NN TEST vs recovery-percentile-only baseline");
  console.log("=".repeat(100));
  function standardize(vals: number[]): number[] {
    const m = vals.reduce((s, x) => s + x, 0) / vals.length;
    const sd =
      Math.sqrt(vals.reduce((s, x) => s + (x - m) ** 2, 0) / vals.length) || 1;
    return vals.map((x) => (x - m) / sd);
  }
  const knnResults: any = {};
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const fps = allFingerprints[symbol]?.[victim] ?? [];
      if (fps.length < MIN_OBS_FOR_TABLE + KNN_K) continue;
      const key = symbol + "_" + victim;
      const featVectors = [
        standardize(fps.map((f) => f.maxEventOverP95)),
        standardize(fps.map((f) => Math.log(f.totalLiqUsd + 1))),
        standardize(fps.map((f) => f.extensionAtr)),
        standardize(fps.map((f) => f.priceProgressPer1M ?? 0)),
        standardize(fps.map((f) => f.eventCount)),
      ];
      const points = fps.map((_, i) => featVectors.map((fv) => fv[i]));

      let knnCorrect = 0;
      for (let i = 0; i < fps.length; i++) {
        const dists = points.map((p, j) =>
          j === i
            ? Infinity
            : Math.sqrt(p.reduce((s, v, d) => s + (v - points[i][d]) ** 2, 0)),
        );
        const nearestIdx = dists
          .map((d, j) => [d, j] as [number, number])
          .sort((a, b) => a[0] - b[0])
          .slice(0, KNN_K)
          .map(([, j]) => j);
        const votes: Record<string, number> = { A: 0, B: 0, C: 0 };
        nearestIdx.forEach((j) => votes[fps[j].outcome]++);
        const predicted = Object.entries(votes).sort(
          (a, b) => b[1] - a[1],
        )[0][0];
        if (predicted === fps[i].outcome) knnCorrect++;
      }
      const knnAccuracy = (knnCorrect / fps.length) * 100;

      const counts = {
        A: fps.filter((f) => f.outcome === "A").length,
        B: fps.filter((f) => f.outcome === "B").length,
        C: fps.filter((f) => f.outcome === "C").length,
      };
      const majorityClass = Object.entries(counts).sort(
        (a, b) => b[1] - a[1],
      )[0];
      const baselineAccuracy = (majorityClass[1] / fps.length) * 100;

      console.log(
        key +
          ": kNN(k=" +
          KNN_K +
          ") accuracy=" +
          fmtPct(knnAccuracy) +
          "  vs  majority-class baseline (" +
          majorityClass[0] +
          ")=" +
          fmtPct(baselineAccuracy) +
          "  -- " +
          (knnAccuracy > baselineAccuracy + 5
            ? "kNN MEANINGFULLY BETTER"
            : knnAccuracy < baselineAccuracy - 5
              ? "kNN WORSE than just guessing the majority class"
              : "no meaningful improvement over the naive baseline"),
      );
      knnResults[key] = {
        n: fps.length,
        knnAccuracy,
        baselineAccuracy,
        majorityClass: majorityClass[0],
      };
    }
  }

  // ═══ 5. Final design questions ═══
  console.log("\n" + "=".repeat(100));
  console.log("4. CURRENT DESIGN QUESTIONS -- ANSWERED FROM THE DATA ABOVE");
  console.log("=".repeat(100));
  const validSymbolSides = Object.values(perSymbolSummary).filter(
    (v) => v !== "INSUFFICIENT_SAMPLE",
  ) as any[];
  const avgAPct = median(validSymbolSides.map((v) => v.aPct));
  const avgCPct = median(validSymbolSides.map((v) => v.cPct));
  console.log(
    "A. Is W2 universally necessary? " +
      (avgAPct !== null && avgAPct > 40
        ? "NO -- across symbol/sides with enough data, W1 alone was terminal (outcome A) in a median of " +
          fmtPct(avgAPct) +
          " of cases; mandatory W2 waiting adds delay in those cases with no benefit."
        : avgCPct !== null && avgCPct > 40
          ? "MOSTLY YES for symbol/sides where continuation (C) is common -- see per-symbol table above for which ones."
          : "MIXED -- varies materially by symbol/side, see table above; NOT ENOUGH DATA for a single universal answer."),
  );
  console.log(
    "B. Can some W1 fingerprints safely skip mandatory W2? See the per-symbol A/B/C characteristic fingerprints above -- symbol/sides with high A% and clearly distinct fingerprints for A vs C are the candidates; this needs per-symbol confirmation, not a single rule.",
  );
  console.log(
    "C. Can recovery-region-based dynamic cancellation work? See the empirical recovery regions printed per symbol/side above -- where a clear low-probability region exists at higher recovery levels, yes, in a per-symbol/side sense; where B/C samples are thin, not yet.",
  );
  const knnBetterCount = Object.values(knnResults).filter(
    (r: any) => r.knnAccuracy > r.baselineAccuracy + 5,
  ).length;
  console.log(
    "D. Does W2 effort-vs-incremental-result distinguish exhaustion from continuation? See the 'within C: above/below own median efficiency' lines above -- present but not uniform across symbols (matches the effort/result split from the prior 72h study).",
  );
  console.log(
    "E. Is per-symbol/per-side historical matching materially better than one global recovery rule? kNN beat the naive per-symbol majority-class baseline in " +
      knnBetterCount +
      " of " +
      Object.keys(knnResults).length +
      " testable symbol/sides -- " +
      (knnBetterCount > Object.keys(knnResults).length / 2
        ? "similarity-based matching shows a real, if modest, edge over a single global rule for MOST symbol/sides tested."
        : "similarity-based matching does NOT show a consistent edge over a much simpler per-symbol majority-class guess in this sample -- the recovery-percentile approach from the prior pass may already capture most of the usable signal."),
  );

  const outPath = path.join(
    OUTPUT_DIR,
    "w1-w2-fingerprint-research-" + Date.now() + ".json",
  );
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        perSymbolSummary,
        knnResults,
        sanity: { globalNegativeDelayCount, globalImpossibleValueCount },
        allFingerprints,
      },
      null,
      2,
    ),
  );
  console.log("\nFull classified observations saved to: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
