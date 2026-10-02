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
 *   options: --symbol BTCUSDT  --from 2026-09-22  --tf 15  --k 1  --n 14  --quiet (summary only)
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import {
  candles,
  outcome,
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
      .project({ ts: 1, high: 1, low: 1, close: 1, oiFirst: 1, oiLast: 1 })
      .sort({ ts: 1 })
      .toArray();
    const bars: MinBar[] = docs.map((d) => ({
      t: (d.ts as Date).getTime(),
      high: Number(d.high),
      low: Number(d.low),
      close: Number(d.close),
      oiFirst: Number(d.oiFirst),
      oiLast: Number(d.oiLast),
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
        "signal (UTC)  new dir  price      extreme (time)            move OI   candle OI  label        | 1h       2h       4h      | best    worst",
      );
      for (const t of withOi) {
        const o = res(t);
        console.log(
          `${utc(t.t)}   ${t.accepted ? (t.newDir === "UP" ? "▲ UP  " : "▼ DOWN") : "  (no) "}  ${t.price.toFixed(1).padStart(9)}  ${t.extreme.toFixed(1).padStart(9)} (${utc(t.extremeT)})  ${sp(t.moveOiPct).padStart(7)}  ${sp(t.candleOiPct).padStart(8)}  ${t.label.padEnd(11)} | ${o.at.map((v) => sp(v).padStart(7)).join("  ")} | ${sp(o.best).padStart(6)} ${sp(o.worst).padStart(7)}${t.accepted ? "" : "   <- NOT THE END (rejected)"}`,
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
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
