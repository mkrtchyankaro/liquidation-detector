/**
 * Sep 10 2026 (Karo), operator-requested. READ-ONLY classification of
 * every status="SIGNAL" record in v5_global_signals -- never modifies
 * or deletes anything. Buckets each into a precise category so a
 * manual, informed cleanup decision can be made before live testing
 * (per the operator's own explicit "do not blindly delete" instruction).
 *
 * Categories:
 *   LIKELY_STILL_OPEN        -- recent (< maxAgeMinutes), isMainExecuted
 *                                true or legacy (cascadeId===null) --
 *                                plausibly a genuinely active trade.
 *   COMPARISON_ONLY          -- isMainExecuted===false (a cascade
 *                                candidate that was correctly never
 *                                installed as a real trade) -- SAFE to
 *                                leave as-is (historical comparison
 *                                data), never was "stuck".
 *   STALE_UNTAGGED_CASCADE   -- cascadeId set, isMainExecuted undefined
 *                                (predates that field), AND older than
 *                                maxAgeMinutes -- exactly the class of
 *                                record the DOGE-type bug produced.
 *                                Ambiguous whether it was ever really
 *                                executed; needs a manual decision.
 *   VERY_OLD_LEGACY          -- cascadeId===null (the old, non-cascade
 *                                V5 path) and older than maxAgeMinutes
 *                                -- almost certainly should have closed
 *                                by now; likely orphaned from before
 *                                onPriceTickForTrades()/mainSymbolLocks
 *                                wiring was correct.
 *   MALFORMED                -- missing entry/tp/sl entirely -- cannot
 *                                ever have been trackable.
 *   DUPLICATE_SYMBOL_MAIN    -- multiple isMainExecuted===true (or
 *                                untagged) docs for the SAME symbol --
 *                                structurally impossible under the
 *                                current invariant (max 1 real MAIN
 *                                position per symbol); a sure sign of
 *                                stale/duplicate state.
 *
 * Usage:
 *   npx tsx scripts/classify-stale-signals.ts [--max-age-minutes 60]
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

function fmtTs(n: number): string {
  return new Date(n).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--max-age-minutes");
  const maxAgeMinutes =
    idx !== -1 && args[idx + 1] ? parseInt(args[idx + 1]!, 10) : 60;
  const maxAgeMs = maxAgeMinutes * 60_000;
  const now = Date.now();

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

  const docs = (await col
    .find({ status: "SIGNAL" })
    .toArray()) as unknown as GlobalSignalDoc[];
  console.log(`Total status="SIGNAL" records: ${docs.length}\n`);

  const buckets: Record<string, GlobalSignalDoc[]> = {
    LIKELY_STILL_OPEN: [],
    COMPARISON_ONLY: [],
    STALE_UNTAGGED_CASCADE: [],
    VERY_OLD_LEGACY: [],
    MALFORMED: [],
  };

  const bySymbol = new Map<string, GlobalSignalDoc[]>();

  for (const doc of docs) {
    const ageMs = now - doc.signalTs;
    const isOld = ageMs > maxAgeMs;

    if (doc.entry === null || doc.tp === null || doc.sl === null) {
      buckets.MALFORMED!.push(doc);
      continue;
    }

    if (doc.isMainExecuted === false) {
      buckets.COMPARISON_ONLY!.push(doc);
      continue;
    }

    const isCascade = doc.cascadeId !== null;
    if (isCascade && doc.isMainExecuted === undefined && isOld) {
      buckets.STALE_UNTAGGED_CASCADE!.push(doc);
    } else if (!isCascade && isOld) {
      buckets.VERY_OLD_LEGACY!.push(doc);
    } else {
      buckets.LIKELY_STILL_OPEN!.push(doc);
      const arr = bySymbol.get(doc.symbol) ?? [];
      arr.push(doc);
      bySymbol.set(doc.symbol, arr);
    }
  }

  // Detect duplicate-per-symbol among the "likely still open" bucket --
  // structurally impossible under the current invariant.
  const duplicates: GlobalSignalDoc[] = [];
  for (const [symbol, arr] of bySymbol) {
    if (arr.length > 1) {
      console.log(
        `\u26A0 DUPLICATE_SYMBOL_MAIN: ${symbol} has ${arr.length} "likely still open" records simultaneously (violates max-1-per-symbol)`,
      );
      duplicates.push(...arr);
    }
  }

  for (const [label, arr] of Object.entries(buckets)) {
    console.log(`\n${label}: ${arr.length}`);
    for (const d of arr) {
      const ageMin = Math.round((now - d.signalTs) / 60_000);
      console.log(
        `  ${d.signalId} ${d.symbol} ${d.side} tf=${d.timeframe ?? "legacy"} cascadeId=${d.cascadeId ?? "n/a"} isMainExecuted=${d.isMainExecuted ?? "undefined"} age=${ageMin}min signalTs=${fmtTs(d.signalTs)}`,
      );
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(
    `LIKELY_STILL_OPEN:      ${buckets.LIKELY_STILL_OPEN!.length}  (leave alone -- plausibly real, active trades)`,
  );
  console.log(
    `COMPARISON_ONLY:        ${buckets.COMPARISON_ONLY!.length}  (leave alone -- correctly never executed, historical data)`,
  );
  console.log(
    `STALE_UNTAGGED_CASCADE: ${buckets.STALE_UNTAGGED_CASCADE!.length}  (MANUAL DECISION NEEDED -- ambiguous, predates isMainExecuted)`,
  );
  console.log(
    `VERY_OLD_LEGACY:        ${buckets.VERY_OLD_LEGACY!.length}  (MANUAL DECISION NEEDED -- almost certainly should have closed)`,
  );
  console.log(
    `MALFORMED:              ${buckets.MALFORMED!.length}  (safe to mark CLOSED/investigate -- never trackable)`,
  );
  console.log(
    `DUPLICATE_SYMBOL_MAIN:  ${duplicates.length}  (MANUAL DECISION NEEDED -- structurally impossible, investigate which is real)`,
  );
  console.log(
    "\nThis script made NO changes. Review the categories above, then decide per-category how to proceed.",
  );

  await mongo.close();
}

main().catch((err) => {
  console.error("classify-stale-signals failed:", err);
  process.exit(1);
});
