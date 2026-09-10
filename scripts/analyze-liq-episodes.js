require("dotenv/config");
const { MongoClient } = require("mongodb");
const https = require("https");

const SYMBOL = process.argv[2] || "ETHUSDT";
const TOP_N = 10;
const WINDOW_MINUTES = 15; // T0 through T0+14, per the operator's own "10-15 minute" request
// Sep 10 2026 (Karo), operator-requested -- NOT a strategy threshold.
// This is ONLY the reporting cutoff for "another meaningful same-side
// burst" in the final PATTERN SUMMARY below, reusing the operator's
// OWN >20%-of-T0 bucket boundary from the prior liq_minute_aggregates-
// only analysis (never invented fresh here).
const MEANINGFUL_BURST_RATIO_PCT = 20;

function fmtTs(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function fmtUsd(n) {
  if (n === 0) return "0";
  return "$" + Math.round(n).toLocaleString("en-US");
}
function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
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
                `Failed to parse response from ${url}: ${data.slice(0, 200)}`,
              ),
            );
          }
        });
      })
      .on("error", reject);
  });
}

/** Public Binance USDS-M futures klines -- no API key needed for this
 *  endpoint. Returns raw arrays: [openTime, open, high, low, close, ...]. */
async function fetchKlines(symbol, startTime, endTime) {
  const base = process.env.BINANCE_REST_BASE_URL || "https://fapi.binance.com";
  const url = `${base}/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=${WINDOW_MINUTES + 2}`;
  const raw = await httpsGetJson(url);
  if (!Array.isArray(raw))
    throw new Error(
      `Unexpected klines response: ${JSON.stringify(raw).slice(0, 300)}`,
    );
  const byOpenTime = new Map();
  for (const k of raw) {
    byOpenTime.set(k[0], {
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    });
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
  const db = client.db(process.env.MONGO_SHARED_DB || "liqwatch_bot");
  const col = db.collection("liq_minute_aggregates");

  const allDocs = await col
    .find({ symbol: SYMBOL })
    .sort({ minuteStart: 1 })
    .toArray();
  const byMinute = new Map(allDocs.map((d) => [d.minuteStart, d]));

  const burstReturnedWithin = { "1m": 0, "2m": 0, "3m": 0, "5m": 0 };
  const newExtremeBeforeBurst = { count: 0, total: 0 };
  const alreadyRecoveredBeforeBurst = { count: 0, total: 0 };
  const minutesBetweenBursts = [];

  async function analyzeVictim(
    victimLabel,
    sumField,
    countField,
    maxField,
    isLongVictim,
  ) {
    console.log("\n" + "=".repeat(80));
    console.log(`${SYMBOL} ${victimLabel} episodes`);
    console.log("=".repeat(80));

    const candidates = allDocs
      .filter((d) => d[sumField] > 0)
      .map((d) => ({ minuteStart: d.minuteStart, total: d[sumField] }))
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_N);

    for (const c of candidates) {
      const windowStart = c.minuteStart;
      const windowEnd = c.minuteStart + (WINDOW_MINUTES - 1) * 60000;
      let klines;
      try {
        klines = await fetchKlines(SYMBOL, windowStart, windowEnd);
      } catch (err) {
        console.log(
          `\n--- T0=${fmtTs(c.minuteStart)} -- FAILED to fetch klines: ${err.message} ---`,
        );
        continue;
      }

      console.log(
        `\n--- T0 = ${fmtTs(c.minuteStart)}  (${victimLabel} total ${fmtUsd(c.total)}) ---`,
      );
      console.log(
        `${"minute".padEnd(20)} ${"LONG".padEnd(12)} ${"SHORT".padEnd(12)} ${"ratio".padEnd(8)} ${"cnt".padEnd(5)} ${"max".padEnd(10)} ${"open".padEnd(10)} ${"high".padEnd(10)} ${"low".padEnd(10)} ${"close".padEnd(10)} ${"dT0".padEnd(8)} extreme`,
      );

      let runningExtreme = null;
      let t0Open = null;
      let burstFoundAt = null;
      let extremeBeforeBurst = false;
      let recoveredBeforeBurst = false;

      for (let k = 0; k < WINDOW_MINUTES; k++) {
        const minuteStart = c.minuteStart + k * 60000;
        const doc = byMinute.get(minuteStart);
        const longAmt = doc ? doc.longSum : 0;
        const shortAmt = doc ? doc.shortSum : 0;
        const sameAmt = doc ? doc[sumField] : 0;
        const cnt = doc ? doc[countField] : 0;
        const max = doc ? doc[maxField] : 0;
        const ratioPct = c.total > 0 ? (sameAmt / c.total) * 100 : 0;

        const kl = klines.get(minuteStart);
        const open = kl ? kl.open : null;
        const high = kl ? kl.high : null;
        const low = kl ? kl.low : null;
        const close = kl ? kl.close : null;

        if (k === 0 && open !== null) t0Open = open;

        let isNewExtreme = false;
        if (kl) {
          if (isLongVictim) {
            if (runningExtreme === null || low < runningExtreme) {
              runningExtreme = low;
              isNewExtreme = true;
            }
          } else {
            if (runningExtreme === null || high > runningExtreme) {
              runningExtreme = high;
              isNewExtreme = true;
            }
          }
        }

        const deltaFromT0Pct =
          t0Open !== null && close !== null
            ? ((close - t0Open) / t0Open) * 100
            : null;

        console.log(
          `${fmtTs(minuteStart).padEnd(20)} ${fmtUsd(longAmt).padEnd(12)} ${fmtUsd(shortAmt).padEnd(12)} ${(ratioPct.toFixed(1) + "%").padEnd(8)} ${String(cnt).padEnd(5)} ${fmtUsd(max).padEnd(10)} ` +
            `${(open === null ? "n/a" : open).toString().padEnd(10)} ${(high === null ? "n/a" : high).toString().padEnd(10)} ${(low === null ? "n/a" : low).toString().padEnd(10)} ${(close === null ? "n/a" : close).toString().padEnd(10)} ` +
            `${deltaFromT0Pct !== null ? deltaFromT0Pct.toFixed(2) + "%" : "n/a"} ${k > 0 && isNewExtreme ? "YES" : ""}`,
        );

        if (
          k > 0 &&
          burstFoundAt === null &&
          ratioPct >= MEANINGFUL_BURST_RATIO_PCT
        ) {
          burstFoundAt = k;
          extremeBeforeBurst = isNewExtreme;
          if (t0Open !== null && close !== null) {
            recoveredBeforeBurst = isLongVictim
              ? close > t0Open
              : close < t0Open;
          }
        }
      }

      if (burstFoundAt !== null) {
        console.log(
          `  -> another same-side burst (>=${MEANINGFUL_BURST_RATIO_PCT}% of T0) returned at T+${burstFoundAt}m`,
        );
        console.log(
          `  -> price was still making a new extreme at that burst's own minute: ${extremeBeforeBurst ? "YES" : "NO"}`,
        );
        console.log(
          `  -> price had already crossed back past T0's own open by then: ${recoveredBeforeBurst ? "YES" : "NO"}`,
        );
        minutesBetweenBursts.push(burstFoundAt);
        for (const w of ["1m", "2m", "3m", "5m"]) {
          const wMin = parseInt(w);
          if (burstFoundAt <= wMin) burstReturnedWithin[w]++;
        }
        newExtremeBeforeBurst.total++;
        if (extremeBeforeBurst) newExtremeBeforeBurst.count++;
        alreadyRecoveredBeforeBurst.total++;
        if (recoveredBeforeBurst) alreadyRecoveredBeforeBurst.count++;
      } else {
        console.log(
          `  -> no same-side burst >=${MEANINGFUL_BURST_RATIO_PCT}% of T0 within the ${WINDOW_MINUTES - 1}-minute window`,
        );
      }
    }
  }

  await analyzeVictim("LONG", "longSum", "longCount", "longMax", true);
  await analyzeVictim("SHORT", "shortSum", "shortCount", "shortMax", false);

  console.log("\n" + "=".repeat(80));
  console.log(
    "PATTERN SUMMARY (across all analyzed episodes, both victim sides)",
  );
  console.log("=".repeat(80));
  const totalEpisodesWithBurst = minutesBetweenBursts.length;
  console.log(
    `Episodes where another same-side burst (>=${MEANINGFUL_BURST_RATIO_PCT}% of T0) returned at all: ${totalEpisodesWithBurst}`,
  );
  console.log(`  returned within 1m: ${burstReturnedWithin["1m"]}`);
  console.log(`  returned within 2m: ${burstReturnedWithin["2m"]}`);
  console.log(`  returned within 3m: ${burstReturnedWithin["3m"]}`);
  console.log(`  returned within 5m: ${burstReturnedWithin["5m"]}`);
  console.log(
    `  median minutes-between-bursts (when it returned): ${median(minutesBetweenBursts) === null ? "n/a" : median(minutesBetweenBursts)}`,
  );
  console.log(
    `New extreme still being made at the burst's own minute: ${newExtremeBeforeBurst.count}/${newExtremeBeforeBurst.total}`,
  );
  console.log(
    `Price already crossed back past T0's own open by the burst: ${alreadyRecoveredBeforeBurst.count}/${alreadyRecoveredBeforeBurst.total}`,
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
