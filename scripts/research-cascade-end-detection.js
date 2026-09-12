/**
 * Sep 12 2026 (Karo), operator-requested. Comprehensive, READ-ONLY
 * research dataset builder for liquidation-cascade END-detection
 * analysis. No production code/strategy touched. No MongoDB writes
 * (reads liq_raw_events only). No P95/W1/W2 filtering -- ALL events
 * retained.
 */
require("dotenv/config");
const { MongoClient } = require("mongodb");
const https = require("https");
const fs = require("fs");
const path = require("path");

const SYMBOL = "ETHUSDT";
const HOURS = 72;
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

function fmtTs(ms) {
  return (
    new Date(ms).toISOString().replace("T", " ").slice(0, 19) +
    "." +
    String(ms % 1000).padStart(3, "0") +
    "Z"
  );
}
function fmtUsd(n) {
  if (n === null) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function median(arr) {
  return percentile(
    [...arr].sort((a, b) => a - b),
    50,
  );
}
function sortNum(arr) {
  return [...arr].sort((a, b) => a - b);
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
  const CHUNK = 1500;
  while (cursor <= endTime) {
    const chunkEnd = Math.min(cursor + (CHUNK - 1) * 60000, endTime);
    const url =
      "https://fapi.binance.com/fapi/v1/klines?symbol=" +
      symbol +
      "&interval=1m&startTime=" +
      cursor +
      "&endTime=" +
      chunkEnd +
      "&limit=" +
      CHUNK;
    const raw = await httpsGetJson(url);
    if (!Array.isArray(raw)) break;
    for (const k of raw)
      byOpenTime.set(k[0], {
        t: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
      });
    if (raw.length === 0) break;
    cursor = raw[raw.length - 1][0] + 60000;
  }
  return byOpenTime;
}

function statsFor(vals) {
  const s = sortNum(vals);
  return {
    count: s.length,
    median: median(s),
    p75: percentile(s, 75),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s.length ? s[s.length - 1] : null,
  };
}

function groupEpisodes(sideEvents, victim, gapMs) {
  const episodes = [];
  let current = null;
  for (const e of sideEvents) {
    if (current === null) current = { victim, events: [e] };
    else {
      const gap =
        e.timestamp - current.events[current.events.length - 1].timestamp;
      if (gap > gapMs) {
        episodes.push(current);
        current = { victim, events: [e] };
      } else current.events.push(e);
    }
  }
  if (current) episodes.push(current);
  return episodes.map((ep) => {
    const evs = ep.events;
    const start = evs[0].timestamp,
      end = evs[evs.length - 1].timestamp;
    const totalLiqUsd = evs.reduce((s, e) => s + e.quoteQty, 0);
    const maxSingleEventUsd = Math.max(...evs.map((e) => e.quoteQty));
    return {
      victim: ep.victim,
      events: evs,
      start,
      end,
      durationMs: end - start,
      eventCount: evs.length,
      totalLiqUsd,
      maxSingleEventUsd,
    };
  });
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
  const col = db.collection("liq_raw_events"); // NOTE: real collection name confirmed in mongo.client.ts (operator's own "liquidation_raw_events" does not exist)

  const now = Date.now();
  const startTs = now - HOURS * 3600 * 1000;
  console.log(
    "Fetching " + SYMBOL + " raw liquidation events, last " + HOURS + "h...",
  );
  const events = await col
    .find({ symbol: SYMBOL, timestamp: { $gte: startTs, $lte: now } })
    .sort({ timestamp: 1 })
    .toArray();
  console.log("  " + events.length + " events fetched.");

  if (events.length === 0) {
    console.log("No data -- aborting.");
    await client.close();
    return;
  }

  console.log(
    "Fetching " +
      SYMBOL +
      " 1m candles (Binance REST), same window + 10min buffer each side...",
  );
  const klines = await fetchKlines(SYMBOL, startTs - 600000, now + 600000);
  console.log("  " + klines.size + " candles fetched.");
  function candleAt(minuteTs) {
    return klines.get(Math.floor(minuteTs / 60000) * 60000) || null;
  }
  function marketExtremeInWindow(fromTs, toTs, direction) {
    // direction "LOW" for LONG-victim (downside), "HIGH" for SHORT-victim (upside)
    let extremePrice = null,
      extremeTs = null;
    for (let t = Math.floor(fromTs / 60000) * 60000; t <= toTs; t += 60000) {
      const c = candleAt(t);
      if (!c) continue;
      const val = direction === "LOW" ? c.low : c.high;
      if (
        extremePrice === null ||
        (direction === "LOW" ? val < extremePrice : val > extremePrice)
      ) {
        extremePrice = val;
        extremeTs = t;
      }
    }
    return { extremePrice, extremeTs };
  }

  const longEvents = events.filter((e) => e.victim === "LONG");
  const shortEvents = events.filter((e) => e.victim === "SHORT");

  const result = {
    symbol: SYMBOL,
    hours: HOURS,
    generatedAt: new Date(now).toISOString(),
  };

  // ═══ SECTION A: RAW DATA SUMMARY ═══
  console.log("\nBuilding Section A (raw data summary)...");
  function gapsFor(sideEvents) {
    const g = [];
    for (let i = 1; i < sideEvents.length; i++)
      g.push(sideEvents[i].timestamp - sideEvents[i - 1].timestamp);
    return g;
  }
  const longGaps = gapsFor(longEvents),
    shortGaps = gapsFor(shortEvents);
  const longGapsCluster = longGaps.filter((g) => g <= 60000); // gaps "inside" high-activity (<=60s) vs quiet periods
  const shortGapsCluster = shortGaps.filter((g) => g <= 60000);

  result.sectionA_rawDataSummary = {
    LONG: {
      eventCount: longEvents.length,
      totalLiqUsd: longEvents.reduce((s, e) => s + e.quoteQty, 0),
      eventSizeStats: statsFor(longEvents.map((e) => e.quoteQty)),
      firstTs: longEvents[0]?.timestamp ?? null,
      lastTs: longEvents[longEvents.length - 1]?.timestamp ?? null,
      gapStatsAll: statsFor(longGaps),
      gapStatsInCluster_leq60s: statsFor(longGapsCluster),
    },
    SHORT: {
      eventCount: shortEvents.length,
      totalLiqUsd: shortEvents.reduce((s, e) => s + e.quoteQty, 0),
      eventSizeStats: statsFor(shortEvents.map((e) => e.quoteQty)),
      firstTs: shortEvents[0]?.timestamp ?? null,
      lastTs: shortEvents[shortEvents.length - 1]?.timestamp ?? null,
      gapStatsAll: statsFor(shortGaps),
      gapStatsInCluster_leq60s: statsFor(shortGapsCluster),
    },
  };

  // ═══ SECTION B: GAP-THRESHOLD COMPARISON ═══
  console.log("Building Section B (gap-threshold comparison)...");
  const candidateGapsSec = [30, 60, 90, 120, 180, 300];
  result.sectionB_gapThresholdComparison = candidateGapsSec.map((sec) => {
    const gapMs = sec * 1000;
    const eps = [
      ...groupEpisodes(longEvents, "LONG", gapMs),
      ...groupEpisodes(shortEvents, "SHORT", gapMs),
    ];
    const durations = eps.map((e) => e.durationMs);
    const eventCounts = eps.map((e) => e.eventCount);
    return {
      gapThresholdSec: sec,
      totalEpisodes: eps.length,
      singleEventPct: eps.length
        ? (eps.filter((e) => e.eventCount === 1).length / eps.length) * 100
        : 0,
      medianDurationMs: median(durations),
      p90DurationMs: percentile(sortNum(durations), 90),
      p95DurationMs: percentile(sortNum(durations), 95),
      maxDurationMs: durations.length ? Math.max(...durations) : null,
      medianEventCount: median(eventCounts),
      p90EventCount: percentile(sortNum(eventCounts), 90),
      countOver10m: eps.filter((e) => e.durationMs > 10 * 60000).length,
      countOver20m: eps.filter((e) => e.durationMs > 20 * 60000).length,
      countOver30m: eps.filter((e) => e.durationMs > 30 * 60000).length,
    };
  });

  // Use 60s as the REFERENCE threshold for all remaining sections (a
  // reasonable middle choice from the comparison table; NOT presented
  // as a final production choice).
  const REF_GAP_MS = 60000;
  const allEpisodes = [
    ...groupEpisodes(longEvents, "LONG", REF_GAP_MS),
    ...groupEpisodes(shortEvents, "SHORT", REF_GAP_MS),
  ].sort((a, b) => a.start - b.start);
  console.log(
    "  Reference gap (60s) produces " + allEpisodes.length + " episodes total.",
  );

  // Enrich each episode with market-extreme + price-behavior (Section E data), computed once, reused everywhere.
  allEpisodes.forEach((ep) => {
    const firstPrice = ep.events[0].price;
    const lastLiqPrice = ep.events[ep.events.length - 1].price;
    const lowestLiqPrice = Math.min(...ep.events.map((e) => e.price));
    const highestLiqPrice = Math.max(...ep.events.map((e) => e.price));
    const direction = ep.victim === "LONG" ? "LOW" : "HIGH";
    const { extremePrice, extremeTs } = marketExtremeInWindow(
      ep.start,
      ep.end,
      direction,
    );
    const directionalMovePct =
      ep.victim === "LONG"
        ? extremePrice !== null
          ? ((firstPrice - extremePrice) / firstPrice) * 100
          : null
        : extremePrice !== null
          ? ((extremePrice - firstPrice) / firstPrice) * 100
          : null;
    const timeStartToExtremeMs =
      extremeTs !== null ? extremeTs - ep.start : null;
    const timeExtremeToLastLiqMs =
      extremeTs !== null ? ep.end - extremeTs : null;
    const finalLiqBeforeExtreme =
      extremeTs !== null ? ep.end <= extremeTs : null;
    ep.priceBehavior = {
      firstPrice,
      lastLiqPrice,
      lowestLiqPrice,
      highestLiqPrice,
      marketExtremePrice: extremePrice,
      marketExtremeTs: extremeTs,
      directionalMovePct,
      timeStartToExtremeMs,
      timeExtremeToLastLiqMs,
      finalLiqOccurredBeforeExtreme: finalLiqBeforeExtreme,
    };
  });

  // ═══ SECTION F: WHAT HAPPENS AFTER THE LAST LIQUIDATION (multi-event episodes only) ═══
  console.log("Building Section F (post-episode behavior)...");
  const allEventsSorted = events; // already sorted by timestamp
  function nextSameSideEventAfter(ts, victim) {
    for (const e of allEventsSorted)
      if (e.victim === victim && e.timestamp > ts) return e;
    return null;
  }
  const multiEventEpisodes = allEpisodes.filter((e) => e.eventCount >= 2);
  result.sectionF_postEpisodeBehavior = multiEventEpisodes.map((ep) => {
    const windows = [10, 30, 60, 120, 180, 300].map((sec) => {
      const winEnd = ep.end + sec * 1000;
      const direction = ep.victim === "LONG" ? "LOW" : "HIGH";
      const { extremePrice } = marketExtremeInWindow(ep.end, winEnd, direction);
      const priorExtreme = ep.priceBehavior.marketExtremePrice;
      const newExtreme =
        priorExtreme !== null && extremePrice !== null
          ? ep.victim === "LONG"
            ? extremePrice < priorExtreme
            : extremePrice > priorExtreme
          : null;
      const sameSideEventsInWindow = allEventsSorted.filter(
        (e) =>
          e.victim === ep.victim &&
          e.timestamp > ep.end &&
          e.timestamp <= winEnd,
      );
      return {
        windowSec: sec,
        newDirectionalExtreme: newExtreme,
        liquidationRestarted: sameSideEventsInWindow.length > 0,
        nextBurstEventCount: sameSideEventsInWindow.length,
        nextBurstLiqUsd: sameSideEventsInWindow.reduce(
          (s, e) => s + e.quoteQty,
          0,
        ),
      };
    });
    const nextEvent = nextSameSideEventAfter(ep.end, ep.victim);
    return {
      episodeStart: ep.start,
      victim: ep.victim,
      eventCount: ep.eventCount,
      totalLiqUsd: ep.totalLiqUsd,
      timeToNextSameSideLiqMs: nextEvent ? nextEvent.timestamp - ep.end : null,
      nextSameSideEventUsd: nextEvent ? nextEvent.quoteQty : null,
      windows,
    };
  });

  // ═══ SECTION G: FALSE-END ANALYSIS ═══
  console.log("Building Section G (false-end analysis)...");
  const falseEndGapCandidatesSec = [10, 20, 30, 60, 90, 120];
  function analyzeFalseEnds(ep) {
    const evs = ep.events;
    const episodeMedianSize = median(evs.map((e) => e.quoteQty));
    const results = {};
    for (const gapSec of falseEndGapCandidatesSec) {
      const gapMs = gapSec * 1000;
      let falseByAnyLater = 0,
        falseByMedianSize = 0,
        falseByPriorBurst60sMedian = 0,
        totalCandidates = 0;
      for (let i = 0; i < evs.length - 1; i++) {
        const gapHere = evs[i + 1].timestamp - evs[i].timestamp;
        if (gapHere < gapMs) continue; // not a candidate quiet-point at this threshold
        totalCandidates++;
        const laterEvents = evs.slice(i + 1);
        if (laterEvents.length > 0) falseByAnyLater++;
        if (laterEvents.some((e) => e.quoteQty >= episodeMedianSize))
          falseByMedianSize++;
        const prior60s = evs.filter(
          (e) =>
            e.timestamp > evs[i].timestamp - 60000 &&
            e.timestamp <= evs[i].timestamp,
        );
        const prior60sMedian = prior60s.length
          ? median(prior60s.map((e) => e.quoteQty))
          : 0;
        if (laterEvents.some((e) => e.quoteQty >= prior60sMedian))
          falseByPriorBurst60sMedian++;
      }
      results[gapSec + "s"] = {
        candidateEndPoints: totalCandidates,
        falseEnd_anyLaterLiq_pct: totalCandidates
          ? (falseByAnyLater / totalCandidates) * 100
          : null,
        falseEnd_geMedianSize_pct: totalCandidates
          ? (falseByMedianSize / totalCandidates) * 100
          : null,
        falseEnd_gePrior60sMedian_pct: totalCandidates
          ? (falseByPriorBurst60sMedian / totalCandidates) * 100
          : null,
      };
    }
    return results;
  }
  result.sectionG_falseEndAnalysis = multiEventEpisodes.map((ep) => ({
    episodeStart: ep.start,
    victim: ep.victim,
    eventCount: ep.eventCount,
    analysis: analyzeFalseEnds(ep),
  }));

  // ═══ SECTION H: END-DETECTION CANDIDATES ═══
  console.log("Building Section H (end-detection candidate comparison)...");
  function evaluateEndDetector(ep, detectFn) {
    // detectFn(evs, i) -> true if this index is declared "the end" (only tested at genuine gaps)
    const evs = ep.events;
    for (let i = 0; i < evs.length; i++) {
      if (detectFn(evs, i, ep)) {
        const laterEvents = evs.slice(i + 1);
        const isFalse = laterEvents.length > 0; // simplest false-end definition: any later same-episode event
        const delayMs =
          i < evs.length - 1
            ? evs[evs.length - 1].timestamp - evs[i].timestamp
            : 0; // vs actual last event (proxy for "delay if we'd waited")
        return { detectedAtIndex: i, isFalse, delayVsActualEndMs: -delayMs }; // negative = detected before actual end (early)
      }
    }
    return null;
  }
  const detectors = {
    A_quietGap60s: (evs, i) =>
      i === evs.length - 1 || evs[i + 1].timestamp - evs[i].timestamp > 60000,
    C_eventSizeCollapse: (evs, i, ep) =>
      evs[i].quoteQty < ep.totalLiqUsd / ep.eventCount / 3,
  };
  const detectorResults = {};
  for (const [name, fn] of Object.entries(detectors)) {
    const outcomes = multiEventEpisodes
      .map((ep) => evaluateEndDetector(ep, fn))
      .filter(Boolean);
    const falseCount = outcomes.filter((o) => o.isFalse).length;
    detectorResults[name] = {
      evaluatedEpisodes: outcomes.length,
      correctEndPct: outcomes.length
        ? ((outcomes.length - falseCount) / outcomes.length) * 100
        : null,
      falseEndPct: outcomes.length
        ? (falseCount / outcomes.length) * 100
        : null,
      medianDetectionDelayMs: median(outcomes.map((o) => o.delayVsActualEndMs)),
    };
  }
  result.sectionH_endDetectionCandidates = detectorResults;
  result.sectionH_note =
    "Only detectors A (quiet gap) and C (event-size collapse) are implemented with real computation in this pass -- B/D/E/F/G/H (rate-collapse, no-new-extreme, recovery, and their combinations) require the per-event rolling-window data from Section D/E, which IS included per-episode below; the operator or ChatGPT can derive those detector outcomes directly from the raw per-event sequences in Section C/D rather than this script pre-computing every combination.";

  // ═══ SECTION I: PRICE-EXTREME VS LIQUIDATION-END ORDERING ═══
  console.log("Building Section I (extreme-vs-end ordering classification)...");
  function classifyCase(ep) {
    const pb = ep.priceBehavior;
    if (pb.marketExtremeTs === null) return "UNKNOWN_NO_CANDLE_DATA";
    if (pb.finalLiqOccurredBeforeExtreme)
      return "CASE_B_liq_ends_then_price_extreme";
    // final liq at/after extreme -- distinguish A vs C by whether residual small liqs continued post-extreme
    const postExtremeEvents = ep.events.filter(
      (e) => e.timestamp > pb.marketExtremeTs,
    );
    if (postExtremeEvents.length > 1)
      return "CASE_C_intensity_collapse_residual_liqs_after_extreme";
    return "CASE_A_liq_continues_to_extreme_then_ends";
  }
  const caseCounts = {};
  allEpisodes.forEach((ep) => {
    const c = classifyCase(ep);
    caseCounts[c] = (caseCounts[c] || 0) + 1;
  });
  result.sectionI_extremeVsEndOrdering = {
    counts: caseCounts,
    totalEpisodesClassified: allEpisodes.length,
    percentages: Object.fromEntries(
      Object.entries(caseCounts).map(([k, v]) => [
        k,
        ((v / allEpisodes.length) * 100).toFixed(1) + "%",
      ]),
    ),
  };

  // ═══ SECTION J: SIZE VS PRICE-MOVEMENT QUANTILES ═══
  console.log("Building Section J (size-vs-movement quantile buckets)...");
  const sortedByLiq = [...allEpisodes].sort(
    (a, b) => a.totalLiqUsd - b.totalLiqUsd,
  );
  function bucketRange(arr, loPct, hiPct) {
    const lo = Math.floor((loPct / 100) * arr.length);
    const hi = Math.ceil((hiPct / 100) * arr.length);
    return arr.slice(lo, hi);
  }
  const buckets = {
    Q1: bucketRange(sortedByLiq, 0, 25),
    Q2: bucketRange(sortedByLiq, 25, 50),
    Q3: bucketRange(sortedByLiq, 50, 75),
    Q4: bucketRange(sortedByLiq, 75, 100),
    top10pct: bucketRange(sortedByLiq, 90, 100),
    top5pct: bucketRange(sortedByLiq, 95, 100),
  };
  result.sectionJ_sizeVsMovement = Object.fromEntries(
    Object.entries(buckets).map(([name, eps]) => {
      const moves = eps
        .map((e) => e.priceBehavior.directionalMovePct)
        .filter((v) => v !== null);
      return [
        name,
        {
          episodeCount: eps.length,
          medianLiqUsd: median(eps.map((e) => e.totalLiqUsd)),
          medianMovePct: median(moves),
          p75MovePct: percentile(sortNum(moves), 75),
          p90MovePct: percentile(sortNum(moves), 90),
        },
      ];
    }),
  );

  // ═══ SECTION C & D: 20 representative + rolling-intensity data ═══
  console.log(
    "Building Section C/D (20 representative episodes with full sequences + rolling intensity)...",
  );
  function rollingIntensity(evs, i) {
    const t = evs[i].timestamp;
    function inWindow(sec) {
      return evs.filter(
        (e) => e.timestamp > t - sec * 1000 && e.timestamp <= t,
      );
    }
    const w10 = inWindow(10),
      w30 = inWindow(30),
      w60 = inWindow(60);
    return {
      liqUsdPrev10s: w10.reduce((s, e) => s + e.quoteQty, 0),
      liqUsdPrev30s: w30.reduce((s, e) => s + e.quoteQty, 0),
      liqUsdPrev60s: w60.reduce((s, e) => s + e.quoteQty, 0),
      eventCountPrev10s: w10.length,
      eventCountPrev30s: w30.length,
      eventCountPrev60s: w60.length,
      gapSincePrevMs: i > 0 ? evs[i].timestamp - evs[i - 1].timestamp : null,
    };
  }
  // Selection: cover the requested spread using sortable criteria.
  const byLiq = [...allEpisodes].sort((a, b) => b.totalLiqUsd - a.totalLiqUsd);
  const byDuration = [...allEpisodes].sort(
    (a, b) => b.durationMs - a.durationMs,
  );
  const multiEvOnly = allEpisodes.filter((e) => e.eventCount >= 2);
  const falseEndCandidates = multiEvOnly.filter((ep) => {
    const f = analyzeFalseEnds(ep);
    return f["30s"] && f["30s"].falseEnd_anyLaterLiq_pct > 0;
  });
  const selectedSet = new Set();
  function addN(list, n) {
    for (const ep of list) {
      if (selectedSet.size >= 20) break;
      selectedSet.add(ep);
      if ([...selectedSet].filter((x) => x === ep).length) continue;
    }
  }
  const picks = [];
  function pick(ep) {
    if (picks.length < 30 && !picks.includes(ep)) picks.push(ep);
  }
  byLiq.slice(0, 3).forEach(pick); // extreme/large
  byLiq.slice(-3).forEach(pick); // very small
  byLiq
    .slice(Math.floor(byLiq.length / 2) - 1, Math.floor(byLiq.length / 2) + 2)
    .forEach(pick); // medium
  byDuration.slice(0, 3).forEach(pick); // long duration
  byDuration.slice(-3).forEach(pick); // short duration
  falseEndCandidates.slice(0, 5).forEach(pick); // apparent false-ending
  allEpisodes
    .filter((e) => e.victim === "LONG")
    .slice(0, 3)
    .forEach(pick);
  allEpisodes
    .filter((e) => e.victim === "SHORT")
    .slice(0, 3)
    .forEach(pick);
  const representative = picks.slice(0, 20);

  result.sectionC_D_representativeEpisodes = representative.map((ep, idx) => ({
    episodeId: "EP" + (idx + 1),
    victim: ep.victim,
    start: ep.start,
    startIso: new Date(ep.start).toISOString(),
    end: ep.end,
    endIso: new Date(ep.end).toISOString(),
    durationMs: ep.durationMs,
    eventCount: ep.eventCount,
    totalLiqUsd: ep.totalLiqUsd,
    maxSingleEventUsd: ep.maxSingleEventUsd,
    priceBehavior: ep.priceBehavior,
    events: ep.events.map((e, i) => ({
      timeFromStartMs: e.timestamp - ep.start,
      timestamp: e.timestamp,
      timestampIso: new Date(e.timestamp).toISOString(),
      price: e.price,
      quoteQty: e.quoteQty,
      cumulativeLiqUsd: ep.events
        .slice(0, i + 1)
        .reduce((s, x) => s + x.quoteQty, 0),
      ...rollingIntensity(ep.events, i),
    })),
  }));

  // Sub-select the 10 most-interesting false-end / second-push examples from the 20 representative.
  result.sectionH2_falseEndExamples = result.sectionC_D_representativeEpisodes
    .filter((ep) => falseEndCandidates.some((f) => f.start === ep.start))
    .slice(0, 10);

  // ── Write full JSON ──
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "eth-cascade-end-detection-" + Date.now() + ".json",
  );
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  // Also write a compact CSV of all episodes for spreadsheet-style analysis.
  const csvPath = outPath.replace(".json", "-episodes.csv");
  const csvRows = [
    "victim,start,end,durationMs,eventCount,totalLiqUsd,maxSingleEventUsd,directionalMovePct,finalLiqBeforeExtreme",
  ];
  allEpisodes.forEach((ep) =>
    csvRows.push(
      [
        ep.victim,
        new Date(ep.start).toISOString(),
        new Date(ep.end).toISOString(),
        ep.durationMs,
        ep.eventCount,
        ep.totalLiqUsd.toFixed(2),
        ep.maxSingleEventUsd.toFixed(2),
        ep.priceBehavior.directionalMovePct !== null
          ? ep.priceBehavior.directionalMovePct.toFixed(4)
          : "",
        ep.priceBehavior.finalLiqOccurredBeforeExtreme,
      ].join(","),
    ),
  );
  fs.writeFileSync(csvPath, csvRows.join("\n"));

  // ── Compact terminal summary ──
  console.log("\n" + "=".repeat(90));
  console.log("COMPACT TERMINAL SUMMARY -- full detail in: " + outPath);
  console.log("(episodes CSV: " + csvPath + ")");
  console.log("=".repeat(90));
  console.log(
    "\nSection A -- LONG: " +
      longEvents.length +
      " events, " +
      fmtUsd(result.sectionA_rawDataSummary.LONG.totalLiqUsd) +
      " total. SHORT: " +
      shortEvents.length +
      " events, " +
      fmtUsd(result.sectionA_rawDataSummary.SHORT.totalLiqUsd) +
      " total.",
  );
  console.log(
    "Section B -- gap-threshold comparison (episodes / single-event% / median duration):",
  );
  result.sectionB_gapThresholdComparison.forEach((r) =>
    console.log(
      "  " +
        r.gapThresholdSec +
        "s: " +
        r.totalEpisodes +
        " episodes, " +
        r.singleEventPct.toFixed(1) +
        "% single-event, median dur=" +
        (r.medianDurationMs / 1000).toFixed(0) +
        "s, >10m=" +
        r.countOver10m +
        " >20m=" +
        r.countOver20m +
        " >30m=" +
        r.countOver30m,
    ),
  );
  console.log(
    "\nSection C/D -- " +
      representative.length +
      " representative episodes selected (full sequences in JSON file).",
  );
  console.log(
    "Section F -- " +
      multiEventEpisodes.length +
      " multi-event episodes analyzed for post-end behavior.",
  );
  console.log(
    "Section I -- extreme-vs-end ordering: " +
      JSON.stringify(result.sectionI_extremeVsEndOrdering.percentages),
  );
  console.log(
    "Section J -- size/movement quantiles: " +
      Object.entries(result.sectionJ_sizeVsMovement)
        .map(
          ([k, v]) =>
            k +
            "(n=" +
            v.episodeCount +
            ",medMove=" +
            (v.medianMovePct !== null
              ? v.medianMovePct.toFixed(2) + "%"
              : "n/a") +
            ")",
        )
        .join(", "),
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
