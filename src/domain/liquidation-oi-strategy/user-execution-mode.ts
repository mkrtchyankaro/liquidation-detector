/**
 * Sep 17 2026 (Karo), operator-requested CRITICAL architecture fix.
 * Prior code treated liquidationOiExecutionEnabled=false and global
 * executionEnabled=false as "do nothing for this user" -- resulting
 * in the global signal being CANCELLED whenever real execution was
 * off, even though a market signal genuinely occurred. This function
 * is the single source of truth for the corrected 4-row matrix:
 * MARKET SIGNAL and USER EXECUTION MODE are different concepts.
 */

export type UserExecutionMode = "NONE" | "PAPER" | "REAL";

/**
 * NONE: userConfigEnabled=false -- user receives nothing, participates
 *   in nothing.
 * PAPER: either this user's own liquidationOiExecutionEnabled=false,
 *   OR (the safety fallback) it is true but the GLOBAL master switch
 *   is off -- in both cases the user gets the COMPLETE virtual
 *   lifecycle (entry, TP, SL, dynamic TP, MARKET_EXIT, close, PnL,
 *   Telegram, Mongo) with ZERO Binance calls.
 * REAL: liquidationOiExecutionEnabled=true AND global
 *   executionEnabled=true -- the only case any Binance order is ever
 *   placed.
 */
export function resolveUserExecutionMode(
  userConfigEnabled: boolean,
  liquidationOiExecutionEnabled: boolean,
  globalExecutionEnabled: boolean,
): UserExecutionMode {
  if (!userConfigEnabled) return "NONE";
  if (!liquidationOiExecutionEnabled) return "PAPER";
  if (!globalExecutionEnabled) return "PAPER";
  return "REAL";
}
