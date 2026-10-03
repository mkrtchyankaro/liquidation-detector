/**
 * V10 ENTRIES COMPARED -- BACKTEST (Oct 3 2026) Read-only, our DB (minute_bars). The SAME functions as live
 * (src/strategy/v10/v10-engine.ts signalsOf / pickAlts / ownMove), on all history at once, for each entry rule:
 *   atr            OI grew with the price (RANK 1), OI now below its peak, the 15m close 1 ATR back from the top made
 *                  by an earlier candle (src/research/atr-turn.ts) -- the ATR before the candle
 *   atrFrozen      the same with the ATR from the move's start
 *   oiPeak         OI low -> OI peak -> first red candle with OI down (no ATR distance)
 *   A = BTC's signal -> the picks (in at BTC's signal) · B = an alt's own signal, moved on its own (old alts only)
 * Exit: SL / TP % from the entry, no time limit, same minute SL + TP = SL; one trade per coin at a time (A first);
 * net R = R - 2 x fee / SL%.
 *
 *   npx tsx src/tools/v10-entry-compare.ts --pct 1 --tp 2
 *   "noTopOi" = WITHOUT the rule "the candle that made the top and closed 1 ATR back must have OI down" (as before Oct 3)
 *   "big" = the OI growth measured as the biggest OI rise in the move with the price going the same way (SUI, Oct 3)
 *   --by-coin  every coin's result (A and B apart, worst first; * = a new coin, data since Oct 1)  --new  part B on the new coins too
 *   --tf 60        1-hour candles (default 15); "self" rows = the top candle is the entry if it closes red 1 ATR below its high
 *   "A:high" / "B:body" = the entry candle's HIGH (with its wick) / its BODY top must be 1 ATR below the top (not the close)
 *   --zone up|down|none  only entries where OI went up / down over the candles between the top candle and the entry
 *                        candle (distribution at a top), or there was no such candle
 *   "flush" rows (Johnny Oct 3): a fall built with OI FALLING, then a candle with OI RISING that closes 1 ATR above
 *                        the low -> LONG (run with --side LONG; with --side SHORT: the mirror, a rise built with OI falling)
 *   --posttop up|down   only entries where OI went up / down in the candle right after the top candle
 *   --h1           only 15m signals inside a 1h move of their direction in which OI grew with the price (1h context)
 *   --no-minmove   without the live rule "the coin moved more than the TP %" (default: with it)
 *   --sl extreme --rr 2   SL at the move's extreme (each coin's own high since the build-up began), TP 2 x that risk; net R
 *                         uses each trade's own risk for the fees
 *   "noRed" = without "the entry candle must close red after a top candle that closed 1 ATR back"
 *   options: --own 1|15 (part 2 R2 on 1m returns, default / 15m closes)  --window 12  --picks 3  --fee 0.05  --side SHORT|LONG  --without AVAX  --list atr  (prints that rule's trades)
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type Candle, type MinBar } from "../research/dc15";
import { simTrade, type Trade } from "../research/sltp";
import { h1Context, inH1Growth } from "../research/atr-turn";
import {
  moveOf,
  ownMove,
  pickAlts,
  signalsOf,
  V10_TF_MIN,
  type V10Rule,
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

const RULES: Array<[string, V10Rule]> = [
  ["atr", { entry: "atr" }],
  ["atr noTopOi", { entry: "atr", topCandleOi: false }],
  ["atr noTopOi self", { entry: "atr", topCandleOi: false, selfTop: true }],
  ["atr noTopOi A:high", { entry: "atr", topCandleOi: false, far: "high" }],
  ["atr noTopOi B:body", { entry: "atr", topCandleOi: false, far: "body" }],
  ["atr self", { entry: "atr", selfTop: true }],
  ["atr big", { entry: "atr", growth: "biggest" }],
  ["atrFrozen", { entry: "atrFrozen" }],
  ["atrFrozen noTopOi", { entry: "atrFrozen", topCandleOi: false }],
  [
    "atrFrozen noTopOi self",
    { entry: "atrFrozen", topCandleOi: false, selfTop: true },
  ],
  ["atr noRed", { entry: "atr", redAfterTop: false }],
  ["atrFrozen noRed", { entry: "atrFrozen", redAfterTop: false }],
  ["oiPeak", { entry: "oiPeak" }],
  ["flush", { entry: "flush" }],
  ["flush noRank", { entry: "flush", flushRank: false }],
  ["flush green", { entry: "flush", flushGreen: true }],
  ["story", { entry: "story" }],
  ["storyFrozen", { entry: "storyFrozen" }],
];

interface Cand {
  t: number;
  sym: string;
  src: "A" | "B";
  side: "SHORT" | "LONG";
  entry: number;
  rank: number;
  ext: number;
}
interface Done extends Cand {
  tr: Trade;
  net: number;
  risk: number;
}
/** the coin's own extreme (highest high for a SHORT / lowest low for a LONG) between two times, from its minute bars */
function extremeOf(
  bars: readonly MinBar[],
  from: number,
  to: number,
  short: boolean,
): number {
  let e = short ? -Infinity : Infinity;
  for (const b of bars) {
    if (b.t < from) continue;
    if (b.t >= to) break;
    e = short ? Math.max(e, b.high) : Math.min(e, b.low);
  }
  return e;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const pct = Number(arg("pct", "1")),
    tpPct = Number(arg("tp", arg("pct", "1"))),
    win = Number(arg("window", "12"));
  const npicks = Number(arg("picks", "3")),
    fee = Number(arg("fee", "0.05")),
    side = arg("side", "SHORT").toUpperCase(),
    own = Number(arg("own", "1")),
    withNew = argv.includes("--new"),
    byCoin = argv.includes("--by-coin");
  // --tf 60 (Johnny Oct 3): the same rules on 1-hour candles (ATR 14 of 1h candles); "self" = the top candle itself
  // is the entry when it closes red 1 ATR below its high (no waiting for the next 1h candle)
  const tf = Number(arg("tf", String(V10_TF_MIN)));
  // --h1 (Johnny Oct 3): take a 15m signal only inside a 1h move of its direction in which OI grew with the price
  const h1 = argv.includes("--h1");
  // --posttop up|down (Johnny Oct 3): keep only entries where, in the candle RIGHT AFTER the top candle, OI went up
  // (big sellers opening new shorts after the shorts' liquidity was collected) / went down. Known at the entry: that
  // candle is closed by then (the entry candle is after the top).
  const postTop = arg("posttop", "");
  // --zone up|down|none (Johnny Oct 3, distribution at the top / accumulation at the bottom): the "top zone" = the
  // candles AFTER the top candle and BEFORE the entry candle (the price still within 1 ATR of the top). up = OI rose
  // over that zone (positions built while the price stalled at the top), down = it fell, none = no such candle
  // (the entry came right after the top).
  const zone = arg("zone", "");
  const zoneOk = (
    cs: readonly Candle[],
    extremeT: number,
    t: number,
  ): boolean => {
    if (!zone) return true;
    const topC = cs.find((x) => x.t === extremeT),
      z = cs.filter((x) => x.t > extremeT && x.end < t);
    if (!topC) return false;
    if (!z.length) return zone === "none";
    const d = z[z.length - 1].oi1 - topC.oi1;
    return zone === "up" ? d > 0 : zone === "down" ? d < 0 : false;
  };
  const postTopOk = (
    cs: readonly Candle[],
    extremeT: number,
    t: number,
  ): boolean => {
    if (!postTop) return true;
    const n = cs.find((x) => x.t === extremeT + tf * 60_000);
    if (!n || n.end > t) return false;
    return postTop === "up" ? n.oi1 > n.oi0 : n.oi1 < n.oi0;
  };
  // --sl extreme (Johnny Oct 3): SL at the move's extreme (the coin's own high since the build-up began), TP = --rr x that risk
  const slExt = arg("sl", "pct") === "extreme",
    rrExt = Number(arg("rr", "2"));
  // as live (Oct 3, ETH +0.36%): the coin must have moved MORE than the TP %; --no-minmove = without it
  const minMove = argv.includes("--no-minmove")
    ? -Infinity
    : slExt
      ? -Infinity
      : tpPct;
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
    const coins = new Map<
      string,
      { bars: MinBar[]; map: Map<number, number>; old: boolean }
    >();
    for (const s of (process.env.SYMBOLS ?? "")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x && x !== "BTCUSDT")) {
      const bars = await load(s);
      if (bars.length)
        coins.set(s, {
          bars,
          map: new Map(bars.map((b) => [b.t, b.close])),
          old: bars[0].t <= btc[0].t + DAY,
        });
    }
    const closes = new Map([...coins].map(([s, c]) => [s, c.map]));
    const btcH1 = h1Context(candles(btc, 60), 1, 14),
      altH1 = new Map(
        [...coins].map(([s, c]) => [s, h1Context(candles(c.bars, 60), 1, 14)]),
      );
    const btcC = candles(btc, tf),
      altC = new Map([...coins].map(([s, c]) => [s, candles(c.bars, tf)]));
    const short = (s: string): string => s.replace(/USDT$/, "");

    console.log(
      `V10 ENTRIES COMPARED · ${tf}m candles${zone ? ` · ONLY entries whose top zone (candles between the top and the entry) has OI ${zone.toUpperCase()}` : ""}${postTop ? ` · ONLY entries where OI went ${postTop.toUpperCase()} in the candle right after the top` : ""}${h1 ? " INSIDE a 1h growth (OI up with the price on 1h)" : ""} · ${side} · ${slExt ? `SL at the extreme · TP ${rrExt}R` : `SL ${pct}% · TP ${tpPct}%`} · fee ${fee}%/side · RANK 1 ${win}h · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`,
    );
    console.log(
      `${minMove > -Infinity ? `only coins that moved MORE than the TP ${tpPct}% (as live) · ` : "no minimum move · "}A = BTC's signal -> ${npicks} picks · B = the alt's own move (${withNew ? "ALL alts, the new ones too" : "old alts only"}, R² on ${own}m) · net R at $10 risk\n`,
    );
    const head = `${"rule".padEnd(24)} ${"part".padEnd(10)} trades   TP   SL open  win   net R      $  hold`;
    console.log(head);
    for (const [name, rule] of RULES) {
      const cands: Cand[] = [];
      const btcSigs = signalsOf(btcC, win, rule).filter((s) => s.side === side);
      for (const s of btcSigs) {
        if (h1 && !inH1Growth(btcH1, s.t, s.side)) continue;
        if (!postTopOk(btcC, s.extremeT, s.t) || !zoneOk(btcC, s.extremeT, s.t))
          continue;
        const turn = {
          moveStartT: s.startT,
          candleEnd: s.t,
          side: s.side,
        } as V10Turn;
        for (const p of pickAlts(turn, btcMap, closes, npicks))
          if (moveOf({ kind: "BTC", side: s.side, turn: s }, p) > minMove)
            cands.push({
              t: s.t,
              sym: p.symbol,
              src: "A",
              side: s.side,
              entry: p.price,
              rank: p.rank,
              ext: extremeOf(
                coins.get(p.symbol)!.bars,
                s.startT,
                s.t,
                s.side === "SHORT",
              ),
            });
      }
      for (const [sym, c] of coins) {
        if (!c.old && !withNew) continue;
        for (const s of signalsOf(altC.get(sym)!, win, rule).filter(
          (x) => x.side === side,
        )) {
          if (h1 && !inH1Growth(altH1.get(sym)!, s.t, s.side)) continue;
          if (
            !postTopOk(altC.get(sym)!, s.extremeT, s.t) ||
            !zoneOk(altC.get(sym)!, s.extremeT, s.t)
          )
            continue;
          if (
            !ownMove(
              { moveStartT: s.startT, candleEnd: s.t } as V10Turn,
              c.map,
              btcMap,
              own,
            )
          )
            continue;
          if (
            moveOf({ kind: "OWN", side: s.side, turn: s }, { coinPct: NaN }) >
            minMove
          )
            cands.push({
              t: s.t,
              sym,
              src: "B",
              side: s.side,
              entry: s.price,
              rank: 0,
              ext: s.extreme,
            });
        }
      }
      cands.sort((a, b) => a.t - b.t || (a.src === "A" ? -1 : 1));
      const busy = new Map<string, number>(),
        done: Done[] = [];
      for (const c of cands) {
        if ((busy.get(c.sym) ?? 0) > c.t) continue;
        const sl = slExt
          ? c.ext
          : c.side === "SHORT"
            ? c.entry * (1 + pct / 100)
            : c.entry * (1 - pct / 100);
        const risk = (100 * Math.abs(sl - c.entry)) / c.entry;
        if (!(risk > 0) || (c.side === "SHORT" ? sl <= c.entry : sl >= c.entry))
          continue; // the extreme must be beyond the entry
        const tr = simTrade(
          coins.get(c.sym)!.bars,
          c.t,
          c.entry,
          sl,
          slExt ? rrExt : tpPct / pct,
          c.side === "SHORT" ? "DOWN" : "UP",
        );
        busy.set(c.sym, tr.exitT);
        done.push({ ...c, tr, risk, net: tr.r - (2 * fee) / risk });
      }
      const line = (part: string, l: Done[]): string => {
        const tp = l.filter((d) => d.tr.exit === "TP").length,
          sl = l.filter((d) => d.tr.exit === "SL").length,
          op = l.length - tp - sl;
        const n = l.reduce((a, d) => a + d.net, 0);
        const hrs = l
          .filter((d) => d.tr.exit !== "OPEN")
          .map((d) => (d.tr.exitT - d.t) / 3_600_000)
          .sort((a, b) => a - b);
        const rs = l.map((d) => d.risk).sort((a, b) => a - b);
        const riskTxt =
          slExt && rs.length
            ? ` · SL median ${rs[Math.floor(rs.length / 2)].toFixed(2)}% (${rs[0].toFixed(2)}–${rs[rs.length - 1].toFixed(2)})`
            : "";
        return `${name.padEnd(24)} ${part.padEnd(10)} ${String(l.length).padStart(6)} ${String(tp).padStart(4)} ${String(sl).padStart(4)} ${String(op).padStart(4)} ${(tp + sl ? Math.round((100 * tp) / (tp + sl)) : 0).toString().padStart(3)}% ${sp(n).padStart(7)} ${("$" + (n * 10).toFixed(0)).padStart(6)} ${hrs.length ? hrs[Math.floor(hrs.length / 2)].toFixed(1) + "h" : "-"}${riskTxt}`;
      };
      console.log(`${name.padEnd(24)} BTC signals: ${btcSigs.length}`);
      console.log(
        line(
          "A (BTC)",
          done.filter((d) => d.src === "A"),
        ),
      );
      console.log(
        line(
          "B (ALT)",
          done.filter((d) => d.src === "B"),
        ),
      );
      console.log(
        line(
          `B w/o ${without.join(",")}`,
          done.filter((d) => d.src === "B" && !without.includes(short(d.sym))),
        ),
      );
      console.log(line("ALL", done));
      if (byCoin)
        for (const src of ["A", "B"] as const) {
          const l = done.filter((d) => d.src === src);
          for (const sym of [...new Set(l.map((d) => d.sym))].sort(
            (a, b) =>
              l.filter((d) => d.sym === a).reduce((x, d) => x + d.net, 0) -
              l.filter((d) => d.sym === b).reduce((x, d) => x + d.net, 0),
          ))
            console.log(
              line(
                ` ${src} ${short(sym)}${coins.get(sym)!.old ? "" : "*"}`,
                l.filter((d) => d.sym === sym),
              ),
            );
        }
      if (arg("list", "") === name)
        for (const d of done)
          console.log(
            `     ${utc(d.t)} ${d.src} ${short(d.sym).padEnd(5)} ${d.src === "A" ? `#${d.rank}` : "  "} entry ${+d.entry.toPrecision(6)} -> ${d.tr.exit.padEnd(4)} ${utc(d.tr.exitT)} net ${sp(d.net)}`,
          );
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
