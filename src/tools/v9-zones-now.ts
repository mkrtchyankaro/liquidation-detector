/**
 * ZONES NOW (Johnny, Sep 28 2026): the current top and bottom zone of each V9 coin, from Binance 4h candles
 * (last 7 days, finished candles only), exactly as v9-frame builds them. Read-only, no database.
 *
 *   npx tsx src/tools/v9-zones-now.ts              (the v9.symbols of users.config.json)
 *   npx tsx src/tools/v9-zones-now.ts BTC ETH AVAX (only these)
 *
 * Coins without a frame (the other side not formed yet) are listed at the end, without zones.
 */
import * as fs from "fs";
import axios from "axios";
import { frameOf, widenFrame, K } from "./v9-frame";

const H4 = 4 * 3_600_000,
  DAY = 24 * 3_600_000,
  LOOK_DAYS = 7;
const fp = (v: number): string =>
  v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toFixed(5);
const yerevan = (ms: number): string =>
  new Date(ms + 4 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
const http = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 15_000,
});

function symbolsFromArgs(): string[] {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (args.length)
    return args.map((a) =>
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
    /* fall through */
  }
  return [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "SUIUSDT",
    "LINKUSDT",
    "AVAXUSDT",
    "ADAUSDT",
    "DOGEUSDT",
    "XRPUSDT",
  ];
}

async function main(): Promise<void> {
  const now = Date.now();
  const none: string[] = [];
  console.log(
    `\n=== ZONES NOW (${yerevan(now)} Yerevan) -- 4h candles, last ${LOOK_DAYS} days ===`,
  );
  console.log(
    "SYMBOL      PRICE      TOP ZONE (sell side)                 BOTTOM ZONE (buy side)               PRICE NOW",
  );
  for (const s of symbolsFromArgs()) {
    const res = await http.get<Array<[number, string, string, string, string]>>(
      "/fapi/v1/klines",
      {
        params: {
          symbol: s,
          interval: "4h",
          startTime: now - (LOOK_DAYS + 1) * DAY,
          limit: 100,
        },
      },
    );
    const all: K[] = res.data.map((k) => ({
      ts: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
    }));
    const price = all.length ? all[all.length - 1].close : NaN;
    const done = all.filter(
      (k) => k.ts >= now - LOOK_DAYS * DAY && k.ts + H4 <= now,
    );
    const f = widenFrame(done, frameOf(done));
    if (!f || !f.top || !f.bottom) {
      none.push(
        `${s.replace("USDT", "")} (${f?.last === "PEAK" ? "falling from the peak, no bottom yet" : f?.last === "BOTTOM" ? "rising from the bottom, no top yet" : "too few candles"})`,
      );
      continue;
    }
    const zone = (z: NonNullable<typeof f.top>): string =>
      `${fp(z.lo)} - ${fp(z.hi)}  x${z.touches} from ${yerevan(z.ts)}`.padEnd(
        37,
      );
    const where =
      price >= f.top.lo
        ? price > f.top.hi
          ? "ABOVE the top zone"
          : "IN the top zone"
        : price <= f.bottom.hi
          ? price < f.bottom.lo
            ? "BELOW the bottom zone"
            : "IN the bottom zone"
          : `middle (${Math.round((100 * (price - f.bottom.hi)) / (f.top.lo - f.bottom.hi))}% from bottom to top)`;
    console.log(
      `${s.replace("USDT", "").padEnd(8)} ${fp(price).padStart(10)}   ${zone(f.top)}${zone(f.bottom)}${where}`,
    );
    await new Promise((r) => setTimeout(r, 150));
  }
  if (none.length) console.log(`\nno frame now: ${none.join(", ")}`);
  console.log(
    "\nxN = how many 4h wicks built the zone; from = the first candle that left a wick there (Yerevan time).",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
