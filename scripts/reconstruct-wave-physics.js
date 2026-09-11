require("dotenv/config");
const { MongoClient } = require("mongodb");
const https = require("https");
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "research-output");
const ATR_PERIOD = 240;
const symbolArgIdx = process.argv.indexOf("--symbols");
const SYMBOLS = (
  symbolArgIdx !== -1 && process.argv[symbolArgIdx + 1]
    ? process.argv[symbolArgIdx + 1]
    : "ETHUSDT,XRPUSDT"
).split(",");

function fmtTs(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 23) + "Z";
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "n/a";
  var sign = n < 0 ? "-" : "";
  var abs = Math.abs(n);
  if (abs >= 1000000) return sign + "$" + (abs / 1000000).toFixed(2) + "M";
  if (abs >= 1000) return sign + "$" + (abs / 1000).toFixed(1) + "k";
  return sign + "$" + Math.round(abs);
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
            reject(new Error("Bad JSON from " + url));
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
    if (!Array.isArray(raw)) throw new Error("Unexpected klines response");
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
function wilderAtr(candlesAsc, period) {
  if (candlesAsc.length < period + 1) return null;
  var trs = [];
  for (var i = 1; i < candlesAsc.length; i++) {
    var c = candlesAsc[i],
      prev = candlesAsc[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
      ),
    );
  }
  var v = 0;
  for (var j = 0; j < period; j++) v += trs[j];
  v /= period;
  for (var k = period; k < trs.length; k++)
    v = (v * (period - 1) + trs[k]) / period;
  return v;
}
function minuteFloor(ms) {
  return Math.floor(ms / 60000) * 60000;
}

function replayWaves(
  events,
  klinesByMinute,
  unitAbs,
  victim,
  cascadeEndMinuteExclusive,
) {
  if (events.length === 0 || !unitAbs)
    return {
      waves: [],
      noSecondWave: false,
      incomplete: true,
      reason: !unitAbs ? "UNIT unavailable" : "no events",
    };

  var forcedDown = victim === "LONG";
  var waves = [];
  var idx = 0;
  var minuteKeys = Array.from(klinesByMinute.keys()).sort(function (a, b) {
    return a - b;
  });

  function priceAt(ts) {
    var m = minuteFloor(ts);
    return klinesByMinute.get(m) || null;
  }

  var currentWave = null;
  var orderingAmbiguousCount = 0;

  while (idx < events.length) {
    var ev = events[idx];
    if (!currentWave) {
      var anchorCandle = priceAt(ev.timestamp);
      if (!anchorCandle) {
        idx++;
        continue;
      }
      currentWave = {
        waveNumber: waves.length + 1,
        startTime: ev.timestamp,
        anchorPrice: ev.price,
        extremePrice: forcedDown
          ? Math.min(ev.price, anchorCandle.low)
          : Math.max(ev.price, anchorCandle.high),
        extremeTime: ev.timestamp,
        events: [ev],
        completionTime: null,
      };
      idx++;
      continue;
    }

    var nextMinute = minuteFloor(ev.timestamp);
    var sawSameMinuteAmbiguity = false;
    for (var mk = 0; mk < minuteKeys.length; mk++) {
      var mkT = minuteKeys[mk];
      if (mkT < minuteFloor(currentWave.extremeTime)) continue;
      if (mkT > nextMinute) break;
      var kl = klinesByMinute.get(mkT);
      if (!kl) continue;
      var candidateExtreme = forcedDown ? kl.low : kl.high;
      var isNew = forcedDown
        ? candidateExtreme < currentWave.extremePrice
        : candidateExtreme > currentWave.extremePrice;
      if (isNew) {
        currentWave.extremePrice = candidateExtreme;
        currentWave.extremeTime = mkT;
      }
      if (mkT === nextMinute) sawSameMinuteAmbiguity = true;
    }

    var recoveryTarget = forcedDown
      ? currentWave.extremePrice + unitAbs
      : currentWave.extremePrice - unitAbs;
    var recoveredBeforeEvent = false;
    var recoveryTime = null;
    // Sep 10 2026 (Karo), operator-reported CRITICAL FIX -- the SAME
    // candle that just set/extended the wave's own extreme cannot also
    // be used to PROVE recovery: we have no sub-minute ordering, so
    // that candle's own high (for a LONG-victim wave) could have
    // occurred BEFORE its own low within the same 60-second window.
    // Recovery-proof only starts from the NEXT full minute onward --
    // never the extreme-setting minute itself. This mirrors the exact
    // fix already applied to the trailing-wave cancellation scan below.
    var recoveryScanFrom = minuteFloor(currentWave.extremeTime) + 60000;
    for (var mk2 = 0; mk2 < minuteKeys.length; mk2++) {
      var mkT2 = minuteKeys[mk2];
      if (mkT2 < recoveryScanFrom) continue;
      if (mkT2 > nextMinute) break;
      var kl2 = klinesByMinute.get(mkT2);
      if (!kl2) continue;
      var reached = forcedDown
        ? kl2.high >= recoveryTarget
        : kl2.low <= recoveryTarget;
      if (reached) {
        recoveredBeforeEvent = true;
        recoveryTime = mkT2;
        if (mkT2 === nextMinute) orderingAmbiguousCount++;
        break;
      }
    }

    if (recoveredBeforeEvent && !currentWave.completionTime) {
      currentWave.completionTime = recoveryTime;
      currentWave.orderingAmbiguous = recoveryTime === nextMinute;
      waves.push(currentWave);
      currentWave = null;
      continue;
    }

    currentWave.events.push(ev);
    var evCandle = priceAt(ev.timestamp);
    if (evCandle) {
      var evExtreme = forcedDown
        ? Math.min(ev.price, evCandle.low)
        : Math.max(ev.price, evCandle.high);
      var evIsNew = forcedDown
        ? evExtreme < currentWave.extremePrice
        : evExtreme > currentWave.extremePrice;
      if (evIsNew) {
        currentWave.extremePrice = evExtreme;
        currentWave.extremeTime = ev.timestamp;
      }
    }
    if (sawSameMinuteAmbiguity) currentWave.orderingAmbiguousExtension = true;
    idx++;
  }

  var noSecondWave = false;
  if (currentWave) {
    var cancelTarget = forcedDown
      ? currentWave.extremePrice + 2 * unitAbs
      : currentWave.extremePrice - 2 * unitAbs;
    // Scan strictly from the NEXT full minute after the wave's own
    // extreme -- the containing minute itself is excluded, since price
    // action within it may have occurred BEFORE the extreme was set
    // (this exact same-minute ambiguity is why sub-minute ordering
    // can't be resolved -- see the script's own header note).
    var scanFrom = minuteFloor(currentWave.extremeTime) + 60000;
    for (var mk3 = 0; mk3 < minuteKeys.length; mk3++) {
      var mkT3 = minuteKeys[mk3];
      if (mkT3 < scanFrom) continue;
      if (
        cascadeEndMinuteExclusive !== null &&
        mkT3 >= cascadeEndMinuteExclusive + 30 * 60000
      )
        break;
      var kl3 = klinesByMinute.get(mkT3);
      if (!kl3) continue;
      var cancelled = forcedDown
        ? kl3.high >= cancelTarget
        : kl3.low <= cancelTarget;
      if (cancelled) {
        noSecondWave = waves.length === 0;
        currentWave.cancelledAt = mkT3;
        break;
      }
    }
    waves.push(currentWave);
  }

  return {
    waves: waves,
    noSecondWave: waves.length === 1 && !!waves[0].cancelledAt,
    incomplete: false,
    orderingAmbiguousCount: orderingAmbiguousCount,
  };
}

async function main() {
  var uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  var client = new MongoClient(uri);
  await client.connect();
  var db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  var rawCol = db.collection("liq_raw_events");

  var results = {};

  for (var si = 0; si < SYMBOLS.length; si++) {
    var symbol = SYMBOLS[si].trim();
    console.log("\n" + "#".repeat(90));
    console.log("SYMBOL: " + symbol);
    console.log("#".repeat(90));

    var firstDoc = await rawCol
      .find({ symbol: symbol })
      .sort({ timestamp: 1 })
      .limit(1)
      .toArray();
    var lastDoc = await rawCol
      .find({ symbol: symbol })
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray();
    if (firstDoc.length === 0) {
      console.log("No liq_raw_events for " + symbol + " -- skipping.");
      continue;
    }
    var usableStart = firstDoc[0].timestamp;
    var usableEnd = lastDoc[0].timestamp;
    var totalRawEvents = await rawCol.countDocuments({ symbol: symbol });
    console.log(
      "SECTION 1 -- usable raw-event range: " +
        fmtTs(usableStart) +
        " .. " +
        fmtTs(usableEnd) +
        "  (" +
        totalRawEvents +
        " events)",
    );

    var klineFetchStart = usableStart - (ATR_PERIOD + 10) * 60000;
    var klineFetchEnd = usableEnd + 70 * 60000;
    console.log(
      "Fetching klines " +
        fmtTs(klineFetchStart) +
        " .. " +
        fmtTs(klineFetchEnd) +
        " ...",
    );
    var klines = await fetchKlinesRange(symbol, klineFetchStart, klineFetchEnd);
    console.log("Fetched " + klines.size + " candles.");
    var candlesAscAll = Array.from(klines.values()).sort(function (a, b) {
      return a.t - b.t;
    });

    var allEvents = await rawCol
      .find({ symbol: symbol })
      .sort({ timestamp: 1 })
      .toArray();

    results[symbol] = { LONG: null, SHORT: null };

    for (var vi = 0; vi < 2; vi++) {
      var victim = vi === 0 ? "LONG" : "SHORT";
      var victimEvents = allEvents.filter(function (e) {
        return e.victim === victim;
      });

      var byMinuteAmt = new Map();
      victimEvents.forEach(function (e) {
        var m = minuteFloor(e.timestamp);
        byMinuteAmt.set(m, (byMinuteAmt.get(m) || 0) + e.quoteQty);
      });
      var rangeStartM = minuteFloor(usableStart);
      var rangeEndM = minuteFloor(usableEnd);
      var cascadeBounds = [];
      var curStart = null;
      for (var t = rangeStartM; t <= rangeEndM; t += 60000) {
        var amt = byMinuteAmt.get(t) || 0;
        if (amt > 0) {
          if (curStart === null) curStart = t;
        } else {
          if (curStart !== null) {
            cascadeBounds.push({ start: curStart, end: t });
            curStart = null;
          }
        }
      }
      if (curStart !== null) cascadeBounds.push({ start: curStart, end: null });

      console.log(
        "\n" +
          symbol +
          " " +
          victim +
          ": " +
          cascadeBounds.length +
          " cascades (from raw events).",
      );

      var reconstructed = [];
      var excludedIncomplete = 0;

      for (var ci = 0; ci < cascadeBounds.length; ci++) {
        var cb = cascadeBounds[ci];
        var cascadeEvents = victimEvents.filter(function (e) {
          return (
            e.timestamp >= cb.start && (cb.end === null || e.timestamp < cb.end)
          );
        });
        if (cascadeEvents.length === 0) {
          excludedIncomplete++;
          continue;
        }

        var candlesBefore = candlesAscAll.filter(function (cd) {
          return cd.t < cb.start;
        });
        var unitAbs = wilderAtr(candlesBefore, ATR_PERIOD);
        if (!unitAbs) {
          excludedIncomplete++;
          continue;
        }

        var replay = replayWaves(
          cascadeEvents,
          klines,
          unitAbs,
          victim,
          cb.end,
        );
        if (replay.incomplete) {
          excludedIncomplete++;
          continue;
        }

        reconstructed.push({
          symbol: symbol,
          victim: victim,
          cascadeStart: cb.start,
          cascadeEnd: cb.end,
          unitAbs: unitAbs,
          waveCount: replay.waves.length,
          noSecondWave: replay.noSecondWave,
          orderingAmbiguousCount: replay.orderingAmbiguousCount,
          waves: replay.waves.map(function (w) {
            var liqUsd = w.events.reduce(function (s, e) {
              return s + e.quoteQty;
            }, 0);
            var maxEvent = w.events.length
              ? Math.max.apply(
                  null,
                  w.events.map(function (e) {
                    return e.quoteQty;
                  }),
                )
              : 0;
            var dirProgressUsd =
              victim === "LONG"
                ? w.anchorPrice - w.extremePrice
                : w.extremePrice - w.anchorPrice;
            var dirProgressUnits =
              unitAbs > 0 ? dirProgressUsd / unitAbs : null;
            return {
              waveNumber: w.waveNumber,
              startTime: w.startTime,
              completionTime: w.completionTime,
              cancelledAt: w.cancelledAt || null,
              anchorPrice: w.anchorPrice,
              extremePrice: w.extremePrice,
              extremeTime: w.extremeTime,
              liquidationUsd: liqUsd,
              liquidationEventCount: w.events.length,
              maxIndividualLiquidationEvent: maxEvent,
              directionalProgressUsd: dirProgressUsd,
              directionalProgressUnits: dirProgressUnits,
              liquidationUsdPerProgressUnit:
                dirProgressUnits && dirProgressUnits > 0.0001
                  ? liqUsd / dirProgressUnits
                  : null,
              maxEventPerProgressUnit:
                dirProgressUnits && dirProgressUnits > 0.0001
                  ? maxEvent / dirProgressUnits
                  : null,
              orderingAmbiguous: !!w.orderingAmbiguous,
              orderingAmbiguousExtension: !!w.orderingAmbiguousExtension,
              events: w.events.map(function (e) {
                return {
                  timestamp: e.timestamp,
                  price: e.price,
                  quoteQty: e.quoteQty,
                };
              }),
            };
          }),
        });
      }

      var waveCounts = reconstructed.map(function (r) {
        return r.waveCount;
      });
      var w1Only = waveCounts.filter(function (n) {
        return n === 1;
      }).length;
      var w2 = waveCounts.filter(function (n) {
        return n === 2;
      }).length;
      var w3 = waveCounts.filter(function (n) {
        return n === 3;
      }).length;
      var w4plus = waveCounts.filter(function (n) {
        return n >= 4;
      }).length;
      var noSecond = reconstructed.filter(function (r) {
        return r.noSecondWave;
      }).length;

      console.log(
        "  reconstructed=" +
          reconstructed.length +
          "  excluded(no-UNIT/no-events)=" +
          excludedIncomplete,
      );
      console.log(
        "  W1-only=" +
          w1Only +
          "  W2=" +
          w2 +
          "  W3=" +
          w3 +
          "  W4+=" +
          w4plus +
          "  NO_SECOND_WAVE=" +
          noSecond,
      );

      results[symbol][victim] = reconstructed;
    }
  }

  await client.close();

  var outPath = path.join(
    OUTPUT_DIR,
    "wave-physics-analysis-" + Date.now() + ".json",
  );
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(
    "\n\nFull reconstructed wave-physics dataset saved to: " + outPath,
  );
  console.log(
    "NOTE: sub-minute event ordering is NOT available anywhere in this project's",
  );
  console.log(
    "stored history (TradeStore is RAM-only, 5min window, never persisted) --",
  );
  console.log(
    "every wave-boundary decision here is at 1-MINUTE candle granularity, and any",
  );
  console.log(
    "transition where the deciding event/recovery fell in the SAME calendar minute",
  );
  console.log(
    "is flagged orderingAmbiguous=true in the saved dataset rather than silently",
  );
  console.log("guessing which happened first.");
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
