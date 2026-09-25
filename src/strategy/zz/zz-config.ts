/**
 * ZZ (OI zigzag) PAPER settings -- users.config.json, top-level "zz" block:
 *
 *   "zz": { "enabled": true, "users": ["main"], "symbols": [...], "maxDelayMin": 40, "tpShare": 1 }
 *
 * PAPER ONLY by design: there is no REAL option here at all -- this strategy
 * never places a Binance order. Absent block -> disabled. Malformed values
 * fail startup with a clear message.
 */
export interface ZzSettings {
  enabled: boolean;
  users: string[];
  symbols: string[];
  /** skip when the OI top became known more than this many minutes after it */
  maxDelayMin: number;
  /** TP at this share of the remaining expected move (reserve), default 1 = no reserve */
  tpShare: number;
}

export function parseZzSettings(raw: unknown, knownUserIds: readonly string[], collectedSymbols: readonly string[]): ZzSettings {
  const off: ZzSettings = { enabled: false, users: [], symbols: [], maxDelayMin: 40, tpShare: 1 };
  if (raw === undefined || raw === null) return off;
  if (typeof raw !== "object") throw new Error(`"zz" must be an object`);
  const v = raw as Record<string, unknown>;
  if (typeof v.enabled !== "boolean") throw new Error(`"zz.enabled" must be true or false`);
  if (!v.enabled) return off;
  if (!Array.isArray(v.users) || v.users.length === 0 || !v.users.every((u) => typeof u === "string")) throw new Error(`"zz.users" must be a non-empty array of userIds, e.g. ["main"]`);
  const users = (v.users as string[]).map((u) => u.trim().toLowerCase());
  const unknown = users.filter((u) => !knownUserIds.includes(u));
  if (unknown.length) throw new Error(`"zz.users" has unknown user(s) ${unknown.join(", ")} (known: ${knownUserIds.join(", ")})`);
  let symbols = [...collectedSymbols];
  if (v.symbols !== undefined) {
    if (!Array.isArray(v.symbols) || v.symbols.length === 0 || !v.symbols.every((s) => typeof s === "string")) throw new Error(`"zz.symbols" must be a non-empty array of symbols`);
    symbols = [...new Set((v.symbols as string[]).map((s) => s.trim().toUpperCase()))];
    const missing = symbols.filter((s) => !collectedSymbols.includes(s));
    if (missing.length) throw new Error(`"zz.symbols" contains ${missing.join(", ")} which this bot does not collect data for`);
  }
  const maxDelayMin = v.maxDelayMin === undefined ? 40 : v.maxDelayMin;
  if (typeof maxDelayMin !== "number" || !(maxDelayMin > 0) || maxDelayMin > 240) throw new Error(`"zz.maxDelayMin" must be a number between 1 and 240`);
  const tpShare = v.tpShare === undefined ? 1 : v.tpShare;
  if (typeof tpShare !== "number" || !(tpShare >= 0.3) || tpShare > 1) throw new Error(`"zz.tpShare" must be a number between 0.3 and 1`);
  return { enabled: true, users, symbols, maxDelayMin, tpShare };
}
