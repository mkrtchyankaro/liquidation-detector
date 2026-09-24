/**
 * Live end-to-end test of the REAL order path, without waiting for a signal.
 *
 * Runs the EXACT production function (runEntrySequence) for one user from
 * users.config.json, with a tiny risk, then immediately cleans up:
 *   readiness check -> margin/leverage -> pre-flight at executable price ->
 *   MARKET entry -> verify position -> SL (algo STOP_MARKET) -> verify ->
 *   TP (reduce-only LIMIT) -> verify -> CANCEL TP + SL -> MARKET close ->
 *   verify flat and no open orders left.
 *
 * Without --confirm it only prints the plan (no orders).
 *
 * Usage:
 *   npx tsx src/tools/test-live-entry.ts --user karo
 *   npx tsx src/tools/test-live-entry.ts --user karo --symbol DOGEUSDT --side LONG --risk 0.1 --sl-pct 1 --tp-pct 2 --confirm
 *
 * Cost of one run: roughly 2 x taker fee on ~$10 notional (about $0.01),
 * plus the spread.
 */
import "dotenv/config";
import { BinanceRestClient } from "../infrastructure/binance/binanceRest.client";
import { getSymbolFilters, runEntrySequence } from "../execution/entry-sequence";
import { loadAppConfig } from "../config/users-config";
import { loadEnv } from "../config/env";
import { checkRealReadiness } from "../execution/readiness";
import { buildRealCloseReport, type UserTradeFill } from "../execution/close-report";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const userId = arg("user");
  if (!userId) throw new Error("--user is required (a userId from users.config.json)");
  const symbol = (arg("symbol", "DOGEUSDT") as string).toUpperCase();
  const side = (arg("side", "LONG") as string).toUpperCase() as "LONG" | "SHORT";
  if (side !== "LONG" && side !== "SHORT") throw new Error("--side must be LONG or SHORT");
  const riskUsd = Number(arg("risk", "0.1"));
  const slPct = Number(arg("sl-pct", "1"));
  const tpPct = Number(arg("tp-pct", "2"));
  if (!(riskUsd > 0 && riskUsd <= 2)) throw new Error("--risk must be > 0 and <= 2 USD for a test");
  if (!(slPct > 0 && tpPct > 0)) throw new Error("--sl-pct and --tp-pct must be > 0");
  const confirm = process.argv.includes("--confirm");

  const env = loadEnv();
  const user = loadAppConfig(env.usersConfigPath, env.symbols).users.find((u) => u.userId === userId);
  if (!user) throw new Error(`user "${userId}" not found in ${env.usersConfigPath}`);
  if (!user.binance) throw new Error(`user "${userId}" has binance.enabled=false`);

  const rest = new BinanceRestClient({
    restBaseUrl: "https://fapi.binance.com", wsBaseUrl: "wss://fstream.binance.com",
    apiKey: user.binance.apiKey, apiSecret: user.binance.apiSecret, testnet: false, recvWindowMs: 5000,
  });

  console.log(`\n=== 1. Readiness (${userId}) ===`);
  const ready = await checkRealReadiness(userId, rest);
  console.log(ready.ok ? `OK -- available USDT ${ready.availableUsdt.toFixed(2)}` : `NOT READY -- ${ready.reason}`);
  if (!ready.ok) process.exit(1);

  const ticker = (await rest.getBookTicker(symbol)) as { bidPrice: string; askPrice: string };
  const price = Number(side === "LONG" ? ticker.askPrice : ticker.bidPrice);
  const sl = side === "LONG" ? price * (1 - slPct / 100) : price * (1 + slPct / 100);
  const tp = side === "LONG" ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100);
  const qty = riskUsd / Math.abs(price - sl);
  const filters = await getSymbolFilters(rest, symbol);
  console.log(`\n=== 2. Plan ===`);
  console.log(`${symbol} ${side}  price=${price}  SL=${sl.toFixed(6)} (${slPct}%)  TP=${tp.toFixed(6)} (${tpPct}%)`);
  console.log(`risk=$${riskUsd}  qty~${qty.toFixed(4)}  notional~$${(qty * price).toFixed(2)}  minNotional=$${filters?.minNotional ?? "?"}`);
  console.log(`leverage=${user.binance.leverage}  margin=${user.binance.marginMode}`);
  if (!confirm) {
    console.log("\nDry run only. Add --confirm to place REAL orders (they are closed again immediately).");
    return;
  }

  const globalSignalId = `manual-test-${Date.now()}`;
  console.log(`\n=== 3. runEntrySequence (production code) id=${globalSignalId} ===`);
  const outcome = await runEntrySequence(rest, {
    userId, globalSignalId, symbol, side, quantity: qty, entryPriceEstimate: price,
    slPrice: sl, initialTpPrice: tp, riskUsd, leverage: user.binance.leverage, marginMode: user.binance.marginMode,
  });
  console.log(JSON.stringify(outcome, null, 2));

  if (outcome.outcome === "ENTRY_ACTIVE_WITH_TP" || outcome.outcome === "ENTRY_ACTIVE_WITHOUT_TP") {
    // Evidence for how Binance answers algo-order queries on this account
    // (used later by restart recovery and SL-fill detection).
    await sleep(2000);
    const byId = await rest.getAlgoOrder(outcome.slBinanceAlgoId).then((r) => JSON.stringify(r), (e) => `ERROR ${e.message}`);
    const byClient = await rest.getAlgoOrderByClientId(outcome.slClientAlgoId).then((r) => JSON.stringify(r), (e) => `ERROR ${e.message}`);
    console.log(`\n=== 3b. SL query check (2s after entry) ===\nby algoId:      ${byId}\nby clientAlgoId: ${byClient}`);
  }

  console.log(`\n=== 4. Cleanup ===`);
  if (outcome.outcome === "ENTRY_ACTIVE_WITH_TP") {
    await rest.cancelOrder(symbol, outcome.tpBinanceOrderId).then(() => console.log("TP cancelled"), (e) => console.log("TP cancel:", e.message));
  }
  if (outcome.outcome === "ENTRY_ACTIVE_WITH_TP" || outcome.outcome === "ENTRY_ACTIVE_WITHOUT_TP") {
    await rest.cancelAlgoOrder(outcome.slBinanceAlgoId).then(() => console.log("SL cancelled"), (e) => console.log("SL cancel:", e.message));
    const closeSide = side === "LONG" ? "SELL" : "BUY";
    await rest.createOrder({ symbol, side: closeSide, type: "MARKET", quantity: String(outcome.quantity), reduceOnly: "true" })
      .then(() => console.log(`position closed (MARKET ${closeSide} ${outcome.quantity})`), (e) => console.log("close:", e.message));
  }
  await sleep(1500);

  // The cleanup above IS a manual close (like closing in the Binance app).
  // Prove the bot's close detection reads it correctly from Binance fills.
  let closeOk = true;
  if (outcome.outcome === "ENTRY_ACTIVE_WITH_TP" || outcome.outcome === "ENTRY_ACTIVE_WITHOUT_TP") {
    const since = Date.now() - 5 * 60_000;
    const fills = (await rest.getUserTrades(symbol, since)) as UserTradeFill[];
    const report = buildRealCloseReport({ side, fills, sinceMs: since, tpOrderId: outcome.outcome === "ENTRY_ACTIVE_WITH_TP" ? outcome.tpBinanceOrderId : null, slActualOrderId: null });
    console.log(`\n=== 4b. Close detection (same code the bot uses) ===`);
    console.log(report ? `reason=${report.reason}  exit=${report.exitPrice}  qty=${report.closedQty}  realizedPnl=$${report.realizedPnlUsd.toFixed(4)}  fees=$${report.feesUsd.toFixed(4)}` : "no closing fills found");
    closeOk = report !== null && report.reason === "POSITION_CLOSED_EXTERNALLY" && report.closedQty === outcome.quantity;
  }

  console.log(`\n=== 5. Final Binance state (must be flat, no open orders) ===`);
  const pos = ((await rest.getPositionRisk(symbol)) as Array<{ symbol: string; positionAmt: string }>).find((p) => p.symbol === symbol);
  const openOrders = (await rest.getOpenOrders(symbol)) as unknown[];
  const openAlgo = (await rest.getOpenAlgoOrders(symbol)) as unknown[];
  console.log(`positionAmt=${pos?.positionAmt ?? 0}  openOrders=${openOrders.length}  openAlgoOrders=${openAlgo.length}`);
  const clean = Number(pos?.positionAmt ?? 0) === 0 && openOrders.length === 0 && openAlgo.length === 0;
  const passed = (outcome.outcome === "ENTRY_ACTIVE_WITH_TP") && clean && closeOk;
  console.log(passed ? "\nRESULT: PASS -- entry, SL, TP and cleanup all work on this account." : "\nRESULT: FAIL -- see outcome and state above. If anything is still open, close it manually in Binance.");
  if (!passed) process.exitCode = 1;
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
