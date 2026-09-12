/**
 * Sep 12 2026 (Karo), operator-requested. Standalone, READ-ONLY
 * exploratory research script. Groups raw ETHUSDT liquidation events
 * (last 24h) into simple gap-based episodes, per victim side. No
 * ATR, no P95 filtering, no candle data, no production logic -- pure
 * exploration to inspect the real gap distribution before choosing a
 * final episode definition. Never writes to MongoDB.
 */
require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = process.argv.includes("--symbol")
  ? process.argv[process.argv.indexOf("--symbol") + 1]
  : "ETHUSDT";
const HOURS = 24;

function fmtTs(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function fmtUsd(n) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return "$" + (n / 1_000).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return totalSec + "s";
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return totalMin + "m " + (totalSec % 60) + "s";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h + "h " + m + "m";
}
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}
function median(arr) {
  return percentile(
    [...arr].sort((a, b) => a - b),
    50,
  );
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
  // NOTE (Sep 12 2026, Karo): the operator's own request named the
  // collection "liquidation_raw_events", but the ACTUAL collection
  // name used by the running production code (confirmed in
  // mongo.client.ts's own rawLiquidationEvents() method) is
  // "liq_raw_events". Using the real, confirmed name below.
  const col = db.collection("liq_raw_events");

  const now = Date.now();
  const startTs = now - HOURS * 3600 * 1000;

  const events = await col
    .find({ symbol: SYMBOL, timestamp: { $gte: startTs, $lte: now } })
    .sort({ timestamp: 1 })
    .toArray();

  console.log("=".repeat(90));
  console.log(
    SYMBOL +
      " -- last " +
      HOURS +
      "h raw liquidation research (liq_raw_events, read-only)",
  );
  console.log("=".repeat(90));

  if (events.length === 0) {
    console.log(
      "\nNo events found for " + SYMBOL + " in the last " + HOURS + "h.",
    );
    await client.close();
    return;
  }

  const longEvents = events.filter((e) => e.victim === "LONG");
  const shortEvents = events.filter((e) => e.victim === "SHORT");
  const totalLongUsd = longEvents.reduce((s, e) => s + e.quoteQty, 0);
  const totalShortUsd = shortEvents.reduce((s, e) => s + e.quoteQty, 0);

  console.log("\nTOTAL RAW EVENTS: " + events.length);
  console.log("LONG EVENTS: " + longEvents.length);
  console.log("SHORT EVENTS: " + shortEvents.length);
  console.log("TOTAL LONG LIQ USD: " + fmtUsd(totalLongUsd));
  console.log("TOTAL SHORT LIQ USD: " + fmtUsd(totalShortUsd));
  console.log("FIRST EVENT TIME: " + fmtTs(events[0].timestamp));
  console.log("LAST EVENT TIME: " + fmtTs(events[events.length - 1].timestamp));

  // ── Inter-event-gap distribution, computed SEPARATELY per victim
  // side (gaps only make sense within the same side's own sequence --
  // mixing LONG/SHORT gaps would conflate two unrelated processes). ──
  function gapsFor(sideEvents) {
    const gaps = [];
    for (let i = 1; i < sideEvents.length; i++)
      gaps.push(sideEvents[i].timestamp - sideEvents[i - 1].timestamp);
    return gaps;
  }
  const longGaps = gapsFor(longEvents).sort((a, b) => a - b);
  const shortGaps = gapsFor(shortEvents).sort((a, b) => a - b);
  const allGaps = [...longGaps, ...shortGaps].sort((a, b) => a - b);

  console.log("\n" + "-".repeat(90));
  console.log(
    "INTER-EVENT GAP DISTRIBUTION (ms), per victim side, and combined",
  );
  console.log("-".repeat(90));
  function printGapStats(label, gaps) {
    if (gaps.length === 0) {
      console.log(label + ": no gaps (0 or 1 event)");
      return;
    }
    console.log(label + " (n=" + gaps.length + "):");
    console.log(
      "  median=" +
        median(gaps).toFixed(0) +
        "ms  p75=" +
        percentile(gaps, 75).toFixed(0) +
        "ms  p90=" +
        percentile(gaps, 90).toFixed(0) +
        "ms  p95=" +
        percentile(gaps, 95).toFixed(0) +
        "ms  max=" +
        gaps[gaps.length - 1].toFixed(0) +
        "ms",
    );
  }
  printGapStats("LONG gaps", longGaps);
  printGapStats("SHORT gaps", shortGaps);
  printGapStats("COMBINED gaps", allGaps);

  // ── Choose an exploratory session-gap from the REAL data: p90 of
  // the COMBINED gap distribution (a common, simple heuristic for
  // session/burst segmentation -- captures the "normal" inter-event
  // spacing while treating the top ~10% longest gaps as genuine
  // quiet-period boundaries). Printed explicitly, not hidden. ──
  const chosenGapMs =
    allGaps.length > 0
      ? Math.max(30_000, Math.round(percentile(allGaps, 90)))
      : 60_000;
  console.log(
    "\nCHOSEN SESSION-GAP THRESHOLD: " +
      chosenGapMs +
      "ms (" +
      (chosenGapMs / 1000).toFixed(1) +
      "s) -- p90 of the combined inter-event gap distribution, floored at 30s",
  );

  // ── Group into episodes per victim side using the chosen gap. ──
  function groupEpisodes(sideEvents, victim) {
    const episodes = [];
    let current = null;
    for (const e of sideEvents) {
      if (current === null) {
        current = { victim, events: [e] };
      } else {
        const gap =
          e.timestamp - current.events[current.events.length - 1].timestamp;
        if (gap > chosenGapMs) {
          episodes.push(current);
          current = { victim, events: [e] };
        } else {
          current.events.push(e);
        }
      }
    }
    if (current) episodes.push(current);
    return episodes;
  }
  const longEpisodes = groupEpisodes(longEvents, "LONG");
  const shortEpisodes = groupEpisodes(shortEvents, "SHORT");
  const allEpisodes = [...longEpisodes, ...shortEpisodes].sort(
    (a, b) => a.events[0].timestamp - b.events[0].timestamp,
  );

  console.log("\n" + "=".repeat(90));
  console.log("ALL EPISODES, CHRONOLOGICAL (" + allEpisodes.length + " total)");
  console.log("=".repeat(90));

  const summaryRows = [];
  allEpisodes.forEach((ep, i) => {
    const evs = ep.events;
    const start = evs[0].timestamp;
    const end = evs[evs.length - 1].timestamp;
    const totalLiqUsd = evs.reduce((s, e) => s + e.quoteQty, 0);
    const maxSingleEventUsd = Math.max(...evs.map((e) => e.quoteQty));
    const firstPrice = evs[0].price;
    const lastPrice = evs[evs.length - 1].price;
    const lowestPrice = Math.min(...evs.map((e) => e.price));
    const highestPrice = Math.max(...evs.map((e) => e.price));
    const priceMovePct =
      ep.victim === "LONG"
        ? ((firstPrice - lowestPrice) / firstPrice) * 100
        : ((highestPrice - firstPrice) / firstPrice) * 100;

    console.log("\nEPISODE #" + (i + 1));
    console.log("  victim: " + ep.victim);
    console.log("  start time: " + fmtTs(start));
    console.log("  end time: " + fmtTs(end));
    console.log("  duration: " + fmtDuration(end - start));
    console.log("  eventCount: " + evs.length);
    console.log("  totalLiqUsd: " + fmtUsd(totalLiqUsd));
    console.log("  maxSingleEventUsd: " + fmtUsd(maxSingleEventUsd));
    console.log("  first liquidation price: " + firstPrice);
    console.log("  last liquidation price: " + lastPrice);
    console.log("  lowest liquidation price: " + lowestPrice);
    console.log("  highest liquidation price: " + highestPrice);
    console.log("  priceMovePct: " + priceMovePct.toFixed(3) + "%");

    summaryRows.push({
      victim: ep.victim,
      durationMs: end - start,
      eventCount: evs.length,
      totalLiqUsd,
      priceMovePct,
    });
  });

  // ── Summary ──
  console.log("\n" + "=".repeat(90));
  console.log("SUMMARY");
  console.log("=".repeat(90));
  const longRows = summaryRows.filter((r) => r.victim === "LONG");
  const shortRows = summaryRows.filter((r) => r.victim === "SHORT");
  console.log("TOTAL EPISODES: " + summaryRows.length);
  console.log("LONG EPISODES: " + longRows.length);
  console.log("SHORT EPISODES: " + shortRows.length);
  console.log(
    "median episode duration: " +
      fmtDuration(median(summaryRows.map((r) => r.durationMs))),
  );
  console.log(
    "median event count: " +
      median(summaryRows.map((r) => r.eventCount)).toFixed(1),
  );
  console.log(
    "median total liquidation USD: " +
      fmtUsd(median(summaryRows.map((r) => r.totalLiqUsd))),
  );
  console.log(
    "median LONG priceMovePct: " +
      (longRows.length
        ? median(longRows.map((r) => r.priceMovePct)).toFixed(3) + "%"
        : "n/a (no LONG episodes)"),
  );
  console.log(
    "median SHORT priceMovePct: " +
      (shortRows.length
        ? median(shortRows.map((r) => r.priceMovePct)).toFixed(3) + "%"
        : "n/a (no SHORT episodes)"),
  );

  // ── Obvious bad-grouping flags ──
  console.log("\n" + "-".repeat(90));
  console.log("GROUPING QUALITY FLAGS (heuristic, for manual inspection)");
  console.log("-".repeat(90));
  const singleEventEpisodes = summaryRows.filter(
    (r) => r.eventCount === 1,
  ).length;
  const singleEventPct = (singleEventEpisodes / summaryRows.length) * 100;
  console.log(
    "single-event episodes: " +
      singleEventEpisodes +
      "/" +
      summaryRows.length +
      " (" +
      singleEventPct.toFixed(1) +
      "%)" +
      (singleEventPct > 50
        ? "  <-- majority are single-event; gap threshold may be too SHORT"
        : ""),
  );
  const maxEventCount = Math.max(...summaryRows.map((r) => r.eventCount));
  const maxDurationEpisode = summaryRows.reduce((a, b) =>
    b.durationMs > a.durationMs ? b : a,
  );
  console.log(
    "largest episode by event count: " +
      maxEventCount +
      " events" +
      (maxEventCount > summaryRows.length * 0.3
        ? "  <-- one episode holds a large share of all events; gap threshold may be too LONG (swallowing unrelated bursts)"
        : ""),
  );
  console.log(
    "longest single episode duration: " +
      fmtDuration(maxDurationEpisode.durationMs) +
      (maxDurationEpisode.durationMs > 30 * 60000
        ? "  <-- longer than 30min; inspect manually for unrelated bursts merged together"
        : ""),
  );
  let rapidAlternations = 0;
  for (let i = 1; i < allEpisodes.length; i++) {
    if (
      allEpisodes[i].victim !== allEpisodes[i - 1].victim &&
      allEpisodes[i].events[0].timestamp -
        allEpisodes[i - 1].events[allEpisodes[i - 1].events.length - 1]
          .timestamp <
        60000
    )
      rapidAlternations++;
  }
  console.log(
    "LONG/SHORT alternations within 60s of each other: " +
      rapidAlternations +
      (rapidAlternations > allEpisodes.length * 0.2
        ? "  <-- frequent rapid side-switching; may indicate choppy/two-sided liquidation activity rather than clean directional episodes"
        : ""),
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
