import type { Db } from "mongodb";
import { MINUTE_BARS } from "../../collector/minute-bars";
import type { MinBar } from "../lib/dc15";

/** our minute bars (price + OI + liquidations) of one symbol in [fromTs, toTs), oldest first -- PAPER exits use them */
export type MinBarLoader = (symbol: string, fromTs: number, toTs: number) => Promise<MinBar[]>;

export function mongoMinBarLoader(getDb: () => Promise<Db | null>): MinBarLoader {
  return async (symbol, fromTs, toTs) => {
    const db = await getDb();
    if (!db) throw new Error("Mongo unavailable");
    const rows = await db.collection(MINUTE_BARS).find({ symbol, ts: { $gte: new Date(fromTs), $lt: new Date(toTs) }, high: { $ne: null } })
      .project({ _id: 0, ts: 1, high: 1, low: 1, close: 1, oiFirst: 1, oiLast: 1, longLiqUsd: 1, shortLiqUsd: 1 }).sort({ ts: 1 }).toArray();
    return rows.map((d) => ({ t: new Date(d.ts).getTime(), high: Number(d.high), low: Number(d.low), close: Number(d.close), oiFirst: Number(d.oiFirst), oiLast: Number(d.oiLast), longLiq: Number(d.longLiqUsd) || 0, shortLiq: Number(d.shortLiqUsd) || 0 }));
  };
}
