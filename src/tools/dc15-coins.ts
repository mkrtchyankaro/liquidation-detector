/**
 * THE BEST BTC TURNS -> WHICH COIN? + FILTERS (Johnny, Oct 2 2026) Read-only, our DB (minute_bars). See src/research/dc15.ts.
 * BTC turns: DC on 15m candles + the OI rule. Signals = RANK 1: the move's |OI change| is bigger than every move of the 24h before it.
 * For each signal, over the BTC move that just ended (its start -> its extreme): every coin's move, x BTC and follow
 * (R2 of 1-minute moves on BTC's). Picks = the coins that followed BTC most (upper half by follow) ranked by x BTC.
 * Then from the signal (candle close), in the signal's direction: 1h, 2h, best / worst within 2h. No TP / SL.
 *
 * FILTERS (Johnny agreed, Oct 2) -- no fixed numbers, all known at the signal:
 *   1  BTC price: the move's |price %| compared with the moves of the 24h before it (same ranking as the OI)
 *   2  direction: SHORT (after a BTC top) / LONG (after a BTC bottom)
 *   3  the coin's own OI: in the move (fuel: new positions that can be liquidated) and in the reversal candle
 * The same split is also run on ALL accepted turns (summary only) -- more signals, to see if a filter holds in general.
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
  oiChange,
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
interface Sig {
  turn: Turn;
  short: boolean;
  pRank: number;
  pShare: number;
  btc: Res;
}
interface Rec {
  sig: Sig;
  sym: string;
  x: number;
  follow: number;
  pick: number;
  follower: boolean;
  oiMove: number;
  oiCandle: number;
  r: Res;
}

function line(name: string, list: Res[]): string {
  const col = (i: number): string => {
    const v = list.map((o) => o.at[i]).filter(Number.isFinite);
    return `${sp(v.reduce((a, b) => a + b, 0) / (v.length || 1)).padStart(7)} (right ${v.filter((x) => x > 0).length}/${v.length})`;
  };
  const b = list.map((o) => o.best).filter(Number.isFinite),
    w = list.map((o) => o.worst).filter(Number.isFinite);
  return `   ${name.padEnd(44)} ${String(list.length).padStart(4)} · 1h ${col(0)} · 2h ${col(1)} · best ${sp(b.reduce((a, x) => a + x, 0) / (b.length || 1))} · worst ${sp(w.reduce((a, x) => a + x, 0) / (w.length || 1))}`;
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
    const byOi = pastRank(all, win),
      byPrice = pastRank(all, win, (t) => t.movePct);
    const priceOf = new Map(byPrice.map((r) => [r.turn.t, r]));
    const rank1 = new Set(
      byOi.filter((r) => r.rank === 1 && r.prior > 0).map((r) => r.turn.t),
    );

    const symbols = (process.env.SYMBOLS ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s && s !== "BTCUSDT");
    const coins = new Map<
      string,
      { bars: MinBar[]; map: Map<number, number>; oi: Map<number, number> }
    >();
    for (const s of symbols) {
      const bars = await load(s);
      if (bars.length)
        coins.set(s, {
          bars,
          map: new Map(bars.map((b) => [b.t, b.close])),
          oi: new Map(bars.map((b) => [b.t, b.oiLast])),
        });
    }
    console.log(
      `BTC turns (15m DC + OI rule) · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC · coins with data: ${coins.size}`,
    );
    console.log(
      "picks = coins that followed BTC most in the move (upper half by follow), ranked by x BTC · after = from the signal, in its direction (+ = right)",
    );
    console.log(
      "price rank = the BTC move's |price %| vs the moves of the 24h before it (1 = biggest) · coin OI: in the move / in the reversal candle\n",
    );

    const study = (sigTurns: Turn[]): { sigs: Sig[]; recs: Rec[] } => {
      const sigs: Sig[] = [],
        recs: Rec[] = [];
      for (const t of sigTurns) {
        const pr = priceOf.get(t.t);
        const sig: Sig = {
          turn: t,
          short: t.newDir === "DOWN",
          pRank: pr?.rank ?? NaN,
          pShare: pr?.share ?? NaN,
          btc: outcome(btc, t.t, t.price, t.newDir, [1, 2], 2),
        };
        sigs.push(sig);
        const fromT = t.moveStartT,
          toT = t.extremeT + W15;
        const rows: Rec[] = [];
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
            sig,
            sym: sym.replace(/USDT$/, ""),
            x: w.x,
            follow: w.follow,
            pick: 0,
            follower: false,
            oiMove: oiChange(c.oi, fromT, toT),
            oiCandle: oiChange(c.oi, t.t - W15, t.t),
            r: outcome(c.bars, t.t, p, t.newDir, [1, 2], 2),
          });
        }
        if (rows.length) {
          const med = [...rows].map((r) => r.follow).sort((a, b) => a - b)[
            Math.floor(rows.length / 2)
          ];
          const followers = rows
            .filter((r) => r.follow >= med)
            .sort((a, b) => b.x - a.x);
          followers.forEach((r, i) => {
            r.follower = true;
            r.pick = i < 3 ? i + 1 : 0;
          });
        }
        recs.push(...rows);
      }
      return { sigs, recs };
    };
    const summary = (name: string, s: { sigs: Sig[]; recs: Rec[] }): void => {
      const picks = s.recs.filter((r) => r.pick > 0),
        fol = s.recs.filter((r) => r.follower);
      const big = (g: Sig): string =>
        g.pRank === 1
          ? "biggest"
          : g.pShare > 0.5
            ? "bigger than most"
            : "smaller than most";
      console.log(`SUMMARY ${name} (averages in the signal's direction)`);
      console.log(
        line(
          "BTC",
          s.sigs.map((g) => g.btc),
        ),
      );
      console.log(
        line(
          "picks 1-3",
          picks.map((r) => r.r),
        ),
      );
      console.log(
        line(
          "all followers",
          fol.map((r) => r.r),
        ),
      );
      console.log("  FILTER 2 · direction");
      for (const sh of [true, false]) {
        const tag = sh ? "SHORT (after a top)" : "LONG (after a bottom)";
        console.log(
          line(
            `${tag} · BTC`,
            s.sigs.filter((g) => g.short === sh).map((g) => g.btc),
          ),
        );
        console.log(
          line(
            `${tag} · picks 1-3`,
            picks.filter((r) => r.sig.short === sh).map((r) => r.r),
          ),
        );
      }
      console.log("  FILTER 1 · BTC price move vs the 24h before");
      for (const k of ["biggest", "bigger than most", "smaller than most"]) {
        console.log(
          line(
            `${k} · BTC`,
            s.sigs.filter((g) => big(g) === k).map((g) => g.btc),
          ),
        );
        console.log(
          line(
            `${k} · picks 1-3`,
            picks.filter((r) => big(r.sig) === k).map((r) => r.r),
          ),
        );
      }
      console.log("  FILTER 3 · the coin's own OI (picks 1-3 / all followers)");
      for (const [lab, f] of [
        ["OI UP in the move", (r: Rec) => r.oiMove > 0],
        ["OI DOWN in the move", (r: Rec) => r.oiMove <= 0],
        ["OI UP in the reversal candle", (r: Rec) => r.oiCandle > 0],
        ["OI DOWN in the reversal candle", (r: Rec) => r.oiCandle <= 0],
      ] as Array<[string, (r: Rec) => boolean]>) {
        console.log(
          line(
            `${lab} · picks`,
            picks
              .filter((r) => Number.isFinite(r.oiMove) && f(r))
              .map((r) => r.r),
          ),
        );
        console.log(
          line(
            `${lab} · followers`,
            fol
              .filter((r) => Number.isFinite(r.oiMove) && f(r))
              .map((r) => r.r),
          ),
        );
      }
      console.log("  FILTER 2 + 3 · SHORT, followers");
      for (const [lab, f] of [
        ["SHORT · coin OI UP in the move", (r: Rec) => r.oiMove > 0],
        ["SHORT · coin OI DOWN in the move", (r: Rec) => r.oiMove <= 0],
        ["SHORT · coin OI UP in the candle", (r: Rec) => r.oiCandle > 0],
        ["SHORT · coin OI DOWN in the candle", (r: Rec) => r.oiCandle <= 0],
      ] as Array<[string, (r: Rec) => boolean]>)
        console.log(
          line(
            lab,
            fol
              .filter((r) => r.sig.short && Number.isFinite(r.oiMove) && f(r))
              .map((r) => r.r),
          ),
        );
      console.log("");
    };

    // RANK 1, signal by signal
    const r1 = study(all.filter((t) => rank1.has(t.t)));
    console.log(
      `================ RANK 1 (biggest move OI of the last 24h): ${r1.sigs.length} signals`,
    );
    if (!argv.includes("--quiet"))
      for (const g of r1.sigs) {
        const t = g.turn;
        console.log(
          `${utc(t.t)} ${g.short ? "▼ SHORT" : "▲ LONG "} · BTC move ${utc(t.moveStartT)} -> ${utc(t.extremeT + W15)} ${sp(t.movePct)} (price rank ${g.pRank}) · move OI ${sp(t.moveOiPct)} · candle ${t.label} (${t.candleLiq})`,
        );
        console.log(
          `   BTC                                      | 1h ${sp(g.btc.at[0]).padStart(7)}  2h ${sp(g.btc.at[1]).padStart(7)} | best ${sp(g.btc.best).padStart(7)} worst ${sp(g.btc.worst).padStart(7)}`,
        );
        for (const r of r1.recs
          .filter((x) => x.sig === g && x.pick > 0)
          .sort((a, b) => a.pick - b.pick))
          console.log(
            `   #${r.pick} ${r.sym.padEnd(6)} x ${r.x.toFixed(2).padStart(6)} · OI move ${sp(r.oiMove).padStart(7)} candle ${sp(r.oiCandle).padStart(7)} | 1h ${sp(r.r.at[0]).padStart(7)}  2h ${sp(r.r.at[1]).padStart(7)} | best ${sp(r.r.best).padStart(7)} worst ${sp(r.r.worst).padStart(7)}`,
          );
      }
    console.log("");
    summary("RANK 1", r1);
    summary(
      `ALL accepted turns (${all.filter((t) => t.accepted).length}) -- does a filter hold in general?`,
      study(all.filter((t) => t.accepted)),
    );
    const ex = Date.parse("2026-09-30T13:30:00Z"),
      exS = r1.sigs.find((g) => g.turn.t === ex);
    console.log(
      `the 09-30 example (signal 13:30 UTC): RANK 1 ${exS ? "YES" : "no"}${
        exS
          ? ` · price rank ${exS.pRank} · picks OI in the move: ${r1.recs
              .filter((r) => r.sig === exS && r.pick > 0)
              .map((r) => `${r.sym} ${sp(r.oiMove)}`)
              .join(", ")}`
          : ""
      }`,
    );
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
