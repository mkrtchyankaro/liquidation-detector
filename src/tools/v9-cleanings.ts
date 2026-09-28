/**
 * CLEANINGS + OI BUILD-UPS per coin (Johnny, Sep 28 2026). Read-only, only our minute_bars, always looking back.
 *   - every CLEANING (4h UTC candles: OI fell >= 2x normal + liquidations >= 2x normal; continuation merged)
 *   - the LAST cleaning, and what happened since (OI, price)
 *   - where the OI kept growing since the last cleaning (zones above / below the price)
 *   - a TradingView script (cleanings.pine) that draws the last cleaning and those zones
 *
 *   npx tsx src/tools/v9-cleanings.ts                (all V9 coins, all stored days)
 *   npx tsx src/tools/v9-cleanings.ts ADA --days 7 --pine cleanings.pine
 */
import "dotenv/config";
import * as fs from "fs";
import { MongoClient } from "mongodb";
import {
  buildUps,
  candles4h,
  cleaningsPine,
  findCleanings,
  type BuildZone,
  type Cleaning,
  type Row,
} from "../research/oi-cleanings";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DAY = 86_400_000,
  H = 3_600_000;
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const fp = (v: number): string =>
  v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(4) : v.toFixed(5);
const yvn = (ms: number): string =>
  new Date(ms + 4 * H).toISOString().slice(5, 16).replace("T", " ");
const utc = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const usd = (v: number): string =>
  v >= 1e9
    ? `$${(v / 1e9).toFixed(2)}B`
    : v >= 1e6
      ? `$${(v / 1e6).toFixed(2)}M`
      : v >= 1e3
        ? `$${(v / 1e3).toFixed(0)}K`
        : `$${v.toFixed(0)}`;
const sg = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function symbols(): string[] {
  const named = argv.filter(
    (a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")),
  );
  if (named.length)
    return named.map((a) =>
      a.toUpperCase().endsWith("USDT")
        ? a.toUpperCase()
        : `${a.toUpperCase()}USDT`,
    );
  try {
    const cfg = JSON.parse(fs.readFileSync("users.config.json", "utf8")) as {
      v9?: { symbols?: string[] };
    };
    if (cfg.v9?.symbols?.length) return cfg.v9.symbols;
  } catch {
    /* default */
  }
  return [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "DOGEUSDT",
    "ADAUSDT",
    "LINKUSDT",
    "AVAXUSDT",
    "SUIUSDT",
  ];
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const days = Number(arg("days", "30")),
    pineOut = arg("pine", "cleanings.pine");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const now = Date.now();
  const pine: Array<{
    symbol: string;
    last: Cleaning | null;
    zones: BuildZone[];
  }> = [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const s of symbols()) {
      const raw = await db
        .collection("minute_bars")
        .find({ symbol: s, ts: { $gte: new Date(now - days * DAY) } })
        .project({
          ts: 1,
          high: 1,
          low: 1,
          close: 1,
          oiLast: 1,
          longLiqUsd: 1,
          shortLiqUsd: 1,
        })
        .sort({ ts: 1 })
        .toArray();
      const rows: Row[] = raw.map((r) => ({
        ts: num(r.ts),
        high: Number(r.high ?? 0),
        low: Number(r.low ?? 0),
        close: Number(r.close ?? 0),
        oi: Number(r.oiLast ?? 0),
        liqLong: Number(r.longLiqUsd ?? 0),
        liqShort: Number(r.shortLiqUsd ?? 0),
      }));
      const coin = s.replace("USDT", "");
      if (rows.length < 600) {
        console.log(`\n${coin}: not enough data`);
        continue;
      }
      const c4 = candles4h(rows, now);
      const all = findCleanings(c4);
      const price = rows[rows.length - 1].close;
      console.log(
        `\n=== ${coin}  now ${fp(price)}  (${c4.length} finished 4h candles since ${yvn(c4[0]?.ts ?? now)} Yerevan) ===`,
      );
      if (!all.length) console.log("  no cleaning in this period");
      for (const e of all) {
        console.log(
          `  ${yvn(e.from)} -> ${yvn(e.to)} Yerevan (UTC ${utc(e.from)}-${utc(e.to)}, ${e.candles} candle${e.candles > 1 ? "s" : ""})  ${e.side === "DOWN" ? "LONGS flushed (down)" : "SHORTS flushed (up)"}  price ${sg(e.movePct)}  ${fp(e.low)}-${fp(e.high)}  OI ${sg(e.oiPct)} (${e.xOi.toFixed(1)}x normal)  liq longs ${usd(e.liqLong)} shorts ${usd(e.liqShort)} (${e.xLiq.toFixed(1)}x normal)`,
        );
      }
      const last = all.length ? all[all.length - 1] : null;
      let zones: BuildZone[] = [];
      if (last) {
        const after = rows.filter((r) => r.ts >= last.to);
        const oiA = after.find((r) => r.oi > 0)?.oi ?? NaN,
          oiB = [...after].reverse().find((r) => r.oi > 0)?.oi ?? NaN;
        const pA = after[0]?.close ?? NaN;
        console.log(
          `  LAST cleaning ended ${yvn(last.to)} (${((now - last.to) / H).toFixed(0)}h ago). Since then: price ${sg((100 * (price - pA)) / pA)}, OI ${sg((100 * (oiB - oiA)) / oiA)}`,
        );
        zones = buildUps(rows, last.to, price);
        if (!zones.length) console.log("  no OI build-up since then yet");
        zones.forEach((z, i) =>
          console.log(
            `    OI+ ${i + 1}  ${`${fp(z.lo)} - ${fp(z.hi)}`.padEnd(24)} ${z.where === "ABOVE" ? "above the price" : z.where === "BELOW" ? "below the price" : "price is in it"}  new positions ${usd(z.usd)}`,
          ),
        );
      }
      pine.push({ symbol: s, last, zones });
    }
  } finally {
    await client.close();
  }
  fs.writeFileSync(pineOut, cleaningsPine(pine, now));
  console.log(
    `\nCleaning = a 4h candle (UTC 00/04/08/12/16/20, like Binance) where the OI fell >= 2x this coin's normal 4h change AND liquidations were >= 2x normal;`,
  );
  console.log(
    `the next candle that still cleans the same side and goes further is the same cleaning. OI+ = where new positions kept opening since the last cleaning.`,
  );
  console.log(
    `TradingView script: ${pineOut}  (scp it to your computer, Pine Editor > paste > Add to chart)`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
