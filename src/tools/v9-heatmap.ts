/**
 * LIQUIDATION / OI HEATMAP (Johnny, Sep 28 2026): the main zones of every V9 coin from OUR data --
 * where longs/shorts were liquidated, where new positions were opened, where they were closed.
 * Read-only (minute_bars). Writes an HTML page with one heatmap per coin and prints the zones.
 *
 *   npx tsx src/tools/v9-heatmap.ts                      (all V9 coins, last 5 days, layers of 0.2%)
 *   npx tsx src/tools/v9-heatmap.ts --days 3 --bin 0.3 --out heatmap.html BTC AVAX
 */
import "dotenv/config";
import * as fs from "fs";
import { MongoClient } from "mongodb";
import {
  buildHeat,
  findZones,
  heatHtml,
  heatPanel,
  usd,
  type MinuteRow,
} from "../research/liq-heatmap";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DAY = 86_400_000;
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const fp = (v: number): string =>
  v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toFixed(5);

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
  const days = Number(arg("days", "5")),
    bin = Number(arg("bin", "0.2")),
    out = arg("out", "heatmap.html");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const panels: string[] = [];
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const now = Date.now();
    console.log(
      `\n=== MAIN ZONES FROM LIQUIDATIONS + OPEN INTEREST (last ${days} days, layers of ${bin}%) ===`,
    );
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
      const rows: MinuteRow[] = raw.map((r) => ({
        ts: num(r.ts),
        high: Number(r.high ?? 0),
        low: Number(r.low ?? 0),
        close: Number(r.close ?? 0),
        oi: Number(r.oiLast ?? 0),
        liqLong: Number(r.longLiqUsd ?? 0),
        liqShort: Number(r.shortLiqUsd ?? 0),
      }));
      const heat = buildHeat(rows, bin);
      if (!heat) {
        console.log(`${s}: not enough data`);
        continue;
      }
      const zones = findZones(heat, 5);
      const price = heat.closes[heat.closes.length - 1].close;
      console.log(`\n${s.replace("USDT", "")}  now ${fp(price)}`);
      zones.forEach((z, i) => {
        const where =
          price > z.hi
            ? `${(((price - z.hi) / price) * 100).toFixed(2)}% below`
            : price < z.lo
              ? `${(((z.lo - price) / price) * 100).toFixed(2)}% above`
              : "price is IN it";
        console.log(
          `  Z${i + 1}  ${fp(z.lo)} - ${fp(z.hi)}  ${where.padEnd(14)}  ${z.kind.padEnd(16)}  longs liq ${usd(z.liqLong).padStart(7)}  shorts liq ${usd(z.liqShort).padStart(7)}  new pos ${usd(z.opened).padStart(7)}  closed ${usd(z.closed).padStart(7)}`,
        );
      });
      panels.push(heatPanel(s, heat, zones, price));
    }
  } finally {
    await client.close();
  }
  fs.writeFileSync(
    out,
    heatHtml(
      panels,
      `Liquidation & open-interest heatmap — last ${days} days (Yerevan time)`,
    ),
  );
  console.log(
    `\nZ1 = the strongest. LIQUIDATIONS = cleaned there; NEW POSITIONS = fuel (their stops/liquidations are near); CLOSED = positions left there.`,
  );
  console.log(
    `heatmap written to ${out} -- copy it to your computer and open it in the browser.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
