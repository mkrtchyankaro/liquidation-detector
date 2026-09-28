/**
 * EXITS ON OUR REAL SIGNALS (Johnny, Sep 28 2026): only the trades the live bot really opened (default user
 * "main", PAPER = every V9 signal), no engine replay -- takes seconds. For each trade:
 *   - the price path after the entry (oi_second_observations prices, ~every few seconds)
 *   - the signals the live engine gave on the same coin WHILE the trade was open (v9_decisions -- the
 *     opposite ones were not opened live: SYMBOL_BUSY)
 * and what each exit rule would have done (see src/research/v9-exit-sim.ts):
 *   BASE        TP / SL (what really happened)
 *   OPP_CLOSE   close at market when live gave an opposite V9 signal (SELECTED or SYMBOL_BUSY)
 *   OPP_PROFIT  the same, only while the trade was in profit
 *   ANY_CLOSE   close on any opposite confirmed episode (also the ones that failed V9's checks)
 *   BE_1R       SL to the entry after +1R
 * Read-only.
 *
 *   npx tsx src/tools/v9-exit-live.ts                (user main, all its trades)
 *   npx tsx src/tools/v9-exit-live.ts --user main --days 7
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import type { Poll } from "../strategy/v9/v9-replay";
import { simulateExit, type ExitTrade, type Sig } from "../research/v9-exit-sim";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const RR = 2.2, DAY = 86_400_000;
const time = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
const yerevan = (ms: number): string => new Date(ms + 4 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
const fp = (v: number | undefined | null): string => (v === undefined || v === null || !Number.isFinite(v) ? "n/a" : v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(4) : v.toFixed(5));
const sR = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
const VARIANTS = ["BASE", "OPP_CLOSE", "OPP_PROFIT", "ANY_CLOSE", "BE_1R"] as const;
type V = typeof VARIANTS[number];

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", "main"), days = Number(arg("days", "60"));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const rows: Array<{ symbol: string; sig: Sig; real: { state: string; pnlR: number | null }; by: Record<V, ExitTrade> }> = [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const trades = await db.collection("v9_trades").find({ userId: user, createdAt: { $gte: Date.now() - days * DAY }, entryPrice: { $ne: null }, state: { $in: ["OPEN", "CLOSED"] } }).sort({ createdAt: 1 }).toArray();
    process.stderr.write(`${trades.length} trades of ${user}\n`);
    for (const t of trades) {
      const symbol = String(t.symbol), start = time(t.createdAt);
      const end = t.closedAt ? time(t.closedAt) + 6 * 3_600_000 : Date.now(); // a little after the real close, for the other rules
      const polls: Poll[] = (await db.collection("oi_second_observations").find({ symbol, timestamp: { $gte: new Date(start - 60_000), $lte: new Date(end) } })
        .project({ timestamp: 1, price: 1 }).sort({ timestamp: 1 }).toArray())
        .map((x) => ({ ts: time(x.timestamp), price: Number(x.price) })).filter((x) => x.price > 0);
      if (polls.length < 10) { process.stderr.write(`${symbol} ${yerevan(start)}: no prices stored -- skipped\n`); continue; }
      const decs = await db.collection("v9_decisions").find({ symbol, evaluatedAt: { $gt: start, $lte: end }, stopPrice: { $gt: 0 } })
        .project({ signalId: 1, victim: 1, reason: 1, evaluatedAt: 1, stopPrice: 1 }).sort({ evaluatedAt: 1 }).toArray();
      // V9's trade side = the victim side (LONG liquidations -> BUY)
      const toSig = (d: (typeof decs)[number]): Sig => ({ id: String(d.signalId), side: d.victim === "LONG" ? "LONG" : "SHORT", stop: Number(d.stopPrice), evaluatedAt: time(d.evaluatedAt) });
      const v9 = decs.filter((d) => d.reason === "SELECTED" || d.reason === "SYMBOL_BUSY").map(toSig);
      const any = decs.filter((d) => d.reason === "SELECTED" || d.reason === "SYMBOL_BUSY" || d.reason === "NOT_SELECTED").map(toSig);
      const sig: Sig = { id: String(t.signalId), side: t.side === "LONG" ? "LONG" : "SHORT", stop: Number(t.slPrice), evaluatedAt: start };
      const by = {
        BASE: simulateExit(polls, sig, RR, []),
        OPP_CLOSE: simulateExit(polls, sig, RR, v9),
        OPP_PROFIT: simulateExit(polls, sig, RR, v9, { onlyInProfit: true }),
        ANY_CLOSE: simulateExit(polls, sig, RR, any),
        BE_1R: simulateExit(polls, sig, RR, [], { breakEvenAtR: 1 }),
      } as Record<V, ExitTrade>;
      rows.push({ symbol, sig, real: { state: String(t.state), pnlR: t.pnlR === null || t.pnlR === undefined ? null : Number(t.pnlR) }, by });
    }
  } finally {
    await client.close();
  }
  console.log(`\n=== EXITS ON THE REAL V9 TRADES of ${user} (${rows.length} trades) ===`);
  console.log("variant      closed  TP   SL  EXIT  BE  open   netR     avg/trade");
  for (const v of VARIANTS) {
    const a = rows.map((r) => r.by[v]);
    const n = (x: string): number => a.filter((t) => t.result === x).length;
    const closed = a.filter((t) => t.result !== "OPEN" && t.result !== "NO_DATA" && t.result !== "NO_RISK"), net = closed.reduce((x, t) => x + t.netR, 0);
    console.log(`${v.padEnd(12)} ${String(closed.length).padStart(5)}  ${String(n("TP")).padStart(3)}  ${String(n("SL")).padStart(3)}  ${String(n("EXIT")).padStart(4)}  ${String(n("BE")).padStart(2)}  ${String(n("OPEN")).padStart(4)}  ${sR(net).padStart(8)}  ${closed.length ? sR(net / closed.length) : "n/a"}`);
  }
  console.log("\nBASE = TP/SL (should match the real results). OPP_CLOSE = close when the bot gave the opposite signal on the same coin.");
  console.log("OPP_PROFIT = only while in profit. ANY_CLOSE = any opposite episode, also failed checks. BE_1R = SL to entry after +1R.");
  console.log("\nENTRY (Yerevan)   COIN   SIDE  entry        SL           real      BASE            best our way  OPP_CLOSE                    OPP_PROFIT       ANY_CLOSE                    BE_1R");
  const cell = (t: ExitTrade): string => (t.result === "OPEN" ? "open" : t.result === "NO_DATA" || t.result === "NO_RISK" ? t.result : `${t.result}${t.result === "EXIT" ? ` ${yerevan(t.exitTs).slice(6)} @${fp(t.exit)}` : ""} ${sR(t.netR)}`);
  for (const r of rows) {
    const b = r.by.BASE;
    console.log(`${yerevan(r.sig.evaluatedAt)}       ${r.symbol.replace("USDT", "").padEnd(6)} ${r.sig.side === "LONG" ? "BUY " : "SELL"}  ${fp(b.entry).padEnd(12)} ${fp(r.sig.stop).padEnd(12)} ${(r.real.state === "OPEN" ? "open" : r.real.pnlR === null ? "?" : sR(r.real.pnlR)).padEnd(9)} ${cell(b).padEnd(15)} ${`+${b.mfeR.toFixed(1)}R`.padEnd(13)} ${cell(r.by.OPP_CLOSE).padEnd(28)} ${cell(r.by.OPP_PROFIT).padEnd(16)} ${cell(r.by.ANY_CLOSE).padEnd(28)} ${cell(r.by.BE_1R)}`);
  }
  const sl = rows.map((r) => r.by.BASE).filter((t) => t.result === "SL");
  const went = (x: number): number => sl.filter((t) => t.mfeR >= x).length;
  console.log(`\nOf ${sl.length} SL trades, first went our way: >= +0.5R ${went(0.5)}, >= +1R ${went(1)}, >= +1.5R ${went(1.5)}`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
