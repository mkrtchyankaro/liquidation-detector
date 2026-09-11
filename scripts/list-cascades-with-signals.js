require("dotenv/config");
const { MongoClient } = require("mongodb");

function fmtTs(ms) {
  if (!ms) return "n/a";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

async function main() {
  var uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }

  var args = process.argv.slice(2);
  var symbolFilter = null;
  var idx = args.indexOf("--symbol");
  if (idx !== -1 && args[idx + 1]) symbolFilter = args[idx + 1].toUpperCase();
  var limit = 50;
  var limIdx = args.indexOf("--limit");
  if (limIdx !== -1 && args[limIdx + 1]) limit = parseInt(args[limIdx + 1], 10);

  var client = new MongoClient(uri);
  await client.connect();
  var db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  var cascadeCol = db.collection("v5_active_cascades");
  var signalCol = db.collection("v5_global_signals");

  var cascadeFilter = symbolFilter ? { symbol: symbolFilter } : {};
  var cascades = await cascadeCol
    .find(cascadeFilter)
    .sort({ startedAt: -1 })
    .limit(limit)
    .toArray();

  console.log(
    "Found " +
      cascades.length +
      " cascade(s)" +
      (symbolFilter ? " for " + symbolFilter : "") +
      " (most recent " +
      limit +
      "):\n",
  );

  for (var i = 0; i < cascades.length; i++) {
    var casc = cascades[i];
    console.log("=".repeat(80));
    console.log("cascade {");
    console.log("  cascadeId:  " + casc.cascadeId);
    console.log("  symbol:     " + casc.symbol);
    console.log("  victim:     " + casc.victimSide);
    console.log("  status:     " + casc.status);
    console.log("  startedAt:  " + fmtTs(casc.startedAt));
    console.log("  closedAt:   " + fmtTs(casc.closedAt));

    var signalIds = [];
    ["1m", "3m", "5m"].forEach(function (tf) {
      var cand = casc.candidates ? casc.candidates[tf] : null;
      if (!cand) return;
      if (cand.signalId) signalIds.push(cand.signalId);
    });

    var signals =
      signalIds.length > 0
        ? await signalCol.find({ signalId: { $in: signalIds } }).toArray()
        : [];
    var signalsById = {};
    signals.forEach(function (s) {
      signalsById[s.signalId] = s;
    });

    console.log("\n  signals history [");
    ["1m", "3m", "5m"].forEach(function (tf) {
      var cand = casc.candidates ? casc.candidates[tf] : null;
      if (!cand || cand.phase === "NOT_STARTED") {
        console.log("    " + tf + ": (not started)");
        return;
      }
      if (cand.phase === "ACTIVE") {
        console.log(
          "    " +
            tf +
            ": ACTIVE (wave " +
            cand.currentWaveNumber +
            ", still tracking)",
        );
        return;
      }
      if (cand.phase === "TERMINAL_CANCEL") {
        console.log("    " + tf + ": {");
        console.log("      status:          CANCEL");
        console.log("      terminalReason:  " + cand.terminalReason);
        console.log(
          "      terminalReasonText: " + (cand.terminalReasonText || "n/a"),
        );
        console.log("      terminalAt:      " + fmtTs(cand.terminalAt));
        console.log("      frozenUnit:      " + cand.frozenUnitAbs);
        console.log("      cancelPrice:     " + cand.cancelPrice);
        console.log("      recoveryUnits:   " + cand.recoveryUnits);
        console.log("    }");
        return;
      }
      if (cand.phase === "TERMINAL_SIGNAL") {
        var sig = signalsById[cand.signalId];
        console.log("    " + tf + ": {");
        console.log("      signalId:    " + cand.signalId);
        if (sig) {
          console.log("      status:      " + sig.status);
          console.log("      isMainExecuted: " + sig.isMainExecuted);
          console.log("      entry:       " + sig.entry);
          console.log("      tp:          " + sig.tp);
          console.log("      sl:          " + sig.sl);
          console.log("      rr:          " + sig.rr);
          console.log("      signalTs:    " + fmtTs(sig.signalTs));
          if (sig.status === "CLOSED_TP" || sig.status === "CLOSED_SL") {
            console.log("      closePrice:  " + sig.closePrice);
            console.log("      closedAt:    " + fmtTs(sig.closedAt));
          }
        } else {
          console.log("      (signal document not found in v5_global_signals)");
        }
        console.log("    }");
      }
    });
    console.log("  ]");
    console.log("}\n");
  }

  await client.close();
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
