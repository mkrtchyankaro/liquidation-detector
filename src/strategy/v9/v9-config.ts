import * as fs from "fs";

/**
 * V9 live settings -- read from users.config.json, top-level "v9" block:
 *
 *   "v9": {
 *     "enabled": true,
 *     "symbols": ["BTCUSDT", "ETHUSDT"],
 *     "rr": 2.2,
 *     "lateSlPct": 0,          // optional: OITURN late-entry stop (0 = always, absent = off)
 *     "timeStopHours": 24,     // optional: a trade still open after 24h is closed at market (absent = off)
 *     "forcedOnlyUsers": ["karo"], // optional: these users get ONLY signals whose cleaning was
 *                              //   forced (liquidation share >= the coin's median); others get all
 *     "frameOnlyUsers": ["karo"], // optional: these users get ONLY signals whose cleaning reached the
 *                              //   edge of the 4h frame (bottom zone for BUY, top zone for SELL)
 *     "lateSlMinPct": 0.6,     // optional: use the OITURN stop only if >= 0.6% from the entry
 *                              //   (closer = noise -> the stop stays at the episode extreme)
 *     "maxOpenPerUser": { "karo": 2, "artak": 2 }, // optional: at most N V9 trades open at once for
 *                              //   that user (all coins together); a new signal while N are open is
 *                              //   skipped for that user only. Users not listed: no limit.
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
  /** Late-entry stop ("OITURN"): when the stop at the episode extreme is
   *  farther than this % from the entry, the stop moves to where the
   *  confirming OI drop started (only if closer). 0 = always, null = off. */
  lateSlPct: number | null;
  /** OITURN stop used only if at least this % from the entry, else the stop
   *  stays at the episode extreme. null = no minimum. Needs lateSlPct. */
  lateSlMinPct: number | null;
  /** Users who only take signals with a FORCED cleaning (quality.weak = false). */
  forcedOnlyUsers: Set<string>;
  /** Users who only take signals at the edge of the 4h frame (frame.verdict = IN_ZONE). */
  frameOnlyUsers: Set<string>;
  /** Close a still-open trade at market after this many hours (null = off). */
  timeStopHours: number | null;
  /** at most N open V9 trades per user (all symbols together); absent user = no limit */
  maxOpenPerUser: Map<string, number>;
  userModes: Map<string, V9UserMode>;
}

export function parseV9Settings(raw: unknown, knownUserIds: readonly string[], collectedSymbols: readonly string[]): V9Settings {
  const off: V9Settings = { enabled: false, symbols: [], rr: 2.2, minSlPct: 0.33, lateSlPct: null, lateSlMinPct: null, forcedOnlyUsers: new Set(), frameOnlyUsers: new Set(), timeStopHours: null, maxOpenPerUser: new Map(), userModes: new Map() };
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
  const lateSlPct = v.lateSlPct === undefined || v.lateSlPct === null ? null : v.lateSlPct;
  if (lateSlPct !== null && (typeof lateSlPct !== "number" || !(lateSlPct >= 0) || lateSlPct > 10)) throw new Error(`"v9.lateSlPct" must be null (off) or a number between 0 and 10 (percent; 0 = always)`);
  const lateSlMinPct = v.lateSlMinPct === undefined || v.lateSlMinPct === null ? null : v.lateSlMinPct;
  if (lateSlMinPct !== null && (typeof lateSlMinPct !== "number" || !(lateSlMinPct >= 0) || lateSlMinPct > 5)) throw new Error(`"v9.lateSlMinPct" must be null (off) or a number between 0 and 5 (percent)`);
  if (lateSlMinPct !== null && lateSlPct === null) throw new Error(`"v9.lateSlMinPct" only works together with "v9.lateSlPct" (set "lateSlPct": 0)`);
  const forcedOnlyUsers = new Set<string>();
  if (v.forcedOnlyUsers !== undefined) {
    if (!Array.isArray(v.forcedOnlyUsers) || !v.forcedOnlyUsers.every((x) => typeof x === "string")) throw new Error(`"v9.forcedOnlyUsers" must be an array of user ids, e.g. ["karo","artak"]`);
    for (const id of v.forcedOnlyUsers as string[]) {
      if (!knownUserIds.includes(id)) throw new Error(`"v9.forcedOnlyUsers" has unknown user "${id}" (known: ${knownUserIds.join(", ")})`);
      forcedOnlyUsers.add(id);
    }
  }
  const frameOnlyUsers = new Set<string>();
  if (v.frameOnlyUsers !== undefined) {
    if (!Array.isArray(v.frameOnlyUsers) || !v.frameOnlyUsers.every((x) => typeof x === "string")) throw new Error(`"v9.frameOnlyUsers" must be an array of user ids, e.g. ["karo","artak"]`);
    for (const id of v.frameOnlyUsers as string[]) {
      if (!knownUserIds.includes(id)) throw new Error(`"v9.frameOnlyUsers" has unknown user "${id}" (known: ${knownUserIds.join(", ")})`);
      frameOnlyUsers.add(id);
    }
  }
  const timeStopHours = v.timeStopHours === undefined || v.timeStopHours === null ? null : v.timeStopHours;
  if (timeStopHours !== null && (typeof timeStopHours !== "number" || !(timeStopHours >= 1) || timeStopHours > 240)) throw new Error(`"v9.timeStopHours" must be null (off) or a number of hours between 1 and 240`);
  const maxOpenPerUser = new Map<string, number>();
  if (v.maxOpenPerUser !== undefined && v.maxOpenPerUser !== null) {
    if (typeof v.maxOpenPerUser !== "object" || Array.isArray(v.maxOpenPerUser)) throw new Error(`"v9.maxOpenPerUser" must be an object like {"karo":2,"artak":2}`);
    for (const [userId, n] of Object.entries(v.maxOpenPerUser as Record<string, unknown>)) {
      if (!knownUserIds.includes(userId)) throw new Error(`"v9.maxOpenPerUser" has unknown user "${userId}" (known: ${knownUserIds.join(", ")})`);
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 50) throw new Error(`"v9.maxOpenPerUser.${userId}" must be a whole number between 1 and 50 (got ${JSON.stringify(n)})`);
      maxOpenPerUser.set(userId, n);
    }
  }
  return { enabled: true, symbols, rr, minSlPct, lateSlPct, lateSlMinPct, forcedOnlyUsers, frameOnlyUsers, timeStopHours, maxOpenPerUser, userModes };
}

export function loadV9Settings(filePath: string, knownUserIds: readonly string[], collectedSymbols: readonly string[]): V9Settings {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { v9?: unknown };
  try {
    return parseV9Settings(raw.v9, knownUserIds, collectedSymbols);
  } catch (err) {
    throw new Error(`users config at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
