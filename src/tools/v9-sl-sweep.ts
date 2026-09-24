/**
 * SL SWEEP -- same signals, same entries, different stop distances.
 *
 * Runs the live engine ONCE per symbol (current live settings), then for every
 * tradable signal simulates several SL placements from the SAME entry price,
 * each with TP = rr x its own risk, walking the real poll prices after entry:
 *   CURRENT              the live stop (episode extreme)
 *   MIN_0.33%            widen only tight stops, to at least 0.33% (stop-out fees <= ~0.3R)
 *   PLUS_1_MINUTE_RANGE  live stop + the typical one-minute high-low of the last hour
 *   X1.5 / X2            1.5x / 2x the live risk distance
 * Results net of Binance fees. Read-only. ~1 minute per symbol.
 *
 *   npx tsx src/tools/v9-sl-sweep.ts
 *   npx tsx src/tools/v9-sl-sweep.ts --symbols BTC,ETH --rr 2.2
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { type Victim } from "../strategy/v9/v9-core";
import { replaySymbol, simulateTrade, stopForVariant, typicalMinuteRangeBefore, SL_VARIANTS, type SlVariant } from "../strategy/v9/v9-replay";

const DEFAULT_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "DOGE", "ADA", "LINK", "AVAX", "SUI"];
const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(",")).split(",").map((s) => s.trim().toUpperCase()).map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
const RR = Number(arg("rr", "2.2"));
const stamp = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const time = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
const short: Record<SlVariant, string> = { CURRENT: "now", "MIN_0.33%": ">=0.33%", PLUS_1_MINUTE_RANGE: "+1mRange", "X1.5": "x1.5", X2: "x2" };

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const tot = new Map(SL_VARIANTS.map((v) => [v, { tp: 0, sl: 0, open: 0, netR: 0, slPct: [] as number[] }]));
  console.log(`TRADE (UTC)          SYMBOL    SIDE   ${SL_VARIANTS.map((v) => short[v].padEnd(20)).join("")}`);
  try {
    for (const symbol of symbols) {
      const liqCol = db.collection("liq_raw_events"), oiCol = db.collection("oi_second_observations");
      const [fl, ll, fo, lo] = await Promise.all([
        liqCol.findOne({ symbol }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } }),
        liqCol.findOne({ symbol }, { sort: { timestamp: -1 }, projection: { timestamp: 1 } }),
        oiCol.findOne({ symbol }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } }),
        oiCol.findOne({ symbol }, { sort: { timestamp: -1 }, projection: { timestamp: 1 } }),
      ]);
      if (!fl || !ll || !fo || !lo) continue;
      const from = Math.max(time(fl.timestamp), time(fo.timestamp)), until = Math.min(time(ll.timestamp), time(lo.timestamp));
      const liq = (await liqCol.find({ symbol, victim: { $in: ["LONG", "SHORT"] }, timestamp: { $gte: from, $lte: until } }).project({ timestamp: 1, victim: 1, quoteQty: 1 }).sort({ timestamp: 1 }).toArray())
        .map((x) => ({ ts: time(x.timestamp), victim: x.victim as Victim, usd: Number(x.quoteQty) }));
      const oi = (await oiCol.find({ symbol, timestamp: { $gte: new Date(from), $lte: new Date(until) } }).project({ timestamp: 1, oiUpdatedAt: 1, openInterest: 1, price: 1 }).sort({ timestamp: 1 }).toArray())
        .map((x) => ({ ts: time(x.timestamp), updated: time(x.oiUpdatedAt), oi: Number(x.openInterest), price: Number(x.price) }));
      const polls = oi.filter((x) => x.price > 0).map((x) => ({ ts: x.ts, price: x.price })).sort((a, b) => a.ts - b.ts);

      const { trades } = replaySymbol(symbol, liq, oi, from, until, RR);
      for (const { decision: d } of trades) {
        const mr = typicalMinuteRangeBefore(polls, d.evaluatedAt);
        const cells: string[] = [];
        for (const v of SL_VARIANTS) {
          const t = simulateTrade(polls, d, RR, (entry) => stopForVariant(v, d.tradeSide, entry, d.stopPrice, mr));
          const x = tot.get(v)!;
          if (t.result === "TP") x.tp++; else if (t.result === "SL") x.sl++; else if (t.result === "OPEN") x.open++;
          x.netR += t.netR ?? 0;
          if (t.slPct !== undefined) x.slPct.push(t.slPct);
          const mark = t.result === "TP" ? "TP ✅" : t.result === "SL" ? "SL ❌" : t.result;
          cells.push(`${mark} ${t.slPct?.toFixed(2) ?? "-"}% ${t.netR !== undefined ? (t.netR >= 0 ? "+" : "") + t.netR.toFixed(2) : ""}`.padEnd(20));
        }
        console.log(`${stamp(d.evaluatedAt)}  ${symbol.padEnd(9)} ${(d.tradeSide === "LONG" ? "BUY" : "SELL").padEnd(5)}  ${cells.join("")}`);
      }
    }
  } finally {
    await client.close();
  }
  console.log(`\n===== TOTAL (rr=${RR}; each cell: result, SL distance, net R after fees) =====`);
  for (const v of SL_VARIANTS) {
    const x = tot.get(v)!, done = x.tp + x.sl;
    const med = [...x.slPct].sort((a, b) => a - b)[x.slPct.length >> 1];
    console.log(`${v.padEnd(20)} trades=${String(done).padStart(3)}  TP=${String(x.tp).padStart(3)}  SL=${String(x.sl).padStart(3)}  open=${x.open}  win=${done ? ((100 * x.tp) / done).toFixed(1).padStart(5) : "  n/a"}%  netR=${x.netR.toFixed(2).padStart(6)}  avgNetR=${done ? (x.netR / done).toFixed(2).padStart(5) : "  n/a"}  medianSL=${med?.toFixed(2) ?? "n/a"}%`);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
