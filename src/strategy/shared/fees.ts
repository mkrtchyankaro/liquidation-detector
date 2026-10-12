/**
 * Binance USD-M futures fees (regular tier). Fees are charged on the
 * traded NOTIONAL (qty x price), never on the risk -- a tight SL means a
 * large notional for the same $ risk, so fees weigh more in R.
 *   entry          MARKET        -> taker
 *   take profit    LIMIT         -> maker
 *   stop loss      STOP_MARKET   -> taker
 * Used to show fees on every message and to make PAPER results comparable
 * with REAL (REAL uses the exact fees Binance reports).
 */
export const TAKER_FEE = 0.0005;
export const MAKER_FEE = 0.0002;

export function estimateFeesUsd(notionalUsd: number): { tp: number; sl: number } {
  return { tp: notionalUsd * (TAKER_FEE + MAKER_FEE), sl: notionalUsd * (TAKER_FEE + TAKER_FEE) };
}
