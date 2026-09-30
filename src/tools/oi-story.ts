/**
 * The story of every OI accumulation on OUR data (minute_bars: 1-minute OI + REAL liquidations) -- read-only, UTC.
 *   accumulation (price + OI together) -> the OI drop right after it (who was cleaned) -> where the price went.
 *
 *   npx tsx src/tools/oi-story.ts                       (the bot's coins, last 7 days)
 *   npx tsx src/tools/oi-story.ts --coins ETH,SOL --days 3
 * Rules: src/research/oi-story.ts (moves: src/research/oi-moves.ts -- no % thresholds).
 */
import "dotenv/config";
import * as fs from "fs";
import { MongoClient } from "mongodb";
import { stories, type Story } from "../research/oi-story";
import { mongoMinuteLoader } from "../strategy/oa/oa-paper.service";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DAYS = Number(arg("days", "7"));
const H = 3_600_000,
  D = 24 * H;
const t = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const f2 = (x: number | null): string =>
  x === null ? "  -  " : (x >= 0 ? "+" : "") + x.toFixed(2) + "%";
const px = (x: number): string =>
  x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toFixed(6);
const n0 = (x: number): string => Math.round(x).toLocaleString("en-US");
const usd = (x: number): string =>
  x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : `$${(x / 1e3).toFixed(0)}K`;
const med = (v: number[]): number | null => {
  const a = [...v].sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : null;
};

function symbols(): string[] {
  const s = arg("coins", "");
  if (s)
    return s
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
      .map((x) => (x.endsWith("USDT") ? x : `${x}USDT`));
  try {
    const c = JSON.parse(
      fs.readFileSync(process.env.USERS_CONFIG ?? "users.config.json", "utf8"),
    ) as { v9?: { symbols?: string[] } };
    if (c.v9?.symbols?.length) return c.v9.symbols;
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

function print(s: Story): void {
  const coin = s.symbol.replace(/USDT$/, ""),
    a = s.acc,
    up = s.dir === "UP";
  console.log(
    `${up ? "▲" : "▼"} ${coin.padEnd(5)} ${up ? "PRICE UP  " : "PRICE DOWN"} + OI UP`,
  );
  console.log(
    `   1. accumulation ${t(a.from)} -> ${t(a.to)} UTC (${a.hours}h)   price ${px(a.priceFrom)} -> ${px(a.priceTo)} (${f2(a.pricePct)})   OI +${n0(a.oiTo - a.oiFrom)} ${coin} (${f2((100 * (a.oiTo - a.oiFrom)) / a.oiFrom)})`,
  );
  console.log(
    `      opened: longs +${n0(a.flow.newLong)}, shorts +${n0(a.flow.newShort)} ${coin} | closed: longs ${n0(a.flow.longOut)}, shorts ${n0(a.flow.shortOut)} ${coin} | REAL liquidations: longs ${usd(a.liq.longUsd)} (${n0(a.liq.longCoin)} ${coin}), shorts ${usd(a.liq.shortUsd)} (${n0(a.liq.shortCoin)} ${coin})`,
  );
  if (!s.drop) {
    console.log(
      `   2. OI still growing -- no drop yet (the peak is the last closed hour)\n`,
    );
    return;
  }
  const d = s.drop;
  console.log(
    `   2. OI drop      ${t(d.from)} -> ${t(d.to)} UTC (${d.hours}h)   price ${px(d.priceFrom)} -> ${px(d.priceTo)} (${f2(d.pricePct)})   OI -${n0(d.oiFrom - d.oiTo)} ${coin} = ${d.cleanedPct.toFixed(0)}% of the accumulation`,
  );
  console.log(
    `      REAL liquidations: longs ${usd(d.liq.longUsd)} (${n0(d.liq.longCoin)} ${coin}), shorts ${usd(d.liq.shortUsd)} (${n0(d.liq.shortCoin)} ${coin})  -> ${d.cleaned} cleaned | OI split: longs out ${n0(d.flow.longOut)}, shorts out ${n0(d.flow.shortOut)} ${coin}`,
  );
  if (!s.after) {
    console.log(`   3. the OI is still falling -- not finished\n`);
    return;
  }
  const x = s.after;
  console.log(
    `   3. after (from ${px(d.priceTo)} at ${t(d.to)}):  1h ${f2(x.h1)}  4h ${f2(x.h4)}  12h ${f2(x.h12)}  24h ${f2(x.h24)}   | in 24h best up ${f2(x.up24)}, down ${f2(x.down24)}${x.hoursSeen < 24 ? `  (only ${x.hoursSeen}h of data yet)` : ""}\n`,
  );
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const load = mongoMinuteLoader(async () =>
    client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector"),
  );
  const until = Math.floor(Date.now() / H) * H,
    winFrom = until - DAYS * D;
  const all: Story[] = [];
  try {
    for (const sym of symbols()) {
      const rows = await load(sym, winFrom - 2 * D);
      const st = stories(sym, rows, until).filter((s) => s.acc.to > winFrom);
      all.push(...st);
      process.stderr.write(
        `${sym}: ${rows.length} minutes, ${st.length} accumulations\n`,
      );
    }
  } finally {
    await client.close();
  }
  all.sort((a, b) => a.acc.from - b.acc.from);
  console.log(
    `\n=== OI ACCUMULATION STORIES, last ${DAYS} days, ${t(winFrom)} .. ${t(until)} UTC -- our data: 1-minute OI + REAL liquidations ===\n`,
  );
  for (const s of all) print(s);

  console.log(
    "=== SUMMARY: after the OI drop, where did the price go (median; 'up' = how many went up) ===",
  );
  const groups: Array<[string, Story[]]> = [];
  for (const dir of ["UP", "DOWN"] as const)
    for (const c of ["LONGS", "SHORTS"] as const)
      groups.push([
        `${dir === "UP" ? "price UP  " : "price DOWN"} + OI up, then ${c} cleaned`,
        all.filter((s) => s.dir === dir && s.drop?.cleaned === c && s.after),
      ]);
  for (const [name, v] of groups) {
    const col = (k: "h4" | "h12" | "h24"): string => {
      const x = v
        .map((s) => s.after![k])
        .filter((y): y is number => y !== null);
      return `${k} ${f2(med(x))} (up ${x.filter((y) => y > 0).length}/${x.length})`;
    };
    console.log(
      `${name.padEnd(42)} ${String(v.length).padStart(3)} cases | ${col("h4")}  ${col("h12")}  ${col("h24")}`,
    );
  }
  console.log(
    `\nnot finished yet: ${all.filter((s) => !s.after).length} (OI still growing or still falling)`,
  );
  console.log(
    "OI split (longs/shorts opened/closed) is an estimate from 1-minute OI + price; REAL liquidations are Binance's forced orders.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
