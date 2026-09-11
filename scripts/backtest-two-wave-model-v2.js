require("dotenv/config");
const { MongoClient } = require("mongodb");
const https = require("https");
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

function fmtTs(ms) {
  return ms
    ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z"
    : "n/a";
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
    "TWO-WAVE LIQUIDATION-REVERSAL BACKTEST v2 -- " + symbol + " LONG-reversal",
  );
  console.log("=".repeat(90));
  console.log(
    "DATA SOURCE: liq_raw_events ONLY (liq_minute_aggregates verified EMPTY, unused).",
  );

  const sampleLongDoc = await rawCol.findOne({ symbol, victim: "LONG" });
  console.log("\nDirection-mapping proof:");
  console.log(
    '  raw Binance forceOrder.side: SELL -> stored victim: "LONG"  |  BUY -> stored victim: "SHORT"',
  );
  console.log(
    "  sample document: " +
      (sampleLongDoc
        ? JSON.stringify({
            symbol: sampleLongDoc.symbol,
            victim: sampleLongDoc.victim,
            price: sampleLongDoc.price,
            quoteQty: sampleLongDoc.quoteQty,
            timestampIso: fmtTs(sampleLongDoc.timestamp),
          })
        : "none found"),
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
    "\nliq_raw_events coverage: " +
      fmtTs(coverageStart) +
      " .. " +
      fmtTs(coverageEnd) +
      "  (" +
      ((coverageEnd - coverageStart) / 3600000).toFixed(1) +
      " hours)",
  );

  const startTime = minuteFloor(coverageStart) + 60000;
  const endTime = minuteFloor(coverageEnd);
  const dataFetchStart = startTime - 25 * 60 * 60000;
  const totalMinutesInWindow = Math.floor((endTime - startTime) / 60000) + 1;

  console.log(
    "\nFetching candles (Binance REST klines, last-trade-price basis)...",
  );
  const klines = await fetchKlinesRange(symbol, dataFetchStart, endTime);
  const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
  console.log("  " + candlesAsc.length + " candles fetched.");

  console.log(
    "Fetching liq_raw_events and building minute buckets directly...",
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
  for (const e of rawEvents) {
    const m = minuteFloor(e.timestamp);
    longSumByMinute.set(m, (longSumByMinute.get(m) || 0) + e.quoteQty);
  }
  console.log(
    "  " +
      rawEvents.length +
      " raw LONG-liquidation events -> " +
      longSumByMinute.size +
      " distinct minutes with recorded liquidation.",
  );

  const recordedMinutes = longSumByMinute.size;
  const assumedZeroMinutes = totalMinutesInWindow - recordedMinutes;
  console.log(
    "\nEvaluated window: " +
      fmtTs(startTime) +
      " .. " +
      fmtTs(endTime) +
      "  (" +
      totalMinutesInWindow +
      " total minutes)",
  );
  console.log("  minutes with RECORDED liquidation: " + recordedMinutes);
  console.log("  minutes ASSUMED_ZERO_UNVERIFIED: " + assumedZeroMinutes);
  console.log(
    "  (these two counters always sum to the total minute count above -- fixed once per run, never accumulated)",
  );

  function longLiqUsdAt(minuteStart) {
    if (longSumByMinute.has(minuteStart))
      return { value: longSumByMinute.get(minuteStart), status: "RECORDED" };
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
            anchorPrice: anchorPrice,
            extremePrice: extremePrice,
            extremeTime: extremeTime,
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
      anchorPrice: anchorPrice,
      extremePrice: extremePrice,
      extremeTime: extremeTime,
      dataGap: sawDataGap,
    };
  }

  console.log("\nBuilding the full historical episode list...");
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
    "  " + allEpisodes.length + " completed long-liquidation episodes built.",
  );

  const MIN_WARMUP_EPISODES = 5;
  function historicalBaseline(beforeTime) {
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
      p60: percentile(
        relevant.map((e) => e.totalLiqUsd),
        60,
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
  function pctValue(baseline, p) {
    if (baseline.count < MIN_WARMUP_EPISODES) return null;
    if (p === 50) return baseline.p50;
    if (p === 60) return baseline.p60;
    if (p === 75) return baseline.p75;
    if (p === 90) return baseline.p90;
    if (p === 95) return baseline.p95;
    return null;
  }

  function runDetector(params, verboseTrace) {
    const P = Object.assign(
      {
        w1Percentile: 75,
        w1MinDistanceAtr: 0.5,
        w2Percentile: 90,
        w2MinDistanceAtr: 0.3,
        minBounceAtr: 0.2,
        minRecoveryAtr: 0.1,
        maxRecoveryAtr: 0.5,
      },
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
        symbol: symbol,
        transitions: [],
        state: "NORMAL",
        cancelReason: null,
      };
      function log(tsAt, from, to, reason, extra) {
        setup.transitions.push(
          Object.assign(
            { time: tsAt, from: from, to: to, reason: reason },
            extra || {},
          ),
        );
        if (verboseTrace)
          console.log(
            fmtTs(tsAt) +
              " " +
              from +
              " -> " +
              to +
              "  (" +
              reason +
              ")" +
              (extra ? "  " + JSON.stringify(extra) : ""),
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
          "CANCEL_INSUFFICIENT_ATR_HISTORY",
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
          "CANCEL_DATA_GAP during W1 scan",
        );
        setups.push(setup);
        cursor = episodeStartMinute + 60000;
        continue;
      }
      if (w1.confirmedEndTime === null) {
        cursor = episodeStartMinute + 60000;
        continue;
      }

      const baseline = historicalBaseline(w1.startTime);
      const w1RequiredLiqUsd = pctValue(baseline, P.w1Percentile);
      const w1DistanceAtr = (w1.anchorPrice - w1.extremePrice) / episodeAtr;
      const w1LiqPassed =
        w1RequiredLiqUsd !== null && w1.totalLiqUsd >= w1RequiredLiqUsd;
      const w1DistancePassed = w1DistanceAtr >= P.w1MinDistanceAtr;

      if (w1RequiredLiqUsd === null) {
        setup.state = "CANCELLED";
        setup.cancelReason = "SKIP_INSUFFICIENT_LIQ_HISTORY";
        log(
          w1.confirmedEndTime,
          "W1_CANDIDATE",
          "CANCELLED",
          "SKIP_INSUFFICIENT_LIQ_HISTORY",
          {
            historicalEpisodeCount: baseline.count,
            requiredWarmupEpisodes: MIN_WARMUP_EPISODES,
          },
        );
        setups.push(setup);
        cursor = w1.confirmedEndTime + 60000;
        continue;
      }
      if (!w1LiqPassed || !w1DistancePassed) {
        setup.state = "CANCELLED";
        setup.cancelReason = "CANCEL_W1_TOO_SMALL";
        log(
          w1.confirmedEndTime,
          "W1_CANDIDATE",
          "CANCELLED",
          "CANCEL_W1_TOO_SMALL",
          {
            liqPassed: w1LiqPassed,
            distancePassed: w1DistancePassed,
            totalLiqUsd: w1.totalLiqUsd,
            requiredLiqUsd: w1RequiredLiqUsd,
            distanceAtr: w1DistanceAtr,
            requiredDistanceAtr: P.w1MinDistanceAtr,
            w1Percentile: P.w1Percentile,
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
        "p" +
          P.w1Percentile +
          " passed and distance reached " +
          P.w1MinDistanceAtr +
          " ATR (zone-discovery wave)",
        {
          totalLiqUsd: w1.totalLiqUsd,
          requiredLiqUsd: w1RequiredLiqUsd,
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
        },
      );

      const w2Baseline0 = historicalBaseline(w1.confirmedEndTime);
      const w2RequiredLiqUsd0 = pctValue(w2Baseline0, P.w2Percentile);

      let waitCursor = w1.confirmedEndTime + 60000;
      let highestSinceW1 = w1.extremePrice;
      let bounceConfirmed = false;
      const w2WaitDeadline = w1.confirmedEndTime + 15 * 60000;
      let w2 = null;

      while (waitCursor <= Math.min(w2WaitDeadline, endTime)) {
        const c = candleAt(waitCursor);
        if (!c) {
          setup.state = "CANCELLED";
          setup.cancelReason = "CANCEL_DATA_GAP";
          log(
            waitCursor,
            "WAITING_FOR_W2",
            "CANCELLED",
            "CANCEL_DATA_GAP while waiting for W2",
          );
          break;
        }
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
        const liq2 = longLiqUsdAt(waitCursor);
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
                "CANCEL_DATA_GAP during W1_EXTENSION merge",
              );
              break;
            }
            log(
              waitCursor,
              "WAITING_FOR_W2",
              "W1_ACTIVE",
              "W1_EXTENSION: liquidation restarted before required bounce -- merged into W1",
              {
                previousW1End: w1.confirmedEndTime,
                mergedTotalLiq: merged.totalLiqUsd,
              },
            );
            w1 = merged;
            log(
              w1.confirmedEndTime,
              "W1_ACTIVE",
              "WAITING_FOR_W2",
              "two consecutive zero-liquidation minutes (post-merge)",
              { w1ExtremePrice: w1.extremePrice },
            );
            waitCursor = w1.confirmedEndTime + 60000;
            highestSinceW1 = w1.extremePrice;
            bounceConfirmed = false;
            continue;
          }

          const candidateStart = waitCursor;
          let watchCursor = candidateStart;
          let watchLiqSum = 0;
          let watchZeroStreak = 0;
          let watchLastLiqTime = null;
          let watchExtreme = null;
          let reachedZone = false;
          let promoted = false;
          let watchDataGap = false;

          while (true) {
            const wc = candleAt(watchCursor);
            if (!wc) {
              watchDataGap = true;
              break;
            }
            if (watchExtreme === null || wc.low < watchExtreme) {
              watchExtreme = wc.low;
            }
            const distToW1ZoneAtr =
              Math.max(0, watchExtreme - w1.extremePrice) / episodeAtr;
            if (distToW1ZoneAtr <= 0.1) reachedZone = true;

            const wliq = longLiqUsdAt(watchCursor);
            if (wliq.value > 0) {
              watchLiqSum += wliq.value;
              watchLastLiqTime = watchCursor;
              watchZeroStreak = 0;
            } else {
              watchZeroStreak++;
            }

            if (
              !promoted &&
              ((w2RequiredLiqUsd0 !== null &&
                watchLiqSum >= w2RequiredLiqUsd0) ||
                reachedZone)
            ) {
              promoted = true;
              break;
            }
            if (watchZeroStreak >= 2 && watchLastLiqTime !== null) break;
            watchCursor += 60000;
            if (
              watchCursor >
              Math.min(w2WaitDeadline, endTime) + 24 * 60 * 60000
            ) {
              watchDataGap = true;
              break;
            }
          }

          if (watchDataGap) {
            setup.state = "CANCELLED";
            setup.cancelReason = "CANCEL_DATA_GAP";
            log(
              watchCursor,
              "WAITING_FOR_W2",
              "CANCELLED",
              "CANCEL_DATA_GAP while watching a post-bounce candidate episode",
            );
            break;
          }

          if (!promoted) {
            const reason = reachedZone
              ? "W2_ZONE_TEST_TOO_SMALL"
              : "IGNORE_W2_NOISE";
            log(watchCursor, "WAITING_FOR_W2", "WAITING_FOR_W2", reason, {
              candidateStart: candidateStart,
              watchLiqSum: watchLiqSum,
              reachedZone: reachedZone,
              w2RequiredLiqUsd: w2RequiredLiqUsd0,
            });
            waitCursor = watchCursor + 60000;
            continue;
          }

          log(
            candidateStart,
            "WAITING_FOR_W2",
            "W2_CANDIDATE",
            "post-bounce episode reached the W2 liquidation threshold or the W1 zone",
            {
              watchLiqSumAtPromotion: watchLiqSum,
              reachedZoneAtPromotion: reachedZone,
            },
          );
          w2 = buildEpisodeFrom(candidateStart, 24 * 60);
          if (w2.dataGap) {
            setup.state = "CANCELLED";
            setup.cancelReason = "CANCEL_DATA_GAP";
            log(
              w2.lastLiqTime || candidateStart,
              "W2_CANDIDATE",
              "CANCELLED",
              "CANCEL_DATA_GAP during W2 full-episode build",
            );
          }
          break;
        }
        waitCursor += 60000;
      }

      if (setup.state === "CANCELLED") {
        setups.push(setup);
        cursor = waitCursor + 60000;
        continue;
      }

      if (w2 === null) {
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
      if (w2.confirmedEndTime === null) {
        cursor = waitCursor + 60000;
        continue;
      }

      const w2Baseline = historicalBaseline(w2.startTime);
      const w2RequiredLiqUsd = pctValue(w2Baseline, P.w2Percentile);
      const w2DistanceAtr = (w2.anchorPrice - w2.extremePrice) / episodeAtr;
      const distanceToW1ExtremeAtr =
        Math.max(0, w2.extremePrice - w1.extremePrice) / episodeAtr;
      const w2LiqPassed =
        w2RequiredLiqUsd !== null && w2.totalLiqUsd >= w2RequiredLiqUsd;
      const w2DistancePassed = w2DistanceAtr >= P.w2MinDistanceAtr;
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
        "p" + P.w2Percentile + ", distance, and W1-zone conditions passed",
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
      let tooLate = false;

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
          recoveryAtr >= P.minRecoveryAtr
        ) {
          if (recoveryAtr <= P.maxRecoveryAtr) {
            entry = {
              time: entryCursor,
              price: c.close,
              recoveryAtr: recoveryAtr,
            };
          } else {
            tooLate = true;
          }
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
          "liquidation ended and price recovered within [" +
            P.minRecoveryAtr +
            "," +
            P.maxRecoveryAtr +
            "] ATR",
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
        setup.cancelReason = tooLate
          ? "CANCEL_ENTRY_TOO_LATE"
          : entryCursor >= hardDeadline
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
  console.log(
    "MAIN BACKTEST RUN (W1: p75 + 0.50 ATR | W2: p90 + 0.30 ATR + zone | bounce 0.20 ATR | recovery [0.10, 0.50] ATR)",
  );
  console.log("=".repeat(90));
  const mainSetups = runDetector(
    {
      w1Percentile: 75,
      w1MinDistanceAtr: 0.5,
      w2Percentile: 90,
      w2MinDistanceAtr: 0.3,
      minBounceAtr: 0.2,
      minRecoveryAtr: 0.1,
      maxRecoveryAtr: 0.5,
    },
    false,
  );

  function summarize(setups) {
    const byReason = {};
    let validW1 = 0,
      cancelledW1 = 0,
      bouncedSetups = 0,
      w2CandidateCount = 0,
      validW2 = 0,
      entryReady = 0,
      ignoreNoiseCount = 0,
      zoneTestTooSmallCount = 0;
    const distances = [],
      delays = [];
    for (const s of setups) {
      if (s.cancelReason)
        byReason[s.cancelReason] = (byReason[s.cancelReason] || 0) + 1;
      ignoreNoiseCount += s.transitions.filter(
        (t) => t.reason === "IGNORE_W2_NOISE",
      ).length;
      zoneTestTooSmallCount += s.transitions.filter(
        (t) => t.reason === "W2_ZONE_TEST_TOO_SMALL",
      ).length;
      if (
        s.cancelReason === "CANCEL_W1_TOO_SMALL" ||
        s.cancelReason === "CANCEL_DATA_GAP" ||
        s.cancelReason === "CANCEL_INSUFFICIENT_ATR_HISTORY" ||
        s.cancelReason === "SKIP_INSUFFICIENT_LIQ_HISTORY"
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
      validW1: validW1,
      cancelledW1: cancelledW1,
      bouncedSetups: bouncedSetups,
      w2CandidateCount: w2CandidateCount,
      validW2: validW2,
      entryReady: entryReady,
      ignoreNoiseCount: ignoreNoiseCount,
      zoneTestTooSmallCount: zoneTestTooSmallCount,
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
  console.log("FOCUSED TRACE -- " + focusDate + " 10:00 UTC through 11:30 UTC");
  console.log("=".repeat(90));
  const traceStart = new Date(focusDate + "T10:00:00Z").getTime();
  const traceEnd = new Date(focusDate + "T11:30:00Z").getTime();
  console.log("\nPer-minute liquidation activity in this window:");
  for (let t = traceStart; t <= traceEnd; t += 60000) {
    const liq = longLiqUsdAt(t);
    if (liq.value > 0) {
      const c = candleAt(t);
      console.log(
        "  " +
          fmtTs(t) +
          "  liqUsd=" +
          liq.value.toFixed(2) +
          "  " +
          (c
            ? "O=" + c.open + " H=" + c.high + " L=" + c.low + " C=" + c.close
            : "(no candle)"),
      );
    }
  }

  const focusDayStart = new Date(focusDate + "T00:00:00Z").getTime();
  const focusDayEnd = focusDayStart + 24 * 60 * 60000;
  const focusSetups = mainSetups.filter(
    (s) =>
      s.transitions.length &&
      s.transitions[0].time >= focusDayStart &&
      s.transitions[0].time < focusDayEnd,
  );
  console.log(
    "\n" +
      focusSetups.length +
      " setup(s) found starting on " +
      focusDate +
      ".",
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

  console.log(
    "\n--- Price-mismatch investigation (76,699.1 vs prior-run 76,721.9) ---",
  );
  const KNOWN_LOW = 76699.1;
  const PRIOR_RUN_LOW = 76721.9;
  let closestToKnown = null,
    closestToPrior = null;
  candlesAsc
    .filter((c) => c.t >= traceStart && c.t <= traceEnd)
    .forEach((c) => {
      if (
        closestToKnown === null ||
        Math.abs(c.low - KNOWN_LOW) < Math.abs(closestToKnown.low - KNOWN_LOW)
      )
        closestToKnown = c;
      if (
        closestToPrior === null ||
        Math.abs(c.low - PRIOR_RUN_LOW) <
          Math.abs(closestToPrior.low - PRIOR_RUN_LOW)
      )
        closestToPrior = c;
    });
  console.log(
    "  Candle with low CLOSEST to " +
      KNOWN_LOW +
      ": " +
      (closestToKnown
        ? fmtTs(closestToKnown.t) +
          " low=" +
          closestToKnown.low +
          " (delta=" +
          (closestToKnown.low - KNOWN_LOW).toFixed(2) +
          ")"
        : "none in window"),
  );
  console.log(
    "  Candle with low CLOSEST to " +
      PRIOR_RUN_LOW +
      ": " +
      (closestToPrior
        ? fmtTs(closestToPrior.t) +
          " low=" +
          closestToPrior.low +
          " (delta=" +
          (closestToPrior.low - PRIOR_RUN_LOW).toFixed(2) +
          ")"
        : "none in window"),
  );
  console.log(
    "  Contract symbol used: " +
      symbol +
      "  |  Kline source: Binance Futures REST /fapi/v1/klines (last-trade-price, verified same basis as live @kline_1m WS stream)",
  );
  console.log(
    "  Raw liquidation events within +/-5 min of the closest-to-known-low candle:",
  );
  if (closestToKnown) {
    const nearby = rawEvents.filter(
      (e) => Math.abs(e.timestamp - closestToKnown.t) <= 5 * 60000,
    );
    nearby.forEach((e) =>
      console.log(
        "    " +
          fmtTs(e.timestamp) +
          " price=" +
          e.price +
          " quoteQty=" +
          e.quoteQty.toFixed(2),
      ),
    );
    if (nearby.length === 0) console.log("    (none)");
  }

  let sensitivityResults = null;
  if (runSensitivity) {
    console.log("\n" + "=".repeat(90));
    console.log(
      "SENSITIVITY MATRIX (W1 percentile p50/p60/p75 x W1 displacement 0.50/0.75/1.00 ATR x max entry recovery 0.30/0.50/0.75 ATR; W2 fixed at trailing p90)",
    );
    console.log("=".repeat(90));
    sensitivityResults = [];
    for (const w1Percentile of [50, 60, 75]) {
      for (const w1MinDistanceAtr of [0.5, 0.75, 1.0]) {
        for (const maxRecoveryAtr of [0.3, 0.5, 0.75]) {
          const s = runDetector(
            {
              w1Percentile: w1Percentile,
              w1MinDistanceAtr: w1MinDistanceAtr,
              w2Percentile: 90,
              w2MinDistanceAtr: 0.3,
              minBounceAtr: 0.2,
              minRecoveryAtr: 0.1,
              maxRecoveryAtr: maxRecoveryAtr,
            },
            false,
          );
          const sum = summarize(s);
          sensitivityResults.push(
            Object.assign(
              {
                w1Percentile: w1Percentile,
                w1MinDistanceAtr: w1MinDistanceAtr,
                maxRecoveryAtr: maxRecoveryAtr,
              },
              sum,
            ),
          );
          console.log(
            "W1p" +
              w1Percentile +
              " dist=" +
              w1MinDistanceAtr +
              " maxRec=" +
              maxRecoveryAtr +
              ": validW1=" +
              sum.validW1 +
              " validW2=" +
              sum.validW2 +
              " entries=" +
              sum.entryReady +
              " ignoreNoise=" +
              sum.ignoreNoiseCount +
              " zoneTestTooSmall=" +
              sum.zoneTestTooSmallCount,
          );
        }
      }
    }
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "two-wave-backtest-v2-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        symbol: symbol,
        coverageStart: coverageStart,
        coverageEnd: coverageEnd,
        evaluatedWindow: {
          startTime: startTime,
          endTime: endTime,
          totalMinutesInWindow: totalMinutesInWindow,
        },
        recordedMinutes: recordedMinutes,
        assumedZeroMinutes: assumedZeroMinutes,
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
