import type { Db } from "mongodb";
import type { Side } from "../../shared/common.types";
import type { MongoClientWrapper } from "./mongo.client";
import { ensureTtlIndexSeconds, dropStaleTtlIndex } from "./mongo-ttl-helper";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "raw-liq-event-repo" });

/** Sep 17 2026 (Karo), operator-requested retention pass. Changed
 *  from the prior 60 days to 4 days: EpisodePercentileService (the
 *  only production reader) needs a rolling 3-day window plus a 6h
 *  left-censoring pad -- 78h of actual history -- so 4 days (96h)
 *  gives it an 18h safety buffer. See this file's own module doc
 *  comment for the full production-safety trace. */
const TTL_SECONDS = 4 * 24 * 3600;
const TTL_INDEX_NAME = "ttl_eventTimeDate";

/**
 * Sep 8 2026 (Karo). One document per individual liquidation event,
 * exactly as received from the WS forceOrder stream -- zero
 * derivation, zero aggregation. This is a NEW capability the old bot
 * never had (liq_minute_aggregates only keeps per-minute sums/counts
 * plus a top-N sample of the largest events; the exact sequence,
 * timing, and individual size of every OTHER event within a dense
 * burst was permanently unrecoverable there). Confirmed cheap:
 * ~200 bytes/doc, realistic volume estimate a few hundred KB/day even
 * during volatile periods -- see the operator-facing audit this was
 * proposed in for the full storage-cost estimate. Bounded via a TTL
 * index (60 days) rather than unbounded retention.
 */
export interface RawLiquidationEventDoc {
  symbol: string;
  /** Derived once, at write time, from the raw WS side (SELL=LONG
   *  liquidated, BUY=SHORT liquidated) -- same convention V5WaveService
   *  itself uses (v5-wave.service.ts). Stored directly so research
   *  queries never have to re-derive it. */
  victim: Side;
  price: number;
  quoteQty: number;
  timestamp: number;
  /** Sep 15 2026 (Karo), operator-requested. Additive-only field --
   *  every field above this line is completely unchanged, so every
   *  existing reader of this collection (there are none in production
   *  code today, only offline research scripts) continues to work
   *  identically whether or not this field is present. Built
   *  synchronously from already-known RAM state at the moment of
   *  insertion by buildMarketSnapshot() (see that file's own doc
   *  comment for the full field-by-field causality and freshness
   *  contract). Optional because: (a) older documents written before
   *  this change will never have it, (b) the insert call defensively
   *  omits it entirely if snapshot construction throws, rather than
   *  ever blocking or corrupting the base liquidation write. */
  marketSnapshot?: Record<string, unknown>;
  /** Sep 17 2026 (Karo), operator-requested CRITICAL retention-pass
   *  fix. `timestamp` above is a plain number (epoch ms) -- MongoDB
   *  TTL indexes ONLY expire documents on a genuine BSON Date field;
   *  a TTL index on a numeric field is silently a no-op (confirmed by
   *  source audit: this collection's TTL index had existed since Sep
   *  8 2026 and had never actually deleted anything). This field is
   *  the SAME semantic value as `timestamp`, stored as a real Date,
   *  used ONLY for TTL expiry -- `timestamp` itself is left
   *  completely unchanged (every existing numeric-range query against
   *  it, in production and research code alike, keeps working
   *  identically). */
  eventTimeDate?: Date;
}

export class RawLiquidationEventRepository {
  constructor(private readonly mongo: MongoClientWrapper) {}

  /** Idempotent, safe to call every boot. Never throws -- a failure
   *  here degrades to "no TTL enforcement yet" rather than blocking
   *  startup, matching every other repository's own ensureIndexes()
   *  convention in this project. */
  async ensureIndexes(): Promise<boolean> {
    try {
      const col = await this.mongo.rawLiquidationEvents();
      const db = await this.mongo.ensureOwn();
      if (!col || !db) return false;
      await col.createIndex({ symbol: 1, timestamp: -1 });

      // Sep 17 2026 (Karo), operator-requested CRITICAL fix -- the
      // OLD TTL index lived on `timestamp` (a number), which MongoDB
      // TTL can never expire (Date-only). Drop it explicitly (it did
      // nothing functional, so this is safe) and create the REAL TTL
      // index on the new eventTimeDate field instead. collMod cannot
      // do this in one step because it changes the KEY, not just the
      // options -- a genuine drop+create is required here, unlike the
      // other two collections in this pass.
      const droppedName = await dropStaleTtlIndex(
        db,
        "liq_raw_events",
        "timestamp",
      );
      if (droppedName !== null) {
        log.warn(
          `[RAW_LIQ_EVENT_STALE_TTL_DROPPED] name=${droppedName} -- this index existed but had NEVER expired anything (TTL requires a genuine Date field, timestamp is a number)`,
        );
      }
      await ensureTtlIndexSeconds(
        db,
        "liq_raw_events",
        "eventTimeDate",
        TTL_SECONDS,
        TTL_INDEX_NAME,
      );
      // Note: not gating the return value on this result's success,
      // unlike the other two repositories' own ensureIndexes() (fixed
      // Sep 17 2026, operator-reported) -- this collection's TTL has
      // been confirmed working correctly in production (345600s
      // applied, matching this.mongo.ensureOwn()'s DB where collMod is
      // permitted), and the backfill below must still run regardless.

      // Backfill: any existing document written before this fix has
      // no eventTimeDate yet, so it would never expire under the new
      // index either. Idempotent (only touches documents still
      // missing the field) and cheap on every subsequent boot once
      // the backfill has fully run once (the filter matches nothing).
      // Derives the Date from the document's OWN original `timestamp`
      // value (not "now"), so backfilled documents get their TRUE
      // original retention window, never an artificially extended one.
      const backfillResult = await col.updateMany(
        { eventTimeDate: { $exists: false } },
        [{ $set: { eventTimeDate: { $toDate: "$timestamp" } } }],
      );
      if (backfillResult.modifiedCount > 0) {
        log.info(
          `[RAW_LIQ_EVENT_BACKFILL_EVENT_TIME_DATE] modifiedCount=${backfillResult.modifiedCount}`,
        );
      }

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "[RAW_LIQ_EVENT_ENSURE_INDEXES_FAILED]");
      return false;
    }
  }

  /** Fire-and-forget from the caller's perspective is NOT how this is
   *  used -- callers await this, but a failure here must never block
   *  or throw back into the live liquidation-tick handling path (that
   *  path drives real strategy decisions; this archive is purely
   *  additive research data). Always resolves, never throws. */
  async insert(doc: RawLiquidationEventDoc): Promise<void> {
    try {
      const col = await this.mongo.rawLiquidationEvents();
      if (!col) return;
      // eventTimeDate is always derived here, unconditionally, from
      // the same `timestamp` every caller already supplies -- no
      // caller needs to change, and it can never silently be missing
      // on a newly-written document going forward.
      await col.insertOne({ ...doc, eventTimeDate: new Date(doc.timestamp) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, symbol: doc.symbol },
        "[RAW_LIQ_EVENT_INSERT_FAILED] -- isolated, never blocks live processing",
      );
    }
  }
}

/** Exported for the one test that needs to inspect a raw Db handle
 *  directly (index verification) without going through the wrapper's
 *  own private ensure(). */
export type { Db };
