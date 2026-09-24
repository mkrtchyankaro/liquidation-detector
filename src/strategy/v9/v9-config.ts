import * as fs from "fs";

/**
 * V9 live settings -- read from users.config.json, top-level "v9" block:
 *
 *   "v9": {
 *     "enabled": true,
 *     "symbols": ["BTCUSDT", "ETHUSDT"],
 *     "rr": 2.2,
 *     "userModes": { "main": "PAPER", "karo": "REAL", "artak": "REAL" }
 *   }
 *
 * Absent block -> V9 disabled. Any malformed value fails startup with a
 * clear message (a typo must never silently arm or disarm real trading).
 * A user not listed in userModes is OFF for V9.
 */
export type V9UserMode = "OFF" | "PAPER" | "REAL";

export interface V9Settings {
  enabled: boolean;
  symbols: string[];
  rr: number;
  /** Minimum SL distance in percent (default 0.33). */
  minSlPct: number;
  userModes: Map<string, V9UserMode>;
}

export function parseV9Settings(raw: unknown, knownUserIds: readonly string[], collectedSymbols: readonly string[]): V9Settings {
  const off: V9Settings = { enabled: false, symbols: [], rr: 2.2, minSlPct: 0.33, userModes: new Map() };
  if (raw === undefined || raw === null) return off;
  if (typeof raw !== "object") throw new Error(`"v9" must be an object`);
  const v = raw as Record<string, unknown>;
  if (typeof v.enabled !== "boolean") throw new Error(`"v9.enabled" must be true or false`);
  if (!v.enabled) return off;

  if (!Array.isArray(v.symbols) || v.symbols.length === 0 || !v.symbols.every((s) => typeof s === "string")) {
    throw new Error(`"v9.symbols" must be a non-empty array of symbols, e.g. ["BTCUSDT","ETHUSDT"]`);
  }
  const symbols = [...new Set((v.symbols as string[]).map((s) => s.trim().toUpperCase()))];
  const missing = symbols.filter((s) => !collectedSymbols.includes(s));
  if (missing.length) {
    throw new Error(`"v9.symbols" contains ${missing.join(", ")} which this bot does not collect data for (SYMBOLS env: ${collectedSymbols.join(", ")})`);
  }

  const rr = v.rr === undefined ? 2.2 : v.rr;
  if (typeof rr !== "number" || !(rr > 0) || rr > 20) throw new Error(`"v9.rr" must be a number between 0 and 20`);
  const minSlPct = v.minSlPct === undefined ? 0.33 : v.minSlPct;
  if (typeof minSlPct !== "number" || !(minSlPct >= 0) || minSlPct > 5) throw new Error(`"v9.minSlPct" must be a number between 0 and 5 (percent)`);

  const userModes = new Map<string, V9UserMode>();
  if (v.userModes !== undefined) {
    if (typeof v.userModes !== "object" || v.userModes === null) throw new Error(`"v9.userModes" must be an object like {"karo":"REAL"}`);
    for (const [userId, mode] of Object.entries(v.userModes as Record<string, unknown>)) {
      if (!knownUserIds.includes(userId)) throw new Error(`"v9.userModes" has unknown user "${userId}" (known: ${knownUserIds.join(", ")})`);
      if (mode !== "OFF" && mode !== "PAPER" && mode !== "REAL") throw new Error(`"v9.userModes.${userId}" must be "OFF", "PAPER" or "REAL" (got ${JSON.stringify(mode)})`);
      userModes.set(userId, mode);
    }
  }
  return { enabled: true, symbols, rr, minSlPct, userModes };
}

export function loadV9Settings(filePath: string, knownUserIds: readonly string[], collectedSymbols: readonly string[]): V9Settings {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { v9?: unknown };
  try {
    return parseV9Settings(raw.v9, knownUserIds, collectedSymbols);
  } catch (err) {
    throw new Error(`users config at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
