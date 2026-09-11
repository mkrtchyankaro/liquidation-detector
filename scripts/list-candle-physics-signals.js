require("dotenv/config");
const { MongoClient } = require("mongodb");

function fmtTs(ms) {
  return ms
    ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z"
    : "n/a";
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const symbolIdx = args.indexOf("--symbol");
  const symbolFilter =
    symbolIdx !== -1 ? args[symbolIdx + 1].toUpperCase() : null;
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 20;

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  const col = db.collection("v5_global_signals");

  const filter = { cascadeId: null, timeframe: "1m" };
  if (symbolFilter) filter.symbol = symbolFilter;

  const docs = await col
    .find(filter)
    .sort({ signalTs: -1 })
    .limit(limit)
    .toArray();
  console.log(
    "Found " +
      docs.length +
      " candle-physics-engine signal(s)" +
      (symbolFilter ? " for " + symbolFilter : "") +
      " (most recent " +
      limit +
      "):\n",
  );

  docs.forEach((d) => {
    console.log("=".repeat(90));
    console.log("signalId: " + d.signalId);
    console.log(d.symbol + " " + d.victim + "  status=" + d.status);
    console.log("signalTs: " + fmtTs(d.signalTs));
    console.log(
      "entry=" + d.entry + "  sl=" + d.sl + "  tp=" + d.tp + "  rr=" + d.rr,
    );
    if (d.status !== "SIGNAL") {
      console.log(
        "closedAt: " +
          fmtTs(d.closedAt) +
          "  closePrice=" +
          d.closePrice +
          "  maxFavorableR=" +
          d.maxFavorableR +
          "  maxAdverseR=" +
          d.maxAdverseR,
      );
    }
    console.log("waves (" + d.waveHistory.length + "):");
    d.waveHistory.forEach((w) => {
      console.log(
        "  W" +
          w.waveNumber +
          " (" +
          w.state +
          "): anchor=" +
          w.anchorPrice.toFixed(6) +
          "@" +
          fmtTs(w.anchorTs) +
          " extreme=" +
          w.extremePrice.toFixed(6) +
          "@" +
          fmtTs(w.extremeTs) +
          " liqUsd=" +
          w.liqNotionalUsd.toFixed(2) +
          " events=" +
          w.liqEvents +
          " efficiency=" +
          (w.priceEfficiency !== null ? w.priceEfficiency.toFixed(2) : "n/a"),
      );
    });
    console.log(
      "dominant: W" +
        d.dominantLayerWaveNumber +
        " ($" +
        d.dominantLayerLiqUsd.toFixed(0) +
        ")  ->  signal/exhaustion: W" +
        d.exhaustionLayerWaveNumber +
        " ($" +
        d.exhaustionLayerLiqUsd.toFixed(0) +
        ")",
    );
    console.log("");
  });

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
