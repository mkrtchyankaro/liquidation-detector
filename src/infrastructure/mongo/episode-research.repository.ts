import type { MongoClientWrapper } from "./mongo.client";
import type { EpisodeResearchRecord } from "../../domain/liquidation-oi-strategy/episode-research-recorder";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "episode-research-repo" });

/**
 * Sep 19 2026 (Karo), operator-requested Episode Research capture.
 * ONE document per finished episode (entry or no-entry alike) --
 * insert-only (each episodeId is written exactly once, at the moment
 * EpisodeResearchRecorder finalizes it via onEntry() or
 * onEpisodeTerminal()). Purely research storage; read by nothing in
 * the live strategy.
 */
export class EpisodeResearchRepository {
  constructor(private readonly mongo: MongoClientWrapper) {}

  async ensureIndexes(): Promise<boolean> {
    const col = await this.mongo.liquidationOiEpisodeResearch();
    if (col === null) return false;
    await col.createIndex({ episodeId: 1 }, { unique: true });
    await col.createIndex({ symbol: 1, createdAtMs: -1 });
    return true;
  }

  async insert(record: EpisodeResearchRecord): Promise<boolean> {
    const col = await this.mongo.liquidationOiEpisodeResearch();
    if (col === null) return false;
    try {
      await col.insertOne({ ...record, _persistedAt: new Date() });
      return true;
    } catch (err) {
      // duplicate episodeId (should never happen -- each episode is
      // finalized exactly once) or a transient Mongo error; either
      // way, never throw into the caller's own tick loop over a
      // purely observational write.
      log.error({ episodeId: record.episodeId, symbol: record.symbol, err: err instanceof Error ? err.message : String(err) }, "[EPISODE_RESEARCH_PERSIST_FAILED]");
      return false;
    }
  }
}
