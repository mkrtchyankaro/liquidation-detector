import * as fs from "fs";
import { parseV9Settings, type V9Settings } from "../strategy/v9/v9-config";
import { parseZzSettings, type ZzSettings } from "../strategy/zz/zz-config";

/**
 * users.config.json -- the ONE file that decides who trades what.
 *
 * {
 *   "realOrdersEnabled": false,          // global master switch for REAL Binance orders
 *   "v9": { "enabled": true, "symbols": [...], "rr": 2.2,
 *           "userModes": { "main": "PAPER", "karo": "REAL" } },
 *   "zz": { "enabled": true, "users": ["main"] },   // OI-zigzag, PAPER only
 *   "users": [
 *     { "userId": "karo", "enabled": true,
 *       "telegram": { "enabled": true, "botToken": "...", "chatIds": ["123"] },
 *       "binance":  { "enabled": true, "apiKey": "...", "apiSecret": "...",
 *                     "leverage": 20, "marginMode": "ISOLATED" },
 *       "risk": { "riskUsd": 1 } }
 *   ]
 * }
 *
 * Unknown/old fields are ignored. Any malformed value fails startup with a
 * clear message -- a typo must never silently arm or disarm real trading.
 */
export interface UserConfig {
  userId: string;
  enabled: boolean;
  telegram: { botToken: string; chatIds: string[] } | null;
  binance: { apiKey: string; apiSecret: string; leverage: number; marginMode: "ISOLATED" | "CROSSED" } | null;
  riskUsd: number;
}

export interface AppConfig {
  realOrdersEnabled: boolean;
  users: UserConfig[];
  v9: V9Settings;
  /** OI-zigzag strategy, PAPER only (Telegram messages, never orders). */
  zz: ZzSettings;
}

const USER_ID = /^[a-z][a-z0-9_-]{1,31}$/;

function fail(path: string, msg: string): never {
  throw new Error(`users config at ${path}: ${msg}`);
}

export function parseAppConfig(raw: unknown, path: string, collectedSymbols: readonly string[]): AppConfig {
  if (typeof raw !== "object" || raw === null) fail(path, "must be a JSON object");
  const r = raw as Record<string, unknown>;
  if (r.realOrdersEnabled !== undefined && typeof r.realOrdersEnabled !== "boolean") fail(path, `"realOrdersEnabled" must be true or false`);
  if (!Array.isArray(r.users) || r.users.length === 0) fail(path, `"users" must be a non-empty array`);

  const seen = new Set<string>();
  const users: UserConfig[] = (r.users as Array<Record<string, unknown>>).map((u, i) => {
    const userId = typeof u.userId === "string" ? u.userId.trim().toLowerCase() : "";
    if (!USER_ID.test(userId)) fail(path, `users[${i}].userId "${String(u.userId)}" must be 2-32 chars: a-z, 0-9, _ or -, starting with a letter`);
    if (seen.has(userId)) fail(path, `duplicate userId "${userId}"`);
    seen.add(userId);
    const where = `user "${userId}"`;

    let telegram: UserConfig["telegram"] = null;
    const t = u.telegram as Record<string, unknown> | undefined;
    if (t && t.enabled === true) {
      const chatIds = (Array.isArray(t.chatIds) ? t.chatIds.map(String) : String(t.chatIds ?? "").split(",")).map((c) => c.trim()).filter(Boolean);
      if (typeof t.botToken !== "string" || !t.botToken || chatIds.length === 0) fail(path, `${where}: telegram.enabled=true needs botToken and chatIds`);
      telegram = { botToken: t.botToken, chatIds };
    }

    let binance: UserConfig["binance"] = null;
    const b = u.binance as Record<string, unknown> | undefined;
    if (b && b.enabled === true) {
      if (typeof b.apiKey !== "string" || !b.apiKey || typeof b.apiSecret !== "string" || !b.apiSecret) fail(path, `${where}: binance.enabled=true needs apiKey and apiSecret`);
      const leverage = b.leverage ?? 20;
      if (typeof leverage !== "number" || !Number.isInteger(leverage) || leverage < 1 || leverage > 125) fail(path, `${where}: binance.leverage must be an integer 1..125`);
      const marginMode = b.marginMode ?? "ISOLATED";
      if (marginMode !== "ISOLATED" && marginMode !== "CROSSED") fail(path, `${where}: binance.marginMode must be "ISOLATED" or "CROSSED"`);
      binance = { apiKey: b.apiKey, apiSecret: b.apiSecret, leverage, marginMode };
    }

    const risk = u.risk as Record<string, unknown> | undefined;
    const riskUsd = risk?.riskUsd ?? 10;
    if (typeof riskUsd !== "number" || !(riskUsd > 0)) fail(path, `${where}: risk.riskUsd must be a positive number`);

    return { userId, enabled: u.enabled !== false, telegram, binance, riskUsd };
  });

  let v9: V9Settings;
  try {
    v9 = parseV9Settings(r.v9, users.map((u) => u.userId), collectedSymbols);
  } catch (err) {
    fail(path, err instanceof Error ? err.message : String(err));
  }
  let zz: ZzSettings;
  try {
    zz = parseZzSettings(r.zz, users.map((u) => u.userId), collectedSymbols);
  } catch (err) {
    fail(path, err instanceof Error ? err.message : String(err));
  }
  return { realOrdersEnabled: r.realOrdersEnabled === true, users, v9, zz };
}

export function loadAppConfig(path: string, collectedSymbols: readonly string[]): AppConfig {
  if (!fs.existsSync(path)) throw new Error(`users config not found at ${path} -- copy users.config.example.json and fill in real values`);
  return parseAppConfig(JSON.parse(fs.readFileSync(path, "utf8")), path, collectedSymbols);
}
