/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY, diagnostic ONLY.
 * Defines the raw-liquidation-flow evidence needed to choose a
 * causal EPISODE START / CONTINUE / END / NEW-EPISODE rule -- using
 * ONLY liquidation event timestamps and USD amounts. No ATR, no
 * price, no reversal, no TP/SL, no trading outcome anywhere in this
 * file. The existing minute-bucketed "wave" construction is used
 * ONLY as a size-reference scale (to define "meaningful burst" as a
 * pure liquidation-USD concept, calibrated to that symbol+victim's
 * own historical wave sizes) -- never as the boundary rule itself,
 * and never fed back into the gap analysis.
 *
 * CAUSALITY NOTE: this is a purely descriptive, retrospective study
 * of gap statistics, not a live production signal. The P95
 * significance stratification and the wave-size reference use the
 * full 72h distribution non-causally, because the question here is
 * "what does the data's natural cadence look like," not "what could
 * a live process have known at time T." This is explicitly different
 * from every prior pass in this thread that computed a live entry
 * signal -- there is no entry here, only a structural question about
 * where one episode ends and the next begins.
 *
 * "Meaningful burst followed" (the ground-truth label used to
 * evaluate candidate quiet-gap rules) is defined ENTIRELY from
 * liquidation USD flow: the forward 15-minute USD sum exceeds that
 * symbol+victim's own median wave total. This is not a price or ATR
 * concept, and not a trading outcome -- it is a pure liquidation-
 * pressure continuation signal, exactly as instructed.
 *
 * No threshold is chosen as "correct" here -- fixed and adaptive
 * candidates are reported side by side with their own agreement
 * rates against the ground-truth label, for the person to judge.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
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
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");
const TRAILING_WINDOW_MIN = 5;
const FORWARD_BURST_WINDOW_MIN = 15;
const TIGHT_CLUSTER_GAP_SEC = 60;
const FIXED_QUIET_GAPS_MIN = [2, 3, 5, 7, 10];
const ADAPTIVE_MULTIPLES = [2, 3, 5];
const GAP_BUCKETS: [string, (sec: number) => boolean][] = [
  ["0-30s", (s) => s <= 30],
  ["30-60s", (s) => s > 30 && s <= 60],
  ["1-2m", (s) => s > 60 && s <= 120],
  ["2-3m", (s) => s > 120 && s <= 180],
  ["3-5m", (s) => s > 180 && s <= 300],
  ["5-7m", (s) => s > 300 && s <= 420],
  ["7-10m", (s) => s > 420 && s <= 600],
  ["10-15m", (s) => s > 600 && s <= 900],
  ["15m+", (s) => s > 900],
];

function sortNum(a: (number | null)[]) {
  return a
    .filter(
      (x): x is number =>
        x !== null && x !== undefined && !isNaN(x) && Number.isFinite(x),
    )
    .sort((x, y) => x - y);
}
function median(a: (number | null)[]) {
  return percentile(sortNum(a), 50);
}
function percentile(sortedArr: number[], p: number): number | null {
  if (sortedArr.length === 0) return null;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sortedArr[lo]
    : sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}
function fmtUsd(n: number) {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(0);
}

interface RawEvent {
  timestamp: number;
  price: number;
  quoteQty: number;
  victim: string;
}
interface GapRecord {
  symbol: string;
  victim: string;
  gapSec: number;
  preGapUsd: number;
  postGapUsd5min: number;
  postGapUsd15min: number;
  ratio: number | null;
  meaningfulBurstFollowed: boolean;
  eventBeforeIdx: number;
  tsBefore: number;
  tsAfter: number;
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
  const windowStart = Math.floor((now - HOURS * 3600 * 1000) / 60000) * 60000;
  const windowEnd = now;

  const allGaps: GapRecord[] = [];
  const adaptiveEvalRecords: {
    symbol: string;
    victim: string;
    boundaryGapSec: number;
    clusterMedianSpacingSec: number;
    clusterP75SpacingSec: number;
    clusterP90SpacingSec: number;
    meaningfulBurstFollowed: boolean;
  }[] = [];

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const events = (await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: windowEnd } })
      .sort({ timestamp: 1 })
      .toArray()) as unknown as RawEvent[];
    if (events.length === 0) {
      console.log("  NO DATA.\n");
      continue;
    }
    console.log("  raw events: " + events.length);

    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEvents = events
        .filter((e) => e.victim === victim)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (sideEvents.length < 2) continue;

      const byMinute = new Map<number, RawEvent[]>();
      for (const e of sideEvents) {
        const m = Math.floor(e.timestamp / 60000) * 60000;
        if (!byMinute.has(m)) byMinute.set(m, []);
        byMinute.get(m)!.push(e);
      }
      const minuteKeys: number[] = [];
      for (let t = windowStart; t <= windowEnd; t += 60000)
        if (byMinute.has(t)) minuteKeys.push(t);
      const waveTotals: number[] = [];
      let curTotal = 0;
      let lastMinute: number | null = null;
      for (const m of minuteKeys) {
        if (lastMinute !== null && m - lastMinute > 60000) {
          waveTotals.push(curTotal);
          curTotal = 0;
        }
        curTotal += byMinute.get(m)!.reduce((s, e) => s + e.quoteQty, 0);
        lastMinute = m;
      }
      if (curTotal > 0) waveTotals.push(curTotal);
      const medianWaveUsd = median(waveTotals) ?? 0;

      function usdInTrailingWindow(
        uptoIdx: number,
        minutesBack: number,
      ): number {
        const tsRef = sideEvents[uptoIdx].timestamp;
        return sideEvents
          .filter(
            (e) =>
              e.timestamp <= tsRef && e.timestamp > tsRef - minutesBack * 60000,
          )
          .reduce((s, e) => s + e.quoteQty, 0);
      }
      function usdInForwardWindow(
        fromIdx: number,
        minutesForward: number,
      ): number {
        const tsRef = sideEvents[fromIdx].timestamp;
        return sideEvents
          .filter(
            (e) =>
              e.timestamp >= tsRef &&
              e.timestamp < tsRef + minutesForward * 60000,
          )
          .reduce((s, e) => s + e.quoteQty, 0);
      }

      for (let i = 0; i < sideEvents.length - 1; i++) {
        const gapSec =
          (sideEvents[i + 1].timestamp - sideEvents[i].timestamp) / 1000;
        const preGapUsd = usdInTrailingWindow(i, TRAILING_WINDOW_MIN);
        const postGapUsd5min = usdInForwardWindow(i + 1, TRAILING_WINDOW_MIN);
        const postGapUsd15min = usdInForwardWindow(
          i + 1,
          FORWARD_BURST_WINDOW_MIN,
        );
        const ratio = preGapUsd > 0 ? postGapUsd5min / preGapUsd : null;
        const meaningfulBurstFollowed = postGapUsd15min >= medianWaveUsd;
        allGaps.push({
          symbol,
          victim,
          gapSec,
          preGapUsd,
          postGapUsd5min,
          postGapUsd15min,
          ratio,
          meaningfulBurstFollowed,
          eventBeforeIdx: i,
          tsBefore: sideEvents[i].timestamp,
          tsAfter: sideEvents[i + 1].timestamp,
        });
      }

      let clusterStart = 0;
      for (let i = 0; i <= sideEvents.length; i++) {
        const gapHere =
          i < sideEvents.length - 1
            ? (sideEvents[i + 1].timestamp - sideEvents[i].timestamp) / 1000
            : Infinity;
        if (
          gapHere > TIGHT_CLUSTER_GAP_SEC ||
          i === sideEvents.length - 1 ||
          i === sideEvents.length
        ) {
          const clusterEnd = i;
          if (clusterEnd > clusterStart) {
            const internalGaps: number[] = [];
            for (let j = clusterStart; j < clusterEnd; j++)
              internalGaps.push(
                (sideEvents[j + 1].timestamp - sideEvents[j].timestamp) / 1000,
              );
            if (
              internalGaps.length >= 2 &&
              clusterEnd < sideEvents.length - 1
            ) {
              const sortedInternal = sortNum(internalGaps);
              const medSpacing = percentile(sortedInternal, 50),
                p75Spacing = percentile(sortedInternal, 75),
                p90Spacing = percentile(sortedInternal, 90);
              const boundaryGapSec =
                (sideEvents[clusterEnd + 1].timestamp -
                  sideEvents[clusterEnd].timestamp) /
                1000;
              const postUsd15 = usdInForwardWindow(
                clusterEnd + 1,
                FORWARD_BURST_WINDOW_MIN,
              );
              if (
                medSpacing !== null &&
                p75Spacing !== null &&
                p90Spacing !== null
              ) {
                adaptiveEvalRecords.push({
                  symbol,
                  victim,
                  boundaryGapSec,
                  clusterMedianSpacingSec: medSpacing,
                  clusterP75SpacingSec: p75Spacing,
                  clusterP90SpacingSec: p90Spacing,
                  meaningfulBurstFollowed: postUsd15 >= medianWaveUsd,
                });
              }
            }
          }
          clusterStart = i + 1;
        }
      }
    }
  }

  console.log("\nTotal same-side gaps analyzed: " + allGaps.length);
  console.log(
    "Total tight-cluster boundary evaluations: " + adaptiveEvalRecords.length,
  );

  function significancePopulations(
    gaps: GapRecord[],
  ): { name: string; filtered: GapRecord[] }[] {
    const bySymbolP95: Record<string, number> = {};
    for (const symbol of SYMBOLS) {
      const symGapPreUsd = sortNum(
        gaps.filter((g) => g.symbol === symbol).map((g) => g.preGapUsd),
      );
      bySymbolP95[symbol] = percentile(symGapPreUsd, 95) ?? Infinity;
    }
    return [
      { name: "all gaps", filtered: gaps },
      {
        name: "preGapUsd >= $10k",
        filtered: gaps.filter((g) => g.preGapUsd >= 10000),
      },
      {
        name: "preGapUsd >= $50k",
        filtered: gaps.filter((g) => g.preGapUsd >= 50000),
      },
      {
        name: "preGapUsd >= $100k",
        filtered: gaps.filter((g) => g.preGapUsd >= 100000),
      },
      {
        name: "preGapUsd >= P95 (per symbol)",
        filtered: gaps.filter((g) => g.preGapUsd >= bySymbolP95[g.symbol]),
      },
    ];
  }

  console.log("\n" + "=".repeat(175));
  console.log(
    "GAP-BUCKET DISTRIBUTIONS BY SIGNIFICANCE POPULATION (pooled across all symbols/sides)",
  );
  console.log("=".repeat(175));
  const pops = significancePopulations(allGaps);
  for (const pop of pops) {
    console.log("\n-- " + pop.name + " (n=" + pop.filtered.length + ") --");
    console.log(
      "  bucket | n | medianPreUsd | medianPostUsd(5m) | medianRatio | %meaningfulBurstFollowed(15m fwd)",
    );
    for (const [label, pred] of GAP_BUCKETS) {
      const group = pop.filtered.filter((g) => pred(g.gapSec));
      const medPre = median(group.map((g) => g.preGapUsd)),
        medPost = median(group.map((g) => g.postGapUsd5min)),
        medRatio = median(group.map((g) => g.ratio));
      const pctFollowed =
        group.length > 0
          ? (group.filter((g) => g.meaningfulBurstFollowed).length /
              group.length) *
            100
          : null;
      console.log(
        "  " +
          label.padEnd(8) +
          " | " +
          String(group.length).padStart(5) +
          " | " +
          fmtUsd(medPre ?? 0).padStart(10) +
          " | " +
          fmtUsd(medPost ?? 0).padStart(10) +
          " | " +
          (medRatio?.toFixed(3) ?? "n/a").padStart(8) +
          " | " +
          (pctFollowed?.toFixed(1) ?? "n/a") +
          "%",
      );
    }
  }

  console.log("\n" + "=".repeat(175));
  console.log(
    "PER-SYMBOL GAP-BUCKET BREAKDOWN (all gaps, %meaningfulBurstFollowed only -- checking whether the cadence differs by symbol)",
  );
  console.log("=".repeat(175));
  for (const symbol of SYMBOLS) {
    const symGaps = allGaps.filter((g) => g.symbol === symbol);
    if (symGaps.length === 0) continue;
    console.log("\n  " + symbol + " (n=" + symGaps.length + "):");
    for (const [label, pred] of GAP_BUCKETS) {
      const group = symGaps.filter((g) => pred(g.gapSec));
      if (group.length === 0) continue;
      const pctFollowed =
        (group.filter((g) => g.meaningfulBurstFollowed).length / group.length) *
        100;
      console.log(
        "    " +
          label.padEnd(8) +
          " n=" +
          group.length +
          "  %followed=" +
          pctFollowed.toFixed(1) +
          "%",
      );
    }
  }

  console.log("\n" + "=".repeat(175));
  console.log(
    "FIXED QUIET-GAP CANDIDATES: does calling 'gap >= X' QUIET correctly predict NO meaningful burst follows?",
  );
  console.log("=".repeat(175));
  console.log(
    "(accuracy = fraction of gaps where the rule's call -- quiet vs continuation -- matches the ground-truth label)",
  );
  for (const quietMin of FIXED_QUIET_GAPS_MIN) {
    const quietSec = quietMin * 60;
    let correct = 0;
    for (const g of allGaps) {
      const calledQuiet = g.gapSec >= quietSec;
      const trueQuiet = !g.meaningfulBurstFollowed;
      if (calledQuiet === trueQuiet) correct++;
    }
    const accuracy = (correct / allGaps.length) * 100;
    const quietCalls = allGaps.filter((g) => g.gapSec >= quietSec);
    const falsePositiveContinuations = quietCalls.filter(
      (g) => g.meaningfulBurstFollowed,
    ).length;
    console.log(
      "  quiet>=" +
        quietMin +
        "min: accuracy=" +
        accuracy.toFixed(1) +
        "%  (n called quiet=" +
        quietCalls.length +
        ", of which " +
        falsePositiveContinuations +
        " were actually followed by a meaningful burst anyway)",
    );
  }

  console.log("\n" + "=".repeat(175));
  console.log(
    "ADAPTIVE QUIET-GAP CANDIDATES (boundary gap >= N x cluster's own internal median/P75/P90 spacing)",
  );
  console.log("=".repeat(175));
  for (const basis of ["median", "p75", "p90"] as const) {
    for (const mult of ADAPTIVE_MULTIPLES) {
      let correct = 0;
      for (const r of adaptiveEvalRecords) {
        const basisVal =
          basis === "median"
            ? r.clusterMedianSpacingSec
            : basis === "p75"
              ? r.clusterP75SpacingSec
              : r.clusterP90SpacingSec;
        const calledQuiet = r.boundaryGapSec >= mult * basisVal;
        const trueQuiet = !r.meaningfulBurstFollowed;
        if (calledQuiet === trueQuiet) correct++;
      }
      const accuracy =
        adaptiveEvalRecords.length > 0
          ? (correct / adaptiveEvalRecords.length) * 100
          : null;
      console.log(
        "  " +
          mult +
          "x cluster-" +
          basis +
          "-spacing: accuracy=" +
          (accuracy?.toFixed(1) ?? "n/a") +
          "%  (n=" +
          adaptiveEvalRecords.length +
          ")",
      );
    }
  }
  for (const basis of ["p75", "p90"] as const) {
    let correct = 0;
    for (const r of adaptiveEvalRecords) {
      const basisVal =
        basis === "p75" ? r.clusterP75SpacingSec : r.clusterP90SpacingSec;
      const calledQuiet = r.boundaryGapSec >= basisVal;
      const trueQuiet = !r.meaningfulBurstFollowed;
      if (calledQuiet === trueQuiet) correct++;
    }
    const accuracy =
      adaptiveEvalRecords.length > 0
        ? (correct / adaptiveEvalRecords.length) * 100
        : null;
    console.log(
      "  1x cluster-" +
        basis +
        "-spacing (direct cutoff): accuracy=" +
        (accuracy?.toFixed(1) ?? "n/a") +
        "%",
    );
  }

  console.log("\n" + "=".repeat(175));
  console.log(
    "TYPICAL CLUSTER INTERNAL SPACING (for context on what the adaptive rule is actually scaling)",
  );
  console.log("=".repeat(175));
  console.log(
    "  median cluster median-spacing: " +
      (median(
        adaptiveEvalRecords.map((r) => r.clusterMedianSpacingSec),
      )?.toFixed(1) ?? "n/a") +
      "s",
  );
  console.log(
    "  median cluster P75-spacing: " +
      (median(adaptiveEvalRecords.map((r) => r.clusterP75SpacingSec))?.toFixed(
        1,
      ) ?? "n/a") +
      "s",
  );
  console.log(
    "  median cluster P90-spacing: " +
      (median(adaptiveEvalRecords.map((r) => r.clusterP90SpacingSec))?.toFixed(
        1,
      ) ?? "n/a") +
      "s",
  );

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "episode-boundary-gap-analysis-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        hoursWindow: HOURS,
        trailingWindowMin: TRAILING_WINDOW_MIN,
        forwardBurstWindowMin: FORWARD_BURST_WINDOW_MIN,
        tightClusterGapSec: TIGHT_CLUSTER_GAP_SEC,
        note: "No ATR, price, reversal, or trading outcome used anywhere. meaningfulBurstFollowed is a pure liquidation-USD flow concept, calibrated to each symbol+victim's own median wave size (used only as a scale reference).",
        totalGaps: allGaps.length,
        totalAdaptiveEvaluations: adaptiveEvalRecords.length,
        gaps: allGaps,
        adaptiveEvalRecords,
      },
      null,
      2,
    ),
  );
  console.log("\n\nFull data: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
