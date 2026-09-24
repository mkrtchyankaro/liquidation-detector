/**
 * V9 CAUSAL REPLAY -- honest backtest of strategy variants on stored history.
 *
 * Feeds real rows (liq_raw_events, oi_second_observations) into the LIVE
 * engine minute by minute (only data <= now, evaluated at hh:mm:10 exactly like
 * production) and simulates every tradable signal: entry at the first poll
 * price at/after the decision, SL per variant, TP = rr x risk. Results are
 * shown gross and NET of Binance fees (taker entry; maker TP / taker SL).
 *
 * Variants compared side by side (see VARIANTS below):
 *   A             current live rule (opposite-side liquidation confirms)
 *   P             PRICE_OI: OI falls while price moves against the move
 *   _ATR          SL beyond the extreme by 1x the typical one-minute range
 *   _SIG          OI drop and reversal must exceed the typical one-minute noise
 *   _NOFILT/_NF   no filters (every confirmation trades);  _DOM  only DOM
 *
 * Read-only. Usage (takes ~2-3 min per symbol on the server; use nohup):
 *   npx tsx src/tools/v9-replay.ts
 *   npx tsx src/tools/v9-replay.ts --symbols BTC,ETH --rr 2.2 --details P
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { type Victim } from "../strategy/v9/v9-core";
import { replaySymbol } from "../strategy/v9/v9-replay";
import {
  DEFAULT_V9_ENGINE_SETTINGS,
  type V9EngineSettings,
} from "../strategy/v9/v9-causal-engine";

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
];
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(","))
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .map((s) => (s.endsWith("USDT") ? s : `${s}USDT`));
const RR = Number(arg("rr", "2.2"));
const DETAILS = arg("details", "");
const stamp = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const time = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);

const base: V9EngineSettings = {
  ...DEFAULT_V9_ENGINE_SETTINGS,
  confirmMode: "PRICE_OI",
};
const VARIANTS: Array<{ name: string; settings: V9EngineSettings }> = [
  { name: "A", settings: { ...DEFAULT_V9_ENGINE_SETTINGS } }, // live today
  { name: "P", settings: base }, // PRICE_OI, 5 filters
  { name: "P_ATR", settings: { ...base, slBufferMinuteRanges: 1 } }, // + SL buffer 1x minute range
  { name: "P_SIG", settings: { ...base, significantConfirm: true } }, // + significant OI drop / reversal
  {
    name: "P_SIG_ATR",
    settings: { ...base, significantConfirm: true, slBufferMinuteRanges: 1 },
  },
  { name: "P_NOFILT", settings: { ...base, filters: "NONE" } }, // every confirmation
  { name: "P_DOM", settings: { ...base, filters: "DOM" } }, // only DOM
  {
    name: "P_SIG_ATR_NF",
    settings: {
      ...base,
      significantConfirm: true,
      slBufferMinuteRanges: 1,
      filters: "NONE",
    },
  },
];

interface Tally {
  decisions: number;
  tradable: number;
  tp: number;
  sl: number;
  open: number;
  noRisk: number;
  r: number;
  netR: number;
  slPcts: number[];
}
const empty = (): Tally => ({
  decisions: 0,
  tradable: 0,
  tp: 0,
  sl: 0,
  open: 0,
  noRisk: 0,
  r: 0,
  netR: 0,
  slPcts: [],
});
const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length
    ? s.length % 2
      ? s[s.length >> 1]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    : NaN;
};
function line(name: string, t: Tally): string {
  const done = t.tp + t.sl;
  return `${name.padEnd(13)} trades=${String(done).padStart(3)}  TP=${String(t.tp).padStart(3)}  SL=${String(t.sl).padStart(3)}  open=${t.open}  win=${done ? ((100 * t.tp) / done).toFixed(1).padStart(5) : "  n/a"}%  R=${t.r.toFixed(1).padStart(6)}  netR=${t.netR.toFixed(1).padStart(6)}  avgNetR=${done ? (t.netR / done).toFixed(2).padStart(5) : "  n/a"}  medianSL=${Number.isFinite(median(t.slPcts)) ? median(t.slPcts).toFixed(2) : "n/a"}%  signals=${t.tradable}/${t.decisions}`;
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const totals = new Map(VARIANTS.map((v) => [v.name, empty()]));
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
      const liq = (
        await liqCol
          .find({
            symbol,
            victim: { $in: ["LONG", "SHORT"] },
            timestamp: { $gte: from, $lte: until },
          })
          .project({ timestamp: 1, victim: 1, quoteQty: 1 })
          .sort({ timestamp: 1 })
          .toArray()
      ).map((x) => ({
        ts: time(x.timestamp),
        victim: x.victim as Victim,
        usd: Number(x.quoteQty),
      }));
      const oi = (
        await oiCol
          .find({
            symbol,
            timestamp: { $gte: new Date(from), $lte: new Date(until) },
          })
          .project({ timestamp: 1, oiUpdatedAt: 1, openInterest: 1, price: 1 })
          .sort({ timestamp: 1 })
          .toArray()
      ).map((x) => ({
        ts: time(x.timestamp),
        updated: time(x.oiUpdatedAt),
        oi: Number(x.openInterest),
        price: Number(x.price),
      }));

      console.log(`\n===== ${symbol}  ${stamp(from)} -> ${stamp(until)} =====`);
      for (const v of VARIANTS) {
        const started = Date.now();
        const { decisions, trades } = replaySymbol(
          symbol,
          liq,
          oi,
          from,
          until,
          RR,
          v.settings,
        );
        const t = empty();
        t.decisions = decisions.length;
        t.tradable = decisions.filter((d) => d.tradable).length;
        for (const { decision: d, trade: x } of trades) {
          if (x.result === "TP") t.tp++;
          else if (x.result === "SL") t.sl++;
          else if (x.result === "OPEN") t.open++;
          else t.noRisk++;
          t.r += x.r;
          t.netR += x.netR ?? 0;
          if (x.slPct !== undefined && (x.result === "TP" || x.result === "SL"))
            t.slPcts.push(x.slPct);
          if (DETAILS === v.name) {
            console.log(
              `   ${v.name} ${stamp(d.evaluatedAt)} ${d.tradeSide === "LONG" ? "BUY " : "SELL"} start ${stamp(d.episode.start)} entry ${x.entry ?? "-"} SL ${x.sl ?? "-"} (${x.slPct?.toFixed(2) ?? "-"}%) ${x.result} ${x.minutes ?? "-"}m netR ${x.netR?.toFixed(2) ?? "-"}`,
            );
          }
        }
        console.log(
          `${line(v.name, t)}  (${((Date.now() - started) / 1000).toFixed(0)}s)`,
        );
        const tot = totals.get(v.name)!;
        for (const k of [
          "decisions",
          "tradable",
          "tp",
          "sl",
          "open",
          "noRisk",
          "r",
          "netR",
        ] as const)
          tot[k] += t[k];
        tot.slPcts.push(...t.slPcts);
      }
    }
  } finally {
    await client.close();
  }
  console.log(
    `\n===== TOTAL (${symbols.length} symbols, rr=${RR}; gross break-even win ${(100 / (1 + RR)).toFixed(1)}%) =====`,
  );
  for (const v of VARIANTS) console.log(line(v.name, totals.get(v.name)!));
  console.log(
    "netR = after Binance fees. Fees weigh more when the SL is tight (see medianSL).",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
