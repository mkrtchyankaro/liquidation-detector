#!/usr/bin/env node
/*
 * BTC LIQUIDATION EPISODES V2 — ADAPTIVE MACRO EPISODES, READ ONLY
 *
 * Run from the project root:
 *   node scripts/btc-liquidation-episodes-v2.js
 *   node scripts/btc-liquidation-episodes-v2.js 2 2
 *
 * Arguments:
 *   1) outputDays   — recent days to print (default: 2)
 *   2) baselineDays — trailing causal history for percentile ranks (default: 2)
 *
 * There are no fixed seconds/minutes, liquidation-USD, OI-percent, ATR, or
 * intensity thresholds in the market rules.
 *
 * Segmentation has two adaptive levels:
 *   1. A three-regime model fitted to log inter-event gaps across BOTH victim
 *      sides learns micro-burst cadence, pauses inside a broader episode, and
 *      true quiet gaps between episodes. Opposite-side events therefore do not
 *      split one market episode.
 *   2. A two-regime model fitted to completed episode durations separates
 *      short pulses from macro episodes. Only the learned macro-duration regime
 *      is printed/ranked, so isolated seconds-long pulses do not pollute the
 *      episode baseline.
 *
 * OI is measured in contracts (openInterest), not openInterestUsd, because the
 * latter also changes when price changes. The episode end is extended from the
 * last visible forceOrder to the OI trough inside the history-learned quiet-gap
 * envelope. A positive post-trough regression slope marks OI recovery; no
 * fixed recovery magnitude or waiting time is used.
 *
 * P70/P75/P90/P95 are causal. Episode T is compared only with completed,
 * non-left-censored macro episodes of the same dominant victim side in the
 * trailing baseline interval before T.
 *
 * Collections:
 *   liquidation_detector.liq_raw_events
 *   liquidation_detector.oi_second_observations
 *
 * The script only reads MongoDB. It never writes, updates, deletes, creates an
 * index, or calls Binance.
 */

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const VICTIMS = ["LONG", "SHORT"];
const DISPLAY_PERCENTILES = [70, 75, 90, 95];
const DAY_MS = 24 * 60 * 60 * 1000;

function usageError(message) {
  throw new Error(
    `${message}\nUsage: node scripts/btc-liquidation-episodes-v2.js [outputDays=2] [baselineDays=2]`,
  );
}

function parsePositiveNumber(raw, name, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    usageError(`${name} must be positive; received ${raw}`);
  }
  return value;
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "N/A";
}

function fmtUsd(value) {
  if (!Number.isFinite(value)) return "N/A";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtPct(value, digits = 4) {
  if (!Number.isFinite(value)) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function fmtRank(value) {
  return Number.isFinite(value) ? `P${value.toFixed(1)}` : "N/A";
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "N/A";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(2)}m`;
  return `${(minutes / 60).toFixed(2)}h`;
}

function quantile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

function percentileRank(sortedValues, value) {
  if (sortedValues.length === 0 || !Number.isFinite(value)) return null;
  let lo = 0;
  let hi = sortedValues.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sortedValues[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  const firstEqual = lo;
  hi = sortedValues.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sortedValues[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  const afterEqual = lo;
  return ((firstEqual + 0.5 * (afterEqual - firstEqual)) / sortedValues.length) * 100;
}

function percentileTier(rank) {
  if (!Number.isFinite(rank)) return "UNRANKED";
  if (rank >= 95) return "P95";
  if (rank >= 90) return "P90";
  if (rank >= 75) return "P75";
  if (rank >= 70) return "P70";
  return "<P70";
}

function lowerBoundByTs(items, targetMs) {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (items[mid].ts < targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundByTs(items, targetMs) {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (items[mid].ts <= targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nearestObservationAtOrBefore(observations, targetMs) {
  const index = upperBoundByTs(observations, targetMs) - 1;
  return index >= 0 ? observations[index] : null;
}

/** Deterministic one-dimensional k-means. Values must be finite. */
function kmeans1d(values, k) {
  if (values.length < k) return { ok: false, reason: `fewer than ${k} observations` };
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted[0] === sorted[sorted.length - 1]) {
    return { ok: false, reason: "all observations are identical" };
  }

  let centers = Array.from({ length: k }, (_, index) =>
    quantile(sorted, ((index + 0.5) / k) * 100),
  );
  let assignments = new Int16Array(values.length).fill(-1);

  for (;;) {
    let changed = false;
    const sums = new Array(k).fill(0);
    const counts = new Array(k).fill(0);
    const nextAssignments = new Int16Array(values.length);

    for (let i = 0; i < values.length; i += 1) {
      let best = 0;
      let bestDistance = Math.abs(values[i] - centers[0]);
      for (let cluster = 1; cluster < k; cluster += 1) {
        const distance = Math.abs(values[i] - centers[cluster]);
        if (distance < bestDistance) {
          best = cluster;
          bestDistance = distance;
        }
      }
      nextAssignments[i] = best;
      if (best !== assignments[i]) changed = true;
      sums[best] += values[i];
      counts[best] += 1;
    }

    if (counts.some((count) => count === 0)) {
      return { ok: false, reason: `${k}-state clustering collapsed` };
    }

    const nextCenters = centers.map((_, cluster) => sums[cluster] / counts[cluster]);
    const unchanged = nextCenters.every((center, index) => center === centers[index]);
    centers = nextCenters;
    assignments = nextAssignments;
    if (!changed || unchanged) break;
  }

  const order = centers
    .map((center, oldIndex) => ({ center, oldIndex }))
    .sort((a, b) => a.center - b.center);
  const oldToNew = new Map(order.map((entry, newIndex) => [entry.oldIndex, newIndex]));
  return {
    ok: true,
    centers: order.map((entry) => entry.center),
    assignments: Int16Array.from(assignments, (oldIndex) => oldToNew.get(oldIndex)),
    counts: order.map((entry) => {
      let count = 0;
      for (const assignment of assignments) if (assignment === entry.oldIndex) count += 1;
      return count;
    }),
  };
}

function learnGapRegimes(events) {
  const gaps = [];
  for (let i = 1; i < events.length; i += 1) {
    const gapMs = events[i].ts - events[i - 1].ts;
    if (gapMs > 0) gaps.push(gapMs);
  }
  const model = kmeans1d(gaps.map((gap) => Math.log1p(gap)), 3);
  if (!model.ok) return { ...model, gaps };

  const centersMs = model.centers.map((center) => Math.expm1(center));
  return {
    ok: true,
    gaps,
    centersMs,
    counts: model.counts,
    microBoundaryMs: Math.expm1((model.centers[0] + model.centers[1]) / 2),
    episodeBoundaryMs: Math.expm1((model.centers[1] + model.centers[2]) / 2),
  };
}

function groupEvents(events, gapModel, dataEndMs) {
  if (events.length === 0) return [];
  const groups = [];
  let current = [events[0]];

  for (let i = 1; i < events.length; i += 1) {
    if (events[i].ts - events[i - 1].ts > gapModel.episodeBoundaryMs) {
      groups.push(current);
      current = [events[i]];
    } else {
      current.push(events[i]);
    }
  }
  groups.push(current);

  return groups.map((episodeEvents, index) => {
    const first = episodeEvents[0];
    const last = episodeEvents[episodeEvents.length - 1];
    let microBurstCount = 1;
    for (let i = 1; i < episodeEvents.length; i += 1) {
      if (episodeEvents[i].ts - episodeEvents[i - 1].ts > gapModel.microBoundaryMs) {
        microBurstCount += 1;
      }
    }

    const longLiqUsd = episodeEvents.reduce(
      (sum, event) => sum + (event.victim === "LONG" ? event.usd : 0),
      0,
    );
    const shortLiqUsd = episodeEvents.reduce(
      (sum, event) => sum + (event.victim === "SHORT" ? event.usd : 0),
      0,
    );
    const dominantVictim = longLiqUsd >= shortLiqUsd ? "LONG" : "SHORT";
    const totalLiqUsd = longLiqUsd + shortLiqUsd;
    const dominantLiqUsd = Math.max(longLiqUsd, shortLiqUsd);
    const nextStartAt = groups[index + 1]?.[0]?.ts ?? null;

    return {
      events: episodeEvents,
      firstEventAt: first.ts,
      lastEventAt: last.ts,
      nextStartAt,
      leftCensored: index === 0,
      isOpen: nextStartAt === null && dataEndMs - last.ts <= gapModel.episodeBoundaryMs,
      eventCount: episodeEvents.length,
      microBurstCount,
      longLiqUsd,
      shortLiqUsd,
      totalLiqUsd,
      dominantVictim,
      dominantLiqUsd,
      dominantSharePct: totalLiqUsd > 0 ? (dominantLiqUsd / totalLiqUsd) * 100 : null,
      startPrice: first.price,
      lastEventPrice: last.price,
    };
  });
}

function linearSlope(points) {
  if (points.length < 2) return null;
  const origin = points[0].ts;
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += (point.ts - origin) / 1000;
    sumY += point.openInterest;
  }
  const meanX = sumX / points.length;
  const meanY = sumY / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const x = (point.ts - origin) / 1000;
    numerator += (x - meanX) * (point.openInterest - meanY);
    denominator += (x - meanX) ** 2;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function attachOi(episode, observations, learnedQuietGapMs, dataEndMs) {
  const startObservation = nearestObservationAtOrBefore(observations, episode.firstEventAt);
  const envelopeEndAt = Math.min(
    dataEndMs,
    episode.nextStartAt ?? Number.POSITIVE_INFINITY,
    episode.lastEventAt + learnedQuietGapMs,
  );
  const fromIndex = lowerBoundByTs(observations, episode.firstEventAt);
  const toIndexExclusive = upperBoundByTs(observations, envelopeEndAt);
  const path = observations.slice(fromIndex, toIndexExclusive);

  if (!startObservation || path.length === 0 || !(startObservation.openInterest > 0)) {
    return {
      ...episode,
      endAt: episode.lastEventAt,
      endPrice: episode.lastEventPrice,
      endBasis: "LAST_FORCE_ORDER_NO_OI",
      oiAvailable: false,
      startOi: startObservation?.openInterest ?? null,
      minOi: null,
      minOiAt: null,
      endOi: null,
      oiDrawdownPct: null,
      oiNetChangePct: null,
      oiRecoveryConfirmed: false,
      recoverySlopeOiPerSecond: null,
      liqToStartOiUsdPct: null,
    };
  }

  let minimumIndex = 0;
  for (let i = 1; i < path.length; i += 1) {
    if (path[i].openInterest < path[minimumIndex].openInterest) minimumIndex = i;
  }
  const minimum = path[minimumIndex];
  const postTrough = path.slice(minimumIndex);
  const recoverySlope = linearSlope(postTrough);
  const recoveryConfirmed = Number.isFinite(recoverySlope) && recoverySlope > 0;
  const endAt = Math.max(episode.lastEventAt, minimum.ts);
  const endObservation = nearestObservationAtOrBefore(observations, endAt);
  const endOi = endObservation?.openInterest ?? null;
  const oiDrawdownPct = Math.max(
    0,
    ((startObservation.openInterest - minimum.openInterest) / startObservation.openInterest) * 100,
  );
  const oiNetChangePct =
    Number.isFinite(endOi) && startObservation.openInterest > 0
      ? ((endOi - startObservation.openInterest) / startObservation.openInterest) * 100
      : null;
  const startOiUsd = startObservation.openInterestUsd;

  return {
    ...episode,
    endAt,
    endPrice: endObservation?.price ?? episode.lastEventPrice,
    endBasis:
      minimum.ts > episode.lastEventAt
        ? recoveryConfirmed
          ? "OI_TROUGH_RECOVERY"
          : "OI_TROUGH_UNCONFIRMED"
        : "LAST_FORCE_ORDER",
    oiAvailable: true,
    startOi: startObservation.openInterest,
    startOiUsd,
    minOi: minimum.openInterest,
    minOiAt: minimum.ts,
    endOi,
    oiDrawdownPct,
    oiNetChangePct,
    oiRecoveryConfirmed: recoveryConfirmed,
    recoverySlopeOiPerSecond: recoverySlope,
    liqToStartOiUsdPct:
      Number.isFinite(startOiUsd) && startOiUsd > 0
        ? (episode.dominantLiqUsd / startOiUsd) * 100
        : null,
  };
}

function learnDurationRegimes(episodes) {
  const eligible = episodes.filter(
    (episode) => !episode.leftCensored && !episode.isOpen && episode.endAt > episode.firstEventAt,
  );
  const logs = eligible.map((episode) => Math.log1p(episode.endAt - episode.firstEventAt));
  const model = kmeans1d(logs, 2);
  if (!model.ok) return model;
  return {
    ok: true,
    shortCenterMs: Math.expm1(model.centers[0]),
    macroCenterMs: Math.expm1(model.centers[1]),
    boundaryMs: Math.expm1((model.centers[0] + model.centers[1]) / 2),
    shortCount: model.counts[0],
    macroCount: model.counts[1],
  };
}

function addCausalRanks(episode, macroEpisodes, baselineMs) {
  const baseline = macroEpisodes.filter(
    (candidate) =>
      candidate.dominantVictim === episode.dominantVictim &&
      !candidate.leftCensored &&
      !candidate.isOpen &&
      candidate.endAt < episode.firstEventAt &&
      candidate.firstEventAt >= episode.firstEventAt - baselineMs,
  );
  const liqValues = baseline
    .map((candidate) => candidate.dominantLiqUsd)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const oiValues = baseline
    .map((candidate) => candidate.oiDrawdownPct)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const liqRank = percentileRank(liqValues, episode.dominantLiqUsd);
  const oiRank = percentileRank(oiValues, episode.oiDrawdownPct);
  const jointRank =
    Number.isFinite(liqRank) && Number.isFinite(oiRank) ? Math.min(liqRank, oiRank) : null;
  const thresholds = {};
  for (const percentile of DISPLAY_PERCENTILES) {
    thresholds[`p${percentile}`] = {
      liqUsd: quantile(liqValues, percentile),
      oiDrawdownPct: quantile(oiValues, percentile),
    };
  }
  return {
    ...episode,
    baselineEpisodeCount: baseline.length,
    baselineLiqCount: liqValues.length,
    baselineOiCount: oiValues.length,
    liqRank,
    oiRank,
    jointRank,
    tier: percentileTier(jointRank),
    thresholds,
  };
}

function priceMovePct(startPrice, endPrice) {
  return Number.isFinite(startPrice) && startPrice > 0 && Number.isFinite(endPrice)
    ? ((endPrice - startPrice) / startPrice) * 100
    : null;
}

function printEpisode(episode, index) {
  console.log("-".repeat(154));
  console.log(
    `#${String(index + 1).padStart(2, "0")}  ${episode.dominantVictim.padEnd(5)}  ${episode.tier.padEnd(8)}  ${episode.isOpen ? "OPEN" : "CLOSED"}`,
  );
  console.log(`    START: ${iso(episode.firstEventAt)}  price=${episode.startPrice ?? "N/A"}`);
  console.log(
    `    END:   ${iso(episode.endAt)}  price=${episode.endPrice ?? "N/A"}  duration=${fmtDuration(episode.endAt - episode.firstEventAt)}  basis=${episode.endBasis}`,
  );
  console.log(
    `    LIQ:   dominant=${fmtUsd(episode.dominantLiqUsd)} (${fmtPct(episode.dominantSharePct, 1)} share)  total=${fmtUsd(episode.totalLiqUsd)}  LONG=${fmtUsd(episode.longLiqUsd)}  SHORT=${fmtUsd(episode.shortLiqUsd)}`,
  );
  console.log(
    `    FLOW:  events=${episode.eventCount}  microBursts=${episode.microBurstCount}  liqRank=${fmtRank(episode.liqRank)}  priceMove=${fmtPct(priceMovePct(episode.startPrice, episode.endPrice))}`,
  );
  console.log(
    `    OI:    start=${episode.startOi ?? "N/A"}  min=${episode.minOi ?? "N/A"}  drawdown=${fmtPct(episode.oiDrawdownPct)}  net=${fmtPct(episode.oiNetChangePct)}  oiRank=${fmtRank(episode.oiRank)}  recovery=${episode.oiRecoveryConfirmed ? "YES" : "NO"}`,
  );
  console.log(
    `    JOINT: ${fmtRank(episode.jointRank)} => ${episode.tier}  baselineN=${episode.baselineEpisodeCount}  dominantLiq/startOIUsd=${fmtPct(episode.liqToStartOiUsdPct)}`,
  );
  const thresholdText = DISPLAY_PERCENTILES.map((percentile) => {
    const threshold = episode.thresholds[`p${percentile}`];
    return `P${percentile}[liq=${fmtUsd(threshold.liqUsd)}, oiDrop=${fmtPct(threshold.oiDrawdownPct)}]`;
  }).join("  ");
  console.log(`    CAUSAL THRESHOLDS: ${thresholdText}`);
  if (episode.leftCensored) {
    console.log("    NOTE: LEFT_CENSORED — history starts inside this episode; excluded from later baselines.");
  }
  if (episode.isOpen) {
    console.log("    NOTE: RIGHT_CENSORED — the learned quiet-gap regime has not completed.");
  }
}

async function firstAndLast(collection, filter, sortField) {
  const [first] = await collection
    .find(filter)
    .project({ [sortField]: 1 })
    .sort({ [sortField]: 1 })
    .limit(1)
    .toArray();
  const [last] = await collection
    .find(filter)
    .project({ [sortField]: 1 })
    .sort({ [sortField]: -1 })
    .limit(1)
    .toArray();
  return {
    firstMs: first ? toMs(first[sortField]) : null,
    lastMs: last ? toMs(last[sortField]) : null,
  };
}

async function main() {
  const outputDays = parsePositiveNumber(process.argv[2], "outputDays", 2);
  const baselineDays = parsePositiveNumber(process.argv[3], "baselineDays", 2);
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");

  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const liqCollection = db.collection("liq_raw_events");
    const oiCollection = db.collection("oi_second_observations");

    const [liqCoverage, oiCoverage] = await Promise.all([
      firstAndLast(liqCollection, { symbol: SYMBOL }, "timestamp"),
      firstAndLast(oiCollection, { symbol: SYMBOL }, "timestamp"),
    ]);
    if (!Number.isFinite(liqCoverage.firstMs) || !Number.isFinite(liqCoverage.lastMs)) {
      throw new Error(`No ${SYMBOL} data in liq_raw_events`);
    }
    if (!Number.isFinite(oiCoverage.firstMs) || !Number.isFinite(oiCoverage.lastMs)) {
      throw new Error(`No ${SYMBOL} data in oi_second_observations`);
    }

    const dataEndMs = Math.max(liqCoverage.lastMs, oiCoverage.lastMs);
    const outputStartMs = dataEndMs - outputDays * DAY_MS;
    const baselineMs = baselineDays * DAY_MS;

    console.log("=".repeat(154));
    console.log(`${SYMBOL} ADAPTIVE MACRO LIQUIDATION EPISODES V2 — READ ONLY`);
    console.log(`Output interval:  ${iso(outputStartMs)} -> ${iso(dataEndMs)} (${outputDays}d)`);
    console.log(`Causal baseline: trailing ${baselineDays}d before each macro episode`);
    console.log(`Liquidation data: ${iso(liqCoverage.firstMs)} -> ${iso(liqCoverage.lastMs)}`);
    console.log(`OI-second data:   ${iso(oiCoverage.firstMs)} -> ${iso(oiCoverage.lastMs)}`);
    console.log("=".repeat(154));

    const [rawLiquidations, rawOi] = await Promise.all([
      liqCollection
        .find({
          symbol: SYMBOL,
          timestamp: { $gte: liqCoverage.firstMs, $lte: dataEndMs },
          victim: { $in: VICTIMS },
        })
        .project({ timestamp: 1, victim: 1, quoteQty: 1, price: 1 })
        .sort({ timestamp: 1 })
        .toArray(),
      oiCollection
        .find({
          symbol: SYMBOL,
          timestamp: { $gte: new Date(oiCoverage.firstMs), $lte: new Date(dataEndMs) },
        })
        .project({ timestamp: 1, oiUpdatedAt: 1, openInterest: 1, openInterestUsd: 1, price: 1 })
        .sort({ timestamp: 1 })
        .toArray(),
    ]);

    const liquidations = rawLiquidations
      .map((doc) => ({
        ts: toMs(doc.timestamp),
        victim: doc.victim,
        usd: finiteNumber(doc.quoteQty),
        price: finiteNumber(doc.price),
      }))
      .filter(
        (event) =>
          Number.isFinite(event.ts) &&
          VICTIMS.includes(event.victim) &&
          Number.isFinite(event.usd) &&
          event.usd >= 0,
      )
      .sort((a, b) => a.ts - b.ts);
    const observations = rawOi
      .map((doc) => ({
        ts: toMs(doc.timestamp),
        oiUpdatedAt: toMs(doc.oiUpdatedAt),
        openInterest: finiteNumber(doc.openInterest),
        openInterestUsd: finiteNumber(doc.openInterestUsd),
        price: finiteNumber(doc.price),
      }))
      .filter(
        (observation) =>
          Number.isFinite(observation.ts) &&
          Number.isFinite(observation.openInterest) &&
          observation.openInterest > 0,
      )
      .sort((a, b) => a.ts - b.ts);
    console.log(`Loaded ${liquidations.length} liquidation events and ${observations.length} OI observations.\n`);
    if (liquidations.length === 0 || observations.length === 0) {
      throw new Error("No valid normalized data");
    }

    const gapModel = learnGapRegimes(liquidations);
    if (!gapModel.ok) {
      throw new Error(`Cannot learn three event-gap regimes: ${gapModel.reason}`);
    }
    console.log(
      `LEARNED EVENT CADENCE: micro=${fmtDuration(gapModel.centersMs[0])} (N=${gapModel.counts[0]}), inside-episode pause=${fmtDuration(gapModel.centersMs[1])} (N=${gapModel.counts[1]}), between-episode quiet=${fmtDuration(gapModel.centersMs[2])} (N=${gapModel.counts[2]})`,
    );
    console.log(
      `LEARNED BOUNDARIES: micro-burst=${fmtDuration(gapModel.microBoundaryMs)}, episode quiet-gap=${fmtDuration(gapModel.episodeBoundaryMs)}`,
    );

    const rawEpisodes = groupEvents(liquidations, gapModel, dataEndMs).map((episode) =>
      attachOi(episode, observations, gapModel.episodeBoundaryMs, dataEndMs),
    );
    const durationModel = learnDurationRegimes(rawEpisodes);
    if (!durationModel.ok) {
      throw new Error(`Cannot learn short-vs-macro duration regimes: ${durationModel.reason}`);
    }
    console.log(
      `LEARNED DURATION REGIMES: short-center=${fmtDuration(durationModel.shortCenterMs)} (N=${durationModel.shortCount}), macro-center=${fmtDuration(durationModel.macroCenterMs)} (N=${durationModel.macroCount}), boundary=${fmtDuration(durationModel.boundaryMs)}`,
    );

    const macroEpisodes = rawEpisodes.filter(
      (episode) => episode.endAt - episode.firstEventAt > durationModel.boundaryMs,
    );
    const ranked = macroEpisodes.map((episode) => addCausalRanks(episode, macroEpisodes, baselineMs));
    const recent = ranked.filter(
      (episode) => episode.firstEventAt >= outputStartMs && episode.firstEventAt <= dataEndMs,
    );

    console.log(
      `\nBuilt ${rawEpisodes.length} broad candidates; ${macroEpisodes.length} are in the learned macro-duration regime; printing ${recent.length} recent macro episode(s).`,
    );
    if (recent.length === 0) {
      console.log("No learned macro episode begins inside the requested output interval.");
      return;
    }
    recent.forEach(printEpisode);

    const strongest = recent
      .filter((episode) => Number.isFinite(episode.jointRank))
      .sort((a, b) => b.jointRank - a.jointRank || b.dominantLiqUsd - a.dominantLiqUsd);
    console.log(`\n${"=".repeat(154)}`);
    console.log("STRONGEST RECENT MACRO EPISODES — JOINT = min(dominant-side liquidation rank, OI-drawdown rank)");
    console.log("=".repeat(154));
    for (const episode of strongest) {
      console.log(
        `${episode.tier.padEnd(5)} ${fmtRank(episode.jointRank).padEnd(7)} ${episode.dominantVictim.padEnd(5)} ${iso(episode.firstEventAt)} -> ${iso(episode.endAt)}  duration=${fmtDuration(episode.endAt - episode.firstEventAt)}  liq=${fmtUsd(episode.dominantLiqUsd)}  oiDrop=${fmtPct(episode.oiDrawdownPct)}  bursts=${episode.microBurstCount}  baselineN=${episode.baselineEpisodeCount}`,
      );
    }

    const tierCounts = new Map();
    for (const episode of recent) tierCounts.set(episode.tier, (tierCounts.get(episode.tier) ?? 0) + 1);
    console.log("\nRECENT TIER COUNTS:");
    for (const tier of ["UNRANKED", "<P70", "P70", "P75", "P90", "P95"]) {
      console.log(`  ${tier.padEnd(8)} ${tierCounts.get(tier) ?? 0}`);
    }
    console.log("\nNOTES:");
    console.log("  LONG/SHORT means the dominant liquidated victim side across the entire macro episode, not the side of its first event.");
    console.log("  A high JOINT tier requires both extreme visible forced liquidation and extreme OI clearing versus prior same-side macro episodes.");
    console.log("  Binance forceOrder is a throttled snapshot feed; liquidation totals are visible lower-bound flow, not guaranteed complete market totals.");
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(
    `\n[BTC_EPISODE_V2_FAILED] ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
