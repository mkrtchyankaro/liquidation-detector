/**
 * OA (OI accumulation) PAPER settings -- users.config.json, top-level "oa" block:
 *
 *   "oa": { "enabled": true, "users": ["main"], "rr": 2.5, "minSlPct": 0.3, "continuation": true, "reversal": false }
 *
 *   rr            TP = rr x risk                                             (default 2.5)
 *   minSlPct      skip a signal whose SL (confirmation candle's extreme) is closer than this, in %   (default 0.3)
 *   continuation  type B: flush against the move, then the move goes on        (default true)
 *   reversal      type A: new extreme + the other side liquidated, then turn   (default false)
 *   symbols       optional subset of the collected symbols
 *
 * PAPER ONLY by design: there is no REAL option at all -- this strategy never places a Binance order.
 * Absent block -> disabled. Malformed values fail startup with a clear message.
 */
export interface OaSettings {
  enabled: boolean;
  users: string[];
  symbols: string[];
  rr: number;
  minSlPct: number;
  continuation: boolean;
  reversal: boolean;
}

export function parseOaSettings(
  raw: unknown,
  knownUserIds: readonly string[],
  collectedSymbols: readonly string[],
): OaSettings {
  const off: OaSettings = {
    enabled: false,
    users: [],
    symbols: [],
    rr: 2.5,
    minSlPct: 0.3,
    continuation: true,
    reversal: false,
  };
  if (raw === undefined || raw === null) return off;
  if (typeof raw !== "object") throw new Error(`"oa" must be an object`);
  const v = raw as Record<string, unknown>;
  if (typeof v.enabled !== "boolean")
    throw new Error(`"oa.enabled" must be true or false`);
  if (!v.enabled) return off;
  if (
    !Array.isArray(v.users) ||
    v.users.length === 0 ||
    !v.users.every((u) => typeof u === "string")
  )
    throw new Error(
      `"oa.users" must be a non-empty array of userIds, e.g. ["main"]`,
    );
  const users = (v.users as string[]).map((u) => u.trim().toLowerCase());
  const unknown = users.filter((u) => !knownUserIds.includes(u));
  if (unknown.length)
    throw new Error(
      `"oa.users" has unknown user(s) ${unknown.join(", ")} (known: ${knownUserIds.join(", ")})`,
    );
  let symbols = [...collectedSymbols];
  if (v.symbols !== undefined) {
    if (
      !Array.isArray(v.symbols) ||
      v.symbols.length === 0 ||
      !v.symbols.every((s) => typeof s === "string")
    )
      throw new Error(`"oa.symbols" must be a non-empty array of symbols`);
    symbols = [
      ...new Set((v.symbols as string[]).map((s) => s.trim().toUpperCase())),
    ];
    const missing = symbols.filter((s) => !collectedSymbols.includes(s));
    if (missing.length)
      throw new Error(
        `"oa.symbols" contains ${missing.join(", ")} which this bot does not collect data for`,
      );
  }
  const rr = v.rr === undefined ? 2.5 : v.rr;
  if (typeof rr !== "number" || !(rr >= 1) || rr > 5)
    throw new Error(`"oa.rr" must be a number between 1 and 5`);
  const minSlPct = v.minSlPct === undefined ? 0.3 : v.minSlPct;
  if (typeof minSlPct !== "number" || !(minSlPct >= 0) || minSlPct > 5)
    throw new Error(`"oa.minSlPct" must be a number between 0 and 5 (percent)`);
  const bool = (k: "continuation" | "reversal", d: boolean): boolean => {
    if (v[k] === undefined) return d;
    if (typeof v[k] !== "boolean")
      throw new Error(`"oa.${k}" must be true or false`);
    return v[k] as boolean;
  };
  const continuation = bool("continuation", true),
    reversal = bool("reversal", false);
  if (!continuation && !reversal)
    throw new Error(
      `"oa": at least one of "continuation" / "reversal" must be true`,
    );
  return {
    enabled: true,
    users,
    symbols,
    rr,
    minSlPct,
    continuation,
    reversal,
  };
}

/** the engine parameters this config asks for */
export function oaParamsOf(
  s: Pick<OaSettings, "rr" | "minSlPct" | "continuation" | "reversal">,
): { rr: number; minSlPct: number; variants: ("A" | "B")[] } {
  return {
    rr: s.rr,
    minSlPct: s.minSlPct,
    variants: [
      ...(s.reversal ? ["A" as const] : []),
      ...(s.continuation ? ["B" as const] : []),
    ],
  };
}
