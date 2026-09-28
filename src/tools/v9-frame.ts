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
 *   npx tsx src/tools/v9-frame.ts --html frame.html   (+ a chart per real signal: candles, zones, entry)
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
export interface Zone { lo: number; hi: number; ts: number; touches?: number }
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

/**
 * Johnny's zone (Sep 28): union of wicks, in time order. A candle leaves a wick at the edge -> that wick is
 * the zone. The next candle touches the zone with its WICK -> its wick is joined (union), a bit higher or a
 * bit lower. The next one touches the JOINED zone -> joined too, and so on.
 * Top zone: wick = body top -> high; a candle touches when its high reaches the zone and its body does not
 * close above it (a body through the zone is a move, not a wick). Bottom zone mirrored (low -> body bottom).
 * Start: the FIRST candle whose chain of touching wicks reaches the extreme candle (`seed`); the search does
 * not go back past `floor` (the other extreme of the frame).
 */
export function widenZone(c: readonly K[], seed: number, side: "TOP" | "BOTTOM", floor = -1): Zone {
  const wickLo = (k: K): number => (side === "TOP" ? Math.max(k.open, k.close) : k.low);
  const wickHi = (k: K): number => (side === "TOP" ? k.high : Math.min(k.open, k.close));
  const chain = (start: number): { lo: number; hi: number; n: number; hasSeed: boolean } => {
    let lo = wickLo(c[start]), hi = wickHi(c[start]), n = 1, hasSeed = start === seed;
    for (let i = start + 1; i < c.length; i++) {
      const k = c[i];
      const touches = side === "TOP" ? k.high >= lo && Math.max(k.open, k.close) <= hi : k.low <= hi && Math.min(k.open, k.close) >= lo;
      if (!touches) continue;
      lo = Math.min(lo, wickLo(k)); hi = Math.max(hi, wickHi(k)); n++;
      if (i === seed) hasSeed = true;
    }
    return { lo, hi, n, hasSeed };
  };
  for (let s = Math.max(0, floor + 1); s <= seed; s++) {
    const r = chain(s);
    if (r.hasSeed) return { lo: r.lo, hi: r.hi, ts: c[s].ts, touches: r.n };
  }
  const r = chain(seed);
  return { lo: r.lo, hi: r.hi, ts: c[seed].ts, touches: r.n };
}

/** The frame with both zones built from the joined wicks. */
export function widenFrame(c: readonly K[], f: Frame | null): Frame | null {
  if (!f) return null;
  const idx = (z: Zone | null): number => (z ? c.findIndex((k) => k.ts === z.ts) : -1);
  const iTop = idx(f.top), iBot = idx(f.bottom);
  if (f.last === "PEAK") return { last: f.last, top: iTop >= 0 ? widenZone(c, iTop, "TOP", -1) : null, bottom: iBot >= 0 ? widenZone(c, iBot, "BOTTOM", iTop) : null };
  return { last: f.last, bottom: iBot >= 0 ? widenZone(c, iBot, "BOTTOM", -1) : null, top: iTop >= 0 ? widenZone(c, iTop, "TOP", iBot) : null };
}

export type Verdict = "IN_ZONE" | "MIDDLE" | "NO_FRAME";
/** Where the cleaning pushed the price (tested = episode low for a BUY, high for a SELL) vs the frame. */
export function verdictOf(f: Frame | null, long: boolean, tested: number): { verdict: Verdict; pierced: boolean; pos: number } {
  if (!f || !f.top || !f.bottom) return { verdict: "NO_FRAME", pierced: false, pos: NaN };
  const pos = (100 * (tested - f.bottom.lo)) / (f.top.hi - f.bottom.lo);
  if (long) return tested <= f.bottom.hi ? { verdict: "IN_ZONE", pierced: tested < f.bottom.lo, pos } : { verdict: "MIDDLE", pierced: false, pos };
  return tested >= f.top.lo ? { verdict: "IN_ZONE", pierced: tested > f.top.hi, pos } : { verdict: "MIDDLE", pierced: false, pos };
}

/** Did not reach our zone, but stopped within one zone-height of it (the zone's own size, no %). */
export function nearZone(f: Frame | null, long: boolean, tested: number): boolean {
  const z = f ? (long ? f.bottom : f.top) : null;
  if (!z || !Number.isFinite(tested)) return false;
  const h = z.hi - z.lo;
  return long ? tested > z.hi && tested <= z.hi + h : tested < z.lo && tested >= z.lo - h;
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

/** One SVG chart: 4h candles, the two zones, the tested price and the entry. */
export function frameSvg(candles: readonly K[], f: Frame | null, o: { title: string; long: boolean; episodeStart: number; at: number; tested: number; entry: number; verdict: string; good: boolean | null }): string {
  const W = 960, Hh = 340, L = 8, R = 78, T = 28, B = 22;
  if (!candles.length) return `<p>${o.title}: no candles</p>`;
  const t0 = candles[0].ts, t1 = candles[candles.length - 1].ts + H4;
  let lo = Math.min(...candles.map((c) => c.low)), hi = Math.max(...candles.map((c) => c.high));
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const x = (t: number): number => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (p: number): number => T + ((hi - p) / (hi - lo)) * (Hh - T - B);
  const cw = Math.max(2, ((W - L - R) / candles.length) * 0.7);
  const parts: string[] = [];
  const zone = (z: Zone | null, cls: string, label: string): void => {
    if (!z) return;
    const yTop = y(z.hi), yBot = y(z.lo);
    parts.push(`<rect x="${x(z.ts)}" y="${yTop}" width="${x(o.episodeStart) - x(z.ts)}" height="${Math.max(2, yBot - yTop)}" class="${cls}"/>`);
    parts.push(`<text x="${x(z.ts) + 4}" y="${cls === "ztop" ? yTop - 4 : yBot + 13}" class="lbl ${cls}t">${label} ${fp(z.lo)}-${fp(z.hi)}</text>`);
  };
  zone(f?.top ?? null, "ztop", "TOP");
  zone(f?.bottom ?? null, "zbot", "BOTTOM");
  for (const c of candles) {
    const up = c.close >= c.open, cx = x(c.ts + H4 / 2);
    parts.push(`<line x1="${cx}" x2="${cx}" y1="${y(c.high)}" y2="${y(c.low)}" class="${up ? "up" : "dn"}"/>`);
    parts.push(`<rect x="${cx - cw / 2}" y="${y(Math.max(c.open, c.close))}" width="${cw}" height="${Math.max(1, Math.abs(y(c.open) - y(c.close)))}" class="${up ? "upb" : "dnb"}"/>`);
  }
  parts.push(`<line x1="${x(o.episodeStart)}" x2="${x(o.episodeStart)}" y1="${T}" y2="${Hh - B}" class="ep"/>`);
  parts.push(`<line x1="${x(o.episodeStart)}" x2="${x(o.at) + 40}" y1="${y(o.tested)}" y2="${y(o.tested)}" class="tested"/>`);
  parts.push(`<circle cx="${x(o.at)}" cy="${y(o.entry)}" r="5" class="${o.long ? "buy" : "sell"}"/>`);
  parts.push(`<text x="${x(o.at) - 8}" text-anchor="end" y="${y(o.entry) + (o.long ? 18 : -10)}" class="lbl">${o.long ? "BUY" : "SELL"} ${fp(o.entry)}  (cleaning reached ${fp(o.tested)})</text>`);
  for (let d = Math.ceil(t0 / DAY) * DAY; d < t1; d += DAY) parts.push(`<text x="${x(d)}" y="${Hh - 6}" class="ax">${new Date(d).toISOString().slice(5, 10)}</text><line x1="${x(d)}" x2="${x(d)}" y1="${T}" y2="${Hh - B}" class="grid"/>`);
  for (let i = 0; i <= 4; i++) { const p = lo + ((hi - lo) * i) / 4; parts.push(`<text x="${W - R + 4}" y="${y(p) + 4}" class="ax">${fp(p)}</text>`); }
  const badge = o.good === null ? "" : o.good ? " ✅" : " ❌";
  return `<div class="card"><h3>${o.title}${badge} — <span class="${o.verdict.startsWith("IN_ZONE") ? "ok" : "bad"}">${o.verdict}</span></h3><svg viewBox="0 0 ${W} ${Hh}" width="100%">${parts.join("")}</svg></div>`;
}

export function frameHtml(cards: string[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>V9 frame check</title><style>
body{background:#0b0e11;color:#eaecef;font:14px system-ui,sans-serif;margin:16px}h1{font-size:18px}h3{font-size:14px;margin:6px 0}
.card{background:#161a1e;border-radius:8px;padding:8px 12px;margin:0 0 14px}
.up{stroke:#0ecb81}.dn{stroke:#f6465d}.upb{fill:#0ecb81}.dnb{fill:#f6465d}
.ztop{fill:rgba(246,70,93,.22);stroke:#f6465d;stroke-width:1}.zbot{fill:rgba(14,203,129,.22);stroke:#0ecb81;stroke-width:1}
.ztopt{fill:#f6465d}.zbott{fill:#0ecb81}.ep{stroke:#f0b90b;stroke-dasharray:4 4}.tested{stroke:#f0b90b;stroke-width:2}
.buy{fill:#0ecb81;stroke:#fff}.sell{fill:#f6465d;stroke:#fff}.lbl{fill:#eaecef;font-size:12px}.ax{fill:#848e9c;font-size:11px}.grid{stroke:#2b3139}
.ok{color:#0ecb81}.bad{color:#f6465d}</style></head><body><h1>V9 frame check (4h, Binance candles)</h1>
<p>Green box = BOTTOM zone, red box = TOP zone (from the candle that made it to the episode start). Dashed yellow = episode start, solid yellow = how far the cleaning pushed the price. Dot = entry. ✅/❌ = the real result.</p>
${cards.join("\n")}</body></html>`;
}

interface Case { symbol: string; long: boolean; episodeStart: number; confirmTs: number; at: number; entry: number; selected: boolean; weak: boolean; forced: number; forcedMed: number; real?: Res & { label: string } }
interface Row { c: Case; frame: Frame | null; tested: number; v: ReturnType<typeof verdictOf>; t1h: number; sim: Res; wide: Frame | null; vw: ReturnType<typeof verdictOf>; near: boolean; confirmPx: number; left: boolean | null }

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
    // FORCED (as live): victims' liquidations $ / the OI $ the cleaning closed, vs this coin's median of its
    // decisions in the 3 days before. Live numbers when stored (from Sep 27), else recomputed like v9-whatif.
    const oiAt = new Map<string, Map<number, number>>();
    for (const sym of [...new Set(decisions.map((d) => String(d.symbol)))]) {
      const first = Math.min(...decisions.filter((d) => d.symbol === sym).map((d) => num(d.episodeStart)));
      const rows = await db.collection("minute_bars").find({ symbol: sym, ts: { $gte: new Date(first - MIN) } }).project({ ts: 1, oiLast: 1 }).toArray();
      oiAt.set(sym, new Map(rows.map((r) => [num(r.ts), Number(r.oiLast)])));
    }
    const forcedOf = (d: (typeof decisions)[number]): number => {
      const m = oiAt.get(String(d.symbol));
      let oi = NaN;
      for (let t = Math.floor(num(d.episodeStart) / MIN) * MIN, i = 0; i < 5 && !(oi > 0); i++, t += MIN) oi = m?.get(t) ?? NaN;
      const drop = Number(d.episode?.oiDropPct), liq = Number(d.features?.victimLiq), px = Number(d.referencePrice);
      return oi > 0 && drop > 0 && px > 0 ? liq / ((drop / 100) * oi * px) : NaN;
    };
    const median = (v: number[]): number => { const a = v.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
    const forcedCache = new Map<string, number>(decisions.map((d) => [String(d.signalId), forcedOf(d)]));
    const quality = (d: (typeof decisions)[number]): { weak: boolean; forced: number; forcedMed: number } => {
      const q = d.quality as { forcedPct: number; forcedMedianPct: number; weak: boolean } | null | undefined;
      if (q) return { weak: !!q.weak, forced: q.forcedPct / 100, forcedMed: q.forcedMedianPct / 100 };
      const c = num(d.confirmTs);
      const prior = decisions.filter((x) => x.symbol === d.symbol && num(x.confirmTs) < c && num(x.confirmTs) >= c - 3 * DAY);
      const f = forcedCache.get(String(d.signalId)) ?? NaN, med = median(prior.map((x) => forcedCache.get(String(x.signalId)) ?? NaN));
      return { weak: Number.isFinite(med) && Number.isFinite(f) && f < med, forced: f, forcedMed: med };
    };
    const trades = await db.collection("v9_trades").find({ userId: user, entryPrice: { $ne: null } }).sort({ createdAt: 1 }).toArray();

    const cases: Case[] = [...byEp.values()].map((d) => ({
      symbol: String(d.symbol), long: d.victim === "LONG", episodeStart: num(d.episodeStart), confirmTs: num(d.confirmTs), at: num(d.evaluatedAt),
      entry: Number(d.referencePrice), selected: d.reason === "SELECTED", ...quality(d),
    }));
    // the real signals use the user's real fill and the real result
    const realCases: Case[] = [];
    for (const t of trades) {
      const d = decisions.find((x) => x.signalId === t.signalId);
      if (!d) continue;
      const label = t.state === "CLOSED" ? (t.closeReason === "TP_FILLED" ? "TP" : t.closeReason === "SL_FILLED" ? "SL" : String(t.closeReason ?? "?")) : String(t.state);
      realCases.push({ symbol: String(t.symbol), long: t.side === "LONG", episodeStart: num(d.episodeStart), confirmTs: num(d.confirmTs), at: num(t.createdAt), entry: Number(t.entryPrice), selected: true, ...quality(d),
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
      const wide = widenFrame(w4, frame);
      const vw = verdictOf(wide, c.long, tested);
      // the moment the other side's liquidations confirmed: is the price still in our zone, or already out of it?
      let confirmPx = NaN;
      for (const k of m1) { if (k.ts > c.confirmTs) break; confirmPx = k.close; }
      const wz = wide ? (c.long ? wide.bottom : wide.top) : null;
      const left = wz && Number.isFinite(confirmPx) ? (c.long ? confirmPx > wz.hi : confirmPx < wz.lo) : null;
      const near = vw.verdict === "MIDDLE" && nearZone(wide, c.long, tested);
      return { c, frame, tested, v, t1h, sim, wide, vw, near, confirmPx, left };
    };
    const z = (zn: Zone | null | undefined): string => (zn ? `${fp(zn.lo)}-${fp(zn.hi)}` : "none").padStart(17);
    const line = (r: Row, res: string, netR: number): string =>
      `${stamp(r.c.at)}  ${r.c.symbol.padEnd(9)} ${r.c.long ? "BUY " : "SELL"}  ${`${res} ${netR >= 0 ? "+" : ""}${netR.toFixed(2)}`.padEnd(11)} ${(r.frame?.last ?? "-").padEnd(6)} top ${z(r.wide?.top)} x${r.wide?.top?.touches ?? 0}  bottom ${z(r.wide?.bottom)} x${r.wide?.bottom?.touches ?? 0}  tested ${fp(r.tested).padStart(8)}  ${(Number.isFinite(r.vw.pos) ? `${Math.round(r.vw.pos)}` : "-").padStart(4)}  ${r.c.weak ? "weak" : "ok  "}  ${r.v.verdict.padEnd(8)} ${r.vw.verdict}${r.near ? " but NEAR" : ""}${r.vw.pierced ? " (pierced)" : ""}${r.vw.verdict === "IN_ZONE" ? (r.left ? ", LEFT zone at confirm" : ", still in zone at confirm") : ""}`;
    const head = "ENTRY UTC    SYMBOL    SIDE  RESULT      LAST   top zone (all wicks)  xN       bottom zone (all wicks)  xN     tested       pos  FORCED 1st-wick  ALL WICKS (FRAME+)";

    type Sum = { n: number; tp: number; sl: number; time: number; net: number };
    const RULES: Array<[string, (r: Row) => boolean]> = [
      ["all (no filter)", () => true],
      ["FORCED", (r) => !r.c.weak],
      ["FRAME (in zone)", (r) => r.v.verdict === "IN_ZONE"],
      ["FORCED + FRAME", (r) => !r.c.weak && r.v.verdict === "IN_ZONE"],
      ["FRAME+ (wicks)", (r) => r.vw.verdict === "IN_ZONE"],
      ["FORCED + FRAME+", (r) => !r.c.weak && r.vw.verdict === "IN_ZONE"],
      ["FRAME+ in@conf", (r) => r.vw.verdict === "IN_ZONE" && r.left === false],
      ["FRAME+ left@conf", (r) => r.vw.verdict === "IN_ZONE" && r.left === true],
      ["FRAME+ or NEAR", (r) => r.vw.verdict === "IN_ZONE" || r.near],
      ["-- NEAR only", (r) => r.near],
      ["-- middle (+)", (r) => r.vw.verdict === "MIDDLE" && !r.near],
      ["-- no frame", (r) => r.vw.verdict === "NO_FRAME"],
    ];
    const tally = (rows: Array<{ r: Row; res: Res }>, name: string): void => {
      const span = rows.length ? (Math.max(...rows.map((x) => x.r.c.at)) - Math.min(...rows.map((x) => x.r.c.at))) / DAY : 0;
      console.log(`\n--- ${name} (${span.toFixed(1)} days) ---`);
      for (const [label, pick] of RULES) {
        const t: Sum = { n: 0, tp: 0, sl: 0, time: 0, net: 0 };
        for (const x of rows) {
          if (!pick(x.r)) continue;
          t.n++; t.net += x.res.netR;
          if (x.res.result === "TP") t.tp++; else if (x.res.result === "SL") t.sl++; else if (x.res.result === "TIME") t.time++;
        }
        console.log(`${label.padEnd(16)} trades ${String(t.n).padStart(3)} (${span > 0 ? (t.n / span).toFixed(1) : "-"}/day)  TP ${String(t.tp).padStart(3)}  SL ${String(t.sl).padStart(3)}  24h ${String(t.time).padStart(2)}  win ${t.tp + t.sl ? `${Math.round((100 * t.tp) / (t.tp + t.sl))}%`.padStart(4) : " n/a"}  netR ${t.net >= 0 ? "+" : ""}${t.net.toFixed(2).padStart(6)}  avg ${t.n ? (t.net / t.n).toFixed(2) : "n/a"}R`);
      }
    };

    // 1. the real signals
    console.log(`\n=== 1. THE ${realCases.length} REAL V9 SIGNALS OF "${user}" vs THE 4h FRAME (last ${LOOK_DAYS} days before each episode) ===`);
    console.log(head);
    const realRows = realCases.map(evaluate);
    for (const r of realRows) console.log(line(r, r.c.real!.label, r.c.real!.netR));
    tally(realRows.map((r) => ({ r, res: r.c.real! })), "real signals, real results");

    const htmlPath = argv.includes("--html") ? arg("html", "frame.html") : null;
    if (htmlPath) {
      const fs = await import("fs");
      const cards = realRows.map((r) => {
        const c4 = data.get(r.c.symbol)!.c4.filter((k) => k.ts >= r.c.episodeStart - LOOK_DAYS * DAY && k.ts <= r.c.at + 2 * DAY);
        return frameSvg(c4, r.wide, { title: `${stamp(r.c.at)} UTC  ${r.c.symbol} ${r.c.long ? "BUY" : "SELL"}  ${r.c.real!.label} ${r.c.real!.netR.toFixed(2)}R  FORCED ${r.c.weak ? "weak" : "ok"}`,
          long: r.c.long, episodeStart: r.c.episodeStart, at: r.c.at, tested: r.tested, entry: r.c.entry, verdict: r.vw.verdict + (r.near ? " but NEAR" : "") + (r.vw.pierced ? " (pierced)" : "") + (r.vw.verdict === "IN_ZONE" ? (r.left ? ", left the zone at confirm" : ", still in the zone at confirm") : ""), good: r.c.real!.result === "TP" ? true : r.c.real!.result === "SL" ? false : null });
      });
      fs.writeFileSync(htmlPath, frameHtml(cards));
      console.log(`\ncharts written to ${htmlPath}`);
    }

    // 2. every confirmed episode, simulated
    const all = cases.map(evaluate).filter((r) => Number.isFinite(r.tested));
    console.log(`\n=== 2. EVERY CONFIRMED EPISODE (${all.length}, one per episode), simulated: OLD stop, TP 2.2R, closed after 24h ===`);
    if (list) { console.log(head); for (const r of all) console.log(line(r, r.sim.result, r.sim.netR)); }
    tally(all.map((r) => ({ r, res: r.sim })), "all confirmed episodes (V9 checks ignored)");
    tally(all.filter((r) => r.c.selected).map((r) => ({ r, res: r.sim })), "only the ones V9 selected (signals)");
    tally(all.filter((r) => !r.c.selected).map((r) => ({ r, res: r.sim })), "only the ones V9 did NOT select");
    const open = all.filter((r) => r.sim.result === "OPEN").length;
    console.log(`\n(${open} still open, counted as 0R.) pos: 0 = frame bottom, 100 = frame top. 1h = 1h swings that touched the zone.`);
    console.log("LAST: PEAK = the last extreme was the top (went up then down), BOTTOM = the last extreme was the low.");
    console.log("FRAME = zone from the first wick only; FRAME+ = union of the 4h wicks that touched the zone, in time order, from the first candle that reached it (xN = wicks joined).");
    console.log("NEAR = did not reach the zone but stopped within one zone-height of it.");
    console.log("in@conf / left@conf: FRAME+ signals where, when the other side's liquidations confirmed, the price was still in our zone / already out of it.");
    console.log("IN_ZONE: BUY with the episode low in the bottom zone, SELL with the high in the top zone. MIDDLE: inside the frame but not at our edge. NO_FRAME: the other side not formed yet.");
  } finally {
    await client.close();
  }
}

if (require.main === module) main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
