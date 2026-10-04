/**
 * ZONE BOUNCE ON 1h CANDLES -- ONE COIN, ONE FIXED ZONE (Johnny + friend, Oct 4 2026). Read-only: our DB
 * (minute_bars: price + OI) + Binance's order book archive. A test of the idea, constant numbers, no live change.
 *
 *   FLAT -> the price comes down INTO the zone (a 1h low <= the zone's top) = armed; "lowest" = the lowest low since
 *   LONG  when a 1h candle closes >= 1 ATR(1h, the ATR before it) above "lowest"
 *           A: no OI condition   B: OI ROSE in that candle (our rule: the turn with new positions)
 *         SL = "lowest" (the touch's wick); checked minute by minute (same minute = SL)
 *   TOP   the LONG closes when a RED 1h candle closes >= 1 ATR below the highest high since the entry AND OI FELL in it
 *         (our top rule) -> at the same close a SHORT opens: TP = the zone's top, SL = that highest high (the top's wick)
 *   then FLAT again (the SHORT's TP is at the zone -> armed at once). A close below the zone's bottom while armed =
 *   the zone broke -> disarmed until a 1h close back above the zone's top.
 * R = the move / the risk (entry -> SL); net R = R - 2 x fee / risk%.
 * Order book (bookDepth archive): the bids' share within 1% at the touch and at the LONG entry (> 50% = more buyers).
 *
 *   npx tsx src/tools/zone-trade.ts --symbol XRPUSDT --lo 1.4637 --hi 1.4859 --from 2026-09-26
 *   options: --to 2026-10-04  --tf 60  --k 1 (ATR)  --fee 0.05  --no-book
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { atrBefore, candles, type MinBar } from "../research/dc15";
import { at, book, val, type Book } from "../research/book-archive";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const ms = (s: string): number =>
  Date.parse(s.length <= 10 ? `${s}T00:00:00Z` : `${s.replace(" ", "T")}:00Z`);
const sp = (v: number, d = 2): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "n/a";
const M = 60_000,
  DAY = 86_400_000;

type Side = "LONG" | "SHORT";
interface Tr {
  side: Side;
  t: number;
  entry: number;
  sl: number;
  tp: number | null;
  exitT: number;
  exitP: number;
  why: string;
  r: number;
  net: number;
  pct: number;
  bookTouch: number;
  bookIn: number;
}

function run(
  bars: readonly MinBar[],
  tfMin: number,
  lo: number,
  hi: number,
  from: number,
  k: number,
  fee: number,
  oiEntry: boolean,
  bk: Book | null,
): Tr[] {
  const c = candles(bars, tfMin),
    atr = atrBefore(c, 14),
    out: Tr[] = [];
  const share = (t: number): number => {
    if (!bk) return NaN;
    const i = at(bk, t),
      b = val(bk, i, -1),
      a = val(bk, i, 1);
    return b + a > 0 ? (100 * b) / (b + a) : NaN;
  };
  const mIdx = (t: number): number => {
    let l = 0,
      h = bars.length;
    while (l < h) {
      const m = (l + h) >> 1;
      if (bars[m].t < t) l = m + 1;
      else h = m;
    }
    return l;
  };
  let armed = false,
    broken = false,
    lowest = Infinity,
    touchT = 0;
  let pos: {
    side: Side;
    t: number;
    entry: number;
    sl: number;
    tp: number | null;
    ext: number;
    bookTouch: number;
    bookIn: number;
  } | null = null;
  const close = (exitT: number, exitP: number, why: string): void => {
    const p = pos!,
      sg = p.side === "LONG" ? 1 : -1,
      risk = Math.abs(p.entry - p.sl),
      riskPct = (100 * risk) / p.entry;
    const r = (sg * (exitP - p.entry)) / risk;
    out.push({
      side: p.side,
      t: p.t,
      entry: p.entry,
      sl: p.sl,
      tp: p.tp,
      exitT,
      exitP,
      why,
      r,
      net: r - (2 * fee) / riskPct,
      pct: (100 * sg * (exitP - p.entry)) / p.entry,
      bookTouch: p.bookTouch,
      bookIn: p.bookIn,
    });
    pos = null;
  };
  for (let ci = 0; ci < c.length; ci++) {
    const x = c[ci],
      a = atr[ci];
    if (x.t < from || !(a > 0)) continue;
    // 1) inside the candle, minute by minute: SL / TP of an open position
    if (pos) {
      for (
        let i = mIdx(Math.max(x.t, pos.t));
        i < bars.length && bars[i].t < x.end;
        i++
      ) {
        const b = bars[i],
          p: NonNullable<typeof pos> = pos;
        if (p.side === "LONG" ? b.low <= p.sl : b.high >= p.sl) {
          close(b.t + M, p.sl, "SL");
          if (p.side === "LONG") {
            armed = false;
            broken = true;
          } // the zone broke down
          break;
        }
        if (p.side === "SHORT" && p.tp !== null && b.low <= p.tp) {
          close(b.t + M, p.tp, "TP (zone)");
          armed = true;
          lowest = b.low;
          touchT = b.t; // back at the zone: armed at once
          break;
        }
      }
    }
    // 2) at the candle's close
    if (pos && pos.side === "LONG") {
      pos.ext = Math.max(pos.ext, x.high);
      if (x.close < x.open && x.oi1 < x.oi0 && pos.ext - x.close >= k * a) {
        const top: number = pos.ext;
        close(x.end, x.close, "TOP (red, OI down, 1 ATR)");
        if (x.close > hi)
          pos = {
            side: "SHORT",
            t: x.end,
            entry: x.close,
            sl: top,
            tp: hi,
            ext: x.close,
            bookTouch: NaN,
            bookIn: NaN,
          };
      }
      continue;
    }
    if (pos) continue; // a SHORT waits for its TP / SL
    if (broken) {
      if (x.close > hi) broken = false;
      continue;
    }
    if (!armed && x.low <= hi) {
      armed = true;
      lowest = x.low;
      touchT = x.t;
    }
    if (!armed) continue;
    lowest = Math.min(lowest, x.low);
    if (x.close < lo && x.close - lowest < k * a) {
      armed = false;
      broken = true;
      continue;
    }
    if (x.close - lowest >= k * a && (!oiEntry || x.oi1 > x.oi0)) {
      pos = {
        side: "LONG",
        t: x.end,
        entry: x.close,
        sl: lowest,
        tp: null,
        ext: x.high,
        bookTouch: share(touchT),
        bookIn: share(x.end),
      };
      armed = false;
    }
  }
  if (pos) {
    const last = bars[bars.length - 1];
    close(last.t + M, last.close, "still open");
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const sym = arg("symbol", "XRPUSDT").toUpperCase(),
    lo = Number(arg("lo", "NaN")),
    hi = Number(arg("hi", "NaN"));
  const from = ms(arg("from", "2026-09-26")),
    to = argv.includes("--to") ? ms(arg("to", "")) + DAY : Date.now();
  const tf = Number(arg("tf", "60")),
    k = Number(arg("k", "1")),
    fee = Number(arg("fee", "0.05"));
  if (!(lo > 0) || !(hi > lo))
    throw new Error("use --lo <zone bottom> --hi <zone top>");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const bars: MinBar[] = (
      await db
        .collection(MINUTE_BARS)
        .find({
          symbol: sym,
          ts: { $gte: new Date(from - 3 * DAY), $lt: new Date(to) },
          high: { $ne: null },
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
    if (!bars.length) throw new Error(`no minute bars for ${sym}`);
    const missing: string[] = [];
    const bk = argv.includes("--no-book")
      ? null
      : await book(sym, from, to, missing);
    console.log(
      `${sym} · zone ${lo} – ${hi} · ${tf}m candles · ${utc(from)} -> ${utc(Math.min(to, bars[bars.length - 1].t + M))} UTC · ${k} ATR · fee ${fee}%/side`,
    );
    console.log(
      `LONG: touch the zone, then a close ${k} ATR above the lowest low (SL there) · exit at our top (red, OI down, ${k} ATR) · SHORT from that top to the zone's top (SL the top's wick)`,
    );
    console.log(
      `book = the bids' share within 1% (> 50% = more buyers below) at the touch -> at the LONG entry${missing.length ? ` · archive missing: ${missing.join(", ")}` : ""}\n`,
    );
    for (const [name, oi] of [
      ["A: LONG entry without OI", false],
      ["B: LONG entry with OI up (our rule)", true],
    ] as const) {
      const tr = run(bars, tf, lo, hi, from, k, fee, oi, bk);
      console.log(`── ${name} ──`);
      for (const t of tr)
        console.log(
          `  ${t.side.padEnd(5)} ${utc(t.t)} in ${+t.entry.toPrecision(6)} (SL ${+t.sl.toPrecision(6)}${t.tp !== null ? `, TP ${t.tp}` : ""}) -> ${utc(t.exitT)} out ${+t.exitP.toPrecision(6)} · ${t.why.padEnd(26)} · ${sp(t.pct)}% · ${sp(t.net)}R${t.side === "LONG" ? ` · book ${Number.isFinite(t.bookTouch) ? t.bookTouch.toFixed(0) : "n/a"}% -> ${Number.isFinite(t.bookIn) ? t.bookIn.toFixed(0) : "n/a"}%` : ""}`,
        );
      for (const side of ["LONG", "SHORT"] as const) {
        const l = tr.filter((t) => t.side === side && t.why !== "still open"),
          w = l.filter((t) => t.net > 0).length;
        console.log(
          `  ${side.padEnd(5)} total: ${l.length} closed · win ${l.length ? Math.round((100 * w) / l.length) : 0}% · net ${sp(l.reduce((s, t) => s + t.net, 0))}R · price ${sp(l.reduce((s, t) => s + t.pct, 0))}%`,
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
