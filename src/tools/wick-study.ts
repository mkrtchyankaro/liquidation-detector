/**
 * THE WICK STUDY (Johnny, Oct 8 2026) -- research, read-only, text only.
 * Every 4h and 1d candle's wicks (upper = body top -> high, lower = low -> body bottom): what happened IN the wick.
 * The wick's EXCURSION = from the last 1m candle at the body edge before the extreme, to the extreme, and back to the
 * first 1m candle at the body edge after it (or the candle's end). Measured over the excursion:
 *   OI     our minute_bars: OI change body-edge -> extreme -> back, % of the OI at the excursion's start
 *   LIQ    our liq_raw_events: $ longs / $ shorts liquidated in the excursion's minutes at a price inside the wick
 *   TAKER  Binance 1m: (taker buy - taker sell) / volume  (+ = buyers hit the market, - = sellers)
 *   VOL    the excursion's volume per minute / the coin's average volume per minute over the period
 *   SPEED  wick size % / minutes to the extreme
 * STRONG = not big: a measure in the top --top % of all wicks of the same timeframe (|OI|, LIQ $, |TAKER|, VOL, SPEED)
 * 1d <-> 4h: for each daily wick, the day's 4h wicks that overlap it (* = holds the day's extreme)
 * WHERE WICKS MEET: the price ranges covered by the most wicks (upper wicks and lower wicks apart), local maxima only,
 *   one place per group of wicks (a place whose wicks are mostly in a place already shown is skipped)
 *
 *   npx tsx src/tools/wick-study.ts --symbol XRPUSDT
 *   options: --top 10   --levels 5
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const M = 60_000,
  H = 60 * M,
  H4 = 4 * H,
  D = 24 * H;
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const px = (v: number): string => String(+v.toPrecision(5));
const usd = (v: number): string =>
  v >= 1e6
    ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1e3
      ? `$${(v / 1e3).toFixed(0)}k`
      : `$${v.toFixed(0)}`;
const sg = (v: number, d = 2): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "  n/a";
const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length);
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});

interface K {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  tb: number;
}
interface Liq {
  t: number;
  long: boolean;
  usd: number;
  p: number;
}
interface Wick {
  tf: "4h" | "1d";
  up: boolean;
  ct: number;
  lo: number;
  hi: number;
  sizePct: number;
  extT: number;
  t0: number;
  t1: number;
  minUp: number;
  minBack: number;
  oiTo: number;
  oiBack: number;
  liqL: number;
  liqS: number;
  taker: number;
  vol: number;
  speed: number;
  tags: string[];
}

async function klines(
  symbol: string,
  interval: string,
  from: number,
  to: number,
): Promise<K[]> {
  const out: K[] = [];
  for (let s = from; s < to; ) {
    const rows: unknown[][] = (
      await fapi.get("/fapi/v1/klines", {
        params: {
          symbol,
          interval,
          startTime: s,
          endTime: to - 1,
          limit: 1500,
        },
      })
    ).data;
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows)
      out.push({
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5]),
        tb: Number(r[9]),
      });
    s = Number(rows[rows.length - 1][0]) + 1;
    if (rows.length < 1500) break;
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const sym = arg("symbol", "XRPUSDT").toUpperCase(),
    TOP = Number(arg("top", "10")),
    LEVELS = Number(arg("levels", "5"));
  const now = Date.now();
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const first = await db
      .collection("liq_raw_events")
      .find({ symbol: sym })
      .project({ _id: 0, timestamp: 1 })
      .sort({ timestamp: 1 })
      .limit(1)
      .toArray();
    if (!first.length) {
      console.log(`${sym}: no liquidations in our DB`);
      return;
    }
    const from = Math.ceil(Number(first[0].timestamp) / D) * D; // the first full day with our data
    const end = Math.floor(now / H4) * H4; // only closed 4h candles
    const m1 = await klines(sym, "1m", from, end);
    const c4 = (await klines(sym, "4h", from, end)).filter(
      (x) => x.t + H4 <= end,
    );
    const c1 = (await klines(sym, "1d", from, end)).filter(
      (x) => x.t + D <= end,
    );
    const idx = new Map<number, number>();
    m1.forEach((x, i) => idx.set(x.t, i));
    const bars = await db
      .collection(MINUTE_BARS)
      .find({
        symbol: sym,
        oiLast: { $gt: 0 },
        ts: { $gte: new Date(from - H) },
      })
      .project({ _id: 0, ts: 1, oiLast: 1 })
      .toArray();
    const oi = new Map<number, number>();
    for (const b of bars) oi.set((b.ts as Date).getTime(), Number(b.oiLast));
    const oiAt = (t: number): number => {
      for (let k = 0; k < 5; k++) {
        const v = oi.get(t - k * M);
        if (v !== undefined) return v;
      }
      return NaN;
    };
    const liqs: Liq[] = (
      await db
        .collection("liq_raw_events")
        .find({
          symbol: sym,
          victim: { $in: ["LONG", "SHORT"] },
          timestamp: { $gte: from },
        })
        .project({ _id: 0, timestamp: 1, victim: 1, quoteQty: 1, price: 1 })
        .toArray()
    )
      .map((d) => ({
        t: Number(d.timestamp),
        long: d.victim === "LONG",
        usd: Number(d.quoteQty),
        p: Number(d.price),
      }))
      .filter((x) => x.p > 0)
      .sort((a, b) => a.t - b.t);
    const avgVol = m1.reduce((a, x) => a + x.v, 0) / Math.max(1, m1.length);

    const wicksOf = (k: K, tf: "4h" | "1d", len: number): Wick[] => {
      const out: Wick[] = [];
      const i0 = idx.get(k.t),
        i1 = idx.get(k.t + len - M);
      if (i0 === undefined || i1 === undefined) return out;
      const top = Math.max(k.o, k.c),
        bot = Math.min(k.o, k.c);
      for (const up of [true, false]) {
        const lo = up ? top : k.l,
          hi = up ? k.h : bot;
        if (!(hi > lo)) continue;
        // the extreme minute, then out to the body edge on both sides
        let e = i0;
        for (let i = i0; i <= i1; i++)
          if (up ? m1[i].h > m1[e].h : m1[i].l < m1[e].l) e = i;
        const atEdge = (i: number): boolean =>
          up ? m1[i].l <= top : m1[i].h >= bot;
        let a = e;
        while (a > i0 && !atEdge(a - 1)) a--;
        if (a > i0) a--;
        let b = e;
        while (b < i1 && !atEdge(b + 1)) b++;
        if (b < i1) b++;
        const t0 = m1[a].t,
          t1 = m1[b].t + M;
        let v = 0,
          tb = 0;
        for (let i = a; i <= b; i++) {
          v += m1[i].v;
          tb += m1[i].tb;
        }
        const o0 = oiAt(m1[a].t),
          oe = oiAt(m1[e].t),
          o1 = oiAt(m1[b].t);
        let liqL = 0,
          liqS = 0;
        for (const q of liqs) {
          if (q.t < t0) continue;
          if (q.t >= t1) break;
          if (q.p >= lo && q.p <= hi) {
            if (q.long) liqL += q.usd;
            else liqS += q.usd;
          }
        }
        const sizePct = (100 * (hi - lo)) / lo,
          minUp = e - a,
          minBack = b - e;
        out.push({
          tf,
          up,
          ct: k.t,
          lo,
          hi,
          sizePct,
          extT: m1[e].t,
          t0,
          t1,
          minUp,
          minBack,
          oiTo: (100 * (oe - o0)) / o0,
          oiBack: (100 * (o1 - oe)) / o0,
          liqL,
          liqS,
          taker: v > 0 ? (2 * tb - v) / v : 0,
          vol: v / (b - a + 1) / avgVol,
          speed: sizePct / Math.max(1, minUp),
          tags: [],
        });
      }
      return out;
    };
    const w4 = c4.flatMap((k) => wicksOf(k, "4h", H4)),
      w1 = c1.flatMap((k) => wicksOf(k, "1d", D));

    // STRONG: top TOP % within the same timeframe, per measure
    const tag = (ws: Wick[]): void => {
      const ms: [string, (w: Wick) => number][] = [
        ["OI", (w) => Math.abs(w.oiTo) + Math.abs(w.oiBack)],
        ["LIQ", (w) => w.liqL + w.liqS],
        ["TAKER", (w) => Math.abs(w.taker)],
        ["VOL", (w) => w.vol],
        ["SPEED", (w) => w.speed],
      ];
      for (const [name, f] of ms) {
        const vals = ws
          .map(f)
          .filter(Number.isFinite)
          .sort((x, y) => y - x);
        if (!vals.length) continue;
        const cut = vals[Math.max(0, Math.ceil((vals.length * TOP) / 100) - 1)];
        for (const w of ws)
          if (Number.isFinite(f(w)) && f(w) >= cut && f(w) > 0)
            w.tags.push(name);
      }
    };
    tag(w4);
    tag(w1);

    const row = (w: Wick): string =>
      `${pad(utc(w.ct), 12)} ${w.up ? "▲up " : "▼low"} ${pad(`${px(w.lo)}–${px(w.hi)}`, 16)} ${pad(w.sizePct.toFixed(2) + "%", 6)} ` +
      `${pad(`${w.minUp}m/${w.minBack}m`, 10)} OI ${pad(`${sg(w.oiTo)}/${sg(w.oiBack)}%`, 15)} ` +
      `liq L ${pad(usd(w.liqL), 7)} S ${pad(usd(w.liqS), 7)} taker ${pad(sg(100 * w.taker, 0) + "%", 5)} vol ${pad(w.vol.toFixed(1) + "x", 5)} ` +
      `${w.tags.length ? "★ " + w.tags.join(",") : ""}`;
    const head = `  candle        wick range            size   to/back    OI to extreme/back   liquidated in the wick     taker      vol`;

    console.log(
      `\n═══ ${sym} · ${utc(from)} → ${utc(end)} UTC · ${c1.length} days, ${c4.length} 4h candles · STRONG ★ = top ${TOP}% of that timeframe ═══`,
    );
    console.log(
      `  to/back = minutes body edge -> extreme / extreme -> body edge · OI % of the OI at the start · taker + = buyers, - = sellers`,
    );

    console.log(
      `\n── 1d WICKS, each with the day's 4h wicks that overlap it (* = made the day's extreme) ──`,
    );
    console.log(head);
    for (const d of w1) {
      console.log(`  ${row(d)}`);
      for (const w of w4)
        if (
          w.up === d.up &&
          w.ct >= d.ct &&
          w.ct < d.ct + D &&
          w.lo <= d.hi &&
          w.hi >= d.lo
        )
          console.log(`   ${w.extT === d.extT ? "*" : " "}${row(w)}`);
    }

    const strong4 = w4.filter((w) => w.tags.length);
    console.log(`\n── 4h STRONG WICKS (${strong4.length} of ${w4.length}) ──`);
    console.log(head);
    for (const w of strong4) console.log(`  ${row(w)}`);

    // WHERE WICKS MEET: sweep the price over all wick ranges; local maxima of the cover count
    const lastPrice = m1.length ? m1[m1.length - 1].c : NaN;
    console.log(
      `\n── WHERE THE WICKS MEET (price ranges covered by the most wicks; now ${px(lastPrice)}) ──`,
    );
    for (const up of [true, false]) {
      const ws = [...w4, ...w1].filter((w) => w.up === up);
      const pts = [...new Set(ws.flatMap((w) => [w.lo, w.hi]))].sort(
        (a, b) => a - b,
      );
      const segs: { lo: number; hi: number; in: Wick[] }[] = [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const lo = pts[i],
          hi = pts[i + 1],
          inn = ws.filter((w) => w.lo <= lo && w.hi >= hi);
        const key = (x: Wick[]): string =>
          x.map((w) => `${w.tf}${w.ct}`).join();
        if (segs.length && key(segs[segs.length - 1].in) === key(inn))
          segs[segs.length - 1].hi = hi;
        else segs.push({ lo, hi, in: inn });
      }
      const score = (s: { in: Wick[] }): number => s.in.length;
      const cands = segs
        .filter(
          (s, i) =>
            s.in.length >= 2 &&
            score(s) >= score(segs[i - 1] ?? { in: [] }) &&
            score(s) >= score(segs[i + 1] ?? { in: [] }),
        )
        .sort(
          (a, b) =>
            b.in.filter((w) => w.tags.length).length -
              a.in.filter((w) => w.tags.length).length ||
            b.in.length - a.in.length,
        );
      // one place per group of wicks: skip a place when most of its wicks are already in a place taken
      const peaks: typeof cands = [],
        used = new Set<Wick>();
      for (const s of cands) {
        if (peaks.length >= LEVELS) break;
        if (s.in.filter((w) => used.has(w)).length * 2 > s.in.length) continue;
        peaks.push(s);
        for (const w of s.in) used.add(w);
      }
      console.log(
        `\n  ${up ? "▲ UPPER wicks (sellers pushed back)" : "▼ LOWER wicks (buyers pushed back)"}`,
      );
      for (const s of peaks.sort((a, b) => b.lo - a.lo)) {
        const st = s.in.filter((w) => w.tags.length),
          n1 = s.in.filter((w) => w.tf === "1d").length;
        let L = 0,
          S = 0;
        for (const w of s.in) {
          L += w.liqL;
          S += w.liqS;
        }
        console.log(
          `  ${pad(`${px(s.lo)}–${px(s.hi)}`, 16)} ${s.in.length} wicks (1d ${n1}, 4h ${s.in.length - n1}) · strong ${st.length} · liq in those wicks L ${usd(L)} S ${usd(S)}`,
        );
        console.log(
          `  ${" ".repeat(16)} strong: ${st.map((w) => `${w.tf} ${utc(w.ct).slice(0, 8)} ${w.tags.join(",")}`).join(" · ") || "-"}`,
        );
      }
      if (!peaks.length) console.log("  (no place where 2+ wicks meet)");
    }
    console.log(
      `\n(our liquidations: max 1 per second per coin, so the $ are lower than Binance's real totals; ~14 days kept)`,
    );
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
