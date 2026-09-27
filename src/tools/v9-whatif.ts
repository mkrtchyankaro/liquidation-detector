/**
 * WHAT-IF ON THE REAL LIVE SIGNALS (Johnny, Sep 27 2026).
 *
 * The causal replay rebuilds signals from raw data and needs 3 days of
 * warm-up (its 3-day window and 3-day medians start empty), so with only a
 * few days of raw data its signals are NOT the live ones. This tool does not
 * rebuild anything: it takes the signals V9 really gave live (v9_trades),
 * keeps their exact entry, and only re-computes the STOP / TP under each rule
 * and the result on minute_bars (kept 365 days). Read-only.
 *
 *   npx tsx src/tools/v9-whatif.ts               (all live signals)
 *   npx tsx src/tools/v9-whatif.ts --user main   (whose fills to use; default main)
 *
 * Rules compared (entry = the user's real fill; TP = 2.2R; SL never < 0.33%):
 *   OLD      SL at the episode extreme (start -> decision)
 *   OITURN   SL at the extreme since the OI turn (if closer)
 *   MIN0.6   OITURN only when that stop is >= 0.6% away (live since Sep 26)
 *   +S3/+S5  MIN0.6, but no trade when the TP lies beyond the last 1h swing
 *            (3-candle / 5-candle rule) -- the 1h structure would have to break
 * "LIVE" = what really happened to the user's trade (validation: OLD should
 * match it for signals that ran with the old rule).
 * Result on 1-minute high/low; when SL and TP are both inside one minute, SL first.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { hourCandles, lastSwing } from "../strategy/v9/v9-causal-engine";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const MIN = 60_000,
  RR = 2.2,
  MIN_SL = 0.0033,
  TAKER = 0.05,
  MAKER = 0.02;
const stamp = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);

interface Bar {
  ts: number;
  high: number;
  low: number;
  oi: number;
}
type Res = {
  sl: number;
  slPct: number;
  tp: number;
  result: "TP" | "SL" | "OPEN";
  netR: number;
  blocked?: boolean;
};

function simulate(
  bars: readonly Bar[],
  entryTs: number,
  long: boolean,
  entry: number,
  sl: number,
): Res {
  const risk = Math.abs(entry - sl),
    slPct = (100 * risk) / entry;
  const tp = long ? entry + RR * risk : entry - RR * risk;
  for (const b of bars) {
    if (b.ts <= Math.floor(entryTs / MIN) * MIN) continue; // from the minute after the entry minute
    if (long ? b.low <= sl : b.high >= sl)
      return { sl, slPct, tp, result: "SL", netR: -1 - (2 * TAKER) / slPct };
    if (long ? b.high >= tp : b.low <= tp)
      return {
        sl,
        slPct,
        tp,
        result: "TP",
        netR: RR - (TAKER + MAKER) / slPct,
      };
  }
  return { sl, slPct, tp, result: "OPEN", netR: 0 };
}

function clampMin(long: boolean, entry: number, sl: number): number {
  const d = entry * MIN_SL;
  return Math.abs(entry - sl) < d ? (long ? entry - d : entry + d) : sl;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", "main");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const trades = await db
      .collection("v9_trades")
      .find({ userId: user, entryPrice: { $ne: null } })
      .sort({ createdAt: 1 })
      .toArray();
    if (!trades.length) {
      console.log(`no V9 trades with a fill for user "${user}"`);
      return;
    }
    const rules = [
      "OLD",
      "OITURN",
      "MIN0.6",
      "MIN0.6+S3",
      "MIN0.6+S5",
    ] as const;
    const tot = new Map<
      string,
      { tp: number; sl: number; open: number; skip: number; net: number }
    >(
      [...rules, "LIVE"].map((r) => [
        r,
        { tp: 0, sl: 0, open: 0, skip: 0, net: 0 },
      ]),
    );
    const add = (rule: string, r: Res | null): void => {
      const t = tot.get(rule)!;
      if (!r || r.blocked) {
        t.skip++;
        return;
      }
      if (r.result === "TP") t.tp++;
      else if (r.result === "SL") t.sl++;
      else t.open++;
      t.net += r.netR;
    };
    const cell = (r: Res | null): string =>
      !r
        ? "n/a".padEnd(20)
        : r.blocked
          ? "SKIP (1h structure)".padEnd(20)
          : `${r.result.padEnd(4)} SL ${r.slPct.toFixed(2)}% ${r.netR >= 0 ? "+" : ""}${r.netR.toFixed(2)}`.padEnd(
              20,
            );

    console.log(
      `\n=== WHAT-IF on the ${trades.length} real live V9 signals (fills of "${user}") ===`,
    );
    console.log(
      "ENTRY UTC    SYMBOL    SIDE  LIVE              | OLD                 OITURN              MIN0.6              MIN0.6+S3           MIN0.6+S5",
    );
    for (const t of trades) {
      const d = await db
        .collection("v9_decisions")
        .findOne({ signalId: t.signalId });
      if (!d) continue;
      const long = t.side === "LONG",
        entry = Number(t.entryPrice),
        now = num(d.evaluatedAt),
        entryTs = num(t.createdAt);
      const rows = await db
        .collection(MINUTE_BARS)
        .find({
          symbol: t.symbol,
          ts: { $gte: new Date(now - 48 * 3_600_000) },
        })
        .project({ ts: 1, high: 1, low: 1, oiLast: 1 })
        .sort({ ts: 1 })
        .toArray();
      const bars: Bar[] = rows
        .map((r) => ({
          ts: num(r.ts),
          high: Number(r.high),
          low: Number(r.low),
          oi: Number(r.oiLast),
        }))
        .filter((b) => b.high > 0 && b.low > 0);
      const upto = (from: number): Bar[] =>
        bars.filter((b) => b.ts >= Math.floor(from / MIN) * MIN && b.ts <= now);
      const ext = (from: number): number => {
        const s = upto(from);
        return long
          ? Math.min(...s.map((b) => b.low))
          : Math.max(...s.map((b) => b.high));
      };
      const after = bars.filter((b) => b.ts > now);

      // OLD: extreme since the episode start
      const oldSl = clampMin(long, entry, ext(num(d.episodeStart)));
      // OI turn: highest OI from the minute before the episode end to (not incl.) the confirmation
      let turnTs: number | null = null,
        best = -Infinity;
      for (const b of bars)
        if (
          b.ts >= num(d.episodeEnd) - MIN &&
          b.ts < num(d.confirmTs) &&
          b.oi > 0 &&
          b.oi >= best
        ) {
          best = b.oi;
          turnTs = b.ts;
        }
      const turnExt = turnTs === null ? NaN : ext(turnTs);
      const turnValid =
        Number.isFinite(turnExt) &&
        (long
          ? turnExt < entry && turnExt > oldSl
          : turnExt > entry && turnExt < oldSl);
      const oiturnSl = clampMin(long, entry, turnValid ? turnExt : oldSl);
      const min06Sl =
        turnValid && Math.abs(entry - turnExt) / entry >= 0.006
          ? oiturnSl
          : oldSl;

      const rOld = simulate(after, entryTs, long, entry, oldSl);
      const rOit = simulate(after, entryTs, long, entry, oiturnSl);
      const rMin = simulate(after, entryTs, long, entry, min06Sl);
      // 1h structure at the decision (complete hours only)
      const candles = hourCandles(
        bars
          .filter((b) => b.ts <= now)
          .map((b) => ({ ts: b.ts, low: b.low, high: b.high })),
        now,
      );
      const beyond = (k: number): boolean => {
        const sw = lastSwing(candles, long ? "HIGH" : "LOW", k);
        return sw !== null && (long ? rMin.tp > sw.price : rMin.tp < sw.price);
      };
      const rS3: Res = { ...rMin, blocked: beyond(1) },
        rS5: Res = { ...rMin, blocked: beyond(2) };
      const live: Res | null =
        t.state === "CLOSED" && t.pnlR !== null
          ? {
              sl: Number(t.slPrice),
              slPct: (100 * Math.abs(entry - Number(t.slPrice))) / entry,
              tp: Number(t.tpPrice),
              result:
                t.closeReason === "TP_FILLED"
                  ? "TP"
                  : t.closeReason === "SL_FILLED"
                    ? "SL"
                    : "OPEN",
              netR: Number(t.pnlR),
            }
          : t.state === "OPEN"
            ? {
                sl: Number(t.slPrice),
                slPct: (100 * Math.abs(entry - Number(t.slPrice))) / entry,
                tp: Number(t.tpPrice),
                result: "OPEN",
                netR: 0,
              }
            : null;

      add("OLD", rOld);
      add("OITURN", rOit);
      add("MIN0.6", rMin);
      add("MIN0.6+S3", rS3);
      add("MIN0.6+S5", rS5);
      add("LIVE", live);
      console.log(
        `${stamp(entryTs)}  ${String(t.symbol).padEnd(9)} ${long ? "BUY " : "SELL"}  ${cell(live).slice(0, 18).padEnd(18)}| ${cell(rOld)}${cell(rOit)}${cell(rMin)}${cell(rS3)}${cell(rS5)}`,
      );
    }
    console.log("\n=== TOTAL (net R after fees; SKIP = no trade) ===");
    for (const [rule, t] of tot) {
      const done = t.tp + t.sl;
      console.log(
        `${rule.padEnd(10)} TP ${String(t.tp).padStart(2)}  SL ${String(t.sl).padStart(2)}  open ${t.open}  skip ${String(t.skip).padStart(2)}  win ${done ? ((100 * t.tp) / done).toFixed(0).padStart(3) : "n/a"}%  netR ${t.net >= 0 ? "+" : ""}${t.net.toFixed(2)}`,
      );
    }
    console.log(
      "LIVE = what really happened. OLD should match LIVE for signals opened before OITURN went live (Sep 25 17:22 UTC); small differences = minute bars vs live 1-second prices.",
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
