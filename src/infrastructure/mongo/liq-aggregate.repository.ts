import type { MongoClientWrapper } from "./mongo.client";
import type { PersistenceConfig } from "../config/persistence.config";
import { ensureTtlIndexSeconds } from "./mongo-ttl-helper";
import { childLogger } from "../logging/logger";

/** A single forensic event stored inside a minute aggregate. */
export interface TopEvent {
  price: number;
  quantity: number;
  quoteQty: number;
  timestamp: number;
}

/** Minute-aggregate document as stored in liq_minute_aggregates. */
export interface LiqMinuteAggregateDoc {
  symbol: string;
  /** ms since epoch, floor(eventTime / 60_000) * 60_000 */
  minuteStart: number;
  longSum: number;
  shortSum: number;
  longCount: number;
  shortCount: number;
  longMax: number;
  shortMax: number;
  /** Up to topEventsPerMinute largest LONG-victim events (sorted desc by quoteQty). */
  topLong: TopEvent[];
  /** Up to topEventsPerMinute largest SHORT-victim events (sorted desc by quoteQty). */
  topShort: TopEvent[];
  /** Server-side insert timestamp; TTL index is on this field. */
  createdAt: Date;
  schemaVersion: number;
}

/** Per-symbol cursor doc for liq_state_meta. */
export interface LiqStateMetaDoc {
  /** Symbol used as the document _id. */
  _id: string;
  lastFlushedMinute: number;
  totalSamplesAllTime: number;
  warmAt: Date | null;
  schemaVersion: number;
}

const SCHEMA_VERSION = 1;
const COLL_AGGREGATES = "liq_minute_aggregates";
const COLL_META = "liq_state_meta";

/**
 * Mongo CRUD for liquidation persistence (Step E).
 *
 * Two collections:
 *   - liq_minute_aggregates  (TTL = retentionDays, unique on symbol+minuteStart)
 *   - liq_state_meta         (one doc per symbol, no TTL)
 *
 * Resilience model: every public method swallows Mongo errors and either
 * logs a WARN and returns a sensible empty/falsy value, or returns a
 * structured failure result. The bot must continue running even if Mongo
 * is intermittently unreachable.
 *
 * We deliberately reuse the existing MongoClientWrapper.ensure() so we
 * inherit its connection pooling and 60s failure cooldown, and so this
 * repository never opens its own client.
 *
 * FUTURE NOTE: wall_minute_aggregates would live as a sibling of this
 * file, ideally `src/db/wall-aggregate.repository.ts`, with the same
 * idempotent-upsert + TTL pattern.
 */
export class LiqAggregateRepository {
  private readonly log = childLogger({ mod: "liq-persist" });
  private indexesEnsured = false;
  private degraded = false;

  constructor(
    private readonly mongo: MongoClientWrapper,
    private readonly cfg: PersistenceConfig,
  ) {}

  /** True when Mongo connection failed in a way that warrants disabling writes
   *  for the rest of this process. Reads still attempt opportunistically. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  // ── Index management ─────────────────────────────────────────────

  /** Idempotently ensure both collections have the right indexes incl. TTL.
   *  Safe to call multiple times. Returns true on success. */
  async ensureIndexes(): Promise<boolean> {
    if (this.indexesEnsured) return true;
    const db = await this.mongo.ensureShared();
    if (!db) return false;
    try {
      const aggregates = db.collection<LiqMinuteAggregateDoc>(COLL_AGGREGATES);

      await aggregates.createIndexes([
        // Idempotent upsert filter — uniqueness prevents double-counting on
        // crashed flushes that retry.
        {
          key: { symbol: 1, minuteStart: 1 },
          name: "symbol_minute_unique",
          unique: true,
        },
        // Warmup range scan: latest-first read of last N hours per symbol.
        { key: { symbol: 1, minuteStart: -1 }, name: "symbol_minute_desc" },
      ]);

      // Sep 17 2026 (Karo), operator-requested retention pass. TTL on
      // createdAt is now managed via ensureTtlIndexSeconds(), which
      // updates the value IN PLACE (collMod) regardless of the
      // existing index's name -- the OLD code named this index
      // `ttl_${retentionDays}d`, so every time an operator changed
      // LIQ_RETENTION_DAYS the next createIndexes() call would try to
      // add a SECOND, differently-named TTL index on the exact same
      // {createdAt:1} key and fail with IndexOptionsConflict (or, if
      // it happened to succeed, leave two conflicting TTL indexes on
      // the same field). This is fixed structurally now: whatever the
      // existing TTL index on createdAt is named, its value is simply
      // updated to match this.cfg.retentionDays going forward.
      const ttlSeconds = this.cfg.retentionDays * 24 * 3600;
      const ttlResult = await ensureTtlIndexSeconds(
        db,
        COLL_AGGREGATES,
        "createdAt",
        ttlSeconds,
        "ttl_createdAt",
      );

      // liq_state_meta: _id is the symbol, no extra indexes needed.
      this.indexesEnsured = true;
      this.log.info(
        {
          coll: COLL_AGGREGATES,
          ttlDays: this.cfg.retentionDays,
          ttlAction: ttlResult.action,
        },
        "indexes ensured",
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.degraded = true;
      this.log.warn(
        { err: msg },
        "failed to ensure indexes; persistence disabled for this run",
      );
      return false;
    }
  }

  // ── Reads (warmup) ───────────────────────────────────────────────

  /**
   * Range-scan minute aggregates for a single symbol within [sinceMs, nowMs).
   * Returned ascending by minuteStart so callers can replay buckets in order.
   * On Mongo failure, returns [] and logs a WARN — never throws.
   */
  async readRange(
    symbol: string,
    sinceMs: number,
    nowMs: number,
  ): Promise<LiqMinuteAggregateDoc[]> {
    const db = await this.mongo.ensureShared();
    if (!db) return [];
    try {
      const coll = db.collection<LiqMinuteAggregateDoc>(COLL_AGGREGATES);
      const docs = await coll
        .find({ symbol, minuteStart: { $gte: sinceMs, $lt: nowMs } })
        .sort({ minuteStart: 1 })
        .toArray();
      return docs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { symbol, err: msg },
        "readRange failed; treating as empty",
      );
      return [];
    }
  }

  // ── Writes (flush) ───────────────────────────────────────────────

  /**
   * Upsert one minute aggregate. Idempotent thanks to the unique
   * (symbol, minuteStart) index — repeated flushes for the same minute
   * just overwrite the same doc. Returns true on success.
   */
  async upsertMinute(
    doc: Omit<LiqMinuteAggregateDoc, "createdAt" | "schemaVersion">,
  ): Promise<boolean> {
    if (this.degraded) return false;
    const db = await this.mongo.ensureShared();
    if (!db) return false;
    try {
      const coll = db.collection<LiqMinuteAggregateDoc>(COLL_AGGREGATES);
      await coll.updateOne(
        { symbol: doc.symbol, minuteStart: doc.minuteStart },
        {
          $set: {
            longSum: doc.longSum,
            shortSum: doc.shortSum,
            longCount: doc.longCount,
            shortCount: doc.shortCount,
            longMax: doc.longMax,
            shortMax: doc.shortMax,
            topLong: doc.topLong,
            topShort: doc.topShort,
            schemaVersion: SCHEMA_VERSION,
          },
          // createdAt is set once on insert and is the TTL key — do NOT
          // refresh it on update, otherwise re-flushing would bump retention.
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { symbol: doc.symbol, minuteStart: doc.minuteStart, err: msg },
        "upsertMinute failed",
      );
      return false;
    }
  }

  /** Update the per-symbol cursor doc. Best-effort: warns on failure. */
  async updateMeta(meta: LiqStateMetaDoc): Promise<boolean> {
    if (this.degraded) return false;
    const db = await this.mongo.ensureShared();
    if (!db) return false;
    try {
      const coll = db.collection<LiqStateMetaDoc>(COLL_META);
      await coll.updateOne(
        { _id: meta._id },
        {
          $set: {
            lastFlushedMinute: meta.lastFlushedMinute,
            totalSamplesAllTime: meta.totalSamplesAllTime,
            warmAt: meta.warmAt,
            schemaVersion: SCHEMA_VERSION,
          },
        },
        { upsert: true },
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { symbol: meta._id, err: msg },
        "updateMeta failed (non-fatal)",
      );
      return false;
    }
  }

  /** Read meta doc for one symbol; null if missing or on failure. */
  async readMeta(symbol: string): Promise<LiqStateMetaDoc | null> {
    const db = await this.mongo.ensureShared();
    if (!db) return null;
    try {
      const coll = db.collection<LiqStateMetaDoc>(COLL_META);
      return await coll.findOne({ _id: symbol });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ symbol, err: msg }, "readMeta failed");
      return null;
    }
  }
}
