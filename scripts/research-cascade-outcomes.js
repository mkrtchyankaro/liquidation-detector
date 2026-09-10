require("dotenv/config");
const { MongoClient } = require("mongodb");
const https = require("https");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf("--" + name);
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : def;
}
const DAYS = parseInt(getArg("days", "5"), 10);
const SYMBOLS = getArg("symbols", "ETHUSDT,XRPUSDT")
  .split(",")
  .map(function (s) {
    return s.trim();
  });
const ATR_PERIOD = 240;
const OUTCOME_HORIZONS_MIN = [5, 10, 15, 30, 60];
const UNIT_LEVELS = [0.5, 1.0, 1.5, 2.0, 3.0];
const P95_LOOKBACK_MS = 24 * 3600 * 1000;
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

function fmtTs(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "n/a";
  var sign = n < 0 ? "-" : "";
  var abs = Math.abs(n);
  if (abs >= 1000000) return sign + "$" + (abs / 1000000).toFixed(2) + "M";
  if (abs >= 1000) return sign + "$" + (abs / 1000).toFixed(1) + "k";
  return sign + "$" + Math.round(abs);
}
function median(arr) {
  var a = arr.filter(function (x) {
    return x !== null && x !== undefined && !isNaN(x);
  });
  if (a.length === 0) return null;
  var s = a.slice().sort(function (x, y) {
    return x - y;
  });
  var mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function percentileOf(arr, p) {
  var a = arr.filter(function (x) {
    return x !== null && x !== undefined && !isNaN(x);
  });
  if (a.length === 0) return null;
  var s = a.slice().sort(function (x, y) {
    return x - y;
  });
  var idx = (p / 100) * (s.length - 1);
  var lo = Math.floor(idx);
  var hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
function pctOf(n, d) {
  return d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "n/a";
}

function httpsGetJson(url) {
  return new Promise(function (resolve, reject) {
    https
      .get(url, function (res) {
        var data = "";
        res.on("data", function (c) {
          data += c;
        });
        res.on("end", function () {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(
              new Error("Bad JSON from " + url + ": " + data.slice(0, 200)),
            );
          }
        });
      })
      .on("error", reject);
  });
}

async function fetchKlinesRange(symbol, startTime, endTime) {
  var base = process.env.BINANCE_REST_BASE_URL || "https://fapi.binance.com";
  var byOpenTime = new Map();
  var cursor = startTime;
  var CHUNK = 1500;
  while (cursor <= endTime) {
    var chunkEnd = Math.min(cursor + (CHUNK - 1) * 60000, endTime);
    var url =
      base +
      "/fapi/v1/klines?symbol=" +
      symbol +
      "&interval=1m&startTime=" +
      cursor +
      "&endTime=" +
      chunkEnd +
      "&limit=" +
      CHUNK;
    var raw = await httpsGetJson(url);
    if (!Array.isArray(raw))
      throw new Error(
        "Unexpected klines response: " + JSON.stringify(raw).slice(0, 300),
      );
    for (var i = 0; i < raw.length; i++) {
      var k = raw[i];
      byOpenTime.set(k[0], {
        t: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
      });
    }
    if (raw.length === 0) cursor = chunkEnd + 60000;
    else cursor = raw[raw.length - 1][0] + 60000;
    if (cursor <= startTime) break;
  }
  return byOpenTime;
}

// EXACT same algorithm as src/shared/indicators.ts's own atr() -- Wilder
// smoothing, SMA-seeded. candlesAsc must be STRICTLY BEFORE the reference
// time (no lookahead) -- caller's own responsibility.
function wilderAtr(candlesAsc, period) {
  if (candlesAsc.length < period + 1) return null;
  var trs = [];
  for (var i = 1; i < candlesAsc.length; i++) {
    var c = candlesAsc[i];
    var prev = candlesAsc[i - 1];
    var hl = c.high - c.low;
    var hc = Math.abs(c.high - prev.close);
    var lc = Math.abs(c.low - prev.close);
    trs.push(Math.max(hl, hc, lc));
  }
  var v = 0;
  for (var j = 0; j < period; j++) v += trs[j];
  v /= period;
  for (var k = period; k < trs.length; k++)
    v = (v * (period - 1) + trs[k]) / period;
  return v;
}

function reconstructCascades(
  sortedMinuteStarts,
  byMinute,
  sumField,
  countField,
  maxField,
  topField,
) {
  var cascades = [];
  var current = null;
  for (var i = 0; i < sortedMinuteStarts.length; i++) {
    var minuteStart = sortedMinuteStarts[i];
    var doc = byMinute.get(minuteStart);
    var amt = doc ? doc[sumField] : 0;
    if (amt > 0) {
      if (!current) current = { startMinute: minuteStart, minutes: [] };
      current.minutes.push({
        minuteStart: minuteStart,
        amt: amt,
        count: doc ? doc[countField] : 0,
        max: doc ? doc[maxField] : 0,
        top: doc ? doc[topField] || [] : [],
      });
    } else {
      if (current) {
        current.endMinute = minuteStart;
        cascades.push(current);
        current = null;
      }
    }
  }
  if (current) {
    current.endMinute = null;
    cascades.push(current);
  }
  return cascades;
}

// p95AtStart -- topEvents-proxy, see the script header note. Uses ONLY
// topLong/topShort events whose OWN timestamp is < cascadeStart, within
// the lookback window. No lookahead.
function computeP95AtStart(
  allDocsSorted,
  cascadeStart,
  victimTopField,
  lookbackMs,
) {
  var events = [];
  var lowerBound = cascadeStart - lookbackMs;
  for (var i = 0; i < allDocsSorted.length; i++) {
    var d = allDocsSorted[i];
    if (d.minuteStart >= cascadeStart) break; // strictly before
    if (d.minuteStart < lowerBound) continue;
    var top = d[victimTopField] || [];
    for (var j = 0; j < top.length; j++) {
      if (top[j].ts !== undefined && top[j].ts < cascadeStart) {
        events.push(
          top[j].quoteQty !== undefined ? top[j].quoteQty : top[j].notional,
        );
      }
    }
  }
  if (events.length < 5) return { p95: null, sampleCount: events.length };
  return { p95: percentileOf(events, 95), sampleCount: events.length };
}

function getCandle(klines, t) {
  return klines.get(t) || null;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  var uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  var client = new MongoClient(uri);
  await client.connect();
  var db = client.db(process.env.MONGO_SHARED_DB || "liqwatch_bot");
  var col = db.collection("liq_minute_aggregates");

  var allResults = {};

  for (var si = 0; si < SYMBOLS.length; si++) {
    var symbol = SYMBOLS[si];
    console.log("\n" + "#".repeat(90));
    console.log("SYMBOL: " + symbol);
    console.log("#".repeat(90));

    var allDocs = await col
      .find({ symbol: symbol })
      .sort({ minuteStart: 1 })
      .toArray();
    if (allDocs.length === 0) {
      console.log(
        "No liq_minute_aggregates data for " + symbol + " -- skipping.",
      );
      continue;
    }
    var dataEnd = allDocs[allDocs.length - 1].minuteStart;
    var periodEnd = Math.floor(dataEnd / 60000) * 60000;
    var periodStart = periodEnd - DAYS * 24 * 3600 * 1000;

    console.log(
      "Most recent " +
        DAYS +
        " days of available data: " +
        fmtTs(periodStart) +
        " .. " +
        fmtTs(periodEnd),
    );

    var byMinute = new Map(
      allDocs.map(function (d) {
        return [d.minuteStart, d];
      }),
    );

    // Kline fetch window: enough BEFORE periodStart for ATR(240) warmup
    // (240+ 1m candles = 4h+), enough AFTER periodEnd for 60min post-
    // cascade outcome measurement.
    var klineFetchStart = periodStart - (ATR_PERIOD + 10) * 60000;
    var klineFetchEnd = periodEnd + 70 * 60000;
    console.log(
      "Fetching klines " +
        fmtTs(klineFetchStart) +
        " .. " +
        fmtTs(klineFetchEnd) +
        " ...",
    );
    var klines = await fetchKlinesRange(symbol, klineFetchStart, klineFetchEnd);
    console.log("Fetched " + klines.size + " candles.");

    // ATR warmup check.
    var candlesAscAll = Array.from(klines.values()).sort(function (a, b) {
      return a.t - b.t;
    });
    var warmupCandles = candlesAscAll.filter(function (c) {
      return c.t < periodStart;
    });
    if (warmupCandles.length < ATR_PERIOD + 1) {
      console.log(
        "WARNING: only " +
          warmupCandles.length +
          " warmup candles available before the period start (" +
          (ATR_PERIOD + 1) +
          " needed for ATR(" +
          ATR_PERIOD +
          ")). UNIT may be null for early cascades in this period.",
      );
    }

    var sortedMinuteStarts = [];
    for (var t = periodStart; t <= periodEnd; t += 60000)
      sortedMinuteStarts.push(t);

    var symbolResult = {
      symbol: symbol,
      period: { start: periodStart, end: periodEnd },
      LONG: null,
      SHORT: null,
    };

    for (var vi = 0; vi < 2; vi++) {
      var victim = vi === 0 ? "LONG" : "SHORT";
      var sumField = vi === 0 ? "longSum" : "shortSum";
      var countField = vi === 0 ? "longCount" : "shortCount";
      var maxField = vi === 0 ? "longMax" : "shortMax";
      var topField = vi === 0 ? "topLong" : "topShort";
      var forcedDir = vi === 0 ? "DOWN" : "UP"; // LONG-victim liquidation forces price DOWN
      var reversalDir = vi === 0 ? "UP" : "DOWN";

      var cascades = reconstructCascades(
        sortedMinuteStarts,
        byMinute,
        sumField,
        countField,
        maxField,
        topField,
      );
      console.log(
        "\n" +
          symbol +
          " " +
          victim +
          ": " +
          cascades.length +
          " cascades reconstructed.",
      );

      var enriched = [];
      for (var ci = 0; ci < cascades.length; ci++) {
        var c = cascades[ci];
        var totalLiqUsd = 0,
          totalEventCount = 0,
          maxIndividualEvent = 0,
          peakLiqMinute = null,
          peakLiqAmt = -1;
        var liqUsdByMinute = [],
          eventCountByMinute = [],
          maxEventByMinute = [];
        for (var mi = 0; mi < c.minutes.length; mi++) {
          var m = c.minutes[mi];
          totalLiqUsd += m.amt;
          totalEventCount += m.count;
          if (m.max > maxIndividualEvent) maxIndividualEvent = m.max;
          if (m.amt > peakLiqAmt) {
            peakLiqAmt = m.amt;
            peakLiqMinute = m.minuteStart;
          }
          liqUsdByMinute.push(m.amt);
          eventCountByMinute.push(m.count);
          maxEventByMinute.push(m.max);
        }
        var durationMinutes = c.minutes.length;

        // Historical UNIT (Wilder ATR-240) strictly before cascade start.
        var candlesBefore = candlesAscAll.filter(function (cd) {
          return cd.t < c.startMinute;
        });
        var unitAbs = wilderAtr(candlesBefore, ATR_PERIOD);

        // Historical P95 (topEvents-proxy), strictly before cascade start.
        var p95Result = computeP95AtStart(
          allDocs,
          c.startMinute,
          topField,
          P95_LOOKBACK_MS,
        );
        var maxEventToP95Ratio =
          p95Result.p95 && p95Result.p95 > 0
            ? maxIndividualEvent / p95Result.p95
            : null;
        var containsP95Event =
          p95Result.p95 !== null && maxIndividualEvent >= p95Result.p95;

        // Price path during the cascade.
        var startCandle = getCandle(klines, c.startMinute);
        var startPrice = startCandle ? startCandle.open : null;
        var cascadeHigh = null,
          cascadeLow = null,
          endPrice = null;
        for (var pmi = 0; pmi < c.minutes.length; pmi++) {
          var pk = getCandle(klines, c.minutes[pmi].minuteStart);
          if (!pk) continue;
          if (cascadeHigh === null || pk.high > cascadeHigh)
            cascadeHigh = pk.high;
          if (cascadeLow === null || pk.low < cascadeLow) cascadeLow = pk.low;
          endPrice = pk.close;
        }

        var forcedPriceProgressUsd = null,
          forcedPriceProgressUnits = null;
        var recoveryAlreadyInsideCascadeUsd = null,
          recoveryAlreadyInsideCascadeUnits = null;
        if (
          startPrice !== null &&
          cascadeHigh !== null &&
          cascadeLow !== null &&
          endPrice !== null
        ) {
          if (forcedDir === "DOWN") {
            forcedPriceProgressUsd = startPrice - cascadeLow;
            recoveryAlreadyInsideCascadeUsd = endPrice - cascadeLow;
          } else {
            forcedPriceProgressUsd = cascadeHigh - startPrice;
            recoveryAlreadyInsideCascadeUsd = cascadeHigh - endPrice;
          }
          if (unitAbs && unitAbs > 0) {
            forcedPriceProgressUnits = forcedPriceProgressUsd / unitAbs;
            recoveryAlreadyInsideCascadeUnits =
              recoveryAlreadyInsideCascadeUsd / unitAbs;
          }
        }

        var liqUsdPerUnitOfForcedProgress =
          forcedPriceProgressUnits && forcedPriceProgressUnits > 0.0001
            ? totalLiqUsd / forcedPriceProgressUnits
            : null;
        var maxEventPerUnit =
          forcedPriceProgressUnits && forcedPriceProgressUnits > 0.0001
            ? maxIndividualEvent / forcedPriceProgressUnits
            : null;
        var eventCountPerUnit =
          forcedPriceProgressUnits && forcedPriceProgressUnits > 0.0001
            ? totalEventCount / forcedPriceProgressUnits
            : null;

        // ── Post-cascade outcome ──
        var outcome = { horizons: {}, firstHit: {} };
        if (
          c.endMinute !== null &&
          unitAbs &&
          unitAbs > 0 &&
          endPrice !== null
        ) {
          var observeStart = c.endMinute;
          var anchorPrice = endPrice; // last cascade-minute's own close, as the reversal-measurement anchor
          var mfeUnitsSoFar = 0,
            maeUnitsSoFar = 0;
          var hitTimes = {};
          for (var h = 0; h < UNIT_LEVELS.length; h++) {
            hitTimes["+" + UNIT_LEVELS[h] + "U"] = null;
            hitTimes["-" + UNIT_LEVELS[h] + "U"] = null;
          }
          var maxHorizonMin =
            OUTCOME_HORIZONS_MIN[OUTCOME_HORIZONS_MIN.length - 1];
          for (var om = 0; om <= maxHorizonMin; om++) {
            var ot = observeStart + om * 60000;
            var ok = getCandle(klines, ot);
            if (!ok) continue;
            var favHigh, favLow;
            if (reversalDir === "UP") {
              favHigh = ok.high;
              favLow = ok.low;
            } else {
              favHigh = ok.low;
              favLow = ok.high;
            } // for DOWN reversal, "favorable" is price going down, so invert roles
            var favExcursion =
              reversalDir === "UP"
                ? ok.high - anchorPrice
                : anchorPrice - ok.low;
            var advExcursion =
              reversalDir === "UP"
                ? anchorPrice - ok.low
                : ok.high - anchorPrice;
            var favUnits = favExcursion / unitAbs;
            var advUnits = advExcursion / unitAbs;
            if (favUnits > mfeUnitsSoFar) mfeUnitsSoFar = favUnits;
            if (advUnits > maeUnitsSoFar) maeUnitsSoFar = advUnits;

            for (var lvl = 0; lvl < UNIT_LEVELS.length; lvl++) {
              var L = UNIT_LEVELS[lvl];
              var posKey = "+" + L + "U";
              var negKey = "-" + L + "U";
              if (hitTimes[posKey] === null && favUnits >= L)
                hitTimes[posKey] = om;
              if (hitTimes[negKey] === null && advUnits >= L)
                hitTimes[negKey] = om;
            }

            if (OUTCOME_HORIZONS_MIN.indexOf(om) !== -1) {
              outcome.horizons[om + "m"] = {
                mfeUsd: favExcursion >= 0 ? mfeUnitsSoFar * unitAbs : null,
                mfeUnits: mfeUnitsSoFar,
                maeUsd: maeUnitsSoFar * unitAbs,
                maeUnits: maeUnitsSoFar,
              };
            }
          }
          outcome.firstHit = hitTimes;
        } else {
          outcome.incomplete = true;
          outcome.reason =
            c.endMinute === null
              ? "cascade still open at data boundary"
              : !unitAbs
                ? "UNIT unavailable (insufficient ATR warmup)"
                : "price data unavailable";
        }

        enriched.push({
          symbol: symbol,
          victimSide: victim,
          startTime: c.startMinute,
          endTime: c.endMinute,
          durationMinutes: durationMinutes,
          totalLiqUsd: totalLiqUsd,
          liqUsdByMinute: liqUsdByMinute,
          eventCountByMinute: eventCountByMinute,
          maxEventByMinute: maxEventByMinute,
          totalEventCount: totalEventCount,
          maxIndividualEvent: maxIndividualEvent,
          peakLiqMinute: peakLiqMinute,
          p95AtStart: p95Result.p95,
          p95SampleCount: p95Result.sampleCount,
          maxEventToP95Ratio: maxEventToP95Ratio,
          containsP95Event: containsP95Event,
          unitAbs: unitAbs,
          startPrice: startPrice,
          cascadeHigh: cascadeHigh,
          cascadeLow: cascadeLow,
          endPrice: endPrice,
          forcedPriceProgressUsd: forcedPriceProgressUsd,
          forcedPriceProgressUnits: forcedPriceProgressUnits,
          recoveryAlreadyInsideCascadeUsd: recoveryAlreadyInsideCascadeUsd,
          recoveryAlreadyInsideCascadeUnits: recoveryAlreadyInsideCascadeUnits,
          liqUsdPerUnitOfForcedProgress: liqUsdPerUnitOfForcedProgress,
          maxEventPerUnit: maxEventPerUnit,
          eventCountPerUnit: eventCountPerUnit,
          outcome: outcome,
        });
      }

      symbolResult[victim] = enriched;
    }

    allResults[symbol] = symbolResult;

    printSymbolSummary(symbol, symbolResult);
  }

  await client.close();

  var outPath = path.join(
    OUTPUT_DIR,
    "cascade-outcomes-" + Date.now() + ".json",
  );
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log("\nFull machine-readable dataset saved to: " + outPath);
}

function printSymbolSummary(symbol, symbolResult) {
  console.log("\n" + "=".repeat(90));
  console.log(symbol + " -- SUMMARY");
  console.log("=".repeat(90));

  ["LONG", "SHORT"].forEach(function (victim) {
    var cascades = symbolResult[victim] || [];
    var complete = cascades.filter(function (c) {
      return !c.outcome.incomplete;
    });
    console.log(
      "\n" +
        victim +
        ": " +
        cascades.length +
        " cascades reconstructed, " +
        complete.length +
        " with a complete post-cascade outcome.",
    );
    if (complete.length === 0) return;

    var durations = complete.map(function (c) {
      return c.durationMinutes;
    });
    var totals = complete.map(function (c) {
      return c.totalLiqUsd;
    });
    console.log(
      "  duration: median=" +
        median(durations) +
        "m  p75=" +
        (percentileOf(durations, 75) || 0).toFixed(1) +
        "m  p90=" +
        (percentileOf(durations, 90) || 0).toFixed(1) +
        "m",
    );
    console.log(
      "  total liq: median=" +
        fmtUsd(median(totals)) +
        "  p90=" +
        fmtUsd(percentileOf(totals, 90)),
    );

    var withP95 = complete.filter(function (c) {
      return c.containsP95Event;
    });
    var withoutP95 = complete.filter(function (c) {
      return !c.containsP95Event;
    });
    console.log(
      "  P95-containing: " + withP95.length + "  non-P95: " + withoutP95.length,
    );

    function groupStats(group, label) {
      if (group.length === 0) {
        console.log("    " + label + ": n=0");
        return;
      }
      var reach1 = group.filter(function (c) {
        return (
          c.outcome.firstHit &&
          c.outcome.firstHit["+1U"] !== null &&
          (c.outcome.firstHit["-1U"] === null ||
            c.outcome.firstHit["+1U"] <= c.outcome.firstHit["-1U"])
        );
      }).length;
      var reach2 = group.filter(function (c) {
        return (
          c.outcome.firstHit &&
          c.outcome.firstHit["+2U"] !== null &&
          (c.outcome.firstHit["-1U"] === null ||
            c.outcome.firstHit["+2U"] <= c.outcome.firstHit["-1U"])
        );
      }).length;
      var reach3 = group.filter(function (c) {
        return (
          c.outcome.firstHit &&
          c.outcome.firstHit["+3U"] !== null &&
          (c.outcome.firstHit["-1U"] === null ||
            c.outcome.firstHit["+3U"] <= c.outcome.firstHit["-1U"])
        );
      }).length;
      var mfe15 = group.map(function (c) {
        return c.outcome.horizons && c.outcome.horizons["15m"]
          ? c.outcome.horizons["15m"].mfeUnits
          : null;
      });
      var mae15 = group.map(function (c) {
        return c.outcome.horizons && c.outcome.horizons["15m"]
          ? c.outcome.horizons["15m"].maeUnits
          : null;
      });
      var mfe60 = group.map(function (c) {
        return c.outcome.horizons && c.outcome.horizons["60m"]
          ? c.outcome.horizons["60m"].mfeUnits
          : null;
      });
      var mae60 = group.map(function (c) {
        return c.outcome.horizons && c.outcome.horizons["60m"]
          ? c.outcome.horizons["60m"].maeUnits
          : null;
      });
      console.log(
        "    " +
          label +
          ": n=" +
          group.length +
          "  +1U-before-1U=" +
          pctOf(reach1, group.length) +
          "  +2U-before-1U=" +
          pctOf(reach2, group.length) +
          "  +3U-before-1U=" +
          pctOf(reach3, group.length) +
          "  medMFE15m=" +
          (median(mfe15) || 0).toFixed(2) +
          "U medMAE15m=" +
          (median(mae15) || 0).toFixed(2) +
          "U" +
          "  medMFE60m=" +
          (median(mfe60) || 0).toFixed(2) +
          "U medMAE60m=" +
          (median(mae60) || 0).toFixed(2) +
          "U",
      );
    }

    groupStats(withP95, "P95-containing");
    groupStats(withoutP95, "non-P95");

    var sortedByTotal = complete.slice().sort(function (a, b) {
      return a.totalLiqUsd - b.totalLiqUsd;
    });
    var n = sortedByTotal.length;
    var buckets = [
      ["0-50pct", sortedByTotal.slice(0, Math.floor(n * 0.5))],
      [
        "50-75pct",
        sortedByTotal.slice(Math.floor(n * 0.5), Math.floor(n * 0.75)),
      ],
      [
        "75-90pct",
        sortedByTotal.slice(Math.floor(n * 0.75), Math.floor(n * 0.9)),
      ],
      [
        "90-95pct",
        sortedByTotal.slice(Math.floor(n * 0.9), Math.floor(n * 0.95)),
      ],
      [
        "95-99pct",
        sortedByTotal.slice(Math.floor(n * 0.95), Math.floor(n * 0.99)),
      ],
      ["99+pct", sortedByTotal.slice(Math.floor(n * 0.99))],
    ];
    console.log("  By cascade-size percentile:");
    buckets.forEach(function (b) {
      groupStats(b[1], "    " + b[0]);
    });
  });
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
