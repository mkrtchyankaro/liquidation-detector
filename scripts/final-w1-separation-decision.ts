/**
 * Sep 13 2026 (Karo), operator-requested FINAL decision script.
 *
 * Question: is current W1 completion too slow for BTC/BNB, and what
 * data-derived recovery boundary should separate W1 from a later W2?
 *
 * Methodology (carried over, validated, from the earlier causal-fix
 * pass -- NOT reinvented here):
 *   - "Meaningful P95-qualified push" = a 5s-clustered same-side raw
 *     liquidation burst with eventCount>=2 AND maxSingleEvent>=P95(at
 *     that moment). This is evaluated independently of the engine's
 *     own wave-merging (extreme-continuation) logic, specifically so
 *     the recovery-before-continuation distribution is NOT circular
 *     with the thing being tested (unlike a plain "current W1" reuse
 *     would be).
 *   - Recovery is tracked with a STRICT LIVE-CAUSAL running extreme,
 *     walked minute-by-minute from each push's own extreme forward,
 *     continuously updated (never frozen), exactly as fixed in the
 *     prior corrected research pass. A rule/threshold "fires" the
 *     FIRST time recovery reaches it -- never using future knowledge.
 *
 * P95 correction (per this task's own explicit instruction):
 *   - per SYMBOL, LONG+SHORT COMBINED, fixed 5000-event ring buffer,
 *     percentile of individual raw event notionals, min 30 samples.
 *   - The ring is PRE-SEEDED with up to 5000 real events immediately
 *     BEFORE the 72h window starts, so P95 at the start of the
 *     window already matches what production's own long-running ring
 *     would show -- never starts empty.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. This is the final research pass -- no further research
 * scripts are proposed after this one.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";

const SYMBOLS = ["BTCUSDT", "BNBUSDT"];
const HOURS = 72;
const SAMPLE_CAPACITY = 5000;
const MIN_SAMPLES_FOR_PERCENTILES = 30;
const BURST_CLUSTER_GAP_MS = 5000;
const RECOVERY_ATR_THRESHOLDS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const PCT_LIST = [25, 50, 60, 70, 75, 80, 90];
const MIN_PAIRS_FOR_TRUST = 10; // below this, INSUFFICIENT_SAMPLE instead of inventing a boundary
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

// The two named live examples to compare against history.
const NAMED_EXAMPLES = [
  {
    symbol: "BTCUSDT",
    victim: "LONG" as const,
    startIso: "2026-09-13T03:14:00Z",
    extreme: 77235.5,
  },
  {
    symbol: "BNBUSDT",
    victim: "SHORT" as const,
    startIso: "2026-09-13T03:25:00Z",
    extreme: 729.27,
  },
];

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
  extreme: number;
  extremeTs: number;
}
interface Pair {
  symbol: string;
  victim: "LONG" | "SHORT";
  push1Start: number;
  push1End: number;
  push1TotalUsd: number;
  push1MaxEvent: number;
  push1Extreme: number;
  push1ExtremeTs: number;
  atrFrozen: number;
  push2Start: number;
  push2TotalUsd: number;
  push2MaxEvent: number;
  push2LiqRatio: number;
  maxRecoveryAtr: number;
  maxRecoveryPct: number;
  maxRecoveryTs: number;
  timeUntilNextPushMs: number;
  push2NewExtreme: boolean;
  // causal crossing map: threshold -> { crossed: boolean, crossTs: number|null }
  thresholdCrossings: Record<
    number,
    { crossed: boolean; crossTs: number | null }
  >;
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

  const allPairs: Record<string, Record<"LONG" | "SHORT", Pair[]>> = {
    BTCUSDT: { LONG: [], SHORT: [] },
    BNBUSDT: { LONG: [], SHORT: [] },
  };
  const namedExampleResults: any[] = [];

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");

    // Pre-seed: fetch up to SAMPLE_CAPACITY events strictly BEFORE windowStart, plus the full window itself.
    const preSeed = await col
      .find({ symbol, timestamp: { $lt: windowStart } })
      .sort({ timestamp: -1 })
      .limit(SAMPLE_CAPACITY)
      .toArray();
    preSeed.reverse(); // chronological
    const windowEvents = await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: now } })
      .sort({ timestamp: 1 })
      .toArray();
    console.log(
      "  pre-seed events: " +
        preSeed.length +
        " (ring warm-start), window events: " +
        windowEvents.length,
    );

    const klines = await fetchKlines(
      symbol,
      windowStart - 5 * 3600000,
      now + 5 * 3600000,
    );
    const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
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

    // ── Build the P95 ring, pre-seeded, then replay forward through the window computing P95 AT EACH burst's own start. ──
    const ring: number[] = [];
    let ringIdx = 0;
    function ingest(notional: number) {
      if (ring.length < SAMPLE_CAPACITY) ring.push(notional);
      else {
        ring[ringIdx] = notional;
        ringIdx = (ringIdx + 1) % SAMPLE_CAPACITY;
      }
    }
    preSeed.forEach((e) => ingest(e.quoteQty));
    function currentP95(): number | null {
      if (ring.length < MIN_SAMPLES_FOR_PERCENTILES) return null;
      return rawPercentile(
        [...ring].sort((a, b) => a - b),
        95,
      );
    }

    // Walk window events chronologically (both sides interleaved, matching production's own single shared ring), computing P95 fresh at the START of every 5s-cluster burst.
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
        // P95 as of this burst's own START, using the ring state built from ALL events (both sides) up to that timestamp.
        const ringUpToStart = [...preSeed, ...windowEvents]
          .filter((e) => e.timestamp < b.start)
          .slice(-SAMPLE_CAPACITY)
          .map((e) => e.quoteQty);
        if (ringUpToStart.length < MIN_SAMPLES_FOR_PERCENTILES) continue;
        const p95 = rawPercentile(
          [...ringUpToStart].sort((x, y) => x - y),
          95,
        );
        if (b.count < 2 || b.maxEvent < p95) continue; // not "meaningful P95-qualified"

        // this push's own directional extreme within [start-1m, end+1m]
        let extreme: number | null = null,
          extremeTs: number | null = null;
        for (
          let t = Math.floor((b.start - 60000) / 60000) * 60000;
          t <= b.end + 60000;
          t += 60000
        ) {
          const c = candleAt(t);
          if (!c) continue;
          const v = victim === "LONG" ? c.low : c.high;
          if (
            extreme === null ||
            (victim === "LONG" ? v < extreme : v > extreme)
          ) {
            extreme = v;
            extremeTs = t;
          }
        }
        if (extreme === null) continue;
        pushesBySide[victim].push({
          symbol,
          victim,
          ...b,
          p95AtStart: p95,
          extreme,
          extremeTs: extremeTs!,
        });
      }
    }
    console.log(
      "  meaningful P95-qualified pushes: LONG=" +
        pushesBySide.LONG.length +
        " SHORT=" +
        pushesBySide.SHORT.length,
    );

    // ── Build Push1->Push2 pairs, with STRICT LIVE-CAUSAL running-extreme recovery tracking. ──
    for (const victim of ["LONG", "SHORT"] as const) {
      const pushes = pushesBySide[victim];
      for (let i = 0; i < pushes.length - 1; i++) {
        const p1 = pushes[i],
          p2 = pushes[i + 1];
        const atrFrozen = atrAt(p1.start);
        if (atrFrozen === null || atrFrozen <= 0) continue;

        let runningExtreme: number | null = null,
          runningExtremeTs: number | null = null;
        let maxRecoveryAtr = -Infinity,
          maxRecoveryTs = p1.start;
        const crossings: Record<
          number,
          { crossed: boolean; crossTs: number | null }
        > = {};
        RECOVERY_ATR_THRESHOLDS.forEach(
          (t) => (crossings[t] = { crossed: false, crossTs: null }),
        );

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
          for (const thr of RECOVERY_ATR_THRESHOLDS) {
            if (!crossings[thr].crossed && recoveryAtr >= thr) {
              crossings[thr] = { crossed: true, crossTs: t };
            }
          }
        }
        if (runningExtreme === null) continue;

        // push2's own extreme, vs runningExtreme at end -- new-extreme check
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
        const maxRecoveryPrice = candleAt(maxRecoveryTs)?.close ?? p1.extreme;
        const maxRecoveryPct =
          victim === "LONG"
            ? ((maxRecoveryPrice - runningExtreme) / runningExtreme) * 100
            : ((runningExtreme - maxRecoveryPrice) / runningExtreme) * 100;

        allPairs[symbol][victim].push({
          symbol,
          victim,
          push1Start: p1.start,
          push1End: p1.end,
          push1TotalUsd: p1.totalUsd,
          push1MaxEvent: p1.maxEvent,
          push1Extreme: runningExtreme,
          push1ExtremeTs: runningExtremeTs!,
          atrFrozen,
          push2Start: p2.start,
          push2TotalUsd: p2.totalUsd,
          push2MaxEvent: p2.maxEvent,
          push2LiqRatio: p1.totalUsd > 0 ? p2.totalUsd / p1.totalUsd : 0,
          maxRecoveryAtr,
          maxRecoveryPct,
          maxRecoveryTs,
          timeUntilNextPushMs: p2.start - p1.end,
          push2NewExtreme,
          thresholdCrossings: crossings,
        });
      }
    }
    console.log(
      "  pairs built: LONG=" +
        allPairs[symbol].LONG.length +
        " SHORT=" +
        allPairs[symbol].SHORT.length +
        "\n",
    );

    // ── Named-example comparison, using the SAME pushesBySide data for this symbol ──
    for (const ex of NAMED_EXAMPLES.filter((e) => e.symbol === symbol)) {
      const exStartTs = Date.parse(ex.startIso);
      const matchingPush = pushesBySide[ex.victim].find(
        (p) => Math.abs(p.start - exStartTs) < 5 * 60000,
      );
      if (!matchingPush) {
        namedExampleResults.push({
          ...ex,
          error:
            "No matching meaningful P95-qualified push found within +/-5min of the given start time in this dataset.",
        });
        continue;
      }
      const atrFrozen = atrAt(matchingPush.start);
      // Find the actual engine-completion point is out of scope here (would require the live engine replay); instead measure recovery reached AT the given extreme up to the NEXT meaningful push (or end of data).
      const pairForThis = allPairs[symbol][ex.victim].find(
        (p) => Math.abs(p.push1Start - matchingPush.start) < 1000,
      );
      namedExampleResults.push({
        ...ex,
        matchedPushStart: matchingPush.start,
        matchedPushExtreme: matchingPush.extreme,
        atrFrozen,
        maxRecoveryAtrBeforeNextPush: pairForThis?.maxRecoveryAtr ?? null,
        laterPushExists: !!pairForThis,
        laterPushNewExtreme: pairForThis?.push2NewExtreme ?? null,
      });
    }
  }

  // ═══ Core distributions ═══
  console.log("=".repeat(100));
  console.log(
    "RECOVERY-ATR DISTRIBUTION (before next meaningful same-side push)",
  );
  console.log("=".repeat(100));
  function distTable(pairs: Pair[]) {
    return Object.fromEntries(
      PCT_LIST.map((p) => [
        "p" + p,
        percentile(
          pairs.map((x) => x.maxRecoveryAtr),
          p,
        ),
      ]),
    );
  }
  const distributions: any = {};
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const pairs = allPairs[symbol][victim];
      distributions[symbol + "_" + victim] = {
        n: pairs.length,
        dist: pairs.length ? distTable(pairs) : null,
      };
      console.log(
        symbol +
          " " +
          victim +
          " (n=" +
          pairs.length +
          "): " +
          (pairs.length
            ? Object.entries(distTable(pairs))
                .map(([k, v]) => k + "=" + (v !== null ? v!.toFixed(3) : "n/a"))
                .join(" ")
            : "INSUFFICIENT_SAMPLE"),
      );
    }
  }

  // ═══ Threshold table (the key table) ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "THRESHOLD TABLE -- recovery reached -> probability of later push / new extreme",
  );
  console.log("=".repeat(100));
  const thresholdResults: any = {};
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const pairs = allPairs[symbol][victim];
      thresholdResults[symbol + "_" + victim] = {};
      console.log(
        "\n" + symbol + " " + victim + " (n=" + pairs.length + " pairs):",
      );
      if (pairs.length < MIN_PAIRS_FOR_TRUST) {
        console.log(
          "  INSUFFICIENT_SAMPLE (n=" +
            pairs.length +
            " < " +
            MIN_PAIRS_FOR_TRUST +
            ") -- threshold table not computed for this symbol+side.",
        );
        thresholdResults[symbol + "_" + victim] = "INSUFFICIENT_SAMPLE";
        continue;
      }
      for (const thr of RECOVERY_ATR_THRESHOLDS) {
        const crossed = pairs.filter((p) => p.thresholdCrossings[thr].crossed);
        const laterPushProb = pairs.length
          ? (crossed.length / pairs.length) * 100
          : null; // among ALL pairs, how many even reached this recovery before push2 (this IS "later push still occurs" framed causally: reaching T and THEN still having push2 arrive is exactly what "crossed" + "this pair exists" means)
        const newExtremeAmongCrossed = crossed.length
          ? (crossed.filter((p) => p.push2NewExtreme).length / crossed.length) *
            100
          : null;
        console.log(
          "  " +
            thr.toFixed(2) +
            " ATR: n_reached=" +
            crossed.length +
            "/" +
            pairs.length +
            " (" +
            fmtPct(laterPushProb) +
            ") | P(later push occurs before ANY recovery target used as an exit) -- see note | P(that later push makes NEW extreme | recovery reached this level first)=" +
            fmtPct(newExtremeAmongCrossed),
        );
        thresholdResults[symbol + "_" + victim][thr] = {
          casesReachingRecovery: crossed.length,
          totalPairs: pairs.length,
          probLaterPushOccursGivenRecoveryReached: laterPushProb,
          probNewExtremeGivenRecoveryReached: newExtremeAmongCrossed,
        };
      }
    }
  }
  console.log(
    "\nNOTE on interpretation: every pair here is, by construction, a Push1 that DID have a later same-side Push2 arrive (that is how pairs are formed). 'n_reached' therefore answers: among cascades that continued, what fraction had ALREADY recovered to at least this ATR level before that continuation arrived. The right-hand probability (P(new extreme | recovery reached)) is the one that matters for a live decision: if you wait until recovery reaches T and a later push then arrives, how likely is that later push actually dangerous (a new extreme) vs just noise.",
  );

  // ═══ Named example comparison ═══
  console.log("\n" + "=".repeat(100));
  console.log("NAMED EXAMPLE COMPARISON");
  console.log("=".repeat(100));
  for (const ex of namedExampleResults) {
    console.log(
      "\n" +
        ex.symbol +
        " " +
        ex.victim +
        " (given start " +
        ex.startIso +
        ", given extreme " +
        ex.extreme +
        "):",
    );
    if (ex.error) {
      console.log("  " + ex.error);
      continue;
    }
    const pairs = allPairs[ex.symbol][ex.victim as "LONG" | "SHORT"];
    const allRecoveries = pairs.map((p) => p.maxRecoveryAtr);
    const rank = allRecoveries.filter(
      (r) => r <= (ex.maxRecoveryAtrBeforeNextPush ?? -Infinity),
    ).length;
    const pctile = pairs.length ? (rank / pairs.length) * 100 : null;
    console.log(
      "  matched push extreme (reconstructed): " +
        ex.matchedPushExtreme +
        "  atrFrozen: " +
        ex.atrFrozen?.toFixed(4),
    );
    console.log(
      "  maxRecoveryATR reached before next meaningful push (or end of data): " +
        (ex.maxRecoveryAtrBeforeNextPush !== null
          ? ex.maxRecoveryAtrBeforeNextPush.toFixed(3)
          : "n/a (no later push in dataset yet)"),
    );
    console.log(
      "  historical percentile of that recovery for " +
        ex.symbol +
        " " +
        ex.victim +
        ": " +
        fmtPct(pctile) +
        " (n=" +
        pairs.length +
        ")",
    );
    console.log(
      "  a later meaningful push exists in this dataset: " +
        (ex.laterPushExists
          ? "YES"
          : "NO (still open / no later push yet within window)"),
    );
    if (ex.laterPushExists)
      console.log(
        "  that later push made a NEW directional extreme: " +
          (ex.laterPushNewExtreme ? "YES" : "NO"),
      );
  }

  // ═══ Recommended boundary per symbol+side ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "RECOMMENDED W1-SEPARATION BOUNDARY (smallest recoveryATR where P(new extreme | recovery reached) drops to a clearly low level)",
  );
  console.log("=".repeat(100));
  const LOW_PROB_CUTOFF = 20; // "clearly low" -- documented choice, not silently assumed
  const recommendations: Record<string, any> = {};
  for (const symbol of SYMBOLS) {
    for (const victim of ["LONG", "SHORT"] as const) {
      const key = symbol + "_" + victim;
      const t = thresholdResults[key];
      if (t === "INSUFFICIENT_SAMPLE") {
        console.log(key + ": INSUFFICIENT_SAMPLE");
        recommendations[key] = "INSUFFICIENT_SAMPLE";
        continue;
      }
      let chosen: number | null = null,
        chosenProb: number | null = null;
      for (const thr of RECOVERY_ATR_THRESHOLDS) {
        const cell = t[thr];
        if (
          cell.probNewExtremeGivenRecoveryReached !== null &&
          cell.probNewExtremeGivenRecoveryReached <= LOW_PROB_CUTOFF &&
          cell.casesReachingRecovery >= 3
        ) {
          chosen = thr;
          chosenProb = cell.probNewExtremeGivenRecoveryReached;
          break;
        }
      }
      if (chosen === null) {
        console.log(
          key +
            ": no threshold in the tested range reaches P(new extreme)<=" +
            LOW_PROB_CUTOFF +
            "% with >=3 supporting cases -- INSUFFICIENT_EVIDENCE_FOR_CLEAR_BOUNDARY",
        );
        recommendations[key] = "INSUFFICIENT_EVIDENCE_FOR_CLEAR_BOUNDARY";
      } else {
        console.log(
          key +
            ": recommended boundary = " +
            chosen.toFixed(2) +
            " ATR  (P(new extreme | recovery reached)=" +
            fmtPct(chosenProb) +
            ")",
        );
        recommendations[key] = {
          boundaryAtr: chosen,
          probNewExtreme: chosenProb,
        };
      }
    }
  }

  // ═══ Decisive per-symbol answer + final overall recommendation ═══
  console.log("\n" + "=".repeat(100));
  console.log("DECISIVE ANSWER");
  console.log("=".repeat(100));
  function decideSymbol(symbol: string) {
    const longRec = recommendations[symbol + "_LONG"];
    const shortRec = recommendations[symbol + "_SHORT"];
    const anyUsable =
      typeof longRec === "object" || typeof shortRec === "object";
    return anyUsable
      ? "USE DYNAMIC RECOVERY SEPARATION"
      : "KEEP CURRENT COMPLETION (insufficient/unclear evidence for a boundary)";
  }
  const btcDecision = decideSymbol("BTCUSDT");
  const bnbDecision = decideSymbol("BNBUSDT");
  console.log("BTC: " + btcDecision);
  console.log("BNB: " + bnbDecision);

  console.log("\nFINAL OVERALL PRODUCTION RECOMMENDATION:");
  if (btcDecision.startsWith("USE") || bnbDecision.startsWith("USE")) {
    console.log(
      "(B) Keep P95-qualified W1 + W2, but close/separate W1 using a per-symbol/per-side historical recovery boundary, exactly as computed above where evidence supports it (INSUFFICIENT_SAMPLE sides keep current completion logic unchanged until more data accumulates).",
    );
  } else {
    console.log(
      "(A) Keep current W1/W2 logic unchanged -- neither symbol's data in this 72h/2-symbol sample supports a confident, evidence-based separation boundary yet.",
    );
  }

  const outPath = path.join(
    OUTPUT_DIR,
    "final-w1-separation-decision-" + Date.now() + ".json",
  );
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        distributions,
        thresholdResults,
        namedExampleResults,
        recommendations,
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
