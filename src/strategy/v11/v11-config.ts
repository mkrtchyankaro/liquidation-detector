/**
 * V11 settings ("squeeze wick", Johnny Oct 12 2026) -- users.config.json, top-level "v11" block. Every field except
 * "enabled" is optional; the defaults are the values tested.
 *
 *   "v11": {
 *     "enabled": false,             // false = no new signals (open REAL V11 trades are still watched and settled)
 *     "short": true,                // the squeeze-wick SHORT (tested: 44 entries, 2R -> 19 TP / 21 SL, +11R after fees)
 *     "long": false,                // the mirror LONG (a fall, long liquidations, a new low) -- tested badly (23%), keep off
 *     "tpR": 2,                     // TP = entry -/+ tpR x (SL - entry)  (tested 2 / 2.5 / 3: +11.0 / +9.7 / +4.5R)
 *     "riskUsd": null,              // $ lost at the SL; null = the user's "risk.riskUsd"
 *     "slBufferPct": 0,             // the SL a little beyond the wick's high: + this % of the price (0 = exactly the high)
 *     "rallyTypes": ["T1", "T2", "FLAT"],  // which rallies are traded: T1 = OI fell during the rally (squeeze, best:
 *                                   //   18 entries, 2R +8.4R / 2.5R +10.5R), T2 = OI rose (new money), FLAT = neither
 *     "meaningfulOnly": false,      // only wicks with "meaningful" liquidations (>= rule.minLiqUsd AND >= rule.minLiqX x
 *                                   //   the coin's p85; tested: 23 entries, 2R +10.6R, 2.5R +11.2R)
 *     "minRiskPct": null,           // no trade when the SL is closer than this % (null = off)
 *     "maxRiskPct": null,           // no trade when the SL is farther than this % (null = off; STRK had 5 %)
 *     "maxOpen": null,              // at most N V11 trades open at once per user (null = no limit)
 *     "timeoutHours": 48,           // a trade still open after this many hours is closed at market (null = never;
 *                                   //   the test followed every trade for 48 h)
 *     "symbols": ["BTCUSDT", ...],  // the coins (default: every symbol the bot collects, SYMBOLS in .env)
 *     "excludeSymbols": [],         // coins that give no V11 signals
 *     "rule": {                     // the signal rule -- shared by every user (the signals are shared)
 *       "rallyHours": 6, "rallyX": 2, "normHours": 72, "oiNormHours": 24, "oiX": 1, "watchHours": 12,
 *       "liqPercentile": 85, "minLiqUsd": 30000, "minLiqX": 2, "confirmCandles": 2, "maxConfirmMovePct": 0.3
 *     },
 *     "userModes": { "main": "PAPER", "karo": "OFF" },   // OFF | PAPER | REAL (a user not listed is OFF)
 *     "perUser": { "karo": { "short": true, "long": false, "tpR": 2.5, "riskUsd": 1, "slBufferPct": 0,
 *                            "rallyTypes": ["T1"], "meaningfulOnly": false, "minRiskPct": null, "maxRiskPct": 3,
 *                            "maxOpen": 2, "timeoutHours": 48 } }   // optional, a missing field = the block's value
 *   }
 *
 * Absent block -> V11 disabled. Any malformed value fails startup with a clear message -- a typo must never silently arm
 * or disarm real trading.
 */
import { DEFAULT_V11_RULE, type V11RallyType, type V11Rule } from "./v11-engine";

export type V11UserMode = "OFF" | "PAPER" | "REAL";

export interface V11UserRules {
  short: boolean;
  long: boolean;
  tpR: number;
  /** null = the user's risk.riskUsd */
  riskUsd: number | null;
  slBufferPct: number;
  rallyTypes: V11RallyType[];
  meaningfulOnly: boolean;
  minRiskPct: number | null;
  maxRiskPct: number | null;
  maxOpen: number | null;
  timeoutHours: number | null;
}

export interface V11Settings extends V11UserRules {
  enabled: boolean;
  symbols: string[];
  rule: V11Rule;
  userModes: Map<string, V11UserMode>;
  perUser: Map<string, Partial<V11UserRules>>;
}

const DEFAULTS: V11UserRules = {
  short: true, long: false, tpR: 2, riskUsd: null, slBufferPct: 0, rallyTypes: ["T1", "T2", "FLAT"], meaningfulOnly: false,
  minRiskPct: null, maxRiskPct: null, maxOpen: null, timeoutHours: 48,
};

/** the rules that apply to one user: the block's values, overridden by perUser */
export function v11RulesFor(s: V11Settings, userId: string): V11UserRules {
  const o = s.perUser.get(userId) ?? {};
  const pick = <K extends keyof V11UserRules>(k: K): V11UserRules[K] => (o[k] !== undefined ? (o[k] as V11UserRules[K]) : s[k]);
  return {
    short: pick("short"), long: pick("long"), tpR: pick("tpR"), riskUsd: pick("riskUsd"), slBufferPct: pick("slBufferPct"),
    rallyTypes: pick("rallyTypes"), meaningfulOnly: pick("meaningfulOnly"), minRiskPct: pick("minRiskPct"), maxRiskPct: pick("maxRiskPct"),
    maxOpen: pick("maxOpen"), timeoutHours: pick("timeoutHours"),
  };
}

const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const USER_KEYS = ["short", "long", "tpR", "riskUsd", "slBufferPct", "rallyTypes", "meaningfulOnly", "minRiskPct", "maxRiskPct", "maxOpen", "timeoutHours"] as const;
const RULE_KEYS = ["rallyHours", "rallyX", "normHours", "oiNormHours", "oiX", "watchHours", "liqPercentile", "minLiqUsd", "minLiqX", "confirmCandles", "maxConfirmMovePct"] as const;

/** the per-user-capable fields of one object (the block itself or a perUser entry); only the fields present */
function parseUserFields(o: Record<string, unknown>, where: string): Partial<V11UserRules> {
  const r: Partial<V11UserRules> = {};
  for (const k of ["short", "long", "meaningfulOnly"] as const) if (o[k] !== undefined) {
    if (typeof o[k] !== "boolean") throw new Error(`"${where}.${k}" must be true or false`);
    r[k] = o[k] as boolean;
  }
  if (o.tpR !== undefined) { if (!isNum(o.tpR, 0.5, 10)) throw new Error(`"${where}.tpR" must be a number of R between 0.5 and 10 (got ${JSON.stringify(o.tpR)})`); r.tpR = o.tpR; }
  if (o.slBufferPct !== undefined) { if (!isNum(o.slBufferPct, 0, 2)) throw new Error(`"${where}.slBufferPct" must be a percent between 0 and 2 (got ${JSON.stringify(o.slBufferPct)})`); r.slBufferPct = o.slBufferPct; }
  const nullable = (k: "riskUsd" | "minRiskPct" | "maxRiskPct" | "timeoutHours", lo: number, hi: number, what: string): void => {
    if (o[k] === undefined) return;
    if (o[k] === null) { r[k] = null; return; }
    if (!isNum(o[k], lo, hi)) throw new Error(`"${where}.${k}" must be ${what}, or null (got ${JSON.stringify(o[k])})`);
    r[k] = o[k] as number;
  };
  nullable("riskUsd", 0.1, 10_000, "a $ amount between 0.1 and 10000");
  nullable("minRiskPct", 0.01, 20, "a percent between 0.01 and 20");
  nullable("maxRiskPct", 0.01, 50, "a percent between 0.01 and 50");
  nullable("timeoutHours", 1, 720, "a number of hours between 1 and 720");
  if (o.maxOpen !== undefined) {
    if (o.maxOpen === null) r.maxOpen = null;
    else if (!isNum(o.maxOpen, 1, 100) || !Number.isInteger(o.maxOpen)) throw new Error(`"${where}.maxOpen" must be a whole number between 1 and 100, or null (no limit)`);
    else r.maxOpen = o.maxOpen;
  }
  if (o.rallyTypes !== undefined) {
    const ok: V11RallyType[] = ["T1", "T2", "FLAT"];
    if (!Array.isArray(o.rallyTypes) || o.rallyTypes.length === 0 || !o.rallyTypes.every((x) => ok.includes(x as V11RallyType)))
      throw new Error(`"${where}.rallyTypes" must be a non-empty array of "T1", "T2", "FLAT" (got ${JSON.stringify(o.rallyTypes)})`);
    r.rallyTypes = [...new Set(o.rallyTypes as V11RallyType[])];
  }
  if (r.minRiskPct != null && r.maxRiskPct != null && r.minRiskPct >= r.maxRiskPct) throw new Error(`"${where}.minRiskPct" must be smaller than maxRiskPct`);
  return r;
}

function parseRule(raw: unknown): V11Rule {
  if (raw === undefined) return { ...DEFAULT_V11_RULE };
  if (!isObj(raw)) throw new Error(`"v11.rule" must be an object`);
  for (const k of Object.keys(raw)) if (!(RULE_KEYS as readonly string[]).includes(k)) throw new Error(`"v11.rule.${k}" is not a known setting (${RULE_KEYS.join(", ")})`);
  const num = (k: (typeof RULE_KEYS)[number], d: number, lo: number, hi: number, what: string, int = false): number => {
    if (raw[k] === undefined) return d;
    if (!isNum(raw[k], lo, hi) || (int && !Number.isInteger(raw[k]))) throw new Error(`"v11.rule.${k}" must be ${what} (got ${JSON.stringify(raw[k])})`);
    return raw[k] as number;
  };
  const D = DEFAULT_V11_RULE;
  const confirmCandles = num("confirmCandles", D.confirmCandles, 1, 2, "1 or 2", true) as 1 | 2;
  return {
    rallyHours: num("rallyHours", D.rallyHours, 2, 24, "a whole number of hours between 2 and 24", true),
    rallyX: num("rallyX", D.rallyX, 0.5, 10, "a number between 0.5 and 10"),
    normHours: num("normHours", D.normHours, 24, 240, "a whole number of hours between 24 and 240", true),
    oiNormHours: num("oiNormHours", D.oiNormHours, 6, 72, "a whole number of hours between 6 and 72", true),
    oiX: num("oiX", D.oiX, 0.1, 10, "a number between 0.1 and 10"),
    watchHours: num("watchHours", D.watchHours, 1, 48, "a whole number of hours between 1 and 48", true),
    liqPct: num("liqPercentile", D.liqPct * 100, 50, 99, "a percentile between 50 and 99") / 100,
    minLiqUsd: num("minLiqUsd", D.minLiqUsd, 0, 10_000_000, "a $ amount between 0 and 10000000"),
    minLiqX: num("minLiqX", D.minLiqX, 0, 50, "a number between 0 and 50"),
    confirmCandles,
    maxConfirmMovePct: num("maxConfirmMovePct", D.maxConfirmMovePct, 0, 5, "a percent between 0 and 5"),
  };
}

export function parseV11Settings(raw: unknown, knownUserIds: readonly string[], collectedSymbols: readonly string[]): V11Settings {
  const off: V11Settings = { enabled: false, ...DEFAULTS, symbols: [], rule: { ...DEFAULT_V11_RULE }, userModes: new Map(), perUser: new Map() };
  if (raw === undefined || raw === null) return off;
  if (!isObj(raw)) throw new Error(`"v11" must be an object`);
  const KNOWN = ["enabled", ...USER_KEYS, "symbols", "excludeSymbols", "rule", "userModes", "perUser"];
  for (const k of Object.keys(raw)) if (!KNOWN.includes(k)) throw new Error(`"v11.${k}" is not a known setting (${KNOWN.join(", ")}) -- check the spelling`);
  if (typeof raw.enabled !== "boolean") throw new Error(`"v11.enabled" must be true or false`);
  // everything is checked even when disabled: a typo is found before the day it is switched on
  const block = { ...DEFAULTS, ...parseUserFields(raw, "v11") };
  const rule = parseRule(raw.rule);

  let symbols = [...collectedSymbols];
  if (raw.symbols !== undefined) {
    if (!Array.isArray(raw.symbols) || raw.symbols.length === 0 || !raw.symbols.every((x) => typeof x === "string")) throw new Error(`"v11.symbols" must be a non-empty array of symbols`);
    symbols = [...new Set((raw.symbols as string[]).map((x) => x.trim().toUpperCase()))];
    const missing = symbols.filter((x) => !collectedSymbols.includes(x));
    if (missing.length) throw new Error(`"v11.symbols" contains ${missing.join(", ")} which this bot does not collect data for (SYMBOLS in .env) -- the liquidations come from our database`);
  }
  if (raw.excludeSymbols !== undefined) {
    if (!Array.isArray(raw.excludeSymbols) || !raw.excludeSymbols.every((x) => typeof x === "string")) throw new Error(`"v11.excludeSymbols" must be an array of symbols like ["ETHUSDT"]`);
    const ex = (raw.excludeSymbols as string[]).map((x) => x.trim().toUpperCase());
    symbols = symbols.filter((x) => !ex.includes(x));
  }

  const userModes = new Map<string, V11UserMode>();
  if (raw.userModes !== undefined) {
    if (!isObj(raw.userModes)) throw new Error(`"v11.userModes" must be an object like {"main":"PAPER"}`);
    for (const [userId, mode] of Object.entries(raw.userModes)) {
      if (!knownUserIds.includes(userId)) throw new Error(`"v11.userModes" has unknown user "${userId}" (known: ${knownUserIds.join(", ")})`);
      if (mode !== "OFF" && mode !== "PAPER" && mode !== "REAL") throw new Error(`"v11.userModes.${userId}" must be "OFF", "PAPER" or "REAL" (got ${JSON.stringify(mode)})`);
      userModes.set(userId, mode);
    }
  }
  const perUser = new Map<string, Partial<V11UserRules>>();
  if (raw.perUser !== undefined && raw.perUser !== null) {
    if (!isObj(raw.perUser)) throw new Error(`"v11.perUser" must be an object like {"karo":{"tpR":2}}`);
    for (const [userId, o] of Object.entries(raw.perUser)) {
      if (!knownUserIds.includes(userId)) throw new Error(`"v11.perUser" has unknown user "${userId}" (known: ${knownUserIds.join(", ")})`);
      if (!isObj(o)) throw new Error(`"v11.perUser.${userId}" must be an object`);
      for (const k of Object.keys(o)) if (!(USER_KEYS as readonly string[]).includes(k)) throw new Error(`"v11.perUser.${userId}.${k}" is not a known setting (${USER_KEYS.join(", ")})`);
      perUser.set(userId, parseUserFields(o, `v11.perUser.${userId}`));
    }
  }
  const s: V11Settings = { enabled: raw.enabled, ...block, symbols, rule, userModes, perUser };
  for (const u of knownUserIds) {
    const r = v11RulesFor(s, u);
    if (r.minRiskPct !== null && r.maxRiskPct !== null && r.minRiskPct >= r.maxRiskPct) throw new Error(`"v11" for user "${u}": minRiskPct (${r.minRiskPct}) must be smaller than maxRiskPct (${r.maxRiskPct})`);
  }
  if (s.enabled && symbols.length === 0) throw new Error(`"v11" has no coins to watch`);
  return s;
}
