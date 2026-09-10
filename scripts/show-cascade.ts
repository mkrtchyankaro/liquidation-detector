/**
 * Sep 10 2026 (Karo), operator-requested observability tool for the
 * production V5 multi-timeframe cascade lifecycle. READ-ONLY -- reads
 * from v5_active_cascades (and v5_global_signals, ONLY to look up a
 * signaled candidate's own entry/TP/SL by signalId), never writes to
 * either.
 *
 * Usage:
 *   npx tsx scripts/show-cascade.ts --id <cascadeId>
 *   npx tsx scripts/show-cascade.ts --signalId <signalId>
 *   npx tsx scripts/show-cascade.ts --symbol BTCUSDT --latest
 */
import "dotenv/config";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import type {
  CascadeDoc,
  CascadeCandidateStateDoc,
} from "../src/domain/cascade/cascade.model";
import type { CascadeWaveState } from "../src/domain/cascade/cascade-candidate.service";
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

function fmtDur(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}min`;
  return `${(m / 60).toFixed(2)}h`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function printWave(w: CascadeWaveState): void {
  console.log(`    Wave ${w.waveNumber} (${w.state})`);
  console.log(
    `      Liquidation total: ${fmtUsd(w.liqUsd)}  (${w.liqEvents} events)`,
  );
  console.log(
    `      Anchor:            ${w.anchorPrice} @ ${fmtTs(w.anchorTs)}`,
  );
  console.log(
    `      Extreme:           ${w.extremePrice} @ ${fmtTs(w.extremeTs)}`,
  );
  console.log(
    `      Start/End:         ${fmtTs(w.anchorTs)} / ${w.state === "COMPLETED" ? fmtTs(w.extremeTs) : "n/a (still ACTIVE)"}`,
  );
}

async function printCandidate(
  label: "1m" | "3m" | "5m",
  c: CascadeCandidateStateDoc,
  victim: "LONG" | "SHORT",
  globalCol: Awaited<ReturnType<MongoClientWrapper["globalSignals"]>>,
): Promise<void> {
  console.log("-".repeat(60));
  console.log(`${label} candidate`);
  console.log("-".repeat(60));
  console.log(`  timeframe:   ${c.timeframe}`);
  console.log(`  status:      ${c.phase}`);
  console.log(`  signalId:    ${c.signalId ?? "n/a"}`);
  console.log(`  wave count:  ${c.waveHistory.length}`);
  console.log(`  frozenUnit:  ${c.frozenUnitAbs ?? "n/a"}`);
  console.log("");

  if (c.phase === "NOT_STARTED") {
    console.log(
      "  (readiness gate never satisfied for this timeframe -- no waves recorded)",
    );
    console.log("");
    return;
  }

  if (c.phase === "ACTIVE") {
    const lastWave = c.waveHistory[c.waveHistory.length - 1];
    if (lastWave) {
      const unitAbs = c.frozenUnitAbs ?? 0;
      if (lastWave.state === "ACTIVE") {
        const target =
          victim === "LONG"
            ? lastWave.extremePrice + unitAbs
            : lastWave.extremePrice - unitAbs;
        console.log(
          `  Current wave (${lastWave.waveNumber}) still ACTIVE -- waiting for 1x UNIT recovery`,
        );
        console.log(`    current extreme: ${lastWave.extremePrice}`);
        console.log(`    target price:    ${target}  (1x UNIT away)`);
      } else {
        const cancelTarget =
          victim === "LONG"
            ? lastWave.extremePrice + 2 * unitAbs
            : lastWave.extremePrice - 2 * unitAbs;
        console.log(`  WAITING_W${lastWave.waveNumber + 1}`);
        console.log(
          `    previous wave (W${lastWave.waveNumber}) liq: ${fmtUsd(lastWave.liqUsd)}`,
        );
        console.log(
          `    structural cancel target: ${cancelTarget}  (2x UNIT from W${lastWave.waveNumber}'s own extreme, if no next wave arrives)`,
        );
      }
    }
    console.log("");
  }

  if (c.phase === "TERMINAL_CANCEL") {
    console.log(
      `  CANCEL reason: ${c.terminalReason ?? "n/a"}${c.terminalReasonText ? ` (${c.terminalReasonText})` : ""}`,
    );
    if (c.cancelPrice !== null) {
      console.log(
        `    waveExtreme=${c.currentExtreme}  frozenUnit=${c.frozenUnitAbs}  cancelPrice=${c.cancelPrice}`,
      );
      console.log(
        `    recoveryDistance=${c.recoveryDistance}  recoveryUnits=${c.recoveryUnits?.toFixed(3)}`,
      );
    }
    console.log("");
  }

  if (c.phase === "TERMINAL_SIGNAL" && c.signalId) {
    if (globalCol) {
      const signalDoc = (await globalCol.findOne({
        signalId: c.signalId,
      })) as GlobalSignalDoc | null;
      if (signalDoc) {
        console.log(`  signalId: ${signalDoc.signalId}`);
        console.log(`  entry:    ${signalDoc.entry ?? "n/a"}`);
        console.log(`  TP:       ${signalDoc.tp ?? "n/a"}`);
        console.log(`  SL:       ${signalDoc.sl ?? "n/a"}`);
        console.log(`  status:   ${signalDoc.status}`);
      } else {
        console.log(
          `  signalId: ${c.signalId}  (no matching v5_global_signals document found)`,
        );
      }
    }
    console.log("");
  }

  if (c.waveHistory.length > 0) {
    console.log("  Completed wave history:");
    c.waveHistory.forEach(printWave);
    console.log("");
  }
}

async function resolveCascadeDoc(
  cascadeCol: Awaited<ReturnType<MongoClientWrapper["activeCascades"]>>,
  args: string[],
): Promise<CascadeDoc | null> {
  const getFlag = (name: string): string | null => {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1]! : null;
  };
  if (!cascadeCol) return null;

  const idArg = getFlag("--id");
  if (idArg)
    return (await cascadeCol.findOne({
      cascadeId: idArg,
    })) as CascadeDoc | null;

  const signalIdArg = getFlag("--signalId");
  if (signalIdArg) {
    return (await cascadeCol.findOne({
      $or: [
        { "candidates.1m.signalId": signalIdArg },
        { "candidates.3m.signalId": signalIdArg },
        { "candidates.5m.signalId": signalIdArg },
      ],
    })) as CascadeDoc | null;
  }

  const symbolArg = getFlag("--symbol");
  if (symbolArg && args.includes("--latest")) {
    return (await cascadeCol
      .find({ symbol: symbolArg.toUpperCase() })
      .sort({ startedAt: -1 })
      .limit(1)
      .next()) as CascadeDoc | null;
  }

  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const filtered = args.filter((a) => a !== "--json");

  if (filtered.length === 0) {
    console.error(
      "Usage:\n" +
        "  npx tsx scripts/show-cascade.ts --id <cascadeId>\n" +
        "  npx tsx scripts/show-cascade.ts --signalId <signalId>\n" +
        "  npx tsx scripts/show-cascade.ts --symbol BTCUSDT --latest",
    );
    process.exit(1);
  }

  const mongo = buildMongo();
  const cascadeCol = await mongo.activeCascades();
  const globalCol = await mongo.globalSignals();
  if (!cascadeCol) {
    console.error(
      !((process.env.MONGO_URI ?? "").length > 0)
        ? "MONGO_URI not set in .env -- .env wasn't found or is missing MONGO_URI, NOT that zero cascades exist."
        : "Mongo is configured but the connection FAILED (network/auth/URI) -- check MONGO_URI and connectivity.",
    );
    process.exit(1);
  }

  const doc = await resolveCascadeDoc(cascadeCol, filtered);
  if (!doc) {
    console.log("No matching cascade found.");
    await mongo.close();
    return;
  }

  if (jsonMode) {
    console.log(JSON.stringify(doc, null, 2));
    await mongo.close();
    return;
  }

  console.log("=".repeat(60));
  console.log("CASCADE");
  console.log("=".repeat(60));
  console.log(`cascadeId:  ${doc.cascadeId}`);
  console.log(`symbol:     ${doc.symbol}`);
  console.log(`victim:     ${doc.victimSide}`);
  console.log(`status:     ${doc.status}`);
  console.log(`startedAt:  ${fmtTs(doc.startedAt)}`);
  console.log(`closedAt:   ${fmtTs(doc.closedAt)}`);
  console.log(
    `duration:   ${doc.closedAt !== null ? fmtDur(doc.closedAt - doc.startedAt) : fmtDur(Date.now() - doc.startedAt) + " (still active)"}`,
  );
  console.log("");

  await printCandidate("1m", doc.candidates["1m"], doc.victimSide, globalCol);
  await printCandidate("3m", doc.candidates["3m"], doc.victimSide, globalCol);
  await printCandidate("5m", doc.candidates["5m"], doc.victimSide, globalCol);

  console.log("=".repeat(60));

  await mongo.close();
}

main().catch((err) => {
  console.error("show-cascade failed:", err);
  process.exit(1);
});
