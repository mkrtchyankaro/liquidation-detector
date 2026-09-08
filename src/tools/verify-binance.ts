/**
 * Sep 8 2026 (Karo). Ported from liqwatch-bot's own
 * verify_telegram_vs_binance.ts (real, current position/resting-order
 * state, straight from Binance -- never Mongo, never logs, ground
 * truth), PLUS a NEW candle-history section (operator-requested: "look
 * at the candles, see how it actually happened" -- independent
 * verification of a close, not just trusting this project's own
 * reconciliation report).
 *
 * Usage:
 *   npx tsx src/tools/verify-binance.ts SYMBOL
 *   npx tsx src/tools/verify-binance.ts SYMBOL --klines-around "2026-09-08 20:05" --window-minutes 15
 */
import "dotenv/config";
import { BinanceRestClient } from "../infrastructure/binance/binanceRest.client";
import { loadBinanceConfig } from "../infrastructure/config/binance.config";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbol = args[0];
  if (!symbol) {
    console.error(
      'Usage:\n  npx tsx src/tools/verify-binance.ts SYMBOL\n  npx tsx src/tools/verify-binance.ts SYMBOL --klines-around "2026-09-08 20:05" --window-minutes 15',
    );
    process.exit(1);
  }

  const rest = new BinanceRestClient(loadBinanceConfig());

  console.log(
    `\n=== REAL Binance state for ${symbol} -- ground truth, straight from the exchange ===\n`,
  );

  const positions = (await rest.getPositionRisk(symbol)) as Array<{
    symbol: string;
    positionAmt: string;
    entryPrice: string;
    markPrice: string;
    unRealizedProfit: string;
  }>;
  const pos = positions.find((p) => p.symbol === symbol);
  const amt = pos ? parseFloat(pos.positionAmt) : 0;

  if (!pos || amt === 0) {
    console.log(
      "POSITION: none open right now (confirms CLOSED, if you expected one to be closed).\n",
    );
  } else {
    const side = amt > 0 ? "LONG" : "SHORT";
    console.log("POSITION (real, currently open on Binance):");
    console.log(`  side:            ${side}`);
    console.log(`  quantity:        ${Math.abs(amt)}`);
    console.log(`  actual entry:    ${pos.entryPrice}`);
    console.log(`  mark price now:  ${pos.markPrice}`);
    console.log(`  unrealized PnL:  ${pos.unRealizedProfit}\n`);
  }

  const openAlgoOrders = (await rest.getOpenAlgoOrders(symbol)) as Array<{
    algoId: number;
    type: string;
    side: string;
    triggerPrice: string;
    quantity: string;
    reduceOnly: boolean;
    algoStatus: string;
  }>;

  if (openAlgoOrders.length === 0) {
    console.log(
      "RESTING ORDERS: none (no SL, no TP currently resting -- confirms clean/fully closed, if you expected that).\n",
    );
  } else {
    console.log(
      `RESTING ORDERS (${openAlgoOrders.length} found, real, from Binance):\n`,
    );
    for (const o of openAlgoOrders) {
      const label =
        o.type === "STOP_MARKET"
          ? "SL"
          : o.type === "TAKE_PROFIT_MARKET"
            ? "TP"
            : o.type;
      console.log(`  ${label}`);
      console.log(`    algoId:        ${o.algoId}`);
      console.log(`    side:          ${o.side}`);
      console.log(`    triggerPrice:  ${o.triggerPrice}`);
      console.log(`    quantity:      ${o.quantity}`);
      console.log(`    reduceOnly:    ${o.reduceOnly}`);
      console.log(`    status:        ${o.algoStatus}\n`);
    }
  }

  const aroundIdx = args.indexOf("--klines-around");
  if (aroundIdx !== -1 && args[aroundIdx + 1]) {
    const aroundArg = args[aroundIdx + 1]!;
    const windowIdx = args.indexOf("--window-minutes");
    const windowMinutes =
      windowIdx !== -1 && args[windowIdx + 1]
        ? Number(args[windowIdx + 1])
        : 15;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(
      aroundArg,
    )
      ? aroundArg.replace(" ", "T") + "Z"
      : aroundArg;
    const center = new Date(normalized);
    if (isNaN(center.getTime())) {
      console.error(
        `Could not parse --klines-around value "${aroundArg}". Expected e.g. "2026-09-08 20:05".`,
      );
      process.exit(1);
    }
    const startMs = center.getTime() - windowMinutes * 60_000;
    const endMs = center.getTime() + windowMinutes * 60_000;

    console.log(
      `=== 1m candles for ${symbol}, ${new Date(startMs).toISOString()} .. ${new Date(endMs).toISOString()} (real, from Binance REST) ===\n`,
    );
    const klines = await rest.getKlines(symbol, "1m", 1000, startMs, endMs);
    if (klines.length === 0) {
      console.log("  (no candles returned for this window)\n");
    } else {
      console.log(
        "  time                  open        high        low         close",
      );
      for (const k of klines) {
        const openTime = new Date(k.openTime).toISOString().slice(11, 19);
        console.log(
          `  ${openTime}Z          ${k.open.toString().padEnd(11)} ${k.high.toString().padEnd(11)} ${k.low.toString().padEnd(11)} ${k.close}`,
        );
      }
      console.log(
        "\n  Compare high/low against the SL/TP prices your Telegram message reported --",
      );
      console.log(
        "  this is the REAL, independent record of what price actually did, unaffected",
      );
      console.log("  by anything this project's own database says.\n");
    }
  } else {
    console.log(
      'Tip: add --klines-around "YYYY-MM-DD HH:MM" --window-minutes N to also see the real 1m candle history around a close, independent of this project\'s own reconciliation report.\n',
    );
  }

  console.log("=== Compare the values above to your Telegram message. ===\n");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
