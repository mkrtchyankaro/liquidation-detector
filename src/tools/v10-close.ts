/**
 * V10 -- CLOSE A PAPER TRADE BY HAND (Johnny, Oct 3 2026). PAPER only: a REAL trade is closed on Binance (the bot then
 * sees the position flat, cancels its own SL / TP and records the close by itself).
 *
 *   npx tsx src/tools/v10-close.ts                         lists the open V10 trades (all users)
 *   npx tsx src/tools/v10-close.ts --user main --symbol ETHUSDT   closes main's open PAPER trade on ETHUSDT
 *   npx tsx src/tools/v10-close.ts --user main --all              closes ALL of main's open PAPER trades
 * The exit = the last closed minute's close in minute_bars; PnL with taker fees on both sides; reason MANUAL_CLOSE.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { MINUTE_BARS } from "../collector/minute-bars";
import { V10_TRADES, type V10TradeDoc } from "../strategy/v10/v10-repository";
import { estimateFeesUsd } from "../strategy/v9/v9-fees";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const user = arg("user", ""),
    symbol = arg("symbol", "").toUpperCase(),
    all = argv.includes("--all");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
    const trades = db.collection<V10TradeDoc>(V10_TRADES);
    const open = (await trades
      .find({ state: "OPEN" }, { projection: { _id: 0 } })
      .toArray()) as V10TradeDoc[];
    const last = async (
      sym: string,
    ): Promise<{ t: number; close: number } | null> => {
      const d = await db
        .collection(MINUTE_BARS)
        .find({ symbol: sym, close: { $ne: null } })
        .sort({ ts: -1 })
        .limit(1)
        .next();
      return d
        ? { t: (d.ts as Date).getTime() + 60_000, close: Number(d.close) }
        : null;
    };
    console.log(`open V10 trades: ${open.length}`);
    for (const t of open) {
      const p = await last(t.symbol);
      const sign = t.side === "SHORT" ? -1 : 1;
      const now =
        p && t.entryPrice
          ? (100 * sign * (p.close - t.entryPrice)) / t.entryPrice
          : NaN;
      console.log(
        `  ${t.userId.padEnd(6)} ${t.mode.padEnd(5)} ${t.symbol.padEnd(9)} ${t.side.padEnd(5)} entry ${t.entryPrice} (${utc(t.createdAt)} UTC) · now ${p?.close ?? "n/a"} (${Number.isFinite(now) ? `${now >= 0 ? "+" : ""}${now.toFixed(2)}%` : "n/a"}) · ${t.tradeId}`,
      );
    }
    if (!user || (!symbol && !all)) {
      console.log(
        "\nto close: --user <id> --symbol <SYMBOL>   or   --user <id> --all   (PAPER only)",
      );
      return;
    }

    const pick = open.filter(
      (t) => t.userId === user && (all || t.symbol === symbol),
    );
    if (!pick.length) {
      console.log(`\nnothing open for ${user}${symbol ? ` on ${symbol}` : ""}`);
      return;
    }
    for (const t of pick) {
      if (t.mode !== "PAPER") {
        console.log(
          `\n✗ ${t.tradeId} is REAL -- close it on Binance; the bot records the close by itself`,
        );
        continue;
      }
      if (t.entryPrice === null || t.quantity === null) {
        console.log(`\n✗ ${t.tradeId} has no entry yet -- not touched`);
        continue;
      }
      const p = await last(t.symbol);
      if (!p) {
        console.log(`\n✗ no price for ${t.symbol}`);
        continue;
      }
      const sign = t.side === "SHORT" ? -1 : 1,
        riskUsd = t.actualRiskUsd ?? t.plannedRiskUsd;
      const feesUsd = estimateFeesUsd(t.entryPrice * t.quantity).sl; // taker in and out
      const pnlUsd = sign * (p.close - t.entryPrice) * t.quantity - feesUsd;
      const r = await trades.updateOne(
        { tradeId: t.tradeId, state: "OPEN" },
        {
          $set: {
            state: "CLOSED",
            entryInProgress: false,
            closedAt: p.t,
            exitPrice: p.close,
            pnlUsd,
            pnlR: pnlUsd / riskUsd,
            feesUsd,
            closeReason: "MANUAL_CLOSE",
          },
        },
      );
      console.log(
        r.modifiedCount === 1
          ? `\n✓ closed ${t.userId} ${t.symbol} ${t.side} at ${p.close} (${utc(p.t)} UTC) · PnL ${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)} USD (${(pnlUsd / riskUsd).toFixed(2)}R, fees included)`
          : `\n✗ ${t.tradeId} was closed by the bot meanwhile -- nothing changed`,
      );
    }
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
