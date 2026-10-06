/**
 * ONE GOES DOWN, ONE GOES UP -- Johnny's pair (Oct 6 2026). Read-only, Binance history (the same data and cache as
 * src/tools/pair-backtest.ts: 1m klines in data/klines1m/, 5-minute OI in data/metrics/), no keys.
 *   signals  OUR live rules on --tf (default 60 = 1h) candles: SHORT = the ALT rule (a rise with OI up RANK 1, the close
 *            1 ATR off the top, OI below its peak), LONG = flush (a fall, then a candle with OI up 1 ATR off the low);
 *            the coin moved on its own (not BTC), given back < 50% of the move, no candle against the turn after the
 *            extreme (SHORT: green + OI down / LONG: red + OI up). The move must be >= N x the coin's ATR (Johnny: the
 *            size depends on the coin's ATR, not a fixed %), N = 2, 3, 4 tried.
 *   trading  one thing at a time, every leg the same $ (--leg, default $5,000 = $500 x 10):
 *     1. the first signal (either side) -> leg 1 opens at once (the signal candle's close)
 *     2. leg 1 alone: +1% -> closed with profit · -1% -> closed with loss (the turn did not hold)   (high / low per
 *        minute; both in the same minute = the loss)
 *     3. while leg 1 is open, the first signal of the OTHER side on another coin -> leg 2 opens: now a PAIR
 *     4. the pair is watched only as a whole (leg 1 % + leg 2 %, at each minute's close): +TP -> both closed ·
 *        -2% -> both closed (1% risk per leg, two legs)   TP = +1% and +2% tried (+1% = $50 on two $5,000 legs,
 *        +2% = $100)
 *     5. then the next signal after that
 *   fees --fee % per side (each leg opened and closed). Shown per N and TP: the whole --days, each 7-day week, how the
 *   trades ended, and with --list every trade (coins, times, prices, result) to check on the chart.
 *
 *   npx tsx src/tools/pair-chase-test.ts
 *   options: --days 30  --tf 60  --leg 5000  --fee 0.05  --window 12  --list
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { atrBefore, candles, type MinBar } from "../research/dc15";
import { atrSignals, flushSignals } from "../research/atr-turn";
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
const px = (v: number): string => String(+v.toPrecision(5));
const M = 60_000,
  D = 86_400_000,
  F5 = 5 * M,
  WEEK = 7 * D,
  SKIP = ["BTCUSDT", "ETHUSDT"];
const dayStr = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** 1m klines, whole past days cached on disk (the same cache as pair-backtest.ts) */
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
  return out;
}
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

/** minute high / low / close of one coin in flat arrays (60 days x 23 coins as Maps of objects is too big for a 1 GB server) */
class MinuteStore {
  private readonly hi: Float64Array;
  private readonly lo: Float64Array;
  private readonly cl: Float64Array;
  constructor(
    private readonly t0: number,
    n: number,
  ) {
    this.hi = new Float64Array(n).fill(NaN);
    this.lo = new Float64Array(n).fill(NaN);
    this.cl = new Float64Array(n).fill(NaN);
  }
  set(b: { t: number; high: number; low: number; close: number }): void {
    const i = (b.t - this.t0) / M;
    if (i >= 0 && i < this.cl.length) {
      this.hi[i] = b.high;
      this.lo[i] = b.low;
      this.cl[i] = b.close;
    }
  }
  get(t: number): { high: number; low: number; close: number } | undefined {
    const i = (t - this.t0) / M;
    if (!(i >= 0 && i < this.cl.length) || !Number.isFinite(this.cl[i]))
      return undefined;
    return { high: this.hi[i], low: this.lo[i], close: this.cl[i] };
  }
}

interface Sig {
  sym: string;
  side: "LONG" | "SHORT";
  t: number;
  price: number;
  moveAtr: number;
}
interface Leg {
  sym: string;
  side: "LONG" | "SHORT";
  t: number;
  price: number;
}
interface Trade {
  kind: "SINGLE" | "PAIR";
  legs: Leg[];
  t0: number;
  t1: number;
  exits: number[];
  pnl: number;
  how: string;
}

async function main(): Promise<void> {
  const days = Number(arg("days", "30")),
    tf = Number(arg("tf", "60")),
    legUsd = Number(arg("leg", "5000")),
    fee = Number(arg("fee", "0.05")),
    win = Number(arg("window", "12"));
  const to = Math.floor(Date.now() / (15 * M)) * 15 * M,
    testFrom = to - days * D,
    from = Math.floor(testFrom / D) * D - 3 * D;
  const syms = (process.env.SYMBOLS ?? "")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter((x) => x && !SKIP.includes(x));
  if (!syms.length) throw new Error("SYMBOLS not set");
  const btc = await minutes("BTCUSDT", from, to),
    btcMap = new Map(btc.map((b) => [b.t, b.close]));
  const bars = new Map<string, MinuteStore>(),
    sigs: Sig[] = [],
    notes: string[] = [];
  for (const sym of syms) {
    let mb: MinBar[];
    try {
      const k = await minutes(sym, from, to);
      mb = minuteBars(k, await oiSnapshots(sym, from, to, "5m")).filter(
        (b) => b.oiFirst > 0 && b.oiLast > 0,
      );
    } catch (err) {
      notes.push(
        `${sym}: data failed (${err instanceof Error ? err.message : err})`,
      );
      continue;
    }
    if (mb.length < 3 * 24 * 60) {
      notes.push(`${sym}: too little data`);
      continue;
    }
    const store = new MinuteStore(from, Math.ceil((to - from) / M) + 1);
    for (const b of mb) store.set(b);
    bars.set(sym, store);
    const map = new Map(mb.map((b) => [b.t, b.close])),
      c = candles(mb, tf),
      atr = atrBefore(c, V10_ATR_N),
      byEnd = new Map(c.map((x, i) => [x.end, i]));
    const raw = [
      ...atrSignals(c, V10_K, V10_ATR_N, win, {
        atr: "live",
        topCandleOi: false,
      }).filter((g) => g.side === "SHORT"),
      ...flushSignals(c, V10_K, V10_ATR_N, win, { rank: true, side: "LONG" }),
    ];
    for (const g of raw) {
      if (g.t < testFrom) continue;
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
        !(givebackPct(turn, g.price) < 50) ||
        againstCandles(mb, turn, tf).length
      )
        continue;
      const i = byEnd.get(g.t),
        a = i === undefined ? NaN : atr[i];
      if (!(a > 0)) continue;
      // the move in ATRs: start -> extreme, in price
      const start = g.extreme / (1 + g.movePct / 100);
      sigs.push({
        sym,
        side: g.side,
        t: g.t,
        price: g.price,
        moveAtr: Math.abs(g.extreme - start) / a,
      });
    }
  }
  process.stderr.write("\n");
  sigs.sort((a, b) => a.t - b.t);
  const coins = bars.size;

  const pctOf = (l: Leg, p: number): number =>
    l.side === "LONG" ? 100 * (p / l.price - 1) : 100 * (1 - p / l.price);
  const flip = (x: "LONG" | "SHORT"): "LONG" | "SHORT" =>
    x === "LONG" ? "SHORT" : "LONG";
  // rev (Oct 6): every leg entered WITH the move (the signal's side flipped) -- the continuation
  const run = (nAtr: number, pairTp: number, rev = false): Trade[] => {
    const S = sigs.filter((s) => s.moveAtr >= nAtr),
      out: Trade[] = [];
    let i = 0;
    while (i < S.length) {
      const first = S[i],
        b1 = bars.get(first.sym)!,
        l1: Leg = {
          sym: first.sym,
          side: rev ? flip(first.side) : first.side,
          t: first.t,
          price: first.price,
        };
      let done: Trade | null = null,
        j = i + 1;
      // walk the minutes after leg 1 opened
      for (let t = first.t; t < to && !done; t += M) {
        // 1. the other side's signal on another coin, known at t (a candle closed at t) -> the pair, from t on
        while (!done && j < S.length && S[j].t <= t) {
          const s = S[j++];
          if (
            s.t < first.t ||
            (rev ? flip(s.side) : s.side) === l1.side ||
            s.sym === l1.sym ||
            !bars.get(s.sym)!.get(s.t)
          )
            continue;
          const l2: Leg = {
              sym: s.sym,
              side: rev ? flip(s.side) : s.side,
              t: s.t,
              price: s.price,
            },
            b2 = bars.get(s.sym)!;
          for (let u = s.t; u < to; u += M) {
            const x1 = b1.get(u),
              x2 = b2.get(u);
            if (!x1 || !x2) continue;
            const tot = pctOf(l1, x1.close) + pctOf(l2, x2.close);
            if (tot >= pairTp || tot <= -2) {
              done = {
                kind: "PAIR",
                legs: [l1, l2],
                t0: l1.t,
                t1: u + M,
                exits: [x1.close, x2.close],
                pnl: tot - 4 * fee,
                how: tot >= pairTp ? `pair +${pairTp}%` : "pair -2%",
              };
              break;
            }
          }
          if (!done)
            done = {
              kind: "PAIR",
              legs: [l1, l2],
              t0: l1.t,
              t1: to,
              exits: [
                b1.get(to - M)?.close ?? NaN,
                b2.get(to - M)?.close ?? NaN,
              ],
              pnl: NaN,
              how: "OPEN",
            };
        }
        if (done) break;
        // 2. leg 1 alone in the minute [t, t+1m): -1% / +1% on its high / low (both -> the loss)
        const k1 = b1.get(t);
        if (!k1) continue;
        const worst =
            l1.side === "LONG" ? pctOf(l1, k1.low) : pctOf(l1, k1.high),
          best = l1.side === "LONG" ? pctOf(l1, k1.high) : pctOf(l1, k1.low);
        if (worst <= -1)
          done = {
            kind: "SINGLE",
            legs: [l1],
            t0: l1.t,
            t1: t + M,
            exits: [l1.side === "LONG" ? l1.price * 0.99 : l1.price * 1.01],
            pnl: -1 - 2 * fee,
            how: "leg 1 alone -1%",
          };
        else if (best >= 1)
          done = {
            kind: "SINGLE",
            legs: [l1],
            t0: l1.t,
            t1: t + M,
            exits: [l1.side === "LONG" ? l1.price * 1.01 : l1.price * 0.99],
            pnl: 1 - 2 * fee,
            how: "leg 1 alone +1%",
          };
      }
      if (!done) {
        const last = b1.get(to - M)?.close ?? NaN;
        done = {
          kind: "SINGLE",
          legs: [l1],
          t0: l1.t,
          t1: to,
          exits: [last],
          pnl: NaN,
          how: "OPEN",
        };
      }
      if (done.how === "OPEN") {
        const ls = done.legs;
        done.pnl =
          ls.reduce((a, l, k) => a + pctOf(l, done!.exits[k]), 0) -
          2 * fee * ls.length;
      }
      out.push(done);
      // the next one: the first signal after this trade ended
      while (i < S.length && S[i].t < done.t1) i++;
      if (done.how === "OPEN") break;
    }
    return out;
  };

  const usd = (pct: number): number => (pct / 100) * legUsd;
  const weeks: Array<[number, number]> = [];
  for (let e = to + 1; e - WEEK >= testFrom - 1; e -= WEEK)
    weeks.unshift([e - WEEK, e]);
  console.log(
    `ONE GOES DOWN, ONE GOES UP · ${coins} coins · ${utc(testFrom)} -> ${utc(to)} UTC (${days} days) · ${tf}m candles, our live rules · $${legUsd} per leg · fee ${fee}%/side`,
  );
  console.log(
    `leg 1 alone: +1% / -1% · with leg 2: the pair as a whole +TP / -2% · one thing at a time · $ = on $${legUsd} legs (1% of a leg = $${usd(1)})`,
  );
  console.log(
    `signals passing the rules: ${sigs.length} (SHORT ${sigs.filter((s) => s.side === "SHORT").length} · LONG ${sigs.filter((s) => s.side === "LONG").length}) · weeks by the exit: ${weeks.map(([a]) => utc(a).slice(0, 5)).join(" | ")}\n`,
  );
  for (const rev of [false, true])
    for (const n of [2, 3, 4])
      for (const tp of [1, 2]) {
        const tr = run(n, tp, rev),
          sum = (l: Trade[]): number => usd(l.reduce((a, x) => a + x.pnl, 0));
        const wk = weeks.map(([a, b]) =>
          sum(tr.filter((x) => x.t1 > a && x.t1 <= b)),
        );
        const cnt = (h: string): number => tr.filter((x) => x.how === h).length;
        console.log(
          `  ${rev ? "WITH the move" : "our side     "} · move >= ${n} ATR · pair TP +${tp}%   ${sp(sum(tr), 0).padStart(6)}$ │ ${wk.map((v) => `${sp(v, 0).padStart(5)}$`).join(" ")} │ weeks + ${wk.filter((v) => v > 0).length}/${wk.length} │ alone +1%: ${cnt("leg 1 alone +1%")} · alone -1%: ${cnt("leg 1 alone -1%")} · pair +${tp}%: ${cnt(`pair +${tp}%`)} · pair -2%: ${cnt("pair -2%")} · open: ${cnt("OPEN")}`,
        );
      }
  // Oct 6: after a 1h signal the price went 1% AGAINST us 61-69% of the time -> is it continuation? Every signal on its
  // own (one at a time per coin), +1% / -1% on the minute high / low (both in one minute = the loss), OUR side vs the
  // REVERSED side (enter the way the move was going), LONG and SHORT signals apart, per week.
  console.log(
    `\n── EVERY SIGNAL ALONE, +1% / -1%: our side vs REVERSED (with the move) · $ on one $${legUsd} leg · weeks by the exit ──`,
  );
  const alone = (
    nAtr: number,
    side: "LONG" | "SHORT" | "ALL",
    rev: boolean,
  ): Array<{ t1: number; pnl: number }> => {
    const out: Array<{ t1: number; pnl: number }> = [],
      busy = new Map<string, number>();
    for (const g of sigs) {
      if (
        g.moveAtr < nAtr ||
        (side !== "ALL" && g.side !== side) ||
        (busy.get(g.sym) ?? 0) > g.t
      )
        continue;
      const l: Leg = {
          sym: g.sym,
          side: rev ? (g.side === "LONG" ? "SHORT" : "LONG") : g.side,
          t: g.t,
          price: g.price,
        },
        b = bars.get(g.sym)!;
      for (let t = g.t; t < to; t += M) {
        const k = b.get(t);
        if (!k) continue;
        const worst = l.side === "LONG" ? pctOf(l, k.low) : pctOf(l, k.high),
          best = l.side === "LONG" ? pctOf(l, k.high) : pctOf(l, k.low);
        if (worst <= -1) {
          out.push({ t1: t + M, pnl: -1 - 2 * fee });
          busy.set(g.sym, t + M);
          break;
        }
        if (best >= 1) {
          out.push({ t1: t + M, pnl: 1 - 2 * fee });
          busy.set(g.sym, t + M);
          break;
        }
      }
    }
    return out;
  };
  for (const n of [2, 3, 4])
    for (const side of ["ALL", "SHORT", "LONG"] as const)
      for (const rev of [false, true]) {
        const r = alone(n, side, rev),
          w = r.filter((x) => x.pnl > 0).length;
        const wk = weeks.map(([a, b]) =>
          usd(
            r
              .filter((x) => x.t1 > a && x.t1 <= b)
              .reduce((s2, x) => s2 + x.pnl, 0),
          ),
        );
        const sideName = side === "ALL" ? "all signals" : `${side} signals`;
        console.log(
          `  >= ${n} ATR · ${sideName.padEnd(13)} · ${rev ? "REVERSED" : "our side"} ${sp(usd(r.reduce((s2, x) => s2 + x.pnl, 0)), 0).padStart(6)}$ │ ${wk.map((v) => `${sp(v, 0).padStart(5)}$`).join(" ")} │ weeks + ${wk.filter((v) => v > 0).length}/${wk.length} │ ${r.length} trades · +1% first ${r.length ? Math.round((100 * w) / r.length) : 0}%`,
        );
      }
  if (argv.includes("--list")) {
    console.log(`\nevery trade · WITH the move · move >= 3 ATR · pair TP +1%:`);
    for (const x of run(3, 1, true)) {
      const L = x.legs
        .map(
          (l, k) =>
            `${l.side} ${l.sym.replace(/USDT$/, "")} ${utc(l.t)} @${px(l.price)} -> ${px(x.exits[k])}`,
        )
        .join("  +  ");
      console.log(
        `  ${utc(x.t0)} -> ${utc(x.t1)}  ${x.how.padEnd(16)} ${sp(usd(x.pnl), 0).padStart(5)}$  ${L}`,
      );
    }
  }
  for (const n of notes) console.log(n);
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
