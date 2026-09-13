/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY research: correctly
 * reconstruct real historical liquidation episodes from
 * liquidation_raw_events, per symbol + victim side, using a
 * DATA-DRIVEN episode boundary -- never a fixed 1m/2m/5m constant.
 *
 * EPISODE-BOUNDARY DISCOVERY METHOD (stated explicitly, not hidden):
 *   For each symbol+side, collect every same-side inter-event gap
 *   over the window. Sort them, take log(gap+1) to handle the
 *   multi-order-of-magnitude spread, and find the single LARGEST jump
 *   between consecutive sorted log-gaps within the middle portion of
 *   the distribution (20th-98th percentile position, to avoid
 *   trivially picking either extreme edge). That jump marks the
 *   natural separation between "gaps that occur WITHIN a cascade" and
 *   "gaps that separate one cascade from the next" for THIS
 *   symbol+side specifically. This is a standard 1D "elbow"/natural-
 *   break technique -- not an ML model, not a guessed constant.
 *
 * CAUSALITY (reused, validated in the prior two passes, not
 * reinvented): running extreme only, reset to zero every time a new,
 * deeper extreme forms; ATR/UNIT frozen at each episode's own start;
 * no future-final-extreme leakage; sanity counters printed.
 *
 * RECENCY WEIGHTING: exponential decay, disclosed half-life of 24h
 * (weight = 0.5^(ageHours/24)). This is a stated research choice for
 * HOW MUCH TO WEIGHT recent data, not a proposed production
 * threshold -- the actual recovery boundary itself is never
 * hard-coded here.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. No production recommendation is made -- this solves the
 * episode-grouping problem only, as requested.
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
const RECENCY_HALF_LIFE_HOURS = 24; // disclosed research choice, not a production threshold
const MIN_GAPS_FOR_ELBOW = 15;
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
function fmtDur(ms: number) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(0) + "s";
  if (s < 3600) return (s / 60).toFixed(1) + "m";
  return (s / 3600).toFixed(2) + "h";
}
function fmtClock(ms: number) {
  return new Date(ms).toISOString().slice(11, 19) + "Z";
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
/** Weighted percentile: sort (value, weight) pairs by value, walk
 *  cumulative weight fraction, return the value where the target
 *  fraction is first reached. */
function weightedPercentile(
  pairs: { v: number; w: number }[],
  p: number,
): number | null {
  const s = [...pairs]
    .filter((x) => Number.isFinite(x.v))
    .sort((a, b) => a.v - b.v);
  if (!s.length) return null;
  const totalW = s.reduce((sum, x) => sum + x.w, 0);
  if (totalW <= 0) return null;
  let cum = 0;
  const target = (p / 100) * totalW;
  for (const item of s) {
    cum += item.w;
    if (cum >= target) return item.v;
  }
  return s[s.length - 1].v;
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

/** Finds the largest jump in the sorted, log-transformed gap array,
 *  restricted to the [20th, 98th] percentile INDEX range so the edges
 *  of the distribution can't trivially "win". Returns the gap value
 *  (ms) that should separate within-episode gaps from between-episode
 *  gaps for this symbol+side, plus the diagnostic jump size itself so
 *  the strength of the natural separation is visible (a tiny jump
 *  means the data doesn't show a clean bimodal split at all). */
function findNaturalGapThreshold(gapsMs: number[]): {
  thresholdMs: number | null;
  jumpSize: number | null;
  sampleSize: number;
} {
  const gaps = sortNum(gapsMs);
  if (gaps.length < MIN_GAPS_FOR_ELBOW)
    return { thresholdMs: null, jumpSize: null, sampleSize: gaps.length };
  const logGaps = gaps.map((g) => Math.log(g + 1));
  const loIdx = Math.floor(0.2 * (logGaps.length - 1));
  const hiIdx = Math.ceil(0.98 * (logGaps.length - 1));
  let bestJump = -Infinity,
    bestIdx = -1;
  for (let i = loIdx; i < hiIdx; i++) {
    const jump = logGaps[i + 1] - logGaps[i];
    if (jump > bestJump) {
      bestJump = jump;
      bestIdx = i;
    }
  }
  if (bestIdx === -1)
    return { thresholdMs: null, jumpSize: null, sampleSize: gaps.length };
  return {
    thresholdMs: gaps[bestIdx],
    jumpSize: bestJump,
    sampleSize: gaps.length,
  };
}

interface Episode {
  symbol: string;
  victim: "LONG" | "SHORT";
  start: number;
  end: number;
  eventCount: number;
  totalLiqUsd: number;
  maxEvent: number;
  liveP95AtStart: number | null;
  maxEventOverP95: number | null;
  extremePrice: number;
  extremeTs: number;
  anchorPrice: number | null;
  extensionAtr: number | null;
  atrFrozen: number | null;
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

  const outAllEpisodes: Record<
    string,
    Record<"LONG" | "SHORT", Episode[]>
  > = {};
  const outThresholds: Record<string, Record<"LONG" | "SHORT", any>> = {};
  const outRecovery: Record<string, Record<"LONG" | "SHORT", any>> = {};
  let globalNegativeDelayCount = 0;

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    outAllEpisodes[symbol] = { LONG: [], SHORT: [] };
    outThresholds[symbol] = { LONG: null, SHORT: null };
    outRecovery[symbol] = { LONG: null, SHORT: null };

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
    function currentP95(atMs: number): number | null {
      const ringUpToStart = [...preSeed, ...windowEvents]
        .filter((e) => e.timestamp < atMs)
        .slice(-SAMPLE_CAPACITY)
        .map((e) => e.quoteQty);
      if (ringUpToStart.length < MIN_SAMPLES_FOR_PERCENTILES) return null;
      return rawPercentile(
        [...ringUpToStart].sort((a, b) => a - b),
        95,
      );
    }

    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEvents = windowEvents.filter((e) => e.victim === victim);
      if (sideEvents.length < 2) {
        console.log(
          "  " +
            victim +
            ": too few events (n=" +
            sideEvents.length +
            ") to analyze gaps at all.",
        );
        continue;
      }

      const gaps: number[] = [];
      for (let i = 1; i < sideEvents.length; i++)
        gaps.push(sideEvents[i].timestamp - sideEvents[i - 1].timestamp);
      const { thresholdMs, jumpSize, sampleSize } =
        findNaturalGapThreshold(gaps);

      console.log(
        "  " +
          victim +
          ": " +
          sideEvents.length +
          " events, " +
          gaps.length +
          " gaps.",
      );
      if (thresholdMs === null) {
        console.log(
          "    INSUFFICIENT_SAMPLE for natural-gap discovery (need >= " +
            MIN_GAPS_FOR_ELBOW +
            " gaps, have " +
            sampleSize +
            ").",
        );
        outThresholds[symbol][victim] = "INSUFFICIENT_SAMPLE";
        continue;
      }
      console.log(
        "    natural gap threshold = " +
          fmtDur(thresholdMs) +
          " (largest log-gap jump = " +
          jumpSize!.toFixed(2) +
          " -- " +
          (jumpSize! > 1.5
            ? "STRONG natural separation"
            : jumpSize! > 0.7
              ? "moderate separation"
              : "WEAK -- gap distribution does not show a clean bimodal split for this symbol+side") +
          ")",
      );
      outThresholds[symbol][victim] = { thresholdMs, jumpSize, sampleSize };

      // ── Reconstruct episodes using the DATA-DERIVED threshold for THIS symbol+side ──
      const episodes: Episode[] = [];
      let cur: any[] = [sideEvents[0]];
      for (let i = 1; i < sideEvents.length; i++) {
        if (
          sideEvents[i].timestamp - sideEvents[i - 1].timestamp >
          thresholdMs
        ) {
          episodes.push(buildEpisode(cur));
          cur = [sideEvents[i]];
        } else cur.push(sideEvents[i]);
      }
      episodes.push(buildEpisode(cur));

      function buildEpisode(evs: any[]): Episode {
        const start = evs[0].timestamp,
          end = evs[evs.length - 1].timestamp;
        const totalLiqUsd = evs.reduce(
          (s: number, e: any) => s + e.quoteQty,
          0,
        );
        const maxEvent = Math.max(...evs.map((e: any) => e.quoteQty));
        const p95 = currentP95(start);
        let extremePrice: number | null = null,
          extremeTs: number | null = null;
        for (
          let t = Math.floor((start - 60000) / 60000) * 60000;
          t <= end + 60000;
          t += 60000
        ) {
          const c = candleAt(t);
          if (!c) continue;
          const v = victim === "LONG" ? c.low : c.high;
          if (
            extremePrice === null ||
            (victim === "LONG" ? v < extremePrice : v > extremePrice)
          ) {
            extremePrice = v;
            extremeTs = t;
          }
        }
        const atrFrozen = atrAt(start);
        const anchorPrice =
          candleAt(Math.max(start - 60000, windowStart - 60000))?.open ?? null;
        const extensionAtr =
          extremePrice !== null && anchorPrice !== null && atrFrozen
            ? Math.abs(anchorPrice - extremePrice) / atrFrozen
            : null;
        return {
          symbol,
          victim,
          start,
          end,
          eventCount: evs.length,
          totalLiqUsd,
          maxEvent,
          liveP95AtStart: p95,
          maxEventOverP95: p95 ? maxEvent / p95 : null,
          extremePrice: extremePrice ?? evs[0].price,
          extremeTs: extremeTs ?? start,
          anchorPrice,
          extensionAtr,
          atrFrozen,
        };
      }

      outAllEpisodes[symbol][victim] = episodes;
      console.log("    reconstructed " + episodes.length + " episodes.");

      // ── Recovery between CONSECUTIVE episodes, causal, reset-on-new-extreme (validated methodology) ──
      const recoveryObs: {
        recoveryAtr: number;
        ageHours: number;
        nextEpisodeNewExtreme: boolean;
        nextEpisodeIdx: number;
        thisEpisodeIdx: number;
      }[] = [];
      for (let i = 0; i < episodes.length - 1; i++) {
        const e1 = episodes[i],
          e2 = episodes[i + 1];
        if (e1.atrFrozen === null || e1.atrFrozen <= 0) continue;

        let runningExtreme: number | null = null,
          runningExtremeTs: number | null = null;
        let maxRecoveryAtr = -Infinity,
          maxRecoveryTs = e1.start;
        for (
          let t = Math.floor(e1.start / 60000) * 60000;
          t <= e2.start;
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
            maxRecoveryAtr = -Infinity;
            maxRecoveryTs = t; // reset on new extreme
          }
          const recoveryUsd =
            victim === "LONG"
              ? c.close - runningExtreme
              : runningExtreme - c.close;
          const recoveryAtr = recoveryUsd / e1.atrFrozen;
          if (recoveryAtr > maxRecoveryAtr) {
            maxRecoveryAtr = recoveryAtr;
            maxRecoveryTs = t;
          }
        }
        if (runningExtreme === null || runningExtremeTs === null) continue;
        if (e2.start - e1.end < 0 || maxRecoveryTs < runningExtremeTs) {
          globalNegativeDelayCount++;
          continue;
        }

        const newExtreme =
          runningExtreme !== e1.extremePrice
            ? victim === "LONG"
              ? runningExtreme < e1.extremePrice
              : runningExtreme > e1.extremePrice
            : false;
        const ageHours = (now - e1.start) / 3600000;
        recoveryObs.push({
          recoveryAtr: maxRecoveryAtr,
          ageHours,
          nextEpisodeNewExtreme: newExtreme,
          nextEpisodeIdx: i + 1,
          thisEpisodeIdx: i,
        });

        // enrich the printed episode with next-episode/recovery info directly (matches the requested print format)
        (e1 as any).maxRecoveryAfterAtr = maxRecoveryAtr;
        (e1 as any).nextEpisodeStart = e2.start;
        (e1 as any).nextEpisodeNewExtreme = newExtreme;
      }

      if (recoveryObs.length > 0) {
        const halfLifeLambda = Math.log(2) / RECENCY_HALF_LIFE_HOURS;
        const weighted = recoveryObs.map((o) => ({
          v: o.recoveryAtr,
          w: Math.exp(-halfLifeLambda * o.ageHours),
        }));
        const dist = {
          n: recoveryObs.length,
          unweighted: {
            p25: percentile(
              recoveryObs.map((o) => o.recoveryAtr),
              25,
            ),
            median: median(recoveryObs.map((o) => o.recoveryAtr)),
            p75: percentile(
              recoveryObs.map((o) => o.recoveryAtr),
              75,
            ),
            p90: percentile(
              recoveryObs.map((o) => o.recoveryAtr),
              90,
            ),
          },
          recencyWeighted: {
            p25: weightedPercentile(weighted, 25),
            median: weightedPercentile(weighted, 50),
            p75: weightedPercentile(weighted, 75),
            p90: weightedPercentile(weighted, 90),
          },
          secondEpisodeNewExtremePct:
            (recoveryObs.filter((o) => o.nextEpisodeNewExtreme).length /
              recoveryObs.length) *
            100,
        };
        outRecovery[symbol][victim] = dist;
        console.log(
          "    recovery-ATR between consecutive episodes (n=" + dist.n + "):",
        );
        console.log(
          "      unweighted:      p25=" +
            dist.unweighted.p25?.toFixed(3) +
            " median=" +
            dist.unweighted.median?.toFixed(3) +
            " p75=" +
            dist.unweighted.p75?.toFixed(3) +
            " p90=" +
            dist.unweighted.p90?.toFixed(3),
        );
        console.log(
          "      recency-weighted(24h half-life): p25=" +
            dist.recencyWeighted.p25?.toFixed(3) +
            " median=" +
            dist.recencyWeighted.median?.toFixed(3) +
            " p75=" +
            dist.recencyWeighted.p75?.toFixed(3) +
            " p90=" +
            dist.recencyWeighted.p90?.toFixed(3),
        );
        console.log(
          "      % of next-episodes that made a NEW directional extreme: " +
            fmtPct(dist.secondEpisodeNewExtremePct),
        );
      } else {
        console.log(
          "    no valid consecutive-episode pairs for recovery analysis (single episode only, or all pairs failed sanity).",
        );
      }
    }
    console.log("");
  }

  console.log("=".repeat(100));
  console.log(
    "SANITY: negativeDetectionDelayCount (should be 0) = " +
      globalNegativeDelayCount,
  );
  console.log("=".repeat(100));

  // ═══ Example print format, as requested ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "EXAMPLE EPISODE PRINTOUT (first symbol+side with >= 2 episodes)",
  );
  console.log("=".repeat(100));
  outer: for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const eps = outAllEpisodes[symbol]?.[victim];
      if (eps && eps.length >= 2) {
        console.log("\n" + symbol + " " + victim);
        eps.slice(0, 5).forEach((e, i) => {
          console.log("Episode #" + (i + 1) + ":");
          console.log("  start: " + fmtClock(e.start));
          console.log("  last liquidation pressure: " + fmtClock(e.end));
          console.log("  events: " + e.eventCount);
          console.log("  total liq: " + fmtUsd(e.totalLiqUsd));
          console.log(
            "  max event: " +
              fmtUsd(e.maxEvent) +
              (e.maxEventOverP95 !== null
                ? " (" + e.maxEventOverP95.toFixed(2) + "x live P95)"
                : ""),
          );
          console.log(
            "  price extreme: " +
              e.extremePrice +
              " @ " +
              fmtClock(e.extremeTs),
          );
          if ((e as any).maxRecoveryAfterAtr !== undefined) {
            console.log(
              "  maximum recovery after pressure: " +
                (e as any).maxRecoveryAfterAtr.toFixed(3) +
                " ATR",
            );
            console.log(
              "  next same-side episode: " +
                fmtClock((e as any).nextEpisodeStart) +
                " (new extreme: " +
                ((e as any).nextEpisodeNewExtreme ? "YES" : "NO") +
                ")",
            );
          } else {
            console.log("  no next same-side episode in this window yet.");
          }
        });
        break outer;
      }
    }
  }

  // ═══ Which symbol/sides commonly get a second wave ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "WHICH SYMBOL/SIDES COMMONLY HAVE A SECOND EPISODE (W2-like) VS USUALLY FINISH IN ONE",
  );
  console.log("=".repeat(100));
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const eps = outAllEpisodes[symbol]?.[victim];
      const rec = outRecovery[symbol]?.[victim];
      if (!eps || eps.length < 2 || !rec) continue;
      const secondWaveRate = (rec.n / (eps.length - 1)) * 100; // basically 100% by construction of pairs, so report new-extreme rate instead as the meaningful signal
      console.log(
        symbol +
          " " +
          victim +
          ": " +
          eps.length +
          " episodes total, " +
          fmtPct(rec.secondEpisodeNewExtremePct) +
          " of transitions produced a NEW extreme on the next episode (higher = more prone to a real second wave).",
      );
    }
  }

  const outPath = path.join(
    OUTPUT_DIR,
    "episode-reconstruction-natural-gap-" + Date.now() + ".json",
  );
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        recencyHalfLifeHours: RECENCY_HALF_LIFE_HOURS,
        outThresholds,
        outRecovery,
        outAllEpisodes,
        sanity: { globalNegativeDelayCount },
      },
      null,
      2,
    ),
  );
  console.log("\nFull data (every reconstructed episode): " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
