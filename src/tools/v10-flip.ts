/**
 * V10 FLIP (STOP AND REVERSE) ON ALTS -- BACKTEST (Johnny, Oct 3 2026). Read-only, our DB (minute_bars). Live untouched.
 *
 * OPEN (the full rule, on the alt's own 15m candles, RANK 1 over --window hours, the move > --move %, moved on its own):
 *   SHORT  a top:    the live ALT rule (atr, no top-candle OI rule): OI grew with the price, OI below its peak, the close
 *                    1 ATR below the top made by an earlier candle
 *   LONG   a bottom: "flush": the fall built with OI FALLING (RANK 1 on that OI decrease), then a candle with OI RISING
 *                    that closes 1 ATR above the low
 *   own = BTC went the other way, or R2 < 0.5 (as live, --own 1|15)
 * HOLD with SL --pct % (minute by minute; no TP). CLOSE at a 15m candle's close when (no %, no RANK, no BTC check):
 *   SHORT  a GREEN candle closes >= 1 ATR above the lowest low since the entry, and OI ROSE in that candle
 *   LONG   a RED candle closes >= 1 ATR below the highest high since the entry, and OI FELL in that candle
 *   (or the opposite full signal comes). At that close: if the opposite full signal is there -> open it at once (FLIP),
 *   else stay flat and wait for the next full signal.
 * Compared with the SAME entries traded with a fixed SL --pct % / TP --tp % (one trade per coin at a time).
 * The ATR = the 15m ATR(14) known before the candle (as the entries). Same minute SL = SL. net R = R - 2 x fee / SL%.
 *
 *   npx tsx src/tools/v10-flip.ts --pct 1 --tp 2
 *   options: --move 2 (the min move to open, default = --tp)  --window 12  --own 1|15  --fee 0.05  --new (new coins too)
 *            --no-rank (LONG flush without RANK 1)  --without AVAX  --list (every trade)  --by-coin
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type MinBar } from "../research/dc15";
import {
  flipCoin,
  type FlipExit as Exit,
  type FlipSig as Sig,
  type FlipTrade as Tr,
} from "../research/flip";
import { flushSignals } from "../research/atr-turn";
import { simTrade } from "../research/sltp";
import {
  moveOf,
  ownMove,
  signalsOf,
  V10_ATR_N,
  V10_K,
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
const DAY = 86_400_000;

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const pct = Number(arg("pct", "1")),
    tpPct = Number(arg("tp", "2")),
    minMove = Number(arg("move", String(tpPct)));
  const win = Number(arg("window", "12")),
    own = Number(arg("own", "1")),
    fee = Number(arg("fee", "0.05"));
  const withNew = argv.includes("--new"),
    rank = !argv.includes("--no-rank");
  const without = arg("without", "AVAX")
    .toUpperCase()
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
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
    const btc = await load("BTCUSDT");
    const btcMap = new Map(btc.map((b) => [b.t, b.close]));
    const flip: Tr[] = [],
      fixed: Tr[] = [];
    const per: Array<{ sym: string; short: number; long: number }> = [];
    for (const s of (process.env.SYMBOLS ?? "")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x && x !== "BTCUSDT")) {
      const sym = s.replace(/USDT$/, "");
      if (without.includes(sym)) continue;
      const bars = await load(s);
      if (!bars.length || (!withNew && bars[0].t > btc[0].t + DAY)) continue;
      const map = new Map(bars.map((b) => [b.t, b.close])),
        c = candles(bars, V10_TF_MIN);
      const isOwn = (startT: number, t: number): boolean =>
        !!ownMove(
          { moveStartT: startT, candleEnd: t } as V10Turn,
          map,
          btcMap,
          own,
        );
      const sigs: Sig[] = [];
      for (const g of signalsOf(c, win, { entry: "atr", topCandleOi: false }))
        if (
          g.side === "SHORT" &&
          isOwn(g.startT, g.t) &&
          moveOf({ kind: "OWN", side: "SHORT", turn: g }, { coinPct: NaN }) >
            minMove
        )
          sigs.push({ t: g.t, side: "SHORT", price: g.price });
      for (const g of flushSignals(c, V10_K, V10_ATR_N, win, {
        rank,
        side: "LONG",
      }))
        if (
          isOwn(g.startT, g.t) &&
          moveOf({ kind: "OWN", side: "LONG", turn: g }, { coinPct: NaN }) >
            minMove
        )
          sigs.push({ t: g.t, side: "LONG", price: g.price });
      sigs.sort((a, b) => a.t - b.t);
      per.push({
        sym,
        short: sigs.filter((x) => x.side === "SHORT").length,
        long: sigs.filter((x) => x.side === "LONG").length,
      });
      flip.push(...flipCoin(sym, bars, c, sigs, pct, fee));
      // the same entries, fixed SL / TP, one trade per coin at a time
      let busy = 0;
      for (const g of sigs) {
        if (busy > g.t) continue;
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
        busy = tr.exitT;
        fixed.push({
          sym,
          side: g.side,
          t: g.t,
          entry: g.price,
          exitT: tr.exitT,
          exitP: NaN,
          exit: tr.exit,
          r: tr.r,
          net: tr.r - (2 * fee) / pct,
        });
      }
    }
    const line = (name: string, l: readonly Tr[]): string => {
      const n = l.reduce((a, d) => a + d.net, 0),
        win = l.filter((d) => d.net > 0).length;
      const cnt = (e: Exit): number => l.filter((d) => d.exit === e).length;
      const hold = l.length
        ? l.reduce((a, d) => a + (d.exitT - d.t), 0) / l.length / 3_600_000
        : 0;
      const ex = (["TP", "SL", "TURN", "FLIP", "OPEN"] as Exit[])
        .filter((e) => cnt(e))
        .map((e) => `${e} ${cnt(e)}`)
        .join(" · ");
      return `  ${name.padEnd(22)} ${String(l.length).padStart(3)} trades · win ${l.length ? Math.round((100 * win) / l.length) : 0}% · net R ${sp(n).padStart(7)} ($${(n * 10).toFixed(0)} at $10) · avg hold ${hold.toFixed(1)}h · ${ex}`;
    };
    console.log(
      `V10 FLIP ON ALTS · 15m · SL ${pct}% · open: move > ${minMove}% · RANK 1 ${win}h${rank ? "" : " (LONG without RANK)"} · own (R² ${own}m) · fee ${fee}%/side · ${withNew ? "all alts" : "old alts only"}${without.length ? ` · without ${without.join(",")}` : ""} · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`,
    );
    console.log(
      `signals: SHORT ${per.reduce((a, p) => a + p.short, 0)} · LONG ${per.reduce((a, p) => a + p.long, 0)} · net R at $10 risk · win = net R > 0\n`,
    );
    console.log(
      `FLIP (no TP; close on the reversal candle, flip if the opposite full signal is there)`,
    );
    console.log(line("all", flip));
    console.log(
      line(
        " SHORT",
        flip.filter((d) => d.side === "SHORT"),
      ),
    );
    console.log(
      line(
        " LONG",
        flip.filter((d) => d.side === "LONG"),
      ),
    );
    console.log(`\nFIXED SL ${pct}% / TP ${tpPct}% on the same entries`);
    console.log(line("all", fixed));
    console.log(
      line(
        " SHORT",
        fixed.filter((d) => d.side === "SHORT"),
      ),
    );
    console.log(
      line(
        " LONG",
        fixed.filter((d) => d.side === "LONG"),
      ),
    );
    if (argv.includes("--by-coin")) {
      console.log(`\nBY COIN (flip net R / fixed net R)`);
      const sum = (l: readonly Tr[], s: string): number =>
        l.filter((d) => d.sym === s).reduce((a, d) => a + d.net, 0);
      for (const p of [...per].sort(
        (a, b) => sum(flip, a.sym) - sum(flip, b.sym),
      ))
        if (p.short + p.long)
          console.log(
            `  ${p.sym.padEnd(8)} signals S ${p.short} L ${p.long} · flip ${sp(sum(flip, p.sym)).padStart(6)} · fixed ${sp(sum(fixed, p.sym)).padStart(6)}`,
          );
    }
    if (argv.includes("--list")) {
      console.log(`\nFLIP TRADES (UTC)`);
      for (const d of [...flip].sort((a, b) => a.t - b.t))
        console.log(
          `  ${utc(d.t)} ${d.sym.padEnd(7)} ${d.side.padEnd(5)} in ${d.entry} -> ${utc(d.exitT)} out ${Number.isFinite(d.exitP) ? +d.exitP.toPrecision(6) : "?"} ${d.exit.padEnd(4)} ${sp(d.net)}R · ${((d.exitT - d.t) / 3_600_000).toFixed(1)}h`,
        );
    }
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
