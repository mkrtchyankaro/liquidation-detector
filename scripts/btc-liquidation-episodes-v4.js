#!/usr/bin/env node
/**
 * Offline BTC liquidation / OI episode research (read-only).
 * node scripts/btc-liquidation-episodes-v4.js [outputDays=2] [baselineDays=2]
 * Minute buckets are a measurement grid, NOT a mandatory episode length.
 * The OI piecewise-linear change points are selected by BIC; no market-time,
 * price, size, OI-magnitude, or duration threshold is hard-coded.
 *
 * IMPORTANT: segmentation is an OFFLINE fit to all loaded observations and
 * therefore cannot be interpreted as a live, causal end signal. Percentile
 * baselines themselves use only previously completed episodes.
 */
require("dotenv/config");
const { MongoClient } = require("mongodb");

const MINUTE = 60_000; // resampling grid, not a decision threshold
const DAY = 86_400_000;
const SYMBOL = "BTCUSDT";
const PERCENTILES = [70, 75, 80, 90, 95];
const stamp = (n) => new Date(n).toISOString();
const num = (v) => (v == null ? NaN : Number(v));
const readable = (n) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "n/a";
const percent = (n) => (Number.isFinite(n) ? `${n.toFixed(3)}%` : "n/a");
const minute = (ts) => Math.floor(ts / MINUTE) * MINUTE;
const time = (v) => (v instanceof Date ? v.getTime() : num(v));

function positiveArg(raw, fallback, name) {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw Error(`${name} must be positive`);
  return value;
}

/** A minute without liquidation stays in the timeline with zero flow. */
function buildBuckets(liquidations, oiObservations, start, end) {
  const buckets = [];
  const byTime = new Map();
  for (let ts = minute(start); ts <= minute(end); ts += MINUTE) {
    const bucket = {
      ts,
      long: 0,
      short: 0,
      count: 0,
      oi: NaN,
      price: NaN,
      oiPoints: 0,
    };
    buckets.push(bucket);
    byTime.set(ts, bucket);
  }
  for (const event of liquidations) {
    const bucket = byTime.get(minute(event.ts));
    if (!bucket) continue;
    bucket[event.victim === "LONG" ? "long" : "short"] += event.usd;
    bucket.count++;
  }
  // A REST poll may repeat the same exchange-side update timestamp. Retain
  // the most recently captured snapshot for each oiUpdatedAt, not every poll.
  const updates = new Map();
  for (const obs of oiObservations) {
    if (Number.isFinite(obs.updated) && obs.updated <= obs.ts)
      updates.set(obs.updated, obs);
  }
  for (const obs of [...updates.values()].sort(
    (a, b) => a.updated - b.updated,
  )) {
    const bucket = byTime.get(minute(obs.updated));
    if (!bucket) continue;
    bucket.oi = obs.oi;
    bucket.price = obs.price;
    bucket.oiPoints++;
  }
  // Carry observations forward only to draw a continuous OI LEVEL line.
  // Carried-forward values are never counted as new exchange updates.
  let lastOi = NaN;
  let lastPrice = NaN;
  for (const bucket of buckets) {
    if (Number.isFinite(bucket.oi)) {
      lastOi = bucket.oi;
      lastPrice = bucket.price;
    } else {
      bucket.oi = lastOi;
      bucket.price = lastPrice;
    }
  }
  return buckets;
}

/** Prefix sums provide O(1) linear regression SSE for any minute interval. */
function linearCost(y) {
  const sums = [[], [], [], [], []].map(() => new Float64Array(y.length + 1));
  for (let i = 0; i < y.length; i++) {
    const x = i;
    const v = y[i];
    sums[0][i + 1] = sums[0][i] + x;
    sums[1][i + 1] = sums[1][i] + v;
    sums[2][i + 1] = sums[2][i] + x * x;
    sums[3][i + 1] = sums[3][i] + x * v;
    sums[4][i + 1] = sums[4][i] + v * v;
  }
  return (a, b) => {
    const n = b - a;
    if (n < 2) return { sse: 0, slope: 0 };
    const [sx, sy, sxx, sxy, syy] = sums.map((s) => s[b] - s[a]);
    const den = n * sxx - sx * sx;
    const slope = den ? (n * sxy - sx * sy) / den : 0;
    const intercept = (sy - slope * sx) / n;
    const sse = Math.max(0, syy - intercept * sy - slope * sxy);
    return { sse, slope };
  };
}

/** Offline binary segmentation with parameter-count BIC, no fixed gap/length. */
function changePoints(y) {
  const cost = linearCost(y);
  const leaves = [];
  const stack = [[0, y.length]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const parent = cost(a, b);
    let best = null;
    // Two observations are needed to estimate each linear slope.
    for (let split = a + 2; split <= b - 2; split++) {
      const left = cost(a, split),
        right = cost(split, b);
      const loss = left.sse + right.sse;
      if (!best || loss < best.loss) best = { split, loss };
    }
    if (best) {
      // BIC compares a 2-parameter line against two 2-parameter lines.
      // The tiny scale guard only avoids log(0) on perfectly straight data.
      const scale = Math.max(
        Number.EPSILON * y.reduce((s, v) => s + v * v, 0),
        1e-16,
      );
      const n = b - a;
      const unsplitBic =
        n * Math.log((parent.sse + scale) / n) + 2 * Math.log(y.length);
      const splitBic =
        n * Math.log((best.loss + scale) / n) + 4 * Math.log(y.length);
      if (splitBic < unsplitBic) {
        stack.push([best.split, b], [a, best.split]);
        continue;
      }
    }
    leaves.push({ a, b, slope: parent.slope });
  }
  return leaves.sort((x, z) => x.a - z.a);
}

/**
 * V4 episode definition.
 * START (unchanged from v3): first liquidation inside a negative-slope OI regime.
 * END (new): OI must GROW. Negative or flat OI keeps the episode open.
 *   When a positive-slope OI regime begins, that minute is the candidate end
 *   (the start of OI growth). While OI keeps growing:
 *     - same-side liquidation     -> episode continues (process repeats)
 *     - opposite-side liquidation -> episode closes at the candidate end
 *     - growth regime ends quietly -> episode closes at the candidate end
 */
function episodesFromRegimes(buckets, regimes, validFrom, validUntil) {
  const slopeAt = new Float64Array(buckets.length);
  for (const r of regimes) for (let i = r.a; i < r.b; i++) slopeAt[i] = r.slope;
  const episodes = [];
  let active = null; // { start, continuations }
  let pendingEnd = -1; // candidate end index (first growth minute), -1 = not pending
  const sideOf = (long, short) => (long >= short ? "LONG" : "SHORT");

  function close(endIndex, reason, rightCensored = false) {
    if (!active) return;
    const start = active.start;
    const stop = Math.max(start + 1, Math.min(endIndex, buckets.length)); // exclusive
    const included = buckets.slice(start, stop);
    const long = included.reduce((s, b) => s + b.long, 0);
    const short = included.reduce((s, b) => s + b.short, 0);
    const victim = sideOf(long, short);
    const baseline = buckets[Math.max(0, start - 1)].oi;
    const minimum = Math.min(baseline, ...included.map((b) => b.oi));
    const count = included.reduce((s, b) => s + b.count, 0);
    const endTs =
      stop < buckets.length
        ? buckets[stop].ts
        : buckets[buckets.length - 1].ts + MINUTE;
    const endOi =
      stop < buckets.length ? buckets[stop].oi : buckets[buckets.length - 1].oi;
    if (count)
      episodes.push({
        start: buckets[start].ts,
        end: endTs,
        victim,
        long,
        short,
        count,
        minOi: minimum,
        startOi: baseline,
        endOi,
        oiDropPct:
          baseline > 0
            ? Math.max(0, ((baseline - minimum) / baseline) * 100)
            : NaN,
        endReason: reason,
        continuations: active.continuations,
        leftCensored: buckets[start].ts <= validFrom + MINUTE,
        rightCensored: rightCensored || endTs > validUntil,
        coverage:
          included.reduce((s, b) => s + (b.oiPoints > 0 ? 1 : 0), 0) /
          included.length,
      });
    active = null;
    pendingEnd = -1;
  }

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const slope = slopeAt[i];
    if (!active) {
      if (slope < 0 && b.count > 0) active = { start: i, continuations: 0 };
      continue;
    }
    if (pendingEnd < 0) {
      // Episode open: only OI growth can move it to the end phase.
      if (slope > 0) pendingEnd = i;
      else continue;
    }
    // End phase: OI is growing since pendingEnd.
    if (slope <= 0) {
      close(pendingEnd, "OI_GROWTH");
      i--; // re-check this minute as a possible new episode start
      continue;
    }
    if (b.count > 0) {
      let long = 0,
        short = 0;
      for (let k = active.start; k < pendingEnd; k++) {
        long += buckets[k].long;
        short += buckets[k].short;
      }
      if (sideOf(b.long, b.short) === sideOf(long, short)) {
        active.continuations++;
        pendingEnd = -1; // same side: continue, wait for growth again
      } else {
        close(pendingEnd, "OPPOSITE_LIQ");
      }
    }
  }
  if (active) {
    if (pendingEnd >= 0) close(pendingEnd, "GROWTH_AT_DATA_END", true);
    else close(buckets.length, "OPEN_AT_DATA_END", true);
  }
  return episodes;
}

function rank(values, value) {
  if (!values.length || !Number.isFinite(value)) return NaN;
  let below = 0,
    equal = 0;
  for (const v of values) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return (100 * (below + equal / 2)) / values.length;
}
function quantile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const x = (p / 100) * (sorted.length - 1),
    a = Math.floor(x),
    t = x - a;
  return sorted[a] + t * (sorted[Math.ceil(x)] - sorted[a]);
}
function rankEpisodes(episodes, baselineDays) {
  const horizon = baselineDays * DAY;
  return episodes.map((episode) => {
    const prior = episodes.filter(
      (old) =>
        old.victim === episode.victim &&
        !old.leftCensored &&
        !old.rightCensored &&
        old.coverage === 1 &&
        old.start >= episode.start - horizon &&
        old.end <= episode.start,
    );
    const liqs = prior.map((e) => (e.victim === "LONG" ? e.long : e.short));
    const oi = prior.map((e) => e.oiDropPct).filter(Number.isFinite);
    const liqRank = rank(
      liqs,
      episode.victim === "LONG" ? episode.long : episode.short,
    );
    const oiRank = rank(oi, episode.oiDropPct);
    const joint = Math.min(liqRank, oiRank);
    const tier = PERCENTILES.filter((p) => joint >= p).at(-1);
    return {
      ...episode,
      baselineN: prior.length,
      liqRank,
      oiRank,
      joint,
      tier: tier ? `P${tier}` : Number.isFinite(joint) ? "<P70" : "UNRANKED",
      thresholds: Object.fromEntries(
        PERCENTILES.map((p) => [
          p,
          { liq: quantile(liqs, p), oi: quantile(oi, p) },
        ]),
      ),
    };
  });
}

async function fetchAll(collection, query, projection) {
  return collection
    .find(query)
    .project(projection)
    .sort({ timestamp: 1 })
    .toArray();
}
async function main() {
  const outputDays = positiveArg(process.argv[2], 2, "outputDays");
  const baselineDays = positiveArg(process.argv[3], 2, "baselineDays");
  if (!process.env.MONGO_URI) throw Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const liq = db.collection("liq_raw_events"),
      oi = db.collection("oi_second_observations");
    const [firstLiq, lastLiq, firstOi, lastOi] = await Promise.all([
      liq.findOne(
        { symbol: SYMBOL },
        { sort: { timestamp: 1 }, projection: { timestamp: 1 } },
      ),
      liq.findOne(
        { symbol: SYMBOL },
        { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
      ),
      oi.findOne(
        { symbol: SYMBOL },
        { sort: { timestamp: 1 }, projection: { timestamp: 1 } },
      ),
      oi.findOne(
        { symbol: SYMBOL },
        { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
      ),
    ]);
    if (!firstLiq || !lastLiq || !firstOi || !lastOi)
      throw Error("BTC liquidation/OI history missing");
    const from = Math.max(time(firstLiq.timestamp), time(firstOi.timestamp));
    const until = Math.min(time(lastLiq.timestamp), time(lastOi.timestamp));
    if (until <= from)
      throw Error("No overlapping BTC liquidation and OI history");
    const [rawLiq, rawOi] = await Promise.all([
      fetchAll(
        liq,
        {
          symbol: SYMBOL,
          victim: { $in: ["LONG", "SHORT"] },
          timestamp: { $gte: from, $lte: until },
        },
        { timestamp: 1, victim: 1, quoteQty: 1 },
      ),
      fetchAll(
        oi,
        {
          symbol: SYMBOL,
          timestamp: { $gte: new Date(from), $lte: new Date(until) },
        },
        { timestamp: 1, oiUpdatedAt: 1, openInterest: 1, price: 1 },
      ),
    ]);
    const events = rawLiq
      .map((x) => ({
        ts: time(x.timestamp),
        victim: x.victim,
        usd: num(x.quoteQty),
      }))
      .filter(
        (x) => Number.isFinite(x.ts) && Number.isFinite(x.usd) && x.usd >= 0,
      );
    const observations = rawOi
      .map((x) => ({
        ts: time(x.timestamp),
        updated: time(x.oiUpdatedAt),
        oi: num(x.openInterest),
        price: num(x.price),
      }))
      .filter(
        (x) =>
          Number.isFinite(x.updated) &&
          Number.isFinite(x.oi) &&
          x.oi > 0 &&
          x.updated >= from &&
          x.updated <= until,
      );
    const buckets = buildBuckets(events, observations, from, until);
    const lastKnown = buckets.findLastIndex((b) => Number.isFinite(b.oi));
    const firstKnown = buckets.findIndex((b) => Number.isFinite(b.oi));
    if (firstKnown < 0 || lastKnown - firstKnown < 4)
      throw Error("Insufficient distinct OI minute updates");
    const usable = buckets.slice(firstKnown, lastKnown + 1);
    const regimes = changePoints(usable.map((b) => b.oi));
    const episodes = episodesFromRegimes(usable, regimes, from, until);
    const ranked = rankEpisodes(episodes, baselineDays);
    const recent = ranked.filter((e) => e.start >= until - outputDays * DAY);
    console.log(
      `BTC V4 OFFLINE OI-CHANGE-POINT RESEARCH (END = OI GROWTH) (READ ONLY)`,
    );
    console.log(
      `History: ${stamp(from)} → ${stamp(until)} | minuteBuckets=${usable.length} | OI regimes=${regimes.length} | episodes=${episodes.length}`,
    );
    console.log(
      `Source: ${events.length} forced-order snapshots; ${observations.length} OI polls; output=${outputDays}d; trailing baseline=${baselineDays}d`,
    );
    console.log(
      "Note: OI change points use all available history (offline look-ahead). Percentile reference sets exclude future episodes.",
    );
    console.log(
      "Note: start = liquidation in OI-falling regime. End = start of OI growth; same-side liq during growth continues, opposite-side liq closes.",
    );
    console.log(
      "TIME START UTC                END UTC                  MIN  SIDE   LONG LIQ     SHORT LIQ    OI DROP   LIQ%  OI%   JOINT TIER  BASE N COVERAGE  END REASON    CONT  END OI",
    );
    for (const e of recent) {
      console.log(
        `${stamp(e.start)}  ${stamp(e.end)}  ${String(Math.round((e.end - e.start) / MINUTE)).padStart(3)}  ${e.victim.padEnd(5)}  ${String(readable(e.long)).padStart(11)}  ${String(readable(e.short)).padStart(11)}  ${percent(e.oiDropPct).padStart(8)}  ${readable(e.liqRank).padStart(5)}  ${readable(e.oiRank).padStart(5)}  ${readable(e.joint).padStart(5)} ${e.tier.padEnd(8)} ${String(e.baselineN).padStart(4)}  ${percent(e.coverage * 100).padStart(8)}  ${e.endReason.padEnd(12)}  ${String(e.continuations).padStart(4)}  ${readable(e.endOi)}${e.leftCensored || e.rightCensored ? " CENSORED" : ""}`,
      );
    }
    console.log(
      "\nCausal same-side P70/P75/P80/P90/P95 limits for recent episodes:",
    );
    for (const e of recent.filter(
      (x) => x.tier === "P80" || x.tier === "P90" || x.tier === "P95",
    )) {
      console.log(
        `${stamp(e.start)} ${e.victim} ${e.tier} baselineN=${e.baselineN} ` +
          PERCENTILES.map(
            (p) =>
              `P${p}[$${readable(e.thresholds[p].liq)}, OI ${percent(e.thresholds[p].oi)}]`,
          ).join(" "),
      );
    }
    const counts = Object.fromEntries(
      ["UNRANKED", "<P70", ...PERCENTILES.map((p) => `P${p}`)].map((tier) => [
        tier,
        recent.filter((e) => e.tier === tier).length,
      ]),
    );
    console.log(
      `\nRecent episodes=${recent.length}; tiers=${JSON.stringify(counts)}`,
    );
    const reasons = {};
    for (const e of recent)
      reasons[e.endReason] = (reasons[e.endReason] ?? 0) + 1;
    console.log(`End reasons=${JSON.stringify(reasons)}`);
    console.log(
      "Do not use these offline boundaries as live trade signals without causal replay and chart review.",
    );
  } finally {
    await client.close();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = {
  buildBuckets,
  changePoints,
  episodesFromRegimes,
  rankEpisodes,
};
