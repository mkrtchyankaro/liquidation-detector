/**
 * REAL close classification from Binance fills (userTrades):
 * TP vs SL vs manual close, exit price, realized PnL after fees.
 * Usage: npx tsx tests/liquidation-oi-real-close-report.test.ts
 */
import * as assert from "assert";
import { buildRealCloseReport, type UserTradeFill } from "../src/domain/liquidation-oi-strategy/real-close-report";

let passed = 0, failed = 0;
function scenario(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}\n`); }
}
const T0 = 1_790_000_000_000;
const entry: UserTradeFill = { orderId: 1, side: "BUY", price: "0.1", qty: "100", realizedPnl: "0", commission: "0.005", commissionAsset: "USDT", time: T0 };
const close = (orderId: number, price: string, pnl: string, qty = "100"): UserTradeFill => ({ orderId, side: "SELL", price, qty, realizedPnl: pnl, commission: "0.005", commissionAsset: "USDT", time: T0 + 60_000 });

console.log("LOX real close report");
scenario("TP order fill -> TP_FILLED, exact exit and net PnL", () => {
  const r = buildRealCloseReport({ side: "LONG", fills: [entry, close(77, "0.102", "0.2")], sinceMs: T0, tpOrderId: 77, slActualOrderId: 88 });
  assert.ok(r);
  assert.strictEqual(r!.reason, "TP_FILLED");
  assert.strictEqual(r!.exitPrice, 0.102);
  assert.ok(Math.abs(r!.realizedPnlUsd - 0.19) < 1e-12);
  assert.ok(Math.abs(r!.feesUsd - 0.01) < 1e-12);
});
scenario("fill of the order created by the SL algo -> SL_FILLED", () => {
  const r = buildRealCloseReport({ side: "LONG", fills: [entry, close(88, "0.099", "-0.1")], sinceMs: T0, tpOrderId: 77, slActualOrderId: 88 });
  assert.strictEqual(r!.reason, "SL_FILLED");
});
scenario("any other closing fill (Binance app, liquidation) -> POSITION_CLOSED_EXTERNALLY with real PnL", () => {
  const r = buildRealCloseReport({ side: "LONG", fills: [entry, close(55, "0.1005", "0.05")], sinceMs: T0, tpOrderId: 77, slActualOrderId: null });
  assert.strictEqual(r!.reason, "POSITION_CLOSED_EXTERNALLY");
  assert.ok(Math.abs(r!.realizedPnlUsd - 0.04) < 1e-12);
});
scenario("partial fills are volume-weighted into one exit price", () => {
  const r = buildRealCloseReport({ side: "LONG", fills: [entry, close(77, "0.102", "0.1", "50"), close(77, "0.104", "0.2", "50")], sinceMs: T0, tpOrderId: 77, slActualOrderId: null });
  assert.ok(Math.abs(r!.exitPrice - 0.103) < 1e-12);
  assert.strictEqual(r!.closedQty, 100);
});
scenario("SHORT: closing side is BUY; fills before the trade are ignored", () => {
  const old: UserTradeFill = { ...entry, side: "BUY", orderId: 5, time: T0 - 3_600_000 };
  const sEntry: UserTradeFill = { ...entry, side: "SELL", orderId: 2 };
  const sClose: UserTradeFill = { ...close(77, "0.098", "0.2"), side: "BUY" };
  const r = buildRealCloseReport({ side: "SHORT", fills: [old, sEntry, sClose], sinceMs: T0, tpOrderId: 77, slActualOrderId: null });
  assert.strictEqual(r!.reason, "TP_FILLED");
  assert.strictEqual(r!.closedQty, 100);
});
scenario("no closing fill yet -> null (caller falls back, never guesses)", () => {
  assert.strictEqual(buildRealCloseReport({ side: "LONG", fills: [entry], sinceMs: T0, tpOrderId: 77, slActualOrderId: null }), null);
});
console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
