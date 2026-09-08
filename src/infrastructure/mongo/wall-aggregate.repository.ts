import type { MongoClientWrapper } from "./mongo.client";
import type { WallPersistenceConfig } from "../config/wall-persistence.config";
import { childLogger } from '../logging/logger';

/**
 * Wall minute summary as stored in wall_minute_aggregates.
 *
 * Snapshot of the WallTrackerService state at minute end (top wall + counts)
 * combined with two counters accumulated DURING the minute (pulls, new walls).
 *
 * Every field is intentionally compact — we deliberately do NOT persist the
 * full candidate wall list per minute (50 walls × 4 symbols × 1440 min/day
 * would explode storage for marginal analytical value).
 */
export interface WallMinuteAggregateDoc {
  symbol: string;
  /** ms since epoch, floor(now / 60_000) * 60_000 */
  minuteStart: number;

  // ── Top wall snapshot at minute end (null if none) ─────────────
  topBidWallNotional: number | null;
  topBidWallPrice: number | null;
  topBidWallAgeMs: number | null;
  topAskWallNotional: number | null;
  topAskWallPrice: number | null;
  topAskWallAgeMs: number | null;

  // ── Counts at minute end ──────────────────────────────────────
  candidateBidCount: number;
  candidateAskCount: number;
  persistentBidCount: number;
  persistentAskCount: number;

  // ── Counters accumulated DURING the minute ────────────────────
  pulled1mCount: number;
  newWallsCount: number;

  // ── Reference for analytical interpretation ───────────────────
  /** Mid price at minute end. Lets you compute (wallPrice - mid)/mid later. */
  midPrice: number | null;

  // ── Standard ──────────────────────────────────────────────────
  createdAt: Date;
  schemaVersion: number;
}

const SCHEMA_VERSION = 1;
const COLL_AGGREGATES = "wall_minute_aggregates";

/**
 * Mongo CRUD for wall minute summaries (Step E2).
 *
 * One collection only — wall_minute_aggregates with TTL. There is no
 * wall_state_meta because there is no warmup, hence no need for a
 * "where did we leave off" cursor (intentional — see config docstring).
 *
 * Resilience model: same as Step E. Every public method swallows Mongo
 * errors and returns a sensible falsy value. The bot never crashes due
 * to wall persistence.
 *
 * Reuses the existing MongoClientWrapper (no new connection).
 */
export class WallAggregateRepository {
  private readonly log = childLogger({ mod: "wall-persist" });
  private indexesEnsured = false;
  private degraded = false;

  constructor(
    private readonly mongo: MongoClientWrapper,
    private readonly cfg: WallPersistenceConfig,
  ) {}

  /** True when index creation failed in a way that warrants disabling writes
   *  for the rest of this process. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /** Idempotently ensure indexes incl. TTL. Safe to call multiple times.
   *  Returns true on success. */
  async ensureIndexes(): Promise<boolean> {
    if (this.indexesEnsured) return true;
    const db = await this.mongo.ensureShared();
    if (!db) return false;
    try {
      const coll = db.collection<WallMinuteAggregateDoc>(COLL_AGGREGATES);
      const ttlSeconds = this.cfg.retentionDays * 24 * 3600;

      await coll.createIndexes([
        // Idempotent upsert filter — uniqueness prevents double-write on
        // restart-during-minute or accidental two-bot scenarios.
        {
          key: { symbol: 1, minuteStart: 1 },
          name: "symbol_minute_unique",
          unique: true,
        },
        // Forensic range scans (newest first).
        { key: { symbol: 1, minuteStart: -1 }, name: "symbol_minute_desc" },
        // TTL on createdAt — set once at insert, never moves on update.
        {
          key: { createdAt: 1 },
          name: `ttl_${this.cfg.retentionDays}d`,
          expireAfterSeconds: ttlSeconds,
        },
      ]);
      this.indexesEnsured = true;
      this.log.info(
        { coll: COLL_AGGREGATES, ttlDays: this.cfg.retentionDays },
        "wall persistence indexes ensured",
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.degraded = true;
      this.log.warn(
        { err: msg },
        "failed to ensure wall indexes; wall persistence disabled for this run",
      );
      return false;
    }
  }

  /**
   * Upsert one minute aggregate. Idempotent thanks to the unique
   * (symbol, minuteStart) index — a retried write for the same minute
   * just overwrites the same doc with the latest values.
   *
   * Failure handling: returns false on Mongo error. The orchestrator does
   * NOT queue retries — wall snapshots are point-in-time observations and
   * a missed minute is acceptable (unlike liquidations, which need
   * continuity for percentile recovery).
   */
  async upsertMinute(
    doc: Omit<WallMinuteAggregateDoc, "createdAt" | "schemaVersion">,
  ): Promise<boolean> {
    if (this.degraded) return false;
    const db = await this.mongo.ensureShared();
    if (!db) return false;
    try {
      const coll = db.collection<WallMinuteAggregateDoc>(COLL_AGGREGATES);
      await coll.updateOne(
        { symbol: doc.symbol, minuteStart: doc.minuteStart },
        {
          $set: {
            topBidWallNotional: doc.topBidWallNotional,
            topBidWallPrice: doc.topBidWallPrice,
            topBidWallAgeMs: doc.topBidWallAgeMs,
            topAskWallNotional: doc.topAskWallNotional,
            topAskWallPrice: doc.topAskWallPrice,
            topAskWallAgeMs: doc.topAskWallAgeMs,
            candidateBidCount: doc.candidateBidCount,
            candidateAskCount: doc.candidateAskCount,
            persistentBidCount: doc.persistentBidCount,
            persistentAskCount: doc.persistentAskCount,
            pulled1mCount: doc.pulled1mCount,
            newWallsCount: doc.newWallsCount,
            midPrice: doc.midPrice,
            schemaVersion: SCHEMA_VERSION,
          },
          // createdAt is the TTL key — set once on insert, never refreshed.
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { symbol: doc.symbol, minuteStart: doc.minuteStart, err: msg },
        "wall upsertMinute failed",
      );
      return false;
    }
  }
}
