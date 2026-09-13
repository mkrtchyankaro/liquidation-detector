/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY research, built
 * strictly on the 1-minute liquidation timeline (no raw-event episode
 * grouping, no candles, no ATR, no fixed gap threshold).
 *
 * Defines activeRun = a maximal block of consecutive non-zero minutes
 * per symbol+victim. Derives magnitude regimes (small/medium/large/
 * extreme) from each symbol+victim's OWN historical distribution of
 * run totalUSD -- never a universal dollar cutoff. Studies
 * Run1 -> zero-gap -> Run2 (-> zero-gap -> Run3) sequences, with
 * emphasis on MEDIUM and LARGE runs (the conditions expected in
 * regular operation), while still reporting EXTREME/shock runs
 * separately rather than folding them into the normal distributions.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. No W1/W2 label used anywhere below -- these are plain
 * Run1/Run2/Run3, by design.
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
const GAP_BUCKETS = [1, 2, 3, 5, 10, 15, 20, 30, 60];

function fmtUsd(n: number) {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtClock(ms: number) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
function fmtPct(n: number | null, d?: number) {
  return n === null || n === undefined ? "n/a" : n.toFixed(d ?? 1) + "%";
}
function sortNum(a: number[]) {
  return [...a]
    .filter((x) => x !== null && x !== undefined && !isNaN(x))
    .sort((x, y) => x - y);
}
function median(a: number[]) {
  const s = sortNum(a);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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
function percentileRank(sortedArr: number[], value: number): number {
  if (sortedArr.length === 0) return 0;
  let count = 0;
  for (const v of sortedArr) if (v <= value) count++;
  return (count / sortedArr.length) * 100;
}

interface MinuteRow {
  minuteTs: number;
  eventCount: number;
  totalLiquidationUsd: number;
  maxSingleEventUsd: number;
  firstLiquidationPrice: number | null;
  lastLiquidationPrice: number | null;
  minLiquidationPrice: number | null;
  maxLiquidationPrice: number | null;
}
interface ActiveRun {
  symbol: string;
  victim: "LONG" | "SHORT";
  runIdx: number;
  startTs: number;
  endTs: number;
  durationMinutes: number;
  totalUsd: number;
  eventCount: number;
  maxMinuteUsd: number;
  maxSingleEventUsd: number;
  firstPrice: number;
  lastPrice: number;
  minPrice: number;
  maxPrice: number;
  magnitudePercentile: number;
  regime: string;
}
type Regime = "small/background" | "medium" | "large" | "extreme/shock";

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
  const windowEndMinute = Math.floor(now / 60000) * 60000;

  const allTimelines: Record<
    string,
    Record<"LONG" | "SHORT", MinuteRow[]>
  > = {};
  const allRuns: Record<string, Record<"LONG" | "SHORT", ActiveRun[]>> = {};

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const events = await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: now } })
      .sort({ timestamp: 1 })
      .toArray();
    allTimelines[symbol] = { LONG: [], SHORT: [] };
    allRuns[symbol] = { LONG: [], SHORT: [] };

    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEvents = events.filter((e) => e.victim === victim);
      const byMinute = new Map<number, any[]>();
      for (const e of sideEvents) {
        const m = Math.floor(e.timestamp / 60000) * 60000;
        if (!byMinute.has(m)) byMinute.set(m, []);
        byMinute.get(m)!.push(e);
      }

      const timeline: MinuteRow[] = [];
      for (let t = windowStart; t <= windowEndMinute; t += 60000) {
        const evs = byMinute.get(t);
        if (!evs || evs.length === 0)
          timeline.push({
            minuteTs: t,
            eventCount: 0,
            totalLiquidationUsd: 0,
            maxSingleEventUsd: 0,
            firstLiquidationPrice: null,
            lastLiquidationPrice: null,
            minLiquidationPrice: null,
            maxLiquidationPrice: null,
          });
        else {
          const prices = evs.map((e) => e.price);
          timeline.push({
            minuteTs: t,
            eventCount: evs.length,
            totalLiquidationUsd: evs.reduce((s, e) => s + e.quoteQty, 0),
            maxSingleEventUsd: Math.max(...evs.map((e) => e.quoteQty)),
            firstLiquidationPrice: evs[0].price,
            lastLiquidationPrice: evs[evs.length - 1].price,
            minLiquidationPrice: Math.min(...prices),
            maxLiquidationPrice: Math.max(...prices),
          });
        }
      }
      allTimelines[symbol][victim] = timeline;

      const runs: Omit<ActiveRun, "magnitudePercentile" | "regime">[] = [];
      let cur: MinuteRow[] = [];
      for (const r of timeline) {
        if (r.eventCount > 0) cur.push(r);
        else if (cur.length > 0) {
          runs.push(buildRun(symbol, victim, runs.length, cur));
          cur = [];
        }
      }
      if (cur.length > 0) runs.push(buildRun(symbol, victim, runs.length, cur));

      function buildRun(
        symbol: string,
        victim: "LONG" | "SHORT",
        idx: number,
        mins: MinuteRow[],
      ): Omit<ActiveRun, "magnitudePercentile" | "regime"> {
        return {
          symbol,
          victim,
          runIdx: idx,
          startTs: mins[0].minuteTs,
          endTs: mins[mins.length - 1].minuteTs,
          durationMinutes: mins.length,
          totalUsd: mins.reduce((s, m) => s + m.totalLiquidationUsd, 0),
          eventCount: mins.reduce((s, m) => s + m.eventCount, 0),
          maxMinuteUsd: Math.max(...mins.map((m) => m.totalLiquidationUsd)),
          maxSingleEventUsd: Math.max(...mins.map((m) => m.maxSingleEventUsd)),
          firstPrice: mins[0].firstLiquidationPrice!,
          lastPrice: mins[mins.length - 1].lastLiquidationPrice!,
          minPrice: Math.min(...mins.map((m) => m.minLiquidationPrice!)),
          maxPrice: Math.max(...mins.map((m) => m.maxLiquidationPrice!)),
        };
      }

      const totals = sortNum(runs.map((r) => r.totalUsd));
      const p50 = percentile(totals, 50)!,
        p80 = percentile(totals, 80)!,
        p95 = percentile(totals, 95)!;
      const withRegime: ActiveRun[] = runs.map((r) => {
        const pctile = percentileRank(totals, r.totalUsd);
        const regime: Regime =
          r.totalUsd < p50
            ? "small/background"
            : r.totalUsd < p80
              ? "medium"
              : r.totalUsd < p95
                ? "large"
                : "extreme/shock";
        return { ...r, magnitudePercentile: pctile, regime };
      });
      allRuns[symbol][victim] = withRegime;

      const regimeCounts = {
        "small/background": 0,
        medium: 0,
        large: 0,
        "extreme/shock": 0,
      };
      withRegime.forEach((r) => regimeCounts[r.regime as Regime]++);
      console.log(
        "  " +
          victim +
          ": " +
          withRegime.length +
          " runs. thresholds p50=" +
          fmtUsd(p50) +
          " p80=" +
          fmtUsd(p80) +
          " p95=" +
          fmtUsd(p95) +
          " -- small=" +
          regimeCounts["small/background"] +
          " medium=" +
          regimeCounts.medium +
          " large=" +
          regimeCounts.large +
          " extreme=" +
          regimeCounts["extreme/shock"],
      );
    }
  }

  interface Pair {
    symbol: string;
    victim: "LONG" | "SHORT";
    run1: ActiveRun;
    run2: ActiveRun;
    run3: ActiveRun | null;
    zeroGapMinutes: number;
    zeroGapMinutes2: number | null;
    run2Ratio: number;
    run2NewTerritory: boolean;
    run3NewTerritory: boolean | null;
  }
  const allPairs: Pair[] = [];
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const runs = allRuns[symbol][victim];
      for (let i = 0; i < runs.length - 1; i++) {
        const r1 = runs[i],
          r2 = runs[i + 1];
        const zeroGapMinutes = Math.round((r2.startTs - r1.endTs) / 60000) - 1;
        const run2NewTerritory =
          victim === "LONG"
            ? r2.minPrice < r1.minPrice
            : r2.maxPrice > r1.maxPrice;
        let run3: ActiveRun | null = null,
          zeroGapMinutes2: number | null = null,
          run3NewTerritory: boolean | null = null;
        if (i + 2 < runs.length) {
          run3 = runs[i + 2];
          zeroGapMinutes2 = Math.round((run3.startTs - r2.endTs) / 60000) - 1;
          run3NewTerritory =
            victim === "LONG"
              ? run3.minPrice < Math.min(r1.minPrice, r2.minPrice)
              : run3.maxPrice > Math.max(r1.maxPrice, r2.maxPrice);
        }
        allPairs.push({
          symbol,
          victim,
          run1: r1,
          run2: r2,
          run3,
          zeroGapMinutes,
          zeroGapMinutes2,
          run2Ratio: r1.totalUsd > 0 ? r2.totalUsd / r1.totalUsd : 0,
          run2NewTerritory,
          run3NewTerritory,
        });
      }
    }
  }
  console.log("\nTotal Run1->Run2 pairs built: " + allPairs.length);

  console.log("\n" + "=".repeat(100));
  console.log(
    "EMPIRICAL QUESTIONS 1-4, BY RUN1 MAGNITUDE REGIME (combined across symbols -- per-symbol breakdown in JSON)",
  );
  console.log("=".repeat(100));
  for (const regime of [
    "medium",
    "large",
    "extreme/shock",
    "small/background",
  ] as Regime[]) {
    const pairs = allPairs.filter((p) => p.run1.regime === regime);
    console.log(
      "\n--- Run1 regime = " + regime + " (n=" + pairs.length + " pairs) ---",
    );
    if (pairs.length === 0) continue;
    const gaps = pairs.map((p) => p.zeroGapMinutes);
    console.log(
      "Q1. silence before Run2 (zero-minutes): median=" +
        median(gaps) +
        " p75=" +
        percentile(sortNum(gaps), 75) +
        " p90=" +
        percentile(sortNum(gaps), 90),
    );
    console.log("Q2. Run2 appears within N zero-minutes:");
    GAP_BUCKETS.forEach((n) => {
      const within = pairs.filter((p) => p.zeroGapMinutes <= n).length;
      console.log(
        "    <= " + n + "min: " + fmtPct((within / pairs.length) * 100),
      );
    });
    const ratios = pairs.map((p) => p.run2Ratio);
    const smaller = pairs.filter((p) => p.run2Ratio < 0.8).length,
      similar = pairs.filter(
        (p) => p.run2Ratio >= 0.8 && p.run2Ratio <= 1.25,
      ).length,
      larger = pairs.filter((p) => p.run2Ratio > 1.25).length;
    console.log(
      "Q3. Run2/Run1 USD ratio: median=" +
        median(ratios)?.toFixed(2) +
        " -- smaller(<0.8x)=" +
        fmtPct((smaller / pairs.length) * 100) +
        " similar(0.8-1.25x)=" +
        fmtPct((similar / pairs.length) * 100) +
        " larger(>1.25x)=" +
        fmtPct((larger / pairs.length) * 100),
    );
    const newTerr = pairs.filter((p) => p.run2NewTerritory).length;
    console.log(
      "Q4. Run2 makes new directional territory beyond Run1's extreme: " +
        fmtPct((newTerr / pairs.length) * 100),
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log("Q5. REGIME COMPARISON (side-by-side)");
  console.log("=".repeat(100));
  console.log(
    "regime | n | medianSilenceMin | medianRun2Ratio | newTerritory%",
  );
  for (const regime of [
    "small/background",
    "medium",
    "large",
    "extreme/shock",
  ] as Regime[]) {
    const pairs = allPairs.filter((p) => p.run1.regime === regime);
    if (pairs.length === 0) {
      console.log(regime + " | 0 | n/a | n/a | n/a");
      continue;
    }
    const medSilence = median(pairs.map((p) => p.zeroGapMinutes));
    const medRatio = median(pairs.map((p) => p.run2Ratio));
    const newTerrPct =
      (pairs.filter((p) => p.run2NewTerritory).length / pairs.length) * 100;
    console.log(
      regime +
        " | " +
        pairs.length +
        " | " +
        medSilence +
        " | " +
        medRatio?.toFixed(2) +
        " | " +
        fmtPct(newTerrPct),
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log(
    "Q6. EXTREME/SHOCK vs MEDIUM+LARGE -- structural comparison (Run1's own properties, not just what follows)",
  );
  console.log("=".repeat(100));
  const allRunsFlat: ActiveRun[] = [];
  for (const symbol of SYMBOLS)
    for (const victim of ["LONG", "SHORT"] as const)
      allRunsFlat.push(...allRuns[symbol][victim]);
  function regimeRunStats(regime: Regime | Regime[]) {
    const regimes = Array.isArray(regime) ? regime : [regime];
    const runs = allRunsFlat.filter((r) =>
      regimes.includes(r.regime as Regime),
    );
    return {
      n: runs.length,
      medianDuration: median(runs.map((r) => r.durationMinutes)),
      medianEventCount: median(runs.map((r) => r.eventCount)),
      medianMaxSingleEvent: median(runs.map((r) => r.maxSingleEventUsd)),
      medianTotalUsd: median(runs.map((r) => r.totalUsd)),
    };
  }
  const extremeStats = regimeRunStats("extreme/shock");
  const medLargeStats = regimeRunStats(["medium", "large"]);
  console.log(
    "EXTREME/SHOCK   (n=" +
      extremeStats.n +
      "): medianDuration=" +
      extremeStats.medianDuration +
      "min medianEventCount=" +
      extremeStats.medianEventCount +
      " medianMaxSingleEvent=" +
      fmtUsd(extremeStats.medianMaxSingleEvent ?? 0) +
      " medianTotalUsd=" +
      fmtUsd(extremeStats.medianTotalUsd ?? 0),
  );
  console.log(
    "MEDIUM+LARGE    (n=" +
      medLargeStats.n +
      "): medianDuration=" +
      medLargeStats.medianDuration +
      "min medianEventCount=" +
      medLargeStats.medianEventCount +
      " medianMaxSingleEvent=" +
      fmtUsd(medLargeStats.medianMaxSingleEvent ?? 0) +
      " medianTotalUsd=" +
      fmtUsd(medLargeStats.medianTotalUsd ?? 0),
  );

  console.log("\n" + "=".repeat(100));
  console.log(
    "REPRESENTATIVE EXAMPLES (minute-by-minute, weighted: 6 medium, 6 large, 3 extreme, 2 small)",
  );
  console.log("=".repeat(100));
  const exampleBudget: Record<Regime, number> = {
    medium: 6,
    large: 6,
    "extreme/shock": 3,
    "small/background": 2,
  };
  for (const regime of [
    "medium",
    "large",
    "extreme/shock",
    "small/background",
  ] as Regime[]) {
    const candidates = allPairs
      .filter((p) => p.run1.regime === regime)
      .sort((a, b) => b.run1.totalUsd - a.run1.totalUsd);
    const picks = candidates.slice(0, exampleBudget[regime]);
    picks.forEach((p, idx) => {
      console.log("\n" + "-".repeat(100));
      console.log(
        "[" +
          regime.toUpperCase() +
          " #" +
          (idx + 1) +
          "] " +
          p.symbol +
          " " +
          p.victim,
      );
      console.log("-".repeat(100));
      console.log(
        "Run1: " +
          fmtClock(p.run1.startTs) +
          " -> " +
          fmtClock(p.run1.endTs) +
          "  duration=" +
          p.run1.durationMinutes +
          "min  totalUsd=" +
          fmtUsd(p.run1.totalUsd) +
          " (p" +
          p.run1.magnitudePercentile.toFixed(0) +
          ")  eventCount=" +
          p.run1.eventCount +
          "  priceRange=[" +
          p.run1.minPrice +
          "," +
          p.run1.maxPrice +
          "]",
      );
      console.log("zero-gap: " + p.zeroGapMinutes + " minutes");
      console.log(
        "Run2: " +
          fmtClock(p.run2.startTs) +
          " -> " +
          fmtClock(p.run2.endTs) +
          "  duration=" +
          p.run2.durationMinutes +
          "min  totalUsd=" +
          fmtUsd(p.run2.totalUsd) +
          " (p" +
          p.run2.magnitudePercentile.toFixed(0) +
          ")  ratio=" +
          p.run2Ratio.toFixed(2) +
          "x  newTerritory=" +
          (p.run2NewTerritory ? "YES" : "NO") +
          "  priceRange=[" +
          p.run2.minPrice +
          "," +
          p.run2.maxPrice +
          "]",
      );
      if (p.run3)
        console.log(
          "zero-gap2: " +
            p.zeroGapMinutes2 +
            " minutes  Run3: " +
            fmtClock(p.run3.startTs) +
            " -> " +
            fmtClock(p.run3.endTs) +
            "  totalUsd=" +
            fmtUsd(p.run3.totalUsd) +
            " (p" +
            p.run3.magnitudePercentile.toFixed(0) +
            ")  newTerritory=" +
            (p.run3NewTerritory ? "YES" : "NO"),
        );

      const timeline = allTimelines[p.symbol][p.victim];
      const spanEnd =
        p.run3 && p.zeroGapMinutes2 !== null && p.zeroGapMinutes2 <= 30
          ? p.run3.endTs
          : p.run2.endTs;
      const rows = timeline.filter(
        (r) => r.minuteTs >= p.run1.startTs && r.minuteTs <= spanEnd,
      );
      console.log("\nminute-by-minute:");
      rows.forEach((r) =>
        console.log(
          "  " +
            fmtClock(r.minuteTs).slice(11) +
            "  n=" +
            String(r.eventCount).padStart(3) +
            "  " +
            fmtUsd(r.totalLiquidationUsd).padStart(10) +
            (r.eventCount > 0
              ? "  price[" +
                r.minLiquidationPrice +
                "-" +
                r.maxLiquidationPrice +
                "]"
              : ""),
        ),
      );
    });
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "active-run-sequence-research-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date(now).toISOString(), allRuns, allPairs },
      null,
      2,
    ),
  );
  console.log("\n\nFull data (every run, every pair): " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
