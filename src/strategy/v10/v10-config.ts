/**
 * V10 settings (BTC-led alts, Johnny Oct 2 2026) -- users.config.json, top-level "v10" block:
 *
 *   "v10": {
 *     "enabled": true,
 *     "short": true,              // BTC top (15m DC + OI rule, RANK 1)  -> SHORT the alts that rose most with BTC
 *     "long": false,              // BTC bottom (the mirror)             -> LONG the alts that fell most with BTC
 *     "slPct": 1,                 // SL this % from the entry (against the trade)
 *     "tpPct": 1,                 // TP this % from the entry (with the trade)
 *     "picks": 3,                 // how many alts per BTC signal
 *     "rankWindowHours": 12,      // RANK 1 = the move's |OI change| is bigger than every BTC move of these hours before it
 *     "symbols": ["ETHUSDT", ...],// optional: the alts to choose from (default: every collected symbol except BTCUSDT)
 *     "userModes": { "main": "PAPER", "karo": "OFF", "artak": "OFF" },   // OFF | PAPER | REAL
 *     "perUser": { "karo": { "short": true, "long": false, "slPct": 1, "tpPct": 1, "maxOpen": 3 } }  // optional overrides
 *   }
 *
 * Every field of "perUser" is optional; a missing one uses the block's value. maxOpen = at most N V10 trades open at
 * once for that user (absent = no limit). Absent block -> V10 disabled. A user not in userModes is OFF.
 * Any malformed value fails startup with a clear message -- a typo must never silently arm or disarm real trading.
 */
export type V10UserMode = "OFF" | "PAPER" | "REAL";

export interface V10UserRules {
  short: boolean;
  long: boolean;
  slPct: number;
  tpPct: number;
  maxOpen: number | null;
}

export interface V10Settings {
  enabled: boolean;
  short: boolean;
  long: boolean;
  slPct: number;
  tpPct: number;
  picks: number;
  rankWindowHours: number;
  /** the alts to choose from (never BTCUSDT) */
  symbols: string[];
  userModes: Map<string, V10UserMode>;
  perUser: Map<string, Partial<V10UserRules>>;
}

export const BTC = "BTCUSDT";

/** the rules that apply to one user: the block's values, overridden by perUser */
export function rulesFor(s: V10Settings, userId: string): V10UserRules {
  const o = s.perUser.get(userId) ?? {};
  return {
    short: o.short ?? s.short,
    long: o.long ?? s.long,
    slPct: o.slPct ?? s.slPct,
    tpPct: o.tpPct ?? s.tpPct,
    maxOpen: o.maxOpen ?? null,
  };
}

const isNum = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

export function parseV10Settings(
  raw: unknown,
  knownUserIds: readonly string[],
  collectedSymbols: readonly string[],
): V10Settings {
  const off: V10Settings = {
    enabled: false,
    short: true,
    long: false,
    slPct: 1,
    tpPct: 1,
    picks: 3,
    rankWindowHours: 12,
    symbols: [],
    userModes: new Map(),
    perUser: new Map(),
  };
  if (raw === undefined || raw === null) return off;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`"v10" must be an object`);
  const v = raw as Record<string, unknown>;
  const KNOWN = [
    "enabled",
    "short",
    "long",
    "slPct",
    "tpPct",
    "picks",
    "rankWindowHours",
    "symbols",
    "userModes",
    "perUser",
  ];
  for (const k of Object.keys(v))
    if (!KNOWN.includes(k))
      throw new Error(
        `"v10.${k}" is not a known setting (${KNOWN.join(", ")}) -- check the spelling`,
      );
  if (typeof v.enabled !== "boolean")
    throw new Error(`"v10.enabled" must be true or false`);
  if (!v.enabled) return off;
  if (!collectedSymbols.includes(BTC))
    throw new Error(
      `"v10" needs ${BTC} in SYMBOLS (.env) -- its signals come from BTC`,
    );

  const bool = (k: string, d: boolean): boolean => {
    if (v[k] === undefined) return d;
    if (typeof v[k] !== "boolean")
      throw new Error(`"v10.${k}" must be true or false`);
    return v[k] as boolean;
  };
  const num = (
    k: string,
    d: number,
    lo: number,
    hi: number,
    what: string,
  ): number => {
    if (v[k] === undefined) return d;
    if (!isNum(v[k], lo, hi))
      throw new Error(
        `"v10.${k}" must be ${what} (got ${JSON.stringify(v[k])})`,
      );
    return v[k] as number;
  };
  const short = bool("short", true),
    long = bool("long", false);
  const slPct = num("slPct", 1, 0.1, 10, "a percent between 0.1 and 10");
  const tpPct = num("tpPct", 1, 0.1, 20, "a percent between 0.1 and 20");
  const picks = num("picks", 3, 1, 10, "a whole number between 1 and 10");
  if (!Number.isInteger(picks))
    throw new Error(`"v10.picks" must be a whole number between 1 and 10`);
  const rankWindowHours = num(
    "rankWindowHours",
    12,
    1,
    72,
    "a number of hours between 1 and 72",
  );

  let symbols = collectedSymbols.filter((s) => s !== BTC);
  if (v.symbols !== undefined) {
    if (
      !Array.isArray(v.symbols) ||
      v.symbols.length === 0 ||
      !v.symbols.every((s) => typeof s === "string")
    )
      throw new Error(`"v10.symbols" must be a non-empty array of symbols`);
    symbols = [
      ...new Set((v.symbols as string[]).map((s) => s.trim().toUpperCase())),
    ];
    if (symbols.includes(BTC))
      throw new Error(
        `"v10.symbols" must not contain ${BTC} -- V10 trades the alts, BTC only gives the signal`,
      );
    const missing = symbols.filter((s) => !collectedSymbols.includes(s));
    if (missing.length)
      throw new Error(
        `"v10.symbols" contains ${missing.join(", ")} which this bot does not collect data for`,
      );
  }
  if (symbols.length === 0)
    throw new Error(`"v10" has no alts to trade (SYMBOLS has only BTCUSDT)`);

  const userModes = new Map<string, V10UserMode>();
  if (v.userModes !== undefined) {
    if (
      typeof v.userModes !== "object" ||
      v.userModes === null ||
      Array.isArray(v.userModes)
    )
      throw new Error(
        `"v10.userModes" must be an object like {"main":"PAPER"}`,
      );
    for (const [userId, mode] of Object.entries(
      v.userModes as Record<string, unknown>,
    )) {
      if (!knownUserIds.includes(userId))
        throw new Error(
          `"v10.userModes" has unknown user "${userId}" (known: ${knownUserIds.join(", ")})`,
        );
      if (mode !== "OFF" && mode !== "PAPER" && mode !== "REAL")
        throw new Error(
          `"v10.userModes.${userId}" must be "OFF", "PAPER" or "REAL" (got ${JSON.stringify(mode)})`,
        );
      userModes.set(userId, mode);
    }
  }

  const perUser = new Map<string, Partial<V10UserRules>>();
  if (v.perUser !== undefined && v.perUser !== null) {
    if (typeof v.perUser !== "object" || Array.isArray(v.perUser))
      throw new Error(
        `"v10.perUser" must be an object like {"karo":{"slPct":1}}`,
      );
    for (const [userId, o] of Object.entries(
      v.perUser as Record<string, unknown>,
    )) {
      if (!knownUserIds.includes(userId))
        throw new Error(
          `"v10.perUser" has unknown user "${userId}" (known: ${knownUserIds.join(", ")})`,
        );
      if (typeof o !== "object" || o === null || Array.isArray(o))
        throw new Error(`"v10.perUser.${userId}" must be an object`);
      const p = o as Record<string, unknown>,
        r: Partial<V10UserRules> = {};
      for (const k of Object.keys(p))
        if (!["short", "long", "slPct", "tpPct", "maxOpen"].includes(k))
          throw new Error(
            `"v10.perUser.${userId}.${k}" is not a known setting (short, long, slPct, tpPct, maxOpen)`,
          );
      for (const k of ["short", "long"] as const)
        if (p[k] !== undefined) {
          if (typeof p[k] !== "boolean")
            throw new Error(
              `"v10.perUser.${userId}.${k}" must be true or false`,
            );
          r[k] = p[k] as boolean;
        }
      if (p.slPct !== undefined) {
        if (!isNum(p.slPct, 0.1, 10))
          throw new Error(
            `"v10.perUser.${userId}.slPct" must be a percent between 0.1 and 10`,
          );
        r.slPct = p.slPct;
      }
      if (p.tpPct !== undefined) {
        if (!isNum(p.tpPct, 0.1, 20))
          throw new Error(
            `"v10.perUser.${userId}.tpPct" must be a percent between 0.1 and 20`,
          );
        r.tpPct = p.tpPct;
      }
      if (p.maxOpen !== undefined) {
        if (!isNum(p.maxOpen, 1, 50) || !Number.isInteger(p.maxOpen))
          throw new Error(
            `"v10.perUser.${userId}.maxOpen" must be a whole number between 1 and 50`,
          );
        r.maxOpen = p.maxOpen;
      }
      perUser.set(userId, r);
    }
  }
  return {
    enabled: true,
    short,
    long,
    slPct,
    tpPct,
    picks,
    rankWindowHours,
    symbols,
    userModes,
    perUser,
  };
}
