/**
 * HOW TO FIND A ZONE IN NUMBERS -- research, not a rule (Johnny, Oct 7 2026). Read-only.
 * Data: OUR DB for OI (minute_bars, per minute) and liquidations (liq_raw_events, kept ~14 days); Binance 1h klines for
 * the price, the volume and the taker-buy share (our DB has no volume). Period: from the coin's first liquidation in our
 * DB (or --days) to now.
 * Every 1h BOTTOM (the lowest low of +-12h) and TOP (the highest high of +-12h), with the 4 steps seen at ENA 10-02 /
 * ALGO 09-30 / 10-01 -- "big" and "small" are the coin's OWN percentiles over the period, no fixed numbers:
 *   1 CLEANING  OI over the 6h before the extreme fell more than the coin's usual (6h OI change <= its 25th percentile)
 *   2 EXTREME   the extreme candle: the aggressive side pushed it (BOTTOM: buy% <= its 30th pct; TOP: buy% >= its 70th)
 *               or a liquidation wave (BOTTOM: longs liq >= its 90th pct of hours; TOP: shorts liq)
 *   3 STOPPED   the 3h after: the push ended -- liquidations of that side small (each hour <= its median) and either the
 *               volume halved vs the extreme candle or the other side took over (BOTTOM: avg buy% >= its 60th pct)
 *   4 REBUILT   the 6h after: OI grew (> 0) and the price never went beyond the extreme
 *   zone = BOTTOM: the low .. the lower of open / close of the extreme candle · TOP: the higher of open / close .. the high
 *   later: the first time the price came back into the zone (after the 6h) -- HELD (moved 2 ATR away from it before a 1h
 *          close beyond it) / BROKE (a 1h close beyond it first) / open (neither yet) / never came back
 *
 *   npx tsx src/tools/bottom-top-scan.ts --symbols SOLUSDT,XRPUSDT
 *   options: --days 14 (max; it starts at the coin's first liquidation in our DB)
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
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number, d = 2): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "n/a";
const px = (v: number): string => String(+v.toPrecision(5));
const usd = (v: number): string =>
  v >= 1e6
    ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1e3
      ? `$${(v / 1e3).toFixed(1)}k`
      : `$${v.toFixed(0)}`;
const H = 3_600_000,
  D = 24 * H;
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const pct = (a: number[], p: number): number => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length
    ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
    : NaN;
};

interface Hr {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  buy: number;
  oi0: number;
  oi1: number;
  liqL: number;
  liqS: number;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const syms = arg("symbols", "SOLUSDT,XRPUSDT")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const days = Number(arg("days", "14")),
    now = Math.floor(Date.now() / H) * H;
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const all: Array<{
      sym: string;
      held: boolean | null;
      steps: number;
      kind: string;
    }> = [];
    for (const sym of syms) {
      const first = await db
        .collection("liq_raw_events")
        .find({ symbol: sym })
        .project({ timestamp: 1 })
        .sort({ timestamp: 1 })
        .limit(1)
        .toArray();
      const from = Math.max(
        now - days * D,
        first.length
          ? Math.ceil(Number(first[0].timestamp) / H) * H
          : now - days * D,
      );
      const k: unknown[][] = (
        await fapi.get("/fapi/v1/klines", {
          params: {
            symbol: sym,
            interval: "1h",
            startTime: from,
            endTime: now - 1,
            limit: 1500,
          },
        })
      ).data;
      const oi = new Map(
        (
          await db
            .collection(MINUTE_BARS)
            .find({
              symbol: sym,
              oiLast: { $gt: 0 },
              ts: { $gte: new Date(from - 2 * H), $lt: new Date(now) },
            })
            .project({ ts: 1, oiLast: 1 })
            .toArray()
        ).map((d) => [(d.ts as Date).getTime(), Number(d.oiLast)]),
      );
      const oiAt = (t: number): number => {
        for (let x = t - 60_000; x > t - 15 * 60_000; x -= 60_000) {
          const v = oi.get(x);
          if (v !== undefined) return v;
        }
        return NaN;
      };
      const liqs = await db
        .collection("liq_raw_events")
        .find({
          symbol: sym,
          victim: { $in: ["LONG", "SHORT"] },
          timestamp: { $gte: from, $lt: now },
        })
        .project({ timestamp: 1, victim: 1, quoteQty: 1 })
        .toArray();
      const hrs: Hr[] = k.map((r) => ({
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5]),
        buy: Number(r[5]) > 0 ? (100 * Number(r[9])) / Number(r[5]) : NaN,
        oi0: oiAt(Number(r[0])),
        oi1: oiAt(Number(r[0]) + H),
        liqL: 0,
        liqS: 0,
      }));
      const byT = new Map(hrs.map((x, i) => [x.t, i]));
      for (const q of liqs) {
        const i = byT.get(Math.floor(Number(q.timestamp) / H) * H);
        if (i !== undefined) {
          if (q.victim === "LONG") hrs[i].liqL += Number(q.quoteQty);
          else hrs[i].liqS += Number(q.quoteQty);
        }
      }
      // the coin's own yardsticks over the period
      const oi6 = hrs.map((_, i) =>
        i >= 6 ? (100 * (hrs[i].oi0 - hrs[i - 6].oi0)) / hrs[i - 6].oi0 : NaN,
      );
      const buys = hrs.map((x) => x.buy),
        lL = hrs.map((x) => x.liqL),
        lS = hrs.map((x) => x.liqS);
      const Y = {
        oi6p25: pct(oi6, 25),
        buyP30: pct(buys, 30),
        buyP40: pct(buys, 40),
        buyP60: pct(buys, 60),
        buyP70: pct(buys, 70),
        lLp90: pct(lL, 90),
        lSp90: pct(lS, 90),
        lLp50: pct(lL, 50),
        lSp50: pct(lS, 50),
      };
      const atr = (i: number): number => {
        let s = 0,
          n = 0;
        for (let j = Math.max(1, i - 13); j <= i; j++) {
          s += Math.max(
            hrs[j].h - hrs[j].l,
            Math.abs(hrs[j].h - hrs[j - 1].c),
            Math.abs(hrs[j].l - hrs[j - 1].c),
          );
          n++;
        }
        return n ? s / n : NaN;
      };
      console.log(
        `\n═══ ${sym} · ${utc(from)} -> ${utc(now)} UTC (${((now - from) / D).toFixed(1)} days, ${hrs.length} hours) ═══`,
      );
      console.log(
        `its yardsticks: 6h OI change 25th pct ${sp(Y.oi6p25)}% · buy% 30th/60th/70th pct ${Y.buyP30.toFixed(0)}/${Y.buyP60.toFixed(0)}/${Y.buyP70.toFixed(0)}% · longs liq 90th pct per hour ${usd(Y.lLp90)} · shorts ${usd(Y.lSp90)}`,
      );
      for (const kind of ["BOTTOM", "TOP"] as const) {
        const bot = kind === "BOTTOM";
        console.log(
          `\n  ${kind}S   (steps: 1 cleaning · 2 extreme pushed · 3 push stopped · 4 OI rebuilt)`,
        );
        for (let i = 12; i < hrs.length - 6; i++) {
          // the extreme of +-12h; equal lows (highs) -> only the first one
          const x = hrs[i],
            prev = hrs.slice(Math.max(0, i - 12), i),
            next = hrs.slice(i + 1, Math.min(hrs.length, i + 13));
          if (
            bot
              ? !(prev.every((w) => w.l > x.l) && next.every((w) => w.l >= x.l))
              : !(prev.every((w) => w.h < x.h) && next.every((w) => w.h <= x.h))
          )
            continue;
          const s1 = oi6[i] <= Y.oi6p25;
          const s2 = bot
            ? x.buy <= Y.buyP30 || (x.liqL >= Y.lLp90 && x.liqL > 0)
            : x.buy >= Y.buyP70 || (x.liqS >= Y.lSp90 && x.liqS > 0);
          const nx = hrs.slice(i + 1, i + 4);
          const nxBuy = nx.reduce((a, w) => a + w.buy, 0) / nx.length,
            nxVol = nx.reduce((a, w) => a + w.v, 0) / nx.length;
          const s3 =
            nx.every((w) => (bot ? w.liqL <= Y.lLp50 : w.liqS <= Y.lSp50)) &&
            (nxVol <= x.v / 2 || (bot ? nxBuy >= Y.buyP60 : nxBuy <= Y.buyP40));
          const after = hrs.slice(i + 1, i + 7),
            oiAfter = (100 * (after[after.length - 1].oi1 - x.oi1)) / x.oi1;
          const s4 =
            oiAfter > 0 && after.every((w) => (bot ? w.l > x.l : w.h < x.h));
          const lo = bot ? x.l : Math.max(x.o, x.c),
            hi = bot ? Math.min(x.o, x.c) : x.h;
          // later: the first return into the zone after the 6h
          let later = "never came back";
          let held: boolean | null = null;
          for (let j = i + 7; j < hrs.length; j++) {
            if (!(bot ? hrs[j].l <= hi : hrs[j].h >= lo)) continue;
            const a = atr(j);
            later = `came back ${utc(hrs[j].t)} -> open`;
            for (let m = j; m < hrs.length; m++) {
              if (bot ? hrs[m].c < lo : hrs[m].c > hi) {
                later = `came back ${utc(hrs[j].t)} -> ❌ BROKE ${utc(hrs[m].t)}`;
                held = false;
                break;
              }
              if (bot ? hrs[m].h >= hi + 2 * a : hrs[m].l <= lo - 2 * a) {
                later = `came back ${utc(hrs[j].t)} -> ✅ HELD`;
                held = true;
                break;
              }
            }
            break;
          }
          const steps = [s1, s2, s3, s4].filter(Boolean).length;
          all.push({ sym, held, steps, kind });
          const liq = bot ? x.liqL : x.liqS;
          console.log(
            `  ${utc(x.t)}  zone ${px(lo)} – ${px(hi)}  ${s1 ? "1✓" : "1✗"} ${s2 ? "2✓" : "2✗"} ${s3 ? "3✓" : "3✗"} ${s4 ? "4✓" : "4✗"} (${steps}/4) · OI 6h before ${sp(oi6[i])}% · buy ${x.buy.toFixed(0)}% · ${bot ? "longs" : "shorts"} liq ${usd(liq)} · 3h after buy ${nxBuy.toFixed(0)}% vol ${Math.round((100 * nxVol) / x.v)}% · OI 6h after ${sp(oiAfter)}% · ${later}`,
          );
        }
      }
    }
    console.log(
      `\n═══ all coins: did the zone hold when the price came back? ═══`,
    );
    for (const [name, f] of [
      ["4/4 steps", (z: { steps: number }) => z.steps === 4],
      ["3/4 steps", (z: { steps: number }) => z.steps === 3],
      ["0-2 steps", (z: { steps: number }) => z.steps <= 2],
    ] as const) {
      const l = all.filter(f),
        back = l.filter((z) => z.held !== null);
      console.log(
        `  ${name.padEnd(10)} ${String(l.length).padStart(3)} extremes · came back and decided ${back.length}: ✅ held ${back.filter((z) => z.held).length} · ❌ broke ${back.filter((z) => z.held === false).length}`,
      );
    }
    console.log(`(only ~14 days and a few coins -- a look, not proof)`);
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
