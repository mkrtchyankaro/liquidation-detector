import type { Side } from "../../shared/common.types";
import type { MongoClientWrapper } from "./mongo.client";
import type { RotationEpisodeHistoryDoc } from "../../domain/signal/rotation-episode-history.model";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "rotation-episode-history-repo" });

export class RotationEpisodeHistoryRepository {
  constructor(private readonly mongo: MongoClientWrapper) {}

  /** Idempotent, safe to call every boot/backfill run. The unique
   *  index on {symbol, victim, episodeStartTs} is what makes reruns
   *  safe -- episodeStartTs is the real historical timestamp of the
   *  episode's own first liquidation, a deterministic identity that
   *  is always reproduced identically by replaying the SAME raw
   *  event stream, so a duplicate insert always collides on this
   *  index rather than creating a second copy of the same episode. */
  async ensureIndexes(): Promise<boolean> {
    try {
      const col = await this.mongo.rotationEpisodeHistory();
      if (!col) return false;
      await col.createIndex(
        { symbol: 1, victim: 1, episodeStartTs: 1 },
        { name: "rotation_episode_identity_unique", unique: true },
      );
      // Sep 14 2026 (Karo) -- the causal P95 read pattern is always
      // "same symbol, same victim, episodeEndTs < watch.createdAt" --
      // this index serves that query directly.
      await col.createIndex(
        { symbol: 1, victim: 1, episodeEndTs: 1 },
        { name: "rotation_episode_causal_read" },
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg },
        "[ROTATION_EPISODE_HISTORY_ENSURE_INDEXES_FAILED]",
      );
      return false;
    }
  }

  /** Idempotent upsert keyed by the episode's own deterministic
   *  identity -- rerunning the backfill over the same historical
   *  range updates a doc in place (harmless, same values) rather than
   *  creating a duplicate. Returns "inserted" | "duplicate" | "error"
   *  so the CLI can report accurate counts. */
  async upsertEpisode(
    doc: RotationEpisodeHistoryDoc,
  ): Promise<"inserted" | "duplicate" | "error"> {
    try {
      const col = await this.mongo.rotationEpisodeHistory();
      if (!col) return "error";
      const result = await col.updateOne(
        {
          symbol: doc.symbol,
          victim: doc.victim,
          episodeStartTs: doc.episodeStartTs,
        },
        { $setOnInsert: doc },
        { upsert: true },
      );
      return result.upsertedCount > 0 ? "inserted" : "duplicate";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err: msg,
          symbol: doc.symbol,
          victim: doc.victim,
          episodeStartTs: doc.episodeStartTs,
        },
        "[ROTATION_EPISODE_HISTORY_UPSERT_FAILED]",
      );
      return "error";
    }
  }

  /** Causal read: same symbol, same victim, completed strictly before
   *  `beforeTs`. No artificial cap on sample count beyond `limit` --
   *  `limit` exists only as a runaway-query safety bound (default
   *  large enough to never be hit by any realistic backfilled
   *  history), never as an intentional rolling lookback -- per
   *  explicit operator instruction not to invent one where none
   *  exists in production today. */
  async findCausalPriorEpisodes(
    symbol: string,
    victim: Side,
    beforeTs: number,
    limit = 50_000,
  ): Promise<{ totalUsd: number; completedAt: number }[]> {
    try {
      const col = await this.mongo.rotationEpisodeHistory();
      if (!col) return [];
      const docs = await col
        .find({ symbol, victim, episodeEndTs: { $lt: beforeTs } })
        .project<{ cumulativeLiqUsd: number; episodeEndTs: number }>({
          cumulativeLiqUsd: 1,
          episodeEndTs: 1,
        })
        .limit(limit)
        .toArray();
      return docs.map((d) => ({
        totalUsd: d.cumulativeLiqUsd,
        completedAt: d.episodeEndTs,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol, victim, err: msg },
        "[ROTATION_EPISODE_HISTORY_FIND_CAUSAL_FAILED]",
      );
      return [];
    }
  }
}
