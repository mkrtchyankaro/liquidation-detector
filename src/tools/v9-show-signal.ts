/**
 * The full story of ONE V9 signal, by its id (the 🆔 line in Telegram).
 *
 *   npx tsx src/tools/v9-show-signal.ts v9-ADAUSDT-2026-09-24T05:37:00.000Z-SHORT
 *   npx tsx src/tools/v9-show-signal.ts <id> --before 30 --after 60     (minutes around the episode)
 *
 * Prints: the decision (5 checks, features, medians), every user's trade, and
 * a minute-by-minute table: price, OI change, LONG/SHORT liquidations, what
 * the engine saw LIVE that minute (OI phase + forming episode), positioning
 * (% long of all accounts / of top traders' positions) and markers
 * (START, CONFIRM, ENTRY, EXIT). Read-only.
 *
 * Raw market data is kept 3-4 days; the live timeline and positioning longer.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { buildStory } from "../strategy/v9/v9-signal-story";
import { fmtPrice } from "../strategy/v9/v9-telegram";

const id = process.argv[2];
const arg = (name: string, fallback: number): number => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? Number(process.argv[i + 1]) : fallback; };
const utc = (ms: number | null | undefined): string => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-");
const usd = (v: number): string => (v === 0 ? "" : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0));
const num = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

async function main(): Promise<void> {
  if (!id) throw new Error("usage: npx tsx src/tools/v9-show-signal.ts <signalId>");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const d = await db.collection("v9_decisions").findOne({ signalId: id });
    if (!d) throw new Error(`signal ${id} not found in v9_decisions`);
    const trades = await db.collection("v9_trades").find({ signalId: id }).sort({ userId: 1 }).toArray();
    const symbol = d.symbol as string;

    console.log(`\n=== SIGNAL ${id} ===`);
    console.log(`${symbol}  victim=${d.victim}  trade=${d.victim === "LONG" ? "BUY" : "SELL"}  decision=${d.reason}${d.missingMinutes ? `  missingMinutes=${d.missingMinutes}` : ""}`);
    console.log(`episode   ${utc(d.episodeStart)} -> end ${utc(d.episodeEnd)} -> CONFIRM ${utc(d.confirmTs)} -> decided ${utc(d.evaluatedAt)}  (${d.episode.parts} part(s), ${Math.round((d.confirmTs - d.episodeStart) / 60_000)} min)`);
    console.log(`liq       LONG $${usd(d.episode.longUsd) || 0}  SHORT $${usd(d.episode.shortUsd) || 0}`);
    console.log(`OI drop   ${d.episode.oiDropPct.toFixed(3)}%   price move ${d.episode.priceMovePct.toFixed(3)}%`);
    const c = d.checks as Record<string, boolean>;
    console.log(`checks    ${Object.entries(c).map(([k, v]) => `${k}${v ? "✓" : "✗"}`).join("  ")}`);
    const f = d.features as Record<string, number>;
    console.log(`features  CLR ${Number(f.clr).toFixed(2)} (median ${d.reference.medianClr.toFixed(2)})  move ${Number(f.dirMove).toFixed(2)}% (median ${d.reference.medianMove.toFixed(2)}%)  EFF pre→post ${Number(f.preEff).toFixed(2)}→${Number(f.postEff).toFixed(2)}  reference n=${d.reference.sampleCount}`);
    console.log(`plan      SL ${fmtPrice(d.stopPrice)}   price at decision ${fmtPrice(d.referencePrice)}`);

    console.log(`\n--- trades ---`);
    if (!trades.length) console.log("(none)");
    for (const t of trades) {
      console.log(`${String(t.userId).padEnd(8)} ${String(t.mode).padEnd(5)} ${String(t.state).padEnd(7)} entry ${fmtPrice(t.entryPrice)}  SL ${fmtPrice(t.slPrice)}  TP ${fmtPrice(t.tpPrice)}  qty ${t.quantity ?? "-"}  ${utc(t.createdAt)} -> ${utc(t.closedAt)}  ${t.closeReason ?? t.failureReason ?? ""}  ${t.pnlUsd != null ? `PnL ${t.pnlUsd >= 0 ? "+" : ""}${Number(t.pnlUsd).toFixed(2)}$ (${Number(t.pnlR).toFixed(2)}R)` : ""}`);
    }

    const closedAt = Math.max(0, ...trades.map((t) => Number(t.closedAt ?? 0)));
    const from = d.episodeStart - arg("before", 15) * 60_000;
    const to = Math.min(Math.max(d.evaluatedAt, closedAt) + arg("after", 15) * 60_000, from + 12 * 3_600_000);
    const [liq, oi, timeline, positioning] = await Promise.all([
      db.collection("liq_raw_events").find({ symbol, timestamp: { $gte: from, $lte: to } }).project({ timestamp: 1, victim: 1, quoteQty: 1 }).toArray(),
      db.collection("oi_second_observations").find({ symbol, timestamp: { $gte: new Date(from), $lte: new Date(to) } }).project({ timestamp: 1, openInterest: 1, price: 1 }).toArray(),
      db.collection("v9_episode_timeline").find({ symbol, ts: { $gte: from, $lte: to } }).toArray(),
      db.collection("market_positioning_5m").find({ symbol, ts: { $gte: new Date(from - 5 * 60_000), $lte: new Date(to) } }).toArray(),
    ]);
    const markers = [
      { ts: d.episodeStart, label: "START" }, { ts: d.confirmTs, label: "CONFIRM" },
      ...trades.filter((t) => t.entryPrice != null).map((t) => ({ ts: Number(t.createdAt), label: `ENTRY:${t.userId}` })),
      ...trades.filter((t) => t.closedAt).map((t) => ({ ts: Number(t.closedAt), label: `EXIT:${t.userId}:${String(t.closeReason ?? "").replace("_FILLED", "")}` })),
    ];
    const rows = buildStory({
      from, to, markers,
      liquidations: liq.map((r) => ({ ts: num(r.timestamp), victim: r.victim, usd: Number(r.quoteQty) })),
      oi: oi.map((r) => ({ ts: num(r.timestamp), oi: Number(r.openInterest), price: r.price == null ? null : Number(r.price) })),
      timeline: timeline.map((r) => ({ ts: Number(r.ts), oiPhase: String(r.oiPhase), forming: r.forming ?? null })),
      positioning: positioning.map((r) => ({ ts: num(r.ts), globalLongPct: r.global?.longPct, topPositionsLongPct: r.topPositions?.longPct })),
    });

    console.log(`\n--- minute by minute (UTC) ${utc(from)} -> ${utc(to)} ---`);
    console.log("TIME   PRICE          OI Δ%    LONG LIQ   SHORT LIQ  LIVE: OI PHASE / FORMING EPISODE     ALL L%  TOP POS L%  MARK");
    for (const r of rows) {
      console.log(
        `${new Date(r.ts).toISOString().slice(11, 16)}  ${fmtPrice(r.price).padEnd(13)}  ${r.oiChangePct === null ? "   n/a" : `${r.oiChangePct >= 0 ? "+" : ""}${r.oiChangePct.toFixed(3)}`.padStart(7)}  ${usd(r.longLiqUsd).padStart(9)}  ${usd(r.shortLiqUsd).padStart(9)}  ${`${r.livePhase || "-"} / ${r.liveEpisode || "-"}`.padEnd(34)}  ${r.globalLongPct === null ? "  -" : r.globalLongPct.toFixed(1).padStart(5)}  ${r.topPositionsLongPct === null ? "     -" : r.topPositionsLongPct.toFixed(1).padStart(8)}   ${r.markers.join(" ")}`,
      );
    }
    if (!oi.length) console.log("(raw OI/liquidation rows for this period have expired -- only the live timeline and positioning remain)");
  } finally {
    await client.close();
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
