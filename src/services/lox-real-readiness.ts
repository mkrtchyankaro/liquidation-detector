import { childLogger } from "../infrastructure/logging/logger";

const log = childLogger({ mod: "lox-real-readiness" });

export interface ReadinessRest {
  getBalance(): Promise<unknown>;
  getPositionMode(): Promise<unknown>;
}

export type ReadinessResult =
  | { ok: true; availableUsdt: number }
  | { ok: false; reason: string };

/**
 * One-time startup check for a user that is configured for REAL LOX
 * orders. Proves, BEFORE any signal arrives, that this user's Binance
 * account can actually take the orders this bot sends:
 *   1. API key/secret are valid and can read the futures balance.
 *   2. Account is in One-Way mode (the bot never sends positionSide;
 *      Binance rejects such orders in Hedge Mode, error -4061).
 *   3. There is some USDT available.
 * A user that fails any check runs PAPER until the next restart, with the
 * reason logged and sent to that user's Telegram -- never a silent
 * REAL->nothing failure at the moment a real signal arrives.
 */
export async function checkLoxRealReadiness(userId: string, rest: ReadinessRest): Promise<ReadinessResult> {
  let availableUsdt = 0;
  try {
    const balances = (await rest.getBalance()) as Array<{ asset: string; availableBalance?: string; balance?: string }>;
    const usdt = Array.isArray(balances) ? balances.find((b) => b.asset === "USDT") : undefined;
    availableUsdt = Number(usdt?.availableBalance ?? usdt?.balance ?? 0);
  } catch (err) {
    return { ok: false, reason: `API key cannot read futures balance: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const mode = (await rest.getPositionMode()) as { dualSidePosition?: boolean };
    if (mode?.dualSidePosition === true) {
      return { ok: false, reason: "account is in HEDGE mode -- switch Binance Futures to One-Way mode (Preferences -> Position Mode)" };
    }
  } catch (err) {
    return { ok: false, reason: `cannot read position mode: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!(availableUsdt > 0)) {
    return { ok: false, reason: "no available USDT in the futures wallet" };
  }
  log.info(`[LOX_REAL_READY] userId=${userId} availableUsdt=${availableUsdt.toFixed(2)}`);
  return { ok: true, availableUsdt };
}
