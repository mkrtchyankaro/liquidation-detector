/**
 * V10 TP vs SL TRADES AND THE TAKER BUY / SELL VOLUME (Johnny, Oct 4 2026). Read-only: our DB (minute_bars) for the
 * signals + Binance's public 1m klines for the taker volume (no keys; cached per finished day in data/taker/<SYMBOL>/).
 * The LIVE rules as v10-liq-study.ts (A = BTC's oiPeak -> 3 picks, B = the alt's own atr signal, no top-candle OI rule,
 * old alts, moved on its own, move > TP, one trade per coin at a time).
 *
 * push = the aggressive side WITH the move that just ended: for a SHORT (a rise) = taker BUY $ - taker SELL $;
 *        for a LONG (a fall) = SELL - BUY. Positive = the move's side still hitting the book.
 *   rise    push over the move (start -> end of the top candle), as % of the volume then
 *   fade    the top candle's push / the biggest push of a 15m candle in the rise BEFORE the top candle
 *           (< 1 = the buyers weaker at the new high than earlier in the rise)
 *   top->in push from the top candle's end to the entry, % of that volume (< 0 = the other side hitting the book)
 *   entry   the entry candle's push, % of its volume
 *   +1h     push in the hour after the entry, % (hindsight -- to understand, not to trade)
 *
 *   npx tsx src/tools/v10-taker-study.ts --pct 1 --tp 2
 *   options: --side SHORT|LONG  --window 12  --picks 3  --own 1|15  --fee 0.05
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type Candle, type MinBar } from "../research/dc15";
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
const pc = (v: number): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : "n/a";
const DAY = 86_400_000,
  H = 3_600_000,
  W = V10_TF_MIN * 60_000;

interface Coin {
  bars: MinBar[];
  map: Map<number, number>;
  old: boolean;
  c: Candle[];
}
/** taker volume of one symbol: minute open times, prefix sums of the quote volume and of the taker BUY quote volume */
interface Taker {
  ts: number[];
  q: number[];
  b: number[];
}
interface Tk {
  rise: number;
  fade: number;
  top: number;
  entry: number;
  after: number;
}
interface Row {
  t: number;
  sym: string;
  src: "A" | "B";
  side: "SHORT" | "LONG";
  entry: number;
  tr: Trade;
  net: number;
  sig: Tk;
  coin: Tk;
}

const prep = (bars: MinBar[], old: boolean): Coin => ({
  bars,
  map: new Map(bars.map((b) => [b.t, b.close])),
  old,
  c: candles(bars, V10_TF_MIN),
});

const fapi = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
/** 1m klines of one UTC day: [openTime, quoteVolume, takerBuyQuoteVolume]; finished days cached on disk */
async function takerDay(
  symbol: string,
  day: number,
): Promise<Array<[number, number, number]>> {
  const dir = path.join("data", "taker", symbol),
    f = path.join(dir, `${new Date(day).toISOString().slice(0, 10)}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  let rows: unknown[][] = [];
  for (let i = 0; ; i++) {
    try {
      rows = (
        await fapi.get("/fapi/v1/klines", {
          params: {
            symbol,
            interval: "1m",
            startTime: day,
            endTime: day + DAY - 1,
            limit: 1500,
          },
        })
      ).data;
      break;
    } catch (err) {
      if (i >= 5) throw err;
      process.stderr.write(
        `${symbol} ${err instanceof Error ? err.message : err} -- retry\n`,
      );
      await sleep(2000 * 2 ** i);
    }
  }
  await sleep(400); // stay far below Binance's weight limit (the bot shares this IP)
  const out = rows.map((r): [number, number, number] => [
    Number(r[0]),
    Number(r[7]),
    Number(r[10]),
  ]);
  if (day + DAY < Date.now() - 5 * 60_000) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(out));
  }
  return out;
}
async function taker(symbol: string, from: number, to: number): Promise<Taker> {
  const ts: number[] = [],
    q: number[] = [0],
    b: number[] = [0];
  for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY)
    for (const [t, qv, bv] of await takerDay(symbol, d)) {
      ts.push(t);
      q.push(q[q.length - 1] + qv);
      b.push(b[b.length - 1] + bv);
    }
  return { ts, q, b };
}
const idx = (ts: readonly number[], t: number): number => {
  let lo = 0,
    hi = ts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ts[m] < t) lo = m + 1;
    else hi = m;
  }
  return lo;
};
/** volume and push (buy - sell, signed for the side) in [a, b) */
function vol(
  k: Taker,
  side: "SHORT" | "LONG",
  a: number,
  z: number,
): { v: number; push: number } {
  const i = idx(k.ts, a),
    j = idx(k.ts, z),
    v = k.q[j] - k.q[i],
    buy = k.b[j] - k.b[i],
    d = buy - (v - buy);
  return { v, push: side === "SHORT" ? d : -d };
}
const pctOf = (x: { v: number; push: number }): number =>
  x.v > 0 ? (100 * x.push) / x.v : NaN;

function tkOf(
  k: Taker,
  side: "SHORT" | "LONG",
  startT: number,
  topT: number,
  entryT: number,
): Tk {
  const topEnd = topT + W;
  let best = -Infinity;
  for (let t = Math.floor(startT / W) * W; t < topT; t += W)
    best = Math.max(best, vol(k, side, t, t + W).push);
  const topPush = vol(k, side, topT, topEnd).push;
  return {
    rise: pctOf(vol(k, side, startT, topEnd)),
    fade: best > 0 ? topPush / best : NaN,
    top: pctOf(vol(k, side, topEnd, entryT)),
    entry: pctOf(vol(k, side, entryT - W, entryT)),
    after: pctOf(vol(k, side, entryT, entryT + H)),
  };
}

async function main(): Promise<void> {
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
    // the taker volume, downloaded once per symbol that has a trade (Binance public klines, cached per finished day)
    const from = btc.bars[0].t,
      to = btc.bars[btc.bars.length - 1].t + 60_000,
      tks = new Map<string, Taker>();
    const tk = async (symbol: string): Promise<Taker> => {
      if (!tks.has(symbol)) {
        process.stderr.write(`taker volume ${symbol}...\n`);
        tks.set(symbol, await taker(symbol, from, to));
      }
      return tks.get(symbol)!;
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
      const coinTk = tkOf(await tk(c.sym), c.side, c.startT, c.topT, c.t);
      rows.push({
        t: c.t,
        sym: short(c.sym),
        src: c.src,
        side: c.side,
        entry: c.entry,
        tr,
        net: tr.r - (2 * fee) / pct,
        sig:
          c.src === "A"
            ? tkOf(await tk("BTCUSDT"), c.side, c.startT, c.topT, c.t)
            : coinTk,
        coin: coinTk,
      });
    }

    const who = side === "SHORT" ? "buyers" : "sellers";
    console.log(
      `V10 LIVE RULES · ${side} · SL ${pct}% · TP ${tpPct}% · ${utc(btc.bars[0].t)} -> ${utc(btc.bars[btc.bars.length - 1].t)} UTC · taker volume: Binance 1m klines`,
    );
    console.log(
      `push = the ${who} (taker, aggressive) minus the other side, % of the volume · rise = in the move · fade = top candle's push / the rise's biggest candle push (< 1 = weaker at the top)`,
    );
    console.log(
      `top->in = push from the top candle's end to the entry · entry = the entry candle's push · +1h = the hour after the entry (hindsight)\n`,
    );
    const fmt = (l: Tk): string =>
      `rise ${pc(l.rise).padStart(7)} · fade ${(Number.isFinite(l.fade) ? l.fade.toFixed(2) : "n/a").padStart(5)} · top->in ${pc(l.top).padStart(7)} · entry ${pc(l.entry).padStart(7)} · +1h ${pc(l.after).padStart(7)}`;
    for (const res of ["TP", "SL", "OPEN"] as const) {
      const l = rows.filter((r) => r.tr.exit === res);
      if (!l.length) continue;
      console.log(`── ${res} (${l.length}) ──`);
      for (const r of l) {
        console.log(
          `  ${utc(r.t)} ${r.src} ${r.sym.padEnd(6)} ${sp(r.net).padStart(6)}R  ${r.src === "A" ? "BTC " : "own "} ${fmt(r.sig)}`,
        );
        if (r.src === "A")
          console.log(
            `  ${" ".repeat(11)}   ${" ".repeat(6)} ${" ".repeat(7)}  coin ${fmt(r.coin)}`,
          );
      }
      console.log("");
    }
    const closed = rows.filter((r) => r.tr.exit !== "OPEN");
    const stat = (name: string, keep: (r: Row) => boolean): void => {
      for (const src of ["A", "B", "ALL"] as const) {
        const l = closed.filter(
          (r) => (src === "ALL" || r.src === src) && keep(r),
        );
        const tp = l.filter((r) => r.tr.exit === "TP").length,
          n = l.reduce((a, r) => a + r.net, 0);
        console.log(
          `  ${name.padEnd(44)} ${src.padEnd(3)} ${String(l.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(l.length - tp).padStart(3)} · win ${l.length ? Math.round((100 * tp) / l.length) : 0}% · net R ${sp(n).padStart(7)}`,
        );
      }
    };
    const both = (name: string, f: (x: Tk) => boolean): void => {
      stat(`sig ${name}`, (r) => f(r.sig));
      stat(`sig NOT ${name}`, (r) => !f(r.sig));
    };
    console.log(
      `FILTERS (known at the entry; "sig" = the signal's chart: BTC for A, the alt for B · "coin" = the traded coin)`,
    );
    stat("all", () => true);
    both("fade < 1 (weaker at the top)", (x) => x.fade < 1);
    both("top->in < 0 (the other side hits after the top)", (x) => x.top < 0);
    both("entry < 0 (the entry candle: the other side)", (x) => x.entry < 0);
    stat(
      "sig fade < 1 AND top->in < 0",
      (r) => r.sig.fade < 1 && r.sig.top < 0,
    );
    stat("coin top->in < 0", (r) => r.coin.top < 0);
    stat("coin entry < 0", (r) => r.coin.entry < 0);
    console.log(
      `\nHINDSIGHT (not tradable, to understand): the hour after the entry`,
    );
    both("+1h < 0", (x) => x.after < 0);
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
