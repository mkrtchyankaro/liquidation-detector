/**
 * V10 settings (BTC-led alts, Johnny Oct 2 2026) -- users.config.json, top-level "v10" block:
 *
 *   "v10": {
 *     "enabled": true,
 *     "entry": "atrFrozen",       // part 1 (BTC) entry (Oct 3) · "ownEntry": "atr" = part 2 (ALT) entry. Each one of:
 *                                 //   "atr" = OI grew with the price (RANK 1), OI is now below its peak,
 *                                 //   the 15m candle closes 1 ATR back from the top made by an earlier candle ·
 *                                 //   "atrFrozen" = the same with the ATR from the move's start ·
 *                                 //   "oiPeak" = OI low -> OI peak -> the first red candle with OI down
 *     "short": true,              // BTC top (15m DC + OI rule, RANK 1)  -> SHORT the alts that rose most with BTC
 *     "long": false,              // BTC bottom (the mirror)             -> LONG the alts that fell most with BTC
 *     "slPct": 1,                 // SL this % from the entry (against the trade)
 *     "tpPct": 1,                 // TP this % from the entry (with the trade)
 *     "picks": 3,                 // how many alts per BTC signal
 *     "rankWindowHours": 12,      // RANK 1 = the move's |OI change| is bigger than every BTC move of these hours before it
 *     "symbols": ["ETHUSDT", ...],// optional: the alts to choose from (default: every collected symbol except BTCUSDT)
 *     "btc": true,                // part 1 "V10 · BTC": BTC's top / bottom -> the alts that moved most WITH BTC
 *     "own": false,               // part 2 "V10 · ALT": an alt's OWN top / bottom (same 15m DC + OI rule + RANK 1, on the
 *                                 //   alt's own data) when it moved ON ITS OWN (BTC explains < half, or went the other way)
 *     "ownR2Minutes": 1,           // part 2: "moved on its own" = the R2 with BTC on 15m closes (15) or 1-minute returns (1)
 *     "ownSlPct": 1, "ownTpPct": 2,  // SL / TP % for part 2 (its moves run further: tested best at 1 / 2)
 *     "userModes": { "main": "PAPER", "karo": "OFF", "artak": "OFF" },   // OFF | PAPER | REAL
 *     "perUser": { "karo": { "short": true, "long": false, "slPct": 1, "tpPct": 1, "maxOpen": 3,
 *                            "btc": true, "own": false, "ownSlPct": 1, "ownTpPct": 2 } }  // optional overrides
 *   }
 *
 * "short" / "long" apply to both parts. Every field of "perUser" is optional; a missing one uses the block's value.
 * maxOpen = at most N V10 trades open at once for that user, both parts together (absent = no limit). Absent block -> V10 disabled. A user not in userModes is OFF.
 * Any malformed value fails startup with a clear message -- a typo must never silently arm or disarm real trading.
 */
import type { V10Entry, V10Rule } from "./v10-engine";

export type V10UserMode = "OFF" | "PAPER" | "REAL";

export interface V10UserRules {
  short: boolean; long: boolean; slPct: number; tpPct: number; maxOpen: number | null;
  /** part 1 (BTC-led) on / off */
  btc: boolean;
  /** part 2 (the alt's own move) on / off, and its SL / TP % */
  own: boolean; ownSlPct: number; ownTpPct: number;
}

export interface V10Settings {
  enabled: boolean;
  /** the entry rule of part 1 (BTC's signal) and of part 2 (the alt's own) -- same for every user: the signals are shared */
  rule: V10Rule;
  ownRule: V10Rule;
  short: boolean;
  long: boolean;
  slPct: number;
  tpPct: number;
  picks: number;
  rankWindowHours: number;
  btc: boolean;
  own: boolean;
  ownSlPct: number;
  ownTpPct: number;
  /** part 2: the R2 with BTC on closes this many minutes apart (15 = the 15m chart, 1 = minute returns) */
  ownR2Minutes: number;
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
    short: o.short ?? s.short, long: o.long ?? s.long, slPct: o.slPct ?? s.slPct, tpPct: o.tpPct ?? s.tpPct, maxOpen: o.maxOpen ?? null,
    btc: o.btc ?? s.btc, own: o.own ?? s.own, ownSlPct: o.ownSlPct ?? s.ownSlPct, ownTpPct: o.ownTpPct ?? s.ownTpPct,
  };
}

const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

export function parseV10Settings(raw: unknown, knownUserIds: readonly string[], collectedSymbols: readonly string[]): V10Settings {
  const off: V10Settings = { enabled: false, rule: { entry: "atrFrozen" }, ownRule: { entry: "atr" }, short: true, long: false, slPct: 1, tpPct: 1, picks: 3, rankWindowHours: 12, btc: true, own: false, ownSlPct: 1, ownTpPct: 2, ownR2Minutes: 1, symbols: [], userModes: new Map(), perUser: new Map() };
  if (raw === undefined || raw === null) return off;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`"v10" must be an object`);
  const v = raw as Record<string, unknown>;
  const KNOWN = ["enabled", "entry", "ownEntry", "short", "long", "slPct", "tpPct", "picks", "rankWindowHours", "btc", "own", "ownSlPct", "ownTpPct", "ownR2Minutes", "symbols", "userModes", "perUser"];
  for (const k of Object.keys(v)) if (!KNOWN.includes(k)) throw new Error(`"v10.${k}" is not a known setting (${KNOWN.join(", ")}) -- check the spelling`);
  if (typeof v.enabled !== "boolean") throw new Error(`"v10.enabled" must be true or false`);
  if (!v.enabled) return off;
  if (!collectedSymbols.includes(BTC)) throw new Error(`"v10" needs ${BTC} in SYMBOLS (.env) -- its signals come from BTC`);

  const bool = (k: string, d: boolean): boolean => {
    if (v[k] === undefined) return d;
    if (typeof v[k] !== "boolean") throw new Error(`"v10.${k}" must be true or false`);
    return v[k] as boolean;
  };
  const num = (k: string, d: number, lo: number, hi: number, what: string): number => {
    if (v[k] === undefined) return d;
    if (!isNum(v[k], lo, hi)) throw new Error(`"v10.${k}" must be ${what} (got ${JSON.stringify(v[k])})`);
    return v[k] as number;
  };
  const ENTRIES: V10Entry[] = ["atr", "atrFrozen", "oiPeak"];
  const entryOf = (k: string, d: V10Entry): V10Rule => {
    if (v[k] !== undefined && !ENTRIES.includes(v[k] as V10Entry)) throw new Error(`"v10.${k}" must be ${ENTRIES.map((e) => `"${e}"`).join(", ")} (got ${JSON.stringify(v[k])})`);
    return { entry: (v[k] as V10Entry | undefined) ?? d };
  };
  // Oct 3 tests: BTC part best with the frozen ATR, the alt's own part with Johnny's ATR rule
  const rule = entryOf("entry", "atrFrozen"), ownRule = entryOf("ownEntry", "atr");
  const short = bool("short", true), long = bool("long", false);
  const slPct = num("slPct", 1, 0.1, 10, "a percent between 0.1 and 10");
  const tpPct = num("tpPct", 1, 0.1, 20, "a percent between 0.1 and 20");
  const picks = num("picks", 3, 1, 10, "a whole number between 1 and 10");
  if (!Number.isInteger(picks)) throw new Error(`"v10.picks" must be a whole number between 1 and 10`);
  const rankWindowHours = num("rankWindowHours", 12, 1, 72, "a number of hours between 1 and 72");
  const btc = bool("btc", true), own = bool("own", false);
  const ownSlPct = num("ownSlPct", 1, 0.1, 10, "a percent between 0.1 and 10");
  const ownTpPct = num("ownTpPct", 2, 0.1, 20, "a percent between 0.1 and 20");
  const ownR2Minutes = num("ownR2Minutes", 1, 1, 15, "1 or 15");
  if (ownR2Minutes !== 1 && ownR2Minutes !== 15) throw new Error(`"v10.ownR2Minutes" must be 1 or 15 (got ${ownR2Minutes})`);

  let symbols = collectedSymbols.filter((s) => s !== BTC);
  if (v.symbols !== undefined) {
    if (!Array.isArray(v.symbols) || v.symbols.length === 0 || !v.symbols.every((s) => typeof s === "string")) throw new Error(`"v10.symbols" must be a non-empty array of symbols`);
    symbols = [...new Set((v.symbols as string[]).map((s) => s.trim().toUpperCase()))];
    if (symbols.includes(BTC)) throw new Error(`"v10.symbols" must not contain ${BTC} -- V10 trades the alts, BTC only gives the signal`);
    const missing = symbols.filter((s) => !collectedSymbols.includes(s));
    if (missing.length) throw new Error(`"v10.symbols" contains ${missing.join(", ")} which this bot does not collect data for`);
  }
  if (symbols.length === 0) throw new Error(`"v10" has no alts to trade (SYMBOLS has only BTCUSDT)`);

  const userModes = new Map<string, V10UserMode>();
  if (v.userModes !== undefined) {
    if (typeof v.userModes !== "object" || v.userModes === null || Array.isArray(v.userModes)) throw new Error(`"v10.userModes" must be an object like {"main":"PAPER"}`);
    for (const [userId, mode] of Object.entries(v.userModes as Record<string, unknown>)) {
      if (!knownUserIds.includes(userId)) throw new Error(`"v10.userModes" has unknown user "${userId}" (known: ${knownUserIds.join(", ")})`);
      if (mode !== "OFF" && mode !== "PAPER" && mode !== "REAL") throw new Error(`"v10.userModes.${userId}" must be "OFF", "PAPER" or "REAL" (got ${JSON.stringify(mode)})`);
      userModes.set(userId, mode);
    }
  }

  const perUser = new Map<string, Partial<V10UserRules>>();
  if (v.perUser !== undefined && v.perUser !== null) {
    if (typeof v.perUser !== "object" || Array.isArray(v.perUser)) throw new Error(`"v10.perUser" must be an object like {"karo":{"slPct":1}}`);
    for (const [userId, o] of Object.entries(v.perUser as Record<string, unknown>)) {
      if (!knownUserIds.includes(userId)) throw new Error(`"v10.perUser" has unknown user "${userId}" (known: ${knownUserIds.join(", ")})`);
      if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error(`"v10.perUser.${userId}" must be an object`);
      const p = o as Record<string, unknown>, r: Partial<V10UserRules> = {};
      const PU = ["short", "long", "slPct", "tpPct", "maxOpen", "btc", "own", "ownSlPct", "ownTpPct"];
      for (const k of Object.keys(p)) if (!PU.includes(k)) throw new Error(`"v10.perUser.${userId}.${k}" is not a known setting (${PU.join(", ")})`);
      for (const k of ["short", "long", "btc", "own"] as const) if (p[k] !== undefined) {
        if (typeof p[k] !== "boolean") throw new Error(`"v10.perUser.${userId}.${k}" must be true or false`);
        r[k] = p[k] as boolean;
      }
      if (p.slPct !== undefined) { if (!isNum(p.slPct, 0.1, 10)) throw new Error(`"v10.perUser.${userId}.slPct" must be a percent between 0.1 and 10`); r.slPct = p.slPct; }
      if (p.tpPct !== undefined) { if (!isNum(p.tpPct, 0.1, 20)) throw new Error(`"v10.perUser.${userId}.tpPct" must be a percent between 0.1 and 20`); r.tpPct = p.tpPct; }
      if (p.ownSlPct !== undefined) { if (!isNum(p.ownSlPct, 0.1, 10)) throw new Error(`"v10.perUser.${userId}.ownSlPct" must be a percent between 0.1 and 10`); r.ownSlPct = p.ownSlPct; }
      if (p.ownTpPct !== undefined) { if (!isNum(p.ownTpPct, 0.1, 20)) throw new Error(`"v10.perUser.${userId}.ownTpPct" must be a percent between 0.1 and 20`); r.ownTpPct = p.ownTpPct; }
      if (p.maxOpen !== undefined) {
        if (!isNum(p.maxOpen, 1, 50) || !Number.isInteger(p.maxOpen)) throw new Error(`"v10.perUser.${userId}.maxOpen" must be a whole number between 1 and 50`);
        r.maxOpen = p.maxOpen;
      }
      perUser.set(userId, r);
    }
  }
  return { enabled: true, rule, ownRule, short, long, slPct, tpPct, picks, rankWindowHours, btc, own, ownSlPct, ownTpPct, ownR2Minutes, symbols, userModes, perUser };
}
