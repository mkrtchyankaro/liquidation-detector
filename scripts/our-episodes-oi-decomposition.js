// FOUR EXACT EPISODES -- OI USD CHANGE DECOMPOSITION (contract effect
// vs BTC price effect). Historical MongoDB only, no live connections.
// Same 4 episodes, unchanged.
//
// METHODOLOGY NOTE (read before trusting the reconciliation number):
// To split OI USD change into a contract-count effect and a price
// effect, we need an independent PRICE at the start and end OI
// observations -- independent of the stored openInterestUsd value
// itself, or the "reconciliation error" would be zero by algebraic
// construction, not because the two stored fields are genuinely
// compatible. This script FIRST checks whether oi_second_observations
// stores its own price field (price / markPrice / indexPrice). If
// yes, that price is used (a genuine, independent check). If NO such
// field exists, price is DERIVED as openInterestUsd / openInterest --
// in that case the script says so explicitly, and the reconciliation
// error will be ~0 BY DEFINITION, not as evidence of compatibility.
//
//   node scripts/four-episodes-oi-decomposition.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const EPISODES = [
  {
    num: 31,
    startMs: Date.parse("2026-09-20T02:24:27.128Z"),
    endMs: Date.parse("2026-09-20T02:36:15.129Z"),
  },
  {
    num: 32,
    startMs: Date.parse("2026-09-20T02:39:21.185Z"),
    endMs: Date.parse("2026-09-20T02:45:58.188Z"),
  },
  {
    num: 33,
    startMs: Date.parse("2026-09-20T02:54:09.182Z"),
    endMs: Date.parse("2026-09-20T03:02:37.147Z"),
  },
  {
    num: 34,
    startMs: Date.parse("2026-09-20T03:14:42.177Z"),
    endMs: Date.parse("2026-09-20T03:16:19.199Z"),
  },
];
const PRICE_FIELD_CANDIDATES = ["price", "markPrice", "indexPrice", "btcPrice"];

function fmtUsd(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  if (abs >= 1_000_000_000)
    return `${sign}$${(abs / 1_000_000_000).toFixed(3)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}
function fmtUsdPlain(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(3)}B`;
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  return `$${abs.toFixed(2)}`;
}
function fmtBtc(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} BTC`;
}
function fmtBtcDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} BTC`;
}
function fmtPrice(n) {
  return n === null || n === undefined
    ? "N/A"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPriceDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  // --- Detect whether an independent price field exists on oi_second_observations ---
  const sampleOiDoc = await oiCol.findOne(
    { symbol: SYMBOL, timestamp: { $lte: new Date(EPISODES[0].startMs) } },
    { sort: { timestamp: -1 } },
  );
  const foundPriceField = sampleOiDoc
    ? PRICE_FIELD_CANDIDATES.find((f) => sampleOiDoc[f] !== undefined)
    : null;

  console.log("=".repeat(80));
  console.log("OI USD DECOMPOSITION -- CONTRACT EFFECT vs BTC PRICE EFFECT");
  console.log("=".repeat(80));
  if (foundPriceField) {
    console.log(
      `\nIndependent price field found on oi_second_observations: "${foundPriceField}" -- using it (genuine check).`,
    );
  } else {
    console.log(
      `\nNO independent price field found on oi_second_observations.`,
    );
    console.log(
      `Price will be DERIVED as openInterestUsd / openInterest for each observation.`,
    );
    console.log(
      `==> In this mode, RECONCILIATION ERROR will be ~0 BY DEFINITION -- it does NOT`,
    );
    console.log(
      `    prove the two stored fields (openInterest, openInterestUsd) are independently`,
    );
    console.log(
      `    compatible, only that division and multiplication are inverse operations.`,
    );
  }

  async function oiObservationAtOrBefore(targetMs) {
    const doc = await oiCol
      .find({ symbol: SYMBOL, timestamp: { $lte: new Date(targetMs) } })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    if (!doc) return null;
    const contracts = doc.openInterest;
    const usd = doc.openInterestUsd;
    let price;
    if (foundPriceField) price = doc[foundPriceField];
    else
      price =
        contracts && usd !== undefined && contracts !== 0
          ? usd / contracts
          : null;
    return { contracts, usd, price };
  }

  const summaryRows = [];

  for (const ep of EPISODES) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`EPISODE ${ep.num}`);
    console.log("=".repeat(80));

    const events = await liqCol
      .find({ symbol: SYMBOL, timestamp: { $gte: ep.startMs, $lte: ep.endMs } })
      .project({ quoteQty: 1, timestamp: 1 })
      .sort({ timestamp: 1 })
      .toArray();
    const totalLiq = events.reduce((a, e) => a + (e.quoteQty ?? 0), 0);

    const startObs = await oiObservationAtOrBefore(ep.startMs);
    const endObs = await oiObservationAtOrBefore(ep.endMs);

    if (
      !startObs ||
      !endObs ||
      startObs.contracts === undefined ||
      endObs.contracts === undefined ||
      startObs.price === null ||
      endObs.price === null
    ) {
      console.log(
        "Insufficient OI data (missing contracts/usd/price at start or end) -- cannot decompose. Skipping.",
      );
      continue;
    }

    const contractChange = endObs.contracts - startObs.contracts;
    const priceChange = endObs.price - startObs.price;

    const startOiUsdComputed = startObs.contracts * startObs.price;
    const endOiUsdComputed = endObs.contracts * endObs.price;
    const totalOiUsdChange = endOiUsdComputed - startOiUsdComputed;

    const contractEffectUsd = contractChange * startObs.price;
    const priceEffectUsd = endObs.contracts * priceChange;
    const reconstructedChange = contractEffectUsd + priceEffectUsd;
    const reconciliationError = totalOiUsdChange - reconstructedChange;

    console.log("");
    console.log(`Liquidations:             ${fmtUsdPlain(totalLiq)}`);
    console.log("");
    console.log(`Start OI contracts:       ${fmtBtc(startObs.contracts)}`);
    console.log(`End OI contracts:         ${fmtBtc(endObs.contracts)}`);
    console.log(`Contract change:          ${fmtBtcDelta(contractChange)}`);
    console.log("");
    console.log(`Start BTC price:          ${fmtPrice(startObs.price)}`);
    console.log(`End BTC price:            ${fmtPrice(endObs.price)}`);
    console.log(`BTC price change:         ${fmtPriceDelta(priceChange)}`);
    console.log("");
    console.log(
      `Start OI USD:             ${fmtUsdPlain(startOiUsdComputed)}  (stored openInterestUsd: ${fmtUsdPlain(startObs.usd)})`,
    );
    console.log(
      `End OI USD:               ${fmtUsdPlain(endOiUsdComputed)}  (stored openInterestUsd: ${fmtUsdPlain(endObs.usd)})`,
    );
    console.log("-".repeat(42));
    console.log(`REAL CONTRACT EFFECT:     ${fmtUsd(contractEffectUsd)}`);
    console.log(`BTC PRICE EFFECT:         ${fmtUsd(priceEffectUsd)}`);
    console.log("-".repeat(42));
    console.log(`TOTAL OI USD CHANGE:      ${fmtUsd(totalOiUsdChange)}`);
    console.log(`RECONSTRUCTED CHANGE:     ${fmtUsd(reconstructedChange)}`);
    console.log(
      `RECONCILIATION ERROR:     ${fmtUsdPlain(reconciliationError)}`,
    );
    console.log("-".repeat(42));
    console.log("");
    console.log(
      `"Of the ${fmtUsd(totalOiUsdChange)} OI USD change, approximately ${fmtUsd(contractEffectUsd)} came from actual OI contract`,
    );
    console.log(
      `change and ${fmtUsd(priceEffectUsd)} came from BTC price movement."`,
    );
    console.log("");
    console.log(
      "Note: this does NOT indicate whether contracts closed were longs or shorts, and does NOT",
    );
    console.log(
      "equate any of this with the observed liquidation USD above -- those are different measurements.",
    );

    summaryRows.push({
      num: ep.num,
      totalLiq,
      contractChange,
      contractEffectUsd,
      priceEffectUsd,
      totalOiUsdChange,
    });
  }

  console.log(`\n${"=".repeat(110)}`);
  console.log(
    "EPISODE | LIQ USD    | CONTRACT Δ BTC     | CONTRACT EFFECT USD | PRICE EFFECT USD | TOTAL OI USD Δ",
  );
  console.log("-".repeat(110));
  for (const r of summaryRows) {
    console.log(
      `${String(r.num).padEnd(7)} | ${fmtUsdPlain(r.totalLiq).padEnd(10)} | ${fmtBtcDelta(r.contractChange).padEnd(18)} | ${fmtUsd(r.contractEffectUsd).padEnd(20)} | ${fmtUsd(r.priceEffectUsd).padEnd(17)} | ${fmtUsd(r.totalOiUsdChange)}`,
    );
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
