/**
 * Sep 10 2026 (Karo), operator-requested post-close observation tool.
 * READ-ONLY -- reads researchCheckpoints from v5_global_signals, never
 * writes. This data was ALREADY being recorded for cascade signals
 * (registerWatch() call in handleCascadeSignalReady(), confirmed wired)
 * -- this script makes it genuinely USABLE for the exact analysis
 * questions the operator asked:
 *   - did price reverse after SL/TP?
 *   - would a WIDER SL have survived? (check mae at every offset --
 *     if it never exceeds -1.0R even at 60m, the SAME SL distance
 *     would have survived the whole observed window)
 *   - would a CLOSER TP have hit earlier? (check mfe -- if it reaches
 *     +1.0R well before the actual +2.33R TP, a tighter TP would have
 *     closed sooner)
 *
 * Checkpoints are anchored to ENTRY (not close) with offsets up to
 * 60 minutes -- for this bot's own fast SL=0.30%/TP=0.70% profile,
 * the LATER offsets (5m/15m/30m/60m) almost always represent genuine
 * observation AFTER the real trade already closed at TP or SL, since
 * the checkpoint tracker has no knowledge of trade-close at all and
 * keeps recording on the SAME fixed schedule regardless -- this is
 * exactly the "independent research observer" the operator asked for:
 * it NEVER feeds back into any live signal decision.
 *
 * Usage:
 *   npx tsx scripts/show-observation.ts --signalId <signalId>
 *   npx tsx scripts/show-observation.ts --symbol XRPUSDT --latest
 */
import "dotenv/config";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import type { GlobalSignalDoc } from "../src/domain/signal/global-signal.model";

function buildMongo(): MongoClientWrapper {
  const cfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  return new MongoClientWrapper(cfg);
}

function fmtTs(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  return new Date(n).toISOString().replace("T", " ").slice(0, 23) + "Z";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getFlag = (name: string): string | null => {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1]! : null;
  };
  const signalIdArg = getFlag("--signalId");
  const symbolArg = getFlag("--symbol");
  const latest = args.includes("--latest");

  const mongo = buildMongo();
  const col = await mongo.globalSignals();
  if (!col) {
    console.error(
      !((process.env.MONGO_URI ?? "").length > 0)
        ? "MONGO_URI not set in .env."
        : "Mongo is configured but the connection FAILED (network/auth/URI).",
    );
    process.exit(1);
  }

  let doc: GlobalSignalDoc | null = null;
  if (signalIdArg) {
    doc = (await col.findOne({
      signalId: signalIdArg,
    })) as GlobalSignalDoc | null;
  } else if (symbolArg && latest) {
    doc = (await col
      .find({ symbol: symbolArg.toUpperCase(), timeframe: { $ne: null } })
      .sort({ signalTs: -1 })
      .limit(1)
      .next()) as GlobalSignalDoc | null;
  } else {
    console.error(
      "Usage:\n  npx tsx scripts/show-observation.ts --signalId <signalId>\n  npx tsx scripts/show-observation.ts --symbol XRPUSDT --latest",
    );
    process.exit(1);
  }

  if (!doc) {
    console.log("No matching signal found.");
    await mongo.close();
    return;
  }

  console.log("=".repeat(60));
  console.log("SIGNAL");
  console.log("=".repeat(60));
  console.log(`signalId:   ${doc.signalId}`);
  console.log(`cascadeId:  ${doc.cascadeId ?? "n/a"}`);
  console.log(`timeframe:  ${doc.timeframe ?? "n/a (legacy)"}`);
  console.log(`symbol:     ${doc.symbol} ${doc.side}`);
  console.log(`entry:      ${doc.entry}`);
  console.log(`SL:         ${doc.sl}`);
  console.log(`TP:         ${doc.tp}`);
  console.log(`status:     ${doc.status}`);
  console.log(`closePrice: ${doc.closePrice ?? "n/a (still open, or legacy)"}`);
  console.log(`closedAt:   ${fmtTs(doc.closedAt)}`);
  console.log("");

  const group = (doc.researchCheckpoints ?? []).find(
    (g) => g.anchorType === "SIGNAL",
  );
  if (!group || group.checkpoints.length === 0) {
    console.log(
      "No post-entry observation checkpoints recorded yet (they fire progressively -- 30s/1m/5m/15m/60m after entry; check back later, or this signal is too recent).",
    );
    await mongo.close();
    return;
  }

  console.log("-".repeat(60));
  console.log(
    "POST-ENTRY OBSERVATION (R-normalized to the SL distance -- independent of live decisions, NEVER affects execution)",
  );
  console.log("-".repeat(60));
  console.log(
    `${"offset".padEnd(6)} ${"price".padEnd(14)} ${"MFE (R)".padEnd(10)} ${"MAE (R)".padEnd(10)}  note`,
  );
  for (const cp of group.checkpoints) {
    const wouldSurviveTighterSl =
      cp.mae > -1.0
        ? "SL never exceeded (even a TIGHTER SL up to this point would have held)"
        : "";
    const wouldHitCloserTp =
      cp.mfe >= 1.0
        ? "a TP as close as +1.0R would already have hit by here"
        : "";
    const note = wouldHitCloserTp || wouldSurviveTighterSl;
    console.log(
      `${cp.offsetLabel.padEnd(6)} ${String(cp.price).padEnd(14)} ${cp.mfe.toFixed(2).padEnd(10)} ${cp.mae.toFixed(2).padEnd(10)}  ${note}`,
    );
  }
  console.log("");
  console.log("Reading guide:");
  console.log(
    "  MFE = best favorable excursion so far, in units of the SL distance (e.g. 1.0 = moved as far as the real SL distance, in the WINNING direction)",
  );
  console.log(
    "  MAE = worst adverse excursion so far, in the SAME units, negative = against the position",
  );
  console.log(
    `  actual RR was ${doc.rr ?? "n/a"} -- TP sits at +${doc.rr ?? "?"}R`,
  );

  console.log("=".repeat(60));
  await mongo.close();
}

main().catch((err) => {
  console.error("show-observation failed:", err);
  process.exit(1);
});
