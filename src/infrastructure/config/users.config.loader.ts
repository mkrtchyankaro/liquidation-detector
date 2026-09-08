import * as fs from "fs";
import { normalizeAndValidateUserId } from "../../domain/user/user-id.validator";
import type { UserConfig } from "../../domain/user/user-config.model";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "users-config" });

interface RawUsersConfigFile {
  users: Array<{
    userId: string;
    enabled: boolean;
    telegram?: { enabled: boolean; botToken: string; chatId: string };
    binance?: {
      enabled: boolean;
      apiKey: string;
      apiSecret: string;
      mode: "live" | "shadow";
      orderExecutionEnabled: boolean;
      leverage: number;
      marginMode: "ISOLATED" | "CROSSED";
    };
    risk: { riskUsd: number; accountBudgetUsd: number; dailyLossLimitPct: number };
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
    throw new Error(`users config file not found at ${filePath} -- copy users.config.example.json and fill in real values.`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RawUsersConfigFile;
  if (!Array.isArray(raw.users) || raw.users.length === 0) {
    throw new Error(`users config at ${filePath} must have a non-empty "users" array.`);
  }

  const seenIds = new Set<string>();
  const result: UserConfig[] = [];

  for (const u of raw.users) {
    const userId = normalizeAndValidateUserId(u.userId); // throws on invalid -- fail-fast
    if (seenIds.has(userId)) {
      throw new Error(`duplicate userId "${userId}" in users config -- each user must be unique.`);
    }
    seenIds.add(userId);

    if (!u.risk || typeof u.risk.riskUsd !== "number" || typeof u.risk.accountBudgetUsd !== "number" || typeof u.risk.dailyLossLimitPct !== "number") {
      throw new Error(`user "${userId}" is missing required risk config (riskUsd/accountBudgetUsd/dailyLossLimitPct).`);
    }

    const telegram = u.telegram
      ? { enabled: u.telegram.enabled, botToken: u.telegram.botToken, chatId: u.telegram.chatId }
      : null;
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
      telegram,
      binance,
      risk: { riskUsd: u.risk.riskUsd, accountBudgetUsd: u.risk.accountBudgetUsd, dailyLossLimitPct: u.risk.dailyLossLimitPct },
    });
  }

  const enabledCount = result.filter((u) => u.enabled).length;
  log.info(`loaded ${result.length} user(s) from config, ${enabledCount} enabled: [${result.map((u) => u.userId).join(", ")}]`);
  return result;
}
