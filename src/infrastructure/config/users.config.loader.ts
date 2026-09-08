import * as fs from "fs";
import { normalizeAndValidateUserId } from "../../domain/user/user-id.validator";
import type { UserConfig } from "../../domain/user/user-config.model";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "users-config" });

interface RawUsersConfigFile {
  users: Array<{
    userId: string;
    enabled: boolean;
    btcBlockEnabled?: boolean;
    telegram?: {
      enabled: boolean;
      botToken: string;
      chatIds: string[] | string;
    };
    binance?: {
      enabled: boolean;
      apiKey: string;
      apiSecret: string;
      mode: "live" | "shadow";
      orderExecutionEnabled: boolean;
      leverage: number;
      marginMode: "ISOLATED" | "CROSSED";
    };
    risk?: {
      riskUsd: number;
      accountBudgetUsd: number;
      dailyLossLimitPct: number;
    };
  }>;
}

/**
 * Sep 8 2026 (Karo). Loaded ONCE at startup, from a plain JSON file
 * (NOT .env-prefixes -- a variable-length list of users doesn't fit
 * .env naturally, per the approved architecture). Secrets never
 * committed -- see users.config.example.json (placeholder values,
 * committed) vs users.config.json (real secrets, .gitignored).
 *
 * FAILS FAST: any invalid userId, or any structurally missing
 * required field, throws here -- the whole process refuses to start
 * rather than silently running with a partially-broken user. This is
 * the ONE place userId validation happens before any Mongo collection
 * name is ever built from it (see domain/user/user-id.validator.ts's
 * own doc comment for the full defense-in-depth reasoning).
 */
export function loadUsersConfig(filePath: string): UserConfig[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `users config file not found at ${filePath} -- copy users.config.example.json and fill in real values.`,
    );
  }
  const raw = JSON.parse(
    fs.readFileSync(filePath, "utf8"),
  ) as RawUsersConfigFile;
  if (!Array.isArray(raw.users) || raw.users.length === 0) {
    throw new Error(
      `users config at ${filePath} must have a non-empty "users" array.`,
    );
  }

  const seenIds = new Set<string>();
  const result: UserConfig[] = [];

  for (const u of raw.users) {
    const userId = normalizeAndValidateUserId(u.userId); // throws on invalid -- fail-fast
    if (seenIds.has(userId)) {
      throw new Error(
        `duplicate userId "${userId}" in users config -- each user must be unique.`,
      );
    }
    seenIds.add(userId);

    // Sep 8 2026 (Karo) -- `risk` is only REQUIRED when this user
    // actually trades (binance.enabled===true) -- a Telegram-only
    // monitoring destination (e.g. "main", a test server that never
    // executes) has no meaningful risk-per-trade to configure at all.
    // When binance is absent/disabled, risk defaults to the same
    // safe fallback DailyLossLimitTracker itself already uses
    // internally (500/5) if unconfigured -- never blocks startup.
    const binanceWillTrade = Boolean(u.binance && u.binance.enabled);
    if (
      binanceWillTrade &&
      (!u.risk ||
        typeof u.risk.riskUsd !== "number" ||
        typeof u.risk.accountBudgetUsd !== "number" ||
        typeof u.risk.dailyLossLimitPct !== "number")
    ) {
      throw new Error(
        `user "${userId}" has binance.enabled=true but is missing required risk config (riskUsd/accountBudgetUsd/dailyLossLimitPct).`,
      );
    }
    const risk = {
      riskUsd: u.risk?.riskUsd ?? 10,
      accountBudgetUsd: u.risk?.accountBudgetUsd ?? 500,
      dailyLossLimitPct: u.risk?.dailyLossLimitPct ?? 5,
    };

    const telegram = u.telegram
      ? {
          enabled: u.telegram.enabled,
          botToken: u.telegram.botToken,
          // Sep 8 2026 (Karo) -- accepts either a real JSON array
          // (["111","222"]) or a comma-separated string ("111,222"),
          // matching liqwatch-bot's own TELEGRAM_CHAT_ID convenience
          // parsing exactly. Always normalized to string[] here.
          chatIds: Array.isArray(u.telegram.chatIds)
            ? u.telegram.chatIds
                .map((id) => id.trim())
                .filter((id) => id.length > 0)
            : u.telegram.chatIds
                .split(",")
                .map((id) => id.trim())
                .filter((id) => id.length > 0),
        }
      : null;

    if (telegram?.enabled && telegram.chatIds.length === 0) {
      throw new Error(
        `user "${userId}" has telegram.enabled=true but no valid chatIds -- fix users.config.json`,
      );
    }
    const binance = u.binance
      ? {
          enabled: u.binance.enabled,
          apiKey: u.binance.apiKey,
          apiSecret: u.binance.apiSecret,
          mode: u.binance.mode,
          orderExecutionEnabled: u.binance.orderExecutionEnabled ?? false,
          leverage: u.binance.leverage,
          marginMode: u.binance.marginMode,
        }
      : null;

    result.push({
      userId,
      enabled: u.enabled,
      // Sep 8 2026 (Karo) -- defaults to false (safe default: block
      // NOT enforced) if omitted, matching liqwatch-bot's own
      // V5_BTC_BLOCK default.
      btcBlockEnabled: u.btcBlockEnabled ?? false,
      telegram,
      binance,
      risk,
    });
  }

  const enabledCount = result.filter((u) => u.enabled).length;
  log.info(
    `loaded ${result.length} user(s) from config, ${enabledCount} enabled: [${result.map((u) => u.userId).join(", ")}]`,
  );
  return result;
}
