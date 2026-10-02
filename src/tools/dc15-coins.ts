/**
 * THE BEST BTC TURNS -> WHICH COIN? (Johnny, Oct 2 2026) Read-only, our DB (minute_bars). See src/research/dc15.ts.
 * BTC turns: DC on 15m candles + the OI rule. Two frozen sets of signals:
 *   RANK 1   the move's |OI change| is bigger than every move of the 24h before it
 *   WINNERS  in the reversal candle the "winners'" side was liquidated more (shorts at a top / longs at a bottom)
 * For each signal, over the BTC move that just ended (its start -> its extreme): every coin's move, x BTC and follow
 * (R2 of 1-minute moves on BTC's). Picks = the coins that followed BTC most (upper half by follow) ranked by x BTC.
 * Then from the signal (candle close), in the signal's direction: 1h, 2h, best / worst within 2h. No TP / SL.
 *
 *   npx tsx src/tools/dc15-coins.ts
 *   options: --from 2026-09-22  --window 24  --quiet (summary only)
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import {
  candles,
  coinInWindow,
  outcome,
  pastRank,
  priceAt,
  turns,
  type MinBar,
  type Turn,
} from "../research/dc15";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "   n/a";
const W15 = 15 * 60_000;

interface Res {
  at: number[];
  best: number;
  worst: number;
}
interface Row {
  sym: string;
  x: number;
  follow: number;
  pct: number;
  r: Res;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const from = arg("from", ""),
    win = Number(arg("window", "24"));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const load = async (symbol: string): Promise<MinBar[]> => {
      const q: Record<string, unknown> = { symbol, high: { $ne: null } };
      if (from) q.ts = { $gte: new Date(`${from}T00:00:00Z`) };
      return (
        await db
          .collection(MINUTE_BARS)
          .find(q)
          .project({
            ts: 1,
            high: 1,
            low: 1,
            close: 1,
            oiFirst: 1,
            oiLast: 1,
            longLiqUsd: 1,
            shortLiqUsd: 1,
          })
          .sort({ ts: 1 })
          .toArray()
      ).map((d) => ({
        t: (d.ts as Date).getTime(),
        high: Number(d.high),
        low: Number(d.low),
        close: Number(d.close),
        oiFirst: Number(d.oiFirst),
        oiLast: Number(d.oiLast),
        longLiq: Number(d.longLiqUsd ?? 0),
        shortLiq: Number(d.shortLiqUsd ?? 0),
      }));
    };
    const btc = await load("BTCUSDT");
    if (!btc.length) throw new Error("no BTC data");
    const btcMap = new Map(btc.map((b) => [b.t, b.close]));
    const all = turns(candles(btc, 15), 1, 14, true);
    const ranked = pastRank(all, win);
    const rank1 = ranked
      .filter((r) => r.rank === 1 && r.prior > 0)
      .map((r) => r.turn);
    const winners = all.filter((t) => t.accepted && t.candleLiq === "WINNERS");

    const symbols = (process.env.SYMBOLS ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s && s !== "BTCUSDT");
    const coins = new Map<
      string,
      { bars: MinBar[]; map: Map<number, number> }
    >();
    for (const s of symbols) {
      const bars = await load(s);
      if (bars.length)
        coins.set(s, { bars, map: new Map(bars.map((b) => [b.t, b.close])) });
    }
    console.log(
      `BTC turns (15m DC + OI rule) · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC · coins with data: ${coins.size}`,
    );
    console.log(
      "picks = coins that followed BTC most in the move (upper half by follow), ranked by x BTC · after = from the signal, in its direction (+ = right)\n",
    );

    const study = (name: string, sigs: Turn[]): void => {
      console.log(`================ ${name}: ${sigs.length} signals`);
      const agg: Record<string, Res[]> = {
        BTC: [],
        "pick #1": [],
        "pick #2": [],
        "pick #3": [],
        "picks 1-3": [],
        "all followers": [],
        "all coins": [],
      };
      for (const t of sigs) {
        const fromT = t.moveStartT,
          toT = t.extremeT + W15;
        const rows: Row[] = [];
        for (const [sym, c] of coins) {
          const w = coinInWindow(c.map, btcMap, fromT, toT);
          const p = priceAt(c.map, t.t);
          if (
            !Number.isFinite(w.pct) ||
            !Number.isFinite(w.follow) ||
            !Number.isFinite(p)
          )
            continue;
          rows.push({
            sym: sym.replace(/USDT$/, ""),
            x: w.x,
            follow: w.follow,
            pct: w.pct,
            r: outcome(c.bars, t.t, p, t.newDir, [1, 2], 2),
          });
        }
        const btcR = outcome(btc, t.t, t.price, t.newDir, [1, 2], 2);
        agg["BTC"].push(btcR);
        if (!rows.length) continue;
        const med = [...rows].map((r) => r.follow).sort((a, b) => a - b)[
          Math.floor(rows.length / 2)
        ];
        const followers = rows
          .filter((r) => r.follow >= med)
          .sort((a, b) => b.x - a.x);
        followers.slice(0, 3).forEach((r, i) => {
          agg[`pick #${i + 1}`].push(r.r);
          agg["picks 1-3"].push(r.r);
        });
        followers.forEach((r) => agg["all followers"].push(r.r));
        rows.forEach((r) => agg["all coins"].push(r.r));
        if (!argv.includes("--quiet")) {
          const btcPct =
            100 * (priceAt(btcMap, toT) / priceAt(btcMap, fromT) - 1);
          console.log(
            `${utc(t.t)} ${t.newDir === "UP" ? "▲ UP  " : "▼ DOWN"} · BTC move ${utc(fromT)} -> ${utc(toT)} ${sp(btcPct)} · move OI ${sp(t.moveOiPct)} · candle ${t.label} (${t.candleLiq})`,
          );
          console.log(
            `   BTC                      | 1h ${sp(btcR.at[0]).padStart(7)}  2h ${sp(btcR.at[1]).padStart(7)} | best ${sp(btcR.best).padStart(7)} worst ${sp(btcR.worst).padStart(7)}`,
          );
          for (const [i, r] of followers.slice(0, 3).entries())
            console.log(
              `   #${i + 1} ${r.sym.padEnd(6)} x ${r.x.toFixed(2).padStart(5)} f ${r.follow.toFixed(2)} | 1h ${sp(r.r.at[0]).padStart(7)}  2h ${sp(r.r.at[1]).padStart(7)} | best ${sp(r.r.best).padStart(7)} worst ${sp(r.r.worst).padStart(7)}`,
            );
        }
      }
      console.log(`\nSUMMARY ${name} (averages in the signal's direction)`);
      for (const [k, list] of Object.entries(agg)) {
        const col = (i: number): string => {
          const v = list.map((o) => o.at[i]).filter(Number.isFinite);
          return `${sp(v.reduce((a, b) => a + b, 0) / (v.length || 1)).padStart(7)} (right ${v.filter((x) => x > 0).length}/${v.length})`;
        };
        const b = list.map((o) => o.best).filter(Number.isFinite),
          w = list.map((o) => o.worst).filter(Number.isFinite);
        console.log(
          `   ${k.padEnd(14)} ${String(list.length).padStart(4)} · 1h ${col(0)} · 2h ${col(1)} · best ${sp(b.reduce((a, x) => a + x, 0) / (b.length || 1))} · worst ${sp(w.reduce((a, x) => a + x, 0) / (w.length || 1))}`,
        );
      }
      console.log("");
    };
    study("RANK 1 (biggest move OI of the last 24h)", rank1);
    study("WINNERS (winners' side liquidated in the reversal candle)", winners);
    const ex = Date.parse("2026-09-30T13:30:00Z");
    console.log(
      `the 09-30 example (signal at 13:30 UTC, the 13:15 candle): RANK 1 ${rank1.some((t) => t.t === ex) ? "YES" : "no"} · WINNERS ${winners.some((t) => t.t === ex) ? "YES" : "no"} · accepted turn ${all.some((t) => t.t === ex && t.accepted) ? "YES" : "no"}`,
    );
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
