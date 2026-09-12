/**
 * Sep 12 2026 (Karo), operator-requested v2 -- fixes the circular
 * ground-truth problem in the v1 research script. NO episode boundary
 * is ever used to define "correct" or "false". Every candidate END
 * declaration is judged ONLY by what actually happens in the FUTURE
 * (forward-looking liquidation + price behavior). A 10-minute
 * same-side gap is used ONLY as a broad, computational container --
 * explicitly documented as NEVER a production rule and NEVER the
 * definition of "ended".
 *
 * READ-ONLY. No production code/strategy/Mongo writes.
 */
require("dotenv/config");
const { MongoClient } = require("mongodb");
const https = require("https");
const fs = require("fs");
const path = require("path");

const SYMBOL = "ETHUSDT";
const HOURS = 72;
const OUTER_CONTAINER_GAP_MS = 10 * 60 * 1000; // NEVER a production rule -- see file header
const CANDIDATE_SILENCE_SEC = [10, 20, 30, 45, 60, 90, 120];
const FORWARD_HORIZONS_SEC = [30, 60, 120, 180, 300];
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

function fmtUsd(n) {
  if (n === null || n === undefined) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtMs(ms) {
  if (ms === null || ms === undefined) return "n/a";
  const s = ms / 1000;
  if (Math.abs(s) < 60) return s.toFixed(1) + "s";
  return (s / 60).toFixed(1) + "m";
}
function fmtPct(n) {
  return n === null || n === undefined ? "n/a" : n.toFixed(2) + "%";
}
function sortNum(a) {
  return [...a]
    .filter((x) => x !== null && x !== undefined && !isNaN(x))
    .sort((x, y) => x - y);
}
function median(a) {
  return percentile(a, 50);
}
function percentile(arr, p) {
  const s = sortNum(arr);
  if (!s.length) return null;
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
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
  while (cursor <= endTime) {
    const chunkEnd = Math.min(cursor + 1499 * 60000, endTime);
    const url =
      "https://fapi.binance.com/fapi/v1/klines?symbol=" +
      symbol +
      "&interval=1m&startTime=" +
      cursor +
      "&endTime=" +
      chunkEnd +
      "&limit=1500";
    const raw = await httpsGetJson(url);
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw)
      byOpenTime.set(k[0], {
        t: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
      });
    cursor = raw[raw.length - 1][0] + 60000;
  }
  return byOpenTime;
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
  const startTs = now - HOURS * 3600 * 1000;
  console.log(
    "Fetching " + SYMBOL + " raw liquidation events, last " + HOURS + "h...",
  );
  const allEvents = await col
    .find({ symbol: SYMBOL, timestamp: { $gte: startTs, $lte: now } })
    .sort({ timestamp: 1 })
    .toArray();
  console.log("  " + allEvents.length + " events.");

  console.log("Fetching " + SYMBOL + " 1m candles (Binance REST)...");
  const klines = await fetchKlines(SYMBOL, startTs - 600000, now + 5 * 60000);
  console.log("  " + klines.size + " candles.");
  function candleAt(ms) {
    return klines.get(Math.floor(ms / 60000) * 60000) || null;
  }
  function priceAt(ms) {
    const c = candleAt(ms);
    return c ? c.close : null;
  }

  const result = {
    symbol: SYMBOL,
    hours: HOURS,
    generatedAt: new Date(now).toISOString(),
    methodologyNote:
      "10-minute same-side gap used ONLY as a broad computational container, NEVER as the definition of cascade end. All candidate END declarations below are evaluated purely by FORWARD-LOOKING future liquidation + price behavior.",
  };

  for (const victim of ["LONG", "SHORT"]) {
    console.log("\n=== Processing " + victim + " ===");
    const sideEvents = allEvents.filter((e) => e.victim === victim);
    if (sideEvents.length === 0) {
      console.log("  no events.");
      continue;
    }

    // ── Rolling directional-extreme tracker (per side, across the WHOLE stream, from candles) ──
    // For LONG: extreme = running minimum low seen so far (since stream start). For SHORT: running maximum high.
    function extremeSoFar(uptoMs, sinceMs) {
      let ext = null,
        extTs = null;
      for (
        let t = Math.floor(sinceMs / 60000) * 60000;
        t <= uptoMs;
        t += 60000
      ) {
        const c = candleAt(t);
        if (!c) continue;
        const val = victim === "LONG" ? c.low : c.high;
        if (ext === null || (victim === "LONG" ? val < ext : val > ext)) {
          ext = val;
          extTs = t;
        }
      }
      return { ext, extTs };
    }

    // ── Broad 10-min containers, computational only ──
    const containers = [];
    let cur = [sideEvents[0]];
    for (let i = 1; i < sideEvents.length; i++) {
      if (
        sideEvents[i].timestamp - sideEvents[i - 1].timestamp >
        OUTER_CONTAINER_GAP_MS
      ) {
        containers.push(cur);
        cur = [sideEvents[i]];
      } else cur.push(sideEvents[i]);
    }
    containers.push(cur);
    console.log(
      "  " + containers.length + " broad 10m containers (computational only).",
    );

    // ═══ CANDIDATE END-DECLARATIONS: walk chronologically, forward-looking outcome ═══
    const candidates = [];
    for (const container of containers) {
      const containerStart = container[0].timestamp;
      for (let i = 0; i < container.length; i++) {
        const evTs = container[i].timestamp;
        const nextEvTs =
          i + 1 < container.length ? container[i + 1].timestamp : null;
        const actualGapAfter =
          nextEvTs !== null
            ? nextEvTs - evTs
            : containerStart + OUTER_CONTAINER_GAP_MS + 600000 - evTs; // treat end-of-container as "very long gap" for threshold-qualification purposes
        for (const silenceSec of CANDIDATE_SILENCE_SEC) {
          const silenceMs = silenceSec * 1000;
          if (actualGapAfter < silenceMs) continue; // this candidate silence-duration was never actually reached before the next same-side event
          const candTs = evTs + silenceMs;

          // ── STATE at candidate time (using ONLY data up to candTs -- no look-ahead) ──
          const priorEventsInContainer = container.slice(0, i + 1);
          const w10 = priorEventsInContainer.filter(
            (e) => e.timestamp > candTs - 10000 && e.timestamp <= candTs,
          );
          const w30 = priorEventsInContainer.filter(
            (e) => e.timestamp > candTs - 30000 && e.timestamp <= candTs,
          );
          const w60 = priorEventsInContainer.filter(
            (e) => e.timestamp > candTs - 60000 && e.timestamp <= candTs,
          );
          const largest30 = w30.length
            ? Math.max(...w30.map((e) => e.quoteQty))
            : 0;
          const largest60 = w60.length
            ? Math.max(...w60.map((e) => e.quoteQty))
            : 0;
          const timeSinceLastEventMs = candTs - evTs;
          const { ext: extremeSoFarVal, extTs: extremeSoFarTs } = extremeSoFar(
            candTs,
            containerStart - 60000,
          );
          const curPrice = priceAt(candTs);
          const timeSinceLastNewExtremeMs =
            extremeSoFarTs !== null ? candTs - extremeSoFarTs : null;
          const recoveryFromExtremePct =
            curPrice !== null && extremeSoFarVal !== null
              ? victim === "LONG"
                ? ((curPrice - extremeSoFarVal) / extremeSoFarVal) * 100
                : ((extremeSoFarVal - curPrice) / extremeSoFarVal) * 100
              : null;
          // still making new extremes? check the last 60s of candles for a new extreme vs extremeSoFarVal computed just before this 60s window
          const { ext: extreme60sAgo } = extremeSoFar(
            candTs - 60000,
            containerStart - 60000,
          );
          const stillMakingNewExtremes =
            extremeSoFarVal !== null && extreme60sAgo !== null
              ? extremeSoFarVal !== extreme60sAgo
              : null;

          // ── burst reference for pressure-collapse ratio: the largest same-side burst (5s-clustered) BEFORE this candidate ──
          function clusterBursts(evs, gapMs) {
            const out = [];
            let c2 = [evs[0]];
            for (let j = 1; j < evs.length; j++) {
              if (evs[j].timestamp - evs[j - 1].timestamp > gapMs) {
                out.push(c2);
                c2 = [evs[j]];
              } else c2.push(evs[j]);
            }
            out.push(c2);
            return out;
          }
          const burstsSoFar = clusterBursts(priorEventsInContainer, 5000);
          const burstLiqTotals = burstsSoFar.map((b) =>
            b.reduce((s, e) => s + e.quoteQty, 0),
          );
          const previousBurstLiq = burstLiqTotals.length
            ? Math.max(...burstLiqTotals)
            : 0;

          // ── FORWARD-LOOKING OUTCOME (the actual ground truth) ──
          const forward = {};
          for (const horizonSec of FORWARD_HORIZONS_SEC) {
            const horizonEnd = candTs + horizonSec * 1000;
            const laterSameSide = allEvents.filter(
              (e) =>
                e.victim === victim &&
                e.timestamp > candTs &&
                e.timestamp <= horizonEnd,
            );
            const laterOppositeAlsoExists = laterSameSide.length > 0;
            const laterLiqUsd = laterSameSide.reduce(
              (s, e) => s + e.quoteQty,
              0,
            );
            const largestLater = laterSameSide.length
              ? Math.max(...laterSameSide.map((e) => e.quoteQty))
              : 0;
            const { ext: extremeInHorizon } = extremeSoFar(horizonEnd, candTs);
            const newExtremeMade =
              extremeSoFarVal !== null && extremeInHorizon !== null
                ? victim === "LONG"
                  ? extremeInHorizon < extremeSoFarVal
                  : extremeInHorizon > extremeSoFarVal
                : null;
            const priceAtHorizonEnd = priceAt(horizonEnd);
            const furtherAdverseMovePct =
              curPrice !== null && extremeInHorizon !== null
                ? victim === "LONG"
                  ? ((curPrice - extremeInHorizon) / curPrice) * 100
                  : ((extremeInHorizon - curPrice) / curPrice) * 100
                : null;
            const favorableRecoveryMovePct =
              curPrice !== null && priceAtHorizonEnd !== null
                ? victim === "LONG"
                  ? ((priceAtHorizonEnd - curPrice) / curPrice) * 100
                  : ((curPrice - priceAtHorizonEnd) / curPrice) * 100
                : null;
            forward[horizonSec + "s"] = {
              laterSameSideLiqUsd: laterLiqUsd,
              largestLaterEvent: largestLater,
              laterEventCount: laterSameSide.length,
              strongBurstOccurred: largestLater >= previousBurstLiq * 0.3,
              newDirectionalExtremeMade: newExtremeMade,
              furtherAdverseMovePct,
              favorableRecoveryMovePct,
            };
          }

          candidates.push({
            victim,
            silenceSec,
            candTs,
            candTsIso: new Date(candTs).toISOString(),
            state: {
              liqUsdPrev10s: w10.reduce((s, e) => s + e.quoteQty, 0),
              liqUsdPrev30s: w30.reduce((s, e) => s + e.quoteQty, 0),
              liqUsdPrev60s: w60.reduce((s, e) => s + e.quoteQty, 0),
              eventCountPrev10s: w10.length,
              eventCountPrev30s: w30.length,
              eventCountPrev60s: w60.length,
              largestEventPrev30s: largest30,
              largestEventPrev60s: largest60,
              timeSinceLastEventMs,
              currentPrice: curPrice,
              currentDirectionalExtreme: extremeSoFarVal,
              timeSinceLastNewExtremeMs,
              recoveryFromExtremePct,
              stillMakingNewExtremes,
              previousBurstLiq,
              pressureRatio10s:
                previousBurstLiq > 0
                  ? (w10.reduce((s, e) => s + e.quoteQty, 0) /
                      previousBurstLiq) *
                    100
                  : null,
              pressureRatio30s:
                previousBurstLiq > 0
                  ? (w30.reduce((s, e) => s + e.quoteQty, 0) /
                      previousBurstLiq) *
                    100
                  : null,
            },
            forward,
          });
        }
      }
    }
    console.log(
      "  " +
        candidates.length +
        " candidate END-declarations generated across all 7 silence-thresholds.",
    );
    result[victim + "_candidates"] = candidates;

    // ═══ SECTION: second-push / meaningful-burst gap distribution ═══
    function clusterBursts(evs, gapMs) {
      const out = [];
      let c2 = [evs[0]];
      for (let j = 1; j < evs.length; j++) {
        if (evs[j].timestamp - evs[j - 1].timestamp > gapMs) {
          out.push(c2);
          c2 = [evs[j]];
        } else c2.push(evs[j]);
      }
      out.push(c2);
      return out;
    }
    const allBursts = clusterBursts(sideEvents, 5000).map((b) => ({
      start: b[0].timestamp,
      end: b[b.length - 1].timestamp,
      totalUsd: b.reduce((s, e) => s + e.quoteQty, 0),
      count: b.length,
    }));
    const burstGaps = [];
    for (let i = 1; i < allBursts.length; i++) {
      const gapMs = allBursts[i].start - allBursts[i - 1].end;
      const { ext: extBefore } = extremeSoFar(
        allBursts[i - 1].end,
        allBursts[0].start - 60000,
      );
      const { ext: extAfter } = extremeSoFar(
        allBursts[i].end,
        allBursts[0].start - 60000,
      );
      const newExtreme =
        extBefore !== null && extAfter !== null
          ? victim === "LONG"
            ? extAfter < extBefore
            : extAfter > extBefore
          : null;
      burstGaps.push({
        gapMs,
        firstBurstUsd: allBursts[i - 1].totalUsd,
        secondBurstUsd: allBursts[i].totalUsd,
        sizeRatio:
          allBursts[i - 1].totalUsd > 0
            ? allBursts[i].totalUsd / allBursts[i - 1].totalUsd
            : null,
        newExtremeMade: newExtreme,
      });
    }
    result[victim + "_burstGapDistribution"] = {
      totalBursts: allBursts.length,
      gapCount: burstGaps.length,
      gapPercentilesMs: {
        p50: percentile(
          burstGaps.map((g) => g.gapMs),
          50,
        ),
        p75: percentile(
          burstGaps.map((g) => g.gapMs),
          75,
        ),
        p90: percentile(
          burstGaps.map((g) => g.gapMs),
          90,
        ),
        p95: percentile(
          burstGaps.map((g) => g.gapMs),
          95,
        ),
        p99: percentile(
          burstGaps.map((g) => g.gapMs),
          99,
        ),
        max: burstGaps.length
          ? Math.max(...burstGaps.map((g) => g.gapMs))
          : null,
      },
      sizeRatioMedian: median(burstGaps.map((g) => g.sizeRatio)),
      newExtremePct: burstGaps.length
        ? (burstGaps.filter((g) => g.newExtremeMade).length /
            burstGaps.length) *
          100
        : null,
      rawGaps: burstGaps,
    };
  }

  // ── Write full JSON ──
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "eth-cascade-end-v2-future-outcome-" + Date.now() + ".json",
  );
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log("\nFull output written to: " + outPath);

  // ── Compact terminal summary ──
  console.log("\n" + "=".repeat(100));
  console.log("COMPACT TERMINAL SUMMARY (paste-ready)");
  console.log("=".repeat(100));
  for (const victim of ["LONG", "SHORT"]) {
    const cands = result[victim + "_candidates"];
    if (!cands || !cands.length) {
      console.log("\n" + victim + ": no candidates.");
      continue;
    }
    console.log("\n--- " + victim + " ---");
    console.log("Total candidate END-declarations: " + cands.length);
    const bg = result[victim + "_burstGapDistribution"];
    console.log(
      "Burst-gap distribution (ms): p50=" +
        fmtMs(bg.gapPercentilesMs.p50) +
        " p75=" +
        fmtMs(bg.gapPercentilesMs.p75) +
        " p90=" +
        fmtMs(bg.gapPercentilesMs.p90) +
        " p95=" +
        fmtMs(bg.gapPercentilesMs.p95) +
        " p99=" +
        fmtMs(bg.gapPercentilesMs.p99) +
        " max=" +
        fmtMs(bg.gapPercentilesMs.max),
    );
    console.log(
      "Burst size-ratio median (2nd/1st): " +
        (bg.sizeRatioMedian !== null ? bg.sizeRatioMedian.toFixed(2) : "n/a") +
        "  |  % of gaps followed by a NEW extreme: " +
        fmtPct(bg.newExtremePct),
    );

    console.log(
      "\nBy silence-threshold -- new-extreme-within-60s probability (the core false-end risk signal):",
    );
    for (const sec of CANDIDATE_SILENCE_SEC) {
      const subset = cands.filter((c) => c.silenceSec === sec);
      if (!subset.length) {
        console.log("  " + sec + "s: no candidates");
        continue;
      }
      const newExtreme60 = subset.filter(
        (c) => c.forward["60s"].newDirectionalExtremeMade === true,
      ).length;
      const strongBurst60 = subset.filter(
        (c) => c.forward["60s"].strongBurstOccurred,
      ).length;
      console.log(
        "  " +
          sec +
          "s: n=" +
          subset.length +
          "  newExtreme-within-60s=" +
          fmtPct((newExtreme60 / subset.length) * 100) +
          "  strongBurst-within-60s=" +
          fmtPct((strongBurst60 / subset.length) * 100),
      );
    }
  }
  console.log(
    "\n(Full per-candidate state+forward-outcome data, and raw burst-gap list, are in the JSON file -- this terminal summary is intentionally compact.)",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
