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
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { candles, type MinBar } from "../research/dc15";
import { atrSignals, flushSignals } from "../research/atr-turn";
import { simTrade } from "../research/sltp";
import { klines, oiSnapshots, type Kline } from "../research/binance-history";
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

interface Tr {
  sym: string;
  side: "LONG" | "SHORT";
  t: number;
  exitT: number;
  exit: string;
  net: number;
}

async function main(): Promise<void> {
  const days = Number(arg("days", "60")),
    pct = Number(arg("pct", "1")),
    tpPct = Number(arg("tp", "2")),
    win = Number(arg("window", "12"));
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
    const map = new Map(bars.map((b) => [b.t, b.close])),
      c = candles(bars, 15);
    const sigs = [
      ...atrSignals(c, V10_K, V10_ATR_N, win, {
        atr: "live",
        topCandleOi: false,
      }).filter((g) => g.side === "SHORT" && g.movePct > tpPct),
      ...flushSignals(c, V10_K, V10_ATR_N, win, {
        rank: true,
        side: "LONG",
      }).filter((g) => -g.movePct > tpPct),
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
        againstCandles(bars, turn).length
      )
        continue;
      if (busy[g.side] > g.t) continue;
      const sl =
        g.side === "SHORT"
          ? g.price * (1 + pct / 100)
          : g.price * (1 - pct / 100);
      const tr = simTrade(
        bars,
        g.t,
        g.price,
        sl,
        tpPct / pct,
        g.side === "SHORT" ? "DOWN" : "UP",
      );
      busy[g.side] = tr.exitT;
      trades.push({
        sym: sym.replace(/USDT$/, ""),
        side: g.side,
        t: g.t,
        exitT: tr.exitT,
        exit: tr.exit,
        net: tr.r - (2 * fee) / pct,
      });
      n++;
    }
    counts.push(`${sym.replace(/USDT$/, "")} ${n}`);
  }
  trades.sort((a, b) => a.t - b.t);

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
    `NEW STRATEGY ON BINANCE HISTORY · ${dayStr(from)} -> ${utc(to)} UTC (${days} days) · SL ${pct}% · TP ${tpPct}% · given back < ${gbMax}% · fee ${fee}%/side`,
  );
  console.log(`coins (trades): ${counts.join(", ")}\n`);
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
