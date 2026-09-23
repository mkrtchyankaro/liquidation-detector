#!/usr/bin/env node

/*
 * BTC LIQUIDATION EPISODES — HISTORY-DRIVEN, READ-ONLY
 *
 * Run:
 *   node scripts/btc-liquidation-episodes-adaptive.js
 *   node scripts/btc-liquidation-episodes-adaptive.js 2 2
 *
 * Arguments:
 *   1) outputDays   — recent days to display
 *   2) baselineDays — trailing history used for causal percentiles
 *
 * No fixed seconds, liquidation USD, OI percentage or intensity
 * threshold is used for episode boundaries.
 */

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const VICTIMS = ["LONG", "SHORT"];
const DISPLAY_PERCENTILES = [70, 75, 90, 95];
const DAY_MS = 24 * 60 * 60 * 1000;

function usageError(message) {
  throw new Error(
    `${message}\nUsage: node scripts/btc-liquidation-episodes-adaptive.js [outputDays=2] [baselineDays=2]`,
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

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

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

  if (abs >= 1_000_000_000) {
    return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  }

  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  }

  if (abs >= 1_000) {
    return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  }

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

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = seconds / 60;

  if (minutes < 60) {
    return `${minutes.toFixed(2)}m`;
  }

  return `${(minutes / 60).toFixed(2)}h`;
}

function quantile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];

  const position = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = position - lower;

  return (
    sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight
  );
}

/**
 * Mid-rank empirical percentile.
 * Equal values receive the same percentile rank.
 */
function percentileRank(sortedValues, value) {
  if (sortedValues.length === 0 || !Number.isFinite(value)) {
    return null;
  }

  let less = 0;
  let equal = 0;

  for (const candidate of sortedValues) {
    if (candidate < value) {
      less += 1;
    } else if (candidate === value) {
      equal += 1;
    } else {
      break;
    }
  }

  return ((less + 0.5 * equal) / sortedValues.length) * 100;
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
  let low = 0;
  let high = items.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (items[middle].ts < targetMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function upperBoundByTs(items, targetMs) {
  let low = 0;
  let high = items.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (items[middle].ts <= targetMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function nearestObservationAtOrBefore(observations, targetMs) {
  const index = upperBoundByTs(observations, targetMs) - 1;
  return index >= 0 ? observations[index] : null;
}

/**
 * Learns two natural gap states from history:
 *
 * 1. Short gaps inside the same episode.
 * 2. Long gaps between separate episodes.
 *
 * No fixed number of seconds is used.
 */
function learnGapModel(events, victim) {
  const gaps = [];

  for (let index = 1; index < events.length; index += 1) {
    const gapMs = events[index].ts - events[index - 1].ts;

    if (gapMs > 0) {
      gaps.push(gapMs);
    }
  }

  if (gaps.length < 2) {
    return {
      ok: false,
      victim,
      reason: "fewer than two positive inter-event gaps",
    };
  }

  const logs = gaps.map((gapMs) => Math.log1p(gapMs));

  let lowCenter = Math.min(...logs);
  let highCenter = Math.max(...logs);

  if (lowCenter === highCenter) {
    return {
      ok: false,
      victim,
      reason: "all inter-event gaps are identical",
    };
  }

  let assignments = new Int8Array(logs.length).fill(-1);

  for (;;) {
    let changed = false;

    const nextAssignments = new Int8Array(logs.length);

    let lowSum = 0;
    let lowCount = 0;
    let highSum = 0;
    let highCount = 0;

    for (let index = 0; index < logs.length; index += 1) {
      const value = logs[index];

      const cluster =
        Math.abs(value - lowCenter) <= Math.abs(value - highCenter) ? 0 : 1;

      nextAssignments[index] = cluster;

      if (cluster !== assignments[index]) {
        changed = true;
      }

      if (cluster === 0) {
        lowSum += value;
        lowCount += 1;
      } else {
        highSum += value;
        highCount += 1;
      }
    }

    if (lowCount === 0 || highCount === 0) {
      return {
        ok: false,
        victim,
        reason: "two-state gap clustering collapsed to one state",
      };
    }

    assignments = nextAssignments;

    const nextLow = lowSum / lowCount;
    const nextHigh = highSum / highCount;

    const centersUnchanged = nextLow === lowCenter && nextHigh === highCenter;

    lowCenter = nextLow;
    highCenter = nextHigh;

    if (!changed || centersUnchanged) {
      break;
    }
  }

  if (lowCenter > highCenter) {
    [lowCenter, highCenter] = [highCenter, lowCenter];
  }

  const boundaryLog = (lowCenter + highCenter) / 2;
  const boundaryMs = Math.expm1(boundaryLog);

  const withinGaps = [];
  const betweenGaps = [];

  for (const gapMs of gaps) {
    if (gapMs <= boundaryMs) {
      withinGaps.push(gapMs);
    } else {
      betweenGaps.push(gapMs);
    }
  }

  if (withinGaps.length === 0 || betweenGaps.length === 0) {
    return {
      ok: false,
      victim,
      reason: "learned boundary did not separate both gap states",
    };
  }

  withinGaps.sort((a, b) => a - b);
  betweenGaps.sort((a, b) => a - b);

  return {
    ok: true,
    victim,
    boundaryMs,
    withinCenterMs: Math.expm1(lowCenter),
    betweenCenterMs: Math.expm1(highCenter),
    withinMedianMs: quantile(withinGaps, 50),
    betweenMedianMs: quantile(betweenGaps, 50),
    withinCount: withinGaps.length,
    betweenCount: betweenGaps.length,
  };
}

function groupEventsIntoEpisodes(events, gapModel, dataEndMs) {
  if (!gapModel.ok || events.length === 0) {
    return [];
  }

  const groups = [];
  let current = [events[0]];

  for (let index = 1; index < events.length; index += 1) {
    const event = events[index];
    const previous = events[index - 1];

    if (event.ts - previous.ts > gapModel.boundaryMs) {
      groups.push(current);
      current = [event];
    } else {
      current.push(event);
    }
  }

  groups.push(current);

  return groups.map((episodeEvents, index) => {
    const first = episodeEvents[0];
    const last = episodeEvents[episodeEvents.length - 1];

    const nextStartAt = groups[index + 1]?.[0]?.ts ?? null;
    const trailingGapMs = dataEndMs - last.ts;

    const isOpen = nextStartAt === null && trailingGapMs <= gapModel.boundaryMs;

    return {
      victim: first.victim,
      events: episodeEvents,

      firstEventAt: first.ts,
      lastEventAt: last.ts,
      nextStartAt,

      leftCensored: index === 0,
      isOpen,

      totalLiqUsd: episodeEvents.reduce((sum, event) => sum + event.usd, 0),

      eventCount: episodeEvents.length,

      startPrice: first.price,
      lastEventPrice: last.price,
    };
  });
}

function attachOi(episode, observations, learnedTailMs, dataEndMs) {
  const baselineOi = nearestObservationAtOrBefore(
    observations,
    episode.firstEventAt,
  );

  const tailLimit = Math.min(
    dataEndMs,
    episode.lastEventAt + learnedTailMs,
    episode.nextStartAt ?? Number.POSITIVE_INFINITY,
  );

  const fromIndex = lowerBoundByTs(observations, episode.firstEventAt);

  const toIndexExclusive = upperBoundByTs(observations, tailLimit);

  const path = observations.slice(fromIndex, toIndexExclusive);

  if (!baselineOi || path.length === 0 || !(baselineOi.openInterest > 0)) {
    return {
      ...episode,

      endAt: episode.lastEventAt,
      endPrice: episode.lastEventPrice,
      endBasis: "LAST_FORCE_ORDER_NO_OI",

      oiAvailable: false,

      startOi: baselineOi?.openInterest ?? null,
      startOiUsd: baselineOi?.openInterestUsd ?? null,

      minOi: null,
      minOiAt: null,
      endOi: null,

      oiDrawdownPct: null,
      oiNetChangePct: null,
      oiTroughConfirmed: false,

      liqToStartOiUsdPct: null,
    };
  }

  let minimum = path[0];
  let minimumIndex = 0;

  for (let index = 1; index < path.length; index += 1) {
    if (path[index].openInterest < minimum.openInterest) {
      minimum = path[index];
      minimumIndex = index;
    }
  }

  const laterHigherObservation = path
    .slice(minimumIndex + 1)
    .find((observation) => observation.openInterest > minimum.openInterest);

  const effectiveEndAt = Math.max(episode.lastEventAt, minimum.ts);

  const endOiObservation = nearestObservationAtOrBefore(
    observations,
    effectiveEndAt,
  );

  const endPrice = endOiObservation?.price ?? episode.lastEventPrice;

  const drawdownPct = Math.max(
    0,
    ((baselineOi.openInterest - minimum.openInterest) /
      baselineOi.openInterest) *
      100,
  );

  const endOi = endOiObservation?.openInterest ?? null;

  const netChangePct =
    Number.isFinite(endOi) && baselineOi.openInterest > 0
      ? ((endOi - baselineOi.openInterest) / baselineOi.openInterest) * 100
      : null;

  const startOiUsd = baselineOi.openInterestUsd;

  return {
    ...episode,

    endAt: effectiveEndAt,
    endPrice,

    endBasis:
      minimum.ts > episode.lastEventAt
        ? laterHigherObservation
          ? "OI_TROUGH_CONFIRMED"
          : "OI_TROUGH_UNCONFIRMED"
        : "LAST_FORCE_ORDER",

    oiAvailable: true,

    startOi: baselineOi.openInterest,
    startOiUsd,

    minOi: minimum.openInterest,
    minOiAt: minimum.ts,

    endOi,

    oiDrawdownPct: drawdownPct,
    oiNetChangePct: netChangePct,

    oiTroughConfirmed: Boolean(laterHigherObservation),

    liqToStartOiUsdPct:
      Number.isFinite(startOiUsd) && startOiUsd > 0
        ? (episode.totalLiqUsd / startOiUsd) * 100
        : null,
  };
}

function causalRanksForEpisode(episode, allEpisodes, baselineMs) {
  const baseline = allEpisodes.filter(
    (candidate) =>
      candidate.victim === episode.victim &&
      !candidate.leftCensored &&
      !candidate.isOpen &&
      candidate.endAt < episode.firstEventAt &&
      candidate.firstEventAt >= episode.firstEventAt - baselineMs,
  );

  const liqValues = baseline
    .map((candidate) => candidate.totalLiqUsd)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const oiValues = baseline
    .map((candidate) => candidate.oiDrawdownPct)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const liqRank = percentileRank(liqValues, episode.totalLiqUsd);

  const oiRank = percentileRank(oiValues, episode.oiDrawdownPct);

  /*
   * Conservative strength:
   * both liquidation and OI must be strong.
   */
  const jointRank =
    Number.isFinite(liqRank) && Number.isFinite(oiRank)
      ? Math.min(liqRank, oiRank)
      : null;

  const thresholds = {};

  for (const percentile of DISPLAY_PERCENTILES) {
    thresholds[`p${percentile}`] = {
      liqUsd: quantile(liqValues, percentile),

      oiDrawdownPct: quantile(oiValues, percentile),
    };
  }

  return {
    ...episode,

    baselineStartAt: episode.firstEventAt - baselineMs,

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
  if (
    !Number.isFinite(startPrice) ||
    startPrice <= 0 ||
    !Number.isFinite(endPrice)
  ) {
    return null;
  }

  return ((endPrice - startPrice) / startPrice) * 100;
}

function printThresholds(episode) {
  const parts = DISPLAY_PERCENTILES.map((percentile) => {
    const threshold = episode.thresholds[`p${percentile}`];

    return (
      `P${percentile}` +
      `[liq=${fmtUsd(threshold.liqUsd)}, ` +
      `oiDrop=${fmtPct(threshold.oiDrawdownPct)}]`
    );
  });

  console.log(`    CAUSAL THRESHOLDS: ${parts.join("  ")}`);
}

function printEpisode(episode, index) {
  const status = episode.isOpen ? "OPEN" : "CLOSED";

  const movePct = priceMovePct(episode.startPrice, episode.endPrice);

  console.log("-".repeat(150));

  console.log(
    `#${String(index + 1).padStart(2, "0")}  ` +
      `${episode.victim.padEnd(5)}  ` +
      `${episode.tier.padEnd(8)}  ` +
      status,
  );

  console.log(
    `    START: ${iso(episode.firstEventAt)}  ` +
      `price=${episode.startPrice ?? "N/A"}`,
  );

  console.log(
    `    END:   ${iso(episode.endAt)}  ` +
      `price=${episode.endPrice ?? "N/A"}  ` +
      `duration=${fmtDuration(episode.endAt - episode.firstEventAt)}  ` +
      `basis=${episode.endBasis}`,
  );

  console.log(
    `    LIQ:   ${fmtUsd(episode.totalLiqUsd)}  ` +
      `events=${episode.eventCount}  ` +
      `rank=${fmtRank(episode.liqRank)}  ` +
      `priceMove=${fmtPct(movePct)}`,
  );

  console.log(
    `    OI:    ` +
      `start=${episode.startOi ?? "N/A"}  ` +
      `min=${episode.minOi ?? "N/A"}  ` +
      `drawdown=${fmtPct(episode.oiDrawdownPct)}  ` +
      `net=${fmtPct(episode.oiNetChangePct)}  ` +
      `rank=${fmtRank(episode.oiRank)}`,
  );

  console.log(
    `    JOINT: ${fmtRank(episode.jointRank)} => ${episode.tier}  ` +
      `baselineEpisodes=${episode.baselineEpisodeCount} ` +
      `(liqN=${episode.baselineLiqCount}, ` +
      `oiN=${episode.baselineOiCount})  ` +
      `liq/startOIUsd=${fmtPct(episode.liqToStartOiUsdPct)}`,
  );

  printThresholds(episode);

  if (episode.leftCensored) {
    console.log(
      "    NOTE: LEFT_CENSORED — history begins inside this episode; excluded from later baselines.",
    );
  }

  if (episode.isOpen) {
    console.log(
      "    NOTE: RIGHT_CENSORED — learned closing gap has not elapsed; this episode may still be active.",
    );
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

  const uri = process.env.MONGO_URI;

  if (!uri) {
    throw new Error("MONGO_URI not set");
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();

    const database = client.db(
      process.env.MONGO_OWN_DB ?? "liquidation_detector",
    );

    const liqCollection = database.collection("liq_raw_events");

    const oiCollection = database.collection("oi_second_observations");

    const [liqCoverage, oiCoverage] = await Promise.all([
      firstAndLast(liqCollection, { symbol: SYMBOL }, "timestamp"),

      firstAndLast(oiCollection, { symbol: SYMBOL }, "timestamp"),
    ]);

    if (
      !Number.isFinite(liqCoverage.firstMs) ||
      !Number.isFinite(liqCoverage.lastMs)
    ) {
      throw new Error(`No ${SYMBOL} documents found in liq_raw_events`);
    }

    if (
      !Number.isFinite(oiCoverage.firstMs) ||
      !Number.isFinite(oiCoverage.lastMs)
    ) {
      throw new Error(`No ${SYMBOL} documents found in oi_second_observations`);
    }

    /*
     * OI normally continues after the latest liquidation.
     * Therefore the latest timestamp from either collection
     * represents the end of the available timeline.
     */
    const dataEndMs = Math.max(liqCoverage.lastMs, oiCoverage.lastMs);

    const loadStartMs = liqCoverage.firstMs;

    const outputStartMs = dataEndMs - outputDays * DAY_MS;

    const baselineMs = baselineDays * DAY_MS;

    console.log("=".repeat(150));

    console.log(`${SYMBOL} HISTORY-DRIVEN LIQUIDATION EPISODES — READ ONLY`);

    console.log(
      `Output interval:  ` +
        `${iso(outputStartMs)} -> ` +
        `${iso(dataEndMs)} ` +
        `(${outputDays}d)`,
    );

    console.log(
      `Causal baseline: trailing ` + `${baselineDays}d before each episode`,
    );

    console.log(
      `Liquidation data: ` +
        `${iso(liqCoverage.firstMs)} -> ` +
        `${iso(liqCoverage.lastMs)}`,
    );

    console.log(
      `OI-second data:   ` +
        `${iso(oiCoverage.firstMs)} -> ` +
        `${iso(oiCoverage.lastMs)}`,
    );

    console.log("=".repeat(150));

    const [rawLiquidations, rawOi] = await Promise.all([
      liqCollection
        .find({
          symbol: SYMBOL,

          timestamp: {
            $gte: loadStartMs,
            $lte: dataEndMs,
          },

          victim: {
            $in: VICTIMS,
          },
        })
        .project({
          timestamp: 1,
          victim: 1,
          quoteQty: 1,
          price: 1,
        })
        .sort({ timestamp: 1 })
        .toArray(),

      oiCollection
        .find({
          symbol: SYMBOL,

          timestamp: {
            $gte: new Date(oiCoverage.firstMs),

            $lte: new Date(dataEndMs),
          },
        })
        .project({
          timestamp: 1,
          oiUpdatedAt: 1,
          openInterest: 1,
          openInterestUsd: 1,
          price: 1,
        })
        .sort({ timestamp: 1 })
        .toArray(),
    ]);

    const liquidations = rawLiquidations
      .map((document) => ({
        ts: toMs(document.timestamp),

        victim: document.victim,

        usd: finiteNumber(document.quoteQty),

        price: finiteNumber(document.price),
      }))
      .filter(
        (event) =>
          Number.isFinite(event.ts) &&
          VICTIMS.includes(event.victim) &&
          Number.isFinite(event.usd) &&
          event.usd >= 0,
      )
      .sort((first, second) => first.ts - second.ts);

    const observations = rawOi
      .map((document) => ({
        ts: toMs(document.timestamp),

        oiUpdatedAt: toMs(document.oiUpdatedAt),

        openInterest: finiteNumber(document.openInterest),

        openInterestUsd: finiteNumber(document.openInterestUsd),

        price: finiteNumber(document.price),
      }))
      .filter(
        (observation) =>
          Number.isFinite(observation.ts) &&
          Number.isFinite(observation.openInterest) &&
          observation.openInterest > 0,
      )
      .sort((first, second) => first.ts - second.ts);

    console.log(
      `Loaded ${liquidations.length} valid liquidation events ` +
        `and ${observations.length} valid OI observations.\n`,
    );

    if (liquidations.length === 0) {
      throw new Error("No valid liquidation events after normalization");
    }

    if (observations.length === 0) {
      throw new Error("No valid OI observations after normalization");
    }

    const allEpisodes = [];
    const learnedModels = [];

    /*
     * LONG and SHORT histories are learned independently.
     */
    for (const victim of VICTIMS) {
      const sideEvents = liquidations.filter(
        (event) => event.victim === victim,
      );

      const model = learnGapModel(sideEvents, victim);

      learnedModels.push(model);

      if (!model.ok) {
        console.log(
          `${victim}: cannot learn episode boundary — ${model.reason}`,
        );

        continue;
      }

      console.log(
        `${victim} LEARNED GAP MODEL: ` +
          `inside-center=${fmtDuration(model.withinCenterMs)}, ` +
          `between-center=${fmtDuration(model.betweenCenterMs)}, ` +
          `boundary=${fmtDuration(model.boundaryMs)}, ` +
          `insideN=${model.withinCount}, ` +
          `betweenN=${model.betweenCount}`,
      );

      const grouped = groupEventsIntoEpisodes(sideEvents, model, dataEndMs);

      for (const episode of grouped) {
        allEpisodes.push(
          attachOi(episode, observations, model.boundaryMs, dataEndMs),
        );
      }
    }

    if (learnedModels.every((model) => !model.ok)) {
      throw new Error(
        "Could not learn two-state gap model for LONG or SHORT; no static fallback was used",
      );
    }

    allEpisodes.sort(
      (first, second) => first.firstEventAt - second.firstEventAt,
    );

    const ranked = allEpisodes.map((episode) =>
      causalRanksForEpisode(episode, allEpisodes, baselineMs),
    );

    const outputEpisodes = ranked.filter(
      (episode) =>
        episode.firstEventAt >= outputStartMs &&
        episode.firstEventAt <= dataEndMs,
    );

    console.log(
      `\nBuilt ${ranked.length} total historical episodes; ` +
        `printing ${outputEpisodes.length} episode(s).`,
    );

    if (outputEpisodes.length === 0) {
      console.log("No episodes begin inside the requested output interval.");

      return;
    }

    outputEpisodes.forEach(printEpisode);

    const rankedStrongest = outputEpisodes
      .filter((episode) => Number.isFinite(episode.jointRank))
      .sort(
        (first, second) =>
          second.jointRank - first.jointRank ||
          second.totalLiqUsd - first.totalLiqUsd,
      );

    console.log("\n" + "=".repeat(150));

    console.log(
      "STRONGEST RECENT EPISODES — " +
        "JOINT percentile = " +
        "min(liquidation rank, OI-drawdown rank)",
    );

    console.log("=".repeat(150));

    if (rankedStrongest.length === 0) {
      console.log(
        "No recent episode had enough prior liquidation and OI history for a joint rank.",
      );
    } else {
      for (const episode of rankedStrongest) {
        console.log(
          `${episode.tier.padEnd(5)} ` +
            `${fmtRank(episode.jointRank).padEnd(7)} ` +
            `${episode.victim.padEnd(5)} ` +
            `${iso(episode.firstEventAt)} -> ` +
            `${iso(episode.endAt)}  ` +
            `liq=${fmtUsd(episode.totalLiqUsd)}  ` +
            `oiDrop=${fmtPct(episode.oiDrawdownPct)}  ` +
            `baselineN=${episode.baselineEpisodeCount}`,
        );
      }
    }

    console.log("\nINTERPRETATION:");

    console.log(
      "  P95/P90 JOINT = both visible forced-liquidation total and OI drawdown were extreme versus the same victim side's trailing baseline.",
    );

    console.log(
      "  High LIQ rank with low OI rank is not promoted to a high JOINT tier.",
    );

    console.log(
      "  Binance forceOrder is throttled, so totalLiqUsd is visible liquidation, not guaranteed complete liquidation.",
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(
    "\n[BTC_EPISODE_SCRIPT_FAILED] " +
      (error instanceof Error ? (error.stack ?? error.message) : String(error)),
  );

  process.exitCode = 1;
});
