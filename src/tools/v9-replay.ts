/**
 * V9 CAUSAL REPLAY -- the honest backtest before going live.
 *
 * Feeds real history from Mongo (liq_raw_events, oi_second_observations)
 * into the LIVE engine minute by minute, exactly as it will receive data in
 * production (only rows with timestamp <= now), and calls evaluate() each
 * minute at hh:mm:10 -- the same schedule the live service uses. No
 * look-ahead: regimes, confirmations and medians only ever see the past.
 *
 * Trades are simulated like the research backtest: entry at the first OI
 * poll price at/after the decision time, SL = episode extreme (from episode
 * start until the decision), TP = rr x risk. No fees, no slippage.
 * Also lists the research (offline, look-ahead) selections for comparison.
 *
 * Read-only. Usage:
 *   npx tsx src/tools/v9-replay.ts
 *   npx tsx src/tools/v9-replay.ts --symbols BTC,ETH --rr 2.2
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { type Victim } from "../strategy/v9/v9-core";
import { replaySymbol } from "../strategy/v9/v9-replay";

const DEFAULT_SYMBOLS = [
  "BTC",
  "ETH",
  "SOL",
  "BNB",
  "DOGE",
  "ADA",
  "LINK",
  "AVAX",
  "SUI",
]; // XRP excluded
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(","))
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
const RR = Number(arg("rr", "2.2"));
const stamp = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const time = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const total = {
    decisions: 0,
    tradable: 0,
    stale: 0,
    small: 0,
    tp: 0,
    sl: 0,
    open: 0,
    noRisk: 0,
    sumR: 0,
  };
  try {
    for (const symbol of symbols) {
      const liqCol = db.collection("liq_raw_events"),
        oiCol = db.collection("oi_second_observations");
      const [firstLiq, lastLiq, firstOi, lastOi] = await Promise.all([
        liqCol.findOne(
          { symbol },
          { sort: { timestamp: 1 }, projection: { timestamp: 1 } },
        ),
        liqCol.findOne(
          { symbol },
          { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
        ),
        oiCol.findOne(
          { symbol },
          { sort: { timestamp: 1 }, projection: { timestamp: 1 } },
        ),
        oiCol.findOne(
          { symbol },
          { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
        ),
      ]);
      if (!firstLiq || !lastLiq || !firstOi || !lastOi) {
        console.log(`\n${symbol}: no data`);
        continue;
      }
      const from = Math.max(time(firstLiq.timestamp), time(firstOi.timestamp));
      const until = Math.min(time(lastLiq.timestamp), time(lastOi.timestamp));
      const liqRows = await liqCol
        .find({
          symbol,
          victim: { $in: ["LONG", "SHORT"] },
          timestamp: { $gte: from, $lte: until },
        })
        .project({ timestamp: 1, victim: 1, quoteQty: 1 })
        .sort({ timestamp: 1 })
        .toArray();
      const oiRows = await oiCol
        .find({
          symbol,
          timestamp: { $gte: new Date(from), $lte: new Date(until) },
        })
        .project({ timestamp: 1, oiUpdatedAt: 1, openInterest: 1, price: 1 })
        .sort({ timestamp: 1 })
        .toArray();
      const liq = liqRows.map((x) => ({
        ts: time(x.timestamp),
        victim: x.victim as Victim,
        usd: Number(x.quoteQty),
      }));
      const oi = oiRows.map((x) => ({
        ts: time(x.timestamp),
        updated: time(x.oiUpdatedAt),
        oi: Number(x.openInterest),
        price: Number(x.price),
      }));
      const started = Date.now();
      const { decisions, trades, offlineSelected } = replaySymbol(
        symbol,
        liq,
        oi,
        from,
        until,
        RR,
      );
      const stats = { tp: 0, sl: 0, open: 0, noRisk: 0, sumR: 0 };
      console.log(
        `\n===== ${symbol}  ${stamp(from)} -> ${stamp(until)}  decisions=${decisions.length} =====`,
      );
      const reasons: Record<string, number> = {};
      for (const d of decisions)
        reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
      console.log(`reasons: ${JSON.stringify(reasons)}`);
      console.log(
        "SIGNAL (UTC)       SIDE   EPISODE START     CONFIRM            ENTRY          SL             TP             RESULT  MIN   R",
      );
      for (const { decision: d, trade: t } of trades) {
        if (t.result === "TP") stats.tp++;
        else if (t.result === "SL") stats.sl++;
        else if (t.result === "OPEN") stats.open++;
        else stats.noRisk++;
        stats.sumR += t.r;
        console.log(
          `${stamp(d.evaluatedAt)}  ${(d.tradeSide === "LONG" ? "BUY" : "SELL").padEnd(5)}  ${stamp(d.episode.start)}  ${stamp(d.episode.confirmTs)}  ${String(t.entry ?? "-").padEnd(13)}  ${String(t.sl ?? "-").padEnd(13)}  ${String(t.tp?.toPrecision(8) ?? "-").padEnd(13)}  ${t.result.padEnd(6)}  ${String(t.minutes ?? "-").padStart(4)}  ${t.r}`,
        );
      }
      const done = stats.tp + stats.sl;
      console.log(
        `trades=${done} TP=${stats.tp} SL=${stats.sl} open=${stats.open} noRisk=${stats.noRisk} win=${done ? ((100 * stats.tp) / done).toFixed(1) : "n/a"}% sumR=${stats.sumR.toFixed(1)}`,
      );
      const tradedStarts = new Set(
        decisions
          .filter((x) => x.tradable)
          .map((x) => `${x.episode.victim}:${x.episode.start}`),
      );
      console.log(`replay took ${((Date.now() - started) / 1000).toFixed(0)}s`);
      console.log(
        `research (look-ahead) selections: ${offlineSelected.length}` +
          (offlineSelected.length
            ? ` -> ${offlineSelected.map((o) => `${stamp(o.start)} ${o.victim}${tradedStarts.has(`${o.victim}:${o.start}`) ? " (also live)" : ""}`).join("; ")}`
            : ""),
      );

      total.decisions += decisions.length;
      total.tradable += decisions.filter((x) => x.tradable).length;
      total.stale += reasons.STALE_CONFIRMATION ?? 0;
      total.small += reasons.REFERENCE_TOO_SMALL ?? 0;
      total.tp += stats.tp;
      total.sl += stats.sl;
      total.open += stats.open;
      total.noRisk += stats.noRisk;
      total.sumR += stats.sumR;
    }
  } finally {
    await client.close();
  }
  const done = total.tp + total.sl;
  console.log(
    `\n===== TOTAL (${symbols.length} symbols, rr=${RR}, break-even win ${(100 / (1 + RR)).toFixed(1)}%) =====`,
  );
  console.log(
    `decisions=${total.decisions} tradable=${total.tradable} stale=${total.stale} referenceTooSmall=${total.small}`,
  );
  console.log(
    `trades=${done} TP=${total.tp} SL=${total.sl} open=${total.open} noRisk=${total.noRisk} win=${done ? ((100 * total.tp) / done).toFixed(1) : "n/a"}% sumR=${total.sumR.toFixed(1)} avgR=${done ? (total.sumR / done).toFixed(2) : "n/a"}`,
  );
  console.log(
    "Note: the first ~day of each symbol has a small reference set (REFERENCE_TOO_SMALL); live warm-up loads history so it starts full.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
