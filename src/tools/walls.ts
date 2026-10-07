/**
 * WALLS: the same place fought over again and again (Johnny, Oct 7 2026) -- research, not a rule. Read-only.
 * Data: Binance 1h klines (price, volume, taker buy) + OUR DB (OI per minute, liquidations ~14 days). Period: from the
 * coin's first liquidation in our DB (or --days) to now.
 *   1. every 1h bottom (the lowest low of +-12h) and top (the highest high of +-12h); its zone INCLUDES THE WICK:
 *      bottom = the low .. the lower of open / close, top = the higher of open / close .. the high
 *   2. zones that overlap (or are closer than 0.25 x the 1h ATR) are the same WALL: support from bottoms, resistance from
 *      tops; the wall = the lowest .. the highest edge of its zones (wicks in)
 *   3. every TOUCH of the wall after it was born (its first extreme): a run of 1h candles that enter the wall (support: the
 *      low <= its top; resistance: the high >= its bottom); a touch ends after 3 hours away. For each touch: the longs (shorts)
 *      liquidated, the OI change, the taker buy %, and how it ended:
 *        ✅ HELD   the price went 2 ATR away from the wall before 2 closes in a row beyond it
 *        ❌ BROKE  2 1h closes in a row beyond the wall (support: below its bottom; resistance: above its top) -- one close
 *                  beyond and back is a fake break, still HELD if it then goes away
 *        … open    neither yet
 *      after a BROKE the wall is not followed further (it may flip; a later look)
 *   4. all walls together: how often a wall held at its 1st, 2nd, 3rd, 4th+ touch -- does a wall get stronger with
 *      every fight? and do touches with big liquidations hold more often?
 *
 *   npx tsx src/tools/walls.ts --symbols SOLUSDT,XRPUSDT
 *   options: --days 14  --min 2 (list only walls with at least this many extremes; the stats use all)
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

interface Hr {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  tb: number;
  oi0: number;
  oi1: number;
  liqL: number;
  liqS: number;
  atr: number;
}
interface Touch {
  t0: number;
  t1: number;
  n: number;
  liq: number;
  oi: number;
  buy: number;
  end: "HELD" | "BROKE" | "open";
  endT: number;
}
interface Wall {
  kind: "SUPPORT" | "RESIST";
  lo: number;
  hi: number;
  born: number;
  extremes: number[];
  touches: Touch[];
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const syms = arg("symbols", "SOLUSDT,XRPUSDT")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const days = Number(arg("days", "14")),
    minExt = Number(arg("min", "2")),
    now = Math.floor(Date.now() / H) * H;
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const stats: Array<{ k: number; held: boolean; liq: number; kind: string }> =
    [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
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
      const hrs: Hr[] = k.map((r) => ({
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5]),
        tb: Number(r[9]),
        oi0: oiAt(Number(r[0])),
        oi1: oiAt(Number(r[0]) + H),
        liqL: 0,
        liqS: 0,
        atr: NaN,
      }));
      const byT = new Map(hrs.map((x, i) => [x.t, i]));
      for (const q of await db
        .collection("liq_raw_events")
        .find({
          symbol: sym,
          victim: { $in: ["LONG", "SHORT"] },
          timestamp: { $gte: from, $lt: now },
        })
        .project({ timestamp: 1, victim: 1, quoteQty: 1 })
        .toArray()) {
        const i = byT.get(Math.floor(Number(q.timestamp) / H) * H);
        if (i !== undefined) {
          if (q.victim === "LONG") hrs[i].liqL += Number(q.quoteQty);
          else hrs[i].liqS += Number(q.quoteQty);
        }
      }
      for (let i = 0; i < hrs.length; i++) {
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
        hrs[i].atr = n ? s / n : hrs[i].h - hrs[i].l;
      }
      const walls: Wall[] = [];
      for (const kind of ["SUPPORT", "RESIST"] as const) {
        const sup = kind === "SUPPORT";
        // 1+2. walls built AS TIME GOES: an extreme is known only 12h after it (no look-ahead); a known extreme that
        //      overlaps a wall of its kind (or is within 0.25 ATR) widens that wall, else it starts a new one
        const built: Array<
          Wall & { states: Array<{ t: number; lo: number; hi: number }> }
        > = [];
        for (let i = 15; i < hrs.length; i++) {
          const e = i - 12,
            x = hrs[e],
            prev = hrs.slice(Math.max(0, e - 12), e),
            next = hrs.slice(e + 1, i + 1);
          const isExt = sup
            ? prev.every((w) => w.l > x.l) && next.every((w) => w.l >= x.l)
            : prev.every((w) => w.h < x.h) && next.every((w) => w.h <= x.h);
          if (!isExt) continue;
          const zlo = sup ? x.l : Math.max(x.o, x.c),
            zhi = sup ? Math.min(x.o, x.c) : x.h,
            tol = 0.25 * x.atr;
          const w = built.find((b) => zlo <= b.hi + tol && zhi >= b.lo - tol);
          if (w) {
            w.lo = Math.min(w.lo, zlo);
            w.hi = Math.max(w.hi, zhi);
            w.extremes.push(e);
            w.states.push({ t: i, lo: w.lo, hi: w.hi });
          } else
            built.push({
              kind,
              lo: zlo,
              hi: zhi,
              born: i,
              extremes: [e],
              touches: [],
              states: [{ t: i, lo: zlo, hi: zhi }],
            });
        }
        for (const w of built) {
          // 3. the touches after it was KNOWN (its first extreme confirmed), with the wall as it was known then
          let i = w.born + 1;
          const range = (at: number): { lo: number; hi: number } => {
            let r = w.states[0];
            for (const st of w.states) if (st.t <= at) r = st;
            return r;
          };
          while (i < hrs.length) {
            const r = range(i);
            const inWall = (x: Hr): boolean =>
              sup
                ? x.l <= r.hi && x.h >= r.lo - 3 * x.atr
                : x.h >= r.lo && x.l <= r.hi + 3 * x.atr;
            if (!inWall(hrs[i])) {
              i++;
              continue;
            }
            let j = i,
              away = 0;
            while (j + 1 < hrs.length && away < 3) {
              j++;
              away = inWall(hrs[j]) ? 0 : away + 1;
            }
            let end = inWall(hrs[j]) ? j : j - away;
            // how it ended: 2 closes in a row beyond -> BROKE; 2 ATR away first -> HELD
            let outcome: Touch["end"] = "open",
              outT = NaN;
            for (let m = i, beyond = 0; m < hrs.length; m++) {
              const x = hrs[m];
              beyond = (sup ? x.c < r.lo : x.c > r.hi) ? beyond + 1 : 0;
              if (beyond >= 2) {
                outcome = "BROKE";
                outT = x.t;
                break;
              }
              if (sup ? x.h >= r.hi + 2 * x.atr : x.l <= r.lo - 2 * x.atr) {
                outcome = "HELD";
                outT = x.t;
                break;
              }
            }
            if (Number.isFinite(outT)) end = Math.min(end, byT.get(outT)!); // the touch is over when it is decided
            const seg = hrs.slice(i, end + 1);
            const t: Touch = {
              t0: hrs[i].t,
              t1: hrs[end].t,
              n: seg.length,
              liq: seg.reduce((a, x) => a + (sup ? x.liqL : x.liqS), 0),
              oi: (100 * (seg[seg.length - 1].oi1 - seg[0].oi0)) / seg[0].oi0,
              buy:
                (100 * seg.reduce((a, x) => a + x.tb, 0)) /
                Math.max(
                  1e-9,
                  seg.reduce((a, x) => a + x.v, 0),
                ),
              end: "open",
              endT: NaN,
            };
            t.end = outcome;
            t.endT = outT;
            w.touches.push(t);
            if (t.end !== "HELD") break;
            i = Math.max(end + 1, byT.get(t.endT)! + 1);
          }
          walls.push(w);
        }
      }
      console.log(
        `\n═══ ${sym} · ${utc(from)} -> ${utc(now)} UTC · price now ${px(hrs[hrs.length - 1].c)} · walls with ${minExt}+ extremes (wicks in) ═══`,
      );
      for (const w of walls
        .filter((x) => x.extremes.length >= minExt)
        .sort((a, b) => b.hi - a.hi)) {
        const sup = w.kind === "SUPPORT",
          held = w.touches.filter((t) => t.end === "HELD").length;
        console.log(
          `\n  ${sup ? "🟩 SUPPORT" : "🟥 RESIST "} ${px(w.lo)} – ${px(w.hi)} (${((100 * (w.hi - w.lo)) / w.lo).toFixed(2)}% wide) · ${w.extremes.length} extremes (${w.extremes.map((i) => utc(hrs[i].t)).join(", ")}) · touches ${w.touches.length}: held ${held}${w.touches.some((t) => t.end === "BROKE") ? " · then BROKE" : ""}`,
        );
        w.touches.forEach((t, n) =>
          console.log(
            `     touch ${n + 1}: ${utc(t.t0)} -> ${utc(t.t1)} (${t.n}h) · ${sup ? "longs" : "shorts"} liq ${usd(t.liq)} · OI ${sp(t.oi)}% · buy ${t.buy.toFixed(0)}% · ${t.end === "HELD" ? "✅ HELD" : t.end === "BROKE" ? `❌ BROKE ${utc(t.endT)}` : "… open"}`,
          ),
        );
      }
      for (const w of walls)
        w.touches.forEach((t, n) => {
          if (t.end !== "open")
            stats.push({
              k: n + 1,
              held: t.end === "HELD",
              liq: t.liq,
              kind: w.kind,
            });
        });
    }
    console.log(
      `\n═══ all walls of ${syms.join(", ")}: does a wall get stronger with every fight? ═══`,
    );
    for (const [name, f] of [
      ["1st touch", (s: { k: number }) => s.k === 1],
      ["2nd touch", (s: { k: number }) => s.k === 2],
      ["3rd touch", (s: { k: number }) => s.k === 3],
      ["4th+ touch", (s: { k: number }) => s.k >= 4],
    ] as const) {
      const l = stats.filter(f);
      console.log(
        `  ${name.padEnd(11)} ${String(l.length).padStart(3)} decided · ✅ held ${l.filter((s) => s.held).length} (${l.length ? Math.round((100 * l.filter((s) => s.held).length) / l.length) : 0}%) · ❌ broke ${l.filter((s) => !s.held).length}`,
      );
    }
    const med =
      [...stats.map((s) => s.liq)].sort((a, b) => a - b)[
        Math.floor(stats.length / 2)
      ] ?? 0;
    for (const [name, f] of [
      [
        `touches with liquidations above the median (${usd(med)})`,
        (s: { liq: number }) => s.liq > med,
      ],
      [
        "touches with liquidations at / below it",
        (s: { liq: number }) => s.liq <= med,
      ],
    ] as const) {
      const l = stats.filter(f);
      console.log(
        `  ${name.padEnd(52)} ${String(l.length).padStart(3)} · ✅ held ${l.length ? Math.round((100 * l.filter((s) => s.held).length) / l.length) : 0}%`,
      );
    }
    console.log(`(~14 days, few coins: a look, not proof)`);
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
