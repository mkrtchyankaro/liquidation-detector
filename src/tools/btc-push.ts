/**
 * WHEN BTC PUSHES WITH NEW POSITIONS (price moves + BTC OI grows, over hours), WHAT DOES EACH COIN'S OI DO?
 * (Johnny, Oct 2 2026) Read-only. Binance 1h candles + 5-minute OI; liquidations from our DB when available.
 * See src/research/btc-push.ts. For every BTC move (start -> BTC's OI peak) the coins sorted from the most
 * BTC-bound (R2 of the 3 days before), with their price, x BTC, OI change, OI dip inside, and liquidations.
 * SUMMARY: of the coins that follow BTC most (upper half by R2 in each move) vs the rest: how often their OI FELL.
 *
 *   npx tsx src/tools/btc-push.ts                 (last 7 days)
 *   options: --days 7 (max 25)  --coins DOGE,AVAX
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { klines, oiAt, oiSnapshots } from "../research/binance-history";
import { episodes } from "../research/oi-pair";
import type { MvHour } from "../research/oi-moves";
import {
  coinInMove,
  priceAt,
  type CoinData,
  type CoinInMove,
} from "../research/btc-push";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DEFAULT =
  "ETH,SOL,XRP,BNB,DOGE,ADA,LINK,AVAX,SUI,HYPE,LTC,BCH,DOT,NEAR,UNI,ENA,ALGO,XTZ,WLD,STRK,HBAR,ZEC,XLM,ONDO";
const H = 3_600_000,
  D = 24 * H;
const sp = (v: number): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "   n/a";
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const usd = (v: number | null): string =>
  v === null
    ? "     -"
    : v >= 1e6
      ? `$${(v / 1e6).toFixed(1)}M`
      : v >= 1e3
        ? `$${(v / 1e3).toFixed(0)}K`
        : `$${v.toFixed(0)}`;
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);

async function coinData(
  symbol: string,
  from: number,
  to: number,
  db: import("mongodb").Db | null,
): Promise<CoinData & { mv: MvHour[] }> {
  const kl = await klines(symbol, "1h", from, to),
    snap = await oiSnapshots(symbol, from, to, "5m");
  const hours = kl.map((c) => ({ t: c.t, open: c.open, close: c.close }));
  const mv: MvHour[] = kl.map((c) => ({
    ...c,
    oi: oiAt(snap, c.t + H),
    oiOpen: oiAt(snap, c.t),
  }));
  let liq: CoinData["liq"];
  if (db) {
    const rows = await db
      .collection(MINUTE_BARS)
      .find({
        symbol,
        ts: { $gte: new Date(from), $lt: new Date(to) },
        $or: [{ longLiqUsd: { $gt: 0 } }, { shortLiqUsd: { $gt: 0 } }],
      })
      .project({ ts: 1, longLiqUsd: 1, shortLiqUsd: 1 })
      .toArray();
    const first = await db
      .collection(MINUTE_BARS)
      .find({ symbol })
      .sort({ ts: 1 })
      .limit(1)
      .project({ ts: 1 })
      .next();
    const since = first ? num(first.ts) : Infinity;
    const r = rows.map((x) => ({
      t: num(x.ts),
      l: Number(x.longLiqUsd ?? 0),
      s: Number(x.shortLiqUsd ?? 0),
    }));
    liq = (a, b) =>
      a < since
        ? null
        : r
            .filter((x) => x.t >= a && x.t < b)
            .reduce(
              (acc, x) => ({ long: acc.long + x.l, short: acc.short + x.s }),
              { long: 0, short: 0 },
            );
  }
  return {
    hours,
    mv,
    oi: (ts) => oiAt(snap, ts),
    oiPoints: [...snap.entries()].sort((a, b) => a[0] - b[0]),
    liq,
  };
}

async function main(): Promise<void> {
  const days = Number(arg("days", "7"));
  if (!(days > 0 && days <= 25)) throw new Error("--days 1..25");
  const coins = arg("coins", DEFAULT)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
  const to = Math.floor(Date.now() / H) * H,
    start = to - days * D,
    from = start - 4 * D; // 3 days before for R2, +1 for the move start
  const client = process.env.MONGO_URI
    ? new MongoClient(process.env.MONGO_URI)
    : null;
  if (client) await client.connect();
  try {
    const db = client
      ? client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector")
      : null;
    const btc = await coinData("BTCUSDT", from, to, null);
    const data = new Map<string, CoinData>();
    for (const s of coins) {
      try {
        data.set(s.replace(/USDT$/, ""), await coinData(s, from, to, db));
      } catch (err) {
        console.log(
          `  ${s}: failed (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    const moves = episodes(btc.mv).filter(
      (e) => e.peak > start && e.peak > e.start,
    );
    console.log(
      `\nBTC moves with NEW POSITIONS (price one way + BTC OI growing, start -> BTC OI peak) · last ${days} days · UTC`,
    );
    console.log(
      `coins sorted by how much they follow BTC (R2, 3 days before) · x BTC = coin % / BTC % · OI dip = lowest OI inside the move · liq = our DB\n`,
    );
    const tally = { top: { n: 0, down: 0 }, rest: { n: 0, down: 0 } };
    for (const e of moves) {
      const bp = ((e.pricePeak - e.priceStart) / e.priceStart) * 100,
        bo = ((e.oiPeak - e.oiStart) / e.oiStart) * 100;
      const btcPct =
        ((priceAt(btc.hours, e.peak) - priceAt(btc.hours, e.start)) /
          priceAt(btc.hours, e.start)) *
        100;
      console.log(
        `BTC ${e.dir === "UP" ? "▲" : "▼"} ${utc(e.start)} -> ${utc(e.peak)} (${Math.round((e.peak - e.start) / H)}h) · price ${sp(Number.isFinite(btcPct) ? btcPct : bp)} · OI ${sp(bo)}${e.ongoing ? " · still going" : ""}`,
      );
      const rows: CoinInMove[] = [...data]
        .map(([s, d]) => coinInMove(s, d, btc.hours, e.start, e.peak, btcPct))
        .filter((r) => Number.isFinite(r.pricePct));
      rows.sort(
        (a, z) =>
          (Number.isFinite(z.r2) ? z.r2 : -1) -
          (Number.isFinite(a.r2) ? a.r2 : -1),
      );
      const half = Math.ceil(rows.length / 2);
      console.log(
        `   coin   follows   price    x BTC    OI       OI dip   long liq  short liq`,
      );
      rows.forEach((r, i) => {
        const g = i < half ? tally.top : tally.rest;
        if (Number.isFinite(r.oiPct)) {
          g.n++;
          if (r.oiPct < 0) g.down++;
        }
        if (i === half) console.log(`   ${"-".repeat(70)}`);
        console.log(
          `   ${r.symbol.padEnd(6)} ${Number.isFinite(r.r2) ? r.r2.toFixed(2) : "  - "}  ${sp(r.pricePct).padStart(7)}  ${Number.isFinite(r.xBtc) ? r.xBtc.toFixed(2).padStart(5) : "   - "}  ${sp(r.oiPct).padStart(7)}  ${sp(r.oiDipPct).padStart(7)}  ${usd(r.longLiq).padStart(7)}  ${usd(r.shortLiq).padStart(7)}${r.oiPct < 0 ? "  <- OI DOWN" : ""}`,
        );
      });
      console.log("");
    }
    const pc = (g: { n: number; down: number }): string =>
      `${g.down} of ${g.n} (${g.n ? Math.round((100 * g.down) / g.n) : 0}%)`;
    console.log(`SUMMARY · ${moves.length} BTC moves with new positions`);
    console.log(
      `   coins that follow BTC most (upper half by R2): OI FELL in ${pc(tally.top)}`,
    );
    console.log(
      `   the rest                                    : OI FELL in ${pc(tally.rest)}`,
    );
  } finally {
    if (client) await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
