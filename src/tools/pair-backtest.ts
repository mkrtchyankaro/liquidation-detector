/**
 * THE NEW STRATEGY ON BINANCE'S OWN HISTORY + "ONE LONG AND ONE SHORT" (Johnny, Oct 6 2026). Read-only, no keys.
 *   data   price: Binance 1m klines (REST, cached per day in data/klines1m/<SYMBOL>/); OI: Binance 5-minute snapshots
 *          (data.binance.vision "metrics", cached in data/metrics/<SYMBOL>/; the last days from openInterestHist 5m).
 *          Each minute's OI is interpolated between the 5-minute snapshots, so every 15m candle's OI start / end is a
 *          real snapshot (our own DB has second OI -- inside a candle this is coarser, the candles themselves are not).
 *   rules  exactly the live NEW strategy (from Oct 5 16:51 UTC, karo's config): SHORT = the ALT rule (rise > TP %, OI up
 *          RANK 1 12h, the close 1 ATR off the top, OI below its peak), LONG = flush (fall > TP % with OI down RANK 1,
 *          then a candle with OI up 1 ATR off the low); both moved on their own (R2 with BTC on 1m returns < 0.5 or BTC
 *          the other way); given back < --gb % of the move; no candle against the turn between the top (bottom) and the
 *          entry (SHORT: green + OI down; LONG: red + OI up). Every alt of SYMBOLS but BTC / ETH, old and new alike.
 *   trades SL --pct / TP --tp from the entry, minute by minute (same minute = SL), one trade at a time per coin and side.
 *   books  ALL      every trade
 *          PAIR     at most ONE LONG and ONE SHORT open at a time, on different coins (a LONG open -> only a SHORT may
 *                   come, and the other way; both free -> the first of each side) -- Johnny's rule
 *          MAX 4    at most 4 open (karo's maxOpen), any side
 *   pairs  in PAIR, every time a LONG and a SHORT were open together: which coins, how each ended
 *
 *   npx tsx src/tools/pair-backtest.ts
 *   options: --days 60  --pct 1  --tp 2  --window 12  --gb 50  --fee 0.05  --list
 *            --wick    (Johnny, Oct 6) the SL on the WICK -- the top's high (SHORT) / the bottom's low (LONG) -- and the TP
 *                      at --rr R (default 2) from the entry; the min move is then that TP in %: the move to the extreme
 *                      must be bigger than the TP distance (not a fixed --tp %). Fees count in each trade's own R.
 *            --rr 2    the TP in R for --wick
 *            --liq     (Johnny, Oct 6) only the trades inside the period OUR DB has liquidations for that coin (each coin
 *                      its own start: from its first liq_raw_events row; the move must start after it), and for each
 *                      trade the liquidations ($, our forceOrder stream: at most 1 per second per coin -> lower than real)
 *                      in 4 phases -- the move (start -> the extreme candle), the extreme candle, the extreme -> the entry,
 *                      the first 2h after the entry (hindsight) -- each side, also as a multiple of the coin's average
 *                      hourly liquidations; TP vs SL split at the median of each (no number made up) + every trade listed
 *            --tf 60   the candle in minutes (Oct 6: the same strategy on 1h candles; default 15 = live). The RANK window
 *                      stays --window hours, the ATR 14 candles of that size; the SL / TP stay --pct / --tp
 *            --from 2026-09-22 --to 2026-10-05   only the trades entered in [from, to) are counted (the data still starts
 *            --days before, for the 12h RANK and the ATR) -- to compare with our own DB's tests on the same days
 *            --trades   every trade of the ALL book (to compare signal by signal with src/tools/oi-split-test.ts --list)
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { candles, type MinBar } from "../research/dc15";
import { atrSignals, flushSignals } from "../research/atr-turn";
import { simTrade } from "../research/sltp";
import { klines, oiSnapshots, type Kline } from "../research/binance-history";
import { MongoClient } from "mongodb";
import {
  againstCandles,
  givebackPct,
  ownMove,
  V10_ATR_N,
  V10_K,
  type V10Turn,
} from "../strategy/v10/v10-engine";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number, d = 2): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "n/a";
const M = 60_000,
  D = 86_400_000,
  F5 = 5 * M,
  SKIP = ["BTCUSDT", "ETHUSDT"];
const dayStr = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** 1m klines, whole past days cached on disk, today fetched fresh */
async function minutes(
  symbol: string,
  from: number,
  to: number,
): Promise<Kline[]> {
  const dir = path.join("data", "klines1m", symbol),
    out: Kline[] = [];
  fs.mkdirSync(dir, { recursive: true });
  const today = Math.floor(Date.now() / D) * D;
  for (let d = from; d < to; d += D) {
    const f = path.join(dir, `${dayStr(d)}.json`),
      end = Math.min(d + D, to);
    if (d + D <= today && fs.existsSync(f)) {
      out.push(...(JSON.parse(fs.readFileSync(f, "utf8")) as Kline[]));
      continue;
    }
    const k = await klines(symbol, "1m", d, end);
    if (d + D <= today && end === d + D) fs.writeFileSync(f, JSON.stringify(k));
    out.push(...k);
    process.stderr.write(`\r${symbol} 1m ${dayStr(d)}   `);
  }
  process.stderr.write("\n");
  return out;
}

/** minute bars with OI interpolated between the 5-minute snapshots (oiFirst = OI at t, oiLast = OI at t + 1m) */
function minuteBars(k: Kline[], snap: Map<number, number>): MinBar[] {
  const oi = (x: number): number => {
    const a = Math.floor(x / F5) * F5,
      va = snap.get(a),
      vb = snap.get(a + F5);
    if (x === a) return va ?? NaN;
    return va !== undefined && vb !== undefined
      ? va + ((vb - va) * (x - a)) / F5
      : NaN;
  };
  return k.map((x) => ({
    t: x.t,
    high: x.high,
    low: x.low,
    close: x.close,
    oiFirst: oi(x.t),
    oiLast: oi(x.t + M),
  }));
}

interface Liq {
  t: number;
  usd: number;
  long: boolean;
}
/** liquidations of one phase: $ of the longs / shorts liquidated, and both as a multiple of the coin's average hour */
interface LiqPhase {
  longs: number;
  shorts: number;
  xL: number;
  xS: number;
}
interface Tr {
  sym: string;
  side: "LONG" | "SHORT";
  t: number;
  exitT: number;
  exit: string;
  net: number;
  slPct?: number;
  liq?: { move: LiqPhase; ext: LiqPhase; back: LiqPhase; after: LiqPhase };
}

async function main(): Promise<void> {
  const days = Number(arg("days", "60")),
    pct = Number(arg("pct", "1")),
    tpPct = Number(arg("tp", "2")),
    win = Number(arg("window", "12")),
    tf = Number(arg("tf", "15"));
  const wick = argv.includes("--wick"),
    rr = Number(arg("rr", "2"));
  const slPcts: number[] = [];
  const gbMax = Number(arg("gb", "50")),
    fee = Number(arg("fee", "0.05"));
  const to = Math.floor(Date.now() / (15 * M)) * 15 * M,
    from = Math.floor(to / D) * D - days * D;
  const syms = (process.env.SYMBOLS ?? "")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter((x) => x && !SKIP.includes(x));
  if (!syms.length) throw new Error("SYMBOLS not set");
  const btc = await minutes("BTCUSDT", from, to),
    btcMap = new Map(btc.map((b) => [b.t, b.close]));
  const trades: Tr[] = [],
    counts: string[] = [];
  // --liq: our own liquidation stream from the DB
  const liqMode = argv.includes("--liq");
  const mongo = liqMode ? new MongoClient(process.env.MONGO_URI ?? "") : null;
  if (mongo) await mongo.connect();
  const liqCol = mongo
    ?.db(process.env.MONGO_OWN_DB ?? "liquidation_detector")
    .collection("liq_raw_events");
  for (const sym of syms) {
    let bars: MinBar[];
    try {
      const k = await minutes(sym, from, to),
        snap = await oiSnapshots(sym, from, to, "5m");
      bars = minuteBars(k, snap).filter((b) => b.oiFirst > 0 && b.oiLast > 0);
    } catch (err) {
      counts.push(
        `${sym}: data failed (${err instanceof Error ? err.message : err})`,
      );
      continue;
    }
    if (bars.length < 3 * 24 * 60) {
      counts.push(`${sym}: too little data (${bars.length} minutes)`);
      continue;
    }
    // --liq: the coin's liquidations (sorted), its first one, its average hourly $ over the period it has
    let liqs: Liq[] = [],
      liqFrom = -Infinity,
      perHour = NaN;
    if (liqCol) {
      liqs = (
        await liqCol
          .find({
            symbol: sym,
            victim: { $in: ["LONG", "SHORT"] },
            timestamp: { $gte: from, $lt: to },
          })
          .project({ timestamp: 1, victim: 1, quoteQty: 1 })
          .sort({ timestamp: 1 })
          .toArray()
      )
        .map((r) => ({
          t: Number(r.timestamp),
          usd: Number(r.quoteQty),
          long: r.victim === "LONG",
        }))
        .filter((x) => x.usd > 0);
      if (!liqs.length) {
        counts.push(`${sym.replace(/USDT$/, "")}: no liquidations in our DB`);
        continue;
      }
      liqFrom = liqs[0].t;
      perHour =
        liqs.reduce((a, x) => a + x.usd, 0) /
        Math.max(1, (to - liqFrom) / 3_600_000);
    }
    const phase = (a: number, b: number): LiqPhase => {
      let lo = 0,
        hi = liqs.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (liqs[m].t < a) lo = m + 1;
        else hi = m;
      }
      let longs = 0,
        shorts = 0;
      for (let k = lo; k < liqs.length && liqs[k].t < b; k++) {
        if (liqs[k].long) longs += liqs[k].usd;
        else shorts += liqs[k].usd;
      }
      const hrs = Math.max(1 / 60, (b - a) / 3_600_000);
      return {
        longs,
        shorts,
        xL: longs / (perHour * hrs),
        xS: shorts / (perHour * hrs),
      };
    };
    const map = new Map(bars.map((b) => [b.t, b.close])),
      c = candles(bars, tf);
    const sigs = [
      ...atrSignals(c, V10_K, V10_ATR_N, win, {
        atr: "live",
        topCandleOi: false,
      }).filter((g) => g.side === "SHORT" && (wick || g.movePct > tpPct)),
      ...flushSignals(c, V10_K, V10_ATR_N, win, {
        rank: true,
        side: "LONG",
      }).filter((g) => wick || -g.movePct > tpPct),
    ].sort((a, b) => a.t - b.t);
    const busy = { LONG: 0, SHORT: 0 };
    let n = 0;
    for (const g of sigs) {
      const turn = {
        side: g.side,
        candleEnd: g.t,
        extreme: g.extreme,
        extremeT: g.extremeT,
        moveStartT: g.startT,
        movePct: g.movePct,
      } as V10Turn;
      if (
        !ownMove(
          { moveStartT: g.startT, candleEnd: g.t } as V10Turn,
          map,
          btcMap,
          1,
        )
      )
        continue;
      if (
        !(givebackPct(turn, g.price) < gbMax) ||
        againstCandles(bars, turn, tf).length
      )
        continue;
      if (busy[g.side] > g.t) continue;
      if (liqMode && g.startT < liqFrom) continue; // the move must be inside the period we have liquidations for
      // --wick: SL on the extreme, TP rr x that risk; the move must be bigger than the TP distance
      const slPct = wick
        ? (100 * Math.abs(g.extreme - g.price)) / g.price
        : pct;
      if (wick && !(slPct > 0 && Math.abs(g.movePct) > rr * slPct)) continue;
      const sl =
        g.side === "SHORT"
          ? g.price * (1 + slPct / 100)
          : g.price * (1 - slPct / 100);
      const tr = simTrade(
        bars,
        g.t,
        g.price,
        sl,
        wick ? rr : tpPct / pct,
        g.side === "SHORT" ? "DOWN" : "UP",
      );
      busy[g.side] = tr.exitT;
      slPcts.push(slPct);
      trades.push({
        sym: sym.replace(/USDT$/, ""),
        side: g.side,
        t: g.t,
        exitT: tr.exitT,
        exit: tr.exit,
        net: tr.r - (2 * fee) / slPct,
        slPct,
        ...(liqMode
          ? {
              liq: {
                move: phase(g.startT, g.extremeT),
                ext: phase(g.extremeT, g.extremeT + tf * M),
                back: phase(g.extremeT + tf * M, g.t),
                after: phase(g.t, g.t + 2 * 3_600_000),
              },
            }
          : {}),
      });
      n++;
    }
    counts.push(`${sym.replace(/USDT$/, "")} ${n}`);
  }
  trades.sort((a, b) => a.t - b.t);
  // --from / --to: count only the trades entered in that window
  const wFrom = argv.includes("--from")
    ? Date.parse(`${arg("from", "")}T00:00:00Z`)
    : -Infinity;
  const wTo = argv.includes("--to")
    ? Date.parse(`${arg("to", "")}T00:00:00Z`)
    : Infinity;
  if (argv.includes("--from") || argv.includes("--to")) {
    const keep = trades.filter((t) => t.t >= wFrom && t.t < wTo);
    trades.length = 0;
    trades.push(...keep);
  }

  // the books
  const replay = (ok: (t: Tr, open: Tr[]) => boolean): Tr[] => {
    const kept: Tr[] = [];
    for (const t of trades) {
      const open = kept.filter((o) => o.exitT > t.t);
      if (ok(t, open)) kept.push(t);
    }
    return kept;
  };
  const pairBook = replay(
    (t, open) => !open.some((o) => o.side === t.side || o.sym === t.sym),
  );
  const max4 = replay(
    (t, open) => open.length < 4 && !open.some((o) => o.sym === t.sym),
  );

  console.log(
    `NEW STRATEGY ON BINANCE HISTORY · ${dayStr(from)} -> ${utc(to)} UTC (${days} days) · ${tf}m candles${Number.isFinite(wFrom) || Number.isFinite(wTo) ? ` · counted: trades entered ${Number.isFinite(wFrom) ? dayStr(wFrom) : "start"} -> ${Number.isFinite(wTo) ? dayStr(wTo) : "now"}` : ""} · ${wick ? `SL on the wick · TP ${rr}R · the move > the TP distance` : `SL ${pct}% · TP ${tpPct}%`} · given back < ${gbMax}% · fee ${fee}%/side`,
  );
  console.log(`coins (trades): ${counts.join(", ")}`);
  if (wick && slPcts.length) {
    const x = [...slPcts].sort((a, b) => a - b),
      q = (p: number): string => x[Math.floor(p * (x.length - 1))].toFixed(2);
    console.log(
      `the SL distance (wick): min ${q(0)}% · quarter ${q(0.25)}% · median ${q(0.5)}% · 3 quarters ${q(0.75)}% · max ${q(1)}%`,
    );
  }
  console.log("");
  const line = (name: string, l: Tr[]): string => {
    const d = l.filter((x) => x.exit !== "OPEN"),
      tp = d.filter((x) => x.exit === "TP").length;
    return `  ${name.padEnd(30)} ${String(d.length).padStart(4)} trades · TP ${String(tp).padStart(4)} · SL ${String(d.length - tp).padStart(4)} · win ${d.length ? Math.round((100 * tp) / d.length) : 0}% · net ${sp(d.reduce((a, x) => a + x.net, 0)).padStart(8)}R`;
  };
  for (const [name, l] of [
    ["ALL (every trade)", trades],
    ["PAIR (1 LONG + 1 SHORT)", pairBook],
    ["MAX 4 open", max4],
  ] as Array<[string, Tr[]]>) {
    console.log(line(name, l));
    console.log(
      line(
        "  SHORT",
        l.filter((x) => x.side === "SHORT"),
      ),
    );
    console.log(
      line(
        "  LONG",
        l.filter((x) => x.side === "LONG"),
      ),
    );
  }

  // --wick: by the SL's size (the data's own quartiles)
  if (wick && trades.length) {
    const x = trades.map((t) => t.slPct!).sort((a, b) => a - b),
      q1 = x[Math.floor(x.length / 4)],
      q2 = x[Math.floor(x.length / 2)],
      q3 = x[Math.floor((3 * x.length) / 4)];
    console.log(`\nALL by the SL's size:`);
    console.log(
      line(
        `  SL < ${q1.toFixed(2)}%`,
        trades.filter((t) => t.slPct! < q1),
      ),
    );
    console.log(
      line(
        `  ${q1.toFixed(2)} .. ${q2.toFixed(2)}%`,
        trades.filter((t) => t.slPct! >= q1 && t.slPct! < q2),
      ),
    );
    console.log(
      line(
        `  ${q2.toFixed(2)} .. ${q3.toFixed(2)}%`,
        trades.filter((t) => t.slPct! >= q2 && t.slPct! < q3),
      ),
    );
    console.log(
      line(
        `  SL >= ${q3.toFixed(2)}%`,
        trades.filter((t) => t.slPct! >= q3),
      ),
    );
  }

  // the pairs in the PAIR book: a trade opened while the other side was open
  interface Pair {
    a: Tr;
    b: Tr;
  }
  const pairs: Pair[] = [];
  for (const t of pairBook) {
    const o = pairBook.find(
      (x) => x !== t && x.side !== t.side && x.t <= t.t && x.exitT > t.t,
    );
    if (o) pairs.push({ a: o, b: t });
  }
  const ended = pairs.filter((p) => p.a.exit !== "OPEN" && p.b.exit !== "OPEN");
  const both = (e: string): number =>
    ended.filter((p) => p.a.exit === e && p.b.exit === e).length;
  // --liq: what the liquidations say about TP vs SL
  if (liqMode) {
    const med = (v: number[]): number => {
      const x = v.filter(Number.isFinite).sort((a, b) => a - b);
      return x.length ? x[Math.floor(x.length / 2)] : NaN;
    };
    const usd = (v: number): string =>
      v >= 1e6
        ? `${(v / 1e6).toFixed(1)}M`
        : v >= 1e3
          ? `${(v / 1e3).toFixed(0)}k`
          : v.toFixed(0);
    for (const side of ["SHORT", "LONG"] as const) {
      const l = trades.filter(
        (t) => t.side === side && t.liq && t.exit !== "OPEN",
      );
      if (!l.length) continue;
      // "with" = the side liquidated BY the move (a SHORT's rise liquidates shorts; a LONG's fall liquidates longs)
      const w = (p: LiqPhase): number => (side === "SHORT" ? p.xS : p.xL),
        o = (p: LiqPhase): number => (side === "SHORT" ? p.xL : p.xS);
      const feats: Array<[string, (t: Tr) => number]> = [
        [
          `the move: ${side === "SHORT" ? "shorts" : "longs"} liquidated (x avg hour)`,
          (t) => w(t.liq!.move),
        ],
        [
          `the move: ${side === "SHORT" ? "longs" : "shorts"} liquidated`,
          (t) => o(t.liq!.move),
        ],
        [
          `the ${side === "SHORT" ? "top" : "bottom"} candle: ${side === "SHORT" ? "shorts" : "longs"} liquidated`,
          (t) => w(t.liq!.ext),
        ],
        [
          `the ${side === "SHORT" ? "top" : "bottom"} candle: ${side === "SHORT" ? "longs" : "shorts"} liquidated`,
          (t) => o(t.liq!.ext),
        ],
        [
          `${side === "SHORT" ? "top" : "bottom"} -> entry: ${side === "SHORT" ? "longs" : "shorts"} liquidated`,
          (t) => o(t.liq!.back),
        ],
        [
          `${side === "SHORT" ? "top" : "bottom"} -> entry: ${side === "SHORT" ? "shorts" : "longs"} liquidated`,
          (t) => w(t.liq!.back),
        ],
        [
          `AFTER the entry 2h (hindsight): ${side === "SHORT" ? "shorts" : "longs"} liquidated`,
          (t) => w(t.liq!.after),
        ],
      ];
      console.log(`\n── ${side} with our liquidations (${l.length} trades) ──`);
      console.log(line("all", l));
      for (const [name, f] of feats) {
        const m = med(l.map(f));
        console.log(
          `  ${name} -- median ${Number.isFinite(m) ? m.toFixed(2) : "n/a"}`,
        );
        console.log(
          line(
            `    >= median`,
            l.filter((t) => f(t) >= m),
          ),
        );
        console.log(
          line(
            `    <  median`,
            l.filter((t) => f(t) < m),
          ),
        );
      }
      for (const t of l) {
        const L = t.liq!,
          f = (p: LiqPhase): string => `L ${usd(p.longs)} S ${usd(p.shorts)}`;
        console.log(
          `      ${utc(t.t)} ${t.sym.padEnd(6)} ${t.exit.padEnd(4)} ${sp(t.net).padStart(6)}R · move ${f(L.move)} · ext ${f(L.ext)} · ext->entry ${f(L.back)} · after 2h ${f(L.after)}`,
        );
      }
    }
    await mongo?.close();
  }

  console.log(
    `\nPAIRS (a LONG and a SHORT open at the same time): ${pairs.length}`,
  );
  console.log(
    `  both TP ${both("TP")} · both SL ${both("SL")} · one TP one SL ${ended.length - both("TP") - both("SL")} · net ${sp(ended.reduce((a, p) => a + p.a.net + p.b.net, 0))}R`,
  );
  const alone = pairBook.filter(
    (t) => !pairs.some((p) => p.a === t || p.b === t),
  );
  console.log(line("trades never paired", alone));

  // by day (PAIR book)
  const byDay = new Map<string, Tr[]>();
  for (const t of pairBook)
    byDay.set(dayStr(t.t), [...(byDay.get(dayStr(t.t)) ?? []), t]);
  const dayNets = [...byDay.values()].map((l) =>
    l.filter((x) => x.exit !== "OPEN").reduce((a, x) => a + x.net, 0),
  );
  console.log(
    `\nPAIR book by day: ${byDay.size} days with trades · plus days ${dayNets.filter((x) => x > 0).length} · minus days ${dayNets.filter((x) => x < 0).length} · worst day ${sp(Math.min(...dayNets))}R · best day ${sp(Math.max(...dayNets))}R`,
  );

  if (argv.includes("--trades")) {
    console.log("\nevery trade (ALL book):");
    for (const t of trades)
      console.log(
        `  ${utc(t.t)} ${t.side.padEnd(5)} ${t.sym.padEnd(6)} ${t.exit.padEnd(4)} ${sp(t.net).padStart(6)}R`,
      );
  }
  if (argv.includes("--list")) {
    console.log("\nthe pairs:");
    for (const p of pairs)
      console.log(
        `  ${utc(p.a.t)} ${p.a.side.padEnd(5)} ${p.a.sym.padEnd(6)} ${p.a.exit.padEnd(4)} ${sp(p.a.net).padStart(6)}R  +  ${utc(p.b.t)} ${p.b.side.padEnd(5)} ${p.b.sym.padEnd(6)} ${p.b.exit.padEnd(4)} ${sp(p.b.net).padStart(6)}R  = ${sp(p.a.net + p.b.net).padStart(6)}R`,
      );
    console.log("\nby day (PAIR book):");
    for (const [d, l] of byDay)
      console.log(
        `  ${d}  ${l.map((t) => `${t.side[0]}:${t.sym}:${t.exit}`).join(" ")}  = ${sp(l.filter((x) => x.exit !== "OPEN").reduce((a, x) => a + x.net, 0))}R`,
      );
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
