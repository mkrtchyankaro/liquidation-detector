import type { GlobalSignalDoc } from "../../domain/signal/global-signal.model";
import type { UserRuntime } from "../../services/user-runtime";
import { formatV5EntryMessage } from "../../infrastructure/telegram/signal.formatter";
import { childLogger } from "../../infrastructure/logging/logger";
import type { V5SignalEvent } from "../../strategy/v5/v5-wave.service";

const log = childLogger({ mod: "notify-user" });

/** Sep 8 2026 (Karo). formatV5EntryMessage is REUSED, byte-identical,
 *  from liqwatch-bot's own strategy-v2/v5/v5-signal.formatter.ts. It
 *  takes a V5SignalEvent shape; globalSignal (GlobalSignalDoc) already
 *  carries every field that formatter needs. */
export async function notifyUser(globalSignal: GlobalSignalDoc, runtime: UserRuntime): Promise<boolean> {
  if (!runtime.telegram || !runtime.config.telegram?.enabled) return false;
  try {
    const message = formatV5EntryMessage(globalSignal as unknown as V5SignalEvent);
    await runtime.telegram.sendMessage(message);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, userId: runtime.config.userId, signalId: globalSignal.signalId }, "[USER_TELEGRAM_SEND_FAILED] -- isolated, other users unaffected");
    return false;
  }
}

export async function notifyUserClose(
  message: string,
  runtime: UserRuntime,
): Promise<void> {
  if (!runtime.telegram || !runtime.config.telegram?.enabled) return;
  try {
    await runtime.telegram.sendMessage(message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, userId: runtime.config.userId }, "[USER_TELEGRAM_CLOSE_SEND_FAILED]");
  }
}
