/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY research: a pure,
 * continuous 1-minute liquidation timeline for every symbol+victim
 * over the full 72h window -- zero-filled, no episode grouping, no
 * candle/ATR data, no recovery thresholds, no gap rules. This exists
 * purely to expose the raw liquidation structure before any grouping
 * decision is made.
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
const TOP_WINDOWS_TO_PRINT = 6;
const WINDOW_MINUTES = 45; // within the requested 30-60 range

function fmtUsd(n: number) {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtClock(ms: number) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
function sortNum(a: number[]) {
  return [...a]
    .filter((x) => x !== null && x !== undefined && !isNaN(x))
    .sort((x, y) => x - y);
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

interface MinuteRow {
  minuteTs: number;
  symbol: string;
  victim: "LONG" | "SHORT";
  eventCount: number;
  totalLiquidationUsd: number;
  maxSingleEventUsd: number;
  firstLiquidationPrice: number | null;
  lastLiquidationPrice: number | null;
  minLiquidationPrice: number | null;
  maxLiquidationPrice: number | null;
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
  const windowEndMinute = Math.floor(now / 60000) * 60000;
  const totalMinutes = Math.round((windowEndMinute - windowStart) / 60000) + 1;
  console.log(
    "Building strict 1-minute timeline: " +
      fmtClock(windowStart) +
      " -> " +
      fmtClock(windowEndMinute) +
      " (" +
      totalMinutes +
      " minutes per symbol+victim)\n",
  );

  const csvRows: string[] = [
    "minuteTs,minuteIso,symbol,victim,eventCount,totalLiquidationUsd,maxSingleEventUsd,firstLiquidationPrice,lastLiquidationPrice,minLiquidationPrice,maxLiquidationPrice",
  ];
  const allTimelines: Record<
    string,
    Record<"LONG" | "SHORT", MinuteRow[]>
  > = {};

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const events = await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: now } })
      .sort({ timestamp: 1 })
      .toArray();
    allTimelines[symbol] = { LONG: [], SHORT: [] };

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
        if (!evs || evs.length === 0) {
          timeline.push({
            minuteTs: t,
            symbol,
            victim,
            eventCount: 0,
            totalLiquidationUsd: 0,
            maxSingleEventUsd: 0,
            firstLiquidationPrice: null,
            lastLiquidationPrice: null,
            minLiquidationPrice: null,
            maxLiquidationPrice: null,
          });
        } else {
          const prices = evs.map((e) => e.price);
          timeline.push({
            minuteTs: t,
            symbol,
            victim,
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

      for (const r of timeline) {
        csvRows.push(
          [
            r.minuteTs,
            new Date(r.minuteTs).toISOString(),
            r.symbol,
            r.victim,
            r.eventCount,
            r.totalLiquidationUsd.toFixed(2),
            r.maxSingleEventUsd.toFixed(2),
            r.firstLiquidationPrice ?? "",
            r.lastLiquidationPrice ?? "",
            r.minLiquidationPrice ?? "",
            r.maxLiquidationPrice ?? "",
          ].join(","),
        );
      }

      const activeMinutes = timeline.filter((r) => r.eventCount > 0);
      console.log(
        "  " +
          victim +
          ": " +
          activeMinutes.length +
          "/" +
          timeline.length +
          " active minutes (" +
          ((activeMinutes.length / timeline.length) * 100).toFixed(1) +
          "%)",
      );
    }
  }

  // ═══ Distributions ═══
  console.log("\n" + "=".repeat(100));
  console.log("DISTRIBUTIONS PER SYMBOL + VICTIM");
  console.log("=".repeat(100));

  const distResults: any = {};
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const timeline = allTimelines[symbol][victim];
      const activeMinutes = timeline.filter((r) => r.eventCount > 0);
      if (activeMinutes.length === 0) {
        console.log(
          "\n" + symbol + " " + victim + ": no active minutes at all.",
        );
        continue;
      }

      const usdVals = sortNum(activeMinutes.map((r) => r.totalLiquidationUsd));
      const eventCountVals = sortNum(activeMinutes.map((r) => r.eventCount));

      const runLengths: number[] = [];
      let curRun = 0;
      for (const r of timeline) {
        if (r.eventCount > 0) curRun++;
        else {
          if (curRun > 0) runLengths.push(curRun);
          curRun = 0;
        }
      }
      if (curRun > 0) runLengths.push(curRun);

      const gapLengths: number[] = [];
      let curGap = 0;
      let seenActive = false;
      for (const r of timeline) {
        if (r.eventCount === 0) {
          if (seenActive) curGap++;
        } else {
          if (curGap > 0) gapLengths.push(curGap);
          curGap = 0;
          seenActive = true;
        }
      }

      const pcts = [10, 25, 50, 75, 90, 95, 99];
      function distLine(vals: number[]) {
        const s = sortNum(vals);
        return Object.fromEntries(pcts.map((p) => ["p" + p, percentile(s, p)]));
      }

      const key = symbol + "_" + victim;
      distResults[key] = {
        activeMinutes: activeMinutes.length,
        totalMinutes: timeline.length,
        activeMinuteUsdDist: distLine(usdVals),
        eventCountPerActiveMinuteDist: distLine(eventCountVals),
        consecutiveActiveRunDist: distLine(runLengths),
        zeroGapBetweenRunsDist: distLine(gapLengths),
        runCount: runLengths.length,
        gapCount: gapLengths.length,
      };

      console.log(
        "\n" +
          key +
          " (n_active=" +
          activeMinutes.length +
          "/" +
          timeline.length +
          "):",
      );
      console.log(
        "  active-minute totalUSD:      " +
          Object.entries(distResults[key].activeMinuteUsdDist)
            .map(
              ([k, v]) => k + "=" + (v !== null ? fmtUsd(v as number) : "n/a"),
            )
            .join(" "),
      );
      console.log(
        "  eventCount per active minute: " +
          Object.entries(distResults[key].eventCountPerActiveMinuteDist)
            .map(
              ([k, v]) =>
                k + "=" + (v !== null ? (v as number).toFixed(1) : "n/a"),
            )
            .join(" "),
      );
      console.log(
        "  consecutive active-minute runs (n=" +
          runLengths.length +
          "): " +
          Object.entries(distResults[key].consecutiveActiveRunDist)
            .map(
              ([k, v]) =>
                k +
                "=" +
                (v !== null ? (v as number).toFixed(1) + "min" : "n/a"),
            )
            .join(" "),
      );
      console.log(
        "  zero-minute gaps between runs (n=" +
          gapLengths.length +
          "):  " +
          Object.entries(distResults[key].zeroGapBetweenRunsDist)
            .map(
              ([k, v]) =>
                k +
                "=" +
                (v !== null ? (v as number).toFixed(1) + "min" : "n/a"),
            )
            .join(" "),
      );
    }
  }

  // ═══ Top windows around strongest liquidation periods ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "TOP " +
      TOP_WINDOWS_TO_PRINT +
      " STRONGEST " +
      WINDOW_MINUTES +
      "-MINUTE WINDOWS (rolling sum of totalLiquidationUsd), minute-by-minute including zeros",
  );
  console.log("=".repeat(100));

  interface WindowCandidate {
    symbol: string;
    victim: "LONG" | "SHORT";
    startIdx: number;
    sumUsd: number;
  }
  const candidates: WindowCandidate[] = [];
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const timeline = allTimelines[symbol][victim];
      if (timeline.length < WINDOW_MINUTES) continue;
      const prefix = new Array(timeline.length + 1).fill(0);
      for (let i = 0; i < timeline.length; i++)
        prefix[i + 1] = prefix[i] + timeline[i].totalLiquidationUsd;
      let bestSum = -1,
        bestIdx = -1;
      for (let i = 0; i + WINDOW_MINUTES <= timeline.length; i++) {
        const sum = prefix[i + WINDOW_MINUTES] - prefix[i];
        if (sum > bestSum) {
          bestSum = sum;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0)
        candidates.push({ symbol, victim, startIdx: bestIdx, sumUsd: bestSum });
    }
  }
  candidates.sort((a, b) => b.sumUsd - a.sumUsd);
  const topWindows = candidates.slice(0, TOP_WINDOWS_TO_PRINT);

  topWindows.forEach((w, idx) => {
    const timeline = allTimelines[w.symbol][w.victim];
    const windowRows = timeline.slice(w.startIdx, w.startIdx + WINDOW_MINUTES);
    console.log("\n" + "-".repeat(100));
    console.log(
      "WINDOW #" +
        (idx + 1) +
        "  " +
        w.symbol +
        " " +
        w.victim +
        "  total=" +
        fmtUsd(w.sumUsd) +
        "  " +
        fmtClock(windowRows[0].minuteTs) +
        " -> " +
        fmtClock(windowRows[windowRows.length - 1].minuteTs),
    );
    console.log("-".repeat(100));
    windowRows.forEach((r) => {
      const priceInfo =
        r.eventCount > 0
          ? "first=" +
            r.firstLiquidationPrice +
            " last=" +
            r.lastLiquidationPrice +
            " min=" +
            r.minLiquidationPrice +
            " max=" +
            r.maxLiquidationPrice
          : "";
      console.log(
        fmtClock(r.minuteTs).slice(11) +
          "  " +
          w.victim.padEnd(5) +
          " n=" +
          String(r.eventCount).padStart(3) +
          "  " +
          fmtUsd(r.totalLiquidationUsd).padStart(10) +
          "  maxEvent=" +
          fmtUsd(r.maxSingleEventUsd).padStart(10) +
          "  " +
          priceInfo,
      );
    });
  });

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const csvPath = path.join(
    OUTPUT_DIR,
    "minute-liquidation-timeline-" + Date.now() + ".csv",
  );
  fs.writeFileSync(csvPath, csvRows.join("\n"));
  const jsonPath = csvPath.replace(".csv", "-distributions.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        windowStart,
        windowEndMinute,
        totalMinutes,
        distResults,
        topWindows: topWindows.map((w) => ({
          symbol: w.symbol,
          victim: w.victim,
          sumUsd: w.sumUsd,
          startTs: allTimelines[w.symbol][w.victim][w.startIdx].minuteTs,
        })),
      },
      null,
      2,
    ),
  );

  console.log(
    "\n\nFull minute-by-minute CSV (" +
      (csvRows.length - 1) +
      " rows, every symbol+victim): " +
      csvPath,
  );
  console.log("Distributions + top-window summary JSON: " + jsonPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
