import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import "dotenv/config";
import { MongoClient } from "mongodb";

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

const LOG_DIR = process.env.PM2_LOG_DIR ?? path.join(os.homedir(), ".pm2", "logs");

function readAllForensicLines(): ForensicLine[] {
  if (!fs.existsSync(LOG_DIR)) {
    console.error(`Log directory not found: ${LOG_DIR} (set PM2_LOG_DIR if pm2 logs live elsewhere)`);
    process.exit(1);
  }
  const files = fs.readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("liquidation-detector-out") && f.endsWith(".log"))
    .map((f) => path.join(LOG_DIR, f));
  if (files.length === 0) {
    console.error(`No liquidation-detector-out*.log files found in ${LOG_DIR}`);
    process.exit(1);
  }

  const out: ForensicLine[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8").split("\n");
    for (const line of raw) {
      // Sep 19 2026 (Karo), operator-requested -- also pick up
      // recovery-flow-tracker.ts's own [RECOVERY_FLOW_FROZEN] log line
      // (mod:"recovery-flow", supersedes the retired order-flow mod), a
      // SEPARATE mod tag from the LOX strategy's own forensic events.
      if (!line.includes("lox-forensic") && !line.includes("recovery-flow")) continue;
      const jsonStart = line.indexOf("{");
      if (jsonStart === -1) continue;
      try {
        const parsed = JSON.parse(line.slice(jsonStart)) as ForensicLine;
        if (parsed.mod === "lox-forensic") {
          out.push(parsed);
        } else if (parsed.mod === "recovery-flow" && typeof parsed.msg === "string" && parsed.msg.includes("[RECOVERY_FLOW_FROZEN]")) {
          // recovery-flow's own log has no `ts`/`type` fields (unlike
          // LOX forensic events) -- normalize onto the same shape so it
          // sorts and groups by episodeId identically to everything else.
          out.push({ ...parsed, type: "RECOVERY_FLOW_FROZEN", ts: parsed.frozenAtMs as number | undefined });
        }
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

/** Sep 19 2026 (Karo), operator-requested -- flow amounts (Spot/Futures
 *  taker volume) can run into the millions; mirrors the main app's own
 *  formatCompactUsd() (telegram-display-format.ts) so the timeline
 *  reads the same way the Telegram message itself does. */
function fmtCompactUsd(n: unknown): string {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function runTimeline(symbol: string, episodeIdFilter: string | null): void {
  const events = readAllForensicLines()
    .filter((e) => e.symbol === symbol)
    .filter((e) => episodeIdFilter === null || e.episodeId === episodeIdFilter)
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  if (events.length === 0) {
    console.log(`Ոչինչ չգտնվեց ${symbol}-ի համար${episodeIdFilter ? ` (episodeId=${episodeIdFilter})` : ""}: հնարավոր է log-երը rotate են եղել։`);
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
          console.log(`[${t}] \u{1F7E2} EPISODE_START  victim=${e.victim}  startPrice=${e.startPrice}  startingOi=${e.startingOi}`);
          break;
        case "LIQ_ACCUMULATED":
          liqCount++;
          lastLiqTotal = e.newTotal;
          if (liqCount % 5 === 1) {
            console.log(`[${t}]   \u21B3 LIQ_ACCUMULATED  total=${fmtUsd(e.newTotal)}  (+${fmtUsd(e.eventUsd)})`);
          }
          break;
        case "EXTREME_UPDATE":
          if (e.meaningfulExtremeProgress) {
            console.log(`[${t}]   \u21B3 EXTREME_UPDATE  ${e.previousExtreme} \u2192 ${e.newExtreme}`);
          }
          break;
        case "WATCH_EVALUATION":
          console.log(`[${t}] \u{1F441} WATCH_EVALUATION  result=${e.result}${e.reasonCode ? `  reason=${e.reasonCode}` : ""}  percentileRank=${Number(e.percentileRank).toFixed(1)} (\u057A\u0561\u0570\u0561\u0576\u057B\u057E\u0578\u0582\u0574 \u0567 ${e.requiredPercentile})`);
          break;
        case "STATE_TRANSITION":
          console.log(`[${t}] \u{1F500} STATE_TRANSITION  ${e.from} \u2192 ${e.to}${e.reason ? `   (${e.reason})` : ""}`);
          break;
        case "ENTRY_GATE_EVALUATION": {
          const blockedBy = Array.isArray(e.blockedBy) ? (e.blockedBy as string[]).join(", ") : "\u2014";
          console.log(`[${t}] \u{1F6AA} ENTRY_GATE_EVALUATION  final=${e.final}  blockedBy=[${blockedBy}]`);
          const counterMove = e.counterMove as { detail?: string } | undefined;
          if (counterMove?.detail) console.log(`             detail: ${counterMove.detail}`);
          break;
        }
        case "ENTRY_READY":
          console.log(`[${t}] \u2705 ENTRY_READY  entryPrice=${e.entryReferencePrice}  extreme=${e.extreme}  counterMoveAtr=${e.counterMoveAtr}`);
          break;
        case "EPISODE_TERMINAL":
          console.log(`[${t}] \u26D4 EPISODE_TERMINAL (cancel)  reason=${e.reason}`);
          console.log(`             detail: ${e.detail}`);
          console.log(`             lifetimeMs=${e.lifetimeMs}  finalTotalLiqUsd=${fmtUsd(e.finalTotalLiqUsd)}  symbolReleased=${e.symbolReleased}`);
          break;
        case "RESTART_RECONCILIATION":
          console.log(`[${t}] \u{1F504} RESTART_RECONCILIATION  outcome=${e.outcome}  ${e.detail ?? ""}`);
          break;
        case "RECOVERY_FLOW_FROZEN": {
          const spotAvail = e.spotDataAvailable === true;
          const oiAvail = e.oiDataAvailable === true;
          console.log(`[${t}] \u{1F30A} RECOVERY_FLOW_FROZEN  (extreme \u2192 entry, ${e.recoveryDurationMs}ms)`);
          console.log(`             extreme=${e.recoveryExtremePrice}  confirm=${e.recoveryConfirmationPrice}`);
          console.log(`             FUT:  Buy ${fmtCompactUsd(e.recoveryFuturesTakerBuyUsd)}  Sell ${fmtCompactUsd(e.recoveryFuturesTakerSellUsd)}  Imb ${Number(e.recoveryFuturesImbalancePct).toFixed(2)}%`);
          console.log(`             SPOT: ${spotAvail ? `Buy ${fmtCompactUsd(e.recoverySpotTakerBuyUsd)}  Sell ${fmtCompactUsd(e.recoverySpotTakerSellUsd)}  Imb ${Number(e.recoverySpotImbalancePct).toFixed(2)}%` : "N/A"}`);
          console.log(`             OI: ${oiAvail && e.recoveryOiDeltaPct !== null ? `${Number(e.recoveryOiDeltaPct).toFixed(2)}%` : "N/A"}  |  Move: ${e.recoveryOiMoveLabel ?? "N/A"}  |  Spot: ${e.spotConfirmationLabel}`);
          break;
        }
        default:
          console.log(`[${t}] (${e.type})`);
      }
    }
    if (liqCount > 0) console.log(`   ... \u0568\u0576\u0564\u0561\u0574\u0565\u0576\u0568 ${liqCount} liquidation event, \u057E\u0565\u0580\u057B\u0576\u0561\u056F\u0561\u0576 total=${fmtUsd(lastLiqTotal)}`);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`\u0538\u0576\u0564\u0561\u0574\u0565\u0576\u0568 ${events.length} forensic event, ${byEpisode.size} episode(\u0576\u0565\u0580) \u0563\u057F\u0576\u057E\u0565\u0581 ${symbol}-\u056B \u0570\u0561\u0574\u0561\u0580.`);
}

interface EpisodeListRow {
  episodeId: string;
  symbol: string;
  startTs: number | null;
  reachedWaitTs: number | null;
  cancelTs: number | null;
  cancelReason: string | null;
  cancelDetail: string | null;
  wasReopened: boolean;
}

function runList(symbolFilter: string | null): void {
  const all = readAllForensicLines().filter((e) => symbolFilter === null || e.symbol === symbolFilter);
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
    const reachedWait = evs.find((e) => e.type === "STATE_TRANSITION" && e.to === "WAIT_FOR_POST_EPISODE_OI_CREATION");
    const reachedEntry = evs.find((e) => e.type === "ENTRY_READY");
    const terminal = evs.find((e) => e.type === "EPISODE_TERMINAL");
    // Sep 18 2026 (Karo), operator-reported fix -- EPISODE_TERMINAL is
    // emitted by BOTH cancel() (pre-entry, e.g. ENTRY_WINDOW_MISSED,
    // WAIT_FOR_POST_EPISODE_OI_CREATION_TIMEOUT) AND closeActive()
    // (a NORMAL close AFTER a successful entry, e.g.
    // ALL_USERS_TERMINAL_AND_CLEAN) -- the two look identical by type,
    // distinguished only by whether ENTRY_READY ever fired in between.
    // Must exclude the latter here: this list is specifically "reached
    // WAIT and was CANCELLED without ever entering", not "reached WAIT,
    // entered, and later closed normally".
    if (!reachedWait || !terminal || reachedEntry) continue;
    // Sep 18 2026 (Karo) -- distinguishes "timed out INSIDE WAIT
    // itself" from "reached WAIT once, got provisionally reopened
    // back to EXHAUSTION_CANDIDATE by a fresh same-direction
    // liquidation, and THEN timed out there instead" -- the terminal
    // reasonCode alone (e.g. ENTRY_WINDOW_MISSED vs
    // WAIT_FOR_POST_EPISODE_OI_CREATION_TIMEOUT) already tells you
    // which state it died in, but this flag makes the reopen itself
    // visible at a glance.
    const wasReopened = evs.some((e) => e.type === "STATE_TRANSITION" && e.from === "WAIT_FOR_POST_EPISODE_OI_CREATION" && e.to === "EXHAUSTION_CANDIDATE");
    rows.push({
      episodeId,
      symbol: (start?.symbol ?? evs[0]?.symbol ?? "?") as string,
      startTs: (start?.ts as number) ?? null,
      reachedWaitTs: (reachedWait.ts as number) ?? null,
      cancelTs: (terminal.ts as number) ?? null,
      cancelReason: (terminal.reason as string) ?? null,
      cancelDetail: (terminal.detail as string) ?? null,
      wasReopened,
    });
  }

  rows.sort((a, b) => (a.cancelTs ?? 0) - (b.cancelTs ?? 0));

  if (rows.length === 0) {
    console.log(`Ոչ մի episode, որ WAIT-ի հասած ու հետո cancel եղած լինի, չգտնվեց${symbolFilter ? ` ${symbolFilter}-ի համար` : ""}։`);
    return;
  }

  console.log(`${"episodeId".padEnd(28)}${"symbol".padEnd(10)}${"episode start".padEnd(24)}${"cancel (UTC)".padEnd(24)}${"reopened?".padEnd(11)}${"reason"}`);
  console.log("-".repeat(120));
  for (const r of rows) {
    console.log(
      `${r.episodeId.padEnd(28)}${r.symbol.padEnd(10)}${fmtTimeShort(r.startTs ?? undefined).padEnd(24)}${fmtTimeShort(r.cancelTs ?? undefined).padEnd(24)}${(r.wasReopened ? "\u0561\u0575\u0578" : "\u0578\u0579").padEnd(11)}${r.cancelReason ?? "?"}`,
    );
  }
  console.log(`\n${rows.length} episode(ներ). Մանրամասն timeline-ի համար.`);
  console.log(`  npx tsx scripts/lox-episode-timeline.ts <symbol> <episodeId>`);
}

/** Sep 18 2026 (Karo), operator-requested -- looks up a real
 *  globalSignalId (e.g. lox-sig-...) in Mongo's
 *  liquidation_oi_global_signals collection, extracts its symbol and
 *  entry time (createdAt -- set via $setOnInsert at the exact moment
 *  of ENTRY_READY, so it's the causal entry timestamp), then finds
 *  the matching episode in the forensic logs by symbol + closest
 *  ENTRY_READY event timestamp, and prints its full timeline. Read
 *  only -- no writes to Mongo, ever. */
async function runSignalLookup(signalId: string): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not found in environment/.env -- cannot look up a signalId without it. Use the plain SYMBOLUSDT [episodeId] mode instead.");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const dbName = process.env.MONGO_OWN_DB ?? "liquidation_detector";
  const db = client.db(dbName);
  const doc = await db.collection("liquidation_oi_global_signals").findOne({ globalSignalId: signalId });
  await client.close();

  if (!doc) {
    console.log(`Signal ${signalId} not found in liquidation_oi_global_signals.`);
    return;
  }
  const symbol = doc.symbol as string;
  const entryTs = (doc.createdAt as Date).getTime();
  console.log(`Գտնվեց՝ ${symbol}, entry \u2248 ${new Date(entryTs).toISOString()}. Փնտրում ենք համապատասխան episode...\n`);

  const all = readAllForensicLines().filter((e) => e.symbol === symbol);
  const byEpisode = new Map<string, ForensicLine[]>();
  for (const e of all) {
    const key = e.episodeId ?? "(unknown)";
    if (!byEpisode.has(key)) byEpisode.set(key, []);
    byEpisode.get(key)!.push(e);
  }

  // Best match: the episode whose own ENTRY_READY event timestamp is
  // closest to the signal's createdAt (should be near-exact, within
  // a second or two of tick latency).
  let bestEpisodeId: string | null = null;
  let bestDelta = Infinity;
  for (const [episodeId, evs] of byEpisode) {
    const entryReady = evs.find((e) => e.type === "ENTRY_READY");
    if (!entryReady || entryReady.ts === undefined) continue;
    const delta = Math.abs(entryReady.ts - entryTs);
    if (delta < bestDelta) { bestDelta = delta; bestEpisodeId = episodeId; }
  }

  if (bestEpisodeId === null) {
    console.log(`Ոչ մի ENTRY_READY event չգտնվեց ${symbol}-ի log-երում, որ համապատասխանի այս signal-ին (հնարավոր է log-երը rotate են եղել): Փորձիր` + ` npm run lox:timeline -- ${symbol}` + ` և ձեռքով գտիր ճիշտ episodeId-ը ժամանակով:`);
    return;
  }
  if (bestDelta > 60_000) {
    console.log(`\u26A0 Ամենամոտ ENTRY_READY-ն ${(bestDelta / 1000).toFixed(0)} վայրկյան հեռու է signal-ի entry-ից. հնարավոր է սխալ episode է (կամ log-երը rotate են եղել): Ցույց տալիս ենք ամեն դեպքում.\n`);
  }
  runTimeline(symbol, bestEpisodeId);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Oգտագործում:");
    console.error("  npx tsx scripts/lox-episode-timeline.ts SYMBOLUSDT [episodeId]");
    console.error("  npx tsx scripts/lox-episode-timeline.ts --list [SYMBOLUSDT]");
    console.error("  npx tsx scripts/lox-episode-timeline.ts --signal <globalSignalId>");
    process.exit(1);
  }
  if (args[0] === "--list") {
    runList(args[1] ?? null);
    return;
  }
  if (args[0] === "--signal") {
    if (!args[1]) {
      console.error("Օգտագործում. npx tsx scripts/lox-episode-timeline.ts --signal <globalSignalId>");
      process.exit(1);
    }
    void runSignalLookup(args[1]);
    return;
  }
  runTimeline(args[0]!, args[1] ?? null);
}

main();
