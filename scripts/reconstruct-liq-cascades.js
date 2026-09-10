require("dotenv/config");
const { MongoClient } = require("mongodb");
const https = require("https");

const SYMBOL = process.argv[2] || "ETHUSDT";
const KLINE_CHUNK = 1500;

function fmtTs(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function fmtUsd(n) {
  if (n === 0) return "$0";
  return "$" + Math.round(n).toLocaleString("en-US");
}
function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function avg(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function percentile(arr, p) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
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
            reject(
              new Error(
                "Failed to parse response from " +
                  url +
                  ": " +
                  data.slice(0, 200),
              ),
            );
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
  while (cursor <= endTime) {
    const chunkEnd = Math.min(cursor + (KLINE_CHUNK - 1) * 60000, endTime);
    const url =
      base +
      "/fapi/v1/klines?symbol=" +
      symbol +
      "&interval=1m&startTime=" +
      cursor +
      "&endTime=" +
      chunkEnd +
      "&limit=" +
      KLINE_CHUNK;
    const raw = await httpsGetJson(url);
    if (!Array.isArray(raw))
      throw new Error(
        "Unexpected klines response: " + JSON.stringify(raw).slice(0, 300),
      );
    for (const k of raw) {
      byOpenTime.set(k[0], {
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
      });
    }
    if (raw.length === 0) {
      cursor = chunkEnd + 60000;
    } else {
      cursor = raw[raw.length - 1][0] + 60000;
    }
    if (cursor <= startTime) break;
  }
  return byOpenTime;
}

function reconstructCascades(
  sortedMinuteStarts,
  byMinute,
  sumField,
  countField,
  maxField,
) {
  const cascades = [];
  let current = null;

  for (const minuteStart of sortedMinuteStarts) {
    const doc = byMinute.get(minuteStart);
    const amt = doc ? doc[sumField] : 0;

    if (amt > 0) {
      if (!current) {
        current = { startMinute: minuteStart, minutes: [] };
      }
      current.minutes.push({
        minuteStart: minuteStart,
        amt: amt,
        count: doc ? doc[countField] : 0,
        max: doc ? doc[maxField] : 0,
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

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_SHARED_DB || "liqwatch_bot");
  const col = db.collection("liq_minute_aggregates");

  const allDocs = await col
    .find({ symbol: SYMBOL })
    .sort({ minuteStart: 1 })
    .toArray();
  if (allDocs.length === 0) {
    console.log("No data found.");
    await client.close();
    return;
  }
  const byMinute = new Map(allDocs.map((d) => [d.minuteStart, d]));

  const rangeStart = allDocs[0].minuteStart;
  const rangeEnd = allDocs[allDocs.length - 1].minuteStart;
  const sortedMinuteStarts = [];
  for (let t = rangeStart; t <= rangeEnd; t += 60000)
    sortedMinuteStarts.push(t);
  console.log(
    SYMBOL +
      ": " +
      sortedMinuteStarts.length +
      " total calendar minutes in range " +
      fmtTs(rangeStart) +
      " .. " +
      fmtTs(rangeEnd) +
      " (gaps filled with 0)\n",
  );

  console.log("Fetching price klines for the full range (chunked)...");
  const klines = await fetchKlinesRange(SYMBOL, rangeStart, rangeEnd);
  console.log("Fetched " + klines.size + " price candles.\n");

  function reportSide(label, sumField, countField, maxField) {
    const cascades = reconstructCascades(
      sortedMinuteStarts,
      byMinute,
      sumField,
      countField,
      maxField,
    );
    console.log("=".repeat(80));
    console.log(
      SYMBOL + " " + label + " CASCADES -- reconstructed: " + cascades.length,
    );
    console.log("=".repeat(80));

    const durations = cascades.map((c) => c.minutes.length);
    const totals = cascades.map((c) =>
      c.minutes.reduce((s, m) => s + m.amt, 0),
    );

    console.log("\nAll cascades (compact):");
    for (const c of cascades) {
      const total = c.minutes.reduce((s, m) => s + m.amt, 0);
      console.log(
        "  " +
          fmtTs(c.startMinute) +
          " -> " +
          (c.endMinute ? fmtTs(c.endMinute) : "(history ends, still open)") +
          "   duration=" +
          c.minutes.length +
          "m   total=" +
          fmtUsd(total),
      );
    }

    console.log("\n" + label + " DISTRIBUTION (n=" + cascades.length + "):");
    console.log("  median duration: " + median(durations) + " minutes");
    var avgDur = avg(durations);
    console.log(
      "  average duration: " +
        (avgDur === null ? "n/a" : avgDur.toFixed(2)) +
        " minutes",
    );
    var p75 = percentile(durations, 75);
    var p90 = percentile(durations, 90);
    console.log(
      "  p75 duration: " + (p75 === null ? "n/a" : p75.toFixed(1)) + " minutes",
    );
    console.log(
      "  p90 duration: " + (p90 === null ? "n/a" : p90.toFixed(1)) + " minutes",
    );
    console.log(
      "  max duration: " + Math.max.apply(null, durations) + " minutes",
    );
    console.log("  median total liquidation: " + fmtUsd(median(totals)));

    function printDetailed(c, tag) {
      const total = c.minutes.reduce((s, m) => s + m.amt, 0);
      const peak = c.minutes.reduce(
        (best, m) => (m.amt > best.amt ? m : best),
        c.minutes[0],
      );
      console.log(
        "\n--- " +
          tag +
          ": " +
          fmtTs(c.startMinute) +
          " -> " +
          (c.endMinute ? fmtTs(c.endMinute) : "(open)") +
          " ---",
      );
      const beforeDoc = byMinute.get(c.startMinute - 60000);
      console.log(
        "before: " +
          fmtTs(c.startMinute - 60000) +
          "  " +
          label +
          " = " +
          fmtUsd(beforeDoc ? beforeDoc[sumField] : 0),
      );
      console.log("");
      for (const m of c.minutes) {
        const kl = klines.get(m.minuteStart);
        console.log(
          "  " +
            fmtTs(m.minuteStart) +
            "  " +
            label +
            " " +
            fmtUsd(m.amt).padEnd(12) +
            " events=" +
            String(m.count).padEnd(4) +
            " max=" +
            fmtUsd(m.max).padEnd(12) +
            " open=" +
            (kl ? kl.open : "n/a") +
            " high=" +
            (kl ? kl.high : "n/a") +
            " low=" +
            (kl ? kl.low : "n/a") +
            " close=" +
            (kl ? kl.close : "n/a"),
        );
      }
      if (c.endMinute)
        console.log(
          "  " +
            fmtTs(c.endMinute) +
            "  " +
            label +
            " = $0  <- cascade finished",
        );
      console.log("\n  duration = " + c.minutes.length + " active minutes");
      console.log("  total = " + fmtUsd(total));
      console.log(
        "  peak minute = " +
          fmtTs(peak.minuteStart) +
          " (" +
          fmtUsd(peak.amt) +
          ")",
      );
    }

    const sortedByDuration = [...cascades].sort(
      (a, b) => a.minutes.length - b.minutes.length,
    );
    const sortedByTotal = [...cascades].sort(
      (a, b) =>
        b.minutes.reduce((s, m) => s + m.amt, 0) -
        a.minutes.reduce((s, m) => s + m.amt, 0),
    );

    const oneMin = sortedByDuration.find((c) => c.minutes.length === 1);
    const twoMin = sortedByDuration.find((c) => c.minutes.length === 2);
    const threeToFive = sortedByDuration.find(
      (c) => c.minutes.length >= 3 && c.minutes.length <= 5,
    );
    const longest = sortedByDuration[sortedByDuration.length - 1];
    const largest = sortedByTotal[0];

    console.log("\n" + "-".repeat(80));
    console.log("REPRESENTATIVE EXAMPLES");
    console.log("-".repeat(80));
    if (oneMin) printDetailed(oneMin, "1-minute cascade");
    if (twoMin) printDetailed(twoMin, "2-minute cascade");
    if (threeToFive) printDetailed(threeToFive, "3-5 minute cascade");
    if (longest)
      printDetailed(
        longest,
        "longest cascade (" + longest.minutes.length + "m)",
      );
    if (largest && largest !== longest)
      printDetailed(largest, "largest-total-liquidation cascade");

    console.log("\n");
  }

  reportSide("LONG", "longSum", "longCount", "longMax");
  reportSide("SHORT", "shortSum", "shortCount", "shortMax");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
