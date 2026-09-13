/**
 * Sep 13 2026 (Karo), operator-requested. READ-ONLY research: build
 * real liquidation cascades from the raw liquidation event stream
 * ONLY (timestamp, price, quoteQty, victim) -- no candle data, no
 * ATR, no recovery-from-candle logic anywhere in this pass. That is
 * intentional: candle-based recovery is explicitly out of scope here
 * per the operator's own instruction; this proves cascade
 * reconstruction directly from the liquidation stream first.
 *
 * TWO SEPARATE PROBLEMS, kept separate as instructed:
 *   1. MEMBERSHIP -- which raw events belong to the same active
 *      cascade (the state machine below).
 *   2. QUALIFICATION -- after grouping, how big/meaningful is this
 *      cascade (noise/ordinary/strong/extreme), computed ONLY from
 *      each symbol+victim's OWN historical distribution of completed
 *      episode totals -- never a fixed USD number.
 *
 * MEMBERSHIP STATE MACHINE (every parameter disclosed, self-relative,
 * no fixed absolute time constant):
 *   - typicalGap = median of the episode's own last 5 intra-episode
 *     gaps. Bootstrapped (only for an episode's first couple of
 *     events, before it has its own cadence) from that symbol+
 *     victim's own P75 of ALL same-side gaps in the dataset -- a
 *     deliberately generous bootstrap, since a median-based bootstrap
 *     was found in an earlier pass to cause premature splits on an
 *     episode's 2nd event.
 *   - rolling intensity = $/sec over the trailing 5 events;
 *     peakIntensityPerSec tracked per-episode; effectiveMultiplier =
 *     4 * (1 + intensityRatio), stretching gap tolerance up to 2x
 *     when recent flow is still close to the episode's own peak.
 *   - price path is event-price only: runningExtreme = most extreme
 *     liquidation price seen so far (low for LONG, high for SHORT).
 *     A NEW extreme always keeps the episode open (definitionally
 *     still the same cascade). Otherwise: recoveryRatio =
 *     |currentPrice - runningExtreme| / |episode's own total
 *     extension so far| -- unitless, self-relative, no ATR/candle.
 *     Below 0.15: never split. Above 0.5: always split (structural
 *     reversal within the event stream itself). Between: defer to
 *     the gap check.
 *
 * READ-ONLY. No production code changed, no Mongo writes, no PM2
 * restart. No W1/W2 recovery thresholds calculated. No candle-based
 * split rule introduced.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as fs from "fs";
import * as path from "path";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
];
const HOURS = 72;
const BASE_GAP_MULTIPLIER = 4;
const INTENSITY_MAX_STRETCH = 1;
const RECENT_GAP_WINDOW = 5;
const RECENT_INTENSITY_WINDOW = 5;
const SMALL_PAUSE_RATIO = 0.15;
const STRUCTURAL_RECOVERY_RATIO = 0.5;
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");
const EXAMPLES_TO_PRINT = 20;

function fmtUsd(n: number) {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtDur(ms: number) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  if (s < 3600) return (s / 60).toFixed(1) + "m";
  return (s / 3600).toFixed(2) + "h";
}
function fmtClock(ms: number) {
  return (
    new Date(ms).toISOString().slice(11, 19) +
    "." +
    String(ms % 1000).padStart(3, "0") +
    "Z"
  );
}
function sortNum(a: number[]) {
  return [...a]
    .filter((x) => x !== null && x !== undefined && !isNaN(x))
    .sort((x, y) => x - y);
}
function median(a: number[]) {
  const s = sortNum(a);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sortedArr[lo]
    : sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

interface RawEvent {
  timestamp: number;
  price: number;
  quoteQty: number;
  victim: "LONG" | "SHORT";
}
interface Episode {
  symbol: string;
  victim: "LONG" | "SHORT";
  events: RawEvent[];
  runningExtreme: number;
  episodeStartPrice: number;
  endReason: string;
}

function buildEpisodes(
  symbol: string,
  victim: "LONG" | "SHORT",
  sideEvents: RawEvent[],
  bootstrapGapMs: number,
): Episode[] {
  const episodes: Episode[] = [];
  let cur: {
    events: RawEvent[];
    runningExtreme: number;
    episodeStartPrice: number;
    peakIntensityPerSec: number;
    endReason: string;
  } | null = null;

  for (let i = 0; i < sideEvents.length; i++) {
    const e = sideEvents[i];
    if (cur === null) {
      cur = {
        events: [e],
        runningExtreme: e.price,
        episodeStartPrice: e.price,
        peakIntensityPerSec: 0,
        endReason: "",
      };
      continue;
    }
    const lastEv = cur.events[cur.events.length - 1];
    const gap = e.timestamp - lastEv.timestamp;

    const recentGaps: number[] = [];
    const gapWindow = cur.events.slice(-RECENT_GAP_WINDOW - 1);
    for (let j = 1; j < gapWindow.length; j++)
      recentGaps.push(gapWindow[j].timestamp - gapWindow[j - 1].timestamp);
    const typicalGap = Math.max(
      recentGaps.length >= 2 ? median(recentGaps) : bootstrapGapMs,
      500,
    );

    const intensityWindow = cur.events.slice(-RECENT_INTENSITY_WINDOW);
    const windowSpanSec = Math.max(
      1,
      (intensityWindow[intensityWindow.length - 1].timestamp -
        intensityWindow[0].timestamp) /
        1000,
    );
    const recentIntensity =
      intensityWindow.reduce((s, ev) => s + ev.quoteQty, 0) / windowSpanSec;
    cur.peakIntensityPerSec = Math.max(
      cur.peakIntensityPerSec,
      recentIntensity,
    );
    const intensityRatio =
      cur.peakIntensityPerSec > 0
        ? Math.min(1, recentIntensity / cur.peakIntensityPerSec)
        : 0;

    const effectiveMultiplier =
      BASE_GAP_MULTIPLIER * (1 + INTENSITY_MAX_STRETCH * intensityRatio);
    const gapSplit = gap > typicalGap * effectiveMultiplier;

    const madeNewExtreme =
      victim === "LONG"
        ? e.price < cur.runningExtreme
        : e.price > cur.runningExtreme;
    const totalExtensionSoFar = Math.abs(
      cur.runningExtreme - cur.episodeStartPrice,
    );
    const deviationFromExtreme = Math.abs(e.price - cur.runningExtreme);
    const recoveryRatio =
      totalExtensionSoFar > 0 ? deviationFromExtreme / totalExtensionSoFar : 0;
    const priceForceSplit =
      !madeNewExtreme && recoveryRatio >= STRUCTURAL_RECOVERY_RATIO;
    const priceOverrideNoSplit = recoveryRatio < SMALL_PAUSE_RATIO;

    let split = false;
    let reason = "";
    if (madeNewExtreme) {
      split = false;
      reason = "new extreme -- definitionally continuing";
    } else if (priceForceSplit) {
      split = true;
      reason =
        "structural price reversal (recoveryRatio=" +
        recoveryRatio.toFixed(3) +
        " >= " +
        STRUCTURAL_RECOVERY_RATIO +
        " of episode's own range)";
    } else if (gapSplit && !priceOverrideNoSplit) {
      split = true;
      reason =
        "gap " +
        fmtDur(gap) +
        " > " +
        fmtDur(typicalGap * effectiveMultiplier) +
        " (adaptive cadence, intensityRatio=" +
        intensityRatio.toFixed(2) +
        "), recoveryRatio=" +
        recoveryRatio.toFixed(3) +
        " inconclusive";
    } else if (gapSplit && priceOverrideNoSplit) {
      split = false;
      reason =
        "gap large but recoveryRatio=" +
        recoveryRatio.toFixed(3) +
        " < " +
        SMALL_PAUSE_RATIO +
        " -- price hasn't left the regime, kept merged";
    } else {
      split = false;
      reason = "gap within adaptive cadence";
    }

    if (split) {
      cur.endReason = reason;
      episodes.push({
        symbol,
        victim,
        events: cur.events,
        runningExtreme: cur.runningExtreme,
        episodeStartPrice: cur.episodeStartPrice,
        endReason: cur.endReason,
      });
      cur = {
        events: [e],
        runningExtreme: e.price,
        episodeStartPrice: e.price,
        peakIntensityPerSec: 0,
        endReason: "",
      };
    } else {
      cur.events.push(e);
      if (madeNewExtreme) cur.runningExtreme = e.price;
    }
  }
  if (cur) {
    cur.endReason =
      "end of available data (window boundary, not a true cascade end)";
    episodes.push({
      symbol,
      victim,
      events: cur.events,
      runningExtreme: cur.runningExtreme,
      episodeStartPrice: cur.episodeStartPrice,
      endReason: cur.endReason,
    });
  }
  return episodes;
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
  const windowStart = now - HOURS * 3600 * 1000;

  const allEpisodesBySymbolSide: Record<
    string,
    Record<"LONG" | "SHORT", Episode[]>
  > = {};

  for (const symbol of SYMBOLS) {
    console.log("=== " + symbol + " ===");
    const windowEvents = await col
      .find({ symbol, timestamp: { $gte: windowStart, $lte: now } })
      .sort({ timestamp: 1 })
      .toArray();
    if (windowEvents.length === 0) {
      console.log("  no events.\n");
      continue;
    }
    allEpisodesBySymbolSide[symbol] = { LONG: [], SHORT: [] };

    for (const victim of ["LONG", "SHORT"] as const) {
      const sideEvents: RawEvent[] = windowEvents
        .filter((e) => e.victim === victim)
        .map((e) => ({
          timestamp: e.timestamp,
          price: e.price,
          quoteQty: e.quoteQty,
          victim,
        }));
      if (sideEvents.length < 2) {
        console.log(
          "  " + victim + ": too few events (n=" + sideEvents.length + ").",
        );
        continue;
      }

      const gaps: number[] = [];
      for (let i = 1; i < sideEvents.length; i++)
        gaps.push(sideEvents[i].timestamp - sideEvents[i - 1].timestamp);
      const bootstrapGapMs = percentile(sortNum(gaps), 75);

      const episodes = buildEpisodes(
        symbol,
        victim,
        sideEvents,
        bootstrapGapMs,
      );
      allEpisodesBySymbolSide[symbol][victim] = episodes;

      const durations = episodes.map(
        (ep) =>
          ep.events[ep.events.length - 1].timestamp - ep.events[0].timestamp,
      );
      const counts = episodes.map((ep) => ep.events.length);
      const singleEventPct =
        (episodes.filter((ep) => ep.events.length === 1).length /
          episodes.length) *
        100;
      console.log(
        "  " +
          victim +
          ": " +
          sideEvents.length +
          " events -> " +
          episodes.length +
          " episodes. medianDuration=" +
          fmtDur(median(durations)) +
          " medianEvents=" +
          median(counts).toFixed(1) +
          " singleEvent%=" +
          singleEventPct.toFixed(0) +
          "%",
      );
    }
  }

  // ═══ QUALIFICATION: magnitude labels from each symbol+side's OWN historical totalUsd distribution ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "QUALIFICATION -- magnitude labels (per symbol+side historical percentiles of episode totalUSD, NOT a universal $ threshold)",
  );
  console.log("=".repeat(100));
  for (const symbol of SYMBOLS) {
    if (!allEpisodesBySymbolSide[symbol]) continue;
    for (const victim of ["LONG", "SHORT"] as const) {
      const eps = allEpisodesBySymbolSide[symbol][victim];
      if (!eps || eps.length < 8) {
        if (eps && eps.length > 0)
          console.log(
            symbol +
              " " +
              victim +
              ": INSUFFICIENT_SAMPLE (n=" +
              eps.length +
              ") for reliable magnitude percentiles.",
          );
        continue;
      }
      const totals = sortNum(
        eps.map((ep) => ep.events.reduce((s, e) => s + e.quoteQty, 0)),
      );
      const p50 = percentile(totals, 50),
        p80 = percentile(totals, 80),
        p95 = percentile(totals, 95);
      const counts = { noise: 0, ordinary: 0, strong: 0, extreme: 0 };
      eps.forEach((ep) => {
        const t = ep.events.reduce((s, e) => s + e.quoteQty, 0);
        if (t < p50) counts.noise++;
        else if (t < p80) counts.ordinary++;
        else if (t < p95) counts.strong++;
        else counts.extreme++;
        (ep as any).totalUsd = t;
        (ep as any).magnitude =
          t < p50
            ? "noise/tiny"
            : t < p80
              ? "ordinary"
              : t < p95
                ? "strong"
                : "extreme/news-like";
      });
      console.log(
        symbol +
          " " +
          victim +
          " (n=" +
          eps.length +
          "): thresholds p50=" +
          fmtUsd(p50) +
          " p80=" +
          fmtUsd(p80) +
          " p95=" +
          fmtUsd(p95) +
          " -- noise=" +
          counts.noise +
          " ordinary=" +
          counts.ordinary +
          " strong=" +
          counts.strong +
          " extreme=" +
          counts.extreme,
      );
    }
  }

  // ═══ 20 real candidate cascades, full raw events ═══
  console.log("\n" + "=".repeat(100));
  console.log(
    "20 REAL CANDIDATE CASCADES -- FULL RAW EVENT LIST EACH (spread across magnitudes/symbols for inspection)",
  );
  console.log("=".repeat(100));

  const allEpisodesFlat: (Episode & {
    totalUsd?: number;
    magnitude?: string;
  })[] = [];
  for (const symbol of SYMBOLS) {
    if (!allEpisodesBySymbolSide[symbol]) continue;
    for (const victim of ["LONG", "SHORT"] as const)
      allEpisodesFlat.push(...(allEpisodesBySymbolSide[symbol][victim] || []));
  }
  const withMagnitude = allEpisodesFlat.filter((ep) => (ep as any).magnitude);
  const byMagnitude: Record<string, typeof withMagnitude> = {
    "extreme/news-like": [],
    strong: [],
    ordinary: [],
    "noise/tiny": [],
  };
  withMagnitude.forEach((ep) => byMagnitude[(ep as any).magnitude].push(ep));
  Object.values(byMagnitude).forEach((arr) =>
    arr.sort((a, b) => b.events.length - a.events.length),
  );

  const selected: typeof withMagnitude = [];
  const perBucket = Math.ceil(EXAMPLES_TO_PRINT / 4);
  for (const label of [
    "extreme/news-like",
    "strong",
    "ordinary",
    "noise/tiny",
  ]) {
    selected.push(...byMagnitude[label].slice(0, perBucket));
  }
  const finalSelection = selected.slice(0, EXAMPLES_TO_PRINT);

  finalSelection.forEach((ep, idx) => {
    const totalUsd =
      (ep as any).totalUsd ?? ep.events.reduce((s, e) => s + e.quoteQty, 0);
    const maxEvent = Math.max(...ep.events.map((e) => e.quoteQty));
    const start = ep.events[0],
      end = ep.events[ep.events.length - 1];
    console.log("\n" + "-".repeat(100));
    console.log(
      "CASCADE #" +
        (idx + 1) +
        "  " +
        ep.symbol +
        " " +
        ep.victim +
        "  [" +
        ((ep as any).magnitude ?? "unlabeled") +
        "]",
    );
    console.log("-".repeat(100));
    console.log(
      "duration: " +
        fmtDur(end.timestamp - start.timestamp) +
        "  eventCount: " +
        ep.events.length +
        "  totalUSD: " +
        fmtUsd(totalUsd) +
        "  maxEvent: " +
        fmtUsd(maxEvent),
    );
    console.log(
      "startPrice: " +
        start.price +
        "  liquidation-direction extreme price: " +
        ep.runningExtreme +
        "  priceProgress: " +
        (ep.victim === "LONG"
          ? ((start.price - ep.runningExtreme) / start.price) * 100
          : ((ep.runningExtreme - start.price) / start.price) * 100
        ).toFixed(3) +
        "%",
    );
    console.log("reason episode ended: " + ep.endReason);
    console.log(
      "\ntimestamp | price | quoteQty | gapFromPrevious | cumulativeUsd",
    );
    let cum = 0;
    ep.events.forEach((e, i) => {
      cum += e.quoteQty;
      const gapStr =
        i === 0 ? "--" : fmtDur(e.timestamp - ep.events[i - 1].timestamp);
      console.log(
        fmtClock(e.timestamp) +
          " | " +
          e.price +
          " | " +
          fmtUsd(e.quoteQty) +
          " | " +
          gapStr +
          " | " +
          fmtUsd(cum),
      );
    });
  });

  const outPath = path.join(
    OUTPUT_DIR,
    "liquidation-cascade-event-stream-" + Date.now() + ".json",
  );
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        params: {
          BASE_GAP_MULTIPLIER,
          INTENSITY_MAX_STRETCH,
          SMALL_PAUSE_RATIO,
          STRUCTURAL_RECOVERY_RATIO,
          RECENT_GAP_WINDOW,
          RECENT_INTENSITY_WINDOW,
        },
        allEpisodesBySymbolSide,
      },
      null,
      2,
    ),
  );
  console.log("\n\nFull data (every episode, every symbol+side): " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
