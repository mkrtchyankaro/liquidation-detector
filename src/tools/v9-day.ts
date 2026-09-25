/**
 * WHY DID (OR DIDN'T) V9 SIGNAL? -- everything the live engine saw for one
 * symbol in a time window. Read-only.
 *
 *   npx tsx src/tools/v9-day.ts BTC                                   (last 24h)
 *   npx tsx src/tools/v9-day.ts BTC --from "2026-09-25 10:00" --to "2026-09-25 16:00"   (UTC)
 *
 * 1. EPISODES THAT FORMED (from the live timeline, kept 60 days): every
 *    liquidation episode the engine was building, how big it got, and
 *    whether it was ever CONFIRMED (an opposite part with an OI drop).
 *    Never confirmed = no decision at all -> no signal.
 * 2. DECISIONS (confirmed episodes): the reason (SELECTED = signal, or which
 *    check failed), the 5 checks and the numbers behind them. For the full
 *    minute-by-minute story of one: npx tsx src/tools/v9-show-signal.ts <id>
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { fmtPrice } from "../strategy/v9/v9-telegram";

const argv = process.argv.slice(2);
const opt = (name: string): string | null => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const raw = (argv[0] ?? "").toUpperCase();
const symbol = raw.endsWith("USDT") ? raw : `${raw}USDT`;
const parseUtc = (s: string): number => Date.parse(`${s.trim().replace(" ", "T")}${s.includes("Z") ? "" : "Z"}`);
const utc = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const usd = (v: number): string => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);

const REASON: Record<string, string> = {
  SELECTED: "SIGNAL",
  NOT_SELECTED: "filtered by the checks (see which are ✗)",
  REFERENCE_TOO_SMALL: "too few past episodes to compare with",
  STALE_CONFIRMATION: "confirmation seen too late",
  DUPLICATE_EPISODE: "same episode already traded",
  DATA_GAP: "minutes with no data inside the episode",
  SL_TOO_TIGHT: "stop too tight (fees)",
  ACCUM_WEAK: "OI did not grow back",
  SYMBOL_BUSY: "a V9 trade on this symbol was still open",
};

async function main(): Promise<void> {
  if (!raw) throw new Error('usage: npx tsx src/tools/v9-day.ts BTC [--from "2026-09-25 10:00"] [--to "2026-09-25 16:00"]  (UTC)');
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const to = opt("to") ? parseUtc(opt("to")!) : Date.now();
  const from = opt("from") ? parseUtc(opt("from")!) : to - 24 * 3_600_000;
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("bad --from/--to, use \"YYYY-MM-DD HH:MM\" (UTC)");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const [timeline, decisions, trades] = await Promise.all([
      db.collection("v9_episode_timeline").find({ symbol, ts: { $gte: from, $lte: to } }).sort({ ts: 1 }).toArray(),
      db.collection("v9_decisions").find({ symbol, $or: [{ evaluatedAt: { $gte: from, $lte: to } }, { episodeStart: { $gte: from, $lte: to } }] }).sort({ evaluatedAt: 1 }).toArray(),
      db.collection("v9_trades").find({ symbol, createdAt: { $gte: from, $lte: to + 24 * 3_600_000 } }).toArray(),
    ]);
    console.log(`\n=== ${symbol}  ${utc(from)} -> ${utc(to)} UTC  (Yerevan = UTC+4) ===`);
    console.log(`timeline minutes: ${timeline.length}   decisions: ${decisions.length}`);

    // price range in the window, for orientation
    const prices = timeline.map((t) => Number(t.price)).filter((p) => p > 0);
    if (prices.length) {
      const hi = Math.max(...prices), lo = Math.min(...prices);
      const hiTs = Number(timeline.find((t) => Number(t.price) === hi)!.ts), loTs = Number(timeline.find((t) => Number(t.price) === lo)!.ts);
      console.log(`price high ${fmtPrice(hi)} at ${utc(hiTs)}   low ${fmtPrice(lo)} at ${utc(loTs)}`);
    }

    // 1. episodes that formed
    type Ep = { start: number; victim: string; first: number; last: number; longUsd: number; shortUsd: number; oiDrop: number; move: number; parts: number; dom: boolean; dir: boolean; exh: boolean };
    const eps = new Map<string, Ep>();
    for (const t of timeline) {
      const f = t.forming;
      if (!f) continue;
      const key = `${f.start}-${f.victim}`;
      const e = eps.get(key) ?? { start: Number(f.start), victim: String(f.victim), first: Number(t.ts), last: Number(t.ts), longUsd: 0, shortUsd: 0, oiDrop: 0, move: 0, parts: 0, dom: false, dir: false, exh: false };
      e.last = Number(t.ts);
      e.longUsd = Math.max(e.longUsd, Number(f.longUsd) || 0); e.shortUsd = Math.max(e.shortUsd, Number(f.shortUsd) || 0);
      e.oiDrop = Math.max(e.oiDrop, Number(f.oiDropPct) || 0); e.move = Number(f.priceMovePct) || e.move; e.parts = Math.max(e.parts, Number(f.parts) || 0);
      e.dom = !!f.dom; e.dir = !!f.dir; e.exh = !!f.exh;
      eps.set(key, e);
    }
    const confirmedStarts = new Set(decisions.map((d) => `${d.episodeStart}-${d.victim}`));
    console.log(`\n--- 1. EPISODES THAT FORMED (${eps.size}) -- victim = who got liquidated (LONG victims -> a BUY signal) ---`);
    console.log("START        VICTIM  SEEN UNTIL   MIN  LONG LIQ   SHORT LIQ  OI DROP  PRICE MOVE  PARTS  DOM DIR EXH  CONFIRMED?");
    for (const e of [...eps.values()].sort((a, b) => a.start - b.start)) {
      const yes = confirmedStarts.has(`${e.start}-${e.victim}`);
      console.log(`${utc(e.start)}  ${e.victim.padEnd(6)}  ${utc(e.last)}  ${String(Math.round((e.last - e.start) / 60_000)).padStart(4)}  ${usd(e.longUsd).padStart(8)}  ${usd(e.shortUsd).padStart(9)}  ${e.oiDrop.toFixed(2).padStart(6)}%  ${e.move.toFixed(2).padStart(8)}%  ${String(e.parts).padStart(5)}   ${e.dom ? "✓" : "✗"}   ${e.dir ? "✓" : "✗"}   ${e.exh ? "✓" : "✗"}   ${yes ? "yes -> see decisions" : "NO (never confirmed -> no decision, no signal)"}`);
    }

    // 2. decisions
    console.log(`\n--- 2. DECISIONS (confirmed episodes: ${decisions.length}) ---`);
    for (const d of decisions) {
      const c = (d.checks ?? {}) as Record<string, boolean>;
      const f = (d.features ?? {}) as Record<string, number>;
      const mine = trades.filter((t) => t.signalId === d.signalId);
      console.log(`\n${utc(Number(d.evaluatedAt))}  ${d.victim} victims -> ${d.victim === "LONG" ? "BUY" : "SELL"}   ${d.reason === "SELECTED" ? "✅ SIGNAL" : `❌ ${d.reason}: ${REASON[d.reason] ?? ""}`}`);
      console.log(`   episode ${utc(Number(d.episodeStart))} -> end ${utc(Number(d.episodeEnd))} -> confirm ${utc(Number(d.confirmTs))}   liq LONG ${usd(d.episode.longUsd)} / SHORT ${usd(d.episode.shortUsd)}   OI drop ${Number(d.episode.oiDropPct).toFixed(2)}%   price move ${Number(d.episode.priceMovePct).toFixed(2)}%`);
      console.log(`   checks  ${Object.entries(c).map(([k, v]) => `${k}${v ? "✓" : "✗"}`).join("  ")}`);
      console.log(`   CLR ${Number(f.clr).toFixed(2)} (needs > median ${Number(d.reference?.medianClr).toFixed(2)})   move ${Number(f.dirMove).toFixed(2)}% (needs > median ${Number(d.reference?.medianMove).toFixed(2)}%)   past episodes n=${d.reference?.sampleCount}`);
      console.log(`   SL ${fmtPrice(d.stopPrice)}  price ${fmtPrice(d.referencePrice)}   id ${d.signalId}`);
      for (const t of mine) console.log(`   trade ${t.userId} ${t.mode} ${t.state} ${t.closeReason ?? t.failureReason ?? ""} ${t.pnlR != null ? `${Number(t.pnlR).toFixed(2)}R` : ""}`);
    }
    if (!timeline.length && !decisions.length) console.log("\nnothing stored for this window (check the symbol and the times, UTC)");
  } finally {
    await client.close();
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
