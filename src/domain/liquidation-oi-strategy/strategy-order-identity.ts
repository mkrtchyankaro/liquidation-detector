import { createHash } from "crypto";

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 1.
 *
 * The existing V3 clientOrderId() (binance-execution.service.ts) uses
 * `v3${kind}${cleanedSignalId}` -- confirmed by direct inspection.
 * This strategy uses a DISTINCT prefix ("lox" -- Liquidation-OI
 * eXhaustion) so its orders can never collide with or be mistaken for
 * V3's, and encodes MORE identity (userId + globalSignalId + purpose +
 * revision) than V3's scheme does, which does not fit as literal text
 * within Binance's clientOrderId length limit. A deterministic short
 * hash is used instead -- the AUTHORITATIVE human-readable mapping
 * lives in the strategy_orders Mongo collection (separate file),
 * never decoded from the ID itself.
 *
 * Binance USDS-M Futures clientOrderId/clientAlgoId limit: 36
 * characters. This scheme produces exactly 23: 3-char prefix + 20 hex
 * chars (80 bits) of a SHA-256 digest -- collision-safe for this
 * project's realistic order volume, with headroom under the 36-char
 * cap.
 */

const PREFIX = "lox";
const HASH_HEX_LENGTH = 20;

export type StrategyOrderPurpose = "ENTRY" | "TAKE_PROFIT" | "STOP_LOSS" | "MARKET_EXIT" | "FAILSAFE_CLOSE";

/** Deterministic: the SAME (userId, globalSignalId, purpose, revision)
 *  ALWAYS produces the SAME id -- this is what makes retrying a failed
 *  placement safe. */
export function strategyClientOrderId(userId: string, globalSignalId: string, purpose: StrategyOrderPurpose, revision: number): string {
  const digest = createHash("sha256").update(`${userId}|${globalSignalId}|${purpose}|${revision}`).digest("hex").slice(0, HASH_HEX_LENGTH);
  const id = `${PREFIX}${digest}`;
  if (id.length > 36) throw new Error(`strategyClientOrderId exceeded Binance's 36-char limit: "${id}" (${id.length} chars)`);
  return id;
}

/** Confirms an id was produced by THIS strategy's scheme (by prefix)
 *  -- never used to decode identity; the Mongo strategy_orders row is
 *  the only source of the actual fields for a given id. Used by
 *  startup orphan recovery to filter candidates before consulting
 *  Mongo, and to positively rule OUT legacy V3 orders (prefix "v3")
 *  and manual/unrelated orders. */
export function isStrategyOwnedOrderId(clientOrderId: string): boolean {
  return clientOrderId.startsWith(PREFIX) && clientOrderId.length === PREFIX.length + HASH_HEX_LENGTH;
}
