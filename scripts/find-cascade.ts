/**
 * Sep 10 2026 (Karo), operator-requested observability tool for the
 * production V5 multi-timeframe cascade lifecycle. READ-ONLY --
 * exactly one Mongo find() against v5_active_cascades, never a write.
 * Purpose: find one or more cascades when the cascadeId is not known,
 * so it can be copied and passed to show-cascade.ts.
 *
 * Usage:
 *   npx tsx scripts/find-cascade.ts --symbol BTCUSDT --latest
 *   npx tsx scripts/find-cascade.ts --symbol XRPUSDT --victim LONG --from "2026-09-10 10:00" --to "2026-09-10 14:00"
 *   npx tsx scripts/find-cascade.ts --signalId <signalId>
 *   npx tsx scripts/find-cascade.ts --status ACTIVE --limit 10
 */
import "dotenv/config";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import type { CascadeDoc } from "../src/domain/cascade/cascade.model";

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

function candidateLine(label: "1m" | "3m" | "5m", doc: CascadeDoc): string {
  const c = doc.candidates[label];
  if (c.phase === "NOT_STARTED")
    return `${label}: not started (readiness gate never satisfied)`;
  if (c.phase === "TERMINAL_SIGNAL")
    return `${label}: SIGNAL${c.signalId ? ` (${c.signalId})` : ""}`;
  if (c.phase === "TERMINAL_CANCEL")
    return `${label}: CANCEL (${c.terminalReasonText ?? c.terminalReason ?? "structural"})`;
  // ACTIVE
  return `${label}: WAITING_W${c.currentWaveNumber ?? "?"}`;
}

function parseDateArg(raw: string): number | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw)
    ? raw.replace(" ", "T") + "Z"
    : raw;
  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function printCascadeBlock(doc: CascadeDoc): void {
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
  console.log(`  ${candidateLine("1m", doc)}`);
  console.log(`  ${candidateLine("3m", doc)}`);
  console.log(`  ${candidateLine("5m", doc)}`);
  const signalIds = (["1m", "3m", "5m"] as const)
    .map((tf) => doc.candidates[tf].signalId)
    .filter((id): id is string => id !== null);
  if (signalIds.length > 0) {
    console.log("");
    console.log(`  signalIds: ${signalIds.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const filtered = args.filter((a) => a !== "--json");

  const getFlag = (name: string): string | null => {
    const idx = filtered.indexOf(name);
    return idx !== -1 && filtered[idx + 1] !== undefined
      ? filtered[idx + 1]!
      : null;
  };

  const symbolArg = getFlag("--symbol");
  const victimArg = getFlag("--victim");
  const statusArg = getFlag("--status");
  const fromArg = getFlag("--from");
  const toArg = getFlag("--to");
  const signalIdArg = getFlag("--signalId");
  const limitArg = getFlag("--limit");
  const latest = filtered.includes("--latest");
  const limit = limitArg
    ? Math.max(1, parseInt(limitArg, 10) || 20)
    : latest
      ? 1
      : 20;

  const mongo = buildMongo();
  const col = await mongo.activeCascades();
  if (!col) {
    console.error(
      !((process.env.MONGO_URI ?? "").length > 0)
        ? "MONGO_URI not set in .env -- .env wasn't found or is missing MONGO_URI, NOT that zero cascades exist."
        : "Mongo is configured but the connection FAILED (network/auth/URI) -- check MONGO_URI and connectivity.",
    );
    process.exit(1);
  }

  const query: Record<string, unknown> = {};
  if (symbolArg) query.symbol = symbolArg.toUpperCase();
  if (victimArg) query.victimSide = victimArg.toUpperCase();
  if (statusArg) query.status = statusArg.toUpperCase();
  if (fromArg || toArg) {
    const range: Record<string, number> = {};
    if (fromArg) {
      const ts = parseDateArg(fromArg);
      if (ts === null) {
        console.error(
          `Could not parse --from value "${fromArg}". Expected e.g. "2026-09-10 10:00".`,
        );
        process.exit(1);
      }
      range.$gte = ts;
    }
    if (toArg) {
      const ts = parseDateArg(toArg);
      if (ts === null) {
        console.error(
          `Could not parse --to value "${toArg}". Expected e.g. "2026-09-10 14:00".`,
        );
        process.exit(1);
      }
      range.$lte = ts;
    }
    query.startedAt = range;
  }
  if (signalIdArg) {
    query.$or = [
      { "candidates.1m.signalId": signalIdArg },
      { "candidates.3m.signalId": signalIdArg },
      { "candidates.5m.signalId": signalIdArg },
    ];
  }

  const results =
    ((await col
      .find(query)
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray()) as unknown as CascadeDoc[]) ?? [];

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
    await mongo.close();
    return;
  }

  if (results.length === 0) {
    console.log("No matching cascades.");
    await mongo.close();
    return;
  }

  console.log(
    `${results.length} cascade${results.length === 1 ? "" : "s"} found\n`,
  );
  for (const doc of results) printCascadeBlock(doc);
  console.log("=".repeat(60));

  await mongo.close();
}

main().catch((err) => {
  console.error("find-cascade failed:", err);
  process.exit(1);
});
