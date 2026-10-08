/**
 * THE LIQUIDATION ZONES OVER TIME (Johnny, Oct 8 2026) -- research, read-only, text only.
 * Where the LONGS were liquidated (below) and where the SHORTS were liquidated (above), period by period, so the eye
 * can see when the market stays in its body and when it turns:
 *   · the new LONGS zone at / above the old SHORTS zone  -> ⬆ TURNED UP   (longs now die where shorts died)
 *   · the new SHORTS zone at / below the old LONGS zone  -> ⬇ TURNED DOWN
 * Data: OUR DB -- liq_raw_events (price, side, $), minute_bars (OI per minute, mark price); Binance 4h candles.
 * Every 4h close, over the last --window 4h candles (12 = 2 days):
 *   price bands of 0.25 x the 4h ATR; LONGS zone = the band with the most longs liquidated, widened to its neighbours
 *   with >= 2/3 of it; SHORTS zone the same. Two ways, side by side:
 *     A  all liquidations
 *     B  only liquidations in minutes when OI FELL (positions really closed) -- usually narrower
 *   a zone counts only when at least --touch different 4h candles reached it AND had liquidations of that side in it
 *   OI there = the OI that left (minutes with OI down, price in the zone), in % of the OI at the window's start
 * A PERIOD goes on while both zones stay where they were (they overlap); a zone that moves starts a new period
 * (its start = the 4h close where the change was seen; the first period starts at the first window's start).
 * TURNED UP only when the LONGS zone really moved up AND reached the old SHORTS zone; TURNED DOWN the mirror.
 *
 *   npx tsx src/tools/liq-zones-timeline.ts --symbols XRPUSDT,SOLUSDT
 *   options: --days 14  --window 12  --touch 3
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
const usd = (v: number): string =>
  v >= 1e6
    ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1e3
      ? `$${(v / 1e3).toFixed(0)}k`
      : `$${v.toFixed(0)}`;
const M = 60_000,
  H = 60 * M,
  H4 = 4 * H,
  D = 24 * H;
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
interface Liq {
  t: number;
  long: boolean;
  usd: number;
  p: number;
  oiDown: boolean;
}
interface Zone {
  lo: number;
  hi: number;
  liq: number;
  touches: number;
  oiPct: number;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const syms = arg("symbols", "XRPUSDT,SOLUSDT")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const days = Number(arg("days", "14")),
    WIN = Number(arg("window", "12")),
    TOUCH = Number(arg("touch", "3"));
  const now = Date.now();
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const sym of syms) {
      const from = Math.floor((now - days * D) / H4) * H4;
      const rows: unknown[][] = (
        await fapi.get("/fapi/v1/klines", {
          params: {
            symbol: sym,
            interval: "4h",
            startTime: from - 15 * H4,
            endTime: now - 1,
            limit: 1500,
          },
        })
      ).data;
      const c4: C[] = rows
        .map((r) => ({
          t: Number(r[0]),
          o: Number(r[1]),
          h: Number(r[2]),
          l: Number(r[3]),
          c: Number(r[4]),
        }))
        .filter((x) => x.t + H4 <= now);
      // the 4h ATR (median over the period) -> the band width
      const trs = c4
        .slice(1)
        .map((x, i) =>
          Math.max(x.h - x.l, Math.abs(x.h - c4[i].c), Math.abs(x.l - c4[i].c)),
        )
        .sort((a, b) => a - b);
      const w = 0.25 * trs[Math.floor(trs.length / 2)];
      // OI per minute (ours) and the liquidations, each marked: did OI fall in its minute?
      const bars = await db
        .collection(MINUTE_BARS)
        .find({
          symbol: sym,
          oiLast: { $gt: 0 },
          ts: { $gte: new Date(from - H) },
        })
        .project({ _id: 0, ts: 1, oiLast: 1, close: 1 })
        .sort({ ts: 1 })
        .toArray();
      const oi = new Map<number, number>(),
        close = new Map<number, number>();
      for (const b of bars) {
        const t = (b.ts as Date).getTime();
        oi.set(t, Number(b.oiLast));
        close.set(t, Number(b.close));
      }
      const docs = await db
        .collection("liq_raw_events")
        .find({
          symbol: sym,
          victim: { $in: ["LONG", "SHORT"] },
          timestamp: { $gte: from },
        })
        .project({ _id: 0, timestamp: 1, victim: 1, quoteQty: 1, price: 1 })
        .toArray();
      const liqs: Liq[] = docs
        .map((d) => {
          const t = Number(d.timestamp),
            m = Math.floor(t / M) * M,
            a = oi.get(m - M),
            b = oi.get(m);
          return {
            t,
            long: d.victim === "LONG",
            usd: Number(d.quoteQty),
            p: Number(d.price),
            oiDown: a !== undefined && b !== undefined && b < a,
          };
        })
        .filter((x) => x.p > 0)
        .sort((a, b) => a.t - b.t);
      if (!liqs.length) {
        console.log(`\n${sym}: no liquidations in our DB`);
        continue;
      }
      const first = Math.max(from, Math.ceil(liqs[0].t / H4) * H4);
      const bin = (p: number): number => Math.floor(p / w);
      // OI that left while the price was in [lo, hi], in the window, in $ (minutes with OI down)
      const oiLeft = (
        t0: number,
        t1: number,
        lo: number,
        hi: number,
      ): number => {
        let s = 0;
        for (let t = t0; t < t1; t += M) {
          const a = oi.get(t - M),
            b = oi.get(t),
            p = close.get(t);
          if (
            a !== undefined &&
            b !== undefined &&
            p !== undefined &&
            b < a &&
            p >= lo &&
            p <= hi
          )
            s += (a - b) * p;
        }
        return s;
      };

      const zoneOf = (
        t0: number,
        t1: number,
        long: boolean,
        onlyOiDown: boolean,
      ): Zone | null => {
        const m = new Map<number, number>();
        const win = liqs.filter(
          (q) =>
            q.t >= t0 &&
            q.t < t1 &&
            q.long === long &&
            (!onlyOiDown || q.oiDown),
        );
        for (const q of win) m.set(bin(q.p), (m.get(bin(q.p)) ?? 0) + q.usd);
        let pk = NaN,
          pv = 0;
        for (const [b, v] of m)
          if (v > pv) {
            pv = v;
            pk = b;
          }
        if (!(pv > 0)) return null;
        let a = pk,
          z = pk;
        while ((m.get(a - 1) ?? 0) >= (2 / 3) * pv) a--;
        while ((m.get(z + 1) ?? 0) >= (2 / 3) * pv) z++;
        const lo = a * w,
          hi = (z + 1) * w;
        let liq = 0;
        for (let b = a; b <= z; b++) liq += m.get(b) ?? 0;
        // touches: 4h candles of the window that reached the zone AND had liquidations of that side in it
        const hit = new Set<number>();
        for (const q of win)
          if (q.p >= lo && q.p < hi) hit.add(Math.floor(q.t / H4) * H4);
        let touches = 0;
        for (const x of c4)
          if (x.t >= t0 && x.t < t1 && x.l <= hi && x.h >= lo && hit.has(x.t))
            touches++;
        const oi0 = oi.get(Math.floor(t0 / M) * M) ?? [...oi.values()][0];
        const price0 = close.get(Math.floor(t0 / M) * M) ?? (lo + hi) / 2;
        return {
          lo,
          hi,
          liq,
          touches,
          oiPct: oi0 ? (100 * oiLeft(t0, t1, lo, hi)) / (oi0 * price0) : NaN,
        };
      };

      const overlap = (a: Zone | null, b: Zone | null): boolean =>
        !!a && !!b && a.lo <= b.hi + w && b.lo <= a.hi + w;
      const zs = (z: Zone | null): string =>
        z
          ? `${px(z.lo)}–${px(z.hi)} ${usd(z.liq)} · OI left ${z.oiPct.toFixed(1)}% · ${z.touches} touches${z.touches < TOUCH ? " (weak)" : ""}`
          : "none";

      console.log(
        `\n═══ ${sym} · our liquidations from ${utc(liqs[0].t)} UTC · 4h steps, each over the last ${WIN} candles (${WIN * 4}h) · bands ${px(w)} · a zone needs ${TOUCH}+ touches ═══`,
      );
      for (const [label, onlyOi] of [
        ["A · ALL liquidations", false],
        ["B · liquidations while OI FELL", true],
      ] as const) {
        console.log(`\n  ${label}`);
        let cur: {
          s: number;
          e: number;
          L: Zone | null;
          S: Zone | null;
        } | null = null;
        const print = (
          p: { s: number; e: number; L: Zone | null; S: Zone | null },
          note: string,
        ): void => {
          console.log(`  ${utc(p.s)} → ${utc(p.e)}  ⬇ LONGS ${zs(p.L)}`);
          console.log(
            `  ${" ".repeat(26)}⬆ SHORTS ${zs(p.S)}${note ? `\n  ${" ".repeat(26)}${note}` : ""}`,
          );
        };
        let pendingNote = "";
        for (
          let t1 = first + WIN * H4;
          t1 <= Math.floor(now / H4) * H4;
          t1 += H4
        ) {
          const t0 = t1 - WIN * H4;
          const Lz = zoneOf(t0, t1, true, onlyOi),
            Sz = zoneOf(t0, t1, false, onlyOi);
          const L = Lz && Lz.touches >= TOUCH ? Lz : null,
            S = Sz && Sz.touches >= TOUCH ? Sz : null;
          if (!cur) {
            cur = { s: t0, e: t1, L, S };
            continue;
          }
          const sameL = (!cur.L && !L) || overlap(cur.L, L),
            sameS = (!cur.S && !S) || overlap(cur.S, S);
          if (sameL && sameS) {
            cur.e = t1;
            if (L) cur.L = L;
            if (S) cur.S = S;
            continue;
          }
          // a zone moved -> print the period that ended, then say what changed
          print(cur, pendingNote);
          const notes: string[] = [];
          if (!sameL && L && cur.L)
            notes.push(`LONGS zone moved ${L.lo > cur.L.hi ? "UP" : "DOWN"}`);
          if (!sameS && S && cur.S)
            notes.push(`SHORTS zone moved ${S.lo > cur.S.hi ? "UP" : "DOWN"}`);
          if (
            !sameL &&
            L &&
            cur.L &&
            cur.S &&
            L.lo > cur.L.hi &&
            L.hi >= cur.S.lo - w
          )
            notes.push("⬆ TURNED UP: longs now die where the shorts died");
          if (
            !sameS &&
            S &&
            cur.S &&
            cur.L &&
            S.hi < cur.S.lo &&
            S.lo <= cur.L.hi + w
          )
            notes.push("⬇ TURNED DOWN: shorts now die where the longs died");
          if (!L && cur.L) notes.push("the LONGS zone faded");
          if (!S && cur.S) notes.push("the SHORTS zone faded");
          pendingNote = notes.length ? `→ ${notes.join(" · ")}` : "";
          console.log(pendingNote ? `  ${" ".repeat(26)}${pendingNote}` : "");
          pendingNote = "";
          cur = { s: t1, e: t1, L, S }; // the new period starts at the 4h close where the change was seen
        }
        if (cur) {
          print(cur, "");
          console.log(`  ${" ".repeat(26)}(still going)`);
        }
      }
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
