/**
 * THE BEST BTC TURNS -> WHICH COIN? (Johnny, Oct 2 2026) Read-only, our DB (minute_bars). See src/research/dc15.ts.
 * BTC turns: DC on 15m candles + the OI rule. Signals = RANK 1: the move's |OI change| is bigger than every move of the window (12h / 24h / 48h) before it.
 * For each signal, over the BTC move that just ended (its start -> its extreme): every coin's move, x BTC and follow
 * (R2 of 1-minute moves on BTC's). Picks = the coins that followed BTC most (upper half by follow) ranked by x BTC.
 * Then from the signal (candle close), in the signal's direction: 1h, 2h, best / worst within 2h. No TP / SL.
 *
 * Oct 2, after the filter test (Johnny agreed):
 *   x FIX    x = the coin's move to its EXTREME in the window / BTC's move to its extreme (a candle close that came back
 *            made x = 133 on 09-26)
 *   KEPT     direction: SHORT (after a BTC top) / LONG (after a BTC bottom). Dropped: the BTC price rank and the coin's
 *            own OI -- they did not hold on all 146 turns.
 *   STABLE?  RANK 1 with a 12h, 24h and 48h window: if RANK 1 + SHORT is good in all three, the rule is not luck.
 *
 *   npx tsx src/tools/dc15-coins.ts
 *   options: --from 2026-09-22  --quiet (summary only)
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
const WINDOWS = [12, 24, 48];
const EXAMPLE = Date.parse("2026-09-30T13:30:00Z");

interface Res {
  at: number[];
  best: number;
  worst: number;
}
interface Sig {
  turn: Turn;
  short: boolean;
  btcUp: number;
  btc: Res;
}
interface Rec {
  sig: Sig;
  sym: string;
  x: number;
  follow: number;
  pick: number;
  follower: boolean;
  r: Res;
}

function line(name: string, list: Res[]): string {
  const col = (i: number): string => {
    const v = list.map((o) => o.at[i]).filter(Number.isFinite);
    return `${sp(v.reduce((a, b) => a + b, 0) / (v.length || 1)).padStart(7)} (right ${v.filter((x) => x > 0).length}/${v.length})`;
  };
  const b = list.map((o) => o.best).filter(Number.isFinite),
    w = list.map((o) => o.worst).filter(Number.isFinite);
  return `   ${name.padEnd(30)} ${String(list.length).padStart(4)} · 1h ${col(0)} · 2h ${col(1)} · best ${sp(b.reduce((a, x) => a + x, 0) / (b.length || 1))} · worst ${sp(w.reduce((a, x) => a + x, 0) / (w.length || 1))}`;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const from = arg("from", "");
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
      "picks = coins that followed BTC most in the move (upper half by follow), ranked by x BTC",
    );
    console.log(
      "x = the coin's move to its extreme in the window / BTC's move to its extreme · after = from the signal, in its direction (+ = right)\n",
    );

    // one signal -> BTC result + every coin with x / follow / picks (cached: the same turn is in several windows)
    const cache = new Map<number, { sig: Sig; recs: Rec[] }>();
    const study = (t: Turn): { sig: Sig; recs: Rec[] } => {
      const hit = cache.get(t.t);
      if (hit) return hit;
      const fromT = t.moveStartT,
        toT = t.extremeT + W15,
        up = t.newDir === "DOWN"; // a SHORT ends an UP move
      const btcW = coinInWindow(btcMap, btcMap, fromT, toT, up);
      const sig: Sig = {
        turn: t,
        short: up,
        btcUp: btcW.pct,
        btc: outcome(btc, t.t, t.price, t.newDir, [1, 2], 2),
      };
      const rows: Rec[] = [];
      for (const [sym, c] of coins) {
        const w = coinInWindow(c.map, btcMap, fromT, toT, up);
        const p = priceAt(c.map, t.t);
        if (
          !Number.isFinite(w.x) ||
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
          r: outcome(c.bars, t.t, p, t.newDir, [1, 2], 2),
        });
      }
      if (rows.length) {
        const med = [...rows].map((r) => r.follow).sort((a, b) => a - b)[
          Math.floor(rows.length / 2)
        ];
        rows
          .filter((r) => r.follow >= med)
          .sort((a, b) => b.x - a.x)
          .forEach((r, i) => {
            r.follower = true;
            r.pick = i < 3 ? i + 1 : 0;
          });
      }
      const out = { sig, recs: rows };
      cache.set(t.t, out);
      return out;
    };

    const table: string[] = [];
    for (const win of WINDOWS) {
      const sigTurns = pastRank(all, win)
        .filter((r) => r.rank === 1 && r.prior > 0)
        .map((r) => r.turn);
      const res = sigTurns.map(study);
      console.log(
        `================ RANK 1 · window ${win}h (biggest move OI of the ${win}h before): ${res.length} signals`,
      );
      if (!argv.includes("--quiet") && win === 24)
        for (const { sig: g, recs } of res) {
          const t = g.turn;
          console.log(
            `${utc(t.t)} ${g.short ? "▼ SHORT" : "▲ LONG "} · BTC move ${utc(t.moveStartT)} -> ${utc(t.extremeT + W15)} ${sp(g.btcUp)} · move OI ${sp(t.moveOiPct)} · candle ${t.label} (${t.candleLiq})`,
          );
          console.log(
            `   BTC                      | 1h ${sp(g.btc.at[0]).padStart(7)}  2h ${sp(g.btc.at[1]).padStart(7)} | best ${sp(g.btc.best).padStart(7)} worst ${sp(g.btc.worst).padStart(7)}`,
          );
          for (const r of recs
            .filter((x) => x.pick > 0)
            .sort((a, b) => a.pick - b.pick))
            console.log(
              `   #${r.pick} ${r.sym.padEnd(6)} x ${r.x.toFixed(2).padStart(5)} f ${r.follow.toFixed(2)} | 1h ${sp(r.r.at[0]).padStart(7)}  2h ${sp(r.r.at[1]).padStart(7)} | best ${sp(r.r.best).padStart(7)} worst ${sp(r.r.worst).padStart(7)}`,
            );
        }
      const picks = res.flatMap((s) => s.recs.filter((r) => r.pick > 0)),
        fol = res.flatMap((s) => s.recs.filter((r) => r.follower));
      console.log(`SUMMARY window ${win}h`);
      console.log(
        line(
          "BTC",
          res.map((s) => s.sig.btc),
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
      for (const sh of [true, false]) {
        const tag = sh ? "SHORT" : "LONG ";
        const b = res.filter((s) => s.sig.short === sh).map((s) => s.sig.btc),
          p = picks.filter((r) => r.sig.short === sh).map((r) => r.r);
        console.log(line(`${tag} · BTC`, b));
        console.log(line(`${tag} · picks 1-3`, p));
        console.log(
          line(
            `${tag} · followers`,
            fol.filter((r) => r.sig.short === sh).map((r) => r.r),
          ),
        );
        table.push(
          line(`${win}h ${tag} · BTC`, b),
          line(`${win}h ${tag} · picks 1-3`, p),
        );
      }
      console.log(
        `   the 09-30 example (13:30 UTC): ${sigTurns.some((t) => t.t === EXAMPLE) ? "IN" : "NOT in"} RANK 1 with ${win}h\n`,
      );
    }
    console.log("STABILITY · RANK 1 + direction, by window");
    for (const l of table) console.log(l);
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
