// BTC CLEAN LIQUIDATION EPISODES -- foundation research, NOT the
// FINISHED detector. LONG and SHORT episodes built INDEPENDENTLY,
// using an EMPIRICALLY-DERIVED (not fixed) inter-event gap boundary
// per side. Percentile seriousness computed separately per side, both
// RETROSPECTIVE (full sample) and LIVE-AVAILABLE (causal, only prior
// episodes). OI+price recorded from episode START for every candidate,
// printed in full only for retained (>=P90) episodes.
//
//   node scripts/btc-clean-liquidation-episodes.js
//
// Uses ONLY liq_raw_events and oi_second_observations. No aggTrade,
// no taker flow, no order book, no ATR, no FINISHED-detector logic of
// any kind (no t-test/Page-Hinkley/CUSUM/kNN-trigger/fixed-recovery%).
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No
// files created. Text output only.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const DAYS_BACK = 3;
const MIN_LIVE_SAMPLE = 5; // minimum prior-episode count before a live-available percentile is reported

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtDate(ms) {
  return ms === null
    ? "N/A"
    : new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
function fmtPrice(n) {
  return n === null || n === undefined
    ? "N/A"
    : n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}
function fmtUsd(n) {
  return n === null || n === undefined
    ? "N/A"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtBtc(n) {
  return n === null || n === undefined
    ? "N/A"
    : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function fmtBtcDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}
function fmtLogPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(4)}%`;
}
function fmtSec(ms) {
  return ms === null ? "N/A" : `${(ms / 1000).toFixed(1)}s`;
}
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}
function percentileRank(sortedPop, x) {
  if (sortedPop.length === 0) return null;
  let count = 0;
  for (const v of sortedPop) if (v <= x) count++;
  return (count / sortedPop.length) * 100;
}
function priceAtOrBeforeIdx(obs, idx) {
  for (let k = idx; k >= 0; k--) {
    if (obs[k].price !== null) return obs[k].price;
  }
  return null;
}
function nearestObsIdxAtOrBefore(obs, targetMs, fromIdx = 0) {
  let best = -1;
  for (let k = fromIdx; k < obs.length; k++) {
    if (obs[k].ts <= targetMs) best = k;
    else break;
  }
  return best;
}

/** Empirical gap-boundary derivation: biggest proportional jump in
 *  the SORTED inter-event gap distribution, searched within the
 *  10th-95th percentile range (avoids degenerate extreme-edge jumps).
 *  Discloses exactly how the threshold was found. */
function deriveGapThreshold(gapsMs) {
  const sorted = [...gapsMs].sort((a, b) => a - b);
  const n = sorted.length;
  const searchLo = Math.max(1, Math.floor(n * 0.1));
  const searchHi = Math.min(n - 2, Math.floor(n * 0.95));
  let bestIdx = searchLo,
    bestRatio = 0;
  for (let i = searchLo; i <= searchHi; i++) {
    if (sorted[i] <= 0) continue;
    const ratio = sorted[i + 1] / sorted[i];
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestIdx = i;
    }
  }
  return {
    threshold: sorted[bestIdx],
    thresholdIdx: bestIdx,
    ratio: bestRatio,
    n,
    sorted,
  };
}

function buildEpisodes(events, gapThresholdMs) {
  const episodes = [];
  let cur = [events[0]];
  for (let i = 1; i < events.length; i++) {
    if (events[i].timestamp - events[i - 1].timestamp > gapThresholdMs) {
      episodes.push(cur);
      cur = [events[i]];
    } else cur.push(events[i]);
  }
  episodes.push(cur);
  return episodes.map((evs) => {
    const gaps = [];
    for (let i = 1; i < evs.length; i++)
      gaps.push(evs[i].timestamp - evs[i - 1].timestamp);
    return {
      events: evs,
      startTs: evs[0].timestamp,
      endTs: evs[evs.length - 1].timestamp,
      durationMs: evs[evs.length - 1].timestamp - evs[0].timestamp,
      eventCount: evs.length,
      totalUsd: evs.reduce((a, e) => a + (e.quoteQty ?? 0), 0),
      largestEvent: Math.max(...evs.map((e) => e.quoteQty ?? 0)),
      meanGapMs: gaps.length
        ? gaps.reduce((a, b) => a + b, 0) / gaps.length
        : null,
      medianGapMs: gaps.length
        ? percentile(
            [...gaps].sort((a, b) => a - b),
            50,
          )
        : null,
    };
  });
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  const rangeEndMs = Date.now();
  const rangeStartMs = rangeEndMs - DAYS_BACK * 86_400_000;

  const allLiq = await liqCol
    .find({
      symbol: SYMBOL,
      timestamp: { $gte: rangeStartMs, $lte: rangeEndMs },
    })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const allOiRaw = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: {
        $gte: new Date(rangeStartMs - 65000),
        $lte: new Date(rangeEndMs),
      },
    })
    .project({ timestamp: 1, openInterest: 1, price: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const allOi = allOiRaw.map((d) => ({
    ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
    contracts: d.openInterest,
    price: d.price,
  }));

  console.log("=".repeat(170));
  console.log(
    `DATASET SUMMARY -- ${isoUtc(rangeStartMs)} to ${isoUtc(rangeEndMs)}`,
  );
  console.log("=".repeat(170));
  const longEvents = allLiq.filter((e) => e.victim === "LONG");
  const shortEvents = allLiq.filter((e) => e.victim === "SHORT");
  console.log(`raw liquidation events: ${allLiq.length}`);
  console.log(`LONG events: ${longEvents.length}`);
  console.log(`SHORT events: ${shortEvents.length}`);

  if (allLiq.length === 0 || allOi.length < 100) {
    console.log("Insufficient data.");
    await client.close();
    return;
  }

  // ---- STEP 2: empirical gap-threshold derivation, LONG and SHORT separately ----
  const longGaps = [];
  for (let i = 1; i < longEvents.length; i++)
    longGaps.push(longEvents[i].timestamp - longEvents[i - 1].timestamp);
  const shortGaps = [];
  for (let i = 1; i < shortEvents.length; i++)
    shortGaps.push(shortEvents[i].timestamp - shortEvents[i - 1].timestamp);
  const longGapDerivation = deriveGapThreshold(longGaps);
  const shortGapDerivation = deriveGapThreshold(shortGaps);

  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "STEP 2 -- EMPIRICAL GAP-THRESHOLD DERIVATION (biggest proportional jump in sorted inter-event gaps, searched in the 10th-95th percentile range)",
  );
  console.log("=".repeat(170));
  console.log(
    `LONG:  N=${longGapDerivation.n} gaps. Biggest jump at sorted index ${longGapDerivation.thresholdIdx} (gap=${fmtSec(longGapDerivation.threshold)}), ratio to next=${longGapDerivation.ratio.toFixed(2)}x.`,
  );
  console.log(
    `       => LONG_GAP_THRESHOLD = ${fmtSec(longGapDerivation.threshold)}`,
  );
  console.log(
    `SHORT: N=${shortGapDerivation.n} gaps. Biggest jump at sorted index ${shortGapDerivation.thresholdIdx} (gap=${fmtSec(shortGapDerivation.threshold)}), ratio to next=${shortGapDerivation.ratio.toFixed(2)}x.`,
  );
  console.log(
    `       => SHORT_GAP_THRESHOLD = ${fmtSec(shortGapDerivation.threshold)}`,
  );

  const longEpisodesRaw = buildEpisodes(
    longEvents,
    longGapDerivation.threshold,
  );
  const shortEpisodesRaw = buildEpisodes(
    shortEvents,
    shortGapDerivation.threshold,
  );
  console.log(`\ndetected LONG episodes: ${longEpisodesRaw.length}`);
  console.log(`detected SHORT episodes: ${shortEpisodesRaw.length}`);

  // ---- OI + price for every candidate episode (recorded regardless of eventual percentile) ----
  async function enrichEpisode(ep, direction) {
    const startIdx = nearestObsIdxAtOrBefore(allOi, ep.startTs);
    const endIdx = nearestObsIdxAtOrBefore(allOi, ep.endTs);
    if (startIdx < 0 || endIdx < 0 || endIdx < startIdx)
      return { ...ep, direction, oiValid: false };
    const oiStart = allOi[startIdx].contracts,
      oiEnd = allOi[endIdx].contracts;
    let posOi = 0,
      negOi = 0;
    for (let k = startIdx + 1; k <= endIdx; k++) {
      const d = allOi[k].contracts - allOi[k - 1].contracts;
      if (d > 0) posOi += d;
      else negOi += d;
    }
    const priceStart = priceAtOrBeforeIdx(allOi, startIdx),
      priceEnd = priceAtOrBeforeIdx(allOi, endIdx);
    let maxAdverseLog = 0,
      maxFavorableLog = 0;
    if (priceStart !== null) {
      for (let k = startIdx; k <= endIdx; k++) {
        const p = priceAtOrBeforeIdx(allOi, k);
        if (p === null) continue;
        const lr = Math.log(p / priceStart);
        const adverseLr = direction === "LONG" ? -lr : lr; // LONG-liq adverse = price down; SHORT-liq adverse = price up
        if (adverseLr > maxAdverseLog) maxAdverseLog = adverseLr;
        if (-adverseLr > maxFavorableLog) maxFavorableLog = -adverseLr;
      }
    }
    const netPriceLog =
      priceStart !== null && priceEnd !== null
        ? Math.log(priceEnd / priceStart)
        : null;
    return {
      ...ep,
      direction,
      oiValid: true,
      oiStart,
      oiEnd,
      netOi: oiEnd - oiStart,
      posOi,
      negOi,
      grossOi: posOi - negOi,
      priceStart,
      priceEnd,
      netPriceLog,
      maxAdverseLog,
      maxFavorableLog,
    };
  }

  const longEpisodes = [];
  for (const ep of longEpisodesRaw)
    longEpisodes.push(await enrichEpisode(ep, "LONG"));
  const shortEpisodes = [];
  for (const ep of shortEpisodesRaw)
    shortEpisodes.push(await enrichEpisode(ep, "SHORT"));

  // ---- STEP 4/12: empirical distributions, LONG and SHORT separately ----
  function printDistribution(label, values) {
    const s = [...values].filter((v) => v !== null).sort((a, b) => a - b);
    console.log(
      `  ${label}: N=${s.length}  P50=${percentile(s, 50)?.toFixed(2)}  P75=${percentile(s, 75)?.toFixed(2)}  P90=${percentile(s, 90)?.toFixed(2)}  P95=${percentile(s, 95)?.toFixed(2)}  P99=${percentile(s, 99)?.toFixed(2)}`,
    );
  }
  console.log(`\n${"=".repeat(170)}`);
  console.log("STEP 12 -- EMPIRICAL EPISODE STATISTICS");
  console.log("=".repeat(170));
  console.log("\nLONG episodes:");
  printDistribution(
    "duration (ms)",
    longEpisodes.map((e) => e.durationMs),
  );
  printDistribution(
    "event count",
    longEpisodes.map((e) => e.eventCount),
  );
  printDistribution(
    "total liquidation USD",
    longEpisodes.map((e) => e.totalUsd),
  );
  printDistribution(
    "inter-event gap within episode (ms, mean)",
    longEpisodes.map((e) => e.meanGapMs),
  );
  console.log("\nSHORT episodes:");
  printDistribution(
    "duration (ms)",
    shortEpisodes.map((e) => e.durationMs),
  );
  printDistribution(
    "event count",
    shortEpisodes.map((e) => e.eventCount),
  );
  printDistribution(
    "total liquidation USD",
    shortEpisodes.map((e) => e.totalUsd),
  );
  printDistribution(
    "inter-event gap within episode (ms, mean)",
    shortEpisodes.map((e) => e.meanGapMs),
  );

  // ---- STEP 5/11: percentile seriousness -- retrospective + live-available ----
  function computePercentiles(episodes) {
    const totals = episodes.map((e) => e.totalUsd);
    const sortedTotals = [...totals].sort((a, b) => a - b);
    episodes.forEach((e) => {
      e.retrospectivePct = percentileRank(sortedTotals, e.totalUsd);
    });

    const byEnd = [...episodes].sort((a, b) => a.endTs - b.endTs);
    byEnd.forEach((e, idx) => {
      const priorTotals = byEnd
        .slice(0, idx)
        .filter((p) => p.endTs < e.endTs)
        .map((p) => p.totalUsd)
        .sort((a, b) => a - b);
      e.liveAvailablePct =
        priorTotals.length >= MIN_LIVE_SAMPLE
          ? percentileRank(priorTotals, e.totalUsd)
          : null;
      e.livePriorN = priorTotals.length;
    });
    episodes.forEach((e) => {
      e.isP90 = e.retrospectivePct >= 90;
      e.isP95 = e.retrospectivePct >= 95;
      e.isP99 = e.retrospectivePct >= 99;
    });
    return sortedTotals;
  }
  computePercentiles(longEpisodes);
  computePercentiles(shortEpisodes);

  console.log(`\n${"=".repeat(170)}`);
  console.log("STEP 5 -- COUNTS");
  console.log("=".repeat(170));
  for (const [label, eps] of [
    ["LONG", longEpisodes],
    ["SHORT", shortEpisodes],
  ]) {
    console.log(
      `${label}: total=${eps.length}  >=P90=${eps.filter((e) => e.isP90).length}  >=P95=${eps.filter((e) => e.isP95).length}  discarded(<P90)=${eps.filter((e) => !e.isP90).length}`,
    );
  }

  // ---- STEP 13: print every >=P90 episode ----
  function printStrongEpisode(e, idLabel) {
    console.log(`\n${idLabel}`);
    console.log(`Direction: ${e.direction}`);
    console.log(`Start: ${fmtDate(e.startTs)}`);
    console.log(`End: ${fmtDate(e.endTs)}`);
    console.log(`Duration: ${fmtSec(e.durationMs)}`);
    console.log(`Events: ${e.eventCount}`);
    console.log(`Total liquidation: ${fmtUsd(e.totalUsd)}`);
    console.log(`Largest event: ${fmtUsd(e.largestEvent)}`);
    console.log(`Retrospective percentile: ${e.retrospectivePct?.toFixed(2)}`);
    console.log(
      `Live-available percentile: ${e.liveAvailablePct !== null ? e.liveAvailablePct.toFixed(2) : `N/A (only ${e.livePriorN} prior episodes, need >=${MIN_LIVE_SAMPLE})`}`,
    );
    console.log(`\nPrice:`);
    console.log(`Start: ${fmtPrice(e.priceStart)}`);
    console.log(`End: ${fmtPrice(e.priceEnd)}`);
    console.log(`Move: ${fmtLogPct(e.netPriceLog)}`);
    console.log(
      `Max adverse: ${fmtLogPct(e.maxAdverseLog)}   Max favorable: ${fmtLogPct(e.maxFavorableLog)}`,
    );
    console.log(`\nOI:`);
    console.log(`Start: ${fmtBtc(e.oiStart)}`);
    console.log(`End: ${fmtBtc(e.oiEnd)}`);
    console.log(`Net ΔOI: ${fmtBtcDelta(e.netOi)}`);
    console.log(`Positive ΔOI: ${fmtBtcDelta(e.posOi)}`);
    console.log(`Negative ΔOI: ${fmtBtcDelta(e.negOi)}`);
    console.log(`Gross movement: ${fmtBtc(e.grossOi)}`);
    console.log(
      `\nClassification: ${e.isP99 ? "P99" : e.isP95 ? "P95" : "P90"}`,
    );
  }

  console.log(`\n${"=".repeat(170)}`);
  console.log("STEP 13 -- STRONG (>=P90) EPISODES");
  console.log("=".repeat(170));
  const strongLong = longEpisodes
    .filter((e) => e.isP90)
    .sort((a, b) => a.startTs - b.startTs);
  const strongShort = shortEpisodes
    .filter((e) => e.isP90)
    .sort((a, b) => a.startTs - b.startTs);
  console.log("\n--- LONG ---");
  strongLong.forEach((e, idx) =>
    printStrongEpisode(e, `EPISODE L${String(idx + 1).padStart(3, "0")}`),
  );
  console.log("\n--- SHORT ---");
  strongShort.forEach((e, idx) =>
    printStrongEpisode(e, `EPISODE S${String(idx + 1).padStart(3, "0")}`),
  );

  // ---- STEP 14: manual inspection cases ----
  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "STEP 14 -- MANUAL INSPECTION CASES (research cases only, NOT ranked as trading opportunities)",
  );
  console.log("=".repeat(170));
  function briefLine(e) {
    return `${e.direction} ${fmtDate(e.startTs)} -> ${fmtDate(e.endTs)}  total=${fmtUsd(e.totalUsd)}  pctile=${e.retrospectivePct?.toFixed(1)}  events=${e.eventCount}`;
  }

  console.log("\n3 strong LONG episodes:");
  [...strongLong]
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 3)
    .forEach((e) => console.log("  " + briefLine(e)));
  console.log("\n3 strong SHORT episodes:");
  [...strongShort]
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 3)
    .forEach((e) => console.log("  " + briefLine(e)));

  const allEpisodes = [...longEpisodes, ...shortEpisodes];
  console.log("\n3 episodes just below P90 (closest to threshold from below):");
  [...allEpisodes]
    .filter((e) => !e.isP90)
    .sort((a, b) => b.retrospectivePct - a.retrospectivePct)
    .slice(0, 3)
    .forEach((e) => console.log("  " + briefLine(e)));
  console.log("\n3 very small discarded episodes:");
  [...allEpisodes]
    .sort((a, b) => a.totalUsd - b.totalUsd)
    .slice(0, 3)
    .forEach((e) => console.log("  " + briefLine(e)));

  // ---- STEP 15: parameter audit ----
  console.log(`\n${"=".repeat(170)}`);
  console.log("STEP 15 -- PARAMETER AUDIT");
  console.log("=".repeat(170));
  const auditParams = [
    {
      name: "LONG_GAP_THRESHOLD",
      value: fmtSec(longGapDerivation.threshold),
      category: "MARKET STRUCTURE",
      why: "Boundary between 'same LONG burst' and 'separate LONG episode', derived from this run's own LONG inter-event gap distribution",
      derived:
        "DATA-DERIVED (biggest proportional jump in sorted gaps, 10th-95th percentile search range)",
    },
    {
      name: "SHORT_GAP_THRESHOLD",
      value: fmtSec(shortGapDerivation.threshold),
      category: "MARKET STRUCTURE",
      why: "Same, for SHORT episodes",
      derived: "DATA-DERIVED",
    },
    {
      name: "Gap-search range",
      value: "10th-95th percentile of sorted gaps",
      category: "STATISTICAL",
      why: "Avoids degenerate jumps at the extreme edges of the sorted gap array",
      derived: "FIXED (search-range convention, not itself a market magnitude)",
    },
    {
      name: "MIN_LIVE_SAMPLE",
      value: "5",
      category: "STATISTICAL",
      why: "Minimum prior-episode count before a live-available percentile is considered meaningful",
      derived: "FIXED",
    },
    {
      name: "P90/P95/P99 cut points",
      value: "90 / 95 / 99",
      category: "STATISTICAL",
      why: "Conventional percentile-rank labels for episode seriousness",
      derived: "FIXED (naming convention, not a market $ amount)",
    },
    {
      name: "Price/OI alignment rule",
      value: "nearest observation AT OR BEFORE target time",
      category: "DATA AVAILABILITY",
      why: "Causal alignment; never uses future data",
      derived: "FIXED (methodological rule, not a market magnitude)",
    },
    {
      name: "DAYS_BACK",
      value: "3 days",
      category: "DATA AVAILABILITY",
      why: "Historical range used for this run",
      derived: "FIXED",
    },
    {
      name: "Minimum event count per episode",
      value: "1 (none enforced separately)",
      category: "OPERATIONAL",
      why: "No separate minimum-size filter exists -- ALL clustering-derived episodes are kept as candidates; filtering happens ENTIRELY via the P90 percentile cut in Step 5, not via any additional hidden minimum-event/duration/USD rule",
      derived: "N/A -- explicitly absent by design",
    },
    {
      name: "Minimum liquidation USD per episode",
      value: "none enforced",
      category: "OPERATIONAL",
      why: "Same -- no fixed $ floor; weak episodes are removed only by the percentile filter",
      derived: "N/A -- explicitly absent by design",
    },
  ];
  console.log(
    "PARAMETER | VALUE | CATEGORY | WHY IT EXISTS | DATA-DERIVED OR FIXED",
  );
  console.log("-".repeat(170));
  auditParams.forEach((p) =>
    console.log(
      `${p.name} | ${p.value} | ${p.category} | ${p.why} | ${p.derived}`,
    ),
  );

  console.log(`\n${"=".repeat(170)}`);
  console.log("RUN COMPLETED SUCCESSFULLY");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
