/**
 * Sep 12 2026 (Karo), operator-reported CRITICAL FIX -- v1 of this
 * research script had a real causality/look-ahead bug: it froze
 * "Burst1's own extreme" as a single, fixed value computed once from
 * Burst1's own window, then NEVER updated it while walking forward
 * through the gap toward Burst2. If price kept making new lows/highs
 * between bursts (entirely possible, since price movement is not
 * gated by liquidation events), recovery was measured against a
 * stale/wrong reference -- explaining the negative detection delays,
 * the near-zero adverse-move numbers, and the implausibly large
 * ~2.1-2.3 ATR median recoveryATR.
 *
 * THIS VERSION: a properly continuous, live-causal RUNNING extreme,
 * re-computed candle-by-candle from Burst1's own start through
 * Burst2's start, for every pair, with mandatory sanity checks that
 * STOP the script (no recommendation printed) if any causality
 * violation is detected.
 *
 * READ-ONLY. No production code/strategy/Mongo writes/PM2 restarts.
 * Same scope as the previous pass -- fix only, no expansion.
 */
require("dotenv/config");
const { MongoClient } = require("mongodb");
const https = require("https");
const fs = require("fs");
const path = require("path");

const SYMBOL = "ETHUSDT";
const HOURS = 72;
const BURST_CLUSTER_GAP_MS = 5000;
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

function fmtMs(ms) {
  if (ms === null || ms === undefined) return "n/a";
  const s = ms / 1000;
  if (Math.abs(s) < 60) return s.toFixed(1) + "s";
  return (s / 60).toFixed(1) + "m";
}
function fmtPct(n, d) {
  return n === null || n === undefined ? "n/a" : n.toFixed(d ?? 2) + "%";
}
function sortNum(a) {
  return [...a]
    .filter((x) => x !== null && x !== undefined && !isNaN(x))
    .sort((x, y) => x - y);
}
function percentile(arr, p) {
  const s = sortNum(arr);
  if (!s.length) return null;
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
function median(a) {
  return percentile(a, 50);
}

function httpsGetJson(url) {
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
async function fetchKlines(symbol, startTime, endTime) {
  const byOpenTime = new Map();
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
function computeWilderAtrSeries(candlesAsc, period) {
  const atrMap = new Map();
  if (candlesAsc.length < period + 1) return atrMap;
  const trs = [];
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
  const startTs = now - HOURS * 3600 * 1000;
  console.log(
    "Fetching " + SYMBOL + " raw liquidation events, last " + HOURS + "h...",
  );
  const allEvents = await col
    .find({ symbol: SYMBOL, timestamp: { $gte: startTs, $lte: now } })
    .sort({ timestamp: 1 })
    .toArray();
  console.log("  " + allEvents.length + " events.");

  console.log("Fetching " + SYMBOL + " 1m candles...");
  const klines = await fetchKlines(
    SYMBOL,
    startTs - 240 * 60000,
    now + 30 * 60000,
  );
  const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
  console.log("  " + candlesAsc.length + " candles.");
  function candleAt(ms) {
    return klines.get(Math.floor(ms / 60000) * 60000) || null;
  }
  function priceAt(ms) {
    const c = candleAt(ms);
    return c ? c.close : null;
  }
  const atrSeries = computeWilderAtrSeries(candlesAsc, 240);
  function atrAt(ms) {
    let t = Math.floor(ms / 60000) * 60000;
    for (let i = 0; i < 300; i++) {
      if (atrSeries.has(t)) return atrSeries.get(t);
      t -= 60000;
    }
    return null;
  }

  function clusterBursts(evs, gapMs) {
    if (!evs.length) return [];
    const out = [];
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
      totalUsd: b.reduce((s, e) => s + e.quoteQty, 0),
      maxSingleUsd: Math.max(...b.map((e) => e.quoteQty)),
      count: b.length,
    }));
  }

  const RECOVERY_ATR_THRESHOLDS = [
    0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1.0,
  ];
  const RULES = {
    R1: (r, p) => r >= 0.1,
    R2: (r, p) => r >= 0.2,
    R3: (r, p) => r >= 0.3,
    R4: (r, p) => r >= 0.4,
    R5: (r, p) => r >= 0.5,
    R6: (r, p) => r >= 0.2 && p <= 30,
    R7: (r, p) => r >= 0.3 && p <= 30,
    R8: (r, p) => r >= 0.4 && p <= 30,
    R9: (r, p) => r >= 0.3 && p <= 20,
    R10: (r, p) => r >= 0.4 && p <= 20,
  };
  const OUTCOME_HORIZONS_SEC = [60, 120, 180, 300]; // 60s, 2m, 3m, 5m -- 3m is primary per operator instruction

  const allPairs = { LONG: [], SHORT: [] };
  const ruleSignals = {
    LONG: Object.fromEntries(Object.keys(RULES).map((r) => [r, []])),
    SHORT: Object.fromEntries(Object.keys(RULES).map((r) => [r, []])),
  };

  for (const victim of ["LONG", "SHORT"]) {
    console.log("\n=== " + victim + " ===");
    const sideEvents = allEvents.filter((e) => e.victim === victim);
    const bursts = clusterBursts(sideEvents, BURST_CLUSTER_GAP_MS);
    console.log("  " + bursts.length + " bursts.");

    for (let i = 0; i < bursts.length - 1; i++) {
      const b1 = bursts[i],
        b2 = bursts[i + 1];
      const atrFrozen = atrAt(b1.start);
      if (atrFrozen === null || atrFrozen <= 0) continue;

      // ── STRICT LIVE-CAUSAL RUNNING EXTREME, walked minute-by-minute
      // from b1.start (the moment Burst1 begins) through b2.start.
      // Updated continuously; NEVER uses data beyond the current
      // candle. This IS "Burst1's own extreme" once the walk passes
      // b1.end, but it keeps updating (and recovery keeps resetting
      // toward zero) if price extends further afterward too --
      // exactly per the operator's own Section A/B specification. ──
      let runningExtreme = null,
        runningExtremeTs = null;
      let bestRecoveryATR = -Infinity,
        bestRecoveryTs = null; // for the "recovery reached before Burst2" descriptive stats
      const perMinuteState = []; // recorded for rule-evaluation below
      let signalFiredForRule = Object.fromEntries(
        Object.keys(RULES).map((r) => [r, false]),
      );

      const walkStart = Math.floor(b1.start / 60000) * 60000;
      const walkEnd = b2.start;
      for (let t = walkStart; t <= walkEnd; t += 60000) {
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
        const curPrice = c.close;
        const recoveryUsd =
          victim === "LONG"
            ? curPrice - runningExtreme
            : runningExtreme - curPrice;
        const recoveryATR = recoveryUsd / atrFrozen;
        if (recoveryATR > bestRecoveryATR) {
          bestRecoveryATR = recoveryATR;
          bestRecoveryTs = t;
        }

        const w30 = sideEvents.filter(
          (e) => e.timestamp > t - 30000 && e.timestamp <= t,
        );
        const pressure30 =
          b1.totalUsd > 0
            ? (w30.reduce((s, e) => s + e.quoteQty, 0) / b1.totalUsd) * 100
            : 0;

        for (const [ruleName, ruleFn] of Object.entries(RULES)) {
          if (signalFiredForRule[ruleName]) continue;
          if (ruleFn(recoveryATR, pressure30)) {
            signalFiredForRule[ruleName] = true;
            const detectionDelayMs = t - runningExtremeTs; // per Section D -- relative to the extreme it recovered FROM, never b1.end
            // ── mandatory sanity check ──
            if (detectionDelayMs < 0) {
              console.error(
                "CAUSALITY BUG STILL PRESENT: negative detectionDelayMs for " +
                  ruleName +
                  " at t=" +
                  t,
              );
              process.exitCode = 2;
            }
            const priceAtSignal = c.close;

            // ── outcome windows: 60s/2m/3m/5m, bounded, never pairs a distant unrelated burst ──
            const outcomes = {};
            for (const horizonSec of OUTCOME_HORIZONS_SEC) {
              const horizonEnd = t + horizonSec * 1000;
              let laterExtremeInHorizon = null;
              for (let t2 = t; t2 <= horizonEnd; t2 += 60000) {
                const c2 = candleAt(t2);
                if (!c2) continue;
                const v2 = victim === "LONG" ? c2.low : c2.high;
                if (
                  laterExtremeInHorizon === null ||
                  (victim === "LONG"
                    ? v2 < laterExtremeInHorizon
                    : v2 > laterExtremeInHorizon)
                )
                  laterExtremeInHorizon = v2;
              }
              const newMeaningfulExtreme =
                laterExtremeInHorizon !== null
                  ? victim === "LONG"
                    ? laterExtremeInHorizon < runningExtreme
                    : laterExtremeInHorizon > runningExtreme
                  : null;
              outcomes[horizonSec + "s"] = {
                newDirectionalExtreme: newMeaningfulExtreme,
              };
            }

            // ── MAE/MFE, Section C, non-negative by construction ──
            let minFuture = Infinity,
              maxFuture = -Infinity;
            for (let t3 = t; t3 <= t + 30 * 60000; t3 += 60000) {
              const c3 = candleAt(t3);
              if (!c3) continue;
              if (c3.low < minFuture) minFuture = c3.low;
              if (c3.high > maxFuture) maxFuture = c3.high;
            }
            const MAE =
              victim === "LONG"
                ? Math.max(0, (priceAtSignal - minFuture) / priceAtSignal) * 100
                : Math.max(0, (maxFuture - priceAtSignal) / priceAtSignal) *
                  100;
            const MFE =
              victim === "LONG"
                ? Math.max(0, (maxFuture - priceAtSignal) / priceAtSignal) * 100
                : Math.max(0, (priceAtSignal - minFuture) / priceAtSignal) *
                  100;
            const price5m = priceAt(t + 5 * 60000),
              price15m = priceAt(t + 15 * 60000);
            const mfe5m =
              priceAtSignal !== null && price5m !== null
                ? victim === "LONG"
                  ? Math.max(0, (price5m - priceAtSignal) / priceAtSignal) * 100
                  : Math.max(0, (priceAtSignal - price5m) / priceAtSignal) * 100
                : null;
            const mfe15m =
              priceAtSignal !== null && price15m !== null
                ? victim === "LONG"
                  ? Math.max(0, (price15m - priceAtSignal) / priceAtSignal) *
                    100
                  : Math.max(0, (priceAtSignal - price15m) / priceAtSignal) *
                    100
                : null;

            ruleSignals[victim][ruleName].push({
              burst1Start: b1.start,
              signalTs: t,
              runningExtremeTs,
              detectionDelayMs,
              recoveryATRAtSignal: recoveryATR,
              pressure30AtSignal: pressure30,
              priceAtSignal,
              outcomes,
              MAE,
              MFE,
              mfe5m,
              mfe15m,
            });
          }
        }
      }

      if (runningExtreme === null) continue;
      allPairs[victim].push({
        victim,
        burst1Start: b1.start,
        burst1TotalUsd: b1.totalUsd,
        burst1MaxSingleUsd: b1.maxSingleUsd,
        burst1EventCount: b1.count,
        burst2Start: b2.start,
        burstGapMs: b2.start - b1.end,
        finalRunningExtreme: runningExtreme,
        finalRunningExtremeTs: runningExtremeTs,
        bestRecoveryATRReached: bestRecoveryATR,
        bestRecoveryTs,
        atrFrozen,
      });
    }
    console.log(
      "  " +
        allPairs[victim].length +
        " pairs, causal running-extreme walk complete.",
    );
  }

  // ── MANDATORY SANITY CHECKS ──
  const allSignals = [
    ...Object.values(ruleSignals.LONG).flat(),
    ...Object.values(ruleSignals.SHORT).flat(),
  ];
  const negativeDetectionDelayCount = allSignals.filter(
    (s) => s.detectionDelayMs < 0,
  ).length;
  const negativeMAECount = allSignals.filter((s) => s.MAE < 0).length;
  const negativeMFECount = allSignals.filter((s) => s.MFE < 0).length;

  console.log("\n" + "=".repeat(100));
  console.log("MANDATORY SANITY CHECKS");
  console.log("=".repeat(100));
  console.log("negativeDetectionDelayCount = " + negativeDetectionDelayCount);
  console.log("negativeMAECount = " + negativeMAECount);
  console.log("negativeMFECount = " + negativeMFECount);
  console.log(
    "minimum MAE = " +
      (allSignals.length
        ? Math.min(...allSignals.map((s) => s.MAE)).toFixed(4)
        : "n/a") +
      "%",
  );
  console.log(
    "minimum MFE = " +
      (allSignals.length
        ? Math.min(...allSignals.map((s) => s.MFE)).toFixed(4)
        : "n/a") +
      "%",
  );
  console.log(
    "minimum detectionDelay = " +
      fmtMs(
        allSignals.length
          ? Math.min(...allSignals.map((s) => s.detectionDelayMs))
          : null,
      ),
  );

  if (
    negativeDetectionDelayCount > 0 ||
    negativeMAECount > 0 ||
    negativeMFECount > 0
  ) {
    console.log(
      "\n*** STOPPING: causality/sign bug still present. No recommendation printed. ***",
    );
    const dbgPath = path.join(
      OUTPUT_DIR,
      "eth-recovery-CAUSALITY-BUG-DEBUG-" + Date.now() + ".json",
    );
    if (!fs.existsSync(OUTPUT_DIR))
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(
      dbgPath,
      JSON.stringify({ allPairs, ruleSignals }, null, 2),
    );
    console.log("Debug data written to: " + dbgPath);
    await client.close();
    return;
  }
  console.log("\nAll sanity checks PASSED. Proceeding with full analysis.\n");

  // ═══ Core recoveryATR distribution (descriptive, from bestRecoveryATRReached per pair) ═══
  const pctList = [10, 25, 50, 60, 70, 75, 80, 85, 90, 95, 99];
  function distTable(vals) {
    return Object.fromEntries(
      pctList.map((p) => ["p" + p, percentile(vals, p)]),
    );
  }
  const result = {
    symbol: SYMBOL,
    hours: HOURS,
    generatedAt: new Date(now).toISOString(),
    sanityChecks: {
      negativeDetectionDelayCount,
      negativeMAECount,
      negativeMFECount,
    },
  };
  result.section3_coreRecoveryATRDistribution = {
    LONG: distTable(allPairs.LONG.map((p) => p.bestRecoveryATRReached)),
    SHORT: distTable(allPairs.SHORT.map((p) => p.bestRecoveryATRReached)),
  };

  // ═══ F: R1-R10, causal, with 60s/2m/3m/5m outcome + delay/MAE/MFE ═══
  function ruleStats(signals) {
    function newExtPct(sec) {
      const n = signals.filter(
        (s) =>
          s.outcomes[sec + "s"] &&
          s.outcomes[sec + "s"].newDirectionalExtreme === true,
      ).length;
      return signals.length ? (n / signals.length) * 100 : null;
    }
    return {
      signalCount: signals.length,
      newExtremeWithin60s_pct: newExtPct(60),
      newExtremeWithin2m_pct: newExtPct(120),
      newExtremeWithin3m_pct: newExtPct(180),
      newExtremeWithin5m_pct: newExtPct(300),
      medianDetectionDelayMs: median(signals.map((s) => s.detectionDelayMs)),
      p90DetectionDelayMs: percentile(
        signals.map((s) => s.detectionDelayMs),
        90,
      ),
      medianMAE: median(signals.map((s) => s.MAE)),
      p90MAE: percentile(
        signals.map((s) => s.MAE),
        90,
      ),
      medianMFE5m: median(signals.map((s) => s.mfe5m)),
      medianMFE15m: median(signals.map((s) => s.mfe15m)),
    };
  }
  result.section7_ruleComparison = { LONG: {}, SHORT: {}, COMBINED: {} };
  for (const ruleName of Object.keys(RULES)) {
    result.section7_ruleComparison.LONG[ruleName] = ruleStats(
      ruleSignals.LONG[ruleName],
    );
    result.section7_ruleComparison.SHORT[ruleName] = ruleStats(
      ruleSignals.SHORT[ruleName],
    );
    result.section7_ruleComparison.COMBINED[ruleName] = ruleStats([
      ...ruleSignals.LONG[ruleName],
      ...ruleSignals.SHORT[ruleName],
    ]);
  }

  // ═══ G: trade simulation ═══
  function simulateTrade(entryTs, entryPrice, victim, slPct, rr) {
    const slDist = entryPrice * slPct,
      tpDist = slDist * rr;
    const sl = victim === "LONG" ? entryPrice - slDist : entryPrice + slDist;
    const tp = victim === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;
    for (
      let t = Math.floor(entryTs / 60000) * 60000 + 60000;
      t <= entryTs + 30 * 60000;
      t += 60000
    ) {
      const c = candleAt(t);
      if (!c) continue;
      const hitTp = victim === "LONG" ? c.high >= tp : c.low <= tp;
      const hitSl = victim === "LONG" ? c.low <= sl : c.high >= sl;
      if (hitTp && hitSl) return { outcome: "AMBIGUOUS_SAME_CANDLE" };
      if (hitTp) return { outcome: "TP" };
      if (hitSl) return { outcome: "SL" };
    }
    return { outcome: "NEITHER" };
  }
  const tradeResults = {};
  for (const ruleName of Object.keys(RULES)) {
    tradeResults[ruleName] = {};
    for (const side of ["LONG", "SHORT", "COMBINED"]) {
      const signals =
        side === "COMBINED"
          ? [...ruleSignals.LONG[ruleName], ...ruleSignals.SHORT[ruleName]]
          : ruleSignals[side][ruleName];
      tradeResults[ruleName][side] = {};
      for (const rr of [2, 2.5, 3]) {
        let tp = 0,
          sl = 0,
          neither = 0,
          ambiguous = 0;
        for (const sig of signals) {
          const v = ruleSignals.LONG[ruleName].includes(sig) ? "LONG" : "SHORT";
          const out = simulateTrade(
            sig.signalTs,
            sig.priceAtSignal,
            v,
            0.003,
            rr,
          );
          if (out.outcome === "TP") tp++;
          else if (out.outcome === "SL") sl++;
          else if (out.outcome === "AMBIGUOUS_SAME_CANDLE") ambiguous++;
          else neither++;
        }
        const decided = tp + sl;
        tradeResults[ruleName][side][rr + "R"] = {
          signals: signals.length,
          TP: tp,
          SL: sl,
          NEITHER: neither,
          AMBIGUOUS: ambiguous,
          winRatePct: decided ? (tp / decided) * 100 : null,
          expectancyR: decided ? (tp * rr - sl) / decided : null,
        };
      }
    }
  }
  result.section8_tradeOutcomes = tradeResults;
  result.rawPairs = allPairs;
  result.rawSignals = ruleSignals;

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "eth-recovery-threshold-CAUSAL-FIXED-" + Date.now() + ".json",
  );
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log("Full output written to: " + outPath);

  console.log("\n" + "=".repeat(100));
  console.log(
    "CORE recoveryATR DISTRIBUTION (bestRecoveryATRReached before Burst2, causal)",
  );
  console.log("=".repeat(100));
  for (const side of ["LONG", "SHORT"])
    console.log(
      side +
        ": " +
        Object.entries(result.section3_coreRecoveryATRDistribution[side])
          .map(([k, v]) => k + "=" + (v !== null ? v.toFixed(3) : "n/a"))
          .join(" "),
    );

  console.log("\n" + "=".repeat(100));
  console.log("R1-R10 COMPARISON (COMBINED, causal)");
  console.log("=".repeat(100));
  for (const [rule, s] of Object.entries(
    result.section7_ruleComparison.COMBINED,
  )) {
    console.log(
      rule +
        ": n=" +
        s.signalCount +
        " newExt60s=" +
        fmtPct(s.newExtremeWithin60s_pct, 1) +
        " newExt2m=" +
        fmtPct(s.newExtremeWithin2m_pct, 1) +
        " newExt3m=" +
        fmtPct(s.newExtremeWithin3m_pct, 1) +
        " newExt5m=" +
        fmtPct(s.newExtremeWithin5m_pct, 1) +
        " medDelay=" +
        fmtMs(s.medianDetectionDelayMs) +
        " p90Delay=" +
        fmtMs(s.p90DetectionDelayMs) +
        " medMAE=" +
        fmtPct(s.medianMAE, 2) +
        " medMFE5m=" +
        fmtPct(s.medianMFE5m, 2),
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log("TRADE OUTCOME (COMBINED, 2R shown; 2.5R/3R in JSON)");
  console.log("=".repeat(100));
  let anyPositiveExpectancy = false;
  for (const [rule, sides] of Object.entries(result.section8_tradeOutcomes)) {
    const r2 = sides.COMBINED["2R"];
    if (r2.expectancyR !== null && r2.expectancyR > 0)
      anyPositiveExpectancy = true;
    console.log(
      rule +
        ": n=" +
        r2.signals +
        " TP=" +
        r2.TP +
        " SL=" +
        r2.SL +
        " NEITHER=" +
        r2.NEITHER +
        " AMBIG=" +
        r2.AMBIGUOUS +
        " winRate=" +
        fmtPct(r2.winRatePct, 1) +
        " expR=" +
        (r2.expectancyR !== null ? r2.expectancyR.toFixed(3) : "n/a"),
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log("H. FINAL DECISION");
  console.log("=".repeat(100));
  if (!anyPositiveExpectancy) {
    console.log(
      "None of R1-R10 provides sufficient edge (no rule shows positive 2R expectancy in the COMBINED sample above).",
    );
  } else {
    console.log(
      "At least one rule shows positive 2R expectancy -- see the full 2R/2.5R/3R table in the JSON file to compare precisely before choosing.",
    );
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
