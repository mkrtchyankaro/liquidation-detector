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
 *   --h1  JOHNNY'S 1h RULE instead (BOUNCE only, no room filter): a 1h candle touches a wall, then a CLOSED 1h candle is
 *        outside it on the room side -- two kinds tried: BODY (open and close outside) / WICK (the whole candle outside)
 *        -> enter at that close, back into the room (from the upper wall SHORT, from the lower wall LONG):
 *          stop = the far edge of that wall (upper wall: its top · lower wall: its bottom)
 *          take profit = a fixed --tp % (1.5), and only if that price is still inside the other wall's far edge
 *                        (SHORT: entry - TP >= the lower wall's bottom · LONG: entry + TP <= the upper wall's top)
 *          ROOM RULE: the distance entry -> the other wall's far edge must be >= --ratio x the distance entry -> stop
 *                     (tried 1.33 and 1.5) -- otherwise no trade · optional --maxstop % (off by default)
 *          BTC and ETH are left out (they do not follow the walls)
 *          out after 24h at the close if neither · fee 0.1%
 *        every trade also notes what happened at the wall before the entry (only past data), to compare -- not filters:
 *          OI at the wall  = OI change from the first touch to the entry (our minute_bars) -- rose / fell
 *          OI signal hour  = OI change in the 1h candle that closed outside -- rose / fell
 *          squeeze liq     = liquidations of the side the wall pushed back while the price was at it
 *                            (upper wall: SHORTS liquidated · lower wall: LONGS) -- above / below the median
 *        default coins with --h1: all SYMBOLS (new coins have ~5 days of our liquidations, trades start 2 days in)
 *
 *   --h1 --rrtest  (Oct 7) WICK, room >= 1.33x, the TP three ways: fixed --tp % · RR (TP = --rr x the SL distance) ·
 *        RR + BREAKEVEN (once the price went --be R our way, the SL moves to the entry +0.1% -- the fees are covered).
 *        Results also in R: the position is sized by the SL, so 1R = the $ risked (e.g. $50).
 *
 *   npx tsx src/tools/wall-trade-test.ts
 *   options: --symbols SOLUSDT,XRPUSDT,...  (default: the 8 coins)  --list (every trade)  --h1
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import {
  hourCandle,
  wallsAt as engineWallsAt,
  WallTracker,
} from "../strategy/v10/wall-engine";

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
const DEPTH = 0.75,
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
interface HT {
  sym: string;
  v: string;
  t: number;
  dir: "LONG" | "SHORT";
  entry: number;
  stop: number;
  tp: number;
  res: "TP" | "STOP" | "BE" | "24h";
  net: number;
  risk: number;
  beOn?: boolean;
  oiStay: number;
  oiSig: number;
  sq: number;
  newCoin: boolean;
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
  const SKIP = ["BTCUSDT", "ETHUSDT"];
  const syms0 = arg(
    "symbols",
    argv.includes("--h1") && process.env.SYMBOLS
      ? process.env.SYMBOLS
      : "SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,SUIUSDT",
  )
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const syms = argv.includes("--h1")
    ? syms0.filter((x) => !SKIP.includes(x))
    : syms0;
  const list = argv.includes("--list");
  const now = Math.floor(Date.now() / Q15) * Q15;
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const all: Trade[] = [];
  const h1 = argv.includes("--h1"),
    hAll: HT[] = [];
  const TPP = Number(arg("tp", "1.5")),
    MAXSTOP = Number(arg("maxstop", "1000"));
  interface Var {
    v: string;
    kind: "WICK" | "BODY";
    ratio: number;
    tpR?: number;
    beR?: number;
  }
  const RR = Number(arg("rr", "2")),
    BE = Number(arg("be", "1"));
  const VARIANTS: Var[] = argv.includes("--rrtest")
    ? [
        { v: `WICK TP ${TPP}%`, kind: "WICK", ratio: 1.33 },
        { v: `WICK RR ${RR}`, kind: "WICK", ratio: 1.33, tpR: RR },
        {
          v: `WICK RR ${RR} + BE at ${BE}R`,
          kind: "WICK",
          ratio: 1.33,
          tpR: RR,
          beR: BE,
        },
      ]
    : (
        [
          ["BODY", 1.33],
          ["BODY", 1.5],
          ["WICK", 1.33],
          ["WICK", 1.5],
        ] as const
      ).map(([kind, ratio]) => ({
        v: `${kind} room>=${ratio}x stop`,
        kind,
        ratio,
      }));
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

      // the walls: the SAME code as the live bot (src/strategy/v10/wall-engine.ts)
      const wallsAt = (t: number): Walls | null =>
        engineWallsAt({ d1, h4, q15: q, liqs }, t);

      if (h1) {
        const memo = new Map<number, Walls | null>();
        const wAt = (t: number): Walls | null => {
          if (!memo.has(t)) memo.set(t, wallsAt(t));
          return memo.get(t) ?? null;
        };
        const s0 = firstIdx(q, testFrom),
          newCoin = liqs[0].t > Date.UTC(2026, 8, 28);
        const oiMap = new Map(
          (
            await db
              .collection(MINUTE_BARS)
              .find({
                symbol: sym,
                oiLast: { $gt: 0 },
                ts: { $gte: new Date(testFrom - 3 * D) },
              })
              .project({ ts: 1, oiLast: 1 })
              .toArray()
          ).map((d) => [(d.ts as Date).getTime(), Number(d.oiLast)]),
        );
        const oiAt = (t: number): number => {
          for (let y = t - M; y > t - 15 * M; y -= M) {
            const v = oiMap.get(y);
            if (v !== undefined) return v;
          }
          return NaN;
        };
        const liqSum = (a: number, b: number, long: boolean): number => {
          let sm = 0;
          for (let j = firstIdx(liqs, a); j < liqs.length && liqs[j].t < b; j++)
            if (liqs[j].long === long) sm += liqs[j].usd;
          return sm;
        };
        console.log(
          `\n═══ ${sym} · 1h rule · from ${utc(testFrom)} UTC${newCoin ? " · NEW coin" : ""} ═══`,
        );
        for (const { v, kind, ratio, tpR, beR } of VARIANTS) {
          const tpPct = TPP,
            res: HT[] = [];
          let pos: HT | null = null,
            noRoom = 0,
            bigStop = 0;
          const tracker = new WallTracker();
          for (let j = s0; j < q.length; j++) {
            const x = q[j];
            if (pos) {
              const p: HT = pos,
                long = p.dir === "LONG";
              const hitS = long ? x.l <= p.stop : x.h >= p.stop,
                hitT = long ? x.h >= p.tp : x.l <= p.tp;
              const out = hitS
                ? p.stop
                : hitT
                  ? p.tp
                  : x.t + Q15 - p.t >= D
                    ? x.c
                    : NaN;
              if (Number.isFinite(out)) {
                p.res = hitS ? (p.beOn ? "BE" : "STOP") : hitT ? "TP" : "24h";
                p.net =
                  (100 * (long ? out - p.entry : p.entry - out)) / p.entry -
                  FEE;
                res.push(p);
                pos = null;
                tracker.reset();
              } else if (beR !== undefined && !p.beOn) {
                // breakeven: the price went beR x the first risk our way -> from the next candle the SL is at the entry +0.1%
                const r0 = (p.risk / 100) * p.entry;
                if (
                  long ? x.h >= p.entry + beR * r0 : x.l <= p.entry - beR * r0
                ) {
                  p.stop = long ? p.entry * 1.001 : p.entry * 0.999;
                  p.beOn = true;
                }
              }
              continue;
            }
            if ((x.t + Q15) % H !== 0) continue; // act only when a 1h candle closes
            const hs = x.t + Q15 - H,
              c = hourCandle(q, hs);
            if (!c) continue;
            // the rule: the SAME code as the live bot (src/strategy/v10/wall-engine.ts)
            const st = tracker.step(c, wAt(hs), {
              kind,
              tpPct,
              roomRatio: ratio,
              maxStopPct: MAXSTOP,
              ...(tpR !== undefined ? { tpR } : {}),
            });
            for (const k of st.skips)
              if (k.why === "TP_BEYOND_WALL") noRoom++;
              else bigStop++;
            const g = st.signal;
            if (!g) continue;
            const te = g.candleEnd,
              t0 = g.touchedAt,
              short = g.side === "SHORT";
            pos = {
              sym,
              v,
              t: te,
              dir: g.side,
              entry: g.entry,
              stop: g.stop,
              tp: g.tp,
              res: "24h",
              net: 0,
              risk: g.riskPct,
              oiStay: (100 * (oiAt(te) - oiAt(t0))) / oiAt(t0),
              oiSig: (100 * (oiAt(te) - oiAt(hs))) / oiAt(hs),
              sq: liqSum(t0, te, !short),
              newCoin,
            };
          }
          if (list)
            for (const p of res)
              console.log(
                `  [${v}] ${utc(p.t)} ${p.dir.padEnd(5)} entry ${px(p.entry).padEnd(8)} stop ${px(p.stop).padEnd(8)} (-${p.risk.toFixed(2)}%) tp ${px(p.tp).padEnd(8)} -> ${p.res.padEnd(4)} ${sp(p.net)}%`,
              );
          const sm = res.reduce((a, p) => a + p.net, 0);
          console.log(
            `  ${v.padEnd(22)} ${String(res.length).padStart(3)} trades · TP ${res.filter((p) => p.res === "TP").length} · STOP ${res.filter((p) => p.res === "STOP").length} · 24h ${res.filter((p) => p.res === "24h").length} · avg stop ${res.length ? (res.reduce((a, p) => a + p.risk, 0) / res.length).toFixed(2) : "n/a"}% · sum ${sp(sm)}% · skipped: TP beyond the other wall ${noRoom}, room < ${ratio}x stop ${bigStop}${pos ? ` · OPEN NOW ${(pos as HT).dir} ${utc((pos as HT).t)} entry ${px((pos as HT).entry)} stop ${px((pos as HT).stop)} tp ${px((pos as HT).tp)}` : ""}`,
          );
          hAll.push(...res);
        }
        continue;
      }
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

  if (h1) {
    console.log(
      `\n═══ ALL COINS (no BTC / ETH) · 1h rule · TP ${TPP}% · stop = the wall's far edge (fee ${FEE}% in) ═══`,
    );
    const R = (p: HT): number => p.net / p.risk; // the net result in R (1R = the $ lost at the first SL)
    for (const { v } of VARIANTS) {
      const l = hAll.filter((p) => p.v === v),
        sm = l.reduce((a, p) => a + p.net, 0),
        w = l.filter((p) => p.net > 0).length,
        sr = l.reduce((a, p) => a + R(p), 0);
      console.log(
        `\n  ${v.padEnd(22)} ${String(l.length).padStart(3)} trades · win ${l.length ? Math.round((100 * w) / l.length) : 0}% · avg ${l.length ? sp(sm / l.length) : "n/a"}% · sum ${sp(sm, 1)}% · per $1000 per trade ${sp(sm * 10, 0)}$`,
      );
      console.log(
        `      IN R (sized by the SL): sum ${sp(sr, 1)}R · avg ${l.length ? sp(sr / l.length) : "n/a"}R · with $50 risk ${sp(sr * 50, 0)}$ · TP ${l.filter((p) => p.res === "TP").length} · SL ${l.filter((p) => p.res === "STOP").length} · BE ${l.filter((p) => p.res === "BE").length} · 24h ${l.filter((p) => p.res === "24h").length}`,
      );
      const wk = new Map<number, HT[]>();
      for (const p of l) {
        const d = new Date(p.t),
          mon =
            Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
            ((d.getUTCDay() + 6) % 7) * D;
        wk.set(mon, [...(wk.get(mon) ?? []), p]);
      }
      for (const [mon, ll] of [...wk].sort((a, b) => a[0] - b[0]))
        console.log(
          `      week of ${new Date(mon).toISOString().slice(5, 10)}: ${ll.length} trades · sum ${sp(
            ll.reduce((a, p) => a + p.net, 0),
            1,
          )}% · ${sp(
            ll.reduce((a, p) => a + R(p), 0),
            1,
          )}R`,
        );
      const coins = [...new Set(l.map((p) => p.sym))]
        .map(
          (c) =>
            `${c.replace("USDT", "")} ${sp(
              l.filter((p) => p.sym === c).reduce((a, p) => a + p.net, 0),
              1,
            )}`,
        )
        .join(" · ");
      console.log(`      by coin: ${coins}`);
      const ln = (name: string, ll: HT[]): void => {
        const s2 = ll.reduce((a, p) => a + p.net, 0);
        console.log(
          `      ${name.padEnd(30)} ${String(ll.length).padStart(3)} trades · win ${ll.length ? Math.round((100 * ll.filter((p) => p.net > 0).length) / ll.length) : 0}% · avg ${ll.length ? sp(s2 / ll.length) : "n/a"}% · sum ${sp(s2, 1)}%`,
        );
      };
      ln(
        "old coins",
        l.filter((p) => !p.newCoin),
      );
      ln(
        "NEW coins (~5 days)",
        l.filter((p) => p.newCoin),
      );
      ln(
        "LONG (lower wall)",
        l.filter((p) => p.dir === "LONG"),
      );
      ln(
        "SHORT (upper wall)",
        l.filter((p) => p.dir === "SHORT"),
      );
      ln(
        "OI at the wall ROSE",
        l.filter((p) => p.oiStay > 0),
      );
      ln(
        "OI at the wall fell",
        l.filter((p) => p.oiStay <= 0),
      );
      ln(
        "stop <= 1%",
        l.filter((p) => p.risk <= 1),
      );
      ln(
        "stop > 1%",
        l.filter((p) => p.risk > 1),
      );
      const med =
        l.map((p) => p.sq).sort((a, b) => a - b)[Math.floor(l.length / 2)] ?? 0;
      ln(
        `squeeze liq > median ($${Math.round(med)})`,
        l.filter((p) => p.sq > med),
      );
      ln(
        "squeeze liq <= median",
        l.filter((p) => p.sq <= med),
      );
      const cm = new Map<string, number>();
      for (const c of new Set(l.map((p) => p.sym))) {
        const v2 = l
          .filter((p) => p.sym === c)
          .map((p) => p.sq)
          .sort((x, y) => x - y);
        cm.set(c, v2[Math.floor(v2.length / 2)]);
      }
      ln(
        "squeeze > the coin's own median",
        l.filter((p) => p.sq > (cm.get(p.sym) ?? 0)),
      );
      ln(
        "squeeze <= the coin's own median",
        l.filter((p) => p.sq <= (cm.get(p.sym) ?? 0)),
      );
    }
    console.log(
      `(walls rebuilt every hour from the past only · a check, not proof)`,
    );
    return;
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
