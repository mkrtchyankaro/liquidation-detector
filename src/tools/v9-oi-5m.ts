/**
 * 5-MINUTE OI GROWTH + LIQUIDATIONS for TradingView (Johnny, Sep 28 2026). Read-only, our minute_bars.
 * Writes one Pine script per coin: oi5m-ADA.pine (paste it on BINANCE:ADAUSDT.P, 5m / 15m / 1h).
 *
 *   npx tsx src/tools/v9-oi-5m.ts ADA              (last 5 days)
 *   npx tsx src/tools/v9-oi-5m.ts ADA BTC --days 5
 */
import "dotenv/config";
import * as fs from "fs";
import { MongoClient } from "mongodb";
import { levels, pine5m, slots5, type Row5 } from "../research/oi-5m";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DAY = 86_400_000;
const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : Number(v);
const yvn = (ms: number): string =>
  new Date(ms + 4 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
const usd = (v: number): string =>
  v >= 1e9
    ? `$${(v / 1e9).toFixed(2)}B`
    : v >= 1e6
      ? `$${(v / 1e6).toFixed(2)}M`
      : v >= 1e3
        ? `$${(v / 1e3).toFixed(0)}K`
        : `$${v.toFixed(0)}`;

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
  return ["ADAUSDT"];
}

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const days = Number(arg("days", "5"));
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const now = Date.now();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    for (const s of symbols()) {
      const raw = await db
        .collection("minute_bars")
        .find({ symbol: s, ts: { $gte: new Date(now - days * DAY) } })
        .project({ ts: 1, close: 1, oiLast: 1, longLiqUsd: 1, shortLiqUsd: 1 })
        .sort({ ts: 1 })
        .toArray();
      const rows: Row5[] = raw.map((r) => ({
        ts: num(r.ts),
        close: Number(r.close ?? 0),
        oi: Number(r.oiLast ?? 0),
        liqLong: Number(r.longLiqUsd ?? 0),
        liqShort: Number(r.shortLiqUsd ?? 0),
      }));
      const coin = s.replace("USDT", "");
      if (rows.length < 300) {
        console.log(`\n${coin}: not enough data`);
        continue;
      }
      const slots = slots5(rows, now);
      const lo = levels(slots.map((x) => x.oiUp)),
        ll = levels(slots.map((x) => x.liqLong)),
        ls = levels(slots.map((x) => x.liqShort));
      console.log(
        `\n=== ${coin}: ${slots.length} five-minute candles (UTC) from ${yvn(slots[0].ts)} Yerevan ===`,
      );
      console.log(
        `  OI growth per 5 min:        normal ${usd(lo.p50)}, top 20% from ${usd(lo.p80)}, top 5% from ${usd(lo.p95)}`,
      );
      console.log(
        `  longs liquidated per 5 min:  normal ${usd(ll.p50)}, top 20% from ${usd(ll.p80)}, top 5% from ${usd(ll.p95)}`,
      );
      console.log(
        `  shorts liquidated per 5 min: normal ${usd(ls.p50)}, top 20% from ${usd(ls.p80)}, top 5% from ${usd(ls.p95)}`,
      );
      const top = (
        f: (x: (typeof slots)[number]) => number,
        name: string,
      ): void => {
        const t = [...slots]
          .sort((a, b) => f(b) - f(a))
          .slice(0, 5)
          .filter((x) => f(x) > 0);
        console.log(
          `  largest ${name}: ${t.map((x) => `${yvn(x.ts)} ${usd(f(x))}`).join(" | ")}`,
        );
      };
      top((x) => x.oiUp, "OI growth");
      top((x) => x.liqLong, "long liquidations");
      top((x) => x.liqShort, "short liquidations");
      const out = `oi5m-${coin}.pine`;
      fs.writeFileSync(out, pine5m(s, slots, now));
      console.log(
        `  TradingView script: ${out}  (${(fs.statSync(out).size / 1024).toFixed(0)} KB) -- paste it on BINANCE:${s}.P, 5m`,
      );
    }
  } finally {
    await client.close();
  }
  console.log(
    `\nPurple = OI grew in that 5-minute candle (middle), orange = longs liquidated (under the low), blue = shorts liquidated (over the high).`,
  );
  console.log(
    `Light = above normal, medium = top 20%, dark and bigger = top 5%. On 15m/1h the 5-minute values inside the candle are added up.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
