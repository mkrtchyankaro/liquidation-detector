/**
 * HOW THE PRICE LEAVES A WALL (Johnny, Oct 7 2026) -- research, not a rule. Read-only.
 * The walls are given by hand (from zone-profile / the chart): --walls 117-118.4,120.5-122.3
 * Data: Binance 1h klines (price, volume, taker buy) + OUR DB (OI per minute, liquidations ~14 days).
 *   VISIT  the price comes to a wall: 1h candles that touch the wall (widened by 0.25 x the 1h ATR on each side).
 *          The visit ends only when 3 candles IN A ROW stay away from it (out 1-2 candles and back = still the same visit).
 *          came from = the side of the close before the visit · left to = the side of the first candle away
 *          BOUNCE = left to the side it came from · THROUGH = left to the other side
 *   for every visit, every 1h candle: price %, OI %, buy %, longs / shorts liquidated; then
 *     the stay   hours, OI change over the stay, liquidations, buy %
 *     the exit   the last candle at the wall + the first candle away: OI %, buy %, liquidations
 *     after      the best move away from the wall in the next 4h / 12h (in 1h ATRs and %) and whether it came back
 *                to the wall within 12h
 *   summary: bounces vs throughs, and the 12h move after the exit split by the OI at the exit (rising vs falling).
 *
 *   ROOM between two walls: the gap from one wall to the next, in % and in 4h-ATR-like terms = gap / wall width
 *        (a trade from one wall to the other risks about the wall width and can make about the gap)
 *   --m15  every visit is opened on 15m candles: a TRIGGER = the first 15m candle whose BODY (open and close) is fully
 *        outside the wall after the price was in it -- the trade would start at that candle's close:
 *          the 15m candles before it, each with its kind:  newL = price up + OI up · newS = price down + OI up ·
 *                                                         S-close = price up + OI down · L-close = price down + OI down
 *          FAKE = a 15m close back inside the wall within the next hour
 *          stop = the far edge of the wall · target = the near edge of the next wall that way (none: 2 x the risk)
 *          -> TARGET / STOP first within 24h (both in one candle = STOP), and how much earlier than the 1h exit
 *
 *   npx tsx src/tools/wall-exits.ts --symbol SOLUSDT --walls 117-118.4,120.5-122.3
 *   options: --days 15 (it starts at our first OI in the DB at the earliest)  --brief (no candle rows)  --m15
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
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "  n/a";
const px = (v: number): string => String(+v.toPrecision(5));
const usd = (v: number): string =>
  v >= 1e6
    ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1e3
      ? `$${(v / 1e3).toFixed(0)}k`
      : v > 0
        ? `$${v.toFixed(0)}`
        : "-";
const M = 60_000,
  H = 60 * M,
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
interface Q {
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
}
interface Ev {
  real: boolean;
  res: "TARGET" | "STOP" | "-";
  early: number;
}
interface Exit {
  name: string;
  bounce: boolean;
  oiExit: number;
  move12: number;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const sym = arg("symbol", "SOLUSDT").toUpperCase(),
    days = Number(arg("days", "15")),
    m15 = argv.includes("--m15"),
    brief = argv.includes("--brief") || m15;
  const walls = arg("walls", "")
    .split(",")
    .map((w) => w.split("-").map(Number))
    .filter((w) => w.length === 2 && w[0] > 0 && w[1] > w[0]);
  if (!walls.length)
    throw new Error(
      "use --walls LOW-HIGH,LOW-HIGH  e.g. --walls 117-118.4,120.5-122.3",
    );
  const now = Math.floor(Date.now() / H) * H;
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const firstOi = await db
      .collection(MINUTE_BARS)
      .find({ symbol: sym, oiLast: { $gt: 0 } })
      .project({ ts: 1 })
      .sort({ ts: 1 })
      .limit(1)
      .toArray();
    const from = Math.max(
      now - days * D,
      firstOi.length
        ? Math.ceil((firstOi[0].ts as Date).getTime() / H) * H
        : now - days * D,
    );
    const rows: unknown[][] = (
      await fapi.get("/fapi/v1/klines", {
        params: {
          symbol: sym,
          interval: "1h",
          startTime: from - D,
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
            ts: { $gte: new Date(from - D), $lt: new Date(now) },
          })
          .project({ ts: 1, oiLast: 1 })
          .toArray()
      ).map((d) => [(d.ts as Date).getTime(), Number(d.oiLast)]),
    );
    const oiAt = (t: number): number => {
      for (let x = t - M; x > t - 15 * M; x -= M) {
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
        timestamp: { $gte: from - D, $lt: now },
      })
      .project({ timestamp: 1, victim: 1, quoteQty: 1 })
      .toArray();
    const hrs: Hr[] = rows.map((r) => ({
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
    for (const q of liqs) {
      const i = byT.get(Math.floor(Number(q.timestamp) / H) * H);
      if (i !== undefined) {
        if (q.victim === "LONG") hrs[i].liqL += Number(q.quoteQty);
        else hrs[i].liqS += Number(q.quoteQty);
      }
    }
    for (let i = 1; i < hrs.length; i++) {
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
      hrs[i].atr = s / n;
    }
    // 15m candles (paged), with our OI and liquidations
    const Qs: Q[] = [];
    if (m15) {
      for (let s0 = from - 4 * H; s0 < now; ) {
        const r: unknown[][] = (
          await fapi.get("/fapi/v1/klines", {
            params: {
              symbol: sym,
              interval: "15m",
              startTime: s0,
              endTime: now + H - 1,
              limit: 1500,
            },
          })
        ).data;
        if (!r.length) break;
        for (const x of r) {
          const t = Number(x[0]);
          Qs.push({
            t,
            o: Number(x[1]),
            h: Number(x[2]),
            l: Number(x[3]),
            c: Number(x[4]),
            v: Number(x[5]),
            tb: Number(x[9]),
            oi0: oiAt(t),
            oi1: oiAt(t + 15 * M),
            liqL: 0,
            liqS: 0,
          });
        }
        s0 = Number(r[r.length - 1][0]) + 1;
        if (r.length < 1500) break;
      }
      const qi = new Map(Qs.map((x, k) => [x.t, k]));
      for (const q of liqs) {
        const k = qi.get(Math.floor(Number(q.timestamp) / (15 * M)) * 15 * M);
        if (k !== undefined) {
          if (q.victim === "LONG") Qs[k].liqL += Number(q.quoteQty);
          else Qs[k].liqS += Number(q.quoteQty);
        }
      }
    }
    const evs: Ev[] = [];
    const sorted = walls.slice().sort((x, y) => x[0] - y[0]);
    const kind = (x: Q): string => {
      const p = x.c - x.o,
        d = x.oi1 - x.oi0;
      return !Number.isFinite(d)
        ? "?"
        : p >= 0
          ? d >= 0
            ? "newL"
            : "S-close"
          : d >= 0
            ? "newS"
            : "L-close";
    };
    const qrow = (x: Q, mark: string): string =>
      `   ${mark} ${utc(x.t)}  ${px(x.o).padEnd(8)} ${px(x.h).padEnd(8)} ${px(x.l).padEnd(8)} ${px(x.c).padEnd(8)} ${sp((100 * (x.c - x.o)) / x.o).padStart(6)}%  OI ${sp((100 * (x.oi1 - x.oi0)) / x.oi0).padStart(6)}%  buy ${x.v > 0 ? Math.round((100 * x.tb) / x.v) : 0}%  liq L ${usd(x.liqL).padStart(6)} S ${usd(x.liqS).padStart(6)}  ${kind(x)}`;
    const study15 = (
      t0: number,
      t1: number,
      lo: number,
      hi: number,
      exitClose: number,
    ): void => {
      let k = Qs.findIndex((x) => x.t >= t0);
      if (k < 0) return;
      let touched = false,
        n = 0;
      for (; k < Qs.length && Qs[k].t < t1; k++) {
        const x = Qs[k];
        if (x.l <= hi && x.h >= lo) {
          touched = true;
          continue;
        }
        const up = Math.min(x.o, x.c) > hi,
          dn = Math.max(x.o, x.c) < lo;
        if (!touched || !(up || dn)) continue;
        touched = false;
        n++;
        const entry = x.c,
          stop = up ? lo : hi;
        const nextW = up
          ? sorted.find((w) => w[0] > hi)
          : sorted
              .slice()
              .reverse()
              .find((w) => w[1] < lo);
        const target = nextW
          ? up
            ? nextW[0]
            : nextW[1]
          : up
            ? entry + 2 * (entry - stop)
            : entry - 2 * (stop - entry);
        let fake = false;
        for (let m = k + 1; m <= Math.min(Qs.length - 1, k + 4); m++)
          if (Qs[m].c >= lo && Qs[m].c <= hi) {
            fake = true;
            break;
          }
        let res: "TARGET" | "STOP" | "-" = "-",
          when = 0;
        for (let m = k + 1; m < Math.min(Qs.length, k + 97); m++) {
          const hitS = up ? Qs[m].l <= stop : Qs[m].h >= stop,
            hitT = up ? Qs[m].h >= target : Qs[m].l <= target;
          if (hitS) {
            res = "STOP";
            when = Qs[m].t;
            break;
          }
          if (hitT) {
            res = "TARGET";
            when = Qs[m].t;
            break;
          }
        }
        const risk = (100 * Math.abs(entry - stop)) / entry,
          reward = (100 * Math.abs(target - entry)) / entry;
        const early = exitClose > 0 ? (exitClose - (x.t + 15 * M)) / M : NaN;
        console.log(`
    15m TRIGGER #${n} ${utc(x.t)} body ${up ? "ABOVE ⬆" : "BELOW ⬇"} the wall · entry ${px(entry)} · stop ${px(stop)} (-${risk.toFixed(2)}%) · target ${px(target)} (+${reward.toFixed(2)}%, R:R ${(reward / risk).toFixed(1)})`);
        for (
          let m = Math.max(0, k - 6);
          m <= Math.min(Qs.length - 1, k + 3);
          m++
        )
          console.log(
            qrow(
              Qs[m],
              m === k ? "→" : Qs[m].l <= hi && Qs[m].h >= lo ? "▌" : " ",
            ),
          );
        console.log(
          `    -> ${fake ? "FAKE (closed back in the wall within 1h)" : "REAL (stayed out 1h)"} · ${res === "-" ? "neither in 24h" : `${res} first ${utc(when)}`}${Number.isFinite(early) ? ` · ${early >= 0 ? `${early} min BEFORE` : `${-early} min AFTER`} the 1h exit candle closed` : ""}`,
        );
        if (k + 97 <= Qs.length || res !== "-")
          evs.push({ real: !fake, res, early });
      }
      if (n === 0)
        console.log(`    15m: no candle body fully outside the wall yet`);
    };
    const oiPct = (a: number, b: number): number =>
      (100 * (hrs[b].oi1 - hrs[a].oi0)) / hrs[a].oi0;
    const buyPct = (a: number, b: number): number => {
      let v = 0,
        tb = 0;
      for (let j = a; j <= b; j++) {
        v += hrs[j].v;
        tb += hrs[j].tb;
      }
      return v > 0 ? (100 * tb) / v : NaN;
    };
    const sum = (a: number, b: number, f: (x: Hr) => number): number => {
      let s = 0;
      for (let j = a; j <= b; j++) s += f(hrs[j]);
      return s;
    };
    const row = (x: Hr, mark: string): string =>
      `   ${mark} ${utc(x.t)}  ${px(x.o).padEnd(8)} ${px(x.h).padEnd(8)} ${px(x.l).padEnd(8)} ${px(x.c).padEnd(8)} ${sp((100 * (x.c - x.o)) / x.o).padStart(6)}%  OI ${sp((100 * (x.oi1 - x.oi0)) / x.oi0).padStart(6)}%  buy ${x.v > 0 ? Math.round((100 * x.tb) / x.v) : 0}%  liq L ${usd(x.liqL).padStart(6)} S ${usd(x.liqS).padStart(6)}`;
    const start = hrs.findIndex((x) => x.t >= from);
    const all: Exit[] = [];
    console.log(
      `${sym} · 1h · ${utc(from)} -> ${utc(now)} UTC · walls ${walls.map((w) => `${px(w[0])}–${px(w[1])}`).join(", ")} · OI and liq = our DB`,
    );
    const atrNow = hrs[hrs.length - 1].atr;
    for (let w = 0; w + 1 < sorted.length; w++) {
      const gap = sorted[w + 1][0] - sorted[w][1],
        wid = Math.max(
          sorted[w][1] - sorted[w][0],
          sorted[w + 1][1] - sorted[w + 1][0],
        );
      console.log(
        `ROOM ${px(sorted[w][1])} -> ${px(sorted[w + 1][0])}: ${px(gap)} = ${((100 * gap) / sorted[w][1]).toFixed(2)}% = ${(gap / atrNow).toFixed(1)} x 1h ATR · walls up to ${px(wid)} wide (${((100 * wid) / sorted[w][1]).toFixed(2)}%) -> gap / wall width ${(gap / wid).toFixed(1)}`,
      );
    }

    for (const [lo, hi] of walls) {
      console.log(`\n══════ WALL ${px(lo)} – ${px(hi)} ══════`);
      const near = (i: number): boolean => {
        const a = 0.25 * hrs[i].atr;
        return hrs[i].l <= hi + a && hrs[i].h >= lo - a;
      };
      let i = start;
      while (i < hrs.length) {
        if (!near(i)) {
          i++;
          continue;
        }
        const a = i;
        let b = i,
          away = 0,
          j = i + 1;
        for (; j < hrs.length; j++) {
          if (near(j)) {
            b = j;
            away = 0;
          } else if (++away >= 3) break;
        }
        const pre = hrs[a - 1],
          cameFrom = pre ? (pre.c > (lo + hi) / 2 ? "above" : "below") : "?";
        const ex = b + 1 < hrs.length && away >= 3 ? b + 1 : -1;
        const leftTo = ex >= 0 ? (hrs[ex].l > hi ? "above" : "below") : "";
        const stay = b - a + 1;
        console.log(
          `\n  VISIT ${utc(hrs[a].t)} · came from ${cameFrom} · at the wall ${stay}h · stay: OI ${sp(oiPct(a, b))}% · buy ${buyPct(a, b).toFixed(0)}% · liq longs ${usd(sum(a, b, (x) => x.liqL))} shorts ${usd(sum(a, b, (x) => x.liqS))}`,
        );
        if (!brief) {
          console.log(
            `        time         open     high     low      close     price      OI`,
          );
          for (
            let k = Math.max(start, a - 2);
            k <= Math.min(hrs.length - 1, (ex >= 0 ? ex : b) + 4);
            k++
          )
            console.log(
              row(hrs[k], k < a ? " " : k <= b ? "▌" : k === ex ? "→" : " "),
            );
        }
        if (m15)
          study15(
            hrs[a].t - H,
            ex >= 0 ? hrs[ex].t + 2 * H : now + H,
            lo,
            hi,
            ex >= 0 ? hrs[ex].t + H : NaN,
          );
        if (ex < 0) {
          console.log(`  -> still at the wall (or not 3h away yet)`);
          i = hrs.length;
          break;
        }
        const up = leftTo === "above",
          bounce = leftTo === cameFrom,
          edge = up ? hi : lo,
          atr = hrs[ex].atr;
        const best = (n: number): number => {
          let m = 0;
          for (let k = ex; k < Math.min(hrs.length, ex + n); k++)
            m = Math.max(m, up ? hrs[k].h - edge : edge - hrs[k].l);
          return m;
        };
        let back = -1;
        for (let k = ex; k < Math.min(hrs.length, ex + 12); k++)
          if (up ? hrs[k].l <= hi : hrs[k].h >= lo) {
            back = k;
            break;
          }
        const oiExit = oiPct(b, ex),
          m4 = best(4),
          m12 = best(12),
          done = ex + 12 <= hrs.length;
        console.log(
          `  EXIT ${utc(hrs[ex].t)} -> ${up ? "UP ⬆" : "DOWN ⬇"} ${bounce ? "BOUNCE (back where it came from)" : "THROUGH the wall"} · exit 2h: OI ${sp(oiExit)}% · buy ${buyPct(b, ex).toFixed(0)}% · liq longs ${usd(sum(b, ex, (x) => x.liqL))} shorts ${usd(sum(b, ex, (x) => x.liqS))}`,
        );
        console.log(
          `        after: best move from the wall 4h ${(m4 / atr).toFixed(1)} ATR (${sp((100 * m4) / edge)}%) · 12h ${(m12 / atr).toFixed(1)} ATR (${sp((100 * m12) / edge)}%)${done ? "" : " (12h not over yet)"} · ${back >= 0 ? `came back to the wall ${utc(hrs[back].t)}` : "did not come back in 12h"}`,
        );
        if (done)
          all.push({
            name: `${px(lo)}–${px(hi)} ${utc(hrs[ex].t)}`,
            bounce,
            oiExit,
            move12: m12 / atr,
          });
        i = ex;
      }
    }

    console.log(`\n═══ SUMMARY (exits with 12h after them) ═══`);
    const avg = (l: Exit[]): string =>
      l.length
        ? `${l.length} exits, avg 12h move ${(l.reduce((s, e) => s + e.move12, 0) / l.length).toFixed(1)} ATR`
        : "0 exits";
    console.log(`  BOUNCE  ${avg(all.filter((e) => e.bounce))}`);
    console.log(`  THROUGH ${avg(all.filter((e) => !e.bounce))}`);
    console.log(`  exit OI rising  ${avg(all.filter((e) => e.oiExit > 0))}`);
    console.log(`  exit OI falling ${avg(all.filter((e) => e.oiExit <= 0))}`);
    if (m15) {
      const sumE = (l: Ev[]): string =>
        `${l.length} triggers: TARGET first ${l.filter((e) => e.res === "TARGET").length} · STOP first ${l.filter((e) => e.res === "STOP").length} · neither ${l.filter((e) => e.res === "-").length}`;
      console.log(`  15m REAL  ${sumE(evs.filter((e) => e.real))}`);
      console.log(`  15m FAKE  ${sumE(evs.filter((e) => !e.real))}`);
      const er = evs.filter((e) => Number.isFinite(e.early));
      if (er.length)
        console.log(
          `  15m trigger vs the 1h exit candle close: median ${er.map((e) => e.early).sort((x, y) => x - y)[Math.floor(er.length / 2)]} min earlier`,
        );
      console.log(`  (fees ~0.1% per trade are not in TARGET / STOP)`);
    }
    console.log(`(one coin, ~2 weeks -- a look, not proof)`);
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
