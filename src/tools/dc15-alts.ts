/**
 * THE SAME RULE ON EVERY ALT (Johnny, Oct 2 2026) Read-only, our DB (minute_bars). See src/research/dc15.ts.
 * For each alt with full history (its data starts within a day of BTC's -- the new coins with ~1 day are skipped):
 *   the alt's OWN turns: DC on its 15m candles + the OI rule (the reversal candle's OI goes against the move's OI)
 *   RANK 1: the move's |OI change| is bigger than every move of THIS ALT in the 12h / 24h before it
 *   own or BTC's?  over the alt's move window: BTC OPPOSITE (BTC went the other way), OWN (BTC explains < 1/2 of
 *                  its minute moves), WITH BTC
 * Then from the signal (candle close), in the signal's direction: 1h, 2h, best / worst within 2h. No TP / SL.
 * SHORT = after the alt's top, LONG = after its bottom. BTC itself is shown as the baseline.
 *
 *   npx tsx src/tools/dc15-alts.ts
 *   options: --from 2026-09-22  --list (every RANK 1 / 24h signal)
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import {
  candles,
  coinInWindow,
  outcome,
  ownness,
  pastRank,
  turns,
  type MinBar,
  type Own,
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
const W15 = 15 * 60_000,
  DAY = 86_400_000;

interface Res {
  at: number[];
  best: number;
  worst: number;
}
interface Sig {
  sym: string;
  turn: Turn;
  short: boolean;
  own: Own | "BTC";
  follow: number;
  btcPct: number;
  rank12: boolean;
  rank24: boolean;
  r: Res;
}

function stats(list: Res[]): string {
  const col = (i: number): string => {
    const v = list.map((o) => o.at[i]).filter(Number.isFinite);
    return `${sp(v.reduce((a, b) => a + b, 0) / (v.length || 1)).padStart(7)} (right ${v.filter((x) => x > 0).length}/${v.length})`;
  };
  const b = list.map((o) => o.best).filter(Number.isFinite),
    w = list.map((o) => o.worst).filter(Number.isFinite);
  return `${String(list.length).padStart(4)} · 1h ${col(0)} · 2h ${col(1)} · best ${sp(b.reduce((a, x) => a + x, 0) / (b.length || 1))} · worst ${sp(w.reduce((a, x) => a + x, 0) / (w.length || 1))}`;
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

    const symbols = (process.env.SYMBOLS ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s && s !== "BTCUSDT");
    const used: string[] = [],
      skipped: string[] = [];
    const sigs: Sig[] = [];
    const run = (sym: string, bars: MinBar[]): void => {
      const all = turns(candles(bars, 15), 1, 14, true);
      const r12 = new Set(
        pastRank(all, 12)
          .filter((r) => r.rank === 1 && r.prior > 0)
          .map((r) => r.turn.t),
      );
      const r24 = new Set(
        pastRank(all, 24)
          .filter((r) => r.rank === 1 && r.prior > 0)
          .map((r) => r.turn.t),
      );
      const map = new Map(bars.map((b) => [b.t, b.close]));
      for (const t of all.filter((x) => x.accepted)) {
        let own: Own | "BTC" = "BTC",
          follow = NaN,
          btcPct = NaN;
        if (sym !== "BTC") {
          const w = coinInWindow(map, btcMap, t.moveStartT, t.extremeT + W15);
          follow = w.follow;
          btcPct = w.btcPct;
          if (!Number.isFinite(follow) || !Number.isFinite(w.pct)) continue;
          own = ownness(follow, w.pct, w.btcPct);
        }
        sigs.push({
          sym,
          turn: t,
          short: t.newDir === "DOWN",
          own,
          follow,
          btcPct,
          rank12: r12.has(t.t),
          rank24: r24.has(t.t),
          r: outcome(bars, t.t, t.price, t.newDir, [1, 2], 2),
        });
      }
    };
    run("BTC", btc);
    for (const s of symbols) {
      const bars = await load(s);
      const name = s.replace(/USDT$/, "");
      if (!bars.length || bars[0].t > btc[0].t + DAY) {
        skipped.push(name);
        continue;
      }
      used.push(name);
      run(name, bars);
    }
    console.log(
      `each coin's own turns (15m DC + OI rule) · ${utc(btc[0].t)} -> ${utc(btc[btc.length - 1].t)} UTC`,
    );
    console.log(
      `alts with full history: ${used.join(", ")} · skipped (too new): ${skipped.join(", ") || "-"}`,
    );
    console.log(
      "own = over the alt's move: BTC OPPOSITE (BTC went the other way) · OWN (BTC explains < half) · WITH BTC · after = from the signal, in its direction (+ = right)\n",
    );

    const groups: Array<[string, (s: Sig) => boolean]> = [
      ["ALL accepted turns", () => true],
      ["RANK 1 · 12h", (s) => s.rank12],
      ["RANK 1 · 24h", (s) => s.rank24],
    ];
    for (const [gname, gf] of groups) {
      console.log(`================ ${gname}`);
      for (const sh of [true, false]) {
        const tag = sh ? "SHORT" : "LONG ";
        for (const own of ["BTC", "BTC OPPOSITE", "OWN", "WITH BTC"] as const)
          console.log(
            `   ${tag} · ${(own === "BTC" ? "BTC itself" : `alts · ${own}`).padEnd(22)} ${stats(sigs.filter((s) => gf(s) && s.short === sh && s.own === own).map((s) => s.r))}`,
          );
        console.log(
          `   ${tag} · ${"alts · OWN + OPPOSITE".padEnd(22)} ${stats(sigs.filter((s) => gf(s) && s.short === sh && (s.own === "OWN" || s.own === "BTC OPPOSITE")).map((s) => s.r))}`,
        );
      }
      console.log("");
    }

    console.log(
      "BY COIN · RANK 1 · 12h · the alt on its own (OWN + BTC OPPOSITE) / WITH BTC, 2h",
    );
    const two = (l: Sig[]): string => {
      const v = l.map((s) => s.r.at[1]).filter(Number.isFinite);
      return `${String(l.length).padStart(2)} ${sp(v.reduce((a, b) => a + b, 0) / (v.length || 1)).padStart(7)} (${v.filter((x) => x > 0).length}/${v.length})`;
    };
    console.log(
      `   ${"coin".padEnd(6)} | ${"SHORT own".padEnd(20)} | ${"SHORT with BTC".padEnd(20)} | ${"LONG own".padEnd(20)} | LONG with BTC`,
    );
    for (const sym of ["BTC", ...used]) {
      const l = sigs.filter((s) => s.sym === sym && s.rank12),
        ownF = (s: Sig): boolean =>
          s.own === "OWN" || s.own === "BTC OPPOSITE" || s.own === "BTC";
      console.log(
        `   ${sym.padEnd(6)} | ${two(l.filter((s) => s.short && ownF(s))).padEnd(20)} | ${two(l.filter((s) => s.short && !ownF(s))).padEnd(20)} | ${two(l.filter((s) => !s.short && ownF(s))).padEnd(20)} | ${two(l.filter((s) => !s.short && !ownF(s)))}`,
      );
    }

    if (argv.includes("--list")) {
      console.log("\nEVERY RANK 1 · 24h SIGNAL");
      for (const s of sigs
        .filter((x) => x.rank24)
        .sort((a, b) => a.turn.t - b.turn.t))
        console.log(
          `${utc(s.turn.t)} ${s.sym.padEnd(5)} ${s.short ? "▼ SHORT" : "▲ LONG "} · move ${sp(s.turn.movePct).padStart(7)} OI ${sp(s.turn.moveOiPct).padStart(7)} · BTC ${sp(s.btcPct).padStart(7)} R2 ${Number.isFinite(s.follow) ? s.follow.toFixed(2) : " -  "} ${s.own.padEnd(12)} | 1h ${sp(s.r.at[0]).padStart(7)}  2h ${sp(s.r.at[1]).padStart(7)} | best ${sp(s.r.best).padStart(7)} worst ${sp(s.r.worst).padStart(7)}`,
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
