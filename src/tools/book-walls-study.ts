/**
 * THE LIMIT-ORDER WALLS (Johnny, Oct 8 2026) -- research, read-only, text only. "Can I tell from the limit orders
 * where the walls are?"
 * Data: OUR DB -- v10_book (one order-book snapshot per 15m close since Oct 4: the 3 biggest 0.1% slices of each side
 * within 3% of the price = "walls", and $ within 1% / 2%), minute_bars (OI), liq_raw_events; Binance public 1m candles.
 * The slice right at the price (0-0.1%) is left out: it is always big and moves with the price, it is not a wall.
 *
 * 1 WALL TRACKS: a wall seen again in the next snapshots at the same price (within one slice, 0.1%) is the SAME wall;
 *   a gap of one snapshot is allowed (only the top 3 are kept, a wall can drop to 4th for a moment).
 *   Shown: walls that lived >= --minHours, or that the price reached.
 * 2 WHAT HAPPENED when the price reached the wall (a 1m low <= a buy wall / a 1m high >= a sell wall, while it lived):
 *   HELD   no 1m close beyond the wall by more than one slice in the next --after minutes
 *   BROKE  the price closed through it (the wall was eaten or pulled at the touch)
 *   PULLED a wall that lived >= --minHours vanished BEFORE the price came, and the price crossed its price within
 *          --after minutes after that
 *   + stayed / gone = was the wall still in the next snapshot after the touch
 *   + OI change and liquidations from the touch to --after minutes later
 * 3 liq here = $ longs / shorts liquidated at the wall's price (± one slice) over the whole period
 * 4 HOUR BY HOUR (the last --hours): price, buy / sell limit $ within 1% and 2%, the buyers' share, OI, liquidations,
 *   the biggest buy and sell wall
 *
 *   npx tsx src/tools/book-walls-study.ts --symbol XRPUSDT
 *   options: --minHours 1  --after 60  --hours 48
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { V10_BOOK } from "../strategy/v10/v10-book";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const M = 60_000,
  H = 60 * M,
  Q = 15 * M;
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
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "n/a";
const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length);
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const SLICE = 0.001; // the recorder's slice: 0.1% of the price

interface K {
  t: number;
  h: number;
  l: number;
  c: number;
}
interface WallPt {
  price: number;
  usd: number;
  distPct: number;
}
interface Snap {
  t: number;
  mid: number;
  bid1: number;
  ask1: number;
  bid2: number;
  ask2: number;
  bids: WallPt[];
  asks: WallPt[];
}
interface Track {
  buy: boolean;
  price: number;
  pw: number;
  w: number;
  maxUsd: number;
  first: number;
  last: number;
  seen: number[];
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const sym = arg("symbol", "XRPUSDT").toUpperCase();
  const MINH = Number(arg("minHours", "1")),
    AFTER = Number(arg("after", "60")) * M,
    HOURS = Number(arg("hours", "48"));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const docs = await db
      .collection(V10_BOOK)
      .find({ symbol: sym })
      .sort({ candleEnd: 1 })
      .toArray();
    const snaps: Snap[] = docs
      .map((d) => ({
        t: (d.candleEnd as Date).getTime(),
        mid: Number(d.mid),
        bid1: Number(d.bid1),
        ask1: Number(d.ask1),
        bid2: Number(d.bid2),
        ask2: Number(d.ask2),
        bids: ((d.walls?.bids ?? []) as WallPt[]).filter(
          (w) => Math.abs(w.distPct) >= 100 * SLICE,
        ),
        asks: ((d.walls?.asks ?? []) as WallPt[]).filter(
          (w) => Math.abs(w.distPct) >= 100 * SLICE,
        ),
      }))
      .filter((s) => s.mid > 0);
    if (!snaps.length) {
      console.log(`${sym}: no order-book snapshots in v10_book`);
      return;
    }
    const from = snaps[0].t,
      now = Date.now();

    // Binance 1m candles over the period
    const m1: K[] = [];
    for (let s = from - H; s < now; ) {
      const rows: unknown[][] = (
        await fapi.get("/fapi/v1/klines", {
          params: {
            symbol: sym,
            interval: "1m",
            startTime: s,
            endTime: now - 1,
            limit: 1500,
          },
        })
      ).data;
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows)
        m1.push({
          t: Number(r[0]),
          h: Number(r[2]),
          l: Number(r[3]),
          c: Number(r[4]),
        });
      s = Number(rows[rows.length - 1][0]) + 1;
      if (rows.length < 1500) break;
    }
    const m1i = (t: number): number => {
      let a = 0,
        b = m1.length;
      while (a < b) {
        const k = (a + b) >> 1;
        if (m1[k].t < t) a = k + 1;
        else b = k;
      }
      return a;
    };
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
      const m = Math.floor(t / M) * M;
      for (let k = 0; k < 5; k++) {
        const v = oi.get(m - k * M);
        if (v !== undefined) return v;
      }
      return NaN;
    };
    const liqs = (
      await db
        .collection("liq_raw_events")
        .find({
          symbol: sym,
          victim: { $in: ["LONG", "SHORT"] },
          timestamp: { $gte: from - H },
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
    const liqIn = (
      t0: number,
      t1: number,
      lo = -Infinity,
      hi = Infinity,
    ): { L: number; S: number } => {
      let L = 0,
        S = 0;
      for (const q of liqs) {
        if (q.t < t0) continue;
        if (q.t >= t1) break;
        if (q.p >= lo && q.p <= hi) {
          if (q.long) L += q.usd;
          else S += q.usd;
        }
      }
      return { L, S };
    };

    // 1 tracks
    const tracks: Track[] = [],
      open: Track[] = [];
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      for (const buy of [true, false])
        for (const w of buy ? s.bids : s.asks) {
          const tr = open.find(
            (x) =>
              x.buy === buy &&
              Math.abs(w.price - x.price) <= SLICE * x.price &&
              s.t - x.last <= 2 * Q &&
              x.last < s.t,
          );
          if (tr) {
            tr.pw += w.price * w.usd;
            tr.w += w.usd;
            tr.price = tr.pw / tr.w;
            tr.maxUsd = Math.max(tr.maxUsd, w.usd);
            tr.last = s.t;
            tr.seen.push(s.t);
          } else {
            const n: Track = {
              buy,
              price: w.price,
              pw: w.price * w.usd,
              w: w.usd,
              maxUsd: w.usd,
              first: s.t,
              last: s.t,
              seen: [s.t],
            };
            open.push(n);
            tracks.push(n);
          }
        }
      for (let k = open.length - 1; k >= 0; k--)
        if (s.t - open[k].last > 2 * Q) open.splice(k, 1);
    }
    const lastSnap = snaps[snaps.length - 1].t;

    interface Out {
      kind: string;
      at: number;
      stayed: string;
      oi: number;
      L: number;
      S: number;
      away: number;
    }
    const outcome = (tr: Track): Out | null => {
      const tol = SLICE * tr.price,
        end = tr.last + Q;
      for (let i = m1i(tr.first); i < m1.length && m1[i].t < end; i++) {
        if (!(tr.buy ? m1[i].l <= tr.price : m1[i].h >= tr.price)) continue;
        const tt = m1[i].t;
        let broke = false,
          away = 0;
        for (let j = i; j < m1.length && m1[j].t < tt + AFTER; j++) {
          if (tr.buy ? m1[j].c < tr.price - tol : m1[j].c > tr.price + tol)
            broke = true;
          away = Math.max(
            away,
            (100 * (tr.buy ? m1[j].h - tr.price : tr.price - m1[j].l)) /
              tr.price,
          );
        }
        const nextSnap = snaps.find((s) => s.t > tt);
        const stayed = !nextSnap
          ? "?"
          : tr.seen.includes(nextSnap.t)
            ? "stayed"
            : "gone";
        const o0 = oiAt(tt),
          o1 = oiAt(tt + AFTER),
          lq = liqIn(tt, tt + AFTER);
        return {
          kind: broke ? "BROKE" : "HELD",
          at: tt,
          stayed,
          oi: (100 * (o1 - o0)) / o0,
          L: lq.L,
          S: lq.S,
          away,
        };
      }
      if (tr.last >= lastSnap) return null; // still there
      for (let i = m1i(end); i < m1.length && m1[i].t < end + AFTER; i++) {
        if (tr.buy ? m1[i].l <= tr.price : m1[i].h >= tr.price) {
          const tt = m1[i].t,
            o0 = oiAt(tt),
            o1 = oiAt(tt + AFTER),
            lq = liqIn(tt, tt + AFTER);
          return {
            kind: "PULLED",
            at: tt,
            stayed: "gone",
            oi: (100 * (o1 - o0)) / o0,
            L: lq.L,
            S: lq.S,
            away: NaN,
          };
        }
      }
      return null;
    };

    // a wall seen for a moment and gone is not "pulled": PULLED only for walls that lived >= --minHours
    const shown = tracks
      .map((tr) => {
        const long = tr.last - tr.first + Q >= MINH * H,
          o = outcome(tr);
        return { tr, long, o: o && (o.kind !== "PULLED" || long) ? o : null };
      })
      .filter(({ long, o }) => o || long);
    console.log(
      `\n═══ ${sym} · LIMIT-ORDER WALLS · ${snaps.length} snapshots ${utc(from)} → ${utc(lastSnap)} UTC · now ${px(m1[m1.length - 1]?.c ?? NaN)} ═══`,
    );
    console.log(
      `  a wall = one of the 3 biggest 0.1% slices of its side within 3% (not the slice at the price) · same wall = same price ±0.1%`,
    );
    console.log(
      `  shown: lived >= ${MINH}h or the price reached it · ${shown.length} of ${tracks.length} walls`,
    );
    console.log(
      `\n  side  price     biggest  avg      seen from → to (UTC)        lived  liq here L / S      what happened (next ${AFTER / M}m)`,
    );
    for (const { tr, o } of shown) {
      const lq = liqIn(
        from,
        now,
        tr.price * (1 - SLICE),
        tr.price * (1 + SLICE),
      );
      const life = (tr.last - tr.first + Q) / H;
      const what = o
        ? `${pad(o.kind, 6)} ${utc(o.at)} ${o.stayed} · OI ${sg(o.oi)}% · liq L ${usd(o.L)} S ${usd(o.S)}${Number.isFinite(o.away) ? ` · moved away ${o.away.toFixed(2)}%` : ""}`
        : tr.last >= lastSnap
          ? "still there, not reached"
          : "gone, the price never came";
      console.log(
        `  ${tr.buy ? "BUY " : "SELL"}  ${pad(px(tr.price), 9)} ${pad(usd(tr.maxUsd), 8)} ${pad(usd(tr.w / tr.seen.length), 8)} ${pad(`${utc(tr.first)} → ${utc(tr.last)}`, 27)} ${pad(life.toFixed(1) + "h", 6)} ${pad(`${usd(lq.L)} / ${usd(lq.S)}`, 19)} ${what}`,
      );
    }

    // 2 summary
    console.log(`\n── SUMMARY (walls the price reached) ──`);
    for (const buy of [true, false]) {
      const os = shown.filter((x) => x.tr.buy === buy && x.o).map((x) => x.o!);
      const c = (k: string, st?: string): number =>
        os.filter((o) => o.kind === k && (!st || o.stayed === st)).length;
      console.log(
        `  ${buy ? "BUY walls (below)" : "SELL walls (above)"}: HELD ${c("HELD")} (wall stayed ${c("HELD", "stayed")}) · BROKE ${c("BROKE")} (wall gone ${c("BROKE", "gone")}) · PULLED before the price came ${c("PULLED")}`,
      );
    }

    // 4 hour by hour
    console.log(
      `\n── HOUR BY HOUR (last ${HOURS}h) · limit $ within 1% / 2% · buyers' share within 1% ──`,
    );
    console.log(
      `  hour (UTC)   price    buy 1%   sell 1%  buy 2%   sell 2%  buyers  OI 1h    liq L / S          biggest BUY wall      biggest SELL wall`,
    );
    let prevOi = NaN;
    for (const s of snaps.filter(
      (x) => x.t % H === 0 && x.t >= lastSnap - HOURS * H,
    )) {
      const o = oiAt(s.t),
        lq = liqIn(s.t - H, s.t);
      const b = s.bids[0],
        a = s.asks[0];
      const share = (100 * s.bid1) / (s.bid1 + s.ask1);
      console.log(
        `  ${utc(s.t)}  ${pad(px(s.mid), 8)} ${pad(usd(s.bid1), 8)} ${pad(usd(s.ask1), 8)} ${pad(usd(s.bid2), 8)} ${pad(usd(s.ask2), 8)} ${pad(share.toFixed(0) + "%", 7)} ${pad(Number.isFinite(prevOi) ? sg((100 * (o - prevOi)) / prevOi) + "%" : "", 8)} ${pad(`${usd(lq.L)} / ${usd(lq.S)}`, 18)} ${pad(b ? `${px(b.price)} ${usd(b.usd)}` : "-", 21)} ${a ? `${px(a.price)} ${usd(a.usd)}` : "-"}`,
      );
      prevOi = o;
    }
    console.log(
      `\n(only the 3 biggest slices per side are stored; our liquidations: max 1 per second, lower than Binance's real totals)`,
    );
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
