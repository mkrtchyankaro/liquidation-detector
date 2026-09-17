import type { Collection } from "mongodb";
import type { MongoClientWrapper } from "./mongo.client";
import { ensureTtlIndexSeconds } from "./mongo-ttl-helper";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "oi-second-obs-repo" });

/** Sep 17 2026 (Karo), operator-requested retention pass. Changed
 *  from the prior 7 days to 3 days -- this is high-frequency (~1s)
 *  research-only data with no production reader (confirmed by source
 *  audit: OiSecondObservationRepository is written to but never
 *  queried from anywhere in src/), so shortening retention carries no
 *  production risk. */
export const OI_SECOND_OBSERVATION_TTL_SECONDS = 3 * 24 * 3600;
const TTL_INDEX_NAME = "ttl_timestamp";

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
      const db = await this.mongo.ensureOwn();
      if (!col || !db) return false;
      await col.createIndex({ symbol: 1, timestamp: 1 });
      await ensureTtlIndexSeconds(
        db,
        "oi_second_observations",
        "timestamp",
        OI_SECOND_OBSERVATION_TTL_SECONDS,
        TTL_INDEX_NAME,
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
