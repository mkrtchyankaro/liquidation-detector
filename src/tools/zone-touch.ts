/**
 * WHAT HAPPENED WHEN THE PRICE TOUCHED THE ZONE (Johnny, Oct 7 2026). Read-only.
 * For one coin and a time window (UTC), candle by candle (--tf minutes), with --pad candles before and after:
 *   price    open / high / low / close, % change
 *   OI       Binance 5-minute OI (data.binance.vision / openInterestHist): % change in the candle
 *   volume   the candle's volume and the TAKER BUY share (> 50% = market buyers pushed, < 50% = market sellers)
 *   liq      OUR liquidations (liq_raw_events; ALGO / ENA etc. only from Oct 1; max 1/s per coin -> lower than real):
 *            longs liquidated $ / shorts liquidated $
 * The lowest low of the window is marked ◀ LOW. Then the window's totals.
 *
 *   npx tsx src/tools/zone-touch.ts --symbol ENAUSDT --from "2026-10-02 20:00" --to "2026-10-03 12:00"
 *   options: --tf 15  --pad 4
 */
import "dotenv/config";
import axios from "axios";
import { MongoClient } from "mongodb";
import { oiSnapshots, oiAt } from "../research/binance-history";

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
      ? `$${(v / 1e3).toFixed(1)}k`
      : v > 0
        ? `$${v.toFixed(0)}`
        : "-";
const M = 60_000,
  D = 86_400_000;
const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const ms = (s: string): number => Date.parse(`${s.replace(" ", "T")}:00Z`);

async function main(): Promise<void> {
  const sym = arg("symbol", "ENAUSDT").toUpperCase(),
    tf = Number(arg("tf", "15")),
    pad = Number(arg("pad", "4")),
    W = tf * M;
  const a = ms(arg("from", "")),
    b = ms(arg("to", ""));
  if (!(a > 0) || !(b > a))
    throw new Error(
      'use --from "YYYY-MM-DD HH:MM" --to "YYYY-MM-DD HH:MM" (UTC)',
    );
  const from = a - pad * W,
    to = b + (pad + 1) * W;
  const interval =
    { 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h" }[tf] ?? "15m";
  const rows: unknown[][] = (
    await fapi.get("/fapi/v1/klines", {
      params: {
        symbol: sym,
        interval,
        startTime: from,
        endTime: to - 1,
        limit: 1500,
      },
    })
  ).data;
  const k = rows.map((r) => ({
    t: Number(r[0]),
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
    v: Number(r[5]),
    tb: Number(r[9]),
  }));
  const snap = await oiSnapshots(sym, Math.floor(from / D) * D, to, "5m");
  let liqs: Array<{ t: number; usd: number; long: boolean }> = [];
  if (process.env.MONGO_URI) {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    try {
      const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
      liqs = (
        await db
          .collection("liq_raw_events")
          .find({
            symbol: sym,
            victim: { $in: ["LONG", "SHORT"] },
            timestamp: { $gte: from, $lt: to },
          })
          .project({ timestamp: 1, victim: 1, quoteQty: 1 })
          .toArray()
      ).map((r) => ({
        t: Number(r.timestamp),
        usd: Number(r.quoteQty),
        long: r.victim === "LONG",
      }));
      const first = await db
        .collection("liq_raw_events")
        .find({ symbol: sym })
        .project({ timestamp: 1 })
        .sort({ timestamp: 1 })
        .limit(1)
        .toArray();
      if (!first.length || Number(first[0].timestamp) > from)
        console.log(
          `⚠️ our liquidations for ${sym} start ${first.length ? utc(Number(first[0].timestamp)) : "never"} UTC -- before that the liq columns are empty, not zero`,
        );
    } finally {
      await client.close();
    }
  }
  const inWin = k.filter((x) => x.t >= a && x.t < b);
  const low = inWin.reduce((m, x) => (x.l < m.l ? x : m), inWin[0]);
  console.log(
    `${sym} · ${tf}m · window ${utc(a)} -> ${utc(b)} UTC (+${pad} candles each side) · OI = Binance 5m · liq = our DB\n`,
  );
  console.log(
    `  time         open      high      low       close     price    OI      volume  buy%   longs liq  shorts liq`,
  );
  let oiA = NaN,
    oiB = NaN,
    vol = 0,
    tb = 0,
    lL = 0,
    lS = 0;
  for (const x of k) {
    const o0 = oiAt(snap, x.t, 30 * M),
      o1 = oiAt(snap, x.t + W, 30 * M),
      oi = (100 * (o1 - o0)) / o0;
    const L = liqs
      .filter((q) => q.long && q.t >= x.t && q.t < x.t + W)
      .reduce((s, q) => s + q.usd, 0);
    const S = liqs
      .filter((q) => !q.long && q.t >= x.t && q.t < x.t + W)
      .reduce((s, q) => s + q.usd, 0);
    const win = x.t >= a && x.t < b;
    if (win) {
      if (!Number.isFinite(oiA)) oiA = o0;
      oiB = o1;
      vol += x.v;
      tb += x.tb;
      lL += L;
      lS += S;
    }
    const mark = x === low ? " ◀ LOW" : "";
    console.log(
      `${win ? "▌" : " "} ${utc(x.t)}  ${px(x.o).padEnd(9)} ${px(x.h).padEnd(9)} ${px(x.l).padEnd(9)} ${px(x.c).padEnd(9)} ${sp((100 * (x.c - x.o)) / x.o).padStart(6)}%  ${sp(oi).padStart(6)}%  ${String(Math.round(x.v)).padStart(9)}  ${x.v > 0 ? Math.round((100 * x.tb) / x.v) : 0}%   ${usd(L).padStart(8)}   ${usd(S).padStart(8)}${mark}`,
    );
  }
  console.log(
    `\nwindow (▌): price ${px(inWin[0].o)} -> ${px(inWin[inWin.length - 1].c)} (${sp((100 * (inWin[inWin.length - 1].c - inWin[0].o)) / inWin[0].o)}%) · lowest ${px(low.l)} at ${utc(low.t)} · OI ${sp((100 * (oiB - oiA)) / oiA)}% · taker buy ${vol > 0 ? Math.round((100 * tb) / vol) : 0}% of the volume · longs liquidated ${usd(lL)} · shorts liquidated ${usd(lS)}`,
  );
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
