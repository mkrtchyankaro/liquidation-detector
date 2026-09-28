/**
 * ZONE STUDY (Johnny, Sep 28 2026): what happens when the price comes to a 4h zone? Read-only research.
 *
 * Every hour, for every coin, the zones are rebuilt from the 4h candles known at that moment (pivot zones,
 * as v9-zones-now shows them). Every time the price (Binance 1m) comes INTO a zone from outside, that is a
 * TOUCH. For each touch:
 *   - which touch it is: the zone already had N turns (pivots) -> this is touch N+1
 *   - frame edge (the highest top / lowest bottom zone) or a zone in between
 *   - liquidations and OI in the hour BEFORE the touch (the side the move liquidates: at a bottom zone the
 *     longs, at a top zone the shorts) and in the 30 minutes AFTER it (from our minute_bars)
 *   - what happened: a trade at the zone edge (bottom zone: BUY at its top edge; top zone: SELL at its
 *     bottom edge), SL just beyond the zone's outer edge (never closer than 0.33%), TP 2.2R, closed after
 *     24h -- TP = the zone held, SL = it broke
 * A zone that a finished 4h candle has already closed through is dead (not studied).
 * After a touch the zone is armed again only when its trade is over and the price has left the zone.
 *
 *   npx tsx src/tools/v9-zone-study.ts              (all V9 coins, all minute_bars days)
 *   npx tsx src/tools/v9-zone-study.ts --days 5 --list
 */
import "dotenv/config";
import * as fs from "fs";
import axios from "axios";
import { MongoClient } from "mongodb";
import { pivotZones, PivotZone, K } from "./v9-frame";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const MIN = 60_000, H = 3_600_000, H4 = 4 * H, DAY = 24 * H, LOOK_DAYS = 7;
const RR = 2.2, MIN_SL = 0.0033, SL_BUFFER = 0.001, TAKER = 0.05, MAKER = 0.02, MAX_HOLD = 24 * 60;
const yerevan = (ms: number): string => new Date(ms + 4 * H).toISOString().slice(5, 16).replace("T", " ");
const fp = (v: number): string => (!Number.isFinite(v) ? "n/a" : v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toFixed(5));
const k$ = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0));
const num = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
const http = axios.create({ baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com", timeout: 15_000 });

async function klines(symbol: string, interval: string, from: number, to: number): Promise<K[]> {
  const out: K[] = [];
  for (let start = from, guard = 0; guard < 300 && start < to; guard++) {
    const res = await http.get<Array<[number, string, string, string, string]>>("/fapi/v1/klines", { params: { symbol, interval, startTime: start, endTime: to, limit: 1500 } });
    if (!res.data.length) break;
    for (const k of res.data) out.push({ ts: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) });
    const next = res.data[res.data.length - 1][0] + 1;
    if (next <= start) break;
    start = next;
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

function symbols(): string[] {
  try {
    const cfg = JSON.parse(fs.readFileSync("users.config.json", "utf8")) as { v9?: { symbols?: string[] } };
    if (cfg.v9?.symbols?.length) return cfg.v9.symbols;
  } catch { /* default */ }
  return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT", "ADAUSDT", "DOGEUSDT"];
}

type Res = "TP" | "SL" | "TIME" | "OPEN";
interface Touch {
  symbol: string; ts: number; side: "BOTTOM" | "TOP"; edge: boolean; prior: number; zone: PivotZone;
  entry: number; sl: number; res: Res; netR: number; minutes: number;
  liqBefore: number; liqBeforeRel: number; oiBefore: number; oiAfter: number; liqAfterOther: number;
}

/** A zone is dead when a finished 4h candle after its last pivot closed beyond its outer edge. */
function alive(z: PivotZone, side: "BOTTOM" | "TOP", c4: readonly K[], until: number): boolean {
  const last = Math.max(...z.pivots);
  for (const k of c4) if (k.ts > last && k.ts + H4 <= until && (side === "BOTTOM" ? k.close < z.lo : k.close > z.hi)) return false;
  return true;
}

function trade(m1: readonly K[], i0: number, long: boolean, entry: number, sl: number): { res: Res; netR: number; minutes: number; exitIdx: number } {
  const risk = Math.abs(entry - sl), slPct = (100 * risk) / entry, tp = long ? entry + RR * risk : entry - RR * risk;
  // the touch minute itself: if it already went through the stop, the zone broke at once
  if (long ? m1[i0].low <= sl : m1[i0].high >= sl) return { res: "SL", netR: -1 - (2 * TAKER) / slPct, minutes: 0, exitIdx: i0 };
  for (let i = i0 + 1; i < m1.length; i++) {
    const b = m1[i], minutes = (b.ts - m1[i0].ts) / MIN;
    if (long ? b.low <= sl : b.high >= sl) return { res: "SL", netR: -1 - (2 * TAKER) / slPct, minutes, exitIdx: i };
    if (long ? b.high >= tp : b.low <= tp) return { res: "TP", netR: RR - (TAKER + MAKER) / slPct, minutes, exitIdx: i };
    if (minutes >= MAX_HOLD) return { res: "TIME", netR: (long ? b.close - entry : entry - b.close) / risk - (2 * TAKER) / slPct, minutes, exitIdx: i };
  }
  return { res: "OPEN", netR: 0, minutes: NaN, exitIdx: m1.length };
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const days = Number(arg("days", "30")), list = argv.includes("--list");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const touches: Touch[] = [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const now = Date.now();
    for (const s of symbols()) {
      const first = await db.collection("minute_bars").find({ symbol: s }).sort({ ts: 1 }).limit(1).toArray();
      if (!first.length) continue;
      const from = Math.max(num(first[0].ts), now - days * DAY);
      process.stderr.write(`${s}: ${yerevan(from)} -> now ...\n`);
      const bars = await db.collection("minute_bars").find({ symbol: s, ts: { $gte: new Date(from - 2 * H) } }).project({ ts: 1, oiLast: 1, longLiqUsd: 1, shortLiqUsd: 1 }).sort({ ts: 1 }).toArray();
      const mb = new Map<number, { oi: number; liqL: number; liqS: number }>(bars.map((b) => [num(b.ts), { oi: Number(b.oiLast), liqL: Number(b.longLiqUsd ?? 0), liqS: Number(b.shortLiqUsd ?? 0) }]));
      // typical hourly liquidations of each side for this coin (to say "big" or "small" for this coin)
      const hourly = (side: "L" | "S"): number => {
        const perH = new Map<number, number>();
        for (const [ts, b] of mb) perH.set(Math.floor(ts / H), (perH.get(Math.floor(ts / H)) ?? 0) + (side === "L" ? b.liqL : b.liqS));
        const v = [...perH.values()].sort((a, b) => a - b);
        return v.length ? v[v.length >> 1] : NaN;
      };
      const typL = hourly("L"), typS = hourly("S");
      const c4 = await klines(s, "4h", from - (LOOK_DAYS + 1) * DAY, now);
      const m1 = await klines(s, "1m", from, now);
      const oiAt = (ts: number): number => { for (let t = Math.floor(ts / MIN) * MIN, i = 0; i < 5; i++, t -= MIN) { const b = mb.get(t); if (b && b.oi > 0) return b.oi; } return NaN; };
      const liqSum = (a: number, b: number, side: "L" | "S"): number => { let v = 0; for (let t = Math.floor(a / MIN) * MIN; t < b; t += MIN) { const x = mb.get(t); if (x) v += side === "L" ? x.liqL : x.liqS; } return v; };

      const armedAt = new Map<string, number>(); // zone key -> ts from which it can be touched again
      let zones: Array<{ z: PivotZone; side: "BOTTOM" | "TOP"; edge: boolean; key: string }> = [];
      let zonesHour = -1;
      for (let i = 1; i < m1.length; i++) {
        const b = m1[i], hour = Math.floor(b.ts / H) * H;
        if (hour !== zonesHour) {
          zonesHour = hour;
          const w4 = c4.filter((k) => k.ts >= hour - LOOK_DAYS * DAY && k.ts + H4 <= hour);
          const tops = pivotZones(w4, "TOP").filter((z) => alive(z, "TOP", c4, hour));
          const bots = pivotZones(w4, "BOTTOM").filter((z) => alive(z, "BOTTOM", c4, hour));
          const topEdge = tops.length ? tops.reduce((a, c) => (c.hi > a.hi ? c : a)) : null;
          const botEdge = bots.length ? bots.reduce((a, c) => (c.lo < a.lo ? c : a)) : null;
          zones = [
            ...tops.map((z) => ({ z, side: "TOP" as const, edge: z === topEdge, key: `T${z.ts}` })),
            ...bots.map((z) => ({ z, side: "BOTTOM" as const, edge: z === botEdge, key: `B${z.ts}` })),
          ];
        }
        const prev = m1[i - 1];
        for (const { z, side, edge, key } of zones) {
          if ((armedAt.get(key) ?? 0) > b.ts) continue;
          // came INTO the zone from outside: the previous minute was fully away from it
          const inside = side === "BOTTOM" ? b.low <= z.hi : b.high >= z.lo;
          const wasAway = side === "BOTTOM" ? prev.low > z.hi : prev.high < z.lo;
          if (!inside || !wasAway) continue;
          const long = side === "BOTTOM";
          const entry = long ? z.hi : z.lo;
          let sl = long ? z.lo * (1 - SL_BUFFER) : z.hi * (1 + SL_BUFFER);
          if (Math.abs(entry - sl) < entry * MIN_SL) sl = long ? entry * (1 - MIN_SL) : entry * (1 + MIN_SL);
          const t = trade(m1, i, long, entry, sl);
          const oi0 = oiAt(b.ts), oiB = oiAt(b.ts - H), oiA = oiAt(b.ts + 30 * MIN);
          const victim: "L" | "S" = long ? "L" : "S"; // the move into a bottom zone liquidates longs, into a top zone shorts
          const liqBefore = liqSum(b.ts - H, b.ts + MIN, victim);
          touches.push({
            symbol: s.replace("USDT", ""), ts: b.ts, side, edge, prior: z.touches ?? 1, zone: z, entry, sl, res: t.res, netR: t.netR, minutes: t.minutes,
            liqBefore, liqBeforeRel: liqBefore / (victim === "L" ? typL : typS),
            oiBefore: oiB > 0 && oi0 > 0 ? (100 * (oi0 - oiB)) / oiB : NaN,
            oiAfter: oi0 > 0 && oiA > 0 ? (100 * (oiA - oi0)) / oi0 : NaN,
            liqAfterOther: liqSum(b.ts + MIN, b.ts + 31 * MIN, long ? "S" : "L"),
          });
          // armed again once the trade is over and the price has left the zone
          let j = Math.min(t.exitIdx, m1.length - 1);
          while (j < m1.length - 1 && (side === "BOTTOM" ? m1[j].low <= z.hi : m1[j].high >= z.lo)) j++;
          armedAt.set(key, m1[j].ts + MIN);
        }
      }
    }
  } finally {
    await client.close();
  }

  if (list) {
    console.log("\nTOUCH (Yerevan)  COIN  ZONE             edge  turns before   zone               liq before (x typical)  OI 1h before  OI 30m after  other liq 30m after  -> result");
    for (const t of touches) console.log(`${yerevan(t.ts)}  ${t.symbol.padEnd(5)} ${t.side.padEnd(6)} ${t.edge ? "EDGE" : "mid "}  ${String(t.prior).padStart(2)} (touch ${t.prior + 1})  ${`${fp(t.zone.lo)}-${fp(t.zone.hi)}`.padEnd(19)} ${k$(t.liqBefore).padStart(8)} (x${Number.isFinite(t.liqBeforeRel) ? t.liqBeforeRel.toFixed(1) : "n/a"})`.padEnd(120) + `  ${Number.isFinite(t.oiBefore) ? `${t.oiBefore.toFixed(2)}%` : "n/a"}`.padEnd(14) + `${Number.isFinite(t.oiAfter) ? `${t.oiAfter.toFixed(2)}%` : "n/a"}`.padEnd(14) + `${k$(t.liqAfterOther)}`.padEnd(20) + `-> ${t.res} ${t.netR >= 0 ? "+" : ""}${t.netR.toFixed(2)}R`);
  }
  const row = (name: string, pick: (t: Touch) => boolean): void => {
    const a = touches.filter(pick), tp = a.filter((t) => t.res === "TP").length, sl = a.filter((t) => t.res === "SL").length, tm = a.filter((t) => t.res === "TIME").length;
    const net = a.reduce((x, t) => x + t.netR, 0);
    console.log(`${name.padEnd(46)} touches ${String(a.length).padStart(4)}  held(TP) ${String(tp).padStart(3)}  broke(SL) ${String(sl).padStart(3)}  24h ${String(tm).padStart(2)}  held ${tp + sl ? `${Math.round((100 * tp) / (tp + sl))}%`.padStart(4) : " n/a"}  avg ${a.length ? (net / a.length).toFixed(2).padStart(5) : "  n/a"}R`);
  };
  const span = touches.length ? (Math.max(...touches.map((t) => t.ts)) - Math.min(...touches.map((t) => t.ts))) / DAY : 0;
  console.log(`\n=== ZONE STUDY: ${touches.length} touches, ${span.toFixed(1)} days, ${new Set(touches.map((t) => t.symbol)).size} coins ===`);
  console.log("(a trade at the zone edge, SL beyond the zone, TP 2.2R: held = TP first, broke = SL first; break-even win rate at 2.2R is ~31%)\n");
  row("ALL", () => true);
  console.log("\n-- which touch --");
  row("2nd touch (1 turn before)", (t) => t.prior === 1);
  row("3rd touch (2 turns before)", (t) => t.prior === 2);
  row("4th+ touch (3+ turns before)", (t) => t.prior >= 3);
  row("3rd or later (2+ turns before)", (t) => t.prior >= 2);
  console.log("\n-- where --");
  row("frame edge (highest top / lowest bottom)", (t) => t.edge);
  row("zone in between", (t) => !t.edge);
  row("bottom zones (BUY)", (t) => t.side === "BOTTOM");
  row("top zones (SELL)", (t) => t.side === "TOP");
  console.log("\n-- the hour BEFORE the touch --");
  row("victims' liq >= 2x this coin's typical hour", (t) => t.liqBeforeRel >= 2);
  row("victims' liq < 2x", (t) => !(t.liqBeforeRel >= 2));
  row("OI fell (positions closed on the way in)", (t) => t.oiBefore < 0);
  row("OI rose (positions opened on the way in)", (t) => t.oiBefore >= 0);
  row("cleaning into the zone: big liq + OI fell", (t) => t.liqBeforeRel >= 2 && t.oiBefore < 0);
  console.log("\n-- the 30 minutes AFTER the touch (not known at the touch; V9 waits for it) --");
  row("OI rose after (new positions)", (t) => t.oiAfter > 0);
  row("OI fell after", (t) => t.oiAfter <= 0);
  row("the other side got liquidated after (turn)", (t) => t.liqAfterOther > 0);
  row("V9-like: cleaning in + new positions after", (t) => t.liqBeforeRel >= 2 && t.oiBefore < 0 && t.oiAfter > 0);
  row("V9-like at a frame EDGE", (t) => t.edge && t.liqBeforeRel >= 2 && t.oiBefore < 0 && t.oiAfter > 0);
  console.log("\nturns before = pivots already in the zone when the price came (2 turns before -> we are the 3rd touch).");
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
