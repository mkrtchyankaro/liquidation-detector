import type { Db, Collection, Document } from "mongodb";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "mongo-ttl" });

/**
 * Sep 17 2026 (Karo), operator-requested retention pass for
 * liq_raw_events, liq_minute_aggregates, and oi_second_observations.
 *
 * MongoDB TTL indexes can be created with any expireAfterSeconds, but
 * CHANGING an existing TTL index's value is NOT done via createIndex
 * (that throws IndexOptionsConflict if a same-key index already
 * exists with different options) -- the correct, minimal-footprint
 * way is `collMod` with an `index` clause, which updates
 * expireAfterSeconds IN PLACE, no drop/rebuild window, no data
 * touched. This helper does exactly that, and only falls back to
 * create when no TTL index on that field exists yet.
 *
 * Also exposes dropStaleTtlIndex() for the one case collMod cannot
 * handle: replacing a TTL index on the WRONG FIELD entirely (e.g.
 * liq_raw_events' old index on the numeric `timestamp` field, which
 * never actually expired anything since MongoDB TTL only fires on a
 * genuine BSON Date field -- that index must be dropped and a new one
 * created on a real Date field instead; collMod cannot change an
 * index's key pattern, only its options).
 *
 * NEVER drops the collection. NEVER touches a non-TTL index (any
 * index this file did not itself create/modify is left completely
 * alone).
 */

export interface EnsureTtlIndexResult {
  action: "created" | "updated" | "unchanged" | "failed";
  indexName: string;
  before: number | null;
  after: number | null;
  detail?: string;
}

/** Idempotent. Ensures a TTL index on `fieldName` (must already be a
 *  genuine Date field in the documents) is set to exactly
 *  `ttlSeconds`. If a TTL index on that exact key already exists
 *  (any name), its value is updated in place via collMod when it
 *  differs. If none exists, one is created with `indexName`. */
export async function ensureTtlIndexSeconds(
  db: Db,
  collectionName: string,
  fieldName: string,
  ttlSeconds: number,
  indexName: string,
): Promise<EnsureTtlIndexResult> {
  try {
    const coll: Collection<Document> = db.collection(collectionName);
    const indexes = await coll.listIndexes().toArray();
    const existing = indexes.find((ix) => {
      const keys = Object.keys(ix.key ?? {});
      return (
        keys.length === 1 &&
        keys[0] === fieldName &&
        ix.key[fieldName] === 1 &&
        typeof ix.expireAfterSeconds === "number"
      );
    });

    if (existing === undefined) {
      await coll.createIndex({ [fieldName]: 1 } as Record<string, 1>, {
        name: indexName,
        expireAfterSeconds: ttlSeconds,
      });
      log.info(
        `[TTL_INDEX_CREATED] coll=${collectionName} field=${fieldName} ttlSeconds=${ttlSeconds} name=${indexName}`,
      );
      return { action: "created", indexName, before: null, after: ttlSeconds };
    }

    const before = existing.expireAfterSeconds as number;
    if (before === ttlSeconds) {
      return {
        action: "unchanged",
        indexName: existing.name as string,
        before,
        after: before,
      };
    }

    await db.command({
      collMod: collectionName,
      index: { name: existing.name, expireAfterSeconds: ttlSeconds },
    });
    log.info(
      `[TTL_INDEX_UPDATED] coll=${collectionName} field=${fieldName} name=${existing.name} before=${before} after=${ttlSeconds}`,
    );
    return {
      action: "updated",
      indexName: existing.name as string,
      before,
      after: ttlSeconds,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      `[TTL_INDEX_ENSURE_FAILED] coll=${collectionName} field=${fieldName}: ${msg}`,
    );
    return {
      action: "failed",
      indexName,
      before: null,
      after: null,
      detail: msg,
    };
  }
}

/** Drops any TTL index on `staleFieldName` in `collectionName`,
 *  regardless of its name -- used ONLY when replacing a TTL index on
 *  the wrong field (never for a field that is still the correct,
 *  intended TTL field; use ensureTtlIndexSeconds for that). Never
 *  drops a non-TTL index, never drops the collection. No-op (returns
 *  null) if no such index exists. */
export async function dropStaleTtlIndex(
  db: Db,
  collectionName: string,
  staleFieldName: string,
): Promise<string | null> {
  try {
    const coll: Collection<Document> = db.collection(collectionName);
    const indexes = await coll.listIndexes().toArray();
    const stale = indexes.find((ix) => {
      const keys = Object.keys(ix.key ?? {});
      return (
        keys.length === 1 &&
        keys[0] === staleFieldName &&
        typeof ix.expireAfterSeconds === "number"
      );
    });
    if (stale === undefined) return null;
    await coll.dropIndex(stale.name as string);
    log.warn(
      `[TTL_STALE_INDEX_DROPPED] coll=${collectionName} field=${staleFieldName} name=${stale.name} -- this index never functioned as a TTL (non-Date field) and is superseded by a new index on a genuine Date field`,
    );
    return stale.name as string;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      `[TTL_STALE_INDEX_DROP_FAILED] coll=${collectionName} field=${staleFieldName}: ${msg}`,
    );
    return null;
  }
}
