require("dotenv/config");
const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "research-output");
const SAMPLE_CAPACITY = 5000;
const MIN_SAMPLES = 30;

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
function findLatestJson(prefix) {
  if (!fs.existsSync(OUTPUT_DIR)) return null;
  var files = fs.readdirSync(OUTPUT_DIR).filter(function (f) {
    return f.indexOf(prefix) === 0 && f.slice(-5) === ".json";
  });
  if (files.length === 0) return null;
  files.sort();
  return path.join(OUTPUT_DIR, files[files.length - 1]);
}

async function computeHistoricalP95(rawCol, symbol, victim, cascadeStart) {
  var victimDocs = await rawCol
    .find({ symbol: symbol, victim: victim, timestamp: { $lt: cascadeStart } })
    .sort({ timestamp: -1 })
    .limit(SAMPLE_CAPACITY)
    .project({ quoteQty: 1, _id: 0 })
    .toArray();

  if (victimDocs.length >= MIN_SAMPLES) {
    var vals = victimDocs.map(function (d) {
      return d.quoteQty;
    });
    return {
      p95: percentileOf(vals, 95),
      sampleCount: victimDocs.length,
      sourceSide: victim,
      usedFallback: false,
    };
  }

  var combinedDocs = await rawCol
    .find({ symbol: symbol, timestamp: { $lt: cascadeStart } })
    .sort({ timestamp: -1 })
    .limit(SAMPLE_CAPACITY)
    .project({ quoteQty: 1, _id: 0 })
    .toArray();

  if (combinedDocs.length < MIN_SAMPLES) {
    return {
      p95: null,
      sampleCount: combinedDocs.length,
      sourceSide: "combined",
      usedFallback: true,
    };
  }
  var cvals = combinedDocs.map(function (d) {
    return d.quoteQty;
  });
  return {
    p95: percentileOf(cvals, 95),
    sampleCount: combinedDocs.length,
    sourceSide: "combined",
    usedFallback: true,
  };
}

async function fetchCascadeEvents(
  rawCol,
  symbol,
  victim,
  cascadeStart,
  cascadeEndExclusive,
) {
  var endBound =
    cascadeEndExclusive === null
      ? cascadeStart + 30 * 24 * 3600 * 1000
      : cascadeEndExclusive;
  return rawCol
    .find({
      symbol: symbol,
      victim: victim,
      timestamp: { $gte: cascadeStart, $lt: endBound },
    })
    .project({ quoteQty: 1, timestamp: 1, price: 1, _id: 0 })
    .toArray();
}

async function main() {
  var uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }

  var srcPath = findLatestJson("cascade-outcomes-");
  if (!srcPath) {
    console.error(
      "No cascade-outcomes-*.json found in research-output/. Run research-cascade-outcomes.js first.",
    );
    process.exit(1);
  }
  console.log("Loading dataset: " + srcPath);
  var raw = JSON.parse(fs.readFileSync(srcPath, "utf8"));

  var client = new MongoClient(uri);
  await client.connect();
  var db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  var rawCol = db.collection("liq_raw_events");

  var rawCount = await rawCol.estimatedDocumentCount();
  console.log("liq_raw_events: " + rawCount + " total documents (estimated).");
  if (rawCount === 0) {
    console.error(
      "liq_raw_events is EMPTY. True historical P95 cannot be reconstructed. Stopping -- not faking a proxy.",
    );
    await client.close();
    process.exit(1);
  }

  var symbols = Object.keys(raw);
  var allP95Ratios = {};
  var updatedDataset = {};

  for (var si = 0; si < symbols.length; si++) {
    var symbol = symbols[si];
    updatedDataset[symbol] = {
      symbol: symbol,
      period: raw[symbol].period,
      LONG: [],
      SHORT: [],
    };

    var rangeFirst = await rawCol
      .find({ symbol: symbol })
      .sort({ timestamp: 1 })
      .limit(1)
      .toArray();
    var rangeLast = await rawCol
      .find({ symbol: symbol })
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray();
    console.log(
      "\n" +
        symbol +
        " liq_raw_events range: " +
        (rangeFirst.length ? fmtTs(rangeFirst[0].timestamp) : "n/a") +
        " .. " +
        (rangeLast.length ? fmtTs(rangeLast[0].timestamp) : "n/a"),
    );

    for (var vi = 0; vi < 2; vi++) {
      var victim = vi === 0 ? "LONG" : "SHORT";
      var cascades = raw[symbol][victim] || [];
      console.log(
        "\n" +
          symbol +
          " " +
          victim +
          ": recomputing P95 for " +
          cascades.length +
          " cascades from liq_raw_events...",
      );

      var enriched = [];
      var withValidP95 = 0;

      for (var ci = 0; ci < cascades.length; ci++) {
        var c = cascades[ci];
        var p95Result = await computeHistoricalP95(
          rawCol,
          symbol,
          victim,
          c.startTime,
        );
        var cascadeEvents = await fetchCascadeEvents(
          rawCol,
          symbol,
          victim,
          c.startTime,
          c.endTime,
        );
        var realMaxEvent =
          cascadeEvents.length > 0
            ? Math.max.apply(
                null,
                cascadeEvents.map(function (e) {
                  return e.quoteQty;
                }),
              )
            : c.maxIndividualEvent;

        var containsP95Event =
          p95Result.p95 !== null &&
          cascadeEvents.some(function (e) {
            return e.quoteQty >= p95Result.p95;
          });
        var maxEventToP95Ratio =
          p95Result.p95 && p95Result.p95 > 0
            ? realMaxEvent / p95Result.p95
            : null;

        var updated = Object.assign({}, c, {
          maxIndividualEvent: realMaxEvent,
          p95AtStart: p95Result.p95,
          p95SampleCount: p95Result.sampleCount,
          p95SourceSide: p95Result.sourceSide,
          p95UsedFallback: p95Result.usedFallback,
          maxEventToP95Ratio: maxEventToP95Ratio,
          containsP95Event: containsP95Event,
        });
        enriched.push(updated);
        if (p95Result.p95 !== null) withValidP95++;
      }

      updatedDataset[symbol][victim] = enriched;
      console.log(
        "  -> " +
          withValidP95 +
          "/" +
          cascades.length +
          " cascades now have a valid p95AtStart.",
      );
      allP95Ratios[symbol + "|" + victim] = enriched;
    }
  }

  await client.close();

  console.log("\n" + "=".repeat(90));
  console.log("SECTION 7 -- P95 DISTRIBUTION SANITY CHECK");
  console.log("=".repeat(90));
  Object.keys(allP95Ratios).forEach(function (key) {
    var group = allP95Ratios[key];
    var withP95 = group.filter(function (c) {
      return c.p95AtStart !== null;
    });
    var withoutP95 = group.filter(function (c) {
      return c.p95AtStart === null;
    });
    var p95Vals = withP95.map(function (c) {
      return c.p95AtStart;
    });
    var containsCount = withP95.filter(function (c) {
      return c.containsP95Event;
    }).length;

    console.log("\n" + key.replace("|", " ") + ":");
    console.log(
      "  with valid P95: " +
        withP95.length +
        "   without: " +
        withoutP95.length,
    );
    console.log(
      "  median P95: " +
        fmtUsd(median(p95Vals)) +
        "   p25: " +
        fmtUsd(percentileOf(p95Vals, 25)) +
        "   p75: " +
        fmtUsd(percentileOf(p95Vals, 75)),
    );
    console.log(
      "  % containing >=1 P95 event: " + pctOf(containsCount, withP95.length),
    );

    var ratioBuckets = [
      [
        "<0.5x",
        function (r) {
          return r < 0.5;
        },
      ],
      [
        "0.5-1.0x",
        function (r) {
          return r >= 0.5 && r < 1.0;
        },
      ],
      [
        "1.0-1.5x",
        function (r) {
          return r >= 1.0 && r < 1.5;
        },
      ],
      [
        "1.5-2.0x",
        function (r) {
          return r >= 1.5 && r < 2.0;
        },
      ],
      [
        "2.0-3.0x",
        function (r) {
          return r >= 2.0 && r < 3.0;
        },
      ],
      [
        "3.0-5.0x",
        function (r) {
          return r >= 3.0 && r < 5.0;
        },
      ],
      [
        "5.0x+",
        function (r) {
          return r >= 5.0;
        },
      ],
    ];
    var withRatio = withP95.filter(function (c) {
      return c.maxEventToP95Ratio !== null;
    });
    console.log(
      "  maxEventToP95Ratio distribution (n=" + withRatio.length + "):",
    );
    ratioBuckets.forEach(function (b) {
      var n = withRatio.filter(function (c) {
        return b[1](c.maxEventToP95Ratio);
      }).length;
      console.log(
        "    " +
          b[0].padEnd(10) +
          " n=" +
          n +
          "  (" +
          pctOf(n, withRatio.length) +
          ")",
      );
    });
  });

  console.log("\n" + "=".repeat(90));
  console.log("SECTION 6 -- 10 CONCRETE EXAMPLES PER SYMBOL/SIDE");
  console.log("=".repeat(90));
  Object.keys(allP95Ratios).forEach(function (key) {
    var group = allP95Ratios[key];
    console.log("\n" + key.replace("|", " ") + ":");
    group.slice(0, 10).forEach(function (c) {
      console.log(
        "  " +
          fmtTs(c.startTime) +
          "  p95AtStart=" +
          fmtUsd(c.p95AtStart) +
          "  sampleCount=" +
          c.p95SampleCount +
          "  source=" +
          c.p95SourceSide +
          (c.p95UsedFallback ? "(fallback)" : "") +
          "  maxEvent=" +
          fmtUsd(c.maxIndividualEvent) +
          "  ratio=" +
          (c.maxEventToP95Ratio === null
            ? "n/a"
            : c.maxEventToP95Ratio.toFixed(2) + "x") +
          "  containsP95=" +
          c.containsP95Event +
          "  cascadeTotal=" +
          fmtUsd(c.totalLiqUsd),
      );
    });
  });

  console.log("\n" + "=".repeat(90));
  console.log("SECTION 8 -- OUTCOME COMPARISON BY maxEventToP95Ratio");
  console.log("=".repeat(90));
  var RATIO_BUCKETS = [
    [
      "<0.5x",
      function (r) {
        return r < 0.5;
      },
    ],
    [
      "0.5-1.0x",
      function (r) {
        return r >= 0.5 && r < 1.0;
      },
    ],
    [
      "1.0-1.5x",
      function (r) {
        return r >= 1.0 && r < 1.5;
      },
    ],
    [
      "1.5-2.0x",
      function (r) {
        return r >= 1.5 && r < 2.0;
      },
    ],
    [
      "2.0-3.0x",
      function (r) {
        return r >= 2.0 && r < 3.0;
      },
    ],
    [
      "3.0-5.0x",
      function (r) {
        return r >= 3.0 && r < 5.0;
      },
    ],
    [
      "5.0x+",
      function (r) {
        return r >= 5.0;
      },
    ],
  ];
  function labelsFor(c) {
    if (!c.outcome || c.outcome.incomplete || !c.outcome.firstHit) return null;
    var fh = c.outcome.firstHit;
    var t1p = fh["+1U"],
      t1n = fh["-1U"],
      t2p = fh["+2U"],
      t3p = fh["+3U"];
    return {
      r1: t1p !== null && (t1n === null || t1p <= t1n),
      r2: t2p !== null && (t1n === null || t2p <= t1n),
      r3: t3p !== null && (t1n === null || t3p <= t1n),
      mfe15:
        c.outcome.horizons && c.outcome.horizons["15m"]
          ? c.outcome.horizons["15m"].mfeUnits
          : null,
      mae15:
        c.outcome.horizons && c.outcome.horizons["15m"]
          ? c.outcome.horizons["15m"].maeUnits
          : null,
    };
  }
  Object.keys(allP95Ratios).forEach(function (key) {
    var group = allP95Ratios[key].filter(function (c) {
      return c.maxEventToP95Ratio !== null && labelsFor(c) !== null;
    });
    console.log("\n" + key.replace("|", " ") + " (n=" + group.length + "):");
    RATIO_BUCKETS.forEach(function (b) {
      var items = group.filter(function (c) {
        return b[1](c.maxEventToP95Ratio);
      });
      if (items.length === 0) {
        console.log("  " + b[0].padEnd(10) + " n=0");
        return;
      }
      var lab = items.map(labelsFor);
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
          b[0].padEnd(10) +
          " n=" +
          String(items.length).padEnd(4) +
          " +1U=" +
          pctOf(r1, items.length).padEnd(7) +
          " +2U=" +
          pctOf(r2, items.length).padEnd(7) +
          " +3U=" +
          pctOf(r3, items.length).padEnd(7) +
          " medMFE15m=" +
          (
            median(
              lab.map(function (l) {
                return l.mfe15;
              }),
            ) || 0
          ).toFixed(2) +
          "U" +
          " medMAE15m=" +
          (
            median(
              lab.map(function (l) {
                return l.mae15;
              }),
            ) || 0
          ).toFixed(2) +
          "U",
      );
    });
    var hasP95 = group.filter(function (c) {
      return c.containsP95Event;
    });
    var noP95 = group.filter(function (c) {
      return !c.containsP95Event;
    });
    [
      ["HAS P95 EVENT", hasP95],
      ["NO P95 EVENT", noP95],
    ].forEach(function (pair) {
      var items = pair[1];
      if (items.length === 0) {
        console.log("  " + pair[0].padEnd(16) + " n=0");
        return;
      }
      var lab = items.map(labelsFor);
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
          pair[0].padEnd(16) +
          " n=" +
          String(items.length).padEnd(4) +
          " +1U=" +
          pctOf(r1, items.length).padEnd(7) +
          " +2U=" +
          pctOf(r2, items.length).padEnd(7) +
          " +3U=" +
          pctOf(r3, items.length),
      );
    });
  });

  var outPath = path.join(
    OUTPUT_DIR,
    "cascade-outcomes-p95fixed-" + Date.now() + ".json",
  );
  fs.writeFileSync(outPath, JSON.stringify(updatedDataset, null, 2));
  console.log("\nP95-corrected dataset saved to: " + outPath);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
