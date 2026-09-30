/**
 * OA (OI accumulation) PAPER settings -- users.config.json, top-level "oa" block:
 *
 *   "oa": { "enabled": true, "users": ["main"], "rr": 2 }   // optional: "symbols": [...], "rr" (TP = rr x risk, default 2)
 *
 * PAPER ONLY by design: there is no REAL option at all -- this strategy never places a Binance order.
 * Absent block -> disabled. Malformed values fail startup with a clear message.
 */
export interface OaSettings { enabled: boolean; users: string[]; symbols: string[]; rr: number }

export function parseOaSettings(raw: unknown, knownUserIds: readonly string[], collectedSymbols: readonly string[]): OaSettings {
  const off: OaSettings = { enabled: false, users: [], symbols: [], rr: 2 };
  if (raw === undefined || raw === null) return off;
  if (typeof raw !== "object") throw new Error(`"oa" must be an object`);
  const v = raw as Record<string, unknown>;
  if (typeof v.enabled !== "boolean") throw new Error(`"oa.enabled" must be true or false`);
  if (!v.enabled) return off;
  if (!Array.isArray(v.users) || v.users.length === 0 || !v.users.every((u) => typeof u === "string")) throw new Error(`"oa.users" must be a non-empty array of userIds, e.g. ["main"]`);
  const users = (v.users as string[]).map((u) => u.trim().toLowerCase());
  const unknown = users.filter((u) => !knownUserIds.includes(u));
  if (unknown.length) throw new Error(`"oa.users" has unknown user(s) ${unknown.join(", ")} (known: ${knownUserIds.join(", ")})`);
  let symbols = [...collectedSymbols];
  if (v.symbols !== undefined) {
    if (!Array.isArray(v.symbols) || v.symbols.length === 0 || !v.symbols.every((s) => typeof s === "string")) throw new Error(`"oa.symbols" must be a non-empty array of symbols`);
    symbols = [...new Set((v.symbols as string[]).map((s) => s.trim().toUpperCase()))];
    const missing = symbols.filter((s) => !collectedSymbols.includes(s));
    if (missing.length) throw new Error(`"oa.symbols" contains ${missing.join(", ")} which this bot does not collect data for`);
  }
  const rr = v.rr === undefined ? 2 : v.rr;
  if (typeof rr !== "number" || !(rr >= 1) || rr > 5) throw new Error(`"oa.rr" must be a number between 1 and 5`);
  return { enabled: true, users, symbols, rr };
}
