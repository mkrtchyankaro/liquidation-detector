import type { Collection } from "mongodb";
import type { MongoClientWrapper } from "./mongo.client";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "oi-second-obs-repo" });

/** Sep 16 2026 (Karo), operator-requested. TEMPORARY/RESEARCH data --
 *  see this file's own module doc comment. 7 days, matching the
 *  operator's own stated default. */
const TTL_SECONDS = 7 * 24 * 3600;

/** Buffer bounds: flushed on a timer OR when this size is reached,
 *  whichever comes first. Hard-capped (drop-oldest) so a prolonged
 *  Mongo outage can never grow this into an unbounded queue -- see
 *  bufferedInsert()'s own doc comment. */
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_AT_SIZE = 200; // ~20s worth at 10 symbols/1s -- flushes well before this in practice via the timer
const MAX_BUFFER_SIZE = 2_000; // ~200s worth at 10 symbols/1s -- generous margin above one flush interval's worth

/**
 * Sep 16 2026 (Karo), operator-requested. DATA COLLECTION ONLY -- no
 * production code reads this collection, and it is not intended to
 * ever be read from a hot path. Persists the EXISTING ~1s
 * OiTrackerService poll (see that file's own header) so a real
 * liquidation episode can later be replayed against a genuine
 * second-by-second OI timeline, rather than only the sparse
 * liquidation-event-timestamped waypoints liq_raw_events provides.
 *
 * NO NEW BINANCE REQUESTS: every observation buffered here originates
 * from OiTrackerService's own existing fetchOne() call -- this
 * repository is purely a sink for data that poll already receives.
 *
 * NEVER BLOCKS THE POLL: bufferedInsert() is synchronous and only
 * pushes into an in-memory array; the actual Mongo write happens on a
 * periodic timer, fully decoupled from the polling loop's own timing.
 * A Mongo outage degrades to "buffered observations get dropped once
 * MAX_BUFFER_SIZE is hit" -- it can never delay or block a poll tick.
 */
export interface OiSecondObservationDoc {
  symbol: string;
  timestamp: Date;
  oiUpdatedAt: Date | null;
  openInterest: number;
  openInterestUsd: number | null;
  price: number | null;
}

export class OiSecondObservationRepository {
  private buffer: OiSecondObservationDoc[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private droppedCount = 0;

  constructor(private readonly mongo: MongoClientWrapper) {
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    void this.flush();
  }

  async ensureIndexes(): Promise<boolean> {
    try {
      const col = await this.getCollection();
      if (!col) return false;
      await col.createIndex({ symbol: 1, timestamp: 1 });
      await col.createIndex(
        { timestamp: 1 },
        { expireAfterSeconds: TTL_SECONDS },
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "[OI_SECOND_OBS_ENSURE_INDEXES_FAILED]");
      return false;
    }
  }

  bufferedInsert(doc: OiSecondObservationDoc): void {
    this.buffer.push(doc);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      const overflow = this.buffer.length - MAX_BUFFER_SIZE;
      this.buffer.splice(0, overflow);
      this.droppedCount += overflow;
      log.warn(
        `[OI_SECOND_OBS_BUFFER_OVERFLOW] dropped ${overflow} oldest observations (totalDropped=${this.droppedCount}) -- Mongo write likely falling behind or down`,
      );
    } else if (this.buffer.length >= FLUSH_AT_SIZE) {
      void this.flush();
    }
  }

  private async getCollection(): Promise<Collection<OiSecondObservationDoc> | null> {
    return this.mongo.oiSecondObservations();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      const col = await this.getCollection();
      if (!col) {
        this.buffer = batch.concat(this.buffer);
        return;
      }
      await col.insertMany(batch, { ordered: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, batchSize: batch.length },
        "[OI_SECOND_OBS_FLUSH_FAILED] -- isolated, never blocks OI polling",
      );
      this.buffer = batch.concat(this.buffer);
    }
  }
}
