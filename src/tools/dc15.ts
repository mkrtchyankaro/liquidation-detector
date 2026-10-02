/**
 * BTC TURNS on 15-minute candles + the OI rule (Johnny, Oct 2 2026). Read-only, our DB (minute_bars).
 * See src/research/dc15.ts. Two versions on the same data:
 *   PLAIN   a move ends when a candle closes k x ATR(15m) back from its extreme
 *   OI      + the reversal candle's OI must go the opposite way to how the move was built (else: not the end)
 * Every turn of the OI version is listed (accepted and REJECTED), then a summary of both: from the signal (the candle
 * close), the price in the new direction 1h / 2h / 4h later, the best and the worst inside 4h. For the rejected
 * candles: what the move did after them (did it really go on?).
 *
 *   npx tsx src/tools/dc15.ts
 *   options: --symbol BTCUSDT  --from 2026-09-22  --tf 15  --k 1  --n 14  --window 24 (hours)  --quiet (summary only)
 * BIG MOVES (Johnny, Oct 2): each accepted turn's |move OI| ranked against the accepted moves of the --window hours
 * BEFORE it (no threshold, live-safe): results by rank, "bigger than all of them", "bigger than most of them".
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import {
  candles,
  outcome,
  pastRank,
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
const H = [1, 2, 4];
const k$ = (v: number): string =>
  `$${v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : Math.round(v / 1e3) + "K"}`.padStart(
    6,
  );

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const symbol = arg("symbol", "BTCUSDT").toUpperCase(),
    tf = Number(arg("tf", "15")),
    k = Number(arg("k", "1")),
    n = Number(arg("n", "14"));
  const from = arg("from", "");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const q: Record<string, unknown> = {
      symbol,
      high: { $ne: null },
      oiFirst: { $ne: null },
    };
    if (from) q.ts = { $gte: new Date(`${from}T00:00:00Z`) };
    const docs = await db
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
      .toArray();
    const bars: MinBar[] = docs.map((d) => ({
      t: (d.ts as Date).getTime(),
      high: Number(d.high),
      low: Number(d.low),
      close: Number(d.close),
      oiFirst: Number(d.oiFirst),
      oiLast: Number(d.oiLast),
      longLiq: Number(d.longLiqUsd ?? 0),
      shortLiq: Number(d.shortLiqUsd ?? 0),
    }));
    if (!bars.length) throw new Error("no data");
    const c = candles(bars, tf);
    const plain = turns(c, k, n, false),
      withOi = turns(c, k, n, true);
    const res = (t: Turn) => outcome(bars, t.t, t.price, t.newDir, H, 4);
    console.log(
      `${symbol} · ${utc(bars[0].t)} -> ${utc(bars[bars.length - 1].t)} UTC · ${tf}m candles · a move ends when a candle closes ${k} x ATR(${n}) back`,
    );
    console.log(
      "OI rule: the reversal candle's OI must go the opposite way to the move's OI, else NOT THE END (the move goes on)",
    );
    console.log(
      "after = from the signal candle's close, in the NEW direction (+ = right): 1h / 2h / 4h, best / worst within 4h\n",
    );
    if (!argv.includes("--quiet")) {
      console.log(
        "signal (UTC)  new dir  price      extreme (time)            move OI   candle OI  label       candle liq (long/short, who)  move liq | 1h       2h       4h      | best    worst",
      );
      for (const t of withOi) {
        const o = res(t);
        console.log(
          `${utc(t.t)}   ${t.accepted ? (t.newDir === "UP" ? "▲ UP  " : "▼ DOWN") : "  (no) "}  ${t.price.toFixed(1).padStart(9)}  ${t.extreme.toFixed(1).padStart(9)} (${utc(t.extremeT)})  ${sp(t.moveOiPct).padStart(7)}  ${sp(t.candleOiPct).padStart(8)}  ${t.label.padEnd(11)} liq L ${k$(t.candleLiqL)} S ${k$(t.candleLiqS)} ${t.candleLiq.padEnd(7)} move ${t.moveLiq.padEnd(7)} | ${o.at.map((v) => sp(v).padStart(7)).join("  ")} | ${sp(o.best).padStart(6)} ${sp(o.worst).padStart(7)}${t.accepted ? "" : "   <- NOT THE END (rejected)"}`,
        );
      }
      console.log("");
    }
    const summary = (name: string, list: Turn[]): void => {
      const os = list.map(res);
      const col = (i: number): string => {
        const v = os.map((o) => o.at[i]).filter(Number.isFinite);
        return `${H[i]}h ${sp(v.reduce((a, b) => a + b, 0) / (v.length || 1))} (right ${v.filter((x) => x > 0).length}/${v.length})`;
      };
      const avg = (f: (o: ReturnType<typeof res>) => number): string => {
        const v = os.map(f).filter(Number.isFinite);
        return sp(v.reduce((a, b) => a + b, 0) / (v.length || 1));
      };
      console.log(
        `${name.padEnd(34)} ${String(list.length).padStart(4)} signals · ${H.map((_, i) => col(i)).join(" · ")} · best ${avg((o) => o.best)} · worst ${avg((o) => o.worst)}`,
      );
    };
    console.log("SUMMARY (averages, in the signal's direction)");
    summary("PLAIN DC", plain);
    summary(
      "DC + OI rule (accepted)",
      withOi.filter((t) => t.accepted),
    );
    summary(
      "  rejected by the OI rule *",
      withOi.filter((t) => !t.accepted),
    );
    console.log(
      "* rejected = if we HAD taken them: minus = right to reject (the move really went on)",
    );

    // LIQUIDATIONS (Johnny, Oct 2) -- no rank here: does WHO was liquidated separate good turns from bad ones?
    const liqBlock = (name: string, list: Turn[]): void => {
      console.log(`\nLIQUIDATIONS · ${name} (${list.length})`);
      const line = (label: string, sel: Turn[]): void => {
        const os = sel.map(res);
        const avg = (i: number): string => {
          const v = os.map((o) => o.at[i]).filter(Number.isFinite);
          return `${sp(v.reduce((a, b) => a + b, 0) / (v.length || 1))} (right ${v.filter((x) => x > 0).length}/${v.length})`;
        };
        const w = os.map((o) => o.worst).filter(Number.isFinite),
          b = os.map((o) => o.best).filter(Number.isFinite);
        console.log(
          `   ${label.padEnd(44)} ${String(sel.length).padStart(4)} · 2h ${avg(1)} · 4h ${avg(2)} · best ${sp(b.reduce((a, x) => a + x, 0) / (b.length || 1))} · worst ${sp(w.reduce((a, x) => a + x, 0) / (w.length || 1))}`,
        );
      };
      console.log("   reversal candle: who was liquidated more");
      line(
        "LOSERS (longs at a top / shorts at a bottom)",
        list.filter((t) => t.candleLiq === "LOSERS"),
      );
      line(
        "WINNERS (the other side)",
        list.filter((t) => t.candleLiq === "WINNERS"),
      );
      line(
        "NONE (no liquidations)",
        list.filter((t) => t.candleLiq === "NONE"),
      );
      console.log("   the move before it: who was liquidated more");
      line(
        "SQUEEZE (shorts in a rise / longs in a fall)",
        list.filter((t) => t.moveLiq === "SQUEEZE"),
      );
      line(
        "AGAINST (the move's own side)",
        list.filter((t) => t.moveLiq === "AGAINST"),
      );
      line(
        "NONE",
        list.filter((t) => t.moveLiq === "NONE"),
      );
      const f = list
        .filter((t) => Number.isFinite(t.forced) && t.forced > 0)
        .sort((a, z) => a.forced - z.forced);
      if (f.length >= 8) {
        console.log(
          "   forced share in the reversal candle (losers' liquidations / |OI change|), quarters of these signals",
        );
        const q = Math.ceil(f.length / 4);
        for (let i = 0; i < 4; i++) {
          const g = f.slice(i * q, (i + 1) * q);
          if (g.length)
            line(
              `Q${i + 1} ${i === 0 ? "most voluntary" : i === 3 ? "most forced" : ""} (${g[0].forced.toFixed(2)}..${g[g.length - 1].forced.toFixed(2)})`,
              g,
            );
        }
        line(
          "no losers' liquidations at all",
          list.filter((t) => !(t.forced > 0)),
        );
      }
    };
    liqBlock(
      "DC + OI rule (accepted)",
      withOi.filter((t) => t.accepted),
    );
    liqBlock("PLAIN DC (no OI rule)", plain);

    const win = Number(arg("window", "24"));
    const days = Math.max(
      1,
      (bars[bars.length - 1].t - bars[0].t) / 86_400_000,
    );
    for (const [name, list] of [
      ["DC + OI rule", withOi],
      ["PLAIN DC", plain.map((t) => ({ ...t, accepted: true }))],
    ] as const) {
      const r = pastRank(list, win).filter((x) => x.prior > 0); // the first moves have nothing before them to compare with
      console.log(
        `\nBIG MOVES · ${name} · each move's |OI change| vs the moves of the ${win}h before it (only moves with earlier ones: ${r.length})`,
      );
      const line = (label: string, sel: typeof r): void => {
        const os = sel.map((x) => res(x.turn));
        const avg = (i: number): string => {
          const v = os.map((o) => o.at[i]).filter(Number.isFinite);
          return `${sp(v.reduce((a, b) => a + b, 0) / (v.length || 1))} (right ${v.filter((x) => x > 0).length}/${v.length})`;
        };
        const w = os.map((o) => o.worst).filter(Number.isFinite),
          b = os.map((o) => o.best).filter(Number.isFinite);
        console.log(
          `   ${label.padEnd(36)} ${String(sel.length).padStart(4)} (${(sel.length / days).toFixed(1)}/day) · 2h ${avg(1)} · 4h ${avg(2)} · best ${sp(b.reduce((a, x) => a + x, 0) / (b.length || 1))} · worst ${sp(w.reduce((a, x) => a + x, 0) / (w.length || 1))}`,
        );
      };
      line(
        "rank 1 = bigger than ALL before it",
        r.filter((x) => x.rank === 1),
      );
      line(
        "rank 2",
        r.filter((x) => x.rank === 2),
      );
      line(
        "rank 3",
        r.filter((x) => x.rank === 3),
      );
      line(
        "rank 4 and lower",
        r.filter((x) => x.rank >= 4),
      );
      line(
        "bigger than MOST before it (share>1/2)",
        r.filter((x) => x.share > 0.5),
      );
      line(
        "smaller than most",
        r.filter((x) => x.share <= 0.5),
      );
      if (name === "DC + OI rule" && !argv.includes("--quiet")) {
        console.log("   the rank-1 signals:");
        for (const x of r.filter((y) => y.rank === 1)) {
          const o = res(x.turn),
            t = x.turn;
          console.log(
            `     ${utc(t.t)} ${t.newDir === "UP" ? "▲ UP  " : "▼ DOWN"} move OI ${sp(t.moveOiPct).padStart(7)} (vs ${x.prior} earlier) · candle ${t.label.padEnd(10)} | 2h ${sp(o.at[1]).padStart(7)} 4h ${sp(o.at[2]).padStart(7)} | best ${sp(o.best)} worst ${sp(o.worst)}`,
          );
        }
      }
    }
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
