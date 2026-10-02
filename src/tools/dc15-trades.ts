/**
 * THE WHOLE STRATEGY WITH SL / TP (Johnny, Oct 2 2026) Read-only, our DB (minute_bars). SHORT only for now
 * (the market was rising these days; the LONG mirror is kept for a falling market).
 *   A  BTC: 15m DC + OI rule, RANK 1 (12h) top -> SHORT the 3 alts that followed BTC most (upper half by R2, by x BTC)
 *   B  an alt's OWN 15m DC + OI rule, RANK 1 (12h) top, when the alt moved on its own (OWN / BTC OPPOSITE) -> SHORT it
 *      (B: only alts with full history)
 * Entry = the alt's price at the signal (the reversal candle's close).
 * SL = the alt's highest high of the move (A: inside BTC's move window, B: inside its own move), up to the signal.
 * TP = 2R / 2.2R / 2.5R. Same minute SL + TP -> SL. One trade per coin at a time (a new signal on a busy coin is skipped;
 * A and B on the same coin at the same time = one trade "A+B").
 * Prices are our minute bars (mark price from the 1/s polls). Fees: --fee (taker % per side, default 0.05) -> net R.
 *
 *   npx tsx src/tools/dc15-trades.ts
 *   options: --from 2026-09-22  --window 12  --fee 0.05  --list
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import {
  candles,
  coinInWindow,
  ownness,
  pastRank,
  priceAt,
  turns,
  type MinBar,
} from "../research/dc15";
import { extremeIn, simTrade, type Trade } from "../research/sltp";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number): string =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "n/a";
const W15 = 15 * 60_000,
  DAY = 86_400_000;
const RRS = [2, 2.2, 2.5];

interface Cand {
  t: number;
  sym: string;
  src: string;
  entry: number;
  sl: number;
  riskPct: number;
}
interface Done extends Cand {
  tr: Trade;
  net: number;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const from = arg("from", ""),
    win = Number(arg("window", "12")),
    fee = Number(arg("fee", "0.05"));
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
    };
    const btc = await load("BTCUSDT");
    if (!btc.length) throw new Error("no BTC data");
    const btcMap = new Map(btc.map((b) => [b.t, b.close]));
    const symbols = (process.env.SYMBOLS ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s && s !== "BTCUSDT");
    const coins = new Map<
      string,
      { bars: MinBar[]; map: Map<number, number>; old: boolean }
    >();
    for (const s of symbols) {
      const bars = await load(s);
      if (bars.length)
        coins.set(s.replace(/USDT$/, ""), {
          bars,
          map: new Map(bars.map((b) => [b.t, b.close])),
          old: bars[0].t <= btc[0].t + DAY,
        });
    }

    const cands: Cand[] = [];
    const add = (
      t: number,
      sym: string,
      src: string,
      entry: number,
      sl: number,
    ): void => {
      if (!(entry > 0) || !(sl > entry)) return; // price already above its own high: no room for a stop
      cands.push({
        t,
        sym,
        src,
        entry,
        sl,
        riskPct: (100 * (sl - entry)) / entry,
      });
    };
    // A: BTC tops
    const bt = turns(candles(btc, 15), 1, 14, true);
    for (const r of pastRank(bt, win).filter(
      (x) => x.rank === 1 && x.prior > 0 && x.turn.newDir === "DOWN",
    )) {
      const t = r.turn,
        fromT = t.moveStartT,
        toT = t.extremeT + W15;
      const rows: Array<{ sym: string; x: number; follow: number }> = [];
      for (const [sym, c] of coins) {
        const w = coinInWindow(c.map, btcMap, fromT, toT, true);
        if (
          Number.isFinite(w.x) &&
          Number.isFinite(w.follow) &&
          Number.isFinite(priceAt(c.map, t.t))
        )
          rows.push({ sym, x: w.x, follow: w.follow });
      }
      if (!rows.length) continue;
      const med = [...rows].map((x) => x.follow).sort((a, b) => a - b)[
        Math.floor(rows.length / 2)
      ];
      for (const p of rows
        .filter((x) => x.follow >= med)
        .sort((a, b) => b.x - a.x)
        .slice(0, 3)) {
        const c = coins.get(p.sym)!;
        add(
          t.t,
          p.sym,
          "A",
          priceAt(c.map, t.t),
          extremeIn(c.bars, fromT, t.t, "DOWN"),
        );
      }
    }
    // B: an alt's own tops
    for (const [sym, c] of coins) {
      if (!c.old) continue;
      const at = turns(candles(c.bars, 15), 1, 14, true);
      for (const r of pastRank(at, win).filter(
        (x) => x.rank === 1 && x.prior > 0 && x.turn.newDir === "DOWN",
      )) {
        const t = r.turn;
        const w = coinInWindow(c.map, btcMap, t.moveStartT, t.extremeT + W15);
        if (
          !Number.isFinite(w.follow) ||
          !Number.isFinite(w.pct) ||
          ownness(w.follow, w.pct, w.btcPct) === "WITH BTC"
        )
          continue;
        add(
          t.t,
          sym,
          "B",
          t.price,
          extremeIn(c.bars, t.moveStartT, t.t, "DOWN"),
        );
      }
    }
    // A and B on the same coin at the same time -> one trade
    cands.sort((a, b) => a.t - b.t || a.sym.localeCompare(b.sym));
    const merged: Cand[] = [];
    for (const c of cands) {
      const same = merged.find((m) => m.t === c.t && m.sym === c.sym);
      if (same) {
        if (!same.src.includes(c.src)) same.src = "A+B";
      } else merged.push({ ...c });
    }

    console.log(
      `SHORT strategy · A (BTC top -> its alts) + B (an alt's own top) · RANK 1 ${win}h · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`,
    );
    console.log(
      `SL = the alt's high of the move · fee ${fee}% per side -> net R = R - 2 x fee / risk% · same minute SL+TP = SL · one trade per coin at a time`,
    );
    const risks = merged.map((c) => c.riskPct).sort((a, b) => a - b);
    const q = (p: number): string =>
      risks.length ? risks[Math.floor(p * (risks.length - 1))].toFixed(2) : "-";
    console.log(
      `signals: ${merged.length} (A ${merged.filter((c) => c.src === "A").length}, B ${merged.filter((c) => c.src === "B").length}, A+B ${merged.filter((c) => c.src === "A+B").length}) · SL distance %: min ${q(0)} · quarter ${q(0.25)} · median ${q(0.5)} · 3 quarters ${q(0.75)} · max ${q(1)}\n`,
    );

    for (const rr of RRS) {
      const busy = new Map<string, number>(),
        done: Done[] = [];
      for (const c of merged) {
        if ((busy.get(c.sym) ?? 0) > c.t) continue;
        const bars = coins.get(c.sym)!.bars;
        const tr = simTrade(bars, c.t, c.entry, c.sl, rr, "DOWN");
        busy.set(c.sym, tr.exitT);
        done.push({ ...c, tr, net: tr.r - (2 * fee) / c.riskPct });
      }
      const line = (name: string, l: Done[]): string => {
        const tp = l.filter((d) => d.tr.exit === "TP").length,
          sl = l.filter((d) => d.tr.exit === "SL").length,
          op = l.length - tp - sl;
        const sumR = l.reduce((a, d) => a + d.tr.r, 0),
          sumN = l.reduce((a, d) => a + d.net, 0);
        const hrs = l
          .filter((d) => d.tr.exit !== "OPEN")
          .map((d) => (d.tr.exitT - d.t) / 3_600_000)
          .sort((a, b) => a - b);
        return `   ${name.padEnd(10)} ${String(l.length).padStart(3)} trades · TP ${String(tp).padStart(3)} · SL ${String(sl).padStart(3)} · open ${op} · win ${l.length ? Math.round((100 * tp) / Math.max(1, tp + sl)) : 0}% · R ${sp(sumR).padStart(7)} · net R ${sp(sumN).padStart(7)} ($${(sumN * 10).toFixed(0)} at $10 risk) · median hold ${hrs.length ? hrs[Math.floor(hrs.length / 2)].toFixed(1) : "-"}h`;
      };
      let streak = 0,
        worstStreak = 0;
      for (const d of done) {
        streak = d.tr.exit === "SL" ? streak + 1 : 0;
        worstStreak = Math.max(worstStreak, streak);
      }
      console.log(
        `================ TP ${rr}R · worst losing streak ${worstStreak}`,
      );
      console.log(line("ALL", done));
      for (const s of ["A", "B", "A+B"])
        console.log(
          line(
            s,
            done.filter((d) => d.src === s),
          ),
        );
      console.log("   by coin:");
      for (const sym of [...new Set(done.map((d) => d.sym))].sort())
        console.log(
          line(
            ` ${sym}`,
            done.filter((d) => d.sym === sym),
          ),
        );
      if (argv.includes("--list"))
        for (const d of done)
          console.log(
            `     ${utc(d.t)} ${d.src.padEnd(3)} ${d.sym.padEnd(5)} entry ${d.entry} SL ${d.sl} (${d.riskPct.toFixed(2)}%) -> ${d.tr.exit.padEnd(4)} ${utc(d.tr.exitT)} R ${sp(d.tr.r)} net ${sp(d.net)}`,
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
