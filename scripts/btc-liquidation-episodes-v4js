#!/usr/bin/env node
/**
 * BTC directional liquidation + OI re-entry study (read-only).
 * node scripts/btc-liquidation-episodes-v4.js [outputDays=2] [baselineDays=2]
 *
 * A same-victim forced order joins the ongoing episode even after OI starts
 * rebuilding. Opposite-victim orders are recorded separately, never added to
 * its forced-volume percentile. An episode completes only after OI recovers to
 * its pre-clearing anchor AND a fitted OI rising regime has begun. This is an
 * offline segmentation rule, not a causal live signal. No fixed quiet timer.
 */
require("dotenv/config");
const { MongoClient } = require("mongodb");
const { buildBuckets, changePoints } = require("./btc-liquidation-episodes-v3");
const MIN = 60_000,
  DAY = 86_400_000,
  LEVELS = [70, 75, 80, 90, 95];
const stamp = (n) => new Date(n).toISOString();
const time = (v) => (v instanceof Date ? v.getTime() : Number(v));
const fmt = (n) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: 3 })
    : "n/a";
const pct = (n) => (Number.isFinite(n) ? n.toFixed(3) + "%" : "n/a");
const arg = (s, d) => (s == null ? d : Number(s));
function rank(a, value) {
  if (!a.length || !Number.isFinite(value)) return NaN;
  return (
    (100 *
      (a.filter((x) => x < value).length +
        a.filter((x) => x === value).length / 2)) /
    a.length
  );
}
function label(n) {
  if (!Number.isFinite(n)) return "UNRANKED";
  const level = LEVELS.filter((x) => n >= x).at(-1);
  return level ? `P${level}` : "<P70";
}
function regimesForBuckets(buckets) {
  const regimes = changePoints(buckets.map((b) => b.oi));
  const regimeAt = new Int32Array(buckets.length);
  regimes.forEach((r, index) => {
    for (let i = r.a; i < r.b; i++) regimeAt[i] = index;
  });
  return { regimes, regimeAt };
}
function buildEpisodes(buckets, regimes, regimeAt, validFrom, validUntil) {
  const result = [];
  let active = null;
  const make = (victim, i) => ({
    victim,
    startIndex: i,
    anchor: buckets[Math.max(0, i - 1)].oi,
    trough: buckets[Math.max(0, i - 1)].oi,
    troughIndex: i,
    lastSame: i,
    same: 0,
    opposite: 0,
    count: 0,
    oppositeCount: 0,
    peakRebuild: 0,
    rebuildStart: null,
    oiUpdates: 0,
    minutes: 0,
  });
  const consume = (a, b, i) => {
    const same = a.victim === "LONG" ? b.long : b.short;
    const opposite = a.victim === "LONG" ? b.short : b.long;
    a.same += same;
    a.opposite += opposite;
    if (same > 0) {
      a.lastSame = i;
      a.count++;
    }
    if (opposite > 0) a.oppositeCount++;
    a.oiUpdates += Number(b.oiPoints > 0);
    a.minutes++;
    if (b.oi < a.trough) {
      a.trough = b.oi;
      a.troughIndex = i;
      a.rebuildStart = null;
      a.peakRebuild = 0;
    }
    const rebuild =
      a.anchor > 0 ? Math.max(0, ((b.oi - a.trough) / a.anchor) * 100) : NaN;
    if (rebuild > 0 && a.rebuildStart == null && i > a.troughIndex)
      a.rebuildStart = i;
    a.peakRebuild = Math.max(a.peakRebuild, rebuild || 0);
  };
  const close = (i, censored) => {
    if (!active) return;
    const a = active;
    const end = buckets[i].ts + MIN;
    const drop =
      a.anchor > 0
        ? Math.max(0, ((a.anchor - a.trough) / a.anchor) * 100)
        : NaN;
    const gain =
      a.anchor > 0
        ? Math.max(0, ((buckets[i].oi - a.trough) / a.anchor) * 100)
        : NaN;
    result.push({
      start: buckets[a.startIndex].ts,
      end,
      victim: a.victim,
      liq: a.same,
      oppositeLiq: a.opposite,
      count: a.count,
      oppositeCount: a.oppositeCount,
      oiDropPct: drop,
      oiGainPct: gain,
      peakRebuildPct: a.peakRebuild,
      anchorOi: a.anchor,
      troughOi: a.trough,
      endOi: buckets[i].oi,
      troughAt: buckets[a.troughIndex].ts,
      rebuildAt: a.rebuildStart == null ? null : buckets[a.rebuildStart].ts,
      status: censored ? "OPEN" : gain > 0 ? "ZONE" : "NO_ZONE",
      leftCensored: buckets[a.startIndex].ts <= validFrom + MIN,
      rightCensored: censored || end > validUntil,
      coverage: a.oiUpdates / a.minutes,
    });
    active = null;
  };
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const r = regimes[regimeAt[i]];
    if (!active) {
      if (r.slope >= 0 || b.count === 0) continue;
      const victim = b.long >= b.short ? "LONG" : "SHORT";
      active = make(victim, i);
    }
    consume(active, b, i);
    // An OI recovery is a structural end only if the pre-clearing anchor is
    // recovered. Thus successive same-side waves during partial rebounds merge.
    // A fresh same-side liquidation at the boundary remains in this episode.
    if (
      r.slope > 0 &&
      b.oi >= active.anchor &&
      i > active.lastSame &&
      i > active.troughIndex
    )
      close(i, false);
  }
  if (active) close(buckets.length - 1, true);
  return result;
}
function rankEpisodes(episodes, baselineDays) {
  return episodes.map((e) => {
    const prior = episodes.filter(
      (p) =>
        p.victim === e.victim &&
        !p.leftCensored &&
        !p.rightCensored &&
        p.coverage === 1 &&
        p.start >= e.start - baselineDays * DAY &&
        p.end <= e.start,
    );
    const lr = rank(
      prior.map((p) => p.liq),
      e.liq,
    );
    const dr = rank(
      prior.map((p) => p.oiDropPct),
      e.oiDropPct,
    );
    const gr = rank(
      prior.filter((p) => p.status === "ZONE").map((p) => p.oiGainPct),
      e.oiGainPct,
    );
    return {
      ...e,
      baselineN: prior.length,
      liqRank: lr,
      dropRank: dr,
      gainRank: gr,
      jointRank: Math.min(lr, dr),
      tier: label(Math.min(lr, dr)),
      zoneTier: e.status === "ZONE" ? label(gr) : "PENDING",
    };
  });
}
async function main() {
  const outputDays = arg(process.argv[2], 2),
    baselineDays = arg(process.argv[3], 2);
  if (![outputDays, baselineDays].every((n) => Number.isFinite(n) && n > 0))
    throw Error("Days must be positive");
  if (!process.env.MONGO_URI) throw Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const liq = db.collection("liq_raw_events"),
      oi = db.collection("oi_second_observations");
    const [firstL, lastL, firstO, lastO] = await Promise.all([
      liq.findOne(
        { symbol: "BTCUSDT" },
        { sort: { timestamp: 1 }, projection: { timestamp: 1 } },
      ),
      liq.findOne(
        { symbol: "BTCUSDT" },
        { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
      ),
      oi.findOne(
        { symbol: "BTCUSDT" },
        { sort: { timestamp: 1 }, projection: { timestamp: 1 } },
      ),
      oi.findOne(
        { symbol: "BTCUSDT" },
        { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
      ),
    ]);
    if (![firstL, lastL, firstO, lastO].every(Boolean))
      throw Error("BTC liquidation/OI history missing");
    const from = Math.max(time(firstL.timestamp), time(firstO.timestamp));
    const until = Math.min(time(lastL.timestamp), time(lastO.timestamp));
    if (until <= from) throw Error("No overlapping history");
    const [rawL, rawO] = await Promise.all([
      liq
        .find({
          symbol: "BTCUSDT",
          victim: { $in: ["LONG", "SHORT"] },
          timestamp: { $gte: from, $lte: until },
        })
        .project({ timestamp: 1, victim: 1, quoteQty: 1 })
        .sort({ timestamp: 1 })
        .toArray(),
      oi
        .find({
          symbol: "BTCUSDT",
          timestamp: { $gte: new Date(from), $lte: new Date(until) },
        })
        .project({ timestamp: 1, oiUpdatedAt: 1, openInterest: 1, price: 1 })
        .sort({ timestamp: 1 })
        .toArray(),
    ]);
    const events = rawL
      .map((x) => ({
        ts: time(x.timestamp),
        victim: x.victim,
        usd: Number(x.quoteQty),
      }))
      .filter(
        (x) => Number.isFinite(x.ts) && Number.isFinite(x.usd) && x.usd >= 0,
      );
    const observations = rawO
      .map((x) => ({
        ts: time(x.timestamp),
        updated: time(x.oiUpdatedAt),
        oi: Number(x.openInterest),
        price: Number(x.price),
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
    const first = buckets.findIndex((b) => Number.isFinite(b.oi));
    const last = buckets.findLastIndex((b) => Number.isFinite(b.oi));
    if (first < 0 || last - first < 4)
      throw Error("Insufficient OI minute updates");
    const usable = buckets.slice(first, last + 1);
    const { regimes, regimeAt } = regimesForBuckets(usable);
    const episodes = rankEpisodes(
      buildEpisodes(usable, regimes, regimeAt, from, until),
      baselineDays,
    );
    const recent = episodes.filter((e) => e.end >= until - outputDays * DAY);
    console.log(
      "BTC V4 DIRECTIONAL LIQUIDATION â†’ OI REBUILD (READ ONLY, OFFLINE)",
    );
    console.log(
      `History ${stamp(from)} â†’ ${stamp(until)} | forced=${events.length} | oiPolls=${observations.length} | regimes=${regimes.length} | episodes=${episodes.length}`,
    );
    console.log(
      "OI change points use future history: boundaries/zone labels are NOT live-causal. Opposite side excluded from same-side liquidation sum.",
    );
    console.log(
      "START UTC                END UTC                  SIDE    MIN  SAME USD     OPP USD      OI DROP  OI GAIN  LIQ%  DROP%  GAIN%  LIQ TIER ZONE TIER BASE N STATUS / TROUGH / OI REBUILD",
    );
    for (const e of recent) {
      console.log(
        `${stamp(e.start)} ${stamp(e.end)} ${e.victim.padEnd(5)} ${String((e.end - e.start) / MIN).padStart(5)} ${fmt(e.liq).padStart(12)} ${fmt(e.oppositeLiq).padStart(12)} ${pct(e.oiDropPct).padStart(8)} ${pct(e.oiGainPct).padStart(8)} ${fmt(e.liqRank).padStart(5)} ${fmt(e.dropRank).padStart(6)} ${fmt(e.gainRank).padStart(6)} ${e.tier.padEnd(8)} ${e.zoneTier.padEnd(9)} ${String(e.baselineN).padStart(3)} ${e.status}${e.rightCensored ? " CENSORED" : ""} trough=${stamp(e.troughAt)} rebuild=${e.rebuildAt == null ? "NONE" : stamp(e.rebuildAt)} coverage=${pct(e.coverage * 100)}`,
      );
    }
    console.log(
      `Recent=${recent.length}; completed zones=${recent.filter((e) => e.status === "ZONE").length}; open=${recent.filter((e) => e.rightCensored).length}`,
    );
    console.log(
      "Zone confirms net OI re-entry, NOT long/short price direction. Full anchor recovery can leave long open episodes; inspect charts before using live.",
    );
  } finally {
    await client.close();
  }
}
if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
module.exports = { buildEpisodes, rankEpisodes, regimesForBuckets };
