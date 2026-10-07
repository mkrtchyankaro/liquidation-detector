/**
 * WALLS FOUND BY THE PROGRAM + THE 15m RULE -- an honest check (Johnny, Oct 7 2026). Read-only, nothing is traded.
 * No hand-drawn walls and no look-ahead: every hour the walls are rebuilt only from what was known at that hour.
 *   THE FIELD at hour t: back from t on CLOSED 4h candles while the closes stay inside 2.5 x the daily ATR(14) (as
 *        zone-profile), at most 30 days.
 *   THE WALLS at hour t, from the field's 15m candles and OUR liquidations (liq_raw_events) before t, in price bands of
 *        0.25 x the 4h ATR:
 *        the MODE  = the band where the price spent the most time
 *        LOWER wall = below the mode: the band with the most LONGS liquidated, widened to its neighbours while they have
 *                     >= 2/3 of that (not into the mode band)
 *        UPPER wall = above the mode: the same with SHORTS liquidated
 *        (on our 10-07 data this gives SOL 117.05–118.37 / 120.56–122.31, the walls drawn by hand)
 *        ROOM = the gap between the walls; a trade only when the gap >= 2 x the wider wall
 *   THE TRADE (one at a time per coin): a 15m candle touches a wall; later the first 15m candle whose BODY is fully outside
 *        that wall -> enter at its close, in the direction it left:
 *          stop   = 75% into the wall (from the side it left)
 *          target = BOUNCE (back into the room): the near edge of the other wall · THROUGH (away from the room): 2 x risk
 *          out after 24h at the close if neither · fee 0.1% per trade · after a trade a new touch is needed
 *   Liquidations exist from our first event (~09-23), so trades start 2 days after that.
 *
 *   npx tsx src/tools/wall-trade-test.ts
 *   options: --symbols SOLUSDT,XRPUSDT,...  (default: the 8 coins)  --list (every trade)
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";

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
const M = 60_000,
  H = 60 * M,
  D = 24 * H,
  Q15 = 15 * M;
const K = 2.5,
  BIN = 0.25,
  DEPTH = 0.75,
  FEE = 0.1,
  ROOM = 2;
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});

interface C {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}
async function kl(
  symbol: string,
  interval: string,
  from: number,
  to: number,
): Promise<C[]> {
  const out: C[] = [];
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
    for (const r of rows)
      out.push({
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
      });
    s = Number(rows[rows.length - 1][0]) + 1;
    if (rows.length < 1500) break;
  }
  return out;
}
const atrOf = (k: C[], n = 14): number => {
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
interface Wall {
  lo: number;
  hi: number;
}
interface Walls {
  lower: Wall | null;
  upper: Wall | null;
  mode: number;
  fs: number;
}
interface Trade {
  sym: string;
  t: number;
  kind: "BOUNCE" | "THROUGH";
  dir: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  res: "TARGET" | "STOP" | "24h";
  net: number;
  exitT: number;
  wall: string;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const syms = arg(
    "symbols",
    "SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,SUIUSDT",
  )
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const list = argv.includes("--list");
  const now = Math.floor(Date.now() / Q15) * Q15;
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const all: Trade[] = [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const sym of syms) {
      const liqDocs = await db
        .collection("liq_raw_events")
        .find({ symbol: sym, victim: { $in: ["LONG", "SHORT"] } })
        .project({ timestamp: 1, victim: 1, quoteQty: 1, price: 1 })
        .toArray();
      const liqs = liqDocs
        .map((d) => ({
          t: Number(d.timestamp),
          long: d.victim === "LONG",
          usd: Number(d.quoteQty),
          p: Number(d.price),
        }))
        .filter((x) => x.p > 0)
        .sort((a, b) => a.t - b.t);
      if (!liqs.length) {
        console.log(`\n${sym}: no liquidations in our DB`);
        continue;
      }
      const testFrom = Math.ceil((liqs[0].t + 2 * D) / H) * H;
      const d1 = await kl(sym, "1d", testFrom - 75 * D, now);
      const h4 = await kl(sym, "4h", testFrom - 45 * D, now);
      const q = await kl(sym, "15m", testFrom - 31 * D, now);
      const firstIdx = (arr: { t: number }[], t: number): number => {
        let a = 0,
          b = arr.length;
        while (a < b) {
          const m = (a + b) >> 1;
          if (arr[m].t < t) a = m + 1;
          else b = m;
        }
        return a;
      };

      const wallsAt = (t: number): Walls | null => {
        const dd = d1.filter((x) => x.t + D <= t).slice(-15),
          hh = h4.filter((x) => x.t + 4 * H <= t);
        if (dd.length < 15 || hh.length < 15) return null;
        const atrD = atrOf(dd),
          atr4 = atrOf(hh.slice(-15)),
          w = BIN * atr4;
        let lo = Infinity,
          hi = -Infinity,
          i = hh.length - 1;
        for (; i >= 0 && hh[i].t >= t - 30 * D; i--) {
          const nlo = Math.min(lo, hh[i].c),
            nhi = Math.max(hi, hh[i].c);
          if (nhi - nlo > K * atrD) break;
          lo = nlo;
          hi = nhi;
        }
        const fs = hh[Math.min(hh.length - 1, i + 1)].t;
        const time = new Map<number, number>(),
          lL = new Map<number, number>(),
          lS = new Map<number, number>();
        for (let j = firstIdx(q, fs); j < q.length && q[j].t + Q15 <= t; j++) {
          const b = Math.floor(q[j].c / w);
          time.set(b, (time.get(b) ?? 0) + 1);
        }
        for (
          let j = firstIdx(liqs, fs);
          j < liqs.length && liqs[j].t < t;
          j++
        ) {
          const b = Math.floor(liqs[j].p / w),
            m = liqs[j].long ? lL : lS;
          m.set(b, (m.get(b) ?? 0) + liqs[j].usd);
        }
        if (!time.size) return null;
        let mode = 0,
          mt = -1;
        for (const [b, v] of time)
          if (v > mt) {
            mt = v;
            mode = b;
          }
        const grow = (m: Map<number, number>, below: boolean): Wall | null => {
          let pk = NaN,
            pv = 0;
          for (const [b, v] of m)
            if ((below ? b < mode : b > mode) && v > pv) {
              pv = v;
              pk = b;
            }
          if (!(pv > 0)) return null;
          let a = pk,
            z = pk;
          while ((m.get(a - 1) ?? 0) >= (2 / 3) * pv && (below || a - 1 > mode))
            a--;
          while (
            (m.get(z + 1) ?? 0) >= (2 / 3) * pv &&
            (!below || z + 1 < mode)
          )
            z++;
          return { lo: a * w, hi: (z + 1) * w };
        };
        return {
          lower: grow(lL, true),
          upper: grow(lS, false),
          mode: mode * w,
          fs,
        };
      };

      const trades: Trade[] = [];
      let W: Walls | null = null,
        wHour = -1,
        pos: Trade | null = null;
      let touched = { lower: false, upper: false },
        skippedRoom = 0;
      const key = (x: Wall | null): string =>
        x ? `${px(x.lo)}–${px(x.hi)}` : "none";
      for (let j = firstIdx(q, testFrom); j < q.length; j++) {
        const x = q[j],
          hr = Math.floor(x.t / H) * H;
        if (hr !== wHour) {
          const nw = wallsAt(hr);
          if (!W || !nw || key(W.lower) !== key(nw.lower))
            touched.lower = false;
          if (!W || !nw || key(W.upper) !== key(nw.upper))
            touched.upper = false;
          W = nw;
          wHour = hr;
        }
        if (pos) {
          const p: Trade = pos,
            long = p.dir === "LONG";
          const hitS = long ? x.l <= p.stop : x.h >= p.stop,
            hitT = long ? x.h >= p.target : x.l <= p.target;
          const close = (price: number, res: Trade["res"]): void => {
            p.res = res;
            p.exitT = x.t + Q15;
            p.net =
              (100 * (long ? price - p.entry : p.entry - price)) / p.entry -
              FEE;
            trades.push(p);
            pos = null;
            touched = { lower: false, upper: false };
          };
          if (hitS) close(p.stop, "STOP");
          else if (hitT) close(p.target, "TARGET");
          else if (x.t + Q15 - p.t >= D) close(x.c, "24h");
          continue;
        }
        if (!W || !W.lower || !W.upper) continue;
        const lw = W.lower,
          uw = W.upper;
        for (const side of ["lower", "upper"] as const) {
          const wl = side === "lower" ? lw : uw;
          if (x.l <= wl.hi && x.h >= wl.lo) {
            touched[side] = true;
            continue;
          }
          const up = Math.min(x.o, x.c) > wl.hi,
            dn = Math.max(x.o, x.c) < wl.lo;
          if (!touched[side] || !(up || dn)) continue;
          touched[side] = false;
          const gap = uw.lo - lw.hi,
            wid = Math.max(lw.hi - lw.lo, uw.hi - uw.lo);
          if (!(gap >= ROOM * wid)) {
            skippedRoom++;
            continue;
          }
          const entry = x.c,
            stop = up
              ? wl.hi - DEPTH * (wl.hi - wl.lo)
              : wl.lo + DEPTH * (wl.hi - wl.lo);
          const bounce = (side === "lower" && up) || (side === "upper" && dn);
          const target = bounce
            ? up
              ? uw.lo
              : lw.hi
            : up
              ? entry + 2 * (entry - stop)
              : entry - 2 * (stop - entry);
          if (up ? target <= entry : target >= entry) continue;
          pos = {
            sym,
            t: x.t + Q15,
            kind: bounce ? "BOUNCE" : "THROUGH",
            dir: up ? "LONG" : "SHORT",
            entry,
            stop,
            target,
            res: "24h",
            net: 0,
            exitT: 0,
            wall: `${side} ${key(wl)} (room ${key(lw)} | ${key(uw)})`,
          };
          break;
        }
      }
      const nowW = wallsAt(Math.floor(now / H) * H);
      const last = q[q.length - 1]?.c ?? NaN;
      console.log(
        `\n═══ ${sym} · trades from ${utc(testFrom)} UTC · now ${px(last)} ═══`,
      );
      if (nowW) {
        const gap =
            nowW.lower && nowW.upper ? nowW.upper.lo - nowW.lower.hi : NaN,
          wid =
            nowW.lower && nowW.upper
              ? Math.max(
                  nowW.lower.hi - nowW.lower.lo,
                  nowW.upper.hi - nowW.upper.lo,
                )
              : NaN;
        console.log(
          `  walls now: lower ${key(nowW.lower)} · upper ${key(nowW.upper)} · most time ~${px(nowW.mode)} · field from ${utc(nowW.fs)} · room / wall ${(gap / wid).toFixed(1)} ${gap >= ROOM * wid ? "(tradable)" : "(too narrow -> no trades)"}`,
        );
      }
      if (pos)
        console.log(
          `  open now: ${(pos as Trade).dir} ${utc((pos as Trade).t)} entry ${px((pos as Trade).entry)} stop ${px((pos as Trade).stop)} target ${px((pos as Trade).target)}`,
        );
      if (list)
        for (const p of trades)
          console.log(
            `  ${utc(p.t)} ${p.dir.padEnd(5)} ${p.kind.padEnd(7)} entry ${px(p.entry).padEnd(8)} stop ${px(p.stop).padEnd(8)} target ${px(p.target).padEnd(8)} -> ${p.res.padEnd(6)} ${utc(p.exitT)}  ${sp(p.net)}%   ${p.wall}`,
          );
      const s = trades.reduce((a, p) => a + p.net, 0);
      console.log(
        `  ${trades.length} trades · TARGET ${trades.filter((p) => p.res === "TARGET").length} · STOP ${trades.filter((p) => p.res === "STOP").length} · 24h ${trades.filter((p) => p.res === "24h").length} · sum ${sp(s)}% · skipped (room too narrow) ${skippedRoom}`,
      );
      all.push(...trades);
    }
  } finally {
    await client.close();
  }

  const line = (name: string, l: Trade[]): void => {
    const s = l.reduce((a, p) => a + p.net, 0),
      w = l.filter((p) => p.net > 0).length;
    console.log(
      `  ${name.padEnd(22)} ${String(l.length).padStart(3)} trades · win ${l.length ? Math.round((100 * w) / l.length) : 0}% · avg ${l.length ? sp(s / l.length) : "n/a"}% · sum ${sp(s, 1)}% · per $1000 per trade: ${sp(s * 10, 0)}$`,
    );
  };
  console.log(`\n═══ ALL COINS (fee ${FEE}% in) ═══`);
  line("all", all);
  line(
    "BOUNCE (into the room)",
    all.filter((p) => p.kind === "BOUNCE"),
  );
  line(
    "THROUGH (break out)",
    all.filter((p) => p.kind === "THROUGH"),
  );
  line(
    "LONG",
    all.filter((p) => p.dir === "LONG"),
  );
  line(
    "SHORT",
    all.filter((p) => p.dir === "SHORT"),
  );
  const wk = new Map<number, Trade[]>();
  for (const p of all) {
    const d = new Date(p.t),
      mon =
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
        ((d.getUTCDay() + 6) % 7) * D;
    wk.set(mon, [...(wk.get(mon) ?? []), p]);
  }
  for (const [mon, l] of [...wk].sort((a, b) => a[0] - b[0]))
    line(`week of ${new Date(mon).toISOString().slice(5, 10)}`, l);
  console.log(
    `(walls rebuilt every hour from the past only · ~2 weeks of our liquidations · a check, not proof)`,
  );
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
