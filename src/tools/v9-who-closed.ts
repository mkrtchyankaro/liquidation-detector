/**
 * WHO CLOSED MY REAL POSITION? (Johnny, Sep 29 2026) -- read-only, signed GET requests only (no orders).
 * For every REAL V9 trade that closed as "CLOSED MANUALLY" (POSITION_CLOSED_EXTERNALLY) in the last days,
 * asks Binance for every fill on that symbol from the entry until 1h after the close, and for each order behind
 * them: its type and its clientOrderId. The clientOrderId says who sent it:
 *   v9...                 this bot (ENTRY / TAKE_PROFIT / STOP_LOSS / MARKET_EXIT)
 *   web_ / ios_ / android_ ...   someone in the Binance website or app
 *   autoclose- / adl_autoclose   Binance itself (liquidation / auto-deleverage)
 *   anything else          another bot / API program using the same account
 *
 *   npx tsx src/tools/v9-who-closed.ts                 (all REAL users, last 3 days)
 *   npx tsx src/tools/v9-who-closed.ts --days 7 --all  (every REAL trade, not only "closed manually")
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { loadEnv } from "../config/env";
import { loadAppConfig } from "../config/users-config";
import { BinanceRestClient } from "../infrastructure/binance/binanceRest.client";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DAYS = Number(arg("days", "3")),
  ALL = argv.includes("--all");
const yvn = (ms: number): string =>
  new Date(ms + 4 * 3_600_000).toISOString().slice(5, 19).replace("T", " ");
const who = (id: string): string =>
  id.startsWith("v9")
    ? "THIS BOT"
    : /^(web_|ios_|android_|and_)/i.test(id)
      ? "BINANCE APP / WEBSITE (a person)"
      : /autoclose|adl/i.test(id)
        ? "BINANCE (liquidation / ADL)"
        : id
          ? "ANOTHER PROGRAM (API) on this account"
          : "unknown";

async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadAppConfig(env.usersConfigPath, env.symbols);
  const client = new MongoClient(env.mongoUri);
  await client.connect();
  try {
    const db = client.db(env.mongoDb);
    const q: Record<string, unknown> = {
      mode: "REAL",
      createdAt: { $gte: Date.now() - DAYS * 86_400_000 },
    };
    if (!ALL) q.closeReason = "POSITION_CLOSED_EXTERNALLY";
    const trades = await db
      .collection("v9_trades")
      .find(q)
      .sort({ createdAt: 1 })
      .toArray();
    if (!trades.length) {
      console.log(
        `no ${ALL ? "" : '"closed manually" '}REAL trades in the last ${DAYS} days`,
      );
      return;
    }
    for (const t of trades) {
      const u = config.users.find((x) => x.userId === t.userId);
      console.log(
        `\n=== ${t.userId} ${t.symbol} ${t.side} entry ${yvn(Number(t.createdAt))} Yerevan -> closed ${t.closedAt ? yvn(Number(t.closedAt)) : "-"}  (${t.closeReason ?? t.state})  bot's TP order ${t.binance?.tpOrderId ?? "-"}, SL algo ${t.binance?.slAlgoId ?? "-"}`,
      );
      if (!u?.binance) {
        console.log("  no Binance keys for this user in users.config.json");
        continue;
      }
      const rest = new BinanceRestClient({
        restBaseUrl: "https://fapi.binance.com",
        wsBaseUrl: "wss://fstream.binance.com",
        apiKey: u.binance.apiKey,
        apiSecret: u.binance.apiSecret,
        testnet: false,
        recvWindowMs: 5_000,
      });
      const since = Number(t.createdAt) - 60_000,
        until = (t.closedAt ? Number(t.closedAt) : Date.now()) + 3_600_000;
      const fills = (
        (await rest.getUserTrades(String(t.symbol), since)) as Array<{
          orderId: number;
          side: string;
          price: string;
          qty: string;
          realizedPnl: string;
          time: number;
        }>
      ).filter((f) => f.time <= until);
      if (!fills.length) {
        console.log("  Binance returned no fills in this window");
        continue;
      }
      const orders = new Map<
        number,
        {
          type?: string;
          origType?: string;
          clientOrderId?: string;
          reduceOnly?: boolean;
          status?: string;
        }
      >();
      for (const id of new Set(fills.map((f) => f.orderId))) {
        orders.set(
          id,
          (await rest
            .getOrder(String(t.symbol), id)
            .catch((e: unknown) => ({
              status: `lookup failed: ${e instanceof Error ? e.message : String(e)}`,
            }))) as { type?: string },
        );
      }
      console.log(
        "  time (Yerevan)       side  qty          price        realizedPnl  order        type          clientOrderId                         sent by",
      );
      for (const f of fills) {
        const o = orders.get(f.orderId) ?? {};
        console.log(
          `  ${yvn(f.time)}  ${f.side.padEnd(4)}  ${String(f.qty).padEnd(12)} ${String(f.price).padEnd(12)} ${String(f.realizedPnl).padEnd(12)} ${String(f.orderId).padEnd(12)} ${String(o.origType ?? o.type ?? "?").padEnd(13)} ${String(o.clientOrderId ?? "?").padEnd(37)} ${who(String(o.clientOrderId ?? ""))}`,
        );
      }
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
