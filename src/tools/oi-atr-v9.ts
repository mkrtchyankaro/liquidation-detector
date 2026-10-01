/**
 * V9 WITH OI ATR -- research only, read-only (Johnny, Oct 2 2026). See src/research/oi-atr-v9.ts.
 * Finds every CLEANING (OI falls) -> ACCUMULATION (OI rises) -> TURN (OI falls, other side liquidated) on
 * minute_bars, measures each leg in OI ATRs, trades it like live V9 (SL at the turn's extreme, TP 1.5R, time stop
 * 24h, fees, one trade per coin at a time) and shows the results split by leg size -- no thresholds picked.
 * At the end: the REAL V9 signals (user main) over the same days, same TP / time stop / min SL, to compare.
 *
 *   npx tsx src/tools/oi-atr-v9.ts --days 30
 *   options: --tf 5 (candle minutes)  --n 14 (ATR length)  --rev 1 (a leg ends when OI turns back by this many ATRs)
 *            --tp 1.5  --minsl 0.7 (skip SL <= this %, like live)  --timestop 24  --coins BTC,DOGE (default: .env SYMBOLS)
 *            --list (every trade)
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import {
  ATR_BUCKETS,
  REGROW_BUCKETS,
  atrBucket,
  atrSignals,
  buildCandles,
  regrowBucket,
  type AtrSignal,
  type MinBar,
} from "../research/oi-atr-v9";
import {
  simTrade,
  type TpBar,
  type TpOpts,
  type TpResult,
  type TpTrade,
} from "../research/v9-tp-sim";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const nn = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sR = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
const sym = (s: string): string =>
  s.toUpperCase().endsWith("USDT") ? s.toUpperCase() : `${s.toUpperCase()}USDT`;
const D = 86_400_000;

interface Row {
  s: AtrSignal;
  r: TpResult;
}

function stats(rows: readonly { r: TpResult }[], nDays: number): string {
  const c = (st: string): number =>
    rows.filter((x) => x.r.status === st).length;
  const done = rows.filter((x) => x.r.status !== "OPEN"),
    R = done.reduce((a, x) => a + x.r.r, 0);
  const win = done.length ? Math.round((100 * c("TP")) / done.length) : 0;
  return `${String(rows.length).padStart(4)} trades · TP ${String(c("TP")).padStart(3)} · SL ${String(c("SL")).padStart(3)} · time ${String(c("TIME")).padStart(2)} · open ${c("OPEN")} · win ${String(win).padStart(3)}% · total ${sR(R).padStart(8)} · avg ${sR(done.length ? R / done.length : 0).padStart(7)} · per day ${sR(R / nDays)}`;
}
function table(
  title: string,
  rows: Row[],
  keyOf: (s: AtrSignal) => string,
  keys: string[],
  nDays: number,
): void {
  console.log(title);
  for (const k of keys) {
    const g = rows.filter((x) => keyOf(x.s) === k);
    if (g.length) console.log(`   ${k.padEnd(18)} ${stats(g, nDays)}`);
  }
  console.log("");
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const days = Number(arg("days", "30")),
    tf = Number(arg("tf", "5")),
    n = Number(arg("n", "14")),
    rev = Number(arg("rev", "1"));
  const tpR = Number(arg("tp", "1.5")),
    minSl = Number(arg("minsl", "0.7")),
    ts = Number(arg("timestop", "24"));
  if (![days, tf, n, rev, tpR].every((x) => x > 0) || !(minSl >= 0))
    throw new Error("bad numbers");
  const coins = arg("coins", process.env.SYMBOLS ?? "BTCUSDT")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(sym);
  const o: TpOpts = {
    tpR,
    minSlPct: minSl,
    maxOpen: null,
    timeStopH: ts > 0 ? ts : null,
    riskUsd: 10,
  };
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const now = Date.now(),
      since = now - days * D,
      warm = since - 2 * D;
    const rows: Row[] = [];
    let skippedSl = 0,
      skippedBusy = 0,
      firstData = Infinity;
    const barsBySym = new Map<string, TpBar[]>();
    for (const s of coins) {
      const docs = await db
        .collection(MINUTE_BARS)
        .find({ symbol: s, ts: { $gte: new Date(warm) } })
        .project({
          ts: 1,
          high: 1,
          low: 1,
          close: 1,
          oiFirst: 1,
          oiLast: 1,
          oiMin: 1,
          oiMax: 1,
          longLiqUsd: 1,
          shortLiqUsd: 1,
        })
        .sort({ ts: 1 })
        .toArray();
      const mb: MinBar[] = docs.map((d) => ({
        t: num(d.ts),
        high: nn(d.high),
        low: nn(d.low),
        close: nn(d.close),
        oiFirst: nn(d.oiFirst),
        oiLast: nn(d.oiLast),
        oiMin: nn(d.oiMin),
        oiMax: nn(d.oiMax),
        longLiq: Number(d.longLiqUsd ?? 0),
        shortLiq: Number(d.shortLiqUsd ?? 0),
      }));
      if (mb.length) firstData = Math.min(firstData, mb[0].t);
      const bars: TpBar[] = mb
        .filter((b) => b.high! > 0 && b.low! > 0 && b.close! > 0)
        .map((b) => ({ t: b.t, high: b.high!, low: b.low!, close: b.close! }));
      barsBySym.set(s, bars);
      const sigs = atrSignals(s, buildCandles(mb, tf), {
        tf,
        n,
        rev,
        minSlPct: 0.33,
        maxGapCandles: 3,
      }).filter((x) => x.t >= since);
      let busyUntil = -Infinity;
      for (const x of sigs) {
        if (!(x.slPct > minSl)) {
          skippedSl++;
          continue;
        }
        if (x.t < busyUntil) {
          skippedBusy++;
          continue;
        }
        const t: TpTrade = {
          id: `${s}-${x.t}`,
          symbol: s,
          side: x.side,
          createdAt: x.t - 1,
          entry: x.entry,
          sl: x.sl,
        };
        const r = simTrade(t, bars, o);
        busyUntil = r.exitTs;
        rows.push({ s: x, r });
      }
    }
    const from = Math.max(since, firstData),
      nDays = Math.max(1, (now - from) / D);
    console.log(
      `V9 with OI ATR · ${utc(from)} -> ${utc(now)} UTC (${nDays.toFixed(1)} days of data) · ${coins.length} coins`,
    );
    console.log(
      `OI candles ${tf}m · ATR ${n} · a leg ends when OI turns back ${rev} ATR · TP ${tpR}R · SL > ${minSl}% · time stop ${ts || "none"}h · one trade per coin`,
    );
    console.log(
      `skipped: SL too small ${skippedSl} · coin already in a trade ${skippedBusy}\n`,
    );
    console.log(`ALL                  ${stats(rows, nDays)}\n`);
    table(
      "1. CLEANING size (OI drop ÷ down-ATR = how many normal falling candles):",
      rows,
      (s) => atrBucket(s.cleanAtr),
      ATR_BUCKETS,
      nDays,
    );
    table(
      "2. ACCUMULATION size (OI rise ÷ up-ATR = how many normal rising candles):",
      rows,
      (s) => atrBucket(s.accAtr),
      ATR_BUCKETS,
      nDays,
    );
    table(
      "   how much of the cleaned OI came back (rise ÷ drop):",
      rows,
      (s) => regrowBucket(s.regrow),
      REGROW_BUCKETS,
      nDays,
    );
    table(
      "   cleaning x accumulation (both in ATRs):",
      rows,
      (s) => `${atrBucket(s.cleanAtr)} / ${atrBucket(s.accAtr)}`,
      ATR_BUCKETS.flatMap((a) => ATR_BUCKETS.map((b) => `${a} / ${b}`)),
      nDays,
    );
    table("   side:", rows, (s) => s.side, ["LONG", "SHORT"], nDays);
    table(
      "   coin:",
      rows,
      (s) => s.symbol.replace(/USDT$/, ""),
      [...new Set(rows.map((x) => x.s.symbol.replace(/USDT$/, "")))].sort(),
      nDays,
    );

    // the real V9 (main = every signal) over the same days, same exits
    const docs = await db
      .collection("v9_trades")
      .find({
        userId: "main",
        entryPrice: { $ne: null },
        state: { $in: ["OPEN", "CLOSED"] },
      })
      .toArray();
    const v9 = docs
      .map(
        (d) =>
          ({
            id: String(d.tradeId),
            symbol: String(d.symbol),
            side: d.side,
            createdAt: num(d.createdAt),
            entry: Number(d.entryPrice),
            sl: Number(d.slPrice),
          }) as TpTrade,
      )
      .filter(
        (t) =>
          t.createdAt >= from &&
          t.entry > 0 &&
          t.sl > 0 &&
          t.entry !== t.sl &&
          (100 * Math.abs(t.entry - t.sl)) / t.entry > minSl,
      );
    for (const s of new Set(v9.map((t) => t.symbol)))
      if (!barsBySym.has(s)) {
        const r = await db
          .collection(MINUTE_BARS)
          .find({
            symbol: s,
            ts: { $gte: new Date(from - 3_600_000) },
            high: { $ne: null },
          })
          .sort({ ts: 1 })
          .toArray();
        barsBySym.set(
          s,
          r.map((b) => ({
            t: num(b.ts),
            high: Number(b.high),
            low: Number(b.low),
            close: Number(b.close),
          })),
        );
      }
    const v9rows = v9.map((t) => ({
      r: simTrade(t, barsBySym.get(t.symbol) ?? [], o),
    }));
    console.log(`REAL V9 (main) same days, SL > ${minSl}%, same TP/time stop:`);
    console.log(`                     ${stats(v9rows, nDays)}`);
    console.log(
      "   (V9 coins are only the ones in v9.symbols; the list above is all coins in SYMBOLS -- compare per coin too)\n",
    );

    if (argv.includes("--list")) {
      for (const x of rows.sort((a, b) => a.s.t - b.s.t)) {
        const s = x.s;
        console.log(
          `${utc(s.t)} ${s.symbol.replace(/USDT$/, "").padEnd(5)} ${s.side.padEnd(5)} clean ${utc(s.cleanStart)}..${utc(s.bottom).slice(6)} ${s.cleanAtr.toFixed(1)}ATR (${s.cleanVictim} liq) · acc ..${utc(s.peak).slice(6)} ${s.accAtr.toFixed(1)}ATR · turn ${s.turnAtr.toFixed(1)}ATR (${s.turnVictim} liq) · SL ${s.slPct.toFixed(2)}% · ${x.r.status} ${sR(x.r.r)}`,
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
