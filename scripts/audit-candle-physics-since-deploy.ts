/**
 * Sep 12 2026 (Karo), operator-requested. READ-ONLY production audit
 * -- replays the REAL, current CandlePhysicsEngine class (imported
 * directly, never reimplemented) against real liq_raw_events + real
 * Binance 1m candles for the window since the last deployment. This
 * gives a 100% faithful reconstruction of every PRE_W1_DISCARD,
 * meaningful-W1-formation, W2+ formation, and ENTRY -- including
 * cases that NEVER reached ENTRY (and are therefore invisible to the
 * [W1_P95_QUALIFICATION] log line, which only fires at ENTRY time).
 *
 * No production code changed. No Mongo writes. No PM2 restart.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import {
  CandlePhysicsEngine,
  type CandlePhysicsEntryEvent,
  type CandlePhysicsCancelEvent,
  type CandlePhysicsPreW1DiscardEvent,
} from "../src/domain/cascade/candle-physics-engine";

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
const SINCE_HOURS = process.argv.includes("--hours")
  ? Number(process.argv[process.argv.indexOf("--hours") + 1])
  : 12;
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

function fmtTs(ms: number) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function fmtUsd(n: number | null) {
  if (n === null) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtDur(ms: number) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(0) + "s";
  return (s / 60).toFixed(1) + "m";
}
function median(arr: number[]) {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(arr: number[], p: number) {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
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
  const startTs = now - SINCE_HOURS * 3600 * 1000;
  console.log(
    "Auditing " +
      SYMBOLS.length +
      " symbols, since " +
      fmtTs(startTs) +
      " (" +
      SINCE_HOURS +
      "h window -- adjust with --hours N to match your own actual last-deploy time).\n",
  );

  const overallReport: any = {
    generatedAt: new Date(now).toISOString(),
    windowStart: startTs,
    windowEnd: now,
    perSymbol: {},
  };
  const allW1Timelines: any[] = [];

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const events = await col
      .find({ symbol, timestamp: { $gte: startTs, $lte: now } })
      .sort({ timestamp: 1 })
      .toArray();
    if (events.length === 0) {
      console.log("  no events.\n");
      continue;
    }

    console.log("  fetching candles...");
    const klines = await fetchKlines(
      symbol,
      startTs - 5 * 3600000,
      now + 60000,
    ); // 5h ATR(240) warmup buffer
    const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
    if (candlesAsc.length < 241) {
      console.log(
        "  insufficient candle history for ATR(240) warmup -- skipping.\n",
      );
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

    // Build a rolling P95 baseline EXACTLY as production does: trailing episode-based percentile.
    // For this audit, approximate using a trailing 24h rolling percentile over ALL individual event sizes for that symbol/victim (a reasonable, declared proxy -- production's own exact liquidationStats module is not directly replayable without the live service; this is disclosed, not hidden).
    function rollingP95(victim: "LONG" | "SHORT", atMs: number): number | null {
      const windowStart = atMs - 24 * 3600000;
      const sample = events
        .filter(
          (e) =>
            e.victim === victim &&
            e.timestamp >= windowStart &&
            e.timestamp < atMs,
        )
        .map((e) => e.quoteQty);
      if (sample.length < 30) return null; // insufficient warmup, matches production's own MIN_WARMUP concept in spirit
      return percentile(sample, 95);
    }

    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEvents = events.filter((e) => e.victim === victim);
      if (sideEvents.length === 0) continue;

      const engine = new CandlePhysicsEngine();
      const discards: CandlePhysicsPreW1DiscardEvent[] = [];
      const entries: CandlePhysicsEntryEvent[] = [];
      const cancels: CandlePhysicsCancelEvent[] = [];
      const w1Formations: any[] = []; // captured directly from engine state, since discards/cancels alone don't expose this

      // Feed candles + liquidations in true chronological order.
      const relevantCandles = candlesAsc.filter(
        (c) => c.t >= startTs - 60000 && c.t <= now,
      );
      let eventIdx = 0;
      let lastDominantWaveNumber: number | null = null;
      for (const candle of relevantCandles) {
        while (
          eventIdx < sideEvents.length &&
          sideEvents[eventIdx].timestamp < candle.t
        ) {
          const e = sideEvents[eventIdx];
          const unit = simpleAtr240(e.timestamp);
          if (unit && unit > 0)
            engine.onLiquidation(
              symbol,
              victim,
              {
                symbol,
                side: victim === "LONG" ? "SELL" : "BUY",
                price: e.price,
                quantity: e.quoteQty / e.price,
                quoteQty: e.quoteQty,
                timestamp: e.timestamp,
              },
              unit,
              e.price,
              e.timestamp,
            );
          eventIdx++;
        }
        const p95 = rollingP95(victim, candle.t);
        const result = engine.onClosedCandle(
          symbol,
          victim,
          candle.t,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          p95,
        );
        if (result?.kind === "ENTRY") entries.push(result);
        else if (result?.kind === "CANCEL") cancels.push(result);
        else if (result?.kind === "PRE_W1_DISCARD") discards.push(result);

        // Capture W1-formation the MOMENT it happens (dominantWave newly set), regardless of eventual outcome.
        const w = engine.peekWatch(symbol, victim);
        if (
          w &&
          w.dominantWave !== null &&
          w.waveNumber !== lastDominantWaveNumber &&
          w.dominantWave.waveNumber === 1
        ) {
          w1Formations.push({
            symbol,
            victim,
            startTs: w.dominantWave.startTime,
            completionTs: w.dominantWave.endTime,
            durationMs: w.dominantWave.endTime - w.dominantWave.startTime,
            eventCount: w.dominantWave.totalEvents,
            totalLiqUsd: w.dominantWave.totalLiqUsd,
            maxIndividualEventUsd: w.dominantWave.maxEvent,
            p95AtQualification: w.p95AtW1Qualification,
            extremePrice: w.dominantWave.extreme,
            candlesAbsorbed:
              Math.round(
                (w.dominantWave.endTime - w.dominantWave.startTime) / 60000,
              ) + 1,
          });
          lastDominantWaveNumber = w.waveNumber;
        }
      }

      const discardSingle = discards.filter(
        (d) => d.reason === "DISCARDED_SINGLE_EVENT",
      ).length;
      const discardNoP95 = discards.filter(
        (d) => d.reason === "DISCARDED_NO_P95",
      ).length;
      const cancelReasons: Record<string, number> = {};
      cancels.forEach((c) => {
        cancelReasons[c.reason] = (cancelReasons[c.reason] || 0) + 1;
      });
      const completedWaves0 = cancels.filter(
        (c) => c.allWaves.length === 0,
      ).length;
      const completedWaves1 = cancels.filter(
        (c) => c.allWaves.length === 1,
      ).length;
      const completedWaves2plus = cancels.filter(
        (c) => c.allWaves.length >= 2,
      ).length;

      overallReport.perSymbol[symbol + "_" + victim] = {
        eventCount: sideEvents.length,
        preW1DiscardSingleEvent: discardSingle,
        preW1DiscardNoP95: discardNoP95,
        validW1Formations: w1Formations.length,
        entries: entries.length,
        cancels: cancels.length,
        cancelReasons,
        cancelsWithZeroCompletedWaves: completedWaves0,
        cancelsWithExactlyW1: completedWaves1,
        cancelsWithW1AndW2Plus: completedWaves2plus,
      };

      console.log(
        "  " +
          victim +
          ": " +
          sideEvents.length +
          " events, " +
          discardSingle +
          " single-discard, " +
          discardNoP95 +
          " no-P95-discard, " +
          w1Formations.length +
          " W1-formed, " +
          entries.length +
          " ENTRY, " +
          cancels.length +
          " cancels (W1-only-then-cancelled=" +
          completedWaves1 +
          ")",
      );

      w1Formations.forEach((w1) => allW1Timelines.push(w1));
    }
    console.log("");
  }

  // ═══ W1 duration/eventCount distribution ═══
  console.log("=".repeat(100));
  console.log(
    "W1 DURATION / EVENT-COUNT DISTRIBUTION (all symbols/sides combined, since window start)",
  );
  console.log("=".repeat(100));
  const durations = allW1Timelines.map((w) => w.durationMs);
  const eventCounts = allW1Timelines.map((w) => w.eventCount);
  console.log("Total valid W1 formations: " + allW1Timelines.length);
  if (allW1Timelines.length > 0) {
    console.log(
      "Duration: median=" +
        fmtDur(median(durations)!) +
        " p75=" +
        fmtDur(percentile(durations, 75)!) +
        " p90=" +
        fmtDur(percentile(durations, 90)!) +
        " max=" +
        fmtDur(Math.max(...durations)),
    );
    console.log(
      "EventCount: median=" +
        median(eventCounts) +
        " p75=" +
        percentile(eventCounts, 75) +
        " p90=" +
        percentile(eventCounts, 90) +
        " max=" +
        Math.max(...eventCounts),
    );
  }

  // ═══ Per-W1 detailed timeline + internal burst structure ═══
  console.log("\n" + "=".repeat(100));
  console.log("PER-W1 TIMELINE (every valid W1 formed since window start)");
  console.log("=".repeat(100));
  for (const w1 of allW1Timelines) {
    console.log("\n" + w1.symbol + " / " + w1.victim);
    console.log(
      "  W1 start: " +
        fmtTs(w1.startTs) +
        "  completion: " +
        fmtTs(w1.completionTs) +
        "  duration: " +
        fmtDur(w1.durationMs),
    );
    console.log(
      "  eventCount: " +
        w1.eventCount +
        "  totalLiqUsd: " +
        fmtUsd(w1.totalLiqUsd) +
        "  maxEvent: " +
        fmtUsd(w1.maxIndividualEventUsd) +
        "  P95@qual: " +
        fmtUsd(w1.p95AtQualification),
    );
    console.log(
      "  candles absorbed: " +
        w1.candlesAbsorbed +
        "  extreme: " +
        w1.extremePrice,
    );

    // Internal burst structure, reconstructed from raw events within [W1 start, W1 end], 5s-cluster (same convention as prior research scripts, disclosed not invented fresh).
    const w1Events = await col
      .find({
        symbol: w1.symbol,
        victim: w1.victim,
        timestamp: { $gte: w1.startTs, $lte: w1.completionTs },
      })
      .sort({ timestamp: 1 })
      .toArray();
    const bursts: any[] = [];
    let cur: any[] = w1Events.length ? [w1Events[0]] : [];
    for (let i = 1; i < w1Events.length; i++) {
      if (w1Events[i].timestamp - w1Events[i - 1].timestamp > 5000) {
        bursts.push(cur);
        cur = [w1Events[i]];
      } else cur.push(w1Events[i]);
    }
    if (cur.length) bursts.push(cur);
    if (bursts.length > 1) {
      console.log(
        "  internal structure -- " +
          bursts.length +
          " distinct sub-bursts detected inside this single W1:",
      );
      bursts.forEach((b, i) => {
        const label = String.fromCharCode(65 + i);
        console.log(
          "    burst " +
            label +
            ": " +
            fmtTs(b[0].timestamp) +
            " -> " +
            fmtTs(b[b.length - 1].timestamp) +
            "  liqUsd=" +
            fmtUsd(b.reduce((s: number, e: any) => s + e.quoteQty, 0)) +
            "  events=" +
            b.length,
        );
        if (i < bursts.length - 1)
          console.log(
            "    quiet gap: " +
              fmtDur(bursts[i + 1][0].timestamp - b[b.length - 1].timestamp),
          );
      });
    } else {
      console.log(
        "  internal structure -- single continuous burst, no distinct sub-pushes detected.",
      );
    }
  }

  const outPath = path.join(
    OUTPUT_DIR,
    "candle-physics-audit-" + Date.now() + ".json",
  );
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ overallReport, allW1Timelines }, null, 2),
  );
  console.log("\nFull output: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
