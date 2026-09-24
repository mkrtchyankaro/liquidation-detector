#!/usr/bin/env node
/**
 * Offline liquidation / OI episode research for any symbol (read-only). Logic = v9.
 * node scripts/liquidation-episodes-v13.js [outputDays=2] [symbol=BTC] [rr=2.2]
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
function symbolArg(raw) {
  const base = String(raw ?? "BTC").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(base)) throw Error(`bad symbol: ${raw}`);
  return base.endsWith("USDT") ? base : `${base}USDT`;
}
const SYMBOL = symbolArg(process.argv[3]);
const RR = positiveArg(process.argv[4], 2.2, "rr");
const PERCENTILES = [70, 75, 80, 90, 95];
const stamp = (n) => new Date(n).toISOString();
const num = (v) => v == null ? NaN : Number(v);
const readable = (n) => Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "n/a";
const percent = (n) => Number.isFinite(n) ? `${n.toFixed(3)}%` : "n/a";
const minute = (ts) => Math.floor(ts / MINUTE) * MINUTE;
const time = (v) => v instanceof Date ? v.getTime() : num(v);

function positiveArg(raw, fallback, name) {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw Error(`${name} must be positive`);
  return value;
}

/** A minute without liquidation stays in the timeline with zero flow. */
function buildBuckets(liquidations, oiObservations, start, end) {
  const buckets = [];
  const byTime = new Map();
  for (let ts = minute(start); ts <= minute(end); ts += MINUTE) {
    const bucket = { ts, long: 0, short: 0, count: 0, oi: NaN, price: NaN, oiPoints: 0 };
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
    if (Number.isFinite(obs.updated) && obs.updated <= obs.ts) updates.set(obs.updated, obs);
  }
  for (const obs of [...updates.values()].sort((a, b) => a.updated - b.updated)) {
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
    if (Number.isFinite(bucket.oi)) { lastOi = bucket.oi; lastPrice = bucket.price; }
    else { bucket.oi = lastOi; bucket.price = lastPrice; }
  }
  return buckets;
}

/** Prefix sums provide O(1) linear regression SSE for any minute interval. */
function linearCost(y) {
  const sums = [[], [], [], [], []].map(() => new Float64Array(y.length + 1));
  for (let i = 0; i < y.length; i++) {
    const x = i; const v = y[i];
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
      const left = cost(a, split), right = cost(split, b);
      const loss = left.sse + right.sse;
      if (!best || loss < best.loss) best = { split, loss };
    }
    if (best) {
      // BIC compares a 2-parameter line against two 2-parameter lines.
      // The tiny scale guard only avoids log(0) on perfectly straight data.
      const scale = Math.max(Number.EPSILON * y.reduce((s, v) => s + v * v, 0), 1e-16);
      const n = b - a;
      const unsplitBic = n * Math.log((parent.sse + scale) / n) + 2 * Math.log(y.length);
      const splitBic = n * Math.log((best.loss + scale) / n) + 4 * Math.log(y.length);
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
  const sideOf = (long, short) => long >= short ? "LONG" : "SHORT";

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
    const extremePrice = victim === "LONG" ? Math.min(...prices) : Math.max(...prices);
    const g = active.growthSlopes;
    if (count) episodes.push({
      start: buckets[start].ts,
      end: endTs,
      sIdx: start, eIdx: stop, gIdx: active.growthStart,
      victim, long, short, count,
      minOi: minimum, startOi: baseline, endOi: last.oi,
      oiDropPct: baseline > 0 ? Math.max(0, (baseline - minimum) / baseline * 100) : NaN,
      oiGrowPct: minimum > 0 ? (last.oi - minimum) / minimum * 100 : NaN,
      growthMin: active.growthStart >= 0 ? stop - active.growthStart : 0,
      firstGrowSpeed: g.length ? g[0] / minimum * 100 : NaN,          // OI %/min
      lastGrowSpeed: g.length ? g[g.length - 1] / minimum * 100 : NaN, // OI %/min
      startPrice, endPrice, extremePrice,
      priceMovePct: startPrice > 0 ? (endPrice - startPrice) / startPrice * 100 : NaN,
      extremeMovePct: startPrice > 0 ? (extremePrice - startPrice) / startPrice * 100 : NaN,
      endReason: reason,
      continuations: active.continuations,
      opposite: active.opposite,
      leftCensored: buckets[start].ts <= validFrom + MINUTE,
      rightCensored: rightCensored || endTs > validUntil,
      coverage: included.reduce((s, b) => s + (b.oiPoints > 0 ? 1 : 0), 0) / included.length,
    });
    active = null;
  }

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const slope = slopeAt[i];
    if (!active) {
      if (slope < 0 && b.count > 0) active = { start: i, side: null, growthStart: -1, continuations: 0, opposite: 0, growthSlopes: [] };
      continue;
    }
    if (active.growthStart < 0) {
      if (slope <= 0) continue; // clearing phase (falling or flat OI)
      let long = 0, short = 0;
      for (let k = active.start; k < i; k++) { long += buckets[k].long; short += buckets[k].short; }
      active.side = sideOf(long, short);
      active.growthStart = i;
    }
    // Growth phase.
    if (slope <= 0) {
      close(i, "GROWTH_END");
      i--; // this minute may start a new episode
      continue;
    }
    if (i === active.growthStart || slopeAt[i - 1] !== slope) active.growthSlopes.push(slope);
    if (b.count > 0) {
      if (sideOf(b.long, b.short) === active.side) active.continuations++;
      else active.opposite++;
    }
  }
  if (active) close(buckets.length, active.growthStart >= 0 ? "GROWING_AT_END" : "OPEN_AT_DATA_END", true);
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
  function finish(closedBy, confirmTs = NaN) {
    if (!group) return;
    const first = group.parts[0], last = group.parts[group.parts.length - 1];
    const start = first.sIdx, stop = last.eIdx;
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
    const extremePrice = side === "LONG" ? Math.min(...prices) : Math.max(...prices);
    episodes.push({
      start: first.start, end: last.end,
      victim: side, long, short, count,
      minOi: minimum, startOi: baseline, endOi: endB.oi,
      oiDropPct: baseline > 0 ? Math.max(0, (baseline - minimum) / baseline * 100) : NaN,
      oiGrowPct: minimum > 0 ? (endB.oi - minimum) / minimum * 100 : NaN,
      growthMin: last.growthMin,
      firstGrowSpeed: last.firstGrowSpeed, lastGrowSpeed: last.lastGrowSpeed,
      startPrice, endPrice: endB.price, extremePrice,
      priceMovePct: startPrice > 0 ? (endB.price - startPrice) / startPrice * 100 : NaN,
      extremeMovePct: startPrice > 0 ? (extremePrice - startPrice) / startPrice * 100 : NaN,
      endReason: last.rightCensored ? last.endReason : closedBy,
      confirmTs,
      parts: group.parts.length,
      partRanges: group.parts.map((p) => [p.sIdx, p.eIdx]),
      sIdx: start, eIdx: stop,
      oppAbsorbed: group.oppAbsorbed,
      continuations: group.parts.reduce((s, p) => s + p.continuations, 0),
      opposite: group.parts.reduce((s, p) => s + p.opposite, 0),
      leftCensored: first.leftCensored,
      rightCensored: last.rightCensored,
      coverage: included.reduce((s, b) => s + (b.oiPoints > 0 ? 1 : 0), 0) / included.length,
    });
    group = null;
  }
  for (const sub of subs) {
    if (!group) { group = { parts: [sub], oppAbsorbed: 0 }; continue; }
    const side = group.parts[0].victim;
    if (sub.victim === side) group.parts.push(sub);
    else if (sub.oiDropPct > 0) {
      // The end is KNOWN only when the opposite part really shows an OI drop:
      // first minute inside it where OI < OI before it started (end of that minute).
      const base = buckets[Math.max(0, sub.sIdx - 1)].oi;
      let k = sub.sIdx;
      while (k < sub.eIdx && !(buckets[k].oi < base)) k++;
      finish("OPPOSITE_EPISODE", k < sub.eIdx ? buckets[k].ts + MINUTE : NaN);
      group = { parts: [sub], oppAbsorbed: 0 };
    }
    else group.oppAbsorbed++;
  }
  finish("DATA_END");
  return episodes;
}

function rank(values, value) {
  if (!values.length || !Number.isFinite(value)) return NaN;
  let below = 0, equal = 0;
  for (const v of values) { if (v < value) below++; else if (v === value) equal++; }
  return 100 * (below + equal / 2) / values.length;
}
function quantile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const x = p / 100 * (sorted.length - 1), a = Math.floor(x), t = x - a;
  return sorted[a] + t * (sorted[Math.ceil(x)] - sorted[a]);
}
function rankEpisodes(episodes, baselineDays) {
  const horizon = baselineDays * DAY;
  return episodes.map((episode) => {
    const prior = episodes.filter((old) => old.victim === episode.victim &&
      !old.leftCensored && !old.rightCensored && old.coverage === 1 &&
      old.start >= episode.start - horizon && old.end <= episode.start);
    const liqs = prior.map((e) => e.victim === "LONG" ? e.long : e.short);
    const oi = prior.map((e) => e.oiDropPct).filter(Number.isFinite);
    const liqRank = rank(liqs, episode.victim === "LONG" ? episode.long : episode.short);
    const oiRank = rank(oi, episode.oiDropPct);
    const joint = Math.min(liqRank, oiRank);
    const tier = PERCENTILES.filter((p) => joint >= p).at(-1);
    return { ...episode, baselineN: prior.length, liqRank, oiRank, joint, tier: tier ? `P${tier}` : Number.isFinite(joint) ? "<P70" : "UNRANKED",
      thresholds: Object.fromEntries(PERCENTILES.map((p) => [p, { liq: quantile(liqs, p), oi: quantile(oi, p) }])),
    };
  });
}

/**
 * V8 features. Per-episode checks here (DOM, DIR); CLR, MOV and EXH are applied in main()
 * against medians of all loaded DIR episodes (EXH needs no median).
 *  DOM  victim side liquidations > opposite side in EVERY part
 *  DIR  price moved in the liquidation direction (LONG victim: down, SHORT victim: up)
 *  EXH  exhaustion: after the peak minute, price progress per 1% OI drop is lower
 *       than before the peak (OI still clears, price no longer follows)
 * AFTER30/60/120: price move after the end in the FADE direction (outcome, not a feature).
 */
function episodeFeatures(buckets, e) {
  const s = e.victim === "LONG" ? -1 : 1;
  const victimOf = (b) => e.victim === "LONG" ? b.long : b.short;
  const oppOf = (b) => e.victim === "LONG" ? b.short : b.long;
  const range = buckets.slice(e.sIdx, e.eIdx);
  const victimLiq = range.reduce((t, b) => t + victimOf(b), 0);
  const oppLiq = range.reduce((t, b) => t + oppOf(b), 0);
  const dom = e.partRanges.every(([a, z]) => {
    const part = buckets.slice(a, z);
    return part.reduce((t, b) => t + victimOf(b), 0) > part.reduce((t, b) => t + oppOf(b), 0);
  });
  const dirMove = s * e.priceMovePct;
  let peak = e.sIdx;
  for (let i = e.sIdx; i < e.eIdx; i++) if (victimOf(buckets[i]) > victimOf(buckets[peak])) peak = i;
  const len = Math.max(1, e.eIdx - e.sIdx);
  const peakPos = (peak - e.sIdx + 0.5) / len;
  function segment(a, z) { // [a, z] inclusive bucket indices; baseline = bucket before a
    const base = buckets[Math.max(0, a - 1)];
    if (z < a || !(base.price > 0) || !(base.oi > 0)) return { move: NaN, drop: NaN, eff: NaN };
    let minOi = base.oi;
    for (let i = a; i <= z; i++) minOi = Math.min(minOi, buckets[i].oi);
    const move = s * (buckets[z].price - base.price) / base.price * 100;
    const drop = (base.oi - minOi) / base.oi * 100;
    return { move, drop, eff: drop > 0 ? move / drop : NaN };
  }
  const pre = segment(e.sIdx, peak);
  const post = segment(peak + 1, e.eIdx - 1);
  const exh = post.drop > 0 && (post.move <= 0 || (Number.isFinite(pre.eff) && post.eff < pre.eff));
  const endPrice = buckets[e.eIdx - 1].price;
  const after = (k) => {
    const j = e.eIdx - 1 + k;
    return j < buckets.length && endPrice > 0 ? -s * (buckets[j].price - endPrice) / endPrice * 100 : NaN;
  };
  const checks = { DOM: dom, DIR: dirMove > 0 };
  const clr = dirMove > 0 ? e.oiDropPct / dirMove : NaN; // OI drop % per 1% price move
  return {
    ...e, victimLiq, oppLiq, domRatio: oppLiq > 0 ? victimLiq / oppLiq : Infinity,
    dirMove, peakTs: buckets[peak].ts, peakPos, pre, post, checks,
    exh, clr,
    after30: after(30), after60: after(60), after120: after(120),
    ...pathAfterEnd(buckets, e.eIdx - 1, s, POST_WINDOW),
  };
}

/**
 * Outcome only (uses future data). Within POST_WINDOW minutes after END:
 *  CONT = how far price kept going in the liquidation direction (bad for a fade)
 *  REV  = how far price reversed (good for a fade)
 *  first = which extreme happened first
 */
const POST_WINDOW = 120; // minutes, display only
function pathAfterEnd(buckets, endIdx, s, window) {
  const p0 = buckets[endIdx]?.price;
  if (!(p0 > 0) || endIdx + window >= buckets.length) return { cont: NaN, rev: NaN, contMin: NaN, revMin: NaN, first: "n/a" };
  let cont = 0, rev = 0, contMin = 0, revMin = 0;
  for (let k = 1; k <= window; k++) {
    const m = s * (buckets[endIdx + k].price - p0) / p0 * 100; // + = continued, - = reversed
    if (m > cont) { cont = m; contMin = k; }
    if (-m > rev) { rev = -m; revMin = k; }
  }
  const first = cont === 0 && rev === 0 ? "-" : cont === 0 ? "REV" : rev === 0 ? "CONT" : contMin < revMin ? "CONT" : "REV";
  return { cont, rev, contMin, revMin, first };
}

/**
 * Fade backtest (outcome only). Signal at episode END.
 *  Entry at END (look-ahead) or at CONFIRM (when the closing opposite part shows a real OI drop).
 *  LONG victims (price fell)  -> BUY, SL = lowest price from episode start until entry
 *  SHORT victims (price rose) -> SELL, SL = highest price from episode start until entry
 *  R = |entry - SL|, TP = entry ± RR * R. Walk every poll price after END
 *  until TP or SL is hit; otherwise OPEN. No fees, no slippage.
 */
function lowerBound(arr, ts) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].ts < ts) lo = mid + 1; else hi = mid; }
  return lo;
}
function backtestFade(prices, e, rr, entryAt = e.end) {
  if (!Number.isFinite(entryAt)) return { result: "NO_CONFIRM" };
  const a = lowerBound(prices, e.start), z = lowerBound(prices, entryAt);
  const i0 = z;
  if (a >= z || i0 >= prices.length) return { result: "NO_DATA" };
  const long = e.victim === "LONG";
  let sl = prices[a].price;
  for (let i = a; i < z; i++) sl = long ? Math.min(sl, prices[i].price) : Math.max(sl, prices[i].price);
  const entry = prices[i0].price, entryTs = prices[i0].ts;
  const risk = long ? entry - sl : sl - entry;
  if (!(risk > 0)) return { result: "NO_RISK", entry, sl };
  const tp = long ? entry + rr * risk : entry - rr * risk;
  for (let i = i0 + 1; i < prices.length; i++) {
    const p = prices[i].price;
    const hitSl = long ? p <= sl : p >= sl;
    const hitTp = long ? p >= tp : p <= tp;
    if (hitSl || hitTp) return { result: hitSl ? "SL" : "TP", entry, sl, tp, riskPct: risk / entry * 100, entryTs, exitTs: prices[i].ts, r: hitSl ? -1 : rr };
  }
  return { result: "OPEN", entry, sl, tp, riskPct: risk / entry * 100, entryTs, exitTs: NaN, r: 0 };
}

async function fetchAll(collection, query, projection) {
  return collection.find(query).project(projection).sort({ timestamp: 1 }).toArray();
}
async function main() {
  const outputDays = positiveArg(process.argv[2], 2, "outputDays");
  if (!process.env.MONGO_URI) throw Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const liq = db.collection("liq_raw_events"), oi = db.collection("oi_second_observations");
    const [firstLiq, lastLiq, firstOi, lastOi] = await Promise.all([
      liq.findOne({ symbol: SYMBOL }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } }),
      liq.findOne({ symbol: SYMBOL }, { sort: { timestamp: -1 }, projection: { timestamp: 1 } }),
      oi.findOne({ symbol: SYMBOL }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } }),
      oi.findOne({ symbol: SYMBOL }, { sort: { timestamp: -1 }, projection: { timestamp: 1 } }),
    ]);
    if (!firstLiq || !lastLiq || !firstOi || !lastOi) {
      const [liqSymbols, oiSymbols] = await Promise.all([liq.distinct("symbol"), oi.distinct("symbol")]);
      const both = liqSymbols.filter((x) => oiSymbols.includes(x)).sort();
      throw Error(`${SYMBOL} liquidation/OI history missing. Symbols with both: ${both.join(", ") || "none"}`);
    }
    const from = Math.max(time(firstLiq.timestamp), time(firstOi.timestamp));
    const until = Math.min(time(lastLiq.timestamp), time(lastOi.timestamp));
    if (until <= from) throw Error(`No overlapping ${SYMBOL} liquidation and OI history`);
    const [rawLiq, rawOi] = await Promise.all([
      fetchAll(liq, { symbol: SYMBOL, victim: { $in: ["LONG", "SHORT"] }, timestamp: { $gte: from, $lte: until } },
        { timestamp: 1, victim: 1, quoteQty: 1 }),
      fetchAll(oi, { symbol: SYMBOL, timestamp: { $gte: new Date(from), $lte: new Date(until) } },
        { timestamp: 1, oiUpdatedAt: 1, openInterest: 1, price: 1 }),
    ]);
    const events = rawLiq.map((x) => ({ ts: time(x.timestamp), victim: x.victim, usd: num(x.quoteQty) }))
      .filter((x) => Number.isFinite(x.ts) && Number.isFinite(x.usd) && x.usd >= 0);
    const observations = rawOi.map((x) => ({ ts: time(x.timestamp), updated: time(x.oiUpdatedAt), oi: num(x.openInterest), price: num(x.price) }))
      .filter((x) => Number.isFinite(x.updated) && Number.isFinite(x.oi) && x.oi > 0 && x.updated >= from && x.updated <= until);
    const prices = rawOi.map((x) => ({ ts: time(x.timestamp), price: num(x.price) }))
      .filter((x) => Number.isFinite(x.ts) && x.price > 0).sort((p, q) => p.ts - q.ts);
    const buckets = buildBuckets(events, observations, from, until);
    const lastKnown = buckets.findLastIndex((b) => Number.isFinite(b.oi));
    const firstKnown = buckets.findIndex((b) => Number.isFinite(b.oi));
    if (firstKnown < 0 || lastKnown - firstKnown < 4) throw Error("Insufficient distinct OI minute updates");
    const usable = buckets.slice(firstKnown, lastKnown + 1);
    const regimes = changePoints(usable.map((b) => b.oi));
    const episodes = episodesFromRegimes(usable, regimes, from, until);
    const featured = episodes.map((e) => episodeFeatures(usable, e));
    // Reference medians: all loaded episodes whose price moved with the liquidation (DIR).
    const median = (v) => { const s = v.filter(Number.isFinite).sort((p, q) => p - q); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const dirEpisodes = featured.filter((e) => e.checks.DIR);
    const medClr = median(dirEpisodes.map((e) => e.clr));
    const medMove = median(dirEpisodes.map((e) => e.dirMove));
    for (const e of featured) {
      e.checks.CLR = e.clr > medClr;
      e.checks.MOV = e.dirMove >= medMove;
      e.checks.EXH = e.exh;
      e.selected = Object.values(e.checks).every(Boolean);
    }
    const recent = featured.filter((e) => e.start >= until - outputDays * DAY);
    const x = (v) => v === Infinity ? "∞" : Number.isFinite(v) ? v.toFixed(2) : "n/a";
    const flags = (c) => Object.entries(c).map(([k, v]) => v ? k : "·".repeat(k.length)).join(" ");
    console.log(`${SYMBOL} V13 OFFLINE EPISODE FILTER (V6 EPISODES; DOM + DIR + CLR + MOV + EXH; NO FIXED THRESHOLDS) (READ ONLY)`);
    console.log(`History: ${stamp(from)} → ${stamp(until)} | minuteBuckets=${usable.length} | OI regimes=${regimes.length} | episodes=${episodes.length}`);
    console.log(`Source: ${events.length} forced-order snapshots; ${observations.length} OI polls; output=${outputDays}d`);
    console.log(`Reference (all ${dirEpisodes.length} DIR episodes in loaded history): median CLR=${x(medClr)} | median MOVE=${percent(medMove)}`);
    console.log("Checks: DOM=victim side wins every part | DIR=price moved with liquidation | CLR=OI drop per 1% move > median | MOV=move >= median | EXH=after peak liq, less price move per 1% OI drop than before");
    console.log("EFF = price move % per 1% OI drop, before peak → after peak. AFTER60 = move 60m after END in fade direction. CONT/REV = max continuation / max reversal within 120m after END (minutes in brackets). Outcome only.");
    console.log("START UTC         END UTC           MIN  SIDE   VICTIM LIQ     OPP LIQ    MOVE%    OI DROP   CLR   EFF pre→post   CHECKS               SEL  AFTER60  CONT(min)        REV(min)         FIRST");
    const row = (e) => `${stamp(e.start).slice(0, 16)}  ${stamp(e.end).slice(0, 16)}  ${String(Math.round((e.end - e.start) / MINUTE)).padStart(4)}  ${e.victim.padEnd(5)}  ${readable(e.victimLiq).padStart(13)}  ${readable(e.oppLiq).padStart(12)}  ${percent(e.priceMovePct).padStart(8)}  ${percent(e.oiDropPct).padStart(7)}  ${x(e.clr).padStart(6)}  ${(x(e.pre.eff) + "→" + x(e.post.eff)).padStart(13)}  ${flags(e.checks)}  ${e.selected ? " ✅" : "   "}  ${percent(e.after60).padStart(7)}  ${(percent(e.cont) + "(" + (Number.isFinite(e.contMin) ? e.contMin : "-") + ")").padStart(15)}  ${(percent(e.rev) + "(" + (Number.isFinite(e.revMin) ? e.revMin : "-") + ")").padStart(15)}  ${e.first}${e.rightCensored ? " OPEN" : ""}`;
    for (const e of recent) console.log(row(e));
    const sel = recent.filter((e) => e.selected);
    console.log(`\nSELECTED (${sel.length}):`);
    for (const e of sel) console.log(`  ${stamp(e.start).slice(0, 16)} → ${stamp(e.end).slice(0, 16)}  ${e.victim.padEnd(5)}  liq ${readable(e.victimLiq)}  move ${percent(e.priceMovePct)}  CLR ${x(e.clr)}  EFF ${x(e.pre.eff)}→${x(e.post.eff)}  cont ${percent(e.cont)} (${e.contMin}m)  rev ${percent(e.rev)} (${e.revMin}m)  first ${e.first}${e.rightCensored ? " OPEN" : ""}`);
    // Does the filter help? Compare selected vs rejected DIR episodes on the post-end path.
    const avg = (v) => { const f = v.filter(Number.isFinite); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN; };
    const groupStats = (name, list) => {
      const ok = list.filter((e) => Number.isFinite(e.rev));
      const revFirst = ok.filter((e) => e.first === "REV").length;
      console.log(`  ${name.padEnd(22)} n=${String(ok.length).padStart(3)}  avg REV ${percent(avg(ok.map((e) => e.rev)))}  avg CONT ${percent(avg(ok.map((e) => e.cont)))}  REV first ${ok.length ? Math.round(100 * revFirst / ok.length) : "n/a"}%`);
    };
    console.log(`\nPOST-END PATH (${POST_WINDOW} min after END, outcome only):`);
    groupStats("SELECTED ✅", recent.filter((e) => e.selected));
    groupStats("DIR but rejected", recent.filter((e) => e.checks.DIR && !e.selected));
    groupStats("all episodes", recent);

    // Fade backtest: A) entry at END (look-ahead), B) entry at CONFIRM (realistic timing).
    for (const e of recent) { e.tEnd = backtestFade(prices, e, RR, e.end); e.tConf = backtestFade(prices, e, RR, e.confirmTs); }
    console.log(`\nFADE BACKTEST (SL = extreme from start until entry, TP = ${RR}R, no fees). CONFIRM = when the end becomes known.`);
    console.log("  START UTC         SIDE  TRADE  END UTC            CONFIRM UTC     DELAY  RISK% END  END RES   RISK% CONF  CONF RES  CONF MIN  SEL");
    for (const e of recent) {
      const a = e.tEnd, b = e.tConf;
      if (!Number.isFinite(a.entry) && !Number.isFinite(b.entry)) continue;
      const delay = Number.isFinite(e.confirmTs) ? Math.round((e.confirmTs - e.end) / MINUTE) : "-";
      const dur = Number.isFinite(b.exitTs) ? Math.round((b.exitTs - b.entryTs) / MINUTE) : "-";
      console.log(`  ${stamp(e.start).slice(0, 16)}  ${e.victim.padEnd(5)} ${(e.victim === "LONG" ? "BUY" : "SELL").padEnd(5)}  ${stamp(e.end).slice(0, 16)}  ${Number.isFinite(e.confirmTs) ? stamp(e.confirmTs).slice(5, 16) : "-".padEnd(11)}  ${String(delay).padStart(6)}  ${percent(a.riskPct).padStart(9)}  ${a.result.padEnd(8)}  ${percent(b.riskPct).padStart(10)}  ${b.result.padEnd(10)} ${String(dur).padStart(7)}  ${e.selected ? "✅" : ""}`);
    }
    const btStats = (name, list, key) => {
      const tr = (e) => e[key];
      const done = list.filter((e) => tr(e).result === "TP" || tr(e).result === "SL");
      const tp = done.filter((e) => tr(e).result === "TP").length, sl = done.length - tp;
      const open = list.filter((e) => tr(e).result === "OPEN").length;
      const sumR = done.reduce((t, e) => t + tr(e).r, 0);
      console.log(`  ${name.padEnd(22)} trades=${String(done.length).padStart(3)}  TP=${String(tp).padStart(3)}  SL=${String(sl).padStart(3)}  open=${open}  win=${done.length ? (100 * tp / done.length).toFixed(1) : "n/a"}%  sumR=${sumR.toFixed(1)}  avgR=${done.length ? (sumR / done.length).toFixed(2) : "n/a"}`);
    };
    for (const [key, label] of [["tEnd", "ENTRY AT END (look-ahead, old v12)"], ["tConf", "ENTRY AT CONFIRM (realistic timing)"]]) {
      console.log(`\nBACKTEST SUMMARY — ${label} (break-even win rate at ${RR}R = ${(100 / (1 + RR)).toFixed(1)}%):`);
      btStats("SELECTED ✅", recent.filter((e) => e.selected), key);
      btStats("DIR but rejected", recent.filter((e) => e.checks.DIR && !e.selected), key);
      btStats("all episodes", recent, key);
    }
    console.log(`\nRecent episodes=${recent.length}; selected=${sel.length}`);
    console.log("Still offline: OI regimes and medians use all loaded history. CONFIRM removes only the end-timing look-ahead.");
  } finally { await client.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { buildBuckets, changePoints, subEpisodesFromRegimes, episodesFromRegimes, episodeFeatures };
