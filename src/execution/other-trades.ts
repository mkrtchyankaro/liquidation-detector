import type { Db } from "mongodb";

/**
 * Strategies that place REAL orders on the same Binance accounts (Oct 12 2026: V10 and V11; V9 was removed).
 * Before a REAL entry each one checks the OTHER strategies' open REAL rows (besides the account itself: symbolClear),
 * and when settling a closed trade it ends its fills window where another strategy's REAL trade on the symbol began.
 */
export const REAL_TRADE_COLLECTIONS = { V10: "v10_trades", V11: "v11_trades" } as const;
export type RealStrategy = keyof typeof REAL_TRADE_COLLECTIONS;

const others = (me: RealStrategy): Array<[RealStrategy, string]> =>
  (Object.entries(REAL_TRADE_COLLECTIONS) as Array<[RealStrategy, string]>).filter(([k]) => k !== me);

/** the name of another strategy that has a REAL trade open (or opening) on this symbol for this user, else null */
export async function otherOpenRealTrade(db: Db, me: RealStrategy, userId: string, symbol: string): Promise<RealStrategy | null> {
  for (const [name, coll] of others(me)) {
    if ((await db.collection(coll).countDocuments({ state: "OPEN", mode: "REAL", userId, symbol }, { limit: 1 })) > 0) return name;
  }
  return null;
}

/** when the earliest REAL trade of another strategy, still open on this symbol, started its entry at or after `after`
 *  (ms), else null. Its start = entryStartedAt (just before its entry order), or createdAt on a row without it. */
export async function otherRealTradeSince(db: Db, me: RealStrategy, userId: string, symbol: string, after: number): Promise<number | null> {
  let best: number | null = null;
  for (const [, coll] of others(me)) {
    const rows = await db.collection(coll).find({ state: "OPEN", mode: "REAL", userId, symbol }).project({ _id: 0, entryStartedAt: 1, createdAt: 1 }).toArray();
    for (const r of rows) {
      const t = Number(r.entryStartedAt ?? r.createdAt);
      if (Number.isFinite(t) && t >= after && (best === null || t < best)) best = t;
    }
  }
  return best;
}

/**
 * In-process lock per (user, symbol): V10 and V11 run in the same process, and each one's "is the symbol clear? ->
 * write our OPEN row" must not interleave with the other's (both could see the symbol clear and both enter). Held
 * only from the checks until our row is written; the other one then sees that row.
 */
const chains = new Map<string, Promise<unknown>>();
export async function withSymbolLock<T>(userId: string, symbol: string, fn: () => Promise<T>): Promise<T> {
  const key = `${userId}|${symbol}`;
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  try {
    return await run;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}
