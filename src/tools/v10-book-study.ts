/**
 * V10 TP vs SL TRADES AND THE ORDER BOOK (LIMIT ORDERS) -- Binance's public archive (Johnny, Oct 4 2026). Read-only:
 * our DB (minute_bars) for the signals + data.binance.vision "bookDepth" daily files of the traded coins (no keys;
 * cached in data/bookDepth/<SYMBOL>/). The archive comes ~1 day late: research only, not usable live as is.
 * bookDepth = snapshots (every few dozen seconds) of how much is resting in the book in bands around the price:
 * percentage -1..-5 = the BIDS (buy limit orders below), +1..+5 = the ASKS (sell limit orders above); depth (coins), notional ($).
 * The LIVE rules as v10-liq-study.ts. For a SHORT: support = the BIDS (they absorb the sellers), resistance = the ASKS;
 * a LONG mirrored. All numbers from the last snapshot at or before the moment (known then).
 *   imb1 / imb2  (support - resistance) / (support + resistance) in band 1 / band 2 at the entry (> 0 = more support)
 *   wall         support band 1 at the entry / its median over the 12h before the move's start (> 1 = more than usual)
 *   top          imb1 at the end of the top candle · +30m / +1h = imb1 after the entry (hindsight)
 *
 *   npx tsx src/tools/v10-book-study.ts --check AVAXUSDT 2026-10-03   the file's first lines (are the files there? columns?)
 *   npx tsx src/tools/v10-book-study.ts --pct 1 --tp 2
 *   options: --side SHORT|LONG  --window 12  --picks 3  --own 1|15  --fee 0.05
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type Candle, type MinBar } from "../research/dc15";
import { unzipFirst } from "../research/binance-history";
import { simTrade, type Trade } from "../research/sltp";
import {
  moveOf,
  ownMove,
  pickAlts,
  signalsOf,
  V10_TF_MIN,
  type V10Turn,
} from "../strategy/v10/v10-engine";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "n/a";
const f2 = (v: number): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "  n/a";
const usd = (v: number): string =>
  !Number.isFinite(v)
    ? "n/a"
    : v >= 1e6
      ? `${(v / 1e6).toFixed(2)}M`
      : v >= 1e3
        ? `${(v / 1e3).toFixed(0)}k`
        : v.toFixed(0);
const DAY = 86_400_000,
  H = 3_600_000,
  W = V10_TF_MIN * 60_000;
const dayStr = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** a timestamp cell: "2026-10-03 00:00:08" (UTC) or epoch ms */
const tsOf = (x: string | undefined): number => {
  const v = (x ?? "").trim();
  return /^\d{12,}$/.test(v)
    ? Number(v)
    : Date.parse(`${v.replace(" ", "T")}Z`);
};

interface Coin {
  bars: MinBar[];
  map: Map<number, number>;
  old: boolean;
  c: Candle[];
}
const prep = (bars: MinBar[], old: boolean): Coin => ({
  bars,
  map: new Map(bars.map((b) => [b.t, b.close])),
  old,
  c: candles(bars, V10_TF_MIN),
});
/** one symbol's book: snapshot times and, per band (-5..5), the notional $ at each snapshot */
interface Book {
  ts: number[];
  n: Map<number, number[]>;
}
interface Bk {
  sup1: number;
  res1: number;
  imb1: number;
  imb2: number;
  wall: number;
  top: number;
  m30: number;
  h1: number;
}
interface Row {
  t: number;
  sym: string;
  src: "A" | "B";
  side: "SHORT" | "LONG";
  entry: number;
  tr: Trade;
  net: number;
  b: Bk | null;
}

const vision = axios.create({
  baseURL: "https://data.binance.vision",
  timeout: 60_000,
  responseType: "arraybuffer",
  validateStatus: (s) => s === 200 || s === 404,
});
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
/** one day's bookDepth CSV (null = not in the archive), cached on disk */
async function bookCsv(symbol: string, day: number): Promise<string | null> {
  const dir = path.join("data", "bookDepth", symbol),
    f = path.join(dir, `${dayStr(day)}.csv`);
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
  for (let i = 0; ; i++) {
    try {
      const r = await vision.get(
        `/data/futures/um/daily/bookDepth/${symbol}/${symbol}-bookDepth-${dayStr(day)}.zip`,
      );
      await sleep(300);
      if (r.status === 404) return null;
      const csv = unzipFirst(Buffer.from(r.data));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, csv);
      return csv;
    } catch (err) {
      if (i >= 4) throw err;
      process.stderr.write(
        `${symbol} ${dayStr(day)}: ${err instanceof Error ? err.message : err} -- retry\n`,
      );
      await sleep(2000 * 2 ** i);
    }
  }
}
async function book(
  symbol: string,
  from: number,
  to: number,
  missing: string[],
): Promise<Book> {
  const rows = new Map<number, Map<number, number>>();
  for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY) {
    const csv = await bookCsv(symbol, d);
    if (csv === null) {
      missing.push(`${symbol} ${dayStr(d)}`);
      continue;
    }
    for (const line of csv.split("\n")) {
      const v = line.split(",");
      const t = tsOf(v[0]),
        p = Number(v[1]),
        n = Number(v[3]);
      if (!Number.isFinite(t) || !Number.isFinite(p) || !Number.isFinite(n))
        continue; // the header
      if (!rows.has(t)) rows.set(t, new Map());
      rows.get(t)!.set(Math.round(p), n);
    }
  }
  const ts = [...rows.keys()].sort((a, b) => a - b),
    n = new Map<number, number[]>();
  for (const p of [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5])
    n.set(
      p,
      ts.map((t) => rows.get(t)!.get(p) ?? NaN),
    );
  return { ts, n };
}
/** the last snapshot at or before t (within 5 minutes), else -1 */
const at = (b: Book, t: number): number => {
  let lo = 0,
    hi = b.ts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (b.ts[m] <= t) lo = m + 1;
    else hi = m;
  }
  const i = lo - 1;
  return i >= 0 && t - b.ts[i] <= 5 * 60_000 ? i : -1;
};
const val = (b: Book, i: number, p: number): number =>
  i < 0 ? NaN : b.n.get(p)![i];
function imb(b: Book, i: number, side: "SHORT" | "LONG", band: number): number {
  const sup = val(b, i, side === "SHORT" ? -band : band),
    res = val(b, i, side === "SHORT" ? band : -band);
  return sup + res > 0 ? (sup - res) / (sup + res) : NaN;
}
function bkOf(
  b: Book,
  side: "SHORT" | "LONG",
  startT: number,
  topT: number,
  entryT: number,
  windowH: number,
): Bk | null {
  const i = at(b, entryT);
  if (i < 0) return null;
  const supBand = side === "SHORT" ? -1 : 1,
    sup1 = val(b, i, supBand),
    res1 = val(b, i, -supBand);
  const hist: number[] = [];
  for (let k = 0; k < b.ts.length; k++)
    if (b.ts[k] >= startT - windowH * H && b.ts[k] < startT) {
      const x = b.n.get(supBand)![k];
      if (Number.isFinite(x)) hist.push(x);
    }
  hist.sort((x, y) => x - y);
  const med = hist.length ? hist[Math.floor(hist.length / 2)] : NaN;
  return {
    sup1,
    res1,
    imb1: imb(b, i, side, 1),
    imb2: imb(b, i, side, 2),
    wall: med > 0 ? sup1 / med : NaN,
    top: imb(b, at(b, topT + W), side, 1),
    m30: imb(b, at(b, entryT + H / 2), side, 1),
    h1: imb(b, at(b, entryT + H), side, 1),
  };
}

async function main(): Promise<void> {
  if (argv.includes("--check")) {
    const sym = arg("check", "AVAXUSDT").toUpperCase(),
      d = Date.parse(
        `${argv[argv.indexOf("--check") + 2] ?? "2026-10-03"}T00:00:00Z`,
      );
    const csv = await bookCsv(sym, d);
    if (csv === null) {
      console.log(`${sym} ${dayStr(d)}: NOT in the archive (404)`);
      return;
    }
    const lines = csv.split("\n").filter(Boolean);
    console.log(
      `${sym} ${dayStr(d)}: ${lines.length} lines\n${lines.slice(0, 24).join("\n")}`,
    );
    const t = [...new Set(lines.slice(1).map((l) => tsOf(l.split(",")[0])))]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const gaps = t
      .slice(1)
      .map((x, k) => x - t[k])
      .sort((a, b) => a - b);
    console.log(
      `\nsnapshots: ${t.length} · median gap ${gaps.length ? gaps[Math.floor(gaps.length / 2)] / 1000 : "n/a"}s · first ${t.length ? new Date(t[0]).toISOString() : ""} · last ${t.length ? new Date(t[t.length - 1]).toISOString() : ""}`,
    );
    return;
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const pct = Number(arg("pct", "1")),
    tpPct = Number(arg("tp", "2")),
    win = Number(arg("window", "12")),
    npicks = Number(arg("picks", "3"));
  const own = Number(arg("own", "1")),
    fee = Number(arg("fee", "0.05")),
    side = arg("side", "SHORT").toUpperCase() as "SHORT" | "LONG";
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const load = async (symbol: string): Promise<MinBar[]> =>
      (
        await db
          .collection(MINUTE_BARS)
          .find({ symbol, high: { $ne: null } })
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
    const btc = prep(await load("BTCUSDT"), true);
    const coins = new Map<string, Coin>();
    for (const s of (process.env.SYMBOLS ?? "")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x && x !== "BTCUSDT")) {
      const bars = await load(s);
      if (bars.length)
        coins.set(s, prep(bars, bars[0].t <= btc.bars[0].t + DAY));
    }
    const closes = new Map([...coins].map(([s, c]) => [s, c.map]));
    const short = (s: string): string => s.replace(/USDT$/, "");

    // the live candidates
    interface Cand {
      t: number;
      sym: string;
      src: "A" | "B";
      side: "SHORT" | "LONG";
      entry: number;
      startT: number;
      topT: number;
    }
    const cands: Cand[] = [];
    for (const s of signalsOf(btc.c, win, { entry: "oiPeak" }).filter(
      (x) => x.side === side,
    ))
      for (const p of pickAlts(
        { moveStartT: s.startT, candleEnd: s.t, side: s.side } as V10Turn,
        btc.map,
        closes,
        npicks,
      ))
        if (moveOf({ kind: "BTC", side: s.side, turn: s }, p) > tpPct)
          cands.push({
            t: s.t,
            sym: p.symbol,
            src: "A",
            side: s.side,
            entry: p.price,
            startT: s.startT,
            topT: s.extremeT,
          });
    for (const [sym, c] of coins) {
      if (!c.old) continue;
      for (const s of signalsOf(c.c, win, {
        entry: "atr",
        topCandleOi: false,
      }).filter((x) => x.side === side)) {
        if (
          !ownMove(
            { moveStartT: s.startT, candleEnd: s.t } as V10Turn,
            c.map,
            btc.map,
            own,
          )
        )
          continue;
        if (
          moveOf({ kind: "OWN", side: s.side, turn: s }, { coinPct: NaN }) >
          tpPct
        )
          cands.push({
            t: s.t,
            sym,
            src: "B",
            side: s.side,
            entry: s.price,
            startT: s.startT,
            topT: s.extremeT,
          });
      }
    }
    cands.sort((a, b) => a.t - b.t || (a.src === "A" ? -1 : 1));
    const busy = new Map<string, number>(),
      rows: Row[] = [];
    const books = new Map<string, Book>(),
      missing: string[] = [];
    const from = btc.bars[0].t - DAY,
      to = btc.bars[btc.bars.length - 1].t + 60_000;
    const bk = async (symbol: string): Promise<Book> => {
      if (!books.has(symbol)) {
        process.stderr.write(`bookDepth ${symbol}...\n`);
        books.set(symbol, await book(symbol, from, to, missing));
      }
      return books.get(symbol)!;
    };
    for (const c of cands) {
      if ((busy.get(c.sym) ?? 0) > c.t) continue;
      const k = coins.get(c.sym)!,
        sl =
          c.side === "SHORT"
            ? c.entry * (1 + pct / 100)
            : c.entry * (1 - pct / 100);
      const tr = simTrade(
        k.bars,
        c.t,
        c.entry,
        sl,
        tpPct / pct,
        c.side === "SHORT" ? "DOWN" : "UP",
      );
      busy.set(c.sym, tr.exitT);
      rows.push({
        t: c.t,
        sym: short(c.sym),
        src: c.src,
        side: c.side,
        entry: c.entry,
        tr,
        net: tr.r - (2 * fee) / pct,
        b: bkOf(await bk(c.sym), c.side, c.startT, c.topT, c.t, win),
      });
    }

    const sup = side === "SHORT" ? "bids" : "asks",
      res = side === "SHORT" ? "asks" : "bids";
    console.log(
      `V10 LIVE RULES · ${side} · SL ${pct}% · TP ${tpPct}% · ${utc(btc.bars[0].t)} -> ${utc(btc.bars[btc.bars.length - 1].t)} UTC · order book: data.binance.vision bookDepth (the traded coin)`,
    );
    console.log(
      `support = ${sup} (limit orders that absorb the move we trade), resistance = ${res} · band 1 = within 1% of the price`,
    );
    console.log(
      `imb = (support - resistance) / (support + resistance), > 0 = more support · wall = support band 1 now / its median of the 12h before the move`,
    );
    console.log(
      `top = imb1 at the top candle's end · +30m / +1h = imb1 after the entry (hindsight)${missing.length ? `\nNOT in the archive: ${missing.join(", ")}` : ""}\n`,
    );
    const fmt = (b: Bk | null): string =>
      !b
        ? "no book snapshot"
        : `${sup}1 ${usd(b.sup1).padStart(6)} · ${res}1 ${usd(b.res1).padStart(6)} · imb1 ${f2(b.imb1)} · imb2 ${f2(b.imb2)} · wall ${Number.isFinite(b.wall) ? b.wall.toFixed(2) : "n/a"} · top ${f2(b.top)} · +30m ${f2(b.m30)} · +1h ${f2(b.h1)}`;
    for (const r0 of ["TP", "SL", "OPEN"] as const) {
      const l = rows.filter((r) => r.tr.exit === r0);
      if (!l.length) continue;
      console.log(`── ${r0} (${l.length}) ──`);
      for (const r of l)
        console.log(
          `  ${utc(r.t)} ${r.src} ${r.sym.padEnd(6)} ${sp(r.net).padStart(6)}R  ${fmt(r.b)}`,
        );
      console.log("");
    }
    const closed = rows.filter((r) => r.tr.exit !== "OPEN" && r.b);
    const stat = (name: string, keep: (b: Bk) => boolean): void => {
      for (const src of ["A", "B", "ALL"] as const) {
        const l = closed.filter(
          (r) => (src === "ALL" || r.src === src) && keep(r.b!),
        );
        const tp = l.filter((r) => r.tr.exit === "TP").length,
          n = l.reduce((a, r) => a + r.net, 0);
        console.log(
          `  ${name.padEnd(40)} ${src.padEnd(3)} ${String(l.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(l.length - tp).padStart(3)} · win ${l.length ? Math.round((100 * tp) / l.length) : 0}% · net R ${sp(n).padStart(7)}`,
        );
      }
    };
    const both = (name: string, f: (b: Bk) => boolean): void => {
      stat(name, f);
      stat(`NOT ${name}`, (b) => !f(b));
    };
    console.log(
      `FILTERS (known at the entry) -- trades with a book snapshot: ${closed.length} of ${rows.filter((r) => r.tr.exit !== "OPEN").length} closed`,
    );
    stat("all", () => true);
    both(`imb1 > 0 (more ${sup} within 1%)`, (b) => b.imb1 > 0);
    both(`imb2 > 0 (more ${sup} within band 2)`, (b) => b.imb2 > 0);
    both(`wall > 1 (${sup}1 above its usual)`, (b) => b.wall > 1);
    both("imb1 grew from the top to the entry", (b) => b.imb1 > b.top);
    console.log(`\nHINDSIGHT (not tradable, to understand)`);
    both("+30m imb1 > 0", (b) => b.m30 > 0);
    both("+1h imb1 > 0", (b) => b.h1 > 0);
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
