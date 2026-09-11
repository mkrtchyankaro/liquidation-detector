require("dotenv/config");
const { MongoClient } = require("mongodb");
const https = require("https");
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

function fmtTs(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function minuteFloor(ms) {
  return Math.floor(ms / 60000) * 60000;
}
function percentile(arr, p) {
  const a = arr
    .filter((x) => typeof x === "number" && !isNaN(x))
    .slice()
    .sort((x, y) => x - y);
  if (a.length === 0) return null;
  const idx = (p / 100) * (a.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}
function median(arr) {
  return percentile(arr, 50);
}
function mean(arr) {
  const a = arr.filter((x) => typeof x === "number" && !isNaN(x));
  if (a.length === 0) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Bad JSON from " + url));
          }
        });
      })
      .on("error", reject);
  });
}
async function fetchKlinesRange(symbol, startTime, endTime) {
  const base = process.env.BINANCE_REST_BASE_URL || "https://fapi.binance.com";
  const byOpenTime = new Map();
  let cursor = startTime;
  const CHUNK = 1500;
  while (cursor <= endTime) {
    const chunkEnd = Math.min(cursor + (CHUNK - 1) * 60000, endTime);
    const url =
      base +
      "/fapi/v1/klines?symbol=" +
      symbol +
      "&interval=1m&startTime=" +
      cursor +
      "&endTime=" +
      chunkEnd +
      "&limit=" +
      CHUNK;
    const raw = await httpsGetJson(url);
    if (!Array.isArray(raw))
      throw new Error(
        "Unexpected klines response: " + JSON.stringify(raw).slice(0, 200),
      );
    for (const k of raw)
      byOpenTime.set(k[0], {
        t: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
      });
    if (raw.length === 0) cursor = chunkEnd + 60000;
    else cursor = raw[raw.length - 1][0] + 60000;
    if (cursor <= startTime) break;
  }
  return byOpenTime;
}

function simpleAtr20(candlesAscBeforeT, n) {
  if (candlesAscBeforeT.length < n + 1) return null;
  const window = candlesAscBeforeT.slice(-(n + 1));
  const trs = [];
  for (let i = 1; i < window.length; i++) {
    const c = window[i],
      prev = window[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
      ),
    );
  }
  return trs.reduce((s, x) => s + x, 0) / trs.length;
}

async function main() {
  const args = process.argv.slice(2);
  const symbolIdx = args.indexOf("--symbol");
  const symbol = symbolIdx !== -1 ? args[symbolIdx + 1] : "BTCUSDT";
  const runSensitivity = args.includes("--sensitivity");
  const focusDateIdx = args.indexOf("--focus-date");
  const focusDate = focusDateIdx !== -1 ? args[focusDateIdx + 1] : "2026-09-11";

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  const rawCol = db.collection("liq_raw_events");

  console.log("=".repeat(90));
  console.log(
    "TWO-WAVE LIQUIDATION-REVERSAL BACKTEST -- " + symbol + " LONG-reversal",
  );
  console.log("=".repeat(90));
  console.log(
    "DATA SOURCE: liq_raw_events ONLY (liq_minute_aggregates verified EMPTY, unused).",
  );

  const earliestDoc = await rawCol
    .find({})
    .sort({ timestamp: 1 })
    .limit(1)
    .toArray();
  const latestDoc = await rawCol
    .find({})
    .sort({ timestamp: -1 })
    .limit(1)
    .toArray();
  if (earliestDoc.length === 0) {
    console.error("liq_raw_events is completely empty -- cannot run.");
    await client.close();
    return;
  }
  const coverageStart = earliestDoc[0].timestamp;
  const coverageEnd = latestDoc[0].timestamp;
  console.log(
    "liq_raw_events coverage: " +
      fmtTs(coverageStart) +
      " .. " +
      fmtTs(coverageEnd) +
      "  (" +
      ((coverageEnd - coverageStart) / 3600000).toFixed(1) +
      " hours -- NOT a full 7 days; this is the actual verified window, used in full)",
  );

  const startTime = minuteFloor(coverageStart) + 60000;
  const endTime = minuteFloor(coverageEnd);
  const dataFetchStart = startTime - 25 * 60 * 60000;

  console.log(
    "\nFetching candles (Binance REST klines, last-trade-price basis, same as the live @kline_1m stream)...",
  );
  const klines = await fetchKlinesRange(symbol, dataFetchStart, endTime);
  const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
  console.log("  " + candlesAsc.length + " candles fetched.");

  console.log(
    "Fetching liq_raw_events and building minute buckets directly (no aggregate collection used)...",
  );
  const rawEvents = await rawCol
    .find({
      symbol: symbol,
      victim: "LONG",
      timestamp: { $gte: startTime, $lte: endTime },
    })
    .sort({ timestamp: 1 })
    .toArray();
  const longSumByMinute = new Map();
  const longCountByMinute = new Map();
  for (const e of rawEvents) {
    const m = minuteFloor(e.timestamp);
    longSumByMinute.set(m, (longSumByMinute.get(m) || 0) + e.quoteQty);
    longCountByMinute.set(m, (longCountByMinute.get(m) || 0) + 1);
  }
  console.log(
    "  " +
      rawEvents.length +
      " raw LONG-liquidation events -> " +
      longSumByMinute.size +
      " distinct minutes with recorded liquidation.",
  );

  let assumedZeroMinuteCount = 0;
  function longLiqUsdAt(minuteStart) {
    if (longSumByMinute.has(minuteStart))
      return { value: longSumByMinute.get(minuteStart), status: "RECORDED" };
    assumedZeroMinuteCount++;
    return { value: 0, status: "ASSUMED_ZERO_UNVERIFIED" };
  }

  const candleByMinute = new Map(candlesAsc.map((c) => [c.t, c]));
  function candleAt(minuteStart) {
    return candleByMinute.get(minuteStart) || null;
  }

  function buildEpisodeFrom(startMinute, maxScanMinutes) {
    let t = startMinute;
    let liqMinutes = [];
    let zeroStreak = 0;
    let lastLiqTime = null;
    let sawDataGap = false;
    let scanned = 0;
    const anchorCandle = candleAt(startMinute - 60000) || candleAt(startMinute);
    const anchorPrice = anchorCandle ? anchorCandle.open : null;
    let extremePrice = null,
      extremeTime = null;

    while (scanned < maxScanMinutes) {
      const c = candleAt(t);
      if (!c) {
        sawDataGap = true;
        break;
      }
      const liq = longLiqUsdAt(t);
      if (extremePrice === null || c.low < extremePrice) {
        extremePrice = c.low;
        extremeTime = t;
      }

      if (liq.value > 0) {
        liqMinutes.push({ t, longLiqUsd: liq.value });
        lastLiqTime = t;
        zeroStreak = 0;
      } else {
        zeroStreak++;
        if (zeroStreak >= 2 && lastLiqTime !== null) {
          return {
            valid: true,
            startTime: startMinute,
            lastLiqTime,
            confirmedEndTime: t,
            totalLiqUsd: liqMinutes.reduce((s, m) => s + m.longLiqUsd, 0),
            peakMinuteLiqUsd: Math.max(...liqMinutes.map((m) => m.longLiqUsd)),
            liquidationMinuteCount: liqMinutes.length,
            durationMinutes: (lastLiqTime - startMinute) / 60000,
            anchorPrice,
            extremePrice,
            extremeTime,
            dataGap: false,
          };
        }
      }
      t += 60000;
      scanned++;
    }
    return {
      valid: false,
      startTime: startMinute,
      lastLiqTime,
      confirmedEndTime: null,
      totalLiqUsd: liqMinutes.reduce((s, m) => s + m.longLiqUsd, 0),
      peakMinuteLiqUsd: liqMinutes.length
        ? Math.max(...liqMinutes.map((m) => m.longLiqUsd))
        : 0,
      liquidationMinuteCount: liqMinutes.length,
      durationMinutes:
        lastLiqTime !== null ? (lastLiqTime - startMinute) / 60000 : 0,
      anchorPrice,
      extremePrice,
      extremeTime,
      dataGap: sawDataGap,
    };
  }

  console.log(
    "\nBuilding the full historical episode list (reused for both the p90 baseline and live tracking)...",
  );
  const allEpisodes = [];
  {
    let t = dataFetchStart;
    while (t <= endTime) {
      const liq = longLiqUsdAt(t);
      if (liq.status === "RECORDED" && liq.value > 0) {
        const ep = buildEpisodeFrom(t, 24 * 60);
        if (ep.confirmedEndTime !== null) {
          allEpisodes.push(ep);
          t = ep.confirmedEndTime + 60000;
          continue;
        } else {
          t = (ep.lastLiqTime || t) + 60000;
          continue;
        }
      }
      t += 60000;
    }
  }
  console.log(
    "  " +
      allEpisodes.length +
      " completed long-liquidation episodes built across the full fetch window.",
  );
  console.log(
    "  Minutes treated as ASSUMED_ZERO_UNVERIFIED during this build: " +
      assumedZeroMinuteCount +
      " (see file header for why these cannot be independently confirmed).",
  );

  function historicalP90Baseline(beforeTime) {
    const windowStart = beforeTime - 24 * 60 * 60000;
    const relevant = allEpisodes.filter(
      (e) =>
        e.confirmedEndTime !== null &&
        e.confirmedEndTime < beforeTime &&
        e.confirmedEndTime >= windowStart,
    );
    return {
      count: relevant.length,
      p50: percentile(
        relevant.map((e) => e.totalLiqUsd),
        50,
      ),
      p75: percentile(
        relevant.map((e) => e.totalLiqUsd),
        75,
      ),
      p90: percentile(
        relevant.map((e) => e.totalLiqUsd),
        90,
      ),
      p95: percentile(
        relevant.map((e) => e.totalLiqUsd),
        95,
      ),
    };
  }

  function runDetector(params, verboseTrace) {
    const P = Object.assign(
      { minPercentile: 90, minDistanceAtr: 0.3, minBounceAtr: 0.2 },
      params,
    );
    const setups = [];
    let cursor = startTime;

    while (cursor <= endTime) {
      const liq = longLiqUsdAt(cursor);
      if (liq.status !== "RECORDED" || !(liq.value > 0)) {
        cursor += 60000;
        continue;
      }

      const setup = {
        symbol,
        transitions: [],
        state: "NORMAL",
        cancelReason: null,
      };
      function log(tsAt, from, to, reason, extra) {
        setup.transitions.push(
          Object.assign({ time: tsAt, from, to, reason }, extra || {}),
        );
        if (verboseTrace)
          console.log(
            fmtTs(tsAt) + " " + from + " -> " + to + "  (" + reason + ")",
          );
      }

      const episodeStartMinute = cursor;
      const candlesBeforeEpisode = candlesAsc.filter(
        (c) => c.t < episodeStartMinute,
      );
      const episodeAtr = simpleAtr20(candlesBeforeEpisode, 20);
      if (episodeAtr === null) {
        setup.state = "CANCELLED";
        setup.cancelReason = "CANCEL_INSUFFICIENT_ATR_HISTORY";
        log(
          episodeStartMinute,
          "NORMAL",
          "CANCELLED",
          "CANCEL_INSUFFICIENT_ATR_HISTORY: fewer than 20 preceding closed candles available",
        );
        setups.push(setup);
        cursor += 60000;
        continue;
      }
      log(
        episodeStartMinute,
        "NORMAL",
        "W1_CANDIDATE",
        "first long-liquidation minute",
      );

      let w1 = buildEpisodeFrom(episodeStartMinute, 24 * 60);
      if (w1.dataGap) {
        setup.state = "CANCELLED";
        setup.cancelReason = "CANCEL_DATA_GAP";
        log(
          w1.lastLiqTime || episodeStartMinute,
          "W1_CANDIDATE",
          "CANCELLED",
          "CANCEL_DATA_GAP: Binance candle missing during W1 episode scan",
        );
        setups.push(setup);
        cursor = episodeStartMinute + 60000;
        continue;
      }
      if (w1.confirmedEndTime === null) {
        cursor = episodeStartMinute + 60000;
        continue;
      }

      const baseline = historicalP90Baseline(w1.startTime);
      const requiredLiqUsd =
        baseline.p90 !== null
          ? P.minPercentile === 95
            ? baseline.p95
            : baseline.p90
          : null;
      const w1DistanceAtr = (w1.anchorPrice - w1.extremePrice) / episodeAtr;
      const liqPassed =
        requiredLiqUsd !== null && w1.totalLiqUsd >= requiredLiqUsd;
      const distancePassed = w1DistanceAtr >= P.minDistanceAtr;

      if (requiredLiqUsd === null) {
        setup.state = "CANCELLED";
        setup.cancelReason = "CANCEL_INSUFFICIENT_BASELINE_HISTORY";
        log(
          w1.confirmedEndTime,
          "W1_CANDIDATE",
          "CANCELLED",
          "CANCEL_INSUFFICIENT_BASELINE_HISTORY: no completed episodes in the trailing 24h to compute a percentile",
          { historicalEpisodeCount: baseline.count },
        );
        setups.push(setup);
        cursor = w1.confirmedEndTime + 60000;
        continue;
      }

      if (!liqPassed || !distancePassed) {
        setup.state = "CANCELLED";
        setup.cancelReason = "CANCEL_W1_TOO_SMALL";
        log(
          w1.confirmedEndTime,
          "W1_CANDIDATE",
          "CANCELLED",
          "CANCEL_W1_TOO_SMALL",
          {
            liqPassed: liqPassed,
            distancePassed: distancePassed,
            totalLiqUsd: w1.totalLiqUsd,
            requiredLiqUsd: requiredLiqUsd,
            distanceAtr: w1DistanceAtr,
            requiredDistanceAtr: P.minDistanceAtr,
            historicalBaseline: baseline,
          },
        );
        setups.push(setup);
        cursor = w1.confirmedEndTime + 60000;
        continue;
      }

      log(
        w1.startTime,
        "W1_CANDIDATE",
        "W1_ACTIVE",
        "liq p" +
          P.minPercentile +
          " passed and distance reached " +
          P.minDistanceAtr +
          " ATR",
        {
          totalLiqUsd: w1.totalLiqUsd,
          requiredLiqUsd: requiredLiqUsd,
          distanceAtr: w1DistanceAtr,
        },
      );
      log(
        w1.confirmedEndTime,
        "W1_ACTIVE",
        "WAITING_FOR_W2",
        "two consecutive zero-liquidation minutes",
        {
          w1ExtremePrice: w1.extremePrice,
          w1ExtremeTime: w1.extremeTime,
          w1TotalLiq: w1.totalLiqUsd,
          w1DistanceAtr: w1DistanceAtr,
          w1ConfirmedEndTime: w1.confirmedEndTime,
        },
      );

      let waitCursor = w1.confirmedEndTime + 60000;
      let highestSinceW1 = w1.extremePrice;
      let bounceConfirmed = false;
      let w2StartCandidate = null;
      const w2WaitDeadline = w1.confirmedEndTime + 15 * 60000;

      while (waitCursor <= Math.min(w2WaitDeadline, endTime)) {
        const c = candleAt(waitCursor);
        if (!c) {
          setup.state = "CANCELLED";
          setup.cancelReason = "CANCEL_DATA_GAP";
          log(
            waitCursor,
            "WAITING_FOR_W2",
            "CANCELLED",
            "CANCEL_DATA_GAP: Binance candle missing while waiting for W2",
          );
          break;
        }
        const liq2 = longLiqUsdAt(waitCursor);
        if (c.high > highestSinceW1) highestSinceW1 = c.high;
        const bounceAtr = (highestSinceW1 - w1.extremePrice) / episodeAtr;
        if (!bounceConfirmed && bounceAtr >= P.minBounceAtr) {
          bounceConfirmed = true;
          log(
            waitCursor,
            "WAITING_FOR_W2",
            "WAITING_FOR_W2",
            "bounce confirmed",
            { bounceAtr: bounceAtr },
          );
        }
        if (liq2.value > 0) {
          if (!bounceConfirmed) {
            const merged = buildEpisodeFrom(w1.startTime, 24 * 60);
            if (merged.dataGap || merged.confirmedEndTime === null) {
              setup.state = "CANCELLED";
              setup.cancelReason = "CANCEL_DATA_GAP";
              log(
                waitCursor,
                "WAITING_FOR_W2",
                "CANCELLED",
                "CANCEL_DATA_GAP during W1_EXTENSION merge rebuild",
              );
              break;
            }
            log(
              waitCursor,
              "WAITING_FOR_W2",
              "W1_ACTIVE",
              "W1_EXTENSION: liquidation restarted before the required bounce -- merged into W1, episode-end/bounce tracking reset",
              {
                previousW1End: w1.confirmedEndTime,
                mergedTotalLiq: merged.totalLiqUsd,
              },
            );
            w1 = merged;
            const remergedDistanceAtr =
              (w1.anchorPrice - w1.extremePrice) / episodeAtr;
            log(
              w1.confirmedEndTime,
              "W1_ACTIVE",
              "WAITING_FOR_W2",
              "two consecutive zero-liquidation minutes (post-merge)",
              {
                w1ExtremePrice: w1.extremePrice,
                w1DistanceAtr: remergedDistanceAtr,
              },
            );
            waitCursor = w1.confirmedEndTime + 60000;
            highestSinceW1 = w1.extremePrice;
            bounceConfirmed = false;
            continue;
          } else {
            w2StartCandidate = waitCursor;
            break;
          }
        }
        waitCursor += 60000;
      }

      if (setup.state === "CANCELLED") {
        setups.push(setup);
        cursor = waitCursor + 60000;
        continue;
      }

      if (w2StartCandidate === null) {
        setup.state = "CANCELLED";
        setup.cancelReason = bounceConfirmed
          ? "CANCEL_NO_W2_TIMEOUT"
          : "CANCEL_NO_BOUNCE";
        log(
          Math.min(w2WaitDeadline, endTime),
          "WAITING_FOR_W2",
          "CANCELLED",
          setup.cancelReason,
          { bounceConfirmed: bounceConfirmed, highestSinceW1: highestSinceW1 },
        );
        setups.push(setup);
        cursor = Math.min(w2WaitDeadline, endTime) + 60000;
        continue;
      }

      log(
        w2StartCandidate,
        "WAITING_FOR_W2",
        "W2_CANDIDATE",
        "new post-bounce liquidation episode",
      );

      const w2 = buildEpisodeFrom(w2StartCandidate, 24 * 60);
      if (w2.dataGap) {
        setup.state = "CANCELLED";
        setup.cancelReason = "CANCEL_DATA_GAP";
        log(
          w2.lastLiqTime || w2StartCandidate,
          "W2_CANDIDATE",
          "CANCELLED",
          "CANCEL_DATA_GAP during W2 episode scan",
        );
        setups.push(setup);
        cursor = w2StartCandidate + 60000;
        continue;
      }
      if (w2.confirmedEndTime === null) {
        cursor = w2StartCandidate + 60000;
        continue;
      }

      const w2Baseline = historicalP90Baseline(w2.startTime);
      const w2RequiredLiqUsd =
        w2Baseline.p90 !== null
          ? P.minPercentile === 95
            ? w2Baseline.p95
            : w2Baseline.p90
          : null;
      const w2DistanceAtr = (w2.anchorPrice - w2.extremePrice) / episodeAtr;
      const distanceToW1ExtremeAtr =
        Math.max(0, w2.extremePrice - w1.extremePrice) / episodeAtr;
      const w2LiqPassed =
        w2RequiredLiqUsd !== null && w2.totalLiqUsd >= w2RequiredLiqUsd;
      const w2DistancePassed = w2DistanceAtr >= P.minDistanceAtr;
      const w2ZonePassed = distanceToW1ExtremeAtr <= 0.1;
      const sweepOrTest =
        w2.extremePrice < w1.extremePrice
          ? "SWEPT"
          : w2ZonePassed
            ? "TESTED"
            : "DID_NOT_REACH";

      if (!w2LiqPassed || !w2DistancePassed || !w2ZonePassed) {
        setup.state = "CANCELLED";
        setup.cancelReason = "CANCEL_W2_INVALID";
        log(
          w2.confirmedEndTime,
          "W2_CANDIDATE",
          "CANCELLED",
          "CANCEL_W2_INVALID",
          {
            liqPassed: w2LiqPassed,
            distancePassed: w2DistancePassed,
            zonePassed: w2ZonePassed,
            totalLiqUsd: w2.totalLiqUsd,
            requiredLiqUsd: w2RequiredLiqUsd,
            distanceAtr: w2DistanceAtr,
            requiredDistanceAtr: P.minDistanceAtr,
            distanceToW1ExtremeAtr: distanceToW1ExtremeAtr,
            sweepOrTest: sweepOrTest,
          },
        );
        setups.push(setup);
        cursor = w2.confirmedEndTime + 60000;
        continue;
      }

      log(
        w2.startTime,
        "W2_CANDIDATE",
        "W2_ACTIVE",
        "p" + P.minPercentile + ", distance, and W1-zone conditions passed",
        {
          totalLiqUsd: w2.totalLiqUsd,
          requiredLiqUsd: w2RequiredLiqUsd,
          distanceAtr: w2DistanceAtr,
          distanceToW1ExtremeAtr: distanceToW1ExtremeAtr,
          sweepOrTest: sweepOrTest,
        },
      );

      const exhaustionDeadline = w2.lastLiqTime + 10 * 60000;
      let entryCursor = w2.confirmedEndTime;
      let entry = null;

      while (
        entryCursor <=
        Math.min(exhaustionDeadline, endTime, w1.startTime + 30 * 60000)
      ) {
        const c = candleAt(entryCursor);
        if (!c) {
          entryCursor += 60000;
          continue;
        }
        let newLowThisMinute = false;
        if (entryCursor > w2.extremeTime && c.low < w2.extremePrice) {
          newLowThisMinute = true;
          w2.extremePrice = c.low;
          w2.extremeTime = entryCursor;
        }
        const recoveryAtr = (c.close - w2.extremePrice) / episodeAtr;
        if (
          !newLowThisMinute &&
          entryCursor > w2.extremeTime &&
          recoveryAtr >= 0.1
        ) {
          entry = {
            time: entryCursor,
            price: c.close,
            recoveryAtr: recoveryAtr,
          };
          break;
        }
        entryCursor += 60000;
      }

      const hardDeadline = w1.startTime + 30 * 60000;
      if (entry) {
        setup.state = "ENTRY_READY";
        const distUsd = entry.price - w2.extremePrice;
        const distAtr = distUsd / episodeAtr;
        const delayMin = (entry.time - w2.extremeTime) / 60000;
        log(
          entry.time,
          "W2_ACTIVE",
          "ENTRY_READY",
          "liquidation ended and price recovered 0.10 ATR",
          {
            w2ExtremePrice: w2.extremePrice,
            w2ExtremeTime: w2.extremeTime,
            entryTime: entry.time,
            entryPrice: entry.price,
            distanceFromExtremeUsd: distUsd,
            distanceFromExtremeAtr: distAtr,
            delayMinutes: delayMin,
          },
        );
        setup.result = {
          w1: w1,
          w2: w2,
          episodeAtr: episodeAtr,
          baseline: baseline,
          w2Baseline: w2Baseline,
          entry: entry,
          distUsd: distUsd,
          distAtr: distAtr,
          delayMin: delayMin,
          sweepOrTest: sweepOrTest,
          bounceHighest: highestSinceW1,
        };
        setups.push(setup);
        cursor = entry.time + 60000;
      } else {
        setup.state = "CANCELLED";
        setup.cancelReason =
          entryCursor >= hardDeadline
            ? "CANCEL_SETUP_TIMEOUT"
            : "CANCEL_W2_NO_EXHAUSTION";
        log(
          Math.min(entryCursor, endTime),
          "W2_ACTIVE",
          "CANCELLED",
          setup.cancelReason,
          { w2ExtremePrice: w2.extremePrice, w2ExtremeTime: w2.extremeTime },
        );
        setups.push(setup);
        cursor = Math.min(entryCursor, endTime) + 60000;
      }
    }
    return setups;
  }

  console.log("\n" + "=".repeat(90));
  console.log("MAIN BACKTEST RUN (p90, 0.30 ATR distance, 0.20 ATR bounce)");
  console.log("=".repeat(90));
  const mainSetups = runDetector(
    { minPercentile: 90, minDistanceAtr: 0.3, minBounceAtr: 0.2 },
    false,
  );

  function summarize(setups) {
    const byReason = {};
    let w1CandidateCount = 0,
      validW1 = 0,
      cancelledW1 = 0,
      bouncedSetups = 0,
      w2CandidateCount = 0,
      validW2 = 0,
      entryReady = 0;
    const distances = [],
      delays = [];
    for (const s of setups) {
      w1CandidateCount++;
      if (s.cancelReason)
        byReason[s.cancelReason] = (byReason[s.cancelReason] || 0) + 1;
      if (
        s.cancelReason === "CANCEL_W1_TOO_SMALL" ||
        s.cancelReason === "CANCEL_DATA_GAP" ||
        s.cancelReason === "CANCEL_INSUFFICIENT_ATR_HISTORY" ||
        s.cancelReason === "CANCEL_INSUFFICIENT_BASELINE_HISTORY"
      ) {
        cancelledW1++;
        continue;
      }
      validW1++;
      if (s.transitions.some((t) => t.reason === "bounce confirmed"))
        bouncedSetups++;
      if (s.transitions.some((t) => t.to === "W2_CANDIDATE"))
        w2CandidateCount++;
      if (s.transitions.some((t) => t.to === "W2_ACTIVE")) validW2++;
      if (s.state === "ENTRY_READY") {
        entryReady++;
        distances.push(s.result.distAtr);
        delays.push(s.result.delayMin);
      }
    }
    return {
      w1CandidateCount: w1CandidateCount,
      validW1: validW1,
      cancelledW1: cancelledW1,
      bouncedSetups: bouncedSetups,
      w2CandidateCount: w2CandidateCount,
      validW2: validW2,
      entryReady: entryReady,
      byReason: byReason,
      avgDistAtr: mean(distances),
      medDistAtr: median(distances),
      avgDelayMin: mean(delays),
      medDelayMin: median(delays),
    };
  }

  const summary = summarize(mainSetups);
  console.log("\n--- SUMMARY (main run) ---");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    "\n*** REMINDER: " +
      assumedZeroMinuteCount +
      " minutes in this window had NO liq_raw_events and were treated as ASSUMED_ZERO_UNVERIFIED -- this cannot be independently confirmed as genuine zero liquidation vs pipeline downtime (no heartbeat/health record exists in this project's database). ***",
  );

  console.log("\n--- ALL ENTRY_READY SETUPS ---");
  mainSetups
    .filter((s) => s.state === "ENTRY_READY")
    .forEach((s) => {
      const r = s.result;
      console.log(
        "W1 start=" +
          fmtTs(r.w1.startTime) +
          " extreme=" +
          r.w1.extremePrice +
          " liq=" +
          r.w1.totalLiqUsd.toFixed(0) +
          " distAtr=" +
          ((r.w1.anchorPrice - r.w1.extremePrice) / r.episodeAtr).toFixed(3) +
          " | bounceHigh=" +
          r.bounceHighest +
          " | W2 start=" +
          fmtTs(r.w2.startTime) +
          " extreme=" +
          r.w2.extremePrice +
          " liq=" +
          r.w2.totalLiqUsd.toFixed(0) +
          " " +
          r.sweepOrTest +
          " | entry=" +
          fmtTs(r.entry.time) +
          "@" +
          r.entry.price +
          " distFromLow=" +
          r.distUsd.toFixed(2) +
          "USD/" +
          r.distAtr.toFixed(3) +
          "ATR delay=" +
          r.delayMin.toFixed(1) +
          "min",
      );
    });

  console.log("\n" + "=".repeat(90));
  console.log("FOCUSED TRACE -- " + focusDate);
  console.log("=".repeat(90));
  const focusDayStart = new Date(focusDate + "T00:00:00Z").getTime();
  const focusDayEnd = focusDayStart + 24 * 60 * 60000;
  const focusSetups = mainSetups.filter(
    (s) =>
      s.transitions.length &&
      s.transitions[0].time >= focusDayStart &&
      s.transitions[0].time < focusDayEnd,
  );
  console.log(
    focusSetups.length + " setup(s) found starting on " + focusDate + ".",
  );
  focusSetups.forEach((s, i) => {
    console.log(
      "\n--- Setup #" +
        (i + 1) +
        " (state=" +
        s.state +
        (s.cancelReason ? ", reason=" + s.cancelReason : "") +
        ") ---",
    );
    s.transitions.forEach((t) =>
      console.log(
        "  " +
          fmtTs(t.time) +
          " " +
          t.from +
          " -> " +
          t.to +
          "  (" +
          t.reason +
          ")" +
          (Object.keys(t).length > 4
            ? "  " +
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(t).filter(
                    ([k]) => ["time", "from", "to", "reason"].indexOf(k) === -1,
                  ),
                ),
              )
            : ""),
      ),
    );
    if (s.state === "ENTRY_READY") {
      const r = s.result;
      const KNOWN_LOW = 76699.1;
      console.log(
        "\n  Known visual low (reference only, not used by the algorithm): " +
          KNOWN_LOW,
      );
      console.log(
        "  Detector's own W2 extreme: " +
          r.w2.extremePrice +
          " @ " +
          fmtTs(r.w2.extremeTime) +
          "  (delta vs known low: " +
          (r.w2.extremePrice - KNOWN_LOW).toFixed(2) +
          " USD)",
      );
      console.log(
        "  Entry: " +
          fmtTs(r.entry.time) +
          " @ " +
          r.entry.price +
          "  (" +
          r.distUsd.toFixed(2) +
          " USD / " +
          r.distAtr.toFixed(3) +
          " ATR above W2 extreme, " +
          r.delayMin.toFixed(1) +
          " min after extreme)",
      );
    }
  });

  let sensitivityResults = null;
  if (runSensitivity) {
    console.log("\n" + "=".repeat(90));
    console.log(
      "SENSITIVITY MATRIX (p90/p95 x distance 0.25/0.30/0.35 x bounce 0.15/0.20/0.25)",
    );
    console.log("=".repeat(90));
    sensitivityResults = [];
    for (const minPercentile of [90, 95]) {
      for (const minDistanceAtr of [0.25, 0.3, 0.35]) {
        for (const minBounceAtr of [0.15, 0.2, 0.25]) {
          const s = runDetector(
            {
              minPercentile: minPercentile,
              minDistanceAtr: minDistanceAtr,
              minBounceAtr: minBounceAtr,
            },
            false,
          );
          const sum = summarize(s);
          sensitivityResults.push(
            Object.assign(
              {
                minPercentile: minPercentile,
                minDistanceAtr: minDistanceAtr,
                minBounceAtr: minBounceAtr,
              },
              sum,
            ),
          );
          console.log(
            "p" +
              minPercentile +
              " dist=" +
              minDistanceAtr +
              " bounce=" +
              minBounceAtr +
              ": validW1=" +
              sum.validW1 +
              " validW2=" +
              sum.validW2 +
              " entries=" +
              sum.entryReady +
              " cancelled=" +
              (sum.cancelledW1 + (sum.validW1 - sum.entryReady)),
          );
        }
      }
    }
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "two-wave-backtest-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        symbol: symbol,
        coverageStart: coverageStart,
        coverageEnd: coverageEnd,
        assumedZeroMinuteCount: assumedZeroMinuteCount,
        dataSourceNote:
          "liq_minute_aggregates is empty and unused; all liquidation sums built directly from liq_raw_events; minutes with no raw events are ASSUMED_ZERO_UNVERIFIED, not proven zero (no independent heartbeat exists in this project's database)",
        summary: summary,
        setups: mainSetups,
        sensitivity: sensitivityResults,
      },
      null,
      2,
    ),
  );
  console.log("\nFull machine-readable output saved to: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
