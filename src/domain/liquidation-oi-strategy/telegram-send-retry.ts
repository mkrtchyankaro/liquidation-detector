import { childLogger } from "../../infrastructure/logging/logger";

const log = childLogger({ mod: "lox-telegram-send" });

/**
 * Sep 17 2026 (Karo), operator-reported production finding -- live
 * evidence: one user received an ENTRY for BTCUSDT but not the SOL
 * signal sent moments later; another user's position closed correctly
 * (confirmed by a different user's own CLOSE message and by Mongo
 * state) but that user never received their own CLOSE notification.
 * Source audit confirmed every one of the 9 sendMessage() call sites
 * in this strategy was a single bare `await`, wrapped in a try/catch
 * that only logs -- a single transient failure (Telegram rate limit,
 * momentary network blip, a brief 5xx from Telegram's API) permanently
 * drops that one notification, even though the underlying trading
 * state transition (entry created, position closed, cleanup complete)
 * had ALREADY succeeded and was already correctly persisted in Mongo
 * before the send was ever attempted -- notification delivery and
 * trading state have always been decoupled, this only makes delivery
 * itself more resilient to short-lived blips.
 *
 * Deliberately simple and bounded: 2 retries (3 attempts total), short
 * fixed delays, never retries forever, never blocks the caller more
 * than ~1.5s worst case, and still NEVER throws back into trading
 * logic -- a message that fails all 3 attempts is logged and the
 * caller continues exactly as it did before (isolated, no effect on
 * any other user or on the position's own lifecycle).
 */

export interface TelegramLike {
  sendMessage(text: string): Promise<unknown>;
}

export async function sendTelegramWithRetry(
  telegram: TelegramLike,
  text: string,
  context: string,
): Promise<boolean> {
  const delaysMs = [0, 500, 1500];
  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    if (delaysMs[attempt]! > 0)
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]!));
    try {
      await telegram.sendMessage(text);
      if (attempt > 0)
        log.info(
          `[LOX_TELEGRAM_SEND_RECOVERED] ${context} succeeded on attempt ${attempt + 1}`,
        );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === delaysMs.length - 1) {
        log.error(
          `[LOX_TELEGRAM_SEND_FAILED_ALL_ATTEMPTS] ${context}: ${msg} -- notification lost, underlying state unaffected`,
        );
        return false;
      }
      log.warn(
        `[LOX_TELEGRAM_SEND_RETRY] ${context} attempt ${attempt + 1} failed, retrying: ${msg}`,
      );
    }
  }
  return false;
}
