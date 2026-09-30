/**
 * OA (OI accumulation, 1h) on the stored data -- read-only. Runs EXACTLY the live engine
 * (src/research/oi-accumulation.ts) on minute_bars and prints every trade it would have taken (UTC).
 *
 *   npx tsx src/tools/oa-backtest.ts               (configured symbols, all stored days up to 14)
 *   npx tsx src/tools/oa-backtest.ts --days 7 --symbols SUI,AVAX
 *   npx tsx src/tools/oa-backtest.ts --rr 3          (TP = 3R instead of 2.2R)
 */
import "dotenv/config";
import * as fs from "fs";
import { MongoClient } from "mongodb";
import {
  hoursFromMinutes,
  OA_DEFAULTS,
  runOa,
  type OaTrade,
} from "../research/oi-accumulation";
import { mongoMinuteLoader } from "../strategy/oa/oa-paper.service";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DAYS = Math.min(30, Number(arg("days", "14"))),
  RR = Number(arg("rr", "2.2")),
  H = 3_600_000;
const t = (ms: number | null): string =>
  ms === null ? "-" : new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const money = (v: number): string =>
  v >= 1e6
    ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1e3
      ? `$${(v / 1e3).toFixed(0)}K`
      : `$${v.toFixed(0)}`;

function symbols(): string[] {
  const s = arg("symbols", "");
  if (s)
    return s
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .map((x) => (x.endsWith("USDT") ? x : `${x}USDT`));
  try {
    const c = JSON.parse(
      fs.readFileSync(process.env.USERS_CONFIG ?? "users.config.json", "utf8"),
    ) as { v9?: { symbols?: string[] } };
    if (c.v9?.symbols?.length) return c.v9.symbols;
  } catch {
    /* next */
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
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const load = mongoMinuteLoader(async () =>
    client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector"),
  );
  const all: OaTrade[] = [];
  try {
    const until = Math.floor(Date.now() / H) * H;
    for (const s of symbols()) {
      const rows = await load(s, until - DAYS * 24 * H);
      const hours = hoursFromMinutes(rows, until);
      const path = rows
        .filter((r) => r.close !== null && r.close > 0 && r.ts < until)
        .map((r) => ({
          ts: r.ts,
          high: r.high ?? r.close!,
          low: r.low ?? r.close!,
          close: r.close!,
        }));
      const { trades, episode } = runOa(s, hours, path, {
        ...OA_DEFAULTS,
        rr: RR,
      });
      all.push(...trades);
      process.stderr.write(
        `${s}: ${hours.filter((h) => h.complete).length} complete hours, ${trades.length} trades${episode ? `, live episode ${episode.dir} since ${t(episode.since)} (move ${episode.movePct.toFixed(1)}%, OI ${episode.oiPct.toFixed(1)}%)` : ""}\n`,
      );
    }
  } finally {
    await client.close();
  }
  all.sort((a, b) => a.entryTs - b.entryTs);
  console.log(
    `\n=== OA (OI accumulation, 1h) on the stored data, last ${DAYS} days, TP ${RR}R, times UTC ===`,
  );
  console.log(
    "ENTRY        COIN   SIDE   TYPE  episode since (move, OI)      OI-drop hour  OI     liq      entry        SL%    result  netR    exit",
  );
  for (const x of all) {
    console.log(
      `${t(x.entryTs)}  ${x.symbol.replace("USDT", "").padEnd(5)}  ${x.side.padEnd(5)}  ${x.variant === "A" ? "A rev" : "B con"}  ${t(x.episode.since)} (${x.episode.movePct >= 0 ? "+" : ""}${x.episode.movePct.toFixed(1)}%, +${x.episode.oiPct.toFixed(1)}%)`.padEnd(
        66,
      ) +
        `${t(x.oiDropHour)}   ${x.oiDropPct.toFixed(2)}%  ${money(x.oiDropLiqUsd).padEnd(7)}  ${String(x.entry).padEnd(11)}  ${x.slPct.toFixed(2)}  ${x.result.padEnd(6)}  ${(x.netR >= 0 ? "+" : "") + x.netR.toFixed(2)}  ${t(x.exitTs)}`,
    );
  }
  const closed = all.filter((x) => x.result !== "OPEN");
  const sum = (v: OaTrade[]): string =>
    `${v.length} trades, TP ${v.filter((x) => x.result === "TP").length}, SL ${v.filter((x) => x.result === "SL").length}, TIME ${v.filter((x) => x.result === "TIME").length}, net ${v.reduce((s, x) => s + x.netR, 0).toFixed(2)}R`;
  console.log(
    `\nclosed: ${sum(closed)}   |  A reversal: ${sum(closed.filter((x) => x.variant === "A"))}   |  B continuation: ${sum(closed.filter((x) => x.variant === "B"))}`,
  );
  console.log(
    `open now: ${all.length - closed.length}   (fees included; SL first when SL and TP are touched in the same minute)`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
