/**
 * V9 EXIT BACKTEST (Johnny, Sep 28 2026): what if we got out when the market builds the same story against us?
 * The real V9 engine on the stored raw data (liq_raw_events + oi_second_observations), like v9-backtest-frame.
 * Same entries, different exits -- see src/research/v9-exit-sim.ts:
 *   BASE, OPP_CLOSE, OPP_FLIP, OPP_PROFIT, ANY_CLOSE, BE_1R
 * Read-only. Every trade is listed with how far it went our way first (MFE, in R).
 *
 *   nohup npx tsx src/tools/v9-backtest-exit.ts > exit.log 2>&1 &      (all coins, ~10-20 min)
 *   npx tsx src/tools/v9-backtest-exit.ts --symbols ADA,ETH --warmup 3
 */
import "dotenv/config";
import { MongoClient, type Db } from "mongodb";
import type { Victim } from "../strategy/v9/v9-core";
import { replaySymbolMulti, type Poll } from "../strategy/v9/v9-replay";
import { DEFAULT_V9_ENGINE_SETTINGS, type V9Decision } from "../strategy/v9/v9-causal-engine";
import { EXIT_VARIANTS, runVariant, type ExitTrade, type ExitVariant, type Sig } from "../research/v9-exit-sim";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const DEFAULT_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "DOGE", "ADA", "LINK", "AVAX", "SUI"];
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(",")).split(",").map((s) => s.trim().toUpperCase()).map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
const WARMUP_MS = Number(arg("warmup", "3")) * 86_400_000;
const RR = 2.2, DAY = 86_400_000;
const time = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
const yerevan = (ms: number): string => new Date(ms + 4 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
const fp = (v: number | undefined): string => (v === undefined || !Number.isFinite(v) ? "n/a" : v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(4) : v.toFixed(5));
const sR = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

const sigOf = (symbol: string, d: V9Decision): Sig => ({ id: `${symbol}:${d.episode.victim}:${d.episode.confirmTs}`, side: d.tradeSide, stop: d.stopPrice, evaluatedAt: d.evaluatedAt });

interface CoinResult { symbol: string; from: number; until: number; byVariant: Map<ExitVariant, ExitTrade[]> }

async function runSymbol(db: Db, symbol: string): Promise<CoinResult | null> {
  const liqCol = db.collection("liq_raw_events"), oiCol = db.collection("oi_second_observations");
  const [firstLiq, lastLiq, firstOi, lastOi] = await Promise.all([
    liqCol.findOne({ symbol }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } }),
    liqCol.findOne({ symbol }, { sort: { timestamp: -1 }, projection: { timestamp: 1 } }),
    oiCol.findOne({ symbol }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } }),
    oiCol.findOne({ symbol }, { sort: { timestamp: -1 }, projection: { timestamp: 1 } }),
  ]);
  if (!firstLiq || !lastLiq || !firstOi || !lastOi) return null;
  const from = Math.max(time(firstLiq.timestamp), time(firstOi.timestamp));
  const until = Math.min(time(lastLiq.timestamp), time(lastOi.timestamp));
  const tradeFrom = from + WARMUP_MS;
  if (tradeFrom >= until) { process.stderr.write(`${symbol}: only ${((until - from) / DAY).toFixed(1)} days of raw data -- less than the warm-up\n`); return null; }
  process.stderr.write(`${symbol}: raw ${yerevan(from)} -> ${yerevan(until)}, trading from ${yerevan(tradeFrom)} ...\n`);
  const liq = (await liqCol.find({ symbol, victim: { $in: ["LONG", "SHORT"] }, timestamp: { $gte: from, $lte: until } })
    .project({ timestamp: 1, victim: 1, quoteQty: 1 }).sort({ timestamp: 1 }).toArray())
    .map((x) => ({ ts: time(x.timestamp), victim: x.victim as Victim, usd: Number(x.quoteQty) }));
  const oi = (await oiCol.find({ symbol, timestamp: { $gte: new Date(from), $lte: new Date(until) } })
    .project({ timestamp: 1, oiUpdatedAt: 1, openInterest: 1, price: 1 }).sort({ timestamp: 1 }).toArray())
    .map((x) => ({ ts: time(x.timestamp), updated: time(x.oiUpdatedAt), oi: Number(x.openInterest), price: Number(x.price) }));
  const polls: Poll[] = oi.filter((x) => x.price > 0).map((x) => ({ ts: x.ts, price: x.price }));

  const [res] = replaySymbolMulti(symbol, liq, oi, from, until, [{ settings: { ...DEFAULT_V9_ENGINE_SETTINGS, minSlFraction: 0.0033 }, rr: RR }]);
  const decisions = res.decisions.filter((d) => d.evaluatedAt >= tradeFrom);
  const v9 = decisions.filter((d) => d.tradable).map((d) => sigOf(symbol, d));
  // every confirmed episode V9 judged (passed or failed its 5 checks) -- the triggers for ANY_CLOSE
  const any = decisions.filter((d) => (d.reason === "SELECTED" || d.reason === "NOT_SELECTED") && d.stopPrice > 0).map((d) => sigOf(symbol, d));
  const byVariant = new Map<ExitVariant, ExitTrade[]>();
  for (const v of EXIT_VARIANTS) byVariant.set(v, runVariant(v, polls, v9, any, RR).filter((t) => t.result !== "NO_DATA" && t.result !== "NO_RISK"));
  return { symbol, from: tradeFrom, until, byVariant };
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const coins: CoinResult[] = [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const s of symbols) { const r = await runSymbol(db, s); if (r) coins.push(r); }
  } finally {
    await client.close();
  }
  if (!coins.length) { console.log("no data"); return; }
  const spanFrom = Math.min(...coins.map((c) => c.from)), spanTo = Math.max(...coins.map((c) => c.until)), days = (spanTo - spanFrom) / DAY;
  console.log(`\n=== V9 EXITS  ${yerevan(spanFrom)} -> ${yerevan(spanTo)} Yerevan (${days.toFixed(1)} days, ${coins.length} coins, after a ${WARMUP_MS / DAY}-day warm-up) ===`);
  console.log("same V9 entries, different exits; net of fees; one trade per coin at a time\n");
  console.log("variant      trades  TP   SL  EXIT  BE  open   netR     avg/trade");
  for (const v of EXIT_VARIANTS) {
    const a = coins.flatMap((c) => c.byVariant.get(v)!);
    const n = (r: string): number => a.filter((t) => t.result === r).length;
    const closed = a.filter((t) => t.result !== "OPEN"), net = closed.reduce((x, t) => x + t.netR, 0);
    console.log(`${v.padEnd(12)} ${String(closed.length).padStart(5)}  ${String(n("TP")).padStart(3)}  ${String(n("SL")).padStart(3)}  ${String(n("EXIT")).padStart(4)}  ${String(n("BE")).padStart(2)}  ${String(n("OPEN")).padStart(4)}  ${sR(net).padStart(8)}  ${closed.length ? sR(net / closed.length) : "n/a"}`);
  }
  console.log(`\nBASE = TP/SL only (now). OPP_CLOSE = also close when V9 gives the opposite signal. OPP_FLIP = close and take that opposite signal.`);
  console.log(`OPP_PROFIT = close on the opposite signal only while in profit. ANY_CLOSE = close on any opposite episode (also failed checks). BE_1R = SL to entry after +1R.`);

  console.log(`\n--- every BASE trade: how far it went our way first (MFE), and what the exits would do ---`);
  console.log("DECISION (Yerevan)  COIN   SIDE  entry        SL           BASE              MFE     OPP_CLOSE                 OPP_PROFIT       ANY_CLOSE        BE_1R");
  const cell = (t: ExitTrade | undefined): string => (!t ? "-" : t.result === "OPEN" ? "open" : `${t.result}${t.result === "EXIT" ? ` @${fp(t.exit)}` : ""} ${sR(t.netR)}`);
  for (const c of coins) {
    const find = (v: ExitVariant, id: string): ExitTrade | undefined => c.byVariant.get(v)!.find((t) => t.sig.id === id);
    for (const t of c.byVariant.get("BASE")!) {
      const id = t.sig.id;
      console.log(`${yerevan(t.sig.evaluatedAt)}         ${c.symbol.replace("USDT", "").padEnd(6)} ${t.sig.side === "LONG" ? "BUY " : "SELL"}  ${fp(t.entry).padEnd(12)} ${fp(t.sl).padEnd(12)} ${cell(t).padEnd(17)} ${`+${t.mfeR.toFixed(1)}R`.padEnd(7)} ${cell(find("OPP_CLOSE", id)).padEnd(25)} ${cell(find("OPP_PROFIT", id)).padEnd(16)} ${cell(find("ANY_CLOSE", id)).padEnd(16)} ${cell(find("BE_1R", id))}`);
    }
  }
  const base = coins.flatMap((c) => c.byVariant.get("BASE")!).filter((t) => t.result === "SL");
  const mfe = (x: number): number => base.filter((t) => t.mfeR >= x).length;
  console.log(`\nSL trades that first went our way: >= +0.5R ${mfe(0.5)}, >= +1R ${mfe(1)}, >= +1.5R ${mfe(1.5)} (of ${base.length} SL)`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
