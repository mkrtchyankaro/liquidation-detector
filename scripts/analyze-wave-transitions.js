require("dotenv/config");
const https = require("https");
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "research-output");
const UNIT_LEVELS = [0.5, 1.0, 2.0, 3.0];
const HORIZONS = [5, 10, 15, 30, 60];

var srcArgIdx = process.argv.indexOf("--src");
var SRC_PATH =
  srcArgIdx !== -1 && process.argv[srcArgIdx + 1]
    ? process.argv[srcArgIdx + 1]
    : null;

function fmtTs(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
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
function pctOf(n, d) {
  return d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "n/a";
}
function findLatestJson(prefix) {
  if (!fs.existsSync(OUTPUT_DIR)) return null;
  var files = fs.readdirSync(OUTPUT_DIR).filter(function (f) {
    return f.indexOf(prefix) === 0 && f.slice(-5) === ".json";
  });
  if (files.length === 0) return null;
  files.sort();
  return path.join(OUTPUT_DIR, files[files.length - 1]);
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
            reject(new Error("Bad JSON"));
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
function minuteFloor(ms) {
  return Math.floor(ms / 60000) * 60000;
}

function computeOutcome(
  klines,
  observeStartMinute,
  anchorPrice,
  victim,
  unitAbs,
) {
  var reversalDir = victim === "LONG" ? "UP" : "DOWN";
  var hitTimes = {};
  UNIT_LEVELS.forEach(function (L) {
    hitTimes["+" + L + "U"] = null;
    hitTimes["-" + L + "U"] = null;
  });
  var mfeSoFar = 0,
    maeSoFar = 0;
  var horizonSnapshots = {};
  var maxH = HORIZONS[HORIZONS.length - 1];
  for (var om = 0; om <= maxH; om++) {
    var ot = observeStartMinute + om * 60000;
    var ok = klines.get(ot);
    if (!ok) continue;
    var favExcursion =
      reversalDir === "UP" ? ok.high - anchorPrice : anchorPrice - ok.low;
    var advExcursion =
      reversalDir === "UP" ? anchorPrice - ok.low : ok.high - anchorPrice;
    var favUnits = favExcursion / unitAbs;
    var advUnits = advExcursion / unitAbs;
    if (favUnits > mfeSoFar) mfeSoFar = favUnits;
    if (advUnits > maeSoFar) maeSoFar = advUnits;
    UNIT_LEVELS.forEach(function (L) {
      var pk = "+" + L + "U",
        nk = "-" + L + "U";
      if (hitTimes[pk] === null && favUnits >= L) hitTimes[pk] = om;
      if (hitTimes[nk] === null && advUnits >= L) hitTimes[nk] = om;
    });
    if (HORIZONS.indexOf(om) !== -1)
      horizonSnapshots[om + "m"] = { mfeUnits: mfeSoFar, maeUnits: maeSoFar };
  }
  return { firstHit: hitTimes, horizons: horizonSnapshots };
}
function labelsFromOutcome(o) {
  if (!o) return null;
  var fh = o.firstHit;
  var t1p = fh["+1U"],
    t1n = fh["-1U"],
    t2p = fh["+2U"],
    t3p = fh["+3U"];
  return {
    r1: t1p !== null && (t1n === null || t1p <= t1n),
    r2: t2p !== null && (t1n === null || t2p <= t1n),
    r3: t3p !== null && (t1n === null || t3p <= t1n),
    mfe15: o.horizons["15m"] ? o.horizons["15m"].mfeUnits : null,
    mae15: o.horizons["15m"] ? o.horizons["15m"].maeUnits : null,
    mfe60: o.horizons["60m"] ? o.horizons["60m"].mfeUnits : null,
    mae60: o.horizons["60m"] ? o.horizons["60m"].maeUnits : null,
  };
}
function printGroupOutcome(label, items) {
  if (items.length === 0) {
    console.log("  " + label.padEnd(40) + " n=0");
    return;
  }
  var lab = items
    .map(function (i) {
      return i.labels;
    })
    .filter(function (l) {
      return l !== null;
    });
  var r1 = lab.filter(function (l) {
    return l.r1;
  }).length;
  var r2 = lab.filter(function (l) {
    return l.r2;
  }).length;
  var r3 = lab.filter(function (l) {
    return l.r3;
  }).length;
  console.log(
    "  " +
      label.padEnd(40) +
      " n=" +
      String(items.length).padEnd(5) +
      " +1U=" +
      pctOf(r1, lab.length).padEnd(7) +
      " +2U=" +
      pctOf(r2, lab.length).padEnd(7) +
      " +3U=" +
      pctOf(r3, lab.length).padEnd(7) +
      " medMFE15=" +
      (
        median(
          lab.map(function (l) {
            return l.mfe15;
          }),
        ) || 0
      ).toFixed(2) +
      "U" +
      " medMAE15=" +
      (
        median(
          lab.map(function (l) {
            return l.mae15;
          }),
        ) || 0
      ).toFixed(2) +
      "U" +
      " medMFE60=" +
      (
        median(
          lab.map(function (l) {
            return l.mfe60;
          }),
        ) || 0
      ).toFixed(2) +
      "U" +
      " medMAE60=" +
      (
        median(
          lab.map(function (l) {
            return l.mae60;
          }),
        ) || 0
      ).toFixed(2) +
      "U",
  );
}

async function main() {
  var srcPath = SRC_PATH || findLatestJson("wave-physics-analysis-");
  if (!srcPath) {
    console.error("No wave-physics-analysis-*.json found.");
    process.exit(1);
  }
  console.log("Loading dataset: " + srcPath);
  var raw = JSON.parse(fs.readFileSync(srcPath, "utf8"));

  var symbols = Object.keys(raw);
  var allTransitions = [];
  var perGroup = {};

  for (var si = 0; si < symbols.length; si++) {
    var symbol = symbols[si];

    var allCascadesForSymbol = (raw[symbol].LONG || []).concat(
      raw[symbol].SHORT || [],
    );
    if (allCascadesForSymbol.length === 0) continue;
    var minT = Math.min.apply(
      null,
      allCascadesForSymbol.map(function (c) {
        return c.cascadeStart;
      }),
    );
    var maxT = Math.max.apply(
      null,
      allCascadesForSymbol.map(function (c) {
        return c.cascadeEnd || c.cascadeStart;
      }),
    );
    console.log(
      "\n" +
        symbol +
        ": fetching outcome-klines " +
        fmtTs(minT) +
        " .. " +
        fmtTs(maxT + 65 * 60000) +
        " ...",
    );
    var klines = await fetchKlinesRange(symbol, minT, maxT + 65 * 60000);
    console.log("Fetched " + klines.size + " candles.");

    ["LONG", "SHORT"].forEach(function (victim) {
      var cascades = raw[symbol][victim] || [];
      var key = symbol + "|" + victim;
      perGroup[key] = {
        validationFailures: [],
        w1Only: [],
        w2: [],
        w3: [],
        w4plus: [],
        transitions: [],
        orderingAmbiguousCount: 0,
      };

      cascades.forEach(function (c) {
        var waves = c.waves;
        for (var wi = 0; wi < waves.length; wi++) {
          var w = waves[wi];
          if (w.completionTime !== null && w.completionTime < w.startTime) {
            perGroup[key].validationFailures.push(
              "completionTime<startTime at " +
                fmtTs(w.startTime) +
                " (cascade " +
                fmtTs(c.cascadeStart) +
                ")",
            );
          }
          if (wi > 0 && waves[wi - 1].startTime >= w.startTime) {
            perGroup[key].validationFailures.push(
              "non-chronological wave starts at cascade " +
                fmtTs(c.cascadeStart),
            );
          }
          var sumLiq = w.events.reduce(function (s, e) {
            return s + e.quoteQty;
          }, 0);
          if (Math.abs(sumLiq - w.liquidationUsd) > 0.01) {
            perGroup[key].validationFailures.push(
              "liquidationUsd mismatch at wave " +
                w.waveNumber +
                " cascade " +
                fmtTs(c.cascadeStart),
            );
          }
          if (w.orderingAmbiguous || w.orderingAmbiguousExtension)
            perGroup[key].orderingAmbiguousCount++;
        }
        if (c.waveCount !== waves.length)
          perGroup[key].validationFailures.push(
            "waveCount mismatch at cascade " + fmtTs(c.cascadeStart),
          );

        if (waves.length === 1) perGroup[key].w1Only.push(c);
        else if (waves.length === 2) perGroup[key].w2.push(c);
        else if (waves.length === 3) perGroup[key].w3.push(c);
        else if (waves.length >= 4) perGroup[key].w4plus.push(c);

        for (var ti = 1; ti < waves.length; ti++) {
          var prev = waves[ti - 1],
            cur = waves[ti];
          if (cur.completionTime === null) continue;
          var liqRatio =
            prev.liquidationUsd > 0
              ? cur.liquidationUsd / prev.liquidationUsd
              : null;
          var progressRatio =
            prev.directionalProgressUnits &&
            prev.directionalProgressUnits > 0.0001 &&
            cur.directionalProgressUnits !== null
              ? cur.directionalProgressUnits / prev.directionalProgressUnits
              : null;
          var prevEff =
            prev.liquidationUsd > 0
              ? prev.directionalProgressUnits / prev.liquidationUsd
              : null;
          var curEff =
            cur.liquidationUsd > 0
              ? cur.directionalProgressUnits / cur.liquidationUsd
              : null;
          var efficiencyRatio =
            prevEff !== null && prevEff !== 0 && curEff !== null
              ? curEff / prevEff
              : null;
          var newExtremeExtensionUnits =
            c.unitAbs > 0
              ? victim === "LONG"
                ? (prev.extremePrice - cur.extremePrice) / c.unitAbs
                : (cur.extremePrice - prev.extremePrice) / c.unitAbs
              : null;

          var observeStartMinute = minuteFloor(cur.completionTime);
          var outcome = computeOutcome(
            klines,
            observeStartMinute,
            cur.extremePrice,
            victim,
            c.unitAbs,
          );
          var labels = labelsFromOutcome(outcome);

          var wnLiqLeRule = liqRatio !== null && liqRatio <= 1;

          var rec = {
            symbol: symbol,
            victim: victim,
            cascadeStart: c.cascadeStart,
            transition: "W" + prev.waveNumber + "->W" + cur.waveNumber,
            liqRatio: liqRatio,
            progressRatio: progressRatio,
            efficiencyRatio: efficiencyRatio,
            newExtremeExtensionUnits: newExtremeExtensionUnits,
            prevLiq: prev.liquidationUsd,
            curLiq: cur.liquidationUsd,
            wnLiqLeRule: wnLiqLeRule,
            orderingAmbiguous: !!(
              cur.orderingAmbiguous ||
              cur.orderingAmbiguousExtension ||
              prev.orderingAmbiguous
            ),
            outcome: outcome,
            labels: labels,
          };
          perGroup[key].transitions.push(rec);
          allTransitions.push(rec);
        }
      });
    });
  }

  console.log("\n" + "=".repeat(90));
  console.log("SECTION 1 -- VALIDATION");
  console.log("=".repeat(90));
  var anyFailures = false;
  Object.keys(perGroup).forEach(function (key) {
    var g = perGroup[key];
    console.log("\n" + key.replace("|", " ") + ":");
    console.log("  validation failures: " + g.validationFailures.length);
    if (g.validationFailures.length > 0) {
      anyFailures = true;
      g.validationFailures.slice(0, 10).forEach(function (f) {
        console.log("    FAIL: " + f);
      });
    }
    var total = g.w1Only.length + g.w2.length + g.w3.length + g.w4plus.length;
    console.log(
      "  total=" +
        total +
        " W1-only=" +
        g.w1Only.length +
        " W2=" +
        g.w2.length +
        " W3=" +
        g.w3.length +
        " W4+=" +
        g.w4plus.length,
    );
    console.log("  orderingAmbiguous waves: " + g.orderingAmbiguousCount);
  });
  if (anyFailures) {
    console.log(
      "\nCHRONOLOGY INVARIANTS BROKEN -- stopping before further analysis, per the operator's own instruction.",
    );
    process.exit(1);
  }

  console.log("\n" + "=".repeat(90));
  console.log(
    "SECTION 6 -- MULTI-WAVE TRANSITION OUTCOMES (W1-only comparison needs a separate pass -- see note)",
  );
  console.log("=".repeat(90));
  Object.keys(perGroup).forEach(function (key) {
    var g = perGroup[key];
    console.log("\n" + key.replace("|", " ") + ":");
    printGroupOutcome(
      "W1->W2 transition outcome",
      g.transitions.filter(function (t) {
        return t.transition === "W1->W2";
      }),
    );
    printGroupOutcome(
      "W2->W3 transition outcome",
      g.transitions.filter(function (t) {
        return t.transition === "W2->W3";
      }),
    );
  });

  console.log("\n" + "=".repeat(90));
  console.log("SECTION 3 -- EXHAUSTION HYPOTHESES (W1->W2 transitions)");
  console.log("=".repeat(90));
  Object.keys(perGroup).forEach(function (key) {
    var w1w2 = perGroup[key].transitions.filter(function (t) {
      return t.transition === "W1->W2";
    });
    console.log("\n" + key.replace("|", " ") + " (n=" + w1w2.length + "):");
    printGroupOutcome(
      "A: liqRatio<1 (W2<W1)",
      w1w2.filter(function (t) {
        return t.liqRatio !== null && t.liqRatio < 1;
      }),
    );
    printGroupOutcome(
      "A: liqRatio>=1 (W2>=W1)",
      w1w2.filter(function (t) {
        return t.liqRatio !== null && t.liqRatio >= 1;
      }),
    );
    printGroupOutcome(
      "B: progressRatio<1",
      w1w2.filter(function (t) {
        return t.progressRatio !== null && t.progressRatio < 1;
      }),
    );
    printGroupOutcome(
      "B: progressRatio>=1",
      w1w2.filter(function (t) {
        return t.progressRatio !== null && t.progressRatio >= 1;
      }),
    );
    printGroupOutcome(
      "C: efficiencyRatio<1",
      w1w2.filter(function (t) {
        return t.efficiencyRatio !== null && t.efficiencyRatio < 1;
      }),
    );
    printGroupOutcome(
      "C: efficiencyRatio>=1",
      w1w2.filter(function (t) {
        return t.efficiencyRatio !== null && t.efficiencyRatio >= 1;
      }),
    );
    printGroupOutcome(
      "D: newExtremeExtension<0.25U",
      w1w2.filter(function (t) {
        return (
          t.newExtremeExtensionUnits !== null &&
          t.newExtremeExtensionUnits < 0.25
        );
      }),
    );
    printGroupOutcome(
      "D: newExtremeExtension>=0.25U",
      w1w2.filter(function (t) {
        return (
          t.newExtremeExtensionUnits !== null &&
          t.newExtremeExtensionUnits >= 0.25
        );
      }),
    );
    printGroupOutcome(
      "E: combined (liqRatio<=1 & eff<1 & ext<0.25U)",
      w1w2.filter(function (t) {
        return (
          t.liqRatio !== null &&
          t.liqRatio <= 1 &&
          t.efficiencyRatio !== null &&
          t.efficiencyRatio < 1 &&
          t.newExtremeExtensionUnits !== null &&
          t.newExtremeExtensionUnits < 0.25
        );
      }),
    );
  });

  console.log("\n" + "=".repeat(90));
  console.log("SECTION 8 -- CURRENT Wn<=W(n-1) RULE, RETROSPECTIVE TEST");
  console.log("=".repeat(90));
  Object.keys(perGroup).forEach(function (key) {
    var ruleHits = perGroup[key].transitions.filter(function (t) {
      return t.wnLiqLeRule;
    });
    printGroupOutcome(
      key.replace("|", " ") + " -- first Liq(Wn)<=Liq(Wn-1)",
      ruleHits,
    );
  });

  console.log("\n" + "=".repeat(90));
  console.log(
    "SECTION 11 -- CLEAR vs ORDERING-AMBIGUOUS (1-minute-granularity approximate reconstruction)",
  );
  console.log("=".repeat(90));
  var clearTransitions = allTransitions.filter(function (t) {
    return !t.orderingAmbiguous;
  });
  var ambiguousTransitions = allTransitions.filter(function (t) {
    return t.orderingAmbiguous;
  });
  console.log(
    "Total transitions: " +
      allTransitions.length +
      "  CLEAR: " +
      clearTransitions.length +
      "  AMBIGUOUS: " +
      ambiguousTransitions.length,
  );
  if (clearTransitions.length === 0) {
    console.log(
      "CLEAR sample is ZERO -- no production decision can be justified from this ambiguous-only reconstruction.",
    );
  } else {
    printGroupOutcome("CLEAR only", clearTransitions);
    printGroupOutcome("AMBIGUOUS only", ambiguousTransitions);
  }

  var outPath = path.join(
    OUTPUT_DIR,
    "wave-transition-outcomes-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { perGroup: perGroup, allTransitionsCount: allTransitions.length },
      null,
      2,
    ),
  );
  console.log("\nDetailed analysis saved to: " + outPath);
  console.log(
    "\nLABEL: this entire analysis is a 1-MINUTE-GRANULARITY APPROXIMATE historical wave",
  );
  console.log(
    "reconstruction -- sub-minute trade ordering was never persisted (TradeStore was RAM-only).",
  );
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
