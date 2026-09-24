import type { Db } from "mongodb";
import type { Victim } from "./v9-core";
import type { V9MinuteStore } from "./v9-minute-store";
import { childLogger } from "../../infrastructure/logging/logger";

const log = childLogger({ mod: "v9-feed" });

/**
 * Feeds the V9 engine from the SAME collections the research used
 * (liq_raw_events, oi_second_observations) -- one source of truth, so live
 * sees exactly the data a replay of the same period sees.
 *
 * The bot writes OI polls in batches (every ~5 s, unordered), so a row can
 * land with a timestamp slightly older than rows already read. Each poll
 * re-reads a short overlap window and skips rows it has already applied
 * (by _id) for liquidations: they are SUMMED per minute, so a duplicate
 * would be double-counted. Re-applying an OI row is harmless (idempotent).
 */
const OVERLAP_MS = 60_000;

interface Cursor { liqTs: number; oiTs: number; seen: Map<string, number> }

export class V9MongoFeed {
  private readonly cursors = new Map<string, Cursor>();

  constructor(private readonly getDb: () => Promise<Db | null>) {}

  /** Load [fromMs, now] into the store in timestamp order. */
  async warmUp(symbol: string, store: V9MinuteStore, fromMs: number): Promise<{ liq: number; oi: number }> {
    const cursor: Cursor = { liqTs: fromMs, oiTs: fromMs, seen: new Map() };
    this.cursors.set(symbol, cursor);
    return this.apply(symbol, store, cursor, fromMs, fromMs);
  }

  /** Apply everything new since the previous call. */
  async poll(symbol: string, store: V9MinuteStore): Promise<{ liq: number; oi: number }> {
    const cursor = this.cursors.get(symbol);
    if (!cursor) throw new Error(`V9MongoFeed.poll(${symbol}) before warmUp`);
    return this.apply(symbol, store, cursor, cursor.liqTs - OVERLAP_MS, cursor.oiTs - OVERLAP_MS);
  }

  private async apply(symbol: string, store: V9MinuteStore, cursor: Cursor, liqFrom: number, oiFrom: number): Promise<{ liq: number; oi: number }> {
    const db = await this.getDb();
    if (!db) throw new Error("Mongo unavailable");
    // Streamed with cursors (never toArray): warm-up reads days of 1-second
    // OI polls and must not spike memory on a small server.
    let liq = 0, oi = 0, rows = 0;
    const liqCursor = db.collection("liq_raw_events")
      .find({ symbol, victim: { $in: ["LONG", "SHORT"] }, timestamp: { $gte: liqFrom } })
      .project({ timestamp: 1, victim: 1, quoteQty: 1 }).sort({ timestamp: 1 });
    for await (const r of liqCursor) {
      rows++;
      const id = String(r._id);
      if (cursor.seen.has(id)) continue;
      const ts = Number(r.timestamp);
      cursor.seen.set(id, ts);
      store.addLiquidation(ts, r.victim as Victim, Number(r.quoteQty));
      cursor.liqTs = Math.max(cursor.liqTs, ts);
      liq++;
    }
    const oiCursor = db.collection("oi_second_observations")
      .find({ symbol, timestamp: { $gte: new Date(oiFrom) } })
      .project({ timestamp: 1, oiUpdatedAt: 1, openInterest: 1, price: 1 }).sort({ timestamp: 1 }).batchSize(5_000);
    for await (const r of oiCursor) {
      rows++;
      const ts = r.timestamp instanceof Date ? r.timestamp.getTime() : Number(r.timestamp);
      // Re-applying the SAME OI row is idempotent in the store (same
      // last-update pick, same low/high), so OI needs no duplicate tracking.
      const updated = r.oiUpdatedAt instanceof Date ? r.oiUpdatedAt.getTime() : r.oiUpdatedAt == null ? NaN : Number(r.oiUpdatedAt);
      store.addOiObservation(ts, updated, Number(r.openInterest), Number(r.price));
      cursor.oiTs = Math.max(cursor.oiTs, ts);
      oi++;
    }
    // keep only liquidation ids that can still re-appear in the overlap window
    const keepFrom = cursor.liqTs - 2 * OVERLAP_MS;
    for (const [id, ts] of cursor.seen) if (ts < keepFrom) cursor.seen.delete(id);
    if (rows > 0) log.debug({ symbol, liq, oi }, "[V9_FEED]");
    return { liq, oi };
  }
}
