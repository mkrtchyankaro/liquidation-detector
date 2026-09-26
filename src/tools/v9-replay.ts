/**
 * V9 CAUSAL REPLAY -- honest backtest of strategy variants on stored history.
 *
 * Feeds real rows (liq_raw_events, oi_second_observations) into the LIVE
 * engine minute by minute (only data <= now, evaluated at hh:mm:10 exactly like
 * production) and simulates every tradable signal: entry at the first poll
 * price at/after the decision, SL per variant, TP = rr x risk. Results are
 * shown gross and NET of Binance fees (taker entry; maker TP / taker SL).
 *
 * Variants compared side by side (see VARIANTS below). LIVE = the rule running
 * live today (incl. min SL 0.33%). LIVE_OITURN: the stop moves to where the
 * confirming OI drop started (if closer than the episode extreme; live with
 * "lateSlPct": 0, live now). _LIQ1/_LIQ3: the confirming liquidations must
 * be >= 1x / 3x the coin's typical liquidation minute. BRK (Johnny, Sep 26):
 * the first liquidation part with an OI drop after the cleaning +
 * accumulation confirms WHICHEVER side, and the trade follows it (SHORT liq
 * -> BUY, LONG liq -> SELL); "new same-side" = the trades classic V9 never
 * takes. _DIR: from the OI turn to the decision the price must have moved
 * our way (BRK/DIR/LIQ were tested Sep 26 and rejected). LATE1: OITURN
 * only when the extreme is > 1% away. OIT_MINx: the OITURN stop only if it is
 * >= x% from the entry, else it stays at the extreme; OIT_CLAMP0.6: placed at
 * 0.6% instead. Like live, one trade per symbol at a time (a signal while a trade
 * is still open = busy, not traded). Older variants:
 *   A          current live rule (opposite-side liquidation confirms), rr 2.2
 *   _RR2       rr 2 instead of 2.2
 *   _MINSL     skip signals whose SL is so tight that stop-out fees > 0.3R
 *   _LIQSIG    the confirming opposite liquidations must be >= the symbol's
 *              typical liquidation-minute size (not e.g. $80)
 * (PRICE_OI variants were tested and rejected: net negative after fees.)
 *
 * Read-only. All variants run in ONE shared pass per symbol (the costly regime
 * fit is computed once per minute and reused), and symbols run in parallel,
 * `--jobs 2` by default (one per CPU). Usage (use nohup):
 *   npx tsx src/tools/v9-replay.ts
 *   npx tsx src/tools/v9-replay.ts --symbols BTC,ETH --rr 2.2 --details P
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { type Victim } from "../strategy/v9/v9-core";
import { replaySymbolMulti } from "../strategy/v9/v9-replay";
import { spawn } from "child_process";
import { DEFAULT_V9_ENGINE_SETTINGS, type V9EngineSettings } from "../strategy/v9/v9-causal-engine";

const DEFAULT_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "DOGE", "ADA", "LINK", "AVAX", "SUI"];
const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(",")).split(",").map((s) => s.trim().toUpperCase()).map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
const RR = Number(arg("rr", "2.2"));
const DETAILS = arg("details", "");
const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const time = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

const A: V9EngineSettings = { ...DEFAULT_V9_ENGINE_SETTINGS }; // live today
const LIVE: V9EngineSettings = { ...A, minSlFraction: 0.0033 };  // exactly what runs live (min SL 0.33%)
const VARIANTS: Array<{ name: string; settings: V9EngineSettings; rr?: number }> = [
  { name: "LIVE", settings: LIVE },
  // OITURN: stop where the confirming OI drop started (when closer than the episode extreme) -- live now ("lateSlPct": 0)
  { name: "LIVE_OITURN", settings: { ...LIVE, lateSlPct: 0 } },
  // only when the extreme is > 1% away
  { name: "LATE1", settings: { ...LIVE, lateSlPct: 1 } },
  // the OITURN stop only if it is >= 0.6% / 0.8% from the entry, else the stop stays at the extreme
  { name: "OIT_MIN0.6", settings: { ...LIVE, lateSlPct: 0, lateSlMinPct: 0.6 } },
  { name: "OIT_MIN0.8", settings: { ...LIVE, lateSlPct: 0, lateSlMinPct: 0.8 } },
  // ... or placed at exactly 0.6% when the turn is closer
  { name: "OIT_CLAMP0.6", settings: { ...LIVE, lateSlPct: 0, lateSlMinPct: 0.6, lateSlClamp: true } },
  { name: "LATE1_MIN0.6", settings: { ...LIVE, lateSlPct: 1, lateSlMinPct: 0.6 } },
];

/** same*: trades confirmed by a SAME-side part (only in BREAKOUT variants = the new trades) */
interface Tally { decisions: number; tradable: number; tp: number; sl: number; open: number; noRisk: number; busy: number; r: number; netR: number; slPcts: number[]; sameTp: number; sameSl: number; sameNetR: number }
const empty = (): Tally => ({ decisions: 0, tradable: 0, tp: 0, sl: 0, open: 0, noRisk: 0, busy: 0, r: 0, netR: 0, slPcts: [], sameTp: 0, sameSl: 0, sameNetR: 0 });
const median = (v: number[]): number => { const s = [...v].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
function line(name: string, t: Tally): string {
  const done = t.tp + t.sl;
  return `${name.padEnd(14)} trades=${String(done).padStart(3)}  TP=${String(t.tp).padStart(3)}  SL=${String(t.sl).padStart(3)}  open=${t.open}  win=${done ? ((100 * t.tp) / done).toFixed(1).padStart(5) : "  n/a"}%  R=${t.r.toFixed(1).padStart(6)}  netR=${t.netR.toFixed(1).padStart(6)}  avgNetR=${done ? (t.netR / done).toFixed(2).padStart(5) : "  n/a"}  medianSL=${Number.isFinite(median(t.slPcts)) ? median(t.slPcts).toFixed(2) : "n/a"}%  signals=${t.tradable}/${t.decisions}${t.busy ? ` busy=${t.busy}` : ""}${t.sameTp + t.sameSl ? `  | new same-side: ${t.sameTp + t.sameSl} (TP ${t.sameTp} SL ${t.sameSl}) netR ${t.sameNetR.toFixed(1)}` : ""}`;
}

type Tallies = Record<string, Tally>;

/** One symbol: load its raw rows once, run ALL variants in one shared pass. */
async function runSymbol(db: import("mongodb").Db, symbol: string, out: (line: string) => void): Promise<Tallies | null> {
  const liqCol = db.collection("liq_raw_events"), oiCol = db.collection("oi_second_observations");
  const [firstLiq, lastLiq, firstOi, lastOi] = await Promise.all([
    liqCol.findOne({ symbol }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } }),
    liqCol.findOne({ symbol }, { sort: { timestamp: -1 }, projection: { timestamp: 1 } }),
    oiCol.findOne({ symbol }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } }),
    oiCol.findOne({ symbol }, { sort: { timestamp: -1 }, projection: { timestamp: 1 } }),
  ]);
  if (!firstLiq || !lastLiq || !firstOi || !lastOi) { out(`\n${symbol}: no data`); return null; }
  const from = Math.max(time(firstLiq.timestamp), time(firstOi.timestamp));
  const until = Math.min(time(lastLiq.timestamp), time(lastOi.timestamp));
  const liq = (await liqCol.find({ symbol, victim: { $in: ["LONG", "SHORT"] }, timestamp: { $gte: from, $lte: until } })
    .project({ timestamp: 1, victim: 1, quoteQty: 1 }).sort({ timestamp: 1 }).toArray())
    .map((x) => ({ ts: time(x.timestamp), victim: x.victim as Victim, usd: Number(x.quoteQty) }));
  const oi = (await oiCol.find({ symbol, timestamp: { $gte: new Date(from), $lte: new Date(until) } })
    .project({ timestamp: 1, oiUpdatedAt: 1, openInterest: 1, price: 1 }).sort({ timestamp: 1 }).toArray())
    .map((x) => ({ ts: time(x.timestamp), updated: time(x.oiUpdatedAt), oi: Number(x.openInterest), price: Number(x.price) }));

  const started = Date.now();
  const results = replaySymbolMulti(symbol, liq, oi, from, until, VARIANTS.map((v) => ({ settings: v.settings, rr: v.rr ?? RR })));
  out(`\n===== ${symbol}  ${stamp(from)} -> ${stamp(until)}  (${VARIANTS.length} variants in one pass, ${((Date.now() - started) / 1000).toFixed(0)}s) =====`);
  const tallies: Tallies = {};
  VARIANTS.forEach((v, k) => {
    const { decisions, trades } = results[k];
    const t = empty();
    t.decisions = decisions.length; t.tradable = decisions.filter((d) => d.tradable).length;
    for (const { decision: d, trade: x } of trades) {
      if (x.result === "TP") t.tp++; else if (x.result === "SL") t.sl++; else if (x.result === "OPEN") t.open++; else if (x.result === "SYMBOL_BUSY") t.busy++; else t.noRisk++;
      t.r += x.r; t.netR += x.netR ?? 0;
      if (x.slPct !== undefined && (x.result === "TP" || x.result === "SL")) t.slPcts.push(x.slPct);
      if (d.episode.confirmSide === d.episode.victim && (x.result === "TP" || x.result === "SL")) {
        if (x.result === "TP") t.sameTp++; else t.sameSl++;
        t.sameNetR += x.netR ?? 0;
      }
      if (DETAILS === v.name) {
        out(`   ${v.name} ${stamp(d.evaluatedAt)} ${d.tradeSide === "LONG" ? "BUY " : "SELL"} start ${stamp(d.episode.start)} entry ${x.entry ?? "-"} SL ${x.sl ?? "-"} (${x.slPct?.toFixed(2) ?? "-"}%) ${x.result} ${x.minutes ?? "-"}m netR ${x.netR?.toFixed(2) ?? "-"}`);
      }
    }
    out(line(v.name, t));
    tallies[v.name] = t;
  });
  return tallies;
}

function printTotals(totals: Map<string, Tally>, n: number): void {
  console.log(`\n===== TOTAL (${n} symbols, rr=${RR}; gross break-even win ${(100 / (1 + RR)).toFixed(1)}%) =====`);
  for (const v of VARIANTS) console.log(line(v.name, totals.get(v.name)!));
  console.log("netR = after Binance fees. Fees weigh more when the SL is tight (see medianSL).");
}

function addInto(totals: Map<string, Tally>, t: Tallies): void {
  for (const v of VARIANTS) {
    const tot = totals.get(v.name)!, x = t[v.name];
    if (!x) continue;
    for (const k of ["decisions", "tradable", "tp", "sl", "open", "noRisk", "busy", "r", "netR", "sameTp", "sameSl", "sameNetR"] as const) tot[k] += x[k] ?? 0;
    tot.slPcts.push(...x.slPcts);
  }
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const child = process.argv.includes("--child");
  const jobs = Math.max(1, Number(arg("jobs", "2")));
  const totals = new Map(VARIANTS.map((v) => [v.name, empty()]));

  // Parallel: one child process per symbol, `jobs` at a time (one CPU each).
  if (!child && jobs > 1 && symbols.length > 1) {
    const queue = [...symbols];
    const outputs = new Map<string, string>();
    const runOne = (symbol: string): Promise<void> => new Promise((resolve) => {
      const args = ["tsx", process.argv[1], "--child", "--symbols", symbol, "--rr", String(RR), ...(DETAILS ? ["--details", DETAILS] : [])];
      const p = spawn("npx", args, { stdio: ["ignore", "pipe", "inherit"], env: process.env });
      let buf = "";
      p.stdout.on("data", (d) => { buf += d.toString(); });
      p.on("close", () => {
        const lines = buf.split("\n");
        const tallyLine = lines.find((l) => l.startsWith("@@TALLY "));
        if (tallyLine) addInto(totals, JSON.parse(tallyLine.slice(8)) as Tallies);
        const text = lines.filter((l) => !l.startsWith("@@TALLY ")).join("\n");
        outputs.set(symbol, text);
        console.log(text); // each symbol printed as soon as it finishes
        resolve();
      });
    });
    const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      while (queue.length) await runOne(queue.shift()!);
    });
    await Promise.all(workers);
    printTotals(totals, symbols.length);
    return;
  }

  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  try {
    for (const symbol of symbols) {
      const t = await runSymbol(db, symbol, (l) => console.log(l));
      if (!t) continue;
      if (child) console.log(`@@TALLY ${JSON.stringify(t)}`);
      else addInto(totals, t);
    }
  } finally {
    await client.close();
  }
  if (!child) printTotals(totals, symbols.length);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
