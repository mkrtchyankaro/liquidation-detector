require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = process.argv[2] || "ETHUSDT";
const TOP_N = 10;

function fmtTs(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function fmtUsd(n) {
  return "$" + Math.round(n).toLocaleString("en-US");
}
function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
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

  // Pull the FULL history for this symbol once, sorted by minuteStart --
  // we need consecutive-minute lookups anyway, so one range-scan is more
  // efficient than N individual queries per T+k.
  const allDocs = await col
    .find({ symbol: SYMBOL })
    .sort({ minuteStart: 1 })
    .toArray();
  console.log(`Total minute-documents for ${SYMBOL}: ${allDocs.length}`);
  if (allDocs.length === 0) {
    console.log("No data found -- nothing to analyze.");
    await client.close();
    return;
  }
  console.log(
    `Range: ${fmtTs(allDocs[0].minuteStart)} .. ${fmtTs(allDocs[allDocs.length - 1].minuteStart)}\n`,
  );

  // Index by minuteStart for O(1) consecutive-minute lookups.
  const byMinute = new Map(allDocs.map((d) => [d.minuteStart, d]));

  function analyzeVictim(victimLabel, sumField, countField, maxField) {
    console.log("=".repeat(70));
    console.log(`${SYMBOL} ${victimLabel}`);
    console.log("=".repeat(70));

    const candidates = allDocs
      .filter((d) => d[sumField] > 0)
      .map((d) => ({
        minuteStart: d.minuteStart,
        total: d[sumField],
        count: d[countField],
        max: d[maxField],
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_N);

    if (candidates.length === 0) {
      console.log("No liquidation minutes found for this victim side.\n");
      return { ratios1: [], ratios2: [], ratios3: [] };
    }

    const ratios1 = [];
    const ratios2 = [];
    const ratios3 = [];
    let t1Zero = 0;
    let t1Under5 = 0;
    let t1Between5And20 = 0;
    let t1Over20 = 0;

    for (const c of candidates) {
      console.log("-".repeat(70));
      console.log(
        `T0    ${fmtTs(c.minuteStart)}   ${fmtUsd(c.total)}   events=${c.count}  max=${fmtUsd(c.max)}`,
      );

      for (let k = 1; k <= 5; k++) {
        const minuteStart = c.minuteStart + k * 60_000;
        const doc = byMinute.get(minuteStart);
        const total = doc ? doc[sumField] : 0;
        const longAmt = doc ? doc.longSum : 0;
        const shortAmt = doc ? doc.shortSum : 0;
        const ratioPct = c.total > 0 ? (total / c.total) * 100 : 0;

        console.log(
          `+${k}m   ${fmtTs(minuteStart)}   ${total === 0 ? "0" : fmtUsd(total)}   ${ratioPct.toFixed(1)}%` +
            `   (LONG=${fmtUsd(longAmt)} SHORT=${fmtUsd(shortAmt)})`,
        );

        if (k === 1) {
          ratios1.push(ratioPct);
          if (total === 0) t1Zero++;
          else if (ratioPct < 5) t1Under5++;
          else if (ratioPct <= 20) t1Between5And20++;
          else t1Over20++;
        }
        if (k === 2) ratios2.push(ratioPct);
        if (k === 3) ratios3.push(ratioPct);
      }
    }

    console.log(`\n${victimLabel} SUMMARY (n=${candidates.length}):`);
    console.log(
      `  median T+1/T0 ratio: ${median(ratios1)?.toFixed(1) ?? "n/a"}%`,
    );
    console.log(
      `  median T+2/T0 ratio: ${median(ratios2)?.toFixed(1) ?? "n/a"}%`,
    );
    console.log(
      `  median T+3/T0 ratio: ${median(ratios3)?.toFixed(1) ?? "n/a"}%`,
    );
    console.log(`  T+1 was zero:        ${t1Zero}/${candidates.length}`);
    console.log(`  T+1 was <5%:         ${t1Under5}/${candidates.length}`);
    console.log(
      `  T+1 was 5-20%:       ${t1Between5And20}/${candidates.length}`,
    );
    console.log(`  T+1 was >20%:        ${t1Over20}/${candidates.length}`);
    console.log("");

    return { ratios1, ratios2, ratios3 };
  }

  analyzeVictim("LONG", "longSum", "longCount", "longMax");
  analyzeVictim("SHORT", "shortSum", "shortCount", "shortMax");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
