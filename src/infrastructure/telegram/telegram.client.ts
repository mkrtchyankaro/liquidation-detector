import axios, { type AxiosInstance } from 'axios';
import type { TelegramConfig } from '../config/integrations.config';
import { childLogger } from '../logging/logger';

export interface TelegramChatSendResult {
  chatId: string;
  ok: boolean;
  messageId?: number;
  error?: string;
}

export interface TelegramSendResult {
  /** True only when EVERY chat received the message successfully. */
  ok: boolean;
  /** Per-chat results for observability. */
  results: TelegramChatSendResult[];
  /** First error encountered across chats, for convenience logging. */
  error?: string;
}

/**
 * Minimal Telegram Bot API client that fans out a single message to ONE or
 * MANY chat IDs.
 *
 *   - `TELEGRAM_CHAT_ID` may be a comma-separated list; each id gets its own
 *     sendMessage call.
 *   - Per-chat failures do not abort the overall send — other chats still
 *     receive the message. Caller sees `ok: false` if ANY chat failed.
 *   - One silent retry per chat on transient network errors.
 */
export class TelegramClient {
  private readonly log = childLogger({ mod: 'telegram' });
  private readonly http: AxiosInstance | null;

  constructor(private readonly cfg: TelegramConfig) {
    this.http = cfg.enabled
      ? axios.create({
          baseURL: `https://api.telegram.org/bot${cfg.botToken}`,
          timeout: 10_000,
        })
      : null;
    if (!cfg.enabled) {
      this.log.warn('telegram disabled (missing token or chat ids); messages will be no-ops');
    } else {
      this.log.info({ chatCount: cfg.chatIds.length }, 'telegram client ready');
    }
  }

  get isEnabled(): boolean { return this.cfg.enabled; }

  async sendMessage(text: string, opts: { silent?: boolean } = {}): Promise<TelegramSendResult> {
    if (!this.http) {
      return { ok: false, results: [], error: 'telegram-disabled' };
    }
    const results = await Promise.all(
      this.cfg.chatIds.map((chatId) => this.sendToChat(chatId, text, opts)),
    );
    const firstError = results.find((r) => !r.ok)?.error;
    const allOk = results.every((r) => r.ok);
    return { ok: allOk, results, error: firstError };
  }

  private async sendToChat(
    chatId: string,
    text: string,
    opts: { silent?: boolean },
  ): Promise<TelegramChatSendResult> {
    if (!this.http) return { chatId, ok: false, error: 'telegram-disabled' };

    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_notification: opts.silent ?? this.cfg.disableNotification,
      disable_web_page_preview: true,
    };
    if (this.cfg.parseMode !== 'none') payload.parse_mode = this.cfg.parseMode;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await this.http.post<{ ok: boolean; result?: { message_id: number }; description?: string }>(
          '/sendMessage',
          payload,
        );
        if (res.data.ok && res.data.result) {
          this.log.info(
            { chatId, messageId: res.data.result.message_id, len: text.length },
            'telegram message sent',
          );
          return { chatId, ok: true, messageId: res.data.result.message_id };
        }
        this.log.warn({ chatId, description: res.data.description }, 'telegram send returned not-ok');
        return { chatId, ok: false, error: res.data.description ?? 'unknown' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === 2) {
          this.log.error({ chatId, err: msg }, 'telegram send failed after retry');
          return { chatId, ok: false, error: msg };
        }
        this.log.warn({ chatId, err: msg, attempt }, 'telegram send failed, retrying');
      }
    }
    return { chatId, ok: false, error: 'exhausted-retries' };
  }
}
