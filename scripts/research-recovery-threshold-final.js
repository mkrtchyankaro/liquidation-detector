/**
 * Sep 12 2026 (Karo), operator-requested FINAL research pass.
 * Statistical boundary between "normal breathing" and "probable
 * liquidation end" -- measured as price recovery (%/ATR) between
 * consecutive meaningful same-side liquidation bursts.
 *
 * READ-ONLY. No production code/strategy/Mongo writes/PM2 restarts.
 * Same burst-definition as the v2 research script (5s-clustered
 * same-side events, no new size threshold invented).
 */
require("dotenv/config");
const { MongoClient } = require("mongodb");
const https = require("https");
const fs = require("fs");
const path = require("path");

const SYMBOL = "ETHUSDT";
const HOURS = 72;
const BURST_CLUSTER_GAP_MS = 5000; // same as v2 research
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

function fmtUsd(n) {
  if (n === null || n === undefined) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
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

/** Wilder ATR(period), 1m, computed as a running value across the
 *  full sorted candle array. Returns a Map<openTime, atrValueAtThatCandleClose>. */
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

  console.log(
    "Fetching " +
      SYMBOL +
      " 1m candles (Binance REST), extra 240min lookback for ATR warmup...",
  );
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
    // frozen-at-candle: find the most recent computed ATR at or before this minute
    let t = Math.floor(ms / 60000) * 60000;
    for (let i = 0; i < 300; i++) {
      if (atrSeries.has(t)) return atrSeries.get(t);
      t -= 60000;
    }
    return null;
  }

  const result = {
    symbol: SYMBOL,
    hours: HOURS,
    generatedAt: new Date(now).toISOString(),
  };

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
      events: b,
    }));
  }

  const RECOVERY_ATR_THRESHOLDS = [
    0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1.0,
  ];
  const PRESSURE_BUCKETS = [
    [0, 10],
    [10, 20],
    [20, 30],
    [30, 50],
    [50, 75],
    [75, 100],
    [100, Infinity],
  ];
  const RULES = {
    R1: (recATR, press30) => recATR >= 0.1,
    R2: (recATR, press30) => recATR >= 0.2,
    R3: (recATR, press30) => recATR >= 0.3,
    R4: (recATR, press30) => recATR >= 0.4,
    R5: (recATR, press30) => recATR >= 0.5,
    R6: (recATR, press30) => recATR >= 0.2 && press30 <= 30,
    R7: (recATR, press30) => recATR >= 0.3 && press30 <= 30,
    R8: (recATR, press30) => recATR >= 0.4 && press30 <= 30,
    R9: (recATR, press30) => recATR >= 0.3 && press30 <= 20,
    R10: (recATR, press30) => recATR >= 0.4 && press30 <= 20,
  };

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

      // Burst1's own directional extreme (low for LONG, high for SHORT) within [b1.start-1m, b1.end+1m]
      let b1Extreme = null;
      for (
        let t = Math.floor((b1.start - 60000) / 60000) * 60000;
        t <= b1.end + 60000;
        t += 60000
      ) {
        const c = candleAt(t);
        if (!c) continue;
        const v = victim === "LONG" ? c.low : c.high;
        if (
          b1Extreme === null ||
          (victim === "LONG" ? v < b1Extreme : v > b1Extreme)
        )
          b1Extreme = v;
      }
      if (b1Extreme === null) continue;

      // Recovery: highest price (LONG) / lowest price (SHORT) reached between b1.end and b2.start
      let recoveryExtreme = null,
        recoveryExtremeTs = null;
      for (
        let t = Math.floor(b1.end / 60000) * 60000;
        t <= b2.start;
        t += 60000
      ) {
        const c = candleAt(t);
        if (!c) continue;
        const v = victim === "LONG" ? c.high : c.low;
        if (
          recoveryExtreme === null ||
          (victim === "LONG" ? v > recoveryExtreme : v < recoveryExtreme)
        ) {
          recoveryExtreme = v;
          recoveryExtremeTs = t;
        }
      }
      if (recoveryExtreme === null) continue;

      const recoveryUsdPrice =
        victim === "LONG"
          ? recoveryExtreme - b1Extreme
          : b1Extreme - recoveryExtreme;
      const recoveryPct = (recoveryUsdPrice / b1Extreme) * 100;
      const recoveryATR = recoveryUsdPrice / atrFrozen;

      // Burst2 own extreme, vs b1Extreme -- did it make a NEW directional extreme?
      let b2Extreme = null;
      for (
        let t = Math.floor((b2.start - 60000) / 60000) * 60000;
        t <= b2.end + 60000;
        t += 60000
      ) {
        const c = candleAt(t);
        if (!c) continue;
        const v = victim === "LONG" ? c.low : c.high;
        if (
          b2Extreme === null ||
          (victim === "LONG" ? v < b2Extreme : v > b2Extreme)
        )
          b2Extreme = v;
      }
      const burst2NewExtreme =
        b2Extreme !== null
          ? victim === "LONG"
            ? b2Extreme < b1Extreme
            : b2Extreme > b1Extreme
          : null;
      const additionalMoveAfterBurst2Pct =
        b2Extreme !== null
          ? victim === "LONG"
            ? ((b1Extreme - b2Extreme) / b1Extreme) * 100
            : ((b2Extreme - b1Extreme) / b1Extreme) * 100
          : null;

      const pair = {
        victim,
        burst1Start: b1.start,
        burst1End: b1.end,
        burst1TotalUsd: b1.totalUsd,
        burst1EventCount: b1.count,
        burst1MaxSingleUsd: b1.maxSingleUsd,
        burst1DurationMs: b1.end - b1.start,
        burstGapMs: b2.start - b1.end,
        burst2Start: b2.start,
        burst2TotalUsd: b2.totalUsd,
        burst2Ratio: b1.totalUsd > 0 ? b2.totalUsd / b1.totalUsd : null,
        atrFrozenAtBurst1Start: atrFrozen,
        b1Extreme,
        recoveryExtreme,
        recoveryExtremeTs,
        recoveryPct,
        recoveryATR,
        burst2NewExtreme,
        additionalMoveAfterBurst2Pct,
        timeRecoveryHighToBurst2StartMs: b2.start - recoveryExtremeTs,
      };
      allPairs[victim].push(pair);

      // ── R1-R10 first-crossing evaluation: walk minute-by-minute from b1.end to b2.start ──
      for (const [ruleName, ruleFn] of Object.entries(RULES)) {
        let signalTs = null,
          signalRecoveryATR = null,
          signalPressure30 = null;
        for (
          let t = Math.floor(b1.end / 60000) * 60000;
          t <= b2.start;
          t += 60000
        ) {
          const c = candleAt(t);
          if (!c) continue;
          const curPrice = c.close;
          const curRecoveryUsd =
            victim === "LONG" ? curPrice - b1Extreme : b1Extreme - curPrice;
          const curRecoveryATR = curRecoveryUsd / atrFrozen;
          const w30 = sideEvents.filter(
            (e) => e.timestamp > t - 30000 && e.timestamp <= t,
          );
          const pressure30 =
            b1.totalUsd > 0
              ? (w30.reduce((s, e) => s + e.quoteQty, 0) / b1.totalUsd) * 100
              : 0;
          if (ruleFn(curRecoveryATR, pressure30)) {
            signalTs = t;
            signalRecoveryATR = curRecoveryATR;
            signalPressure30 = pressure30;
            break;
          }
        }
        if (signalTs !== null) {
          const detectionDelayMs = signalTs - b1.end;
          const priceAtSignal = priceAt(signalTs);
          ruleSignals[victim][ruleName].push({
            burst1Start: b1.start,
            signalTs,
            detectionDelayMs,
            recoveryATRAtSignal: signalRecoveryATR,
            pressure30AtSignal: signalPressure30,
            priceAtSignal,
            burst2NewExtreme,
            additionalMoveAfterBurst2Pct,
            b1Extreme,
            atrFrozen,
            favorableReversalMove5m:
              priceAtSignal !== null
                ? victim === "LONG"
                  ? ((priceAt(signalTs + 5 * 60000) - priceAtSignal) /
                      priceAtSignal) *
                    100
                  : ((priceAtSignal - priceAt(signalTs + 5 * 60000)) /
                      priceAtSignal) *
                    100
                : null,
            favorableReversalMove15m:
              priceAtSignal !== null
                ? victim === "LONG"
                  ? ((priceAt(signalTs + 15 * 60000) - priceAtSignal) /
                      priceAtSignal) *
                    100
                  : ((priceAtSignal - priceAt(signalTs + 15 * 60000)) /
                      priceAtSignal) *
                    100
                : null,
          });
        }
      }
    }
    console.log(
      "  " + allPairs[victim].length + " valid Burst1->Burst2 pairs computed.",
    );
  }

  result.rawPairs = allPairs;

  // ═══ SECTION 3: core recoveryPct/recoveryATR distributions ═══
  const pctList = [10, 25, 50, 60, 70, 75, 80, 85, 90, 95, 99];
  function distTable(pairs, field) {
    const vals = pairs.map((p) => p[field]);
    return Object.fromEntries(
      pctList.map((p) => ["p" + p, percentile(vals, p)]),
    );
  }
  result.section3_coreDistribution = {
    LONG: {
      recoveryPct: distTable(allPairs.LONG, "recoveryPct"),
      recoveryATR: distTable(allPairs.LONG, "recoveryATR"),
    },
    SHORT: {
      recoveryPct: distTable(allPairs.SHORT, "recoveryPct"),
      recoveryATR: distTable(allPairs.SHORT, "recoveryATR"),
    },
  };

  // ═══ SECTION 4: split by dangerous (new extreme) vs not ═══
  function splitStats(pairs) {
    const dangerous = pairs.filter((p) => p.burst2NewExtreme === true);
    const safe = pairs.filter((p) => p.burst2NewExtreme === false);
    function stats(arr, field) {
      const v = arr.map((p) => p[field]);
      return {
        median: median(v),
        p75: percentile(v, 75),
        p90: percentile(v, 90),
        p95: percentile(v, 95),
      };
    }
    return {
      dangerousCount: dangerous.length,
      safeCount: safe.length,
      dangerous: {
        recoveryPct: stats(dangerous, "recoveryPct"),
        recoveryATR: stats(dangerous, "recoveryATR"),
      },
      safe: {
        recoveryPct: stats(safe, "recoveryPct"),
        recoveryATR: stats(safe, "recoveryATR"),
      },
    };
  }
  result.section4_dangerousSplit = {
    LONG: splitStats(allPairs.LONG),
    SHORT: splitStats(allPairs.SHORT),
  };

  // ═══ SECTION 5: recovery-threshold test ═══
  function thresholdTest(pairs, T) {
    const qualifying = pairs.filter((p) => p.recoveryATR >= T);
    const newExtremeCount = qualifying.filter(
      (p) => p.burst2NewExtreme === true,
    ).length;
    return {
      threshold: T,
      count: qualifying.length,
      burst2ArrivedPct: pairs.length
        ? (qualifying.length / pairs.length) * 100
        : null,
      newExtremePct: qualifying.length
        ? (newExtremeCount / qualifying.length) * 100
        : null,
      medianBurst2Ratio: median(qualifying.map((p) => p.burst2Ratio)),
      medianAdverseMove: median(
        qualifying.map((p) => p.additionalMoveAfterBurst2Pct),
      ),
      p90AdverseMove: percentile(
        qualifying.map((p) => p.additionalMoveAfterBurst2Pct),
        90,
      ),
    };
  }
  result.section5_thresholdTest = {
    LONG: RECOVERY_ATR_THRESHOLDS.map((T) => thresholdTest(allPairs.LONG, T)),
    SHORT: RECOVERY_ATR_THRESHOLDS.map((T) => thresholdTest(allPairs.SHORT, T)),
    COMBINED: RECOVERY_ATR_THRESHOLDS.map((T) =>
      thresholdTest([...allPairs.LONG, ...allPairs.SHORT], T),
    ),
  };

  // ═══ SECTION 6: recovery + pressure matrix ═══
  console.log(
    "\nBuilding recovery+pressure matrix (this re-walks each pair's own gap window)...",
  );
  function pressureAtThresholdCrossing(pair, victim, sideEvents) {
    for (
      let t = Math.floor(pair.burst1End / 60000) * 60000;
      t <= pair.burst2Start;
      t += 60000
    ) {
      const c = candleAt(t);
      if (!c) continue;
      const curPrice = c.close;
      const curRecoveryUsd =
        victim === "LONG"
          ? curPrice - pair.b1Extreme
          : pair.b1Extreme - curPrice;
      const curRecoveryATR = curRecoveryUsd / pair.atrFrozenAtBurst1Start;
      for (const T of RECOVERY_ATR_THRESHOLDS) {
        if (curRecoveryATR >= T && !pair["_crossed_" + T]) {
          pair["_crossed_" + T] = true;
          const w30 = sideEvents.filter(
            (e) => e.timestamp > t - 30000 && e.timestamp <= t,
          );
          const pressure30 =
            pair.burst1TotalUsd > 0
              ? (w30.reduce((s, e) => s + e.quoteQty, 0) /
                  pair.burst1TotalUsd) *
                100
              : 0;
          pair["_pressureAt_" + T] = pressure30;
        }
      }
    }
  }
  for (const victim of ["LONG", "SHORT"]) {
    const sideEvents = allEvents.filter((e) => e.victim === victim);
    allPairs[victim].forEach((p) =>
      pressureAtThresholdCrossing(p, victim, sideEvents),
    );
  }
  const recoveryBucketsForMatrix = [0.1, 0.2, 0.3, 0.4, 0.5];
  function matrixCell(pairs, recT, pressLo, pressHi) {
    const cellPairs = pairs.filter(
      (p) =>
        p["_crossed_" + recT] &&
        p["_pressureAt_" + recT] >= pressLo &&
        p["_pressureAt_" + recT] < pressHi,
    );
    const newExt = cellPairs.filter((p) => p.burst2NewExtreme === true).length;
    return {
      count: cellPairs.length,
      burst2Prob: cellPairs.length ? 100 : 0,
      newExtremeProb: cellPairs.length
        ? (newExt / cellPairs.length) * 100
        : null,
      medianAdverseMove: median(
        cellPairs.map((p) => p.additionalMoveAfterBurst2Pct),
      ),
      p90AdverseMove: percentile(
        cellPairs.map((p) => p.additionalMoveAfterBurst2Pct),
        90,
      ),
    };
  }
  result.section6_recoveryPressureMatrix = {};
  for (const victim of ["LONG", "SHORT"]) {
    result.section6_recoveryPressureMatrix[victim] = {};
    for (const recT of recoveryBucketsForMatrix) {
      result.section6_recoveryPressureMatrix[victim][recT + "ATR"] =
        Object.fromEntries(
          PRESSURE_BUCKETS.map(([lo, hi]) => [
            lo + "-" + (hi === Infinity ? "100+" : hi) + "%",
            matrixCell(allPairs[victim], recT, lo, hi),
          ]),
        );
    }
  }

  // ═══ SECTION 7: R1-R10 comparison ═══
  function ruleStats(signals) {
    const newExt = signals.filter((s) => s.burst2NewExtreme === true).length;
    return {
      signalCount: signals.length,
      dangerousSecondPushProb: signals.length
        ? (newExt / signals.length) * 100
        : null,
      newExtremeProb: signals.length ? (newExt / signals.length) * 100 : null,
      medianDetectionDelayMs: median(signals.map((s) => s.detectionDelayMs)),
      p90DetectionDelayMs: percentile(
        signals.map((s) => s.detectionDelayMs),
        90,
      ),
      medianAdverseMovePct: median(
        signals.map((s) => s.additionalMoveAfterBurst2Pct),
      ),
      p90AdverseMovePct: percentile(
        signals.map((s) => s.additionalMoveAfterBurst2Pct),
        90,
      ),
      medianFavorableMove5m: median(
        signals.map((s) => s.favorableReversalMove5m),
      ),
      medianFavorableMove15m: median(
        signals.map((s) => s.favorableReversalMove15m),
      ),
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

  // ═══ SECTION 8: trade-outcome simulation for R1-R10 ═══
  console.log(
    "Simulating trade outcomes (SL=0.30%, TP=2R/2.5R/3R) for R1-R10 signals...",
  );
  function simulateTrade(entryTs, entryPrice, victim, slPct, rr) {
    const slDist = entryPrice * slPct;
    const tpDist = slDist * rr;
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
      if (hitTp && hitSl)
        return { outcome: "AMBIGUOUS_SAME_CANDLE", timeMs: t - entryTs };
      if (hitTp) return { outcome: "TP", timeMs: t - entryTs };
      if (hitSl) return { outcome: "SL", timeMs: t - entryTs };
    }
    return { outcome: "NEITHER", timeMs: null };
  }
  const tradeResults = {};
  for (const ruleName of Object.keys(RULES)) {
    tradeResults[ruleName] = {};
    for (const side of ["LONG", "SHORT", "COMBINED"]) {
      const signals =
        side === "COMBINED"
          ? [...ruleSignals.LONG[ruleName], ...ruleSignals.SHORT[ruleName]]
          : ruleSignals[side === "LONG" ? "LONG" : "SHORT"][ruleName];
      const sideForSim = side === "COMBINED" ? null : side;
      tradeResults[ruleName][side] = {};
      for (const rr of [2, 2.5, 3]) {
        let tp = 0,
          sl = 0,
          neither = 0,
          ambiguous = 0;
        const tpTimes = [],
          slTimes = [];
        for (const sig of signals) {
          if (sig.priceAtSignal === null) continue;
          const v =
            sideForSim ||
            (ruleSignals.LONG[ruleName].includes(sig) ? "LONG" : "SHORT");
          const out = simulateTrade(
            sig.signalTs,
            sig.priceAtSignal,
            v,
            0.003,
            rr,
          );
          if (out.outcome === "TP") {
            tp++;
            tpTimes.push(out.timeMs);
          } else if (out.outcome === "SL") {
            sl++;
            slTimes.push(out.timeMs);
          } else if (out.outcome === "AMBIGUOUS_SAME_CANDLE") ambiguous++;
          else neither++;
        }
        const decided = tp + sl;
        const winRate = decided ? (tp / decided) * 100 : null;
        const expectancyR = decided ? (tp * rr - sl) / decided : null;
        tradeResults[ruleName][side][rr + "R"] = {
          signals: signals.length,
          TP: tp,
          SL: sl,
          NEITHER: neither,
          AMBIGUOUS: ambiguous,
          winRatePct: winRate,
          expectancyR,
          medianTimeToTPMs: median(tpTimes),
          medianTimeToSLMs: median(slTimes),
        };
      }
    }
  }
  result.section8_tradeOutcomes = tradeResults;

  // ── Write full JSON ──
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "eth-recovery-threshold-final-" + Date.now() + ".json",
  );
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log("\nFull output written to: " + outPath);

  // ── Compact terminal summary ──
  console.log("\n" + "=".repeat(100));
  console.log("1. RECOVERY-ATR DISTRIBUTION");
  console.log("=".repeat(100));
  for (const side of ["LONG", "SHORT"]) {
    console.log(
      side +
        " recoveryATR: " +
        Object.entries(result.section3_coreDistribution[side].recoveryATR)
          .map(([k, v]) => k + "=" + (v !== null ? v.toFixed(3) : "n/a"))
          .join(" "),
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log("2. DANGEROUS-SECOND-PUSH RECOVERY SPLIT");
  console.log("=".repeat(100));
  for (const side of ["LONG", "SHORT"]) {
    const s = result.section4_dangerousSplit[side];
    console.log(
      side +
        ": dangerous(n=" +
        s.dangerousCount +
        ") recoveryATR median=" +
        (s.dangerous.recoveryATR.median !== null
          ? s.dangerous.recoveryATR.median.toFixed(3)
          : "n/a") +
        " p90=" +
        (s.dangerous.recoveryATR.p90 !== null
          ? s.dangerous.recoveryATR.p90.toFixed(3)
          : "n/a") +
        "  |  safe(n=" +
        s.safeCount +
        ") median=" +
        (s.safe.recoveryATR.median !== null
          ? s.safe.recoveryATR.median.toFixed(3)
          : "n/a") +
        " p90=" +
        (s.safe.recoveryATR.p90 !== null
          ? s.safe.recoveryATR.p90.toFixed(3)
          : "n/a"),
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log("3. THRESHOLD vs NEW-EXTREME PROBABILITY (COMBINED)");
  console.log("=".repeat(100));
  result.section5_thresholdTest.COMBINED.forEach((r) =>
    console.log(
      "T=" +
        r.threshold +
        "ATR: n=" +
        r.count +
        " burst2Arrived=" +
        fmtPct(r.burst2ArrivedPct, 1) +
        " newExtreme%=" +
        fmtPct(r.newExtremePct, 1) +
        " medAdverse=" +
        fmtPct(r.medianAdverseMove, 2),
    ),
  );

  console.log("\n" + "=".repeat(100));
  console.log("5. R1-R10 COMPARISON (COMBINED)");
  console.log("=".repeat(100));
  for (const [rule, s] of Object.entries(
    result.section7_ruleComparison.COMBINED,
  )) {
    console.log(
      rule +
        ": n=" +
        s.signalCount +
        " dangerP%=" +
        fmtPct(s.dangerousSecondPushProb, 1) +
        " medDelay=" +
        fmtMs(s.medianDetectionDelayMs) +
        " medAdverse=" +
        fmtPct(s.medianAdverseMovePct, 2) +
        " medFavorable5m=" +
        fmtPct(s.medianFavorableMove5m, 2),
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log(
    "6. TP/SL EXPECTANCY (COMBINED, 2R shown; full 2R/2.5R/3R in JSON)",
  );
  console.log("=".repeat(100));
  for (const [rule, sides] of Object.entries(result.section8_tradeOutcomes)) {
    const r2 = sides.COMBINED["2R"];
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

  console.log(
    "\n(Sections 6 (recovery+pressure matrix) and full per-pair raw data are in the JSON file.)",
  );
  console.log(
    "\n*** Recommendation (Section 9) withheld from this printout -- computed from the numbers above once you share the real output; the script does not fabricate a recommendation before seeing real data. ***",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
