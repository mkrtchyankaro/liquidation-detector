/**
 * OPEN-POSITION / LIQUIDATION HEATMAP (Johnny, Sep 28 2026): the zones of every V9 coin from OUR data --
 * FUEL = positions still open (longs waiting below the price, shorts above; a model, see liq-heatmap.ts),
 * CLEANED = where the liquidations already happened.
 * Read-only (minute_bars). Writes an HTML page with one heatmap per coin and prints the zones.
 *
 *   npx tsx src/tools/v9-heatmap.ts                      (all V9 coins, last 5 days, layers of 0.2%)
 *   npx tsx src/tools/v9-heatmap.ts --days 3 --bin 0.3 --out heatmap.html --pine zones.pine BTC AVAX
 * The ledger of open positions starts at the LAST MARKET BREAK (a 4h impulse >= 3x the coin's normal 4h
 * candle): after a break the old positions are mostly gone, a new structure starts.
 */
import "dotenv/config";
import * as fs from "fs";
import { MongoClient } from "mongodb";
import {
  buildHeat,
  fromNow,
  fuelZones,
  heatHtml,
  heatPanel,
  liquidationZones,
  pineScript,
  usd,
  type HeatZone,
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
  const pine: Array<{
    symbol: string;
    fuel: HeatZone[];
    cleaned: HeatZone[];
    breakTs: number | null;
    madeAt: number;
  }> = [];
  const yvn = (ms: number): string =>
    new Date(ms + 4 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const now = Date.now();
    console.log(
      `\n=== ZONES FROM OUR LIQUIDATIONS + OPEN INTEREST (last ${days} days, layers of ${bin}%) ===`,
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
      const fuel = fuelZones(heat, 3),
        liqZ = liquidationZones(heat, 3);
      const price = heat.price;
      console.log(`\n${s.replace("USDT", "")}  now ${fp(price)}`);
      const b = heat.lastBreak;
      console.log(
        b
          ? `  last market break ${yvn(b.from)} -> ${yvn(b.to)}: ${b.up ? "UP" : "DOWN"} ${b.movePct.toFixed(2)}% (${b.timesMedian.toFixed(1)}x a normal 4h candle), OI ${b.oiPct.toFixed(2)}%, liquidations ${usd(b.liqUsd)} -- positions counted from here`
          : "  no market break in this period -- positions counted from the first stored minute",
      );
      fuel.forEach((z, i) =>
        console.log(
          `  F${i + 1} ${z.side.padEnd(14)} ${`${fp(z.lo)} - ${fp(z.hi)}`.padEnd(22)} ${fromNow(z, price).padEnd(14)}  still open ${usd(z.usd)}`,
        ),
      );
      liqZ.forEach((z, i) =>
        console.log(
          `  L${i + 1} CLEANED        ${`${fp(z.lo)} - ${fp(z.hi)}`.padEnd(22)} ${fromNow(z, price).padEnd(14)}  longs liq ${usd(z.liqLong)}, shorts liq ${usd(z.liqShort)}`,
        ),
      );
      panels.push(heatPanel(s, heat, liqZ, fuel));
      pine.push({
        symbol: s,
        fuel,
        cleaned: liqZ,
        breakTs: b?.to ?? null,
        madeAt: now,
      });
    }
  } finally {
    await client.close();
  }
  const pineOut = arg("pine", "zones.pine");
  fs.writeFileSync(pineOut, pineScript(pine));
  fs.writeFileSync(
    out,
    heatHtml(
      panels,
      `Open positions & liquidations — last ${days} days (Yerevan time)`,
    ),
  );
  console.log(
    `\nF = FUEL: positions still open (model). LONGS WAITING below the price -- their stops/liquidations are under them, the next long cleaning; SHORTS WAITING above.`,
  );
  console.log(
    `L = CLEANED: where the liquidations already happened. F1/L1 = the strongest.`,
  );
  console.log(
    `heatmap written to ${out} -- copy it to your computer and open it in the browser.`,
  );
  console.log(
    `TradingView script written to ${pineOut} -- tradingview.com > Pine Editor > paste > Add to chart (e.g. BINANCE:BTCUSDT.P).`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
