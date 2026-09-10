/**
 * Sep 10 2026 (Karo), operator-requested READ-ONLY monitoring script
 * for the LIVE common-horizon-4h-v1 research experiment (REPLACES the
 * earlier ATR(14)-based dragon competition report -- reads
 * commonHorizonResearch, NOT unitCompetitionResearch, so old and new
 * data are never mixed in this report).
 *
 * READ-ONLY GUARANTEE: this file contains exactly ONE Mongo operation
 * -- a single .find() query, no options beyond sort/limit. There is no
 * updateOne/insertOne/deleteOne/$set/$push/upsert anywhere in this
 * file, and no import of any repository class that could perform one.
 * It has zero influence on production or research state -- it only
 * ever reads what market-data-orchestrator.ts's own common-horizon
 * research code has already, independently written.
 *
 * Schema traced from the REAL, current source (not guessed):
 *   - Collection: v5_global_signals, in the "own" database
 *     (mongo.client.ts's own globalSignals(), dbs.own.collection(...))
 *   - Field shape: GlobalSignalDoc.commonHorizonResearch (global-
 *     signal.model.ts) -- { version, atr1m, atr3m, atr5m,
 *     winnerCandidate, winnerEntryTs, winnerResult }, each candidate a
 *     CommonHorizonCandidateDoc | null (a UNIFIED shape covering both
 *     an in-progress phase-snapshot and a terminal result).
 */
import { MongoClient } from "mongodb";
import type {
  GlobalSignalDoc,
  CommonHorizonCandidateDoc,
} from "../src/domain/signal/global-signal.model";

require("dotenv").config();

interface Args {
  limit: number;
  symbol: string | null;
  state: "PASS" | "FAIL_NO_VALID_RR" | "STRUCTURAL_CANCEL" | "TRACKING" | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 20, symbol: null, state: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit" && argv[i + 1])
      args.limit = Math.max(1, parseInt(argv[++i]!, 10) || 20);
    else if (argv[i] === "--symbol" && argv[i + 1])
      args.symbol = argv[++i]!.toUpperCase();
    else if (argv[i] === "--state" && argv[i + 1])
      args.state = argv[++i] as Args["state"];
  }
  return args;
}

function fmtPct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(3)}%`;
}

function fmtUsd(v: number | null): string {
  if (v === null) return "n/a";
  return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "n/a";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Sep 10 2026 (Karo) -- defensive against the known, accepted
 *  upsert-race limitation documented on GlobalSignalRepository's own
 *  setCommonHorizonCandidate()/setCommonHorizonWinner(): a shadow
 *  candidate's own snapshot/result can be persisted (upsert:true)
 *  BEFORE production's own main signal doc exists yet, producing a
 *  genuinely PARTIAL document missing signalTs/symbol/side entirely.
 *  This report must display such episodes usefully, never crash. */
function safeIsoTime(ts: number | undefined | null): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0)
    return "unknown time";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function fmtW(
  w: {
    anchorPrice: number;
    extremePrice: number;
    liqUsd: number;
    liqEvents: number;
  } | null,
): string {
  if (!w) return "n/a";
  return `anchor=${w.anchorPrice} extreme=${w.extremePrice} liq=${fmtUsd(w.liqUsd)} (${w.liqEvents} events)`;
}

function candidateLines(
  label: string,
  c: CommonHorizonCandidateDoc | null,
  isWinner: boolean,
): string[] {
  const lines: string[] = [];
  if (!c) {
    lines.push(`${label} \u23F3 TRACKING`);
    lines.push(
      `    (no snapshot persisted yet -- candidate just started, or still warming up)`,
    );
    return lines;
  }

  if (c.state === "TRACKING") {
    lines.push(`${label} \u23F3 TRACKING`);
  } else if (c.state === "PASS") {
    lines.push(
      `${label} ${isWinner ? "\u{1F3C6} PASS / WINNER" : "\u2705 PASS"}`,
    );
  } else if (c.state === "FAIL_NO_VALID_RR") {
    lines.push(`${label} \u274C FAIL_NO_VALID_RR`);
  } else {
    lines.push(`${label} \u26A0\uFE0F STRUCTURAL_CANCEL`);
  }

  lines.push(`    Episode start: ${safeIsoTime(c.episodeStartTs)}`);
  lines.push(`    ATR period: ${c.atrPeriod}`);
  lines.push(`    ATR frozen abs: ${c.frozenUnitAbs}`);
  lines.push(`    ATR frozen %: ${fmtPct(c.frozenAtrPct)}`);

  if (c.state === "TRACKING") {
    lines.push(`    Phase: ${c.phase ?? "unknown"}`);
    lines.push(`    W1: ${fmtW(c.w1)}`);
    lines.push(`    W2: ${fmtW(c.w2)}`);
    lines.push(`    Current price: ${c.currentPrice ?? "n/a"}`);
    lines.push(
      `    Next structural target: ${c.nextTargetPrice ?? "n/a"}${c.nextTargetDescription ? ` (${c.nextTargetDescription})` : ""}`,
    );
    if (c.lastUpdatedTs !== null)
      lines.push(`    Last updated: ${safeIsoTime(c.lastUpdatedTs)}`);
    return lines;
  }

  // Terminal states -- exact reason + relevant structural level.
  lines.push(`    Terminal reason: ${c.terminalReason ?? "n/a"}`);
  lines.push(`    W1: ${fmtW(c.w1)}`);
  lines.push(`    W2: ${fmtW(c.w2)}`);
  if (c.state === "STRUCTURAL_CANCEL") return lines;

  // FAIL_NO_VALID_RR or PASS -- both reached the Dragon.
  lines.push(`    Duration: ${fmtDuration(c.durationMs)}`);
  lines.push(
    `    Liq: ${fmtUsd(c.episodeLiqUsdAtEntry)} | Baseline: ${c.liqBaselineAtEntry !== null ? fmtUsd(c.liqBaselineAtEntry) + "/min" : "n/a"}`,
  );
  lines.push(`    TP: ${fmtPct(c.rawTpPct)}`);
  if (c.rrAttempts.length > 0) {
    const attemptsStr = c.rrAttempts
      .map((a) => `${a.rr}\u2192${fmtPct(a.slPct)}${a.valid ? "*" : ""}`)
      .join(", ");
    lines.push(`    RR attempts: ${attemptsStr}  (* = valid)`);
  }
  if (c.state === "PASS") {
    lines.push(`    RR: ${c.selectedRR} | SL: ${fmtPct(c.rawSlPct)}`);
    if (c.hypotheticalEntry !== null)
      lines.push(`    Entry: ${c.hypotheticalEntry}`);
    const last = c.checkpoints[c.checkpoints.length - 1];
    if (last) {
      const sign = (v: number) => (v >= 0 ? "+" : "");
      lines.push(
        `    MFE: ${sign(last.mfe)}${last.mfe.toFixed(2)}${last.normalization} | MAE: ${sign(last.mae)}${last.mae.toFixed(2)}${last.normalization}  (as of ${last.offsetLabel})`,
      );
    } else {
      lines.push(`    MFE/MAE: no checkpoints recorded yet`);
    }
  }
  return lines;
}

function candidateState(
  c: CommonHorizonCandidateDoc | null,
): "PASS" | "FAIL_NO_VALID_RR" | "STRUCTURAL_CANCEL" | "TRACKING" {
  return c ? c.state : "TRACKING";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set in the environment.");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
    const col = db.collection<GlobalSignalDoc>("v5_global_signals");

    const query: Record<string, unknown> = {
      commonHorizonResearch: { $ne: null },
    };
    if (args.symbol) query.symbol = args.symbol;

    // READ-ONLY: exactly one find(), sorted/limited -- no writes anywhere in this file.
    const docs = await col
      .find(query)
      .sort({ signalTs: -1 })
      .limit(args.limit)
      .toArray();

    const filtered = args.state
      ? docs.filter((d) => {
          const ch = d.commonHorizonResearch!;
          return (
            candidateState(ch.atr1m) === args.state ||
            candidateState(ch.atr3m) === args.state ||
            candidateState(ch.atr5m) === args.state
          );
        })
      : docs;

    if (filtered.length === 0) {
      console.log("No episodes found matching the given filters.");
      await client.close();
      return;
    }

    const summary = {
      atr1m: {
        PASS: 0,
        FAIL_NO_VALID_RR: 0,
        STRUCTURAL_CANCEL: 0,
        TRACKING: 0,
      },
      atr3m: {
        PASS: 0,
        FAIL_NO_VALID_RR: 0,
        STRUCTURAL_CANCEL: 0,
        TRACKING: 0,
      },
      atr5m: {
        PASS: 0,
        FAIL_NO_VALID_RR: 0,
        STRUCTURAL_CANCEL: 0,
        TRACKING: 0,
      },
    };
    const winnerCounts = { atr1m: 0, atr3m: 0, atr5m: 0 };
    const outcomeCounts = { TP: 0, SL: 0, OPEN: 0 };

    for (const doc of filtered) {
      const ch = doc.commonHorizonResearch!;
      console.log("=".repeat(60));
      console.log(
        `${doc.symbol ?? "UNKNOWN_SYMBOL"} ${doc.side ?? "?"} | ${safeIsoTime(doc.signalTs)}  [${ch.version}]`,
      );
      console.log(`Episode: ${doc.signalId}`);
      console.log("");

      for (const [label, key] of [
        ["1m", "atr1m"],
        ["3m", "atr3m"],
        ["5m", "atr5m"],
      ] as const) {
        const candidate = ch[key];
        const isWinner = ch.winnerCandidate === key;
        for (const line of candidateLines(label, candidate, isWinner))
          console.log(line);
        console.log("");
        summary[key][candidateState(candidate)]++;
      }

      if (ch.winnerCandidate) {
        winnerCounts[ch.winnerCandidate]++;
        console.log(`Winner: ${ch.winnerCandidate.replace("atr", "ATR")}`);
        if (ch.winnerResult) {
          console.log(`Winner result: ${ch.winnerResult}`);
          outcomeCounts[ch.winnerResult]++;
        } else {
          console.log(`Winner result: OPEN (still tracking)`);
          outcomeCounts.OPEN++;
        }
      } else {
        console.log(`Winner: none yet`);
      }
      console.log("=".repeat(60));
      console.log("");
    }

    console.log(`Episodes: ${filtered.length}`);
    console.log("");
    for (const [label, key] of [
      ["ATR1m", "atr1m"],
      ["ATR3m", "atr3m"],
      ["ATR5m", "atr5m"],
    ] as const) {
      const s = summary[key];
      const parts = [
        `PASS ${s.PASS}`,
        `FAIL ${s.FAIL_NO_VALID_RR}`,
        `CANCEL ${s.STRUCTURAL_CANCEL}`,
      ];
      if (s.TRACKING > 0) parts.push(`TRACKING ${s.TRACKING}`);
      console.log(`${label}: ${parts.join(" | ")}`);
    }
    console.log("");
    console.log("Winners:");
    console.log(`  1m: ${winnerCounts.atr1m}`);
    console.log(`  3m: ${winnerCounts.atr3m}`);
    console.log(`  5m: ${winnerCounts.atr5m}`);
    console.log("");
    console.log("Winner outcomes:");
    console.log(`  TP: ${outcomeCounts.TP}`);
    console.log(`  SL: ${outcomeCounts.SL}`);
    console.log(`  OPEN: ${outcomeCounts.OPEN}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
