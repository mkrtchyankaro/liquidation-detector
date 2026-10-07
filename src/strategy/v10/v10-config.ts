/**
 * V10 settings (BTC-led alts, Johnny Oct 2 2026) -- users.config.json, top-level "v10" block:
 *
 *   "v10": {
 *     "enabled": true,
 *     "entry": "oiPeak",          // part 1 (BTC) entry (Oct 3) · "ownEntry": "atr" = part 2 (ALT) entry. Each one of:
 *                                 //   "atr" = OI grew with the price (RANK 1), OI is now below its peak,
 *                                 //   the 15m candle closes 1 ATR back from the top made by an earlier candle ·
 *                                 //   "atrFrozen" = the same with the ATR from the move's start ·
 *                                 //   "oiPeak" = OI low -> OI peak -> the first red candle with OI down ·
 *                                 //   "story" / "storyFrozen" = Johnny's 4 points (growth -> OI falls while the price
 *                                 //   rises -> top -> red candle 1 ATR back)
 *     "topCandleOi": true, "ownTopCandleOi": false,  // atr entries: a top candle that closed 1 ATR back must have OI down
 *     (every part: the coin must have moved MORE than the user's TP %, else that coin is not taken)
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
 *     "ownLong": true,             // part 2 LONGs on / off (Oct 4; absent = follow "long"; also per user)
 *     "newShort": false, "newLong": false,  // Oct 4: trade the NEW coins (< 7 days of our data) -- per side (also per user)
 *     "zoneFilterShort": false,     // Oct 4: no SHORT when a 4h zone lies between the entry and the TP (also per user)
 *     "zoneFilterLong": false,      // Oct 4: a LONG only with a STRONG 4h zone (flip 2+/2+, >= 10 days) under the entry
 *     "zoneLongMaxAtr": 7,          //   within this many 4h ATRs (the test's median) (also per user)
 *     "bookFilterShort": false,     // Oct 4: no SHORT when the bids' share within 1% grew from the top to the entry (📚 ⚠️)
 *     "maxGivebackShort": 50,       // Oct 5: no SHORT when the price already gave back >= this % of its move at the entry
 *                                 //   (top - entry) / (top - the move's start); absent / null = off (also per user)
 *     "maxGivebackLong": 50,        // Oct 5: the same for the LONGs (the bottom); absent / null = off (also per user)
 *     "oiCandleShort": false,       // Oct 5: no SHORT when, after the top and before the entry, a GREEN candle had OI DOWN
 *     "oiCandleLong": false,        // Oct 5: no LONG when, after the bottom and before the entry, a RED candle had OI UP
 *     "excludeSymbols": ["ETHUSDT"],// Oct 4: no signals from these coins (their data is still collected)
 *     "ownLongEntry": "flush",     // part 2 LONG rule: "flush" (default: a fall with OI DOWN, RANK 1, then a candle with
 *                                 //   OI UP closing 1 ATR above the low) or "same" (the mirror of ownEntry)
 *     "wall": false,                // Oct 7: part 3 "V10 · WALL" (src/strategy/v10/wall-engine.ts): the 1h candle closes
 *                                 //   wholly outside a liquidation wall, back into the room -> SL at the wall's far edge,
 *                                 //   TP wallTpPct %. Hourly. (also per user)
 *     "wallTpPct": 2,               // the TP % from the entry (tested 1.5 / 2 / 2.5: +23 / +24 / +22%)
 *     "wallRoomRatio": 1.33,        // entry -> the other wall's far edge must be >= this x (entry -> SL)
 *     "wallMaxStopPct": null,       // optional: no trade when the SL is more than this % away (null = off)
 *     "wallTimeoutHours": 24,       // a trade still open after this long is closed at market
 *     "wallRebuildHours": null,     // optional: a 1h BODY wholly beyond a wall's far edge = BROKEN -> both walls void, the
 *                                 //   new field starts there, no WALL signal on the coin for this many hours (null = off)
 *     "wallExcludeSymbols": ["ETHUSDT"],  // coins that give no WALL signals (BTCUSDT never does)
 *     "userModes": { "main": "PAPER", "karo": "OFF", "artak": "OFF" },   // OFF | PAPER | REAL
 *     "perUser": { "karo": { "short": true, "long": false, "slPct": 1, "tpPct": 1, "maxOpen": 3,
 *                            "btc": true, "own": false, "ownSlPct": 1, "ownTpPct": 2,
 *                            "wall": true, "wallRiskUsd": 5, "wallMaxOpen": null } }  // optional overrides
 *       wallRiskUsd = the $ lost at the WALL SL (absent = the user's risk.riskUsd) · wallMaxOpen = at most N WALL trades
 *       open at once (absent / null = no limit; maxOpen counts only the BTC / ALT parts)
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
  /** part 2 LONGs on / off (Oct 4) -- default: the same as "long" */
  ownLong: boolean;
  /** Oct 4: trade the NEW coins (less than NEW_COIN_DAYS of our data) -- SHORTs / LONGs */
  newShort: boolean; newLong: boolean;
  /** Oct 4 zone filters: SHORT -- not when a 4h zone lies between the entry and the TP; LONG -- only when a STRONG 4h
   *  zone (a flip 2+/2+ built over >= 10 days) is under the entry within zoneLongMaxAtr 4h ATRs */
  zoneFilterShort: boolean; zoneFilterLong: boolean; zoneLongMaxAtr: number;
  /** Oct 4 order book filter: no SHORT when, from the top candle's close to the entry, the bids' share within 1% GREW
   *  (⚠️ someone defends the price below; test: 34% / -2.2R vs 74% / +21.1R). Unknown book = not blocked. */
  bookFilterShort: boolean;
  /** Oct 5 (giveback test: the top quarter -- >= ~50% given back -- won 29-33%, negative; the rest positive): no SHORT
   *  when, at the entry, the price already gave back at least this % of its move; null = off */
  maxGivebackShort: number | null;
  /** Oct 5: the same for the LONGs; null = off */
  maxGivebackLong: number | null;
  /** Oct 5 (oi-candle-test.ts): no trade when a candle against the turn came between the top (bottom) and the entry */
  oiCandleShort: boolean; oiCandleLong: boolean;
  /** Oct 7: part 3 WALL on / off, its $ risk (null = the user's riskUsd) and its own open-trade limit (null = none) */
  wall: boolean; wallRiskUsd: number | null; wallMaxOpen: number | null;
}

/** a coin with less than this many days of our data is "new" (Oct 4) */
export const NEW_COIN_DAYS = 7;

export interface V10Settings {
  enabled: boolean;
  /** the entry rule of part 1 (BTC's signal) and of part 2 (the alt's own) -- same for every user: the signals are shared */
  rule: V10Rule;
  ownRule: V10Rule;
  /** part 2 LONGs (Oct 4): "flush" (a fall with OI down, RANK 1, then OI up + 1 ATR -- tested 70%, +10R on the live
   *  coins) or "same" (the mirror of ownRule -- tested negative) */
  ownLongRule: V10Rule;
  /** part 2 LONGs on / off for everyone (null = follow "long") */
  ownLong: boolean | null;
  /** Oct 4 block defaults of the per-user switches */
  newShort: boolean; newLong: boolean; zoneFilterShort: boolean; zoneFilterLong: boolean; zoneLongMaxAtr: number; bookFilterShort: boolean; maxGivebackShort: number | null; maxGivebackLong: number | null; oiCandleShort: boolean; oiCandleLong: boolean;
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
  /** Oct 7: part 3 WALL -- block default on / off and its rule (shared by every user: the signals are shared) */
  wall: boolean; wallTpPct: number; wallRoomRatio: number; wallMaxStopPct: number | null; wallTimeoutHours: number; wallRebuildHours: number | null;
  /** the coins WALL watches (symbols minus wallExcludeSymbols) */
  wallSymbols: string[];
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
    ownLong: o.ownLong ?? s.ownLong ?? o.long ?? s.long,
    newShort: o.newShort ?? s.newShort, newLong: o.newLong ?? s.newLong,
    zoneFilterShort: o.zoneFilterShort ?? s.zoneFilterShort, zoneFilterLong: o.zoneFilterLong ?? s.zoneFilterLong, zoneLongMaxAtr: o.zoneLongMaxAtr ?? s.zoneLongMaxAtr,
    bookFilterShort: o.bookFilterShort ?? s.bookFilterShort,
    maxGivebackShort: o.maxGivebackShort !== undefined ? o.maxGivebackShort : s.maxGivebackShort,
    maxGivebackLong: o.maxGivebackLong !== undefined ? o.maxGivebackLong : s.maxGivebackLong,
    oiCandleShort: o.oiCandleShort ?? s.oiCandleShort, oiCandleLong: o.oiCandleLong ?? s.oiCandleLong,
    wall: o.wall ?? s.wall, wallRiskUsd: o.wallRiskUsd ?? null, wallMaxOpen: o.wallMaxOpen ?? null,
  };
}

const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

export function parseV10Settings(raw: unknown, knownUserIds: readonly string[], collectedSymbols: readonly string[]): V10Settings {
  const off: V10Settings = { enabled: false, rule: { entry: "oiPeak", topCandleOi: true }, ownRule: { entry: "atr", topCandleOi: false }, ownLongRule: { entry: "flush", flushRank: true }, ownLong: null, newShort: false, newLong: false, zoneFilterShort: false, zoneFilterLong: false, zoneLongMaxAtr: 7, bookFilterShort: false, maxGivebackShort: null, maxGivebackLong: null, oiCandleShort: false, oiCandleLong: false, short: true, long: false, slPct: 1, tpPct: 1, picks: 3, rankWindowHours: 12, btc: true, own: false, ownSlPct: 1, ownTpPct: 2, ownR2Minutes: 1, symbols: [], wall: false, wallTpPct: 2, wallRoomRatio: 1.33, wallMaxStopPct: null, wallTimeoutHours: 24, wallRebuildHours: null, wallSymbols: [], userModes: new Map(), perUser: new Map() };
  if (raw === undefined || raw === null) return off;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`"v10" must be an object`);
  const v = raw as Record<string, unknown>;
  const KNOWN = ["enabled", "entry", "ownEntry", "ownLongEntry", "ownLong", "newShort", "newLong", "zoneFilterShort", "zoneFilterLong", "zoneLongMaxAtr", "bookFilterShort", "maxGivebackShort", "maxGivebackLong", "oiCandleShort", "oiCandleLong", "excludeSymbols", "topCandleOi", "ownTopCandleOi", "short", "long", "slPct", "tpPct", "picks", "rankWindowHours", "btc", "own", "ownSlPct", "ownTpPct", "ownR2Minutes", "symbols", "userModes", "perUser", "wall", "wallTpPct", "wallRoomRatio", "wallMaxStopPct", "wallTimeoutHours", "wallExcludeSymbols", "wallRebuildHours"];
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
  const ENTRIES: V10Entry[] = ["atr", "atrFrozen", "oiPeak", "story", "storyFrozen"];
  const entryOf = (k: string, d: V10Entry): V10Rule => {
    if (v[k] !== undefined && !ENTRIES.includes(v[k] as V10Entry)) throw new Error(`"v10.${k}" must be ${ENTRIES.map((e) => `"${e}"`).join(", ")} (got ${JSON.stringify(v[k])})`);
    return { entry: (v[k] as V10Entry | undefined) ?? d };
  };
  // Oct 3 tests (SL 1 / TP 2, only coins that moved more than the TP): BTC part best with "oiPeak" (8 trades, 75%,
  // +9.2R), the alt's own part with "atr" WITHOUT the top-candle OI rule (28 trades, 61%, +20.2R)
  const rule = { ...entryOf("entry", "oiPeak"), topCandleOi: bool("topCandleOi", true) };
  const ownRule = { ...entryOf("ownEntry", "atr"), topCandleOi: bool("ownTopCandleOi", false) };
  // Oct 4: the ALT part's LONGs -- "flush" (default) or "same" (the mirror of ownEntry)
  if (v.ownLongEntry !== undefined && v.ownLongEntry !== "flush" && v.ownLongEntry !== "same") throw new Error(`"v10.ownLongEntry" must be "flush" or "same" (got ${JSON.stringify(v.ownLongEntry)})`);
  const ownLongRule: V10Rule = v.ownLongEntry === "same" ? ownRule : { entry: "flush", flushRank: true };
  const ownLong = v.ownLong === undefined ? null : bool("ownLong", false);
  const newShort = bool("newShort", false), newLong = bool("newLong", false);
  const zoneFilterShort = bool("zoneFilterShort", false), zoneFilterLong = bool("zoneFilterLong", false);
  const zoneLongMaxAtr = num("zoneLongMaxAtr", 7, 0.1, 50, "a number of 4h ATRs between 0.1 and 50");
  const bookFilterShort = bool("bookFilterShort", false);
  const giveback = (x: unknown, where: string): number | null => {
    if (x === undefined || x === null) return null;
    if (!isNum(x, 1, 100)) throw new Error(`"${where}" must be a percent between 1 and 100, or null (off)`);
    return x;
  };
  const maxGivebackShort = giveback(v.maxGivebackShort, "v10.maxGivebackShort");
  const maxGivebackLong = giveback(v.maxGivebackLong, "v10.maxGivebackLong");
  const oiCandleShort = bool("oiCandleShort", false), oiCandleLong = bool("oiCandleLong", false);
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
  // Oct 4: coins that give no signals (their data is still collected), e.g. ["ETHUSDT"]
  if (v.excludeSymbols !== undefined) {
    if (!Array.isArray(v.excludeSymbols) || !v.excludeSymbols.every((x) => typeof x === "string")) throw new Error(`"v10.excludeSymbols" must be an array of symbols like ["ETHUSDT"]`);
    const ex = (v.excludeSymbols as string[]).map((x) => x.trim().toUpperCase());
    const unknown = ex.filter((x) => !collectedSymbols.includes(x));
    if (unknown.length) throw new Error(`"v10.excludeSymbols" contains ${unknown.join(", ")} which this bot does not collect data for`);
    symbols = symbols.filter((x) => !ex.includes(x));
  }
  if (symbols.length === 0) throw new Error(`"v10" has no alts to trade (SYMBOLS has only BTCUSDT)`);

  // Oct 7: part 3 WALL
  const wall = bool("wall", false);
  const wallTpPct = num("wallTpPct", 2, 0.1, 20, "a percent between 0.1 and 20");
  const wallRoomRatio = num("wallRoomRatio", 1.33, 0.5, 10, "a number between 0.5 and 10");
  let wallMaxStopPct: number | null = null;
  if (v.wallMaxStopPct !== undefined && v.wallMaxStopPct !== null) {
    if (!isNum(v.wallMaxStopPct, 0.1, 20)) throw new Error(`"v10.wallMaxStopPct" must be a percent between 0.1 and 20, or null (off)`);
    wallMaxStopPct = v.wallMaxStopPct;
  }
  const wallTimeoutHours = num("wallTimeoutHours", 24, 1, 168, "a number of hours between 1 and 168");
  let wallRebuildHours: number | null = null;
  if (v.wallRebuildHours !== undefined && v.wallRebuildHours !== null) {
    if (!isNum(v.wallRebuildHours, 1, 168)) throw new Error(`"v10.wallRebuildHours" must be a number of hours between 1 and 168, or null (off)`);
    wallRebuildHours = v.wallRebuildHours;
  }
  let wallEx = ["ETHUSDT"];
  if (v.wallExcludeSymbols !== undefined) {
    if (!Array.isArray(v.wallExcludeSymbols) || !v.wallExcludeSymbols.every((x) => typeof x === "string")) throw new Error(`"v10.wallExcludeSymbols" must be an array of symbols like ["ETHUSDT"]`);
    wallEx = (v.wallExcludeSymbols as string[]).map((x) => x.trim().toUpperCase());
  }
  const wallSymbols = symbols.filter((x) => !wallEx.includes(x));

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
      const PU = ["short", "long", "slPct", "tpPct", "maxOpen", "btc", "own", "ownSlPct", "ownTpPct", "ownLong", "newShort", "newLong", "zoneFilterShort", "zoneFilterLong", "zoneLongMaxAtr", "bookFilterShort", "maxGivebackShort", "maxGivebackLong", "oiCandleShort", "oiCandleLong", "wall", "wallRiskUsd", "wallMaxOpen"];
      for (const k of Object.keys(p)) if (!PU.includes(k)) throw new Error(`"v10.perUser.${userId}.${k}" is not a known setting (${PU.join(", ")})`);
      for (const k of ["short", "long", "btc", "own", "ownLong", "newShort", "newLong", "zoneFilterShort", "zoneFilterLong", "bookFilterShort", "oiCandleShort", "oiCandleLong", "wall"] as const) if (p[k] !== undefined) {
        if (typeof p[k] !== "boolean") throw new Error(`"v10.perUser.${userId}.${k}" must be true or false`);
        r[k] = p[k] as boolean;
      }
      if (p.slPct !== undefined) { if (!isNum(p.slPct, 0.1, 10)) throw new Error(`"v10.perUser.${userId}.slPct" must be a percent between 0.1 and 10`); r.slPct = p.slPct; }
      if (p.tpPct !== undefined) { if (!isNum(p.tpPct, 0.1, 20)) throw new Error(`"v10.perUser.${userId}.tpPct" must be a percent between 0.1 and 20`); r.tpPct = p.tpPct; }
      if (p.ownSlPct !== undefined) { if (!isNum(p.ownSlPct, 0.1, 10)) throw new Error(`"v10.perUser.${userId}.ownSlPct" must be a percent between 0.1 and 10`); r.ownSlPct = p.ownSlPct; }
      if (p.ownTpPct !== undefined) { if (!isNum(p.ownTpPct, 0.1, 20)) throw new Error(`"v10.perUser.${userId}.ownTpPct" must be a percent between 0.1 and 20`); r.ownTpPct = p.ownTpPct; }
      if (p.zoneLongMaxAtr !== undefined) { if (!isNum(p.zoneLongMaxAtr, 0.1, 50)) throw new Error(`"v10.perUser.${userId}.zoneLongMaxAtr" must be a number of 4h ATRs between 0.1 and 50`); r.zoneLongMaxAtr = p.zoneLongMaxAtr; }
      if (p.maxGivebackShort !== undefined) r.maxGivebackShort = giveback(p.maxGivebackShort, `v10.perUser.${userId}.maxGivebackShort`);
      if (p.maxGivebackLong !== undefined) r.maxGivebackLong = giveback(p.maxGivebackLong, `v10.perUser.${userId}.maxGivebackLong`);
      if (p.maxOpen !== undefined) {
        if (!isNum(p.maxOpen, 1, 50) || !Number.isInteger(p.maxOpen)) throw new Error(`"v10.perUser.${userId}.maxOpen" must be a whole number between 1 and 50`);
        r.maxOpen = p.maxOpen;
      }
      if (p.wallRiskUsd !== undefined && p.wallRiskUsd !== null) {
        if (!isNum(p.wallRiskUsd, 0.1, 10_000)) throw new Error(`"v10.perUser.${userId}.wallRiskUsd" must be a $ amount between 0.1 and 10000`);
        r.wallRiskUsd = p.wallRiskUsd;
      }
      if (p.wallMaxOpen !== undefined && p.wallMaxOpen !== null) {
        if (!isNum(p.wallMaxOpen, 1, 50) || !Number.isInteger(p.wallMaxOpen)) throw new Error(`"v10.perUser.${userId}.wallMaxOpen" must be a whole number between 1 and 50, or null (no limit)`);
        r.wallMaxOpen = p.wallMaxOpen;
      }
      perUser.set(userId, r);
    }
  }
  return { enabled: true, rule, ownRule, ownLongRule, ownLong, newShort, newLong, zoneFilterShort, zoneFilterLong, zoneLongMaxAtr, bookFilterShort, maxGivebackShort, maxGivebackLong, oiCandleShort, oiCandleLong, short, long, slPct, tpPct, picks, rankWindowHours, btc, own, ownSlPct, ownTpPct, ownR2Minutes, symbols, wall, wallTpPct, wallRoomRatio, wallMaxStopPct, wallTimeoutHours, wallRebuildHours, wallSymbols, userModes, perUser };
}
