/**
 * THE SAME DAYS, THREE SOURCES -- is something wrong (UTC, Binance data, our DB)? (Johnny, Oct 6 2026). Read-only.
 * For the live V10 ALT rules (SHORT = the ALT rule, LONG = flush; own move; the move start -> extreme > --tp %; given
 * back < 50%; no candle against the turn) on --tf candles, every signal in [--from, now) found by:
 *   DB       our own minute_bars (mark price per second -> no real wicks; OI per second), SL / TP simulated on them
 *   BINANCE  Binance 1m klines (real wicks) + Binance 5-minute OI (the same as pair-backtest.ts), SL / TP on them
 *   BOT      what the live bot really recorded: v10_signals (kind OWN) and --user's v10_trades (PAPER / REAL result)
 * side by side, matched by coin + side + candle close time (UTC). Then the totals in R (SL --pct, TP --tp) of each
 * source: all its own signals, and only the signals all three found. One trade at a time per coin and side in DB /
 * BINANCE (the bot has its own limits: maxOpen, new coins, ...).
 *
 *   npx tsx src/tools/compare-sources.ts
 *   options: --from 2026-09-22  --tf 15  --pct 1  --tp 2  --user main  --fee 0.05   (every signal is listed at the end)
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
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
import { V10_SIGNALS, V10_TRADES } from "../strategy/v10/v10-repository";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number, d = 2): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "n/a";
const px = (v: number): string =>
  Number.isFinite(v) ? String(+v.toPrecision(5)) : "-";
const M = 60_000,
  D = 86_400_000,
  F5 = 5 * M,
  SKIP = ["BTCUSDT", "ETHUSDT"];
const dayStr = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

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
  }
  return out;
}
function binanceBars(k: Kline[], snap: Map<number, number>): MinBar[] {
  const oi = (x: number): number => {
    const a = Math.floor(x / F5) * F5,
      va = snap.get(a),
      vb = snap.get(a + F5);
    if (x === a) return va ?? NaN;
    return va !== undefined && vb !== undefined
      ? va + ((vb - va) * (x - a)) / F5
      : NaN;
  };
  return k
    .map((x) => ({
      t: x.t,
      high: x.high,
      low: x.low,
      close: x.close,
      oiFirst: oi(x.t),
      oiLast: oi(x.t + M),
    }))
    .filter((b) => b.oiFirst > 0 && b.oiLast > 0);
}

interface Hit {
  price: number;
  exit: string;
  r: number;
  startT: number;
  extreme: number;
}
type Side = "LONG" | "SHORT";

/** the live ALT signals of one coin from minute bars, each with its SL / TP result on the same bars */
function signals(
  bars: MinBar[],
  btcMap: Map<number, number>,
  tf: number,
  from: number,
  pct: number,
  tpPct: number,
  fee: number,
): Map<string, Hit> {
  const out = new Map<string, Hit>();
  if (bars.length < 2 * 24 * 60) return out;
  const map = new Map(bars.map((b) => [b.t, b.close])),
    c = candles(bars, tf);
  const raw = [
    ...atrSignals(c, V10_K, V10_ATR_N, 12, {
      atr: "live",
      topCandleOi: false,
    }).filter((g) => g.side === "SHORT" && g.movePct > tpPct),
    ...flushSignals(c, V10_K, V10_ATR_N, 12, {
      rank: true,
      side: "LONG",
    }).filter((g) => -g.movePct > tpPct),
  ].sort((a, b) => a.t - b.t);
  const busy: Record<Side, number> = { LONG: 0, SHORT: 0 };
  for (const g of raw) {
    if (g.t < from) continue;
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
      againstCandles(bars, turn, tf).length
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
    out.set(`${g.side}|${g.t}`, {
      price: g.price,
      exit: tr.exit,
      r: tr.exit === "OPEN" ? NaN : tr.r - (2 * fee) / pct,
      startT: g.startT,
      extreme: g.extreme,
    });
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const from = Date.parse(`${arg("from", "2026-09-22")}T00:00:00Z`),
    tf = Number(arg("tf", "15")),
    pct = Number(arg("pct", "1")),
    tpPct = Number(arg("tp", "2"));
  const fee = Number(arg("fee", "0.05")),
    user = arg("user", "main");
  const to = Math.floor(Date.now() / (15 * M)) * 15 * M,
    warm = from - 3 * D;
  const syms = (process.env.SYMBOLS ?? "")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter((x) => x && !SKIP.includes(x));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const loadDb = async (symbol: string): Promise<MinBar[]> =>
      (
        await db
          .collection(MINUTE_BARS)
          .find({
            symbol,
            high: { $ne: null },
            ts: { $gte: new Date(warm), $lt: new Date(to) },
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
    const btcDb = await loadDb("BTCUSDT"),
      btcDbMap = new Map(btcDb.map((b) => [b.t, b.close]));
    const btcBn = await minutes("BTCUSDT", warm, to),
      btcBnMap = new Map(btcBn.map((b) => [b.t, b.close]));
    const dbFirst = btcDb.length ? btcDb[0].t : NaN;

    // the bot: its OWN signals and the user's trades
    const botSig = await db
      .collection(V10_SIGNALS)
      .find({ kind: "OWN", createdAt: { $gte: new Date(from) } })
      .project({
        signalId: 1,
        symbol: 1,
        side: 1,
        turn: 1,
        createdAt: 1,
        newCoin: 1,
      })
      .toArray();
    const botTr = await db
      .collection(V10_TRADES)
      .find({ userId: user, createdAt: { $gte: from } })
      .project({
        signalId: 1,
        symbol: 1,
        side: 1,
        state: 1,
        mode: 1,
        entryPrice: 1,
        exitPrice: 1,
        pnlR: 1,
        closeReason: 1,
        slPct: 1,
        tpPct: 1,
      })
      .toArray();
    const trBySig = new Map(botTr.map((t) => [`${t.signalId}|${t.symbol}`, t]));

    interface Row {
      sym: string;
      side: Side;
      t: number;
      db?: Hit;
      bn?: Hit;
      bot?: {
        price: number;
        result: string;
        r: number;
        mode: string;
        newCoin: boolean;
      };
    }
    const rows = new Map<string, Row>();
    const row = (sym: string, side: Side, t: number): Row => {
      const k = `${sym}|${side}|${t}`;
      let r = rows.get(k);
      if (!r) {
        r = { sym, side, t };
        rows.set(k, r);
      }
      return r;
    };
    for (const s of botSig) {
      const t = Number(
        (s.turn as { candleEnd?: number } | undefined)?.candleEnd ??
          new Date(s.createdAt as Date).getTime(),
      );
      if (t >= to) continue;
      const tr = trBySig.get(`${s.signalId}|${s.symbol}`);
      const r =
        tr && tr.state === "CLOSED" && tr.pnlR !== null ? Number(tr.pnlR) : NaN;
      row(String(s.symbol), s.side as Side, t).bot = {
        price: Number(
          tr?.entryPrice ??
            (s.turn as { price?: number } | undefined)?.price ??
            NaN,
        ),
        result: tr
          ? tr.state === "CLOSED"
            ? String(tr.closeReason ?? "CLOSED").replace("_FILLED", "")
            : String(tr.state)
          : "no trade",
        r,
        mode: tr ? String(tr.mode) : "-",
        newCoin: !!s.newCoin,
      };
    }
    const notes: string[] = [];
    for (const sym of syms) {
      process.stderr.write(`\r${sym}          `);
      try {
        const dbBars = await loadDb(sym);
        for (const [k, h] of signals(
          dbBars,
          btcDbMap,
          tf,
          from,
          pct,
          tpPct,
          fee,
        )) {
          const [side, t] = k.split("|");
          row(sym, side as Side, Number(t)).db = h;
        }
        const bn = binanceBars(
          await minutes(sym, warm, to),
          await oiSnapshots(sym, warm, to, "5m"),
        );
        for (const [k, h] of signals(bn, btcBnMap, tf, from, pct, tpPct, fee)) {
          const [side, t] = k.split("|");
          row(sym, side as Side, Number(t)).bn = h;
        }
        if (dbBars.length && dbBars[0].t > dbFirst + D)
          notes.push(
            `${sym.replace(/USDT$/, "")}: new in our DB from ${utc(dbBars[0].t)}`,
          );
      } catch (err) {
        notes.push(`${sym}: ${err instanceof Error ? err.message : err}`);
      }
    }
    process.stderr.write("\n");

    const all = [...rows.values()].sort((a, b) => a.t - b.t);
    const sum = (l: Array<number | undefined>): number =>
      l.reduce<number>(
        (a, v) => a + (Number.isFinite(v) ? (v as number) : 0),
        0,
      );
    const n = (f: (r: Row) => boolean): number => all.filter(f).length;
    console.log(
      `THE SAME DAYS, THREE SOURCES · ${utc(from)} -> ${utc(to)} UTC · ${tf}m · the live ALT rules (move > ${tpPct}%) · SL ${pct}% / TP ${tpPct}% · bot user ${user}`,
    );
    console.log(
      `DB = our minute_bars (mark price, no real wicks) · BINANCE = Binance 1m klines + 5m OI · BOT = v10_signals OWN + ${user}'s v10_trades\n`,
    );
    console.log(
      `signals found:  DB ${n((r) => !!r.db)} · BINANCE ${n((r) => !!r.bn)} · BOT ${n((r) => !!r.bot)}`,
    );
    console.log(
      `  all three ${n((r) => !!(r.db && r.bn && r.bot))} · DB + BINANCE only ${n((r) => !!(r.db && r.bn && !r.bot))} · DB + BOT only ${n((r) => !!(r.db && !r.bn && r.bot))} · BINANCE + BOT only ${n((r) => !!(!r.db && r.bn && r.bot))}`,
    );
    console.log(
      `  only DB ${n((r) => !!(r.db && !r.bn && !r.bot))} · only BINANCE ${n((r) => !!(!r.db && r.bn && !r.bot))} · only BOT ${n((r) => !!(!r.db && !r.bn && r.bot))}\n`,
    );
    const tot = (name: string, l: Row[]): void => {
      const d = l.filter((r) => r.db && r.db.exit !== "OPEN"),
        b = l.filter((r) => r.bn && r.bn.exit !== "OPEN"),
        o = l.filter((r) => r.bot && Number.isFinite(r.bot.r));
      const w = (x: Array<{ r: number } | undefined>): string => {
        const v = x.filter((y) => y && Number.isFinite(y.r)) as Array<{
          r: number;
        }>;
        return `${v.length} trades, ${v.length ? Math.round((100 * v.filter((y) => y.r > 0).length) / v.length) : 0}% won, ${sp(sum(v.map((y) => y.r)))}R`;
      };
      console.log(
        `  ${name.padEnd(34)} DB: ${w(d.map((r) => r.db))} │ BINANCE: ${w(b.map((r) => r.bn))} │ BOT: ${w(o.map((r) => r.bot))}`,
      );
    };
    console.log("totals in R (fees in):");
    tot("each source, all its own signals", all);
    tot(
      "only signals all three found",
      all.filter((r) => r.db && r.bn && r.bot),
    );
    tot(
      "only signals DB and BINANCE found",
      all.filter((r) => r.db && r.bn),
    );
    // the same signal, a different result: where and why (the price path differs -> wicks)
    const diff = all.filter(
      (r) =>
        r.db &&
        r.bn &&
        r.db.exit !== "OPEN" &&
        r.bn.exit !== "OPEN" &&
        r.db.exit !== r.bn.exit,
    );
    console.log(
      `\nthe same signal, a different result DB vs BINANCE: ${diff.length} (DB TP & BINANCE SL: ${diff.filter((r) => r.db!.exit === "TP").length} · DB SL & BINANCE TP: ${diff.filter((r) => r.db!.exit === "SL").length})`,
    );
    const pdiff = all
      .filter((r) => r.db && r.bn)
      .map((r) => (100 * Math.abs(r.db!.price - r.bn!.price)) / r.bn!.price);
    if (pdiff.length)
      console.log(
        `entry price DB vs BINANCE on the same signals: median gap ${pdiff.sort((a, b) => a - b)[Math.floor(pdiff.length / 2)].toFixed(3)}% · biggest ${Math.max(...pdiff).toFixed(3)}%`,
      );
    {
      console.log(
        `\nevery signal (UTC candle close) · DB / BINANCE: entry -> TP/SL (R) · BOT: entry, result (R), mode`,
      );
      const f = (h?: Hit): string =>
        h
          ? `${px(h.price).padStart(8)} ${h.exit.padEnd(4)} ${sp(h.r, 1).padStart(5)}`
          : "        -            ".padEnd(19);
      for (const r of all) {
        const b = r.bot
          ? `${px(r.bot.price).padStart(8)} ${r.bot.result.padEnd(9)} ${sp(r.bot.r, 1).padStart(5)} ${r.bot.mode}${r.bot.newCoin ? " new" : ""}`
          : "-";
        console.log(
          `  ${utc(r.t)} ${r.sym.replace(/USDT$/, "").padEnd(6)} ${r.side.padEnd(5)} │ DB ${f(r.db)} │ BN ${f(r.bn)} │ BOT ${b}`,
        );
      }
    }
    for (const x of notes) console.log(x);
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
