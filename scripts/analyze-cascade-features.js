const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

function fmtUsd(n) {
  if (n === null || n === undefined) return "n/a";
  var sign = n < 0 ? "-" : "";
  var abs = Math.abs(n);
  if (abs >= 1000000) return sign + "$" + (abs / 1000000).toFixed(2) + "M";
  if (abs >= 1000) return sign + "$" + (abs / 1000).toFixed(1) + "k";
  return sign + "$" + Math.round(abs);
}
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

function aucEffectSize(goodVals, badVals) {
  var g = goodVals.filter(function (x) {
    return x !== null && x !== undefined && !isNaN(x);
  });
  var b = badVals.filter(function (x) {
    return x !== null && x !== undefined && !isNaN(x);
  });
  if (g.length === 0 || b.length === 0) return null;
  var wins = 0,
    ties = 0;
  for (var i = 0; i < g.length; i++) {
    for (var j = 0; j < b.length; j++) {
      if (g[i] > b[j]) wins++;
      else if (g[i] === b[j]) ties++;
    }
  }
  return (wins + 0.5 * ties) / (g.length * b.length);
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

function deriveFeatures(c) {
  var f = {};
  f.maxEventToTotalRatio =
    c.totalLiqUsd > 0 ? c.maxIndividualEvent / c.totalLiqUsd : null;
  var peakIdx = c.liqUsdByMinute.indexOf(
    Math.max.apply(null, c.liqUsdByMinute),
  );
  f.peakMinuteLiqUsd = c.liqUsdByMinute[peakIdx];
  f.peakMinuteRatio =
    c.totalLiqUsd > 0 ? f.peakMinuteLiqUsd / c.totalLiqUsd : null;
  f.firstMinuteLiqUsd = c.liqUsdByMinute[0];
  f.lastActiveMinuteLiqUsd = c.liqUsdByMinute[c.liqUsdByMinute.length - 1];
  f.lastToFirstRatio =
    f.firstMinuteLiqUsd > 0
      ? f.lastActiveMinuteLiqUsd / f.firstMinuteLiqUsd
      : null;
  f.lastToPeakRatio =
    f.peakMinuteLiqUsd > 0
      ? f.lastActiveMinuteLiqUsd / f.peakMinuteLiqUsd
      : null;

  var n = c.liqUsdByMinute.length;
  if (n >= 2) {
    var final2 = c.liqUsdByMinute.slice(-2).reduce(function (a, b) {
      return a + b;
    }, 0);
    var prevAvg =
      n > 2
        ? c.liqUsdByMinute.slice(0, -2).reduce(function (a, b) {
            return a + b;
          }, 0) /
          (n - 2)
        : c.liqUsdByMinute[0];
    f.final2VsPrevAvgRatio = prevAvg > 0 ? final2 / 2 / prevAvg : null;
  } else {
    f.final2VsPrevAvgRatio = null;
  }

  if (n === 1) {
    f.intensityTrend = "single-minute";
    f.peakPosition = "single-minute";
  } else {
    var increasing = true,
      decreasing = true;
    for (var i = 1; i < n; i++) {
      if (c.liqUsdByMinute[i] < c.liqUsdByMinute[i - 1]) increasing = false;
      if (c.liqUsdByMinute[i] > c.liqUsdByMinute[i - 1]) decreasing = false;
    }
    f.intensityTrend = increasing
      ? "increasing"
      : decreasing
        ? "decreasing"
        : "mixed";
    var third = n / 3;
    f.peakPosition =
      peakIdx < third ? "early" : peakIdx < 2 * third ? "middle" : "late";
  }
  return f;
}

function deriveOutcomeLabels(c) {
  if (!c.outcome || c.outcome.incomplete || !c.outcome.firstHit)
    return { valid: false };
  var fh = c.outcome.firstHit;
  var t1p = fh["+1U"],
    t1n = fh["-1U"],
    t2p = fh["+2U"],
    t3p = fh["+3U"];
  var strongReversal1U = t1p !== null && (t1n === null || t1p <= t1n);
  var strongReversal2U = t2p !== null && (t1n === null || t2p <= t1n);
  var strongReversal3U = t3p !== null && (t1n === null || t3p <= t1n);
  var failedReversal = t1n !== null && (t1p === null || t1n < t1p);
  return {
    valid: true,
    STRONG_REVERSAL_1U: strongReversal1U,
    STRONG_REVERSAL_2U: strongReversal2U,
    STRONG_REVERSAL_3U: strongReversal3U,
    FAILED_REVERSAL: failedReversal,
    mfe15m:
      c.outcome.horizons && c.outcome.horizons["15m"]
        ? c.outcome.horizons["15m"].mfeUnits
        : null,
    mae15m:
      c.outcome.horizons && c.outcome.horizons["15m"]
        ? c.outcome.horizons["15m"].maeUnits
        : null,
    mfe30m:
      c.outcome.horizons && c.outcome.horizons["30m"]
        ? c.outcome.horizons["30m"].mfeUnits
        : null,
    mae30m:
      c.outcome.horizons && c.outcome.horizons["30m"]
        ? c.outcome.horizons["30m"].maeUnits
        : null,
  };
}

function main() {
  var srcPath = findLatestJson("cascade-outcomes-");
  if (!srcPath) {
    console.error(
      "No cascade-outcomes-*.json found in research-output/. Run research-cascade-outcomes.js first.",
    );
    process.exit(1);
  }
  console.log("Loading dataset: " + srcPath);
  var raw = JSON.parse(fs.readFileSync(srcPath, "utf8"));

  var allEnriched = {};
  var symbols = Object.keys(raw);

  symbols.forEach(function (symbol) {
    allEnriched[symbol] = {};
    ["LONG", "SHORT"].forEach(function (victim) {
      var cascades = raw[symbol][victim] || [];
      var enriched = cascades
        .map(function (c) {
          return {
            c: c,
            features: deriveFeatures(c),
            labels: deriveOutcomeLabels(c),
          };
        })
        .filter(function (e) {
          return e.labels.valid;
        });
      allEnriched[symbol][victim] = enriched;
    });
  });

  var FEATURE_LIST = [
    [
      "totalLiqUsd",
      function (e) {
        return e.c.totalLiqUsd;
      },
    ],
    [
      "durationMinutes",
      function (e) {
        return e.c.durationMinutes;
      },
    ],
    [
      "totalEventCount",
      function (e) {
        return e.c.totalEventCount;
      },
    ],
    [
      "maxIndividualEvent",
      function (e) {
        return e.c.maxIndividualEvent;
      },
    ],
    [
      "maxEventToTotalRatio",
      function (e) {
        return e.features.maxEventToTotalRatio;
      },
    ],
    [
      "peakMinuteLiqUsd",
      function (e) {
        return e.features.peakMinuteLiqUsd;
      },
    ],
    [
      "peakMinuteRatio",
      function (e) {
        return e.features.peakMinuteRatio;
      },
    ],
    [
      "forcedPriceProgressUnits",
      function (e) {
        return e.c.forcedPriceProgressUnits;
      },
    ],
    [
      "recoveryAlreadyInsideCascadeUnits",
      function (e) {
        return e.c.recoveryAlreadyInsideCascadeUnits;
      },
    ],
    [
      "liqUsdPerUnitOfForcedProgress",
      function (e) {
        return e.c.liqUsdPerUnitOfForcedProgress;
      },
    ],
    [
      "maxEventPerUnit",
      function (e) {
        return e.c.maxEventPerUnit;
      },
    ],
    [
      "eventCountPerUnit",
      function (e) {
        return e.c.eventCountPerUnit;
      },
    ],
    [
      "lastToFirstRatio",
      function (e) {
        return e.features.lastToFirstRatio;
      },
    ],
    [
      "lastToPeakRatio",
      function (e) {
        return e.features.lastToPeakRatio;
      },
    ],
  ];

  var featureRankings = {};

  symbols.forEach(function (symbol) {
    ["LONG", "SHORT"].forEach(function (victim) {
      var group = allEnriched[symbol][victim];
      console.log("\n" + "=".repeat(90));
      console.log(
        symbol +
          " " +
          victim +
          " -- GOOD (+2U before -1U) vs BAD (-1U before +2U)",
      );
      console.log("=".repeat(90));

      var good = group.filter(function (e) {
        return e.labels.STRONG_REVERSAL_2U;
      });
      var bad = group.filter(function (e) {
        return !e.labels.STRONG_REVERSAL_2U && e.labels.FAILED_REVERSAL;
      });
      console.log(
        "n=" +
          group.length +
          "  GOOD=" +
          good.length +
          "  BAD=" +
          bad.length +
          "  (neither=" +
          (group.length - good.length - bad.length) +
          ")",
      );

      var rankings = [];
      FEATURE_LIST.forEach(function (fdef) {
        var name = fdef[0],
          getter = fdef[1];
        var goodVals = good.map(getter);
        var badVals = bad.map(getter);
        var medG = median(goodVals);
        var medB = median(badVals);
        var p25G = percentileOf(goodVals, 25),
          p75G = percentileOf(goodVals, 75);
        var p25B = percentileOf(badVals, 25),
          p75B = percentileOf(badVals, 75);
        var auc = aucEffectSize(goodVals, badVals);
        console.log(
          "  " +
            name.padEnd(32) +
            " medGOOD=" +
            (medG === null ? "n/a" : medG.toFixed(3)).toString().padEnd(12) +
            " medBAD=" +
            (medB === null ? "n/a" : medB.toFixed(3)).toString().padEnd(12) +
            " AUC=" +
            (auc === null ? "n/a" : auc.toFixed(3)),
        );
        if (auc !== null)
          rankings.push({
            feature: name,
            auc: auc,
            absEffect: Math.abs(auc - 0.5),
            medGood: medG,
            medBad: medB,
            p25Good: p25G,
            p75Good: p75G,
            p25Bad: p25B,
            p75Bad: p75B,
          });
      });
      rankings.sort(function (a, b) {
        return b.absEffect - a.absEffect;
      });
      featureRankings[symbol + "|" + victim] = rankings;
    });
  });

  console.log("\n" + "=".repeat(90));
  console.log(
    "FEATURE RANKING (by |AUC - 0.5|, larger = stronger separation for +2U-before-1U)",
  );
  console.log("=".repeat(90));
  Object.keys(featureRankings).forEach(function (key) {
    console.log("\n" + key.replace("|", " "));
    featureRankings[key].slice(0, 8).forEach(function (r, i) {
      console.log(
        "  " +
          (i + 1) +
          ". " +
          r.feature +
          "  AUC=" +
          r.auc.toFixed(3) +
          " (effect=" +
          r.absEffect.toFixed(3) +
          ")",
      );
    });
  });

  console.log("\n" + "-".repeat(90));
  console.log("CROSS-SYMBOL/SIDE CONSISTENCY");
  console.log("-".repeat(90));
  var allKeys = Object.keys(featureRankings);
  var featureConsistency = {};
  FEATURE_LIST.forEach(function (fdef) {
    var name = fdef[0];
    var directions = [];
    var topRanks = 0;
    allKeys.forEach(function (key) {
      var entry = null;
      for (var i = 0; i < featureRankings[key].length; i++)
        if (featureRankings[key][i].feature === name)
          entry = featureRankings[key][i];
      if (entry) {
        directions.push(entry.auc > 0.5 ? 1 : entry.auc < 0.5 ? -1 : 0);
        var rankIdx = -1;
        for (var j = 0; j < featureRankings[key].length; j++)
          if (featureRankings[key][j].feature === name) rankIdx = j;
        if (rankIdx !== -1 && rankIdx < 8) topRanks++;
      }
    });
    var posCount = directions.filter(function (d) {
      return d === 1;
    }).length;
    var negCount = directions.filter(function (d) {
      return d === -1;
    }).length;
    var sameDirCount = Math.max(posCount, negCount);
    featureConsistency[name] = {
      sameDirCount: sameDirCount,
      totalGroups: directions.length,
      topRanks: topRanks,
    };
  });
  Object.keys(featureConsistency)
    .sort(function (a, b) {
      return (
        featureConsistency[b].sameDirCount +
        featureConsistency[b].topRanks -
        (featureConsistency[a].sameDirCount + featureConsistency[a].topRanks)
      );
    })
    .forEach(function (name) {
      var fc = featureConsistency[name];
      console.log(
        "  " +
          name.padEnd(32) +
          " same-direction in " +
          fc.sameDirCount +
          "/" +
          fc.totalGroups +
          " groups, top-8 in " +
          fc.topRanks +
          "/" +
          fc.totalGroups,
      );
    });

  var BUCKET_FEATURES = [
    "totalLiqUsd",
    "forcedPriceProgressUnits",
    "liqUsdPerUnitOfForcedProgress",
    "maxIndividualEvent",
    "lastToPeakRatio",
  ];
  var BUCKET_EDGES = [0, 25, 50, 75, 90, 95, 99, 100];
  var BUCKET_LABELS = [
    "0-25",
    "25-50",
    "50-75",
    "75-90",
    "90-95",
    "95-99",
    "99+",
  ];

  function getterFor(name) {
    for (var i = 0; i < FEATURE_LIST.length; i++)
      if (FEATURE_LIST[i][0] === name) return FEATURE_LIST[i][1];
    return null;
  }

  console.log("\n" + "=".repeat(90));
  console.log("BUCKET ANALYSIS");
  console.log("=".repeat(90));
  symbols.forEach(function (symbol) {
    ["LONG", "SHORT"].forEach(function (victim) {
      var group = allEnriched[symbol][victim];
      if (group.length < 8) return;
      BUCKET_FEATURES.forEach(function (fname) {
        var getter = getterFor(fname);
        var vals = group.map(getter).filter(function (v) {
          return v !== null && v !== undefined && !isNaN(v);
        });
        if (vals.length < 8) return;
        console.log("\n" + symbol + " " + victim + " -- bucketed by " + fname);
        for (var bi = 0; bi < BUCKET_EDGES.length - 1; bi++) {
          var lo = percentileOf(vals, BUCKET_EDGES[bi]);
          var hi = percentileOf(vals, BUCKET_EDGES[bi + 1]);
          var bucketItems = group.filter(function (e) {
            var v = getter(e);
            if (v === null || v === undefined || isNaN(v)) return false;
            return bi === BUCKET_EDGES.length - 2
              ? v >= lo && v <= hi
              : v >= lo && v < hi;
          });
          if (bucketItems.length === 0) continue;
          var r1 = bucketItems.filter(function (e) {
            return e.labels.STRONG_REVERSAL_1U;
          }).length;
          var r2 = bucketItems.filter(function (e) {
            return e.labels.STRONG_REVERSAL_2U;
          }).length;
          var r3 = bucketItems.filter(function (e) {
            return e.labels.STRONG_REVERSAL_3U;
          }).length;
          console.log(
            "  " +
              BUCKET_LABELS[bi].padEnd(8) +
              " n=" +
              String(bucketItems.length).padEnd(4) +
              " +1U=" +
              pctOf(r1, bucketItems.length).padEnd(7) +
              " +2U=" +
              pctOf(r2, bucketItems.length).padEnd(7) +
              " +3U=" +
              pctOf(r3, bucketItems.length).padEnd(7) +
              " medMFE15m=" +
              (
                median(
                  bucketItems.map(function (e) {
                    return e.labels.mfe15m;
                  }),
                ) || 0
              ).toFixed(2) +
              "U" +
              " medMAE15m=" +
              (
                median(
                  bucketItems.map(function (e) {
                    return e.labels.mae15m;
                  }),
                ) || 0
              ).toFixed(2) +
              "U",
          );
        }
      });
    });
  });

  console.log("\n" + "=".repeat(90));
  console.log(
    "SECTION 5 -- LIQUIDATION SIZE (within-symbol/side median split) x FORCED-PROGRESS-UNITS QUADRANTS",
  );
  console.log("=".repeat(90));
  symbols.forEach(function (symbol) {
    ["LONG", "SHORT"].forEach(function (victim) {
      var group = allEnriched[symbol][victim];
      var withBoth = group.filter(function (e) {
        return (
          e.c.totalLiqUsd !== null && e.c.forcedPriceProgressUnits !== null
        );
      });
      if (withBoth.length < 8) return;
      var liqVals = withBoth.map(function (e) {
        return e.c.totalLiqUsd;
      });
      var progVals = withBoth.map(function (e) {
        return e.c.forcedPriceProgressUnits;
      });
      var liqMed = median(liqVals),
        progMed = median(progVals);
      var quads = {
        "HIGH-liq_LOW-prog": [],
        "HIGH-liq_HIGH-prog": [],
        "LOW-liq_LOW-prog": [],
        "LOW-liq_HIGH-prog": [],
      };
      withBoth.forEach(function (e) {
        var liqHigh = e.c.totalLiqUsd >= liqMed;
        var progHigh = e.c.forcedPriceProgressUnits >= progMed;
        var key =
          (liqHigh ? "HIGH" : "LOW") +
          "-liq_" +
          (progHigh ? "HIGH" : "LOW") +
          "-prog";
        quads[key].push(e);
      });
      console.log(
        "\n" +
          symbol +
          " " +
          victim +
          " (liqMedian=" +
          fmtUsd(liqMed) +
          ", progressMedian=" +
          (progMed === null ? "n/a" : progMed.toFixed(2)) +
          "U):",
      );
      Object.keys(quads).forEach(function (qk) {
        var items = quads[qk];
        if (items.length === 0) {
          console.log("  " + qk.padEnd(20) + " n=0");
          return;
        }
        var r1 = items.filter(function (e) {
          return e.labels.STRONG_REVERSAL_1U;
        }).length;
        var r2 = items.filter(function (e) {
          return e.labels.STRONG_REVERSAL_2U;
        }).length;
        var r3 = items.filter(function (e) {
          return e.labels.STRONG_REVERSAL_3U;
        }).length;
        console.log(
          "  " +
            qk.padEnd(20) +
            " n=" +
            String(items.length).padEnd(4) +
            " +1U=" +
            pctOf(r1, items.length).padEnd(7) +
            " +2U=" +
            pctOf(r2, items.length).padEnd(7) +
            " +3U=" +
            pctOf(r3, items.length).padEnd(7) +
            " medMFE=" +
            (
              median(
                items.map(function (e) {
                  return e.labels.mfe15m;
                }),
              ) || 0
            ).toFixed(2) +
            "U" +
            " medMAE=" +
            (
              median(
                items.map(function (e) {
                  return e.labels.mae15m;
                }),
              ) || 0
            ).toFixed(2) +
            "U",
        );
      });
    });
  });

  console.log("\n" + "=".repeat(90));
  console.log(
    "SECTION 6 -- CASCADE-END EXHAUSTION (lastMinute/peakMinute ratio) + PEAK POSITION",
  );
  console.log("=".repeat(90));
  symbols.forEach(function (symbol) {
    ["LONG", "SHORT"].forEach(function (victim) {
      var group = allEnriched[symbol][victim];
      var multiMin = group.filter(function (e) {
        return e.c.durationMinutes >= 2;
      });
      if (multiMin.length < 4) return;
      console.log(
        "\n" +
          symbol +
          " " +
          victim +
          " (multi-minute cascades only, n=" +
          multiMin.length +
          "):",
      );
      var ratioVals = multiMin
        .map(function (e) {
          return e.features.lastToPeakRatio;
        })
        .filter(function (v) {
          return v !== null;
        });
      var edges = [0, 33, 66, 100];
      for (var bi = 0; bi < 3; bi++) {
        var lo = percentileOf(ratioVals, edges[bi]);
        var hi = percentileOf(ratioVals, edges[bi + 1]);
        var items = multiMin.filter(function (e) {
          var v = e.features.lastToPeakRatio;
          return v !== null && v >= lo && (bi === 2 ? v <= hi : v < hi);
        });
        if (items.length === 0) continue;
        var r2 = items.filter(function (e) {
          return e.labels.STRONG_REVERSAL_2U;
        }).length;
        console.log(
          "  lastToPeakRatio [" +
            lo.toFixed(2) +
            "-" +
            hi.toFixed(2) +
            "]  n=" +
            items.length +
            "  +2U=" +
            pctOf(r2, items.length),
        );
      }
      ["early", "middle", "late"].forEach(function (pos) {
        var items = multiMin.filter(function (e) {
          return e.features.peakPosition === pos;
        });
        if (items.length === 0) return;
        var r2 = items.filter(function (e) {
          return e.labels.STRONG_REVERSAL_2U;
        }).length;
        console.log(
          "  peak=" +
            pos.padEnd(8) +
            " n=" +
            String(items.length).padEnd(4) +
            " +2U=" +
            pctOf(r2, items.length),
        );
      });
    });
  });

  console.log("\n" + "=".repeat(90));
  console.log("SECTION 7 -- DURATION GROUPS");
  console.log("=".repeat(90));
  symbols.forEach(function (symbol) {
    ["LONG", "SHORT"].forEach(function (victim) {
      var group = allEnriched[symbol][victim];
      console.log("\n" + symbol + " " + victim + ":");
      var durationGroups = [
        [1, 1, "1-minute"],
        [2, 2, "2-minute"],
        [3, 3, "3-minute"],
        [4, Infinity, "4+ minute"],
      ];
      durationGroups.forEach(function (d) {
        var items = group.filter(function (e) {
          return e.c.durationMinutes >= d[0] && e.c.durationMinutes <= d[1];
        });
        if (items.length === 0) {
          console.log("  " + d[2].padEnd(12) + " n=0");
          return;
        }
        var r1 = items.filter(function (e) {
          return e.labels.STRONG_REVERSAL_1U;
        }).length;
        var r2 = items.filter(function (e) {
          return e.labels.STRONG_REVERSAL_2U;
        }).length;
        var r3 = items.filter(function (e) {
          return e.labels.STRONG_REVERSAL_3U;
        }).length;
        console.log(
          "  " +
            d[2].padEnd(12) +
            " n=" +
            String(items.length).padEnd(4) +
            " medTotalLiq=" +
            fmtUsd(
              median(
                items.map(function (e) {
                  return e.c.totalLiqUsd;
                }),
              ),
            ).padEnd(10) +
            " medProgress=" +
            (
              median(
                items.map(function (e) {
                  return e.c.forcedPriceProgressUnits;
                }),
              ) || 0
            ).toFixed(2) +
            "U" +
            " +1U=" +
            pctOf(r1, items.length).padEnd(7) +
            " +2U=" +
            pctOf(r2, items.length).padEnd(7) +
            " +3U=" +
            pctOf(r3, items.length),
        );
      });
    });
  });

  console.log("\n" + "=".repeat(90));
  console.log("SECTION 8 -- P95 DIAGNOSTIC (why containsP95Event may show 0)");
  console.log("=".repeat(90));
  symbols.forEach(function (symbol) {
    ["LONG", "SHORT"].forEach(function (victim) {
      var group = allEnriched[symbol][victim];
      var nullP95 = group.filter(function (e) {
        return e.c.p95AtStart === null;
      }).length;
      var lowSample = group.filter(function (e) {
        return e.c.p95SampleCount !== undefined && e.c.p95SampleCount < 30;
      }).length;
      console.log(
        "\n" +
          symbol +
          " " +
          victim +
          ": " +
          group.length +
          " cascades, p95AtStart=null for " +
          nullP95 +
          ", p95SampleCount<30 for " +
          lowSample,
      );
      console.log("  10 concrete examples:");
      group.slice(0, 10).forEach(function (e) {
        console.log(
          "    " +
            fmtTs(e.c.startTime) +
            "  maxEvent=" +
            fmtUsd(e.c.maxIndividualEvent) +
            "  p95AtStart=" +
            (e.c.p95AtStart === null ? "null" : fmtUsd(e.c.p95AtStart)) +
            "  sampleCount=" +
            e.c.p95SampleCount +
            "  ratio=" +
            (e.c.maxEventToP95Ratio === null
              ? "n/a"
              : e.c.maxEventToP95Ratio.toFixed(2)) +
            "  containsP95=" +
            e.c.containsP95Event,
        );
      });
    });
  });

  var outPath = path.join(
    OUTPUT_DIR,
    "cascade-feature-analysis-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        featureRankings: featureRankings,
        featureConsistency: featureConsistency,
      },
      null,
      2,
    ),
  );
  console.log("\nFeature-analysis dataset saved to: " + outPath);
}

main();
