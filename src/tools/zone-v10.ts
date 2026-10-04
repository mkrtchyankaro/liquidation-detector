/**
 * OUR V10 RULES AT A 4h ZONE -- ONE COIN, ONE FIXED ZONE (Johnny + friend, Oct 4 2026). Read-only, our DB.
 * The signals are exactly ours (the same functions as the backtests / live), on the coin's own candles:
 *   SHORT  the live ALT rule (atr, no top-candle OI rule): a rise > the TP %, OI grew with it (RANK 1 in --window h),
 *          OI below its peak, the close 1 ATR below the top
 *   LONG   "flush": a fall > the TP %, OI FELL in it (that fall's OI decrease RANK 1 in --window h), then a candle with
 *          OI RISING that closes 1 ATR above the low
 *   both   moved on their own (BTC opposite or R2 < 0.5 on 1m, as live)
 * The zone (--lo .. --hi, constant): a LONG counts "at the zone" when its low came into the zone (low <= the top) and
 * the entry closed back at / above the zone's bottom; a SHORT "above the zone" when its top is over the zone.
 * Trades: SL --pct %, TP --tp % from the entry, minute by minute (same minute = SL), one trade at a time on the coin.
 *
 *   npx tsx src/tools/zone-v10.ts --symbol XRPUSDT --lo 1.4637 --hi 1.4859 --from 2026-09-26
 *   options: --tf 15,60  --pct 1  --tp 2  --window 12  --fee 0.05
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { candles, type MinBar } from "../research/dc15";
import { flushSignals } from "../research/atr-turn";
import { simTrade } from "../research/sltp";
import {
  moveOf,
  ownMove,
  signalsOf,
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
const ms = (s: string): number =>
  Date.parse(s.length <= 10 ? `${s}T00:00:00Z` : `${s.replace(" ", "T")}:00Z`);
const sp = (v: number): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "n/a";

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const sym = arg("symbol", "XRPUSDT").toUpperCase(),
    lo = Number(arg("lo", "NaN")),
    hi = Number(arg("hi", "NaN")),
    from = ms(arg("from", "2026-09-26"));
  const pct = Number(arg("pct", "1")),
    tpPct = Number(arg("tp", "2")),
    win = Number(arg("window", "12")),
    fee = Number(arg("fee", "0.05"));
  if (!(lo > 0) || !(hi > lo))
    throw new Error("use --lo <zone bottom> --hi <zone top>");
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
    const bars = await load(sym),
      btc = await load("BTCUSDT");
    if (!bars.length) throw new Error(`no minute bars for ${sym}`);
    const map = new Map(bars.map((b) => [b.t, b.close])),
      btcMap = new Map(btc.map((b) => [b.t, b.close]));
    console.log(
      `${sym} · zone ${lo} – ${hi} · signals from ${utc(from)} to ${utc(bars[bars.length - 1].t)} UTC (history since ${utc(bars[0].t)} for the RANK) · SL ${pct}% · TP ${tpPct}% · RANK 1 ${win}h · fee ${fee}%/side`,
    );
    console.log(
      `LONG = flush (fall > ${tpPct}% with OI down RANK 1, then OI up + 1 ATR) · SHORT = the live ALT rule (rise > ${tpPct}% with OI up RANK 1, close 1 ATR off the top) · both moved on their own\n`,
    );

    for (const tf of arg("tf", "15,60").split(",").map(Number)) {
      const c = candles(bars, tf);
      interface S {
        t: number;
        side: "LONG" | "SHORT";
        price: number;
        ext: number;
        move: number;
        oi: number;
        prior: number;
        zone: boolean;
      }
      const sigs: S[] = [];
      const own = (startT: number, t: number): boolean =>
        !!ownMove(
          { moveStartT: startT, candleEnd: t } as V10Turn,
          map,
          btcMap,
          1,
        );
      for (const g of signalsOf(c, win, { entry: "atr", topCandleOi: false }))
        if (
          g.side === "SHORT" &&
          g.t >= from &&
          own(g.startT, g.t) &&
          moveOf({ kind: "OWN", side: "SHORT", turn: g }, { coinPct: NaN }) >
            tpPct
        )
          sigs.push({
            t: g.t,
            side: "SHORT",
            price: g.price,
            ext: g.extreme,
            move: g.movePct,
            oi: g.buildOiPct,
            prior: g.prior,
            zone: g.extreme > hi,
          });
      for (const g of flushSignals(c, V10_K, V10_ATR_N, win, {
        rank: true,
        side: "LONG",
      }))
        if (
          g.t >= from &&
          own(g.startT, g.t) &&
          moveOf({ kind: "OWN", side: "LONG", turn: g }, { coinPct: NaN }) >
            tpPct
        )
          sigs.push({
            t: g.t,
            side: "LONG",
            price: g.price,
            ext: g.extreme,
            move: g.movePct,
            oi: g.buildOiPct,
            prior: g.prior,
            zone: g.extreme <= hi && g.price >= lo,
          });
      sigs.sort((a, b) => a.t - b.t);

      const trade = (
        keep: (s: S) => boolean,
      ): Array<S & { exit: string; exitT: number; net: number }> => {
        let busy = 0;
        const out: Array<S & { exit: string; exitT: number; net: number }> = [];
        for (const s of sigs.filter(keep)) {
          if (busy > s.t) continue;
          const sl =
            s.side === "SHORT"
              ? s.price * (1 + pct / 100)
              : s.price * (1 - pct / 100);
          const tr = simTrade(
            bars,
            s.t,
            s.price,
            sl,
            tpPct / pct,
            s.side === "SHORT" ? "DOWN" : "UP",
          );
          busy = tr.exitT;
          out.push({
            ...s,
            exit: tr.exit,
            exitT: tr.exitT,
            net: tr.r - (2 * fee) / pct,
          });
        }
        return out;
      };
      const line = (
        name: string,
        l: Array<{ exit: string; net: number }>,
      ): string => {
        const tp = l.filter((x) => x.exit === "TP").length,
          slN = l.filter((x) => x.exit === "SL").length;
        return `  ${name.padEnd(30)} ${String(l.length).padStart(2)} trades · TP ${tp} · SL ${slN} · open ${l.length - tp - slN} · net ${sp(l.reduce((s, x) => s + x.net, 0))}R`;
      };
      const all = trade(() => true);
      console.log(
        `── ${tf}m candles: ${sigs.length} signals (LONG ${sigs.filter((s) => s.side === "LONG").length}, SHORT ${sigs.filter((s) => s.side === "SHORT").length}) ──`,
      );
      for (const s of sigs) {
        const d = all.find((x) => x.t === s.t && x.side === s.side);
        console.log(
          `  ${utc(s.t)} ${s.side.padEnd(5)} at ${+s.price.toPrecision(6)} · ${s.side === "LONG" ? "low" : "top"} ${+s.ext.toPrecision(6)} · move ${sp(s.move)}% · OI ${sp(s.oi)}% (RANK 1 of ${s.prior}) · ${s.side === "LONG" ? (s.zone ? "AT THE ZONE" : "not at the zone") : s.zone ? "above the zone" : "not above the zone"} · ${d ? `${d.exit} ${sp(d.net)}R (${utc(d.exitT)})` : "skipped (a trade was open)"}`,
        );
      }
      console.log(line("all signals", all));
      console.log(
        line(
          "LONG all",
          trade((s) => s.side === "LONG"),
        ),
      );
      console.log(
        line(
          "LONG at the zone",
          trade((s) => s.side === "LONG" && s.zone),
        ),
      );
      console.log(
        line(
          "SHORT all",
          trade((s) => s.side === "SHORT"),
        ),
      );
      console.log(
        line(
          "SHORT above the zone",
          trade((s) => s.side === "SHORT" && s.zone),
        ),
      );
      console.log(
        line(
          "zone plan (LONG at + SHORT above)",
          trade((s) => s.zone),
        ),
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
