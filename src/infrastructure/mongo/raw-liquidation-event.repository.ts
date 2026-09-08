import type { Db } from "mongodb";
import type { Side } from "../../shared/common.types";
import type { MongoClientWrapper } from "./mongo.client";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "raw-liq-event-repo" });

/** Retention window for the raw archive -- see this file's own module
 *  doc comment for why this is bounded rather than kept forever. */
const TTL_SECONDS = 60 * 24 * 3600; // 60 days

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
      if (!col) return false;
      await col.createIndex({ symbol: 1, timestamp: -1 });
      await col.createIndex(
        { timestamp: 1 },
        { expireAfterSeconds: TTL_SECONDS },
      );
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
      await col.insertOne(doc);
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
