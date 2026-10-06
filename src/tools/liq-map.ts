/**
 * ONE COIN'S BIGGEST LIQUIDATIONS, WITH PRICES -- to look at on the chart (Johnny, Oct 6 2026). Read-only, our DB:
 * liq_raw_events (our forceOrder stream: at most 1 liquidation per second per coin reaches us -> the sums are LOWER
 * than the real ones; kept 14 days) + minute_bars (price, OI). For 1h and 15m candles (UTC): the candles with the most
 * liquidated $, each with its prices (open / high / low / close), the price and OI change, and per side (LONGS = longs
 * liquidated = forced SELLS; SHORTS = shorts liquidated = forced BUYS): $, count, the price range and the $-weighted
 * average price of those liquidations. Then the same candles in time order.
 *
 *   npx tsx src/tools/liq-map.ts --symbol ALGOUSDT
 *   options: --top 15
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type MinBar } from "../research/dc15";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number, d = 2): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "n/a";
const usd = (v: number): string =>
  v >= 1e6
    ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1e3
      ? `$${(v / 1e3).toFixed(1)}k`
      : `$${v.toFixed(0)}`;
const px = (v: number): string =>
  Number.isFinite(v) ? String(+v.toPrecision(5)) : "-";

interface Side {
  usd: number;
  n: number;
  lo: number;
  hi: number;
  pq: number;
}
const side0 = (): Side => ({
  usd: 0,
  n: 0,
  lo: Infinity,
  hi: -Infinity,
  pq: 0,
});

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const symbol = arg("symbol", "ALGOUSDT").toUpperCase(),
    top = Number(arg("top", "15"));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const liqs = (
      await db
        .collection("liq_raw_events")
        .find({ symbol, victim: { $in: ["LONG", "SHORT"] } })
        .project({ timestamp: 1, victim: 1, quoteQty: 1, price: 1 })
        .sort({ timestamp: 1 })
        .toArray()
    )
      .map((r) => ({
        t: Number(r.timestamp),
        usd: Number(r.quoteQty),
        p: Number(r.price),
        long: r.victim === "LONG",
      }))
      .filter((x) => x.usd > 0 && x.p > 0);
    if (!liqs.length) {
      console.log(`${symbol}: no liquidations in our DB`);
      return;
    }
    const from = liqs[0].t - 3_600_000,
      to = liqs[liqs.length - 1].t + 3_600_000;
    const bars: MinBar[] = (
      await db
        .collection(MINUTE_BARS)
        .find({
          symbol,
          high: { $ne: null },
          ts: { $gte: new Date(from), $lt: new Date(to) },
        })
        .project({ ts: 1, high: 1, low: 1, close: 1, oiFirst: 1, oiLast: 1 })
        .sort({ ts: 1 })
        .toArray()
    ).map((d) => ({
      t: (d.ts as Date).getTime(),
      high: Number(d.high),
      low: Number(d.low),
      close: Number(d.close),
      oiFirst: Number(d.oiFirst),
      oiLast: Number(d.oiLast),
    }));
    const total = {
      L: liqs.filter((x) => x.long).reduce((a, x) => a + x.usd, 0),
      S: liqs.filter((x) => !x.long).reduce((a, x) => a + x.usd, 0),
    };
    console.log(
      `${symbol} · our liquidations ${utc(liqs[0].t)} -> ${utc(liqs[liqs.length - 1].t)} UTC (${((liqs[liqs.length - 1].t - liqs[0].t) / 86_400_000).toFixed(1)} days) · ${liqs.length} events`,
    );
    console.log(
      `longs liquidated ${usd(total.L)} · shorts liquidated ${usd(total.S)} · (our stream: max 1 per second -> lower than real)`,
    );
    console.log(
      `LONGS = longs liquidated (forced SELLS, price going down) · SHORTS = shorts liquidated (forced BUYS, price going up)`,
    );
    console.log(
      `avg = the $-weighted average price of those liquidations · range = their lowest .. highest price\n`,
    );

    for (const tf of [60, 15]) {
      const c = candles(bars, tf),
        W = tf * 60_000;
      const byT = new Map(c.map((x) => [x.t, { x, L: side0(), S: side0() }]));
      for (const l of liqs) {
        const k = byT.get(Math.floor(l.t / W) * W);
        if (!k) continue;
        const s = l.long ? k.L : k.S;
        s.usd += l.usd;
        s.n++;
        s.lo = Math.min(s.lo, l.p);
        s.hi = Math.max(s.hi, l.p);
        s.pq += l.p * l.usd;
      }
      const rows = [...byT.values()]
        .filter((r) => r.L.usd + r.S.usd > 0)
        .sort((a, b) => b.L.usd + b.S.usd - (a.L.usd + a.S.usd))
        .slice(0, top);
      const fmt = (s: Side): string =>
        s.n
          ? `${usd(s.usd).padStart(8)} (${s.n}) avg ${px(s.pq / s.usd)} range ${px(s.lo)}..${px(s.hi)}`
          : "-";
      const line = (r: (typeof rows)[number]): string => {
        const x = r.x,
          ch = (100 * (x.close - x.open)) / x.open,
          oi = (100 * (x.oi1 - x.oi0)) / x.oi0;
        const who =
          r.L.usd > 2 * r.S.usd
            ? "LONGS"
            : r.S.usd > 2 * r.L.usd
              ? "SHORTS"
              : "both";
        return `  ${utc(x.t)}  O ${px(x.open)} H ${px(x.high)} L ${px(x.low)} C ${px(x.close)}  price ${sp(ch)}%  OI ${sp(oi)}%  [${who}]\n      LONGS  ${fmt(r.L)}\n      SHORTS ${fmt(r.S)}`;
      };
      console.log(
        `═══ ${tf === 60 ? "1h" : "15m"} candles: the ${rows.length} with the most liquidations (biggest first) ═══`,
      );
      for (const r of rows) console.log(line(r));
      console.log(
        `\n─── the same ${tf === 60 ? "1h" : "15m"} candles in time order ───`,
      );
      for (const r of [...rows].sort((a, b) => a.x.t - b.x.t)) {
        const x = r.x;
        console.log(
          `  ${utc(x.t)}  ${r.L.usd > r.S.usd ? "LONGS " : "SHORTS"} ${usd(Math.max(r.L.usd, r.S.usd)).padStart(8)}  (other side ${usd(Math.min(r.L.usd, r.S.usd))})  L ${px(x.low)} H ${px(x.high)} C ${px(x.close)}  OI ${sp((100 * (x.oi1 - x.oi0)) / x.oi0)}%`,
        );
      }
      console.log("");
    }
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
