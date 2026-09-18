import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Sep 18 2026 (Karo), operator-requested diagnostic tool.
 *
 * READ ONLY -- parses pm2's own log files for this app
 * (LOG_DIR/liquidation-detector-out*.log, rotated files included),
 * extracts every LOX forensic event ({"mod":"lox-forensic",...}), and
 * reconstructs a human-readable episode timeline. No Mongo access, no
 * writes anywhere -- confirmed structurally: this file contains no
 * MongoClientWrapper import at all.
 *
 * Two modes:
 *
 *   npx tsx scripts/lox-episode-timeline.ts SYMBOLUSDT [episodeId]
 *     Full chronological timeline for one symbol (optionally one
 *     specific episode), every EPISODE_START/WATCH_EVALUATION/
 *     EXTREME_UPDATE/STATE_TRANSITION/ENTRY_GATE_EVALUATION/
 *     ENTRY_READY/EPISODE_TERMINAL event, in order.
 *
 *   npx tsx scripts/lox-episode-timeline.ts --list [SYMBOLUSDT]
 *     One row per episode that reached WAIT_FOR_POST_EPISODE_OI_CREATION
 *     and was then cancelled -- episodeId, symbol, UTC start, UTC
 *     cancel time, and the exact cancel reasonCode -- so you can pick
 *     an episodeId/time and re-run the detailed mode above on it.
 *
 * Limitation, stated plainly: this reads whatever pm2-logrotate has
 * not yet rotated away. For a durable, log-rotation-proof history, a
 * dedicated Mongo collection (discussed separately) would be needed --
 * this tool is the log-based stopgap for right now.
 */

interface ForensicLine {
  mod?: string;
  symbol?: string;
  episodeId?: string;
  ts?: number;
  type?: string;
  [key: string]: unknown;
}

const LOG_DIR =
  process.env.PM2_LOG_DIR ?? path.join(os.homedir(), ".pm2", "logs");

function readAllForensicLines(): ForensicLine[] {
  if (!fs.existsSync(LOG_DIR)) {
    console.error(
      `Log directory not found: ${LOG_DIR} (set PM2_LOG_DIR if pm2 logs live elsewhere)`,
    );
    process.exit(1);
  }
  const files = fs
    .readdirSync(LOG_DIR)
    .filter(
      (f) => f.startsWith("liquidation-detector-out") && f.endsWith(".log"),
    )
    .map((f) => path.join(LOG_DIR, f));
  if (files.length === 0) {
    console.error(`No liquidation-detector-out*.log files found in ${LOG_DIR}`);
    process.exit(1);
  }

  const out: ForensicLine[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8").split("\n");
    for (const line of raw) {
      if (!line.includes("lox-forensic")) continue;
      const jsonStart = line.indexOf("{");
      if (jsonStart === -1) continue;
      try {
        const parsed = JSON.parse(line.slice(jsonStart)) as ForensicLine;
        if (parsed.mod === "lox-forensic") out.push(parsed);
      } catch {
        // partial/truncated JSON line -- skip
      }
    }
  }
  return out;
}

function fmtTime(ts: number | undefined): string {
  if (ts === undefined) return "?";
  return new Date(ts).toISOString().replace("T", " ").replace("Z", " UTC");
}

function fmtTimeShort(ts: number | undefined): string {
  if (ts === undefined) return "?";
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function fmtUsd(n: unknown): string {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "n/a";
  return `$${v.toFixed(0)}`;
}

function runTimeline(symbol: string, episodeIdFilter: string | null): void {
  const events = readAllForensicLines()
    .filter((e) => e.symbol === symbol)
    .filter((e) => episodeIdFilter === null || e.episodeId === episodeIdFilter)
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  if (events.length === 0) {
    console.log(
      `Ոչինչ չգտնվեց ${symbol}-ի համար${episodeIdFilter ? ` (episodeId=${episodeIdFilter})` : ""}: հնարավոր է log-երը rotate են եղել։`,
    );
    return;
  }

  const byEpisode = new Map<string, ForensicLine[]>();
  for (const e of events) {
    const key = e.episodeId ?? "(unknown)";
    if (!byEpisode.has(key)) byEpisode.set(key, []);
    byEpisode.get(key)!.push(e);
  }

  for (const [episodeId, evs] of byEpisode) {
    console.log(`\n${"=".repeat(72)}`);
    console.log(`EPISODE: ${episodeId}  (${symbol})`);
    console.log("=".repeat(72));

    let liqCount = 0;
    let lastLiqTotal: unknown = null;

    for (const e of evs) {
      const t = fmtTime(e.ts);
      switch (e.type) {
        case "EPISODE_START":
          console.log(
            `[${t}] \u{1F7E2} EPISODE_START  victim=${e.victim}  startPrice=${e.startPrice}  startingOi=${e.startingOi}`,
          );
          break;
        case "LIQ_ACCUMULATED":
          liqCount++;
          lastLiqTotal = e.newTotal;
          if (liqCount % 5 === 1) {
            console.log(
              `[${t}]   \u21B3 LIQ_ACCUMULATED  total=${fmtUsd(e.newTotal)}  (+${fmtUsd(e.eventUsd)})`,
            );
          }
          break;
        case "EXTREME_UPDATE":
          if (e.meaningfulExtremeProgress) {
            console.log(
              `[${t}]   \u21B3 EXTREME_UPDATE  ${e.previousExtreme} \u2192 ${e.newExtreme}`,
            );
          }
          break;
        case "WATCH_EVALUATION":
          console.log(
            `[${t}] \u{1F441} WATCH_EVALUATION  result=${e.result}${e.reasonCode ? `  reason=${e.reasonCode}` : ""}  percentileRank=${Number(e.percentileRank).toFixed(1)} (\u057A\u0561\u0570\u0561\u0576\u057B\u057E\u0578\u0582\u0574 \u0567 ${e.requiredPercentile})`,
          );
          break;
        case "STATE_TRANSITION":
          console.log(
            `[${t}] \u{1F500} STATE_TRANSITION  ${e.from} \u2192 ${e.to}${e.reason ? `   (${e.reason})` : ""}`,
          );
          break;
        case "ENTRY_GATE_EVALUATION": {
          const blockedBy = Array.isArray(e.blockedBy)
            ? (e.blockedBy as string[]).join(", ")
            : "\u2014";
          console.log(
            `[${t}] \u{1F6AA} ENTRY_GATE_EVALUATION  final=${e.final}  blockedBy=[${blockedBy}]`,
          );
          const counterMove = e.counterMove as { detail?: string } | undefined;
          if (counterMove?.detail)
            console.log(`             detail: ${counterMove.detail}`);
          break;
        }
        case "ENTRY_READY":
          console.log(
            `[${t}] \u2705 ENTRY_READY  entryPrice=${e.entryReferencePrice}  extreme=${e.extreme}  counterMoveAtr=${e.counterMoveAtr}`,
          );
          break;
        case "EPISODE_TERMINAL":
          console.log(
            `[${t}] \u26D4 EPISODE_TERMINAL (cancel)  reason=${e.reason}`,
          );
          console.log(`             detail: ${e.detail}`);
          console.log(
            `             lifetimeMs=${e.lifetimeMs}  finalTotalLiqUsd=${fmtUsd(e.finalTotalLiqUsd)}  symbolReleased=${e.symbolReleased}`,
          );
          break;
        case "RESTART_RECONCILIATION":
          console.log(
            `[${t}] \u{1F504} RESTART_RECONCILIATION  outcome=${e.outcome}  ${e.detail ?? ""}`,
          );
          break;
        default:
          console.log(`[${t}] (${e.type})`);
      }
    }
    if (liqCount > 0)
      console.log(
        `   ... \u0568\u0576\u0564\u0561\u0574\u0565\u0576\u0568 ${liqCount} liquidation event, \u057E\u0565\u0580\u057B\u0576\u0561\u056F\u0561\u0576 total=${fmtUsd(lastLiqTotal)}`,
      );
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(
    `\u0538\u0576\u0564\u0561\u0574\u0565\u0576\u0568 ${events.length} forensic event, ${byEpisode.size} episode(\u0576\u0565\u0580) \u0563\u057F\u0576\u057E\u0565\u0581 ${symbol}-\u056B \u0570\u0561\u0574\u0561\u0580.`,
  );
}

interface EpisodeListRow {
  episodeId: string;
  symbol: string;
  startTs: number | null;
  reachedWaitTs: number | null;
  cancelTs: number | null;
  cancelReason: string | null;
  cancelDetail: string | null;
}

function runList(symbolFilter: string | null): void {
  const all = readAllForensicLines().filter(
    (e) => symbolFilter === null || e.symbol === symbolFilter,
  );
  const byEpisode = new Map<string, ForensicLine[]>();
  for (const e of all) {
    const key = e.episodeId ?? "(unknown)";
    if (!byEpisode.has(key)) byEpisode.set(key, []);
    byEpisode.get(key)!.push(e);
  }

  const rows: EpisodeListRow[] = [];
  for (const [episodeId, evs] of byEpisode) {
    evs.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const start = evs.find((e) => e.type === "EPISODE_START");
    const reachedWait = evs.find(
      (e) =>
        e.type === "STATE_TRANSITION" &&
        e.to === "WAIT_FOR_POST_EPISODE_OI_CREATION",
    );
    const terminal = evs.find((e) => e.type === "EPISODE_TERMINAL");
    // Only list episodes that reached WAIT and were then cancelled --
    // exactly what the operator asked for.
    if (!reachedWait || !terminal) continue;
    rows.push({
      episodeId,
      symbol: (start?.symbol ?? evs[0]?.symbol ?? "?") as string,
      startTs: (start?.ts as number) ?? null,
      reachedWaitTs: (reachedWait.ts as number) ?? null,
      cancelTs: (terminal.ts as number) ?? null,
      cancelReason: (terminal.reason as string) ?? null,
      cancelDetail: (terminal.detail as string) ?? null,
    });
  }

  rows.sort((a, b) => (a.cancelTs ?? 0) - (b.cancelTs ?? 0));

  if (rows.length === 0) {
    console.log(
      `Ոչ մի episode, որ WAIT-ի հասած ու հետո cancel եղած լինի, չգտնվեց${symbolFilter ? ` ${symbolFilter}-ի համար` : ""}։`,
    );
    return;
  }

  console.log(
    `${"episodeId".padEnd(28)}${"symbol".padEnd(10)}${"episode start".padEnd(24)}${"cancel (UTC)".padEnd(24)}${"reason"}`,
  );
  console.log("-".repeat(110));
  for (const r of rows) {
    console.log(
      `${r.episodeId.padEnd(28)}${r.symbol.padEnd(10)}${fmtTimeShort(r.startTs ?? undefined).padEnd(24)}${fmtTimeShort(r.cancelTs ?? undefined).padEnd(24)}${r.cancelReason ?? "?"}`,
    );
  }
  console.log(`\n${rows.length} episode(ներ). Մանրամասն timeline-ի համար.`);
  console.log(`  npx tsx scripts/lox-episode-timeline.ts <symbol> <episodeId>`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Oգտագործում:");
    console.error(
      "  npx tsx scripts/lox-episode-timeline.ts SYMBOLUSDT [episodeId]",
    );
    console.error(
      "  npx tsx scripts/lox-episode-timeline.ts --list [SYMBOLUSDT]",
    );
    process.exit(1);
  }
  if (args[0] === "--list") {
    runList(args[1] ?? null);
    return;
  }
  runTimeline(args[0]!, args[1] ?? null);
}

main();
