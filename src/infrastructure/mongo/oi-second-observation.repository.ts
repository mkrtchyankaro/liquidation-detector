import type { Db } from "mongodb";
import { ensureTtlIndexSeconds } from "./mongo-ttl-helper";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "oi-obs-repo" });

/** oi_second_observations: one row per OI poll (~1/s per symbol), written
 *  in small batches every few seconds. Retained 14 days (V9 replays; was 3). */
export const OI_SECOND_OBSERVATIONS = "oi_second_observations";
const TTL_SECONDS = 14 * 24 * 3600;
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_AT_SIZE = 200;
const MAX_BUFFER_SIZE = 5_000;

export interface OiSecondObservationDoc {
  symbol: string;
  timestamp: Date;          // when we polled
  oiUpdatedAt: Date | null; // Binance's own OI update time
  openInterest: number;     // contracts
  openInterestUsd: number | null;
  price: number | null;     // futures mid price at poll time
}

export class OiSecondObservationRepository {
  private buffer: OiSecondObservationDoc[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(private readonly db: () => Promise<Db | null>) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  async ensureIndexes(): Promise<void> {
    const db = await this.db();
    if (!db) throw new Error("Mongo unavailable");
    await db.collection(OI_SECOND_OBSERVATIONS).createIndex({ symbol: 1, timestamp: 1 });
    const ttl = await ensureTtlIndexSeconds(db, OI_SECOND_OBSERVATIONS, "timestamp", TTL_SECONDS, "ttl_timestamp");
    if (ttl.action === "failed") log.warn(`[OI_OBS_TTL_FAILED] ${ttl.detail}`);
  }

  add(doc: OiSecondObservationDoc): void {
    this.buffer.push(doc);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      const dropped = this.buffer.length - MAX_BUFFER_SIZE;
      this.buffer.splice(0, dropped);
      log.warn(`[OI_OBS_BUFFER_OVERFLOW] dropped ${dropped} oldest rows -- Mongo is falling behind`);
    } else if (this.buffer.length >= FLUSH_AT_SIZE) {
      void this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      const db = await this.db();
      if (!db) throw new Error("Mongo unavailable");
      await db.collection(OI_SECOND_OBSERVATIONS).insertMany(batch, { ordered: false });
    } catch (err) {
      this.buffer = batch.concat(this.buffer); // retry on the next flush
      log.error({ err: err instanceof Error ? err.message : String(err), batch: batch.length }, "[OI_OBS_FLUSH_FAILED]");
    } finally {
      this.flushing = false;
    }
  }
}
