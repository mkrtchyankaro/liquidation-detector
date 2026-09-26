import type { Db } from "mongodb";
import { ensureTtlIndexSeconds } from "./mongo-ttl-helper";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "liq-raw-repo" });

/** liq_raw_events: every Binance forced-order (liquidation) event.
 *  `timestamp` is epoch ms (research + V9 read it); `eventTimeDate` is the
 *  same instant as a Date, used only for TTL expiry. */
export const LIQ_RAW_EVENTS = "liq_raw_events";
const TTL_SECONDS = 14 * 24 * 3600; // 14 days for V9 replays (was 4)

export interface RawLiquidationEventDoc {
  symbol: string;
  victim: "LONG" | "SHORT";
  price: number;
  quoteQty: number;
  timestamp: number;
}

export class RawLiquidationEventRepository {
  constructor(private readonly db: () => Promise<Db | null>) {}

  async ensureIndexes(): Promise<void> {
    const db = await this.db();
    if (!db) throw new Error("Mongo unavailable");
    await db.collection(LIQ_RAW_EVENTS).createIndex({ symbol: 1, timestamp: -1 });
    const ttl = await ensureTtlIndexSeconds(db, LIQ_RAW_EVENTS, "eventTimeDate", TTL_SECONDS, "ttl_eventTimeDate");
    if (ttl.action === "failed") log.warn(`[LIQ_RAW_TTL_FAILED] ${ttl.detail}`);
  }

  async insert(doc: RawLiquidationEventDoc): Promise<void> {
    try {
      const db = await this.db();
      if (!db) return;
      await db.collection(LIQ_RAW_EVENTS).insertOne({ ...doc, eventTimeDate: new Date(doc.timestamp) });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), symbol: doc.symbol }, "[LIQ_RAW_INSERT_FAILED]");
    }
  }
}
