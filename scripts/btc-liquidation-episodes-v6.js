#!/usr/bin/env node
/**
 * Offline BTC liquidation / OI episode research (read-only).
 * node scripts/btc-liquidation-episodes-v6.js [outputDays=2] [baselineDays=2]
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
 * V5 episode definition.
 * START (unchanged): first liquidation inside a negative-slope OI regime.
 * SIDE: fixed by liquidation totals of the clearing phase (before OI growth).
 * GROWTH PHASE: begins with the first positive-slope OI regime.
 *   - same-side liquidation     -> continues (counted in CONT)
 *   - opposite-side liquidation -> ignored, episode continues (counted in OPP)
 *   - consecutive positive regimes (fast then slower growth) stay in growth
 * END (new): first minute where OI stops growing (regime slope <= 0).
 *   End = OI peak of the growth phase, not its start.
 */
function subEpisodesFromRegimes(buckets, regimes, validFrom, validUntil) {
  const slopeAt = new Float64Array(buckets.length);
  for (const r of regimes) for (let i = r.a; i < r.b; i++) slopeAt[i] = r.slope;
  const episodes = [];
  let active = null; // { start, side, growthStart, continuations, opposite, growthSlopes }
  const sideOf = (long, short) => (long >= short ? "LONG" : "SHORT");

  function close(endIndex, reason, rightCensored = false) {
    if (!active) return;
    const start = active.start;
    const stop = Math.max(start + 1, Math.min(endIndex, buckets.length)); // exclusive
    const included = buckets.slice(start, stop);
    const long = included.reduce((s, b) => s + b.long, 0);
    const short = included.reduce((s, b) => s + b.short, 0);
    const victim = active.side ?? sideOf(long, short);
    const baseline = buckets[Math.max(0, start - 1)].oi;
    const minimum = Math.min(baseline, ...included.map((b) => b.oi));
    const count = included.reduce((s, b) => s + b.count, 0);
    const last = included[included.length - 1];
    const endTs = stop < buckets.length ? buckets[stop].ts : last.ts + MINUTE;
    const startPrice = buckets[Math.max(0, start - 1)].price;
    const endPrice = last.price;
    const prices = included.map((b) => b.price).filter(Number.isFinite);
    const extremePrice =
      victim === "LONG" ? Math.min(...prices) : Math.max(...prices);
    const g = active.growthSlopes;
    if (count)
      episodes.push({
        start: buckets[start].ts,
        end: endTs,
        sIdx: start,
        eIdx: stop,
        gIdx: active.growthStart,
        victim,
        long,
        short,
        count,
        minOi: minimum,
        startOi: baseline,
        endOi: last.oi,
        oiDropPct:
          baseline > 0
            ? Math.max(0, ((baseline - minimum) / baseline) * 100)
            : NaN,
        oiGrowPct: minimum > 0 ? ((last.oi - minimum) / minimum) * 100 : NaN,
        growthMin: active.growthStart >= 0 ? stop - active.growthStart : 0,
        firstGrowSpeed: g.length ? (g[0] / minimum) * 100 : NaN, // OI %/min
        lastGrowSpeed: g.length ? (g[g.length - 1] / minimum) * 100 : NaN, // OI %/min
        startPrice,
        endPrice,
        extremePrice,
        priceMovePct:
          startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : NaN,
        extremeMovePct:
          startPrice > 0
            ? ((extremePrice - startPrice) / startPrice) * 100
            : NaN,
        endReason: reason,
        continuations: active.continuations,
        opposite: active.opposite,
        leftCensored: buckets[start].ts <= validFrom + MINUTE,
        rightCensored: rightCensored || endTs > validUntil,
        coverage:
          included.reduce((s, b) => s + (b.oiPoints > 0 ? 1 : 0), 0) /
          included.length,
      });
    active = null;
  }

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const slope = slopeAt[i];
    if (!active) {
      if (slope < 0 && b.count > 0)
        active = {
          start: i,
          side: null,
          growthStart: -1,
          continuations: 0,
          opposite: 0,
          growthSlopes: [],
        };
      continue;
    }
    if (active.growthStart < 0) {
      if (slope <= 0) continue; // clearing phase (falling or flat OI)
      let long = 0,
        short = 0;
      for (let k = active.start; k < i; k++) {
        long += buckets[k].long;
        short += buckets[k].short;
      }
      active.side = sideOf(long, short);
      active.growthStart = i;
    }
    // Growth phase.
    if (slope <= 0) {
      close(i, "GROWTH_END");
      i--; // this minute may start a new episode
      continue;
    }
    if (i === active.growthStart || slopeAt[i - 1] !== slope)
      active.growthSlopes.push(slope);
    if (b.count > 0) {
      if (sideOf(b.long, b.short) === active.side) active.continuations++;
      else active.opposite++;
    }
  }
  if (active)
    close(
      buckets.length,
      active.growthStart >= 0 ? "GROWING_AT_END" : "OPEN_AT_DATA_END",
      true,
    );
  return episodes;
}

/**
 * V6: merge consecutive same-side v5 sub-episodes into one episode.
 * The episode closes only when an OPPOSITE-side sub-episode with a real
 * OI drop (oiDropPct > 0) appears. Opposite sub-episodes without an OI
 * drop are treated as noise and absorbed. No threshold is added.
 */
function episodesFromRegimes(buckets, regimes, validFrom, validUntil) {
  const subs = subEpisodesFromRegimes(buckets, regimes, validFrom, validUntil);
  const episodes = [];
  let group = null; // { parts: [], oppAbsorbed }
  function finish(closedBy) {
    if (!group) return;
    const first = group.parts[0],
      last = group.parts[group.parts.length - 1];
    const start = first.sIdx,
      stop = last.eIdx;
    const side = first.victim;
    const included = buckets.slice(start, stop);
    const long = included.reduce((s, b) => s + b.long, 0);
    const short = included.reduce((s, b) => s + b.short, 0);
    const count = included.reduce((s, b) => s + b.count, 0);
    const baseline = buckets[Math.max(0, start - 1)].oi;
    const minimum = Math.min(baseline, ...included.map((b) => b.oi));
    const endB = included[included.length - 1];
    const startPrice = buckets[Math.max(0, start - 1)].price;
    const prices = included.map((b) => b.price).filter(Number.isFinite);
    const extremePrice =
      side === "LONG" ? Math.min(...prices) : Math.max(...prices);
    episodes.push({
      start: first.start,
      end: last.end,
      victim: side,
      long,
      short,
      count,
      minOi: minimum,
      startOi: baseline,
      endOi: endB.oi,
      oiDropPct:
        baseline > 0
          ? Math.max(0, ((baseline - minimum) / baseline) * 100)
          : NaN,
      oiGrowPct: minimum > 0 ? ((endB.oi - minimum) / minimum) * 100 : NaN,
      growthMin: last.growthMin,
      firstGrowSpeed: last.firstGrowSpeed,
      lastGrowSpeed: last.lastGrowSpeed,
      startPrice,
      endPrice: endB.price,
      extremePrice,
      priceMovePct:
        startPrice > 0 ? ((endB.price - startPrice) / startPrice) * 100 : NaN,
      extremeMovePct:
        startPrice > 0 ? ((extremePrice - startPrice) / startPrice) * 100 : NaN,
      endReason: last.rightCensored ? last.endReason : closedBy,
      parts: group.parts.length,
      oppAbsorbed: group.oppAbsorbed,
      continuations: group.parts.reduce((s, p) => s + p.continuations, 0),
      opposite: group.parts.reduce((s, p) => s + p.opposite, 0),
      leftCensored: first.leftCensored,
      rightCensored: last.rightCensored,
      coverage:
        included.reduce((s, b) => s + (b.oiPoints > 0 ? 1 : 0), 0) /
        included.length,
    });
    group = null;
  }
  for (const sub of subs) {
    if (!group) {
      group = { parts: [sub], oppAbsorbed: 0 };
      continue;
    }
    const side = group.parts[0].victim;
    if (sub.victim === side) group.parts.push(sub);
    else if (sub.oiDropPct > 0) {
      finish("OPPOSITE_EPISODE");
      group = { parts: [sub], oppAbsorbed: 0 };
    } else group.oppAbsorbed++;
  }
  finish("DATA_END");
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
      `BTC V6 OFFLINE OI-CHANGE-POINT RESEARCH (MERGED SAME-SIDE, END = OPPOSITE EPISODE) (READ ONLY)`,
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
      "Note: same-side v5 parts are merged. Episode ends at the OI peak of its last part, when an opposite-side part WITH OI drop appears. Speeds are OI %/min (last part).",
    );
    console.log(
      "TIME START UTC                END UTC                  MIN  SIDE   LONG LIQ     SHORT LIQ    OI DROP   OI GROW  GROW MIN  SPEED 1st→last      PRICE START  PRICE END   MOVE%    EXTREME%  JOINT TIER    BASE N  END REASON        PARTS  ABSORBED  OPP",
    );
    for (const e of recent) {
      console.log(
        `${stamp(e.start)}  ${stamp(e.end)}  ${String(Math.round((e.end - e.start) / MINUTE)).padStart(3)}  ${e.victim.padEnd(5)}  ${String(readable(e.long)).padStart(11)}  ${String(readable(e.short)).padStart(11)}  ${percent(e.oiDropPct).padStart(8)}  ${percent(e.oiGrowPct).padStart(8)}  ${String(e.growthMin).padStart(8)}  ${(percent(e.firstGrowSpeed) + "→" + percent(e.lastGrowSpeed)).padStart(17)}  ${readable(e.startPrice).padStart(11)}  ${readable(e.endPrice).padStart(10)}  ${percent(e.priceMovePct).padStart(8)}  ${percent(e.extremeMovePct).padStart(9)}  ${readable(e.joint).padStart(5)} ${e.tier.padEnd(8)} ${String(e.baselineN).padStart(4)}  ${e.endReason.padEnd(16)}  ${String(e.parts).padStart(5)}  ${String(e.oppAbsorbed).padStart(8)}  ${String(e.opposite).padStart(3)}${e.leftCensored || e.rightCensored ? " CENSORED" : ""}`,
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
  subEpisodesFromRegimes,
  episodesFromRegimes,
  rankEpisodes,
};
