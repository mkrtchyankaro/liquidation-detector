/**
 * ZONES FROM NUMBERS, ONLY IN THE CURRENT PRICE FIELD (Johnny, Oct 7 2026) -- research, not a rule. Read-only.
 *   1. THE CURRENT FIELD -- no fixed number of days: from now we go back on 4h candles while all 4h closes stay inside a
 *      band of --k x the daily ATR(14). The first candle that would make the band wider = the move that brought the price
 *      here; everything before it is another market and is dropped. (--from "YYYY-MM-DD HH:MM" sets it by hand.)
 *   2. THE NUMBERS ON THE PRICE: the field is cut into price bands of --bin x the 4h ATR(14). Every minute goes into the
 *      band of its close, and every band sums:
 *        hours     how long the price stayed there (the sideways box = where people trade)
 *        OI net $  OI change summed over the minutes there (our DB minute_bars, OI x price):
 *                  + = NEW positions were opened at that price · - = positions were closed / flushed there
 *        longs liq / shorts liq $   our liquidations at that price            (our DB liq_raw_events, ~14 days, max 1/s)
 *        delta $   taker BUY - taker SELL volume there (+ = buyers pushed, - = sellers)   (Binance 1m klines)
 *      ◆ marks the biggest band of each column; ◀ now = the current price.
 *   3. SUMMARY: the box (the bands holding 70% of the time) and, below and above the price, where the biggest longs /
 *      shorts liquidations, OI drop and OI growth sit.
 *
 *   npx tsx src/tools/zone-profile.ts --symbols SOLUSDT,XRPUSDT
 *   options: --k 2.5  --bin 0.25  --from "2026-09-26 00:00"
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
const px = (v: number): string => String(+v.toPrecision(5));
const usd = (v: number): string => {
  const a = Math.abs(v),
    s = v < 0 ? "-" : "";
  return a >= 1e6
    ? `${s}$${(a / 1e6).toFixed(2)}M`
    : a >= 1e3
      ? `${s}$${(a / 1e3).toFixed(0)}k`
      : a > 0
        ? `${s}$${a.toFixed(0)}`
        : "-";
};
const M = 60_000,
  H = 60 * M,
  D = 24 * H;
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
const toK = (r: unknown[]): K => ({
  t: Number(r[0]),
  o: Number(r[1]),
  h: Number(r[2]),
  l: Number(r[3]),
  c: Number(r[4]),
  v: Number(r[5]),
  tb: Number(r[9]),
});
async function kl(
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
    if (!rows.length) break;
    out.push(...rows.map(toK));
    s = Number(rows[rows.length - 1][0]) + 1;
    if (rows.length < 1500) break;
  }
  return out;
}
const atr = (k: K[], n = 14): number => {
  let s = 0,
    c = 0;
  for (let i = Math.max(1, k.length - n); i < k.length; i++) {
    s += Math.max(
      k[i].h - k[i].l,
      Math.abs(k[i].h - k[i - 1].c),
      Math.abs(k[i].l - k[i - 1].c),
    );
    c++;
  }
  return c ? s / c : NaN;
};

interface Bin {
  min: number;
  oiUp: number;
  oiDn: number;
  liqL: number;
  liqS: number;
  buy: number;
  sell: number;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const syms = arg("symbols", "SOLUSDT,XRPUSDT")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const k = Number(arg("k", "2.5")),
    binAtr = Number(arg("bin", "0.25")),
    fromArg = arg("from", "");
  const now = Math.floor(Date.now() / M) * M;
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const sym of syms) {
      // 1. the current field
      const d1 = await kl(sym, "1d", now - 40 * D, now);
      const h4 = await kl(sym, "4h", now - 60 * D, now);
      const atrD = atr(d1.slice(0, -1)),
        atr4 = atr(h4.slice(0, -1));
      let start: number;
      let why: string;
      if (fromArg) {
        start = Date.parse(`${fromArg.replace(" ", "T")}:00Z`);
        why = "set by hand (--from)";
      } else {
        let lo = Infinity,
          hi = -Infinity,
          i = h4.length - 1;
        for (; i >= 0; i--) {
          const nlo = Math.min(lo, h4[i].c),
            nhi = Math.max(hi, h4[i].c);
          if (nhi - nlo > k * atrD) break;
          lo = nlo;
          hi = nhi;
        }
        start = h4[Math.min(h4.length - 1, i + 1)].t;
        why =
          i >= 0
            ? `the 4h candle ${utc(h4[i].t)} closed at ${px(h4[i].c)}, outside the band ${px(lo)}–${px(hi)} (${k} x daily ATR ${px(atrD)}) -- the move that brought the price here`
            : `all of the last 60 days stay inside ${k} x daily ATR`;
      }
      const first = await db
        .collection("liq_raw_events")
        .find({ symbol: sym })
        .project({ timestamp: 1 })
        .sort({ timestamp: 1 })
        .limit(1)
        .toArray();
      const liqFrom = first.length ? Number(first[0].timestamp) : now;
      const barsFirst = await db
        .collection(MINUTE_BARS)
        .find({ symbol: sym, oiLast: { $gt: 0 } })
        .project({ ts: 1 })
        .sort({ ts: 1 })
        .limit(1)
        .toArray();
      const oiFrom = barsFirst.length
        ? (barsFirst[0].ts as Date).getTime()
        : now;

      // 2. the numbers on the price
      const m1 = await kl(sym, "1m", start, now);
      const bars = await db
        .collection(MINUTE_BARS)
        .find({
          symbol: sym,
          oiLast: { $gt: 0 },
          ts: { $gte: new Date(start - M), $lt: new Date(now) },
        })
        .project({ ts: 1, oiLast: 1 })
        .toArray();
      const oi = new Map(
        bars.map((b) => [(b.ts as Date).getTime(), Number(b.oiLast)]),
      );
      const liqs = await db
        .collection("liq_raw_events")
        .find({
          symbol: sym,
          victim: { $in: ["LONG", "SHORT"] },
          timestamp: { $gte: start, $lt: now },
        })
        .project({ victim: 1, quoteQty: 1, price: 1 })
        .toArray();
      if (!m1.length) {
        console.log(`\n${sym}: no 1m klines`);
        continue;
      }
      const lowAll = Math.min(...m1.map((x) => x.l)),
        highAll = Math.max(...m1.map((x) => x.h));
      const w = binAtr * atr4,
        base = Math.floor(lowAll / w) * w,
        nb = Math.floor((highAll - base) / w) + 1;
      const bins: Bin[] = Array.from({ length: nb }, () => ({
        min: 0,
        oiUp: 0,
        oiDn: 0,
        liqL: 0,
        liqS: 0,
        buy: 0,
        sell: 0,
      }));
      const bi = (p: number): number =>
        Math.max(0, Math.min(nb - 1, Math.floor((p - base) / w)));
      for (const x of m1) {
        const b = bins[bi(x.c)];
        b.min++;
        const q = x.v > 0 ? (x.o + x.h + x.l + x.c) / 4 : 0;
        b.buy += x.tb * q;
        b.sell += (x.v - x.tb) * q;
        const o0 = oi.get(x.t - M),
          o1 = oi.get(x.t);
        if (o0 !== undefined && o1 !== undefined) {
          const d = (o1 - o0) * x.c;
          if (d > 0) b.oiUp += d;
          else b.oiDn -= d;
        }
      }
      for (const q of liqs) {
        const p = Number(q.price);
        if (!(p > 0)) continue;
        const b = bins[bi(p)];
        if (q.victim === "LONG") b.liqL += Number(q.quoteQty);
        else b.liqS += Number(q.quoteQty);
      }
      const price = m1[m1.length - 1].c;

      console.log(`\n═══ ${sym} · now ${px(price)} · ${utc(now)} UTC ═══`);
      console.log(
        `current field from ${utc(start)} UTC (${((now - start) / D).toFixed(1)} days): ${why}`,
      );
      console.log(
        `range in it ${px(lowAll)} – ${px(highAll)} · bands of ${px(w)} (${binAtr} x 4h ATR ${px(atr4)})`,
      );
      if (liqFrom > start)
        console.log(
          `⚠️ our liquidations start ${utc(liqFrom)} UTC -- before that the liq columns are empty, not zero`,
        );
      if (oiFrom > start)
        console.log(
          `⚠️ our OI (minute_bars) starts ${utc(oiFrom)} UTC -- before that the OI columns are empty, not zero`,
        );
      const top = (f: (b: Bin) => number): number => {
        let j = -1,
          m = 0;
        bins.forEach((b, i) => {
          if (f(b) > m) {
            m = f(b);
            j = i;
          }
        });
        return j;
      };
      const T = {
        min: top((b) => b.min),
        up: top((b) => b.oiUp - b.oiDn),
        dn: top((b) => b.oiDn - b.oiUp),
        lL: top((b) => b.liqL),
        lS: top((b) => b.liqS),
        buy: top((b) => b.buy - b.sell),
        sell: top((b) => b.sell - b.buy),
      };
      const mk = (i: number, j: number): string => (i === j ? "◆" : " ");
      const tot = bins.reduce((s, b) => s + b.min, 0),
        maxMin = bins[T.min].min;
      console.log(
        `\n  price band          hours  time                    OI net $     longs liq   shorts liq  delta $`,
      );
      for (let i = nb - 1; i >= 0; i--) {
        const b = bins[i],
          lo = base + i * w,
          hi = lo + w;
        const bar = "█".repeat(Math.round((20 * b.min) / maxMin)).padEnd(20);
        const now_ = price >= lo && price < hi ? " ◀ now" : "";
        console.log(
          `  ${(px(lo) + " – " + px(hi)).padEnd(18)} ${(b.min / 60).toFixed(1).padStart(5)} ${mk(i, T.min)}${bar}  ${usd(b.oiUp - b.oiDn).padStart(9)}${i === T.up || i === T.dn ? "◆" : " "}    ${usd(b.liqL).padStart(8)}${mk(i, T.lL)}   ${usd(b.liqS).padStart(8)}${mk(i, T.lS)}   ${usd(b.buy - b.sell).padStart(8)}${i === T.buy || i === T.sell ? "◆" : " "}${now_}`,
        );
      }

      // 3. summary
      let a = T.min,
        z = T.min,
        acc = bins[T.min].min;
      while (acc < 0.7 * tot) {
        const up = z + 1 < nb ? bins[z + 1].min : -1,
          dn = a - 1 >= 0 ? bins[a - 1].min : -1;
        if (up >= dn) {
          z++;
          acc += up;
        } else {
          a--;
          acc += dn;
        }
      }
      console.log(
        `\n  BOX (70% of the time): ${px(base + a * w)} – ${px(base + (z + 1) * w)} · most time ${px(base + T.min * w)} – ${px(base + (T.min + 1) * w)}`,
      );
      const pi = bi(price);
      for (const [side, from, to] of [
        ["BELOW", 0, pi - 1],
        ["ABOVE", pi + 1, nb - 1],
      ] as const) {
        if (from > to) {
          console.log(`  ${side} the price: nothing in this field`);
          continue;
        }
        const r = bins.slice(from, to + 1);
        const best = (
          f: (b: Bin) => number,
          name: string,
          fmt: (b: Bin) => string,
        ): string => {
          let j = -1,
            m = 0;
          r.forEach((b, i) => {
            if (f(b) > m) {
              m = f(b);
              j = i;
            }
          });
          return j < 0
            ? `${name} -`
            : `${name} ${px(base + (from + j) * w)}–${px(base + (from + j + 1) * w)} (${fmt(r[j])})`;
        };
        console.log(`  ${side} the price:`);
        console.log(
          `     ${best(
            (b) => b.liqL,
            "biggest LONGS liq  ",
            (b) => usd(b.liqL),
          )}`,
        );
        console.log(
          `     ${best(
            (b) => b.liqS,
            "biggest SHORTS liq ",
            (b) => usd(b.liqS),
          )}`,
        );
        console.log(
          `     ${best(
            (b) => b.oiDn - b.oiUp,
            "biggest OI drop    ",
            (b) => usd(b.oiUp - b.oiDn),
          )}`,
        );
        console.log(
          `     ${best(
            (b) => b.oiUp - b.oiDn,
            "biggest OI growth  ",
            (b) => `${usd(b.oiUp - b.oiDn)}, delta ${usd(b.buy - b.sell)}`,
          )}`,
        );
        console.log(
          `     ${best(
            (b) => b.min,
            "most time          ",
            (b) => `${(b.min / 60).toFixed(1)}h`,
          )}`,
        );
      }
    }
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
