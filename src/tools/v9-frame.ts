/**
 * THE FRAME (Johnny, Sep 28 2026): trade only at the edge of the market's
 * current frame (range), never in its middle. Read-only research.
 *
 * The frame, from Binance 4h candles, no percentages, each coin by itself:
 *   - look at the last 7 days of 4h candles finished BEFORE the episode started
 *   - the most recent extreme decides the story:
 *       PEAK came last   (went up, turned down): TOP zone = the peak candle
 *                        (its wick: body top -> high); BOTTOM zone = the lowest
 *                        candle after the peak, if the price already turned
 *                        there (a later candle with a higher low) -- its wick
 *                        (low -> body bottom)
 *       BOTTOM came last (went down, turned up): mirrored
 *   - the other side not formed yet (still going straight) = NO FRAME
 * A signal is IN ZONE when the cleaning pushed the price into its zone:
 *   BUY  -> the episode low reached the BOTTOM zone (<= its body bottom; going
 *           under the wick = "pierced", still counted)
 *   SELL -> the episode high reached the TOP zone
 * Otherwise MIDDLE (pos = where the tested price sits in the frame, 0 = bottom,
 * 100 = top). 1h swings touching the zone are counted for information.
 *
 * Two checks:
 *   1. the real live signals (fills of --user, default main), real results
 *   2. EVERY confirmed episode in v9_decisions (one per episode, selected or not),
 *      simulated: entry = the decision price, SL = the episode extreme (>= 0.33%),
 *      TP = 2.2R, closed at market after 24h, on Binance 1m candles.
 * Candles come from Binance (public klines): real wicks and bodies. Our
 * minute_bars are built from ~5 s price polls and cut the wicks.
 *
 *   npx tsx src/tools/v9-frame.ts            (summary)
 *   npx tsx src/tools/v9-frame.ts --list     (also every episode, one line each)
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const MIN = 60_000, H = 3_600_000, DAY = 24 * H, H4 = 4 * H;
const RR = 2.2, MIN_SL = 0.0033, TAKER = 0.05, MAKER = 0.02, MAX_HOLD_MIN = 24 * 60, LOOK_DAYS = 7;
const stamp = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const num = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
const fp = (v: number): string => (!Number.isFinite(v) ? "n/a" : v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toFixed(4));

export interface K { ts: number; open: number; high: number; low: number; close: number }
export interface Zone { lo: number; hi: number; ts: number }
export interface Frame { last: "PEAK" | "BOTTOM"; top: Zone | null; bottom: Zone | null }

const topZone = (c: K): Zone => ({ lo: Math.max(c.open, c.close), hi: c.high, ts: c.ts });
const bottomZone = (c: K): Zone => ({ lo: c.low, hi: Math.min(c.open, c.close), ts: c.ts });

/** The frame from 4h candles (oldest first, all finished). null = too few candles. */
export function frameOf(c: readonly K[]): Frame | null {
  if (c.length < 3) return null;
  let iH = 0, iL = 0;
  for (let i = 0; i < c.length; i++) { if (c[i].high >= c[iH].high) iH = i; if (c[i].low <= c[iL].low) iL = i; }
  if (iH > iL) {
    // went up to the peak, then down: the bottom = the lowest candle after the peak, once the price turned up from it
    let j = -1;
    for (let i = iH + 1; i < c.length; i++) if (j < 0 || c[i].low <= c[j].low) j = i;
    const turned = j > 0 && j < c.length - 1 && c[j + 1].low > c[j].low && c[j - 1].low > c[j].low;
    return { last: "PEAK", top: topZone(c[iH]), bottom: turned ? bottomZone(c[j]) : null };
  }
  let j = -1;
  for (let i = iL + 1; i < c.length; i++) if (j < 0 || c[i].high >= c[j].high) j = i;
  const turned = j > 0 && j < c.length - 1 && c[j + 1].high < c[j].high && c[j - 1].high < c[j].high;
  return { last: "BOTTOM", bottom: bottomZone(c[iL]), top: turned ? topZone(c[j]) : null };
}

export type Verdict = "IN_ZONE" | "MIDDLE" | "NO_FRAME";
/** Where the cleaning pushed the price (tested = episode low for a BUY, high for a SELL) vs the frame. */
export function verdictOf(f: Frame | null, long: boolean, tested: number): { verdict: Verdict; pierced: boolean; pos: number } {
  if (!f || !f.top || !f.bottom) return { verdict: "NO_FRAME", pierced: false, pos: NaN };
  const pos = (100 * (tested - f.bottom.lo)) / (f.top.hi - f.bottom.lo);
  if (long) return tested <= f.bottom.hi ? { verdict: "IN_ZONE", pierced: tested < f.bottom.lo, pos } : { verdict: "MIDDLE", pierced: false, pos };
  return tested >= f.top.lo ? { verdict: "IN_ZONE", pierced: tested > f.top.hi, pos } : { verdict: "MIDDLE", pierced: false, pos };
}

/** 1h swing lows (highs for SELL), 2 candles each side, since `from`, inside the zone. */
function touches1h(c1: readonly K[], zone: Zone, long: boolean, from: number): number {
  let n = 0;
  for (let i = 2; i < c1.length - 2; i++) {
    if (c1[i].ts < from) continue;
    const v = long ? c1[i].low : c1[i].high;
    let ok = true;
    for (let j = i - 2; j <= i + 2 && ok; j++) if (j !== i && (long ? !(v < c1[j].low) : !(v > c1[j].high))) ok = false;
    if (ok && v >= zone.lo * 0.9999 && v <= zone.hi * 1.0001) n++;
    else if (ok && (long ? v < zone.lo : v > zone.hi)) n++; // went through the zone and turned = touched too
  }
  return n;
}

type Res = { result: "TP" | "SL" | "TIME" | "OPEN"; netR: number };
function simulate(m1: readonly K[], entryTs: number, long: boolean, entry: number, sl: number): Res {
  const risk = Math.abs(entry - sl), slPct = (100 * risk) / entry, tp = long ? entry + RR * risk : entry - RR * risk;
  const t0 = Math.floor(entryTs / MIN) * MIN;
  for (const b of m1) {
    if (b.ts <= t0) continue;
    if (long ? b.low <= sl : b.high >= sl) return { result: "SL", netR: -1 - (2 * TAKER) / slPct };
    if (long ? b.high >= tp : b.low <= tp) return { result: "TP", netR: RR - (TAKER + MAKER) / slPct };
    if ((b.ts - t0) / MIN >= MAX_HOLD_MIN) return { result: "TIME", netR: (long ? b.close - entry : entry - b.close) / risk - (2 * TAKER) / slPct };
  }
  return { result: "OPEN", netR: 0 };
}

const http = axios.create({ baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com", timeout: 15_000 });
async function klines(symbol: string, interval: string, from: number, to: number): Promise<K[]> {
  const out: K[] = [];
  let start = from;
  for (let guard = 0; guard < 200 && start < to; guard++) {
    const res = await http.get<Array<[number, string, string, string, string]>>("/fapi/v1/klines", { params: { symbol, interval, startTime: start, endTime: to, limit: 1500 } });
    if (!res.data.length) break;
    for (const k of res.data) out.push({ ts: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) });
    const next = res.data[res.data.length - 1][0] + 1;
    if (next <= start) break;
    start = next;
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

interface Case { symbol: string; long: boolean; episodeStart: number; at: number; entry: number; selected: boolean; real?: Res & { label: string } }
interface Row { c: Case; frame: Frame | null; tested: number; v: ReturnType<typeof verdictOf>; t1h: number; sim: Res }

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", "main"), list = argv.includes("--list");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    // every confirmed episode, one decision each (prefer the SELECTED one)
    const decisions = await db.collection("v9_decisions").find({ referencePrice: { $gt: 0 } }).sort({ evaluatedAt: 1 }).toArray();
    const byEp = new Map<string, (typeof decisions)[number]>();
    for (const d of decisions) {
      const k = `${d.symbol}|${d.episodeStart}|${d.victim}`;
      const had = byEp.get(k);
      if (!had || (had.reason !== "SELECTED" && d.reason === "SELECTED")) byEp.set(k, d);
    }
    const trades = await db.collection("v9_trades").find({ userId: user, entryPrice: { $ne: null } }).sort({ createdAt: 1 }).toArray();

    const cases: Case[] = [...byEp.values()].map((d) => ({
      symbol: String(d.symbol), long: d.victim === "LONG", episodeStart: num(d.episodeStart), at: num(d.evaluatedAt),
      entry: Number(d.referencePrice), selected: d.reason === "SELECTED",
    }));
    // the real signals use the user's real fill and the real result
    const realCases: Case[] = [];
    for (const t of trades) {
      const d = decisions.find((x) => x.signalId === t.signalId);
      if (!d) continue;
      const label = t.state === "CLOSED" ? (t.closeReason === "TP_FILLED" ? "TP" : t.closeReason === "SL_FILLED" ? "SL" : String(t.closeReason ?? "?")) : String(t.state);
      realCases.push({ symbol: String(t.symbol), long: t.side === "LONG", episodeStart: num(d.episodeStart), at: num(t.createdAt), entry: Number(t.entryPrice), selected: true,
        real: { label, result: label === "TP" ? "TP" : label === "SL" ? "SL" : "OPEN", netR: t.pnlR != null ? Number(t.pnlR) : 0 } });
    }

    // Binance candles per symbol, once
    const symbols = [...new Set([...cases, ...realCases].map((c) => c.symbol))];
    const now = Date.now();
    const data = new Map<string, { c4: K[]; c1: K[]; m1: K[] }>();
    for (const s of symbols) {
      const mine = [...cases, ...realCases].filter((c) => c.symbol === s);
      const first = Math.min(...mine.map((c) => c.episodeStart));
      process.stderr.write(`loading ${s} ...\n`);
      data.set(s, {
        c4: await klines(s, "4h", first - (LOOK_DAYS + 1) * DAY, now),
        c1: await klines(s, "1h", first - (LOOK_DAYS + 1) * DAY, now),
        m1: await klines(s, "1m", first - H, now),
      });
    }

    const evaluate = (c: Case): Row => {
      const { c4, c1, m1 } = data.get(c.symbol)!;
      const from = c.episodeStart - LOOK_DAYS * DAY;
      const w4 = c4.filter((k) => k.ts >= from && k.ts + H4 <= c.episodeStart);
      const frame = frameOf(w4);
      const ep = m1.filter((k) => k.ts >= Math.floor(c.episodeStart / MIN) * MIN && k.ts <= c.at);
      const tested = ep.length ? (c.long ? Math.min(...ep.map((k) => k.low)) : Math.max(...ep.map((k) => k.high))) : NaN;
      const v = verdictOf(frame, c.long, tested);
      const zone = frame ? (c.long ? frame.bottom : frame.top) : null;
      const w1 = c1.filter((k) => k.ts >= from && k.ts + H <= c.episodeStart);
      const extremeTs = frame ? Math.min(frame.top?.ts ?? Infinity, frame.bottom?.ts ?? Infinity) : Infinity;
      const t1h = zone ? touches1h(w1, zone, c.long, Number.isFinite(extremeTs) ? extremeTs : from) : 0;
      // OLD stop: the episode extreme, at least 0.33% away
      let sl = tested;
      if (Math.abs(c.entry - sl) < c.entry * MIN_SL) sl = c.long ? c.entry * (1 - MIN_SL) : c.entry * (1 + MIN_SL);
      const sim = Number.isFinite(sl) ? simulate(m1, c.at, c.long, c.entry, sl) : { result: "OPEN" as const, netR: 0 };
      return { c, frame, tested, v, t1h, sim };
    };
    const z = (zn: Zone | null | undefined): string => (zn ? `${fp(zn.lo)}-${fp(zn.hi)}` : "none").padStart(17);
    const line = (r: Row, res: string, netR: number): string =>
      `${stamp(r.c.at)}  ${r.c.symbol.padEnd(9)} ${r.c.long ? "BUY " : "SELL"}  ${`${res} ${netR >= 0 ? "+" : ""}${netR.toFixed(2)}`.padEnd(11)} ${(r.frame?.last ?? "-").padEnd(6)} top ${z(r.frame?.top)}  bottom ${z(r.frame?.bottom)}  tested ${fp(r.tested).padStart(8)}  ${(Number.isFinite(r.v.pos) ? `${Math.round(r.v.pos)}` : "-").padStart(4)}  ${String(r.t1h).padStart(3)}  ${r.v.verdict}${r.v.pierced ? " (pierced)" : ""}`;
    const head = "ENTRY UTC    SYMBOL    SIDE  RESULT      LAST   top zone (4h wick)         bottom zone (4h wick)        tested       pos  1h   FRAME";

    type Sum = { n: number; tp: number; sl: number; time: number; net: number };
    const tally = (rows: Array<{ v: Verdict; res: Res }>, name: string): void => {
      const s = new Map<string, Sum>();
      for (const k of ["all", "IN_ZONE", "MIDDLE", "NO_FRAME"]) s.set(k, { n: 0, tp: 0, sl: 0, time: 0, net: 0 });
      for (const r of rows) for (const k of ["all", r.v]) {
        const t = s.get(k)!; t.n++; t.net += r.res.netR;
        if (r.res.result === "TP") t.tp++; else if (r.res.result === "SL") t.sl++; else if (r.res.result === "TIME") t.time++;
      }
      console.log(`\n--- ${name} ---`);
      for (const [k, t] of s) console.log(`${k.padEnd(9)} trades ${String(t.n).padStart(3)}  TP ${String(t.tp).padStart(3)}  SL ${String(t.sl).padStart(3)}  24h ${String(t.time).padStart(2)}  win ${t.tp + t.sl ? `${Math.round((100 * t.tp) / (t.tp + t.sl))}%`.padStart(4) : " n/a"}  netR ${t.net >= 0 ? "+" : ""}${t.net.toFixed(2)}  avg ${t.n ? (t.net / t.n).toFixed(2) : "n/a"}R`);
    };

    // 1. the real signals
    console.log(`\n=== 1. THE ${realCases.length} REAL V9 SIGNALS OF "${user}" vs THE 4h FRAME (last ${LOOK_DAYS} days before each episode) ===`);
    console.log(head);
    const realRows = realCases.map(evaluate);
    for (const r of realRows) console.log(line(r, r.c.real!.label, r.c.real!.netR));
    tally(realRows.map((r) => ({ v: r.v.verdict, res: r.c.real! })), "real signals, real results");

    // 2. every confirmed episode, simulated
    const all = cases.map(evaluate).filter((r) => Number.isFinite(r.tested));
    console.log(`\n=== 2. EVERY CONFIRMED EPISODE (${all.length}, one per episode), simulated: OLD stop, TP 2.2R, closed after 24h ===`);
    if (list) { console.log(head); for (const r of all) console.log(line(r, r.sim.result, r.sim.netR)); }
    tally(all.map((r) => ({ v: r.v.verdict, res: r.sim })), "all confirmed episodes");
    tally(all.filter((r) => r.c.selected).map((r) => ({ v: r.v.verdict, res: r.sim })), "only the ones V9 selected (signals)");
    tally(all.filter((r) => !r.c.selected).map((r) => ({ v: r.v.verdict, res: r.sim })), "only the ones V9 did NOT select");
    const open = all.filter((r) => r.sim.result === "OPEN").length;
    console.log(`\n(${open} still open, counted as 0R.) pos: 0 = frame bottom, 100 = frame top. 1h = 1h swings that touched the zone.`);
    console.log("LAST: PEAK = the last extreme was the top (went up then down), BOTTOM = the last extreme was the low.");
    console.log("IN_ZONE: BUY with the episode low in the bottom zone, SELL with the high in the top zone. MIDDLE: inside the frame but not at our edge. NO_FRAME: the other side not formed yet.");
  } finally {
    await client.close();
  }
}

if (require.main === module) main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
