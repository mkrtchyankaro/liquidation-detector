import type { MongoClientWrapper } from "./mongo.client";
import type {
  GlobalSignalDoc,
  UnitResearchCandidateDoc,
  UnitCompetitionCandidateDoc,
  CommonHorizonCandidateDoc,
} from "../../domain/signal/global-signal.model";
import type { GlobalSignalRepositoryPort } from "../../application/ports";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "global-signal-repo" });

export class GlobalSignalRepository implements GlobalSignalRepositoryPort {
  private indexesEnsured = false;

  constructor(private readonly mongo: MongoClientWrapper) {}

  /** Sep 8 2026 (Karo) -- same pattern/severity as liqwatch-bot's own
   *  db/execution-record.repository.ts / db/execution-claim.repository.ts
   *  ensureIndexes() (unique index = real idempotency guarantee,
   *  throws + treated as a startup blocker on failure). The OLD,
   *  single-collection v5-signal.repository.ts had NO index management
   *  at all -- this is a genuinely new addition, not a reproduction --
   *  but the operator explicitly requested it: "ensure canonical
   *  signalId cannot accidentally duplicate". */
  async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) return;
    const col = await this.mongo.globalSignals();
    if (!col) return;
    try {
      await col.createIndexes([
        {
          key: { signalId: 1 },
          name: "global_signal_signalId_unique",
          unique: true,
        },
      ]);
      this.indexesEnsured = true;
      log.info("global signal index ensured (signalId unique)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg },
        "FAILED to ensure global signal index -- treat as a startup blocker",
      );
      throw err;
    }
  }

  async insert(doc: GlobalSignalDoc): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.insertOne(doc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId: doc.signalId },
        "[GLOBAL_SIGNAL_INSERT_FAILED] -- non-fatal, fan-out continues",
      );
    }
  }

  /** Sep 8 2026 (Karo) -- appends ONE completed research checkpoint
   *  group to an existing doc's own researchCheckpoints array
   *  ($push, never a full-document rewrite). Called once per
   *  completed offset (up to 5 times per signalId total, sparse --
   *  see ResearchCheckpointTracker's own doc comment). Silently no-op
   *  if the target doc doesn't exist (e.g. Mongo was briefly
   *  unavailable when the original insert() happened) -- never
   *  throws back into the price-tick handling path. */
  async appendCheckpoint(
    signalId: string,
    group: GlobalSignalDoc["researchCheckpoints"][number],
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne(
        { signalId },
        { $push: { researchCheckpoints: group } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId },
        "[GLOBAL_SIGNAL_APPEND_CHECKPOINT_FAILED] -- non-fatal",
      );
    }
  }

  /** Sep 9 2026 (Karo), operator-requested RESEARCH-ONLY ATR-timeframe
   *  comparison. Writes ONE shadow candidate's own terminal (entry or
   *  no-entry) summary. */
  async setUnitResearchCandidate(
    signalId: string,
    label: "atr3m" | "atr5m",
    candidate: UnitResearchCandidateDoc,
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne(
        { signalId },
        { $set: { [`unitResearch.${label}`]: candidate } },
        { upsert: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId, label },
        "[GLOBAL_SIGNAL_SET_UNIT_RESEARCH_FAILED] -- non-fatal",
      );
    }
  }

  /** Sep 9 2026 (Karo) -- appends ONE MFE/MAE checkpoint to a shadow
   *  candidate's own checkpoints array. */
  async appendUnitResearchCheckpoint(
    signalId: string,
    label: "atr3m" | "atr5m",
    checkpoint: UnitResearchCandidateDoc["checkpoints"][number],
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne(
        { signalId },
        { $push: { [`unitResearch.${label}.checkpoints`]: checkpoint } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId, label },
        "[GLOBAL_SIGNAL_APPEND_UNIT_RESEARCH_CHECKPOINT_FAILED] -- non-fatal",
      );
    }
  }

  /** Sep 10 2026 (Karo), operator-requested LIVE 3-way ATR-unit
   *  "dragon" competition -- $setOnInsert for symbol/side/signalTs
   *  (race-tolerant, never overwrites production's own canonical
   *  values), plain $set for the candidate doc itself. */
  async setUnitCompetitionCandidate(
    signalId: string,
    candidate: "atr1m" | "atr3m" | "atr5m",
    doc: UnitCompetitionCandidateDoc,
    meta: { symbol: string; side: "LONG" | "SHORT"; signalTs: number },
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne(
        { signalId },
        {
          $set: { [`unitCompetitionResearch.${candidate}`]: doc },
          $setOnInsert: {
            symbol: meta.symbol,
            side: meta.side,
            signalTs: meta.signalTs,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId, candidate },
        "[GLOBAL_SIGNAL_SET_UNIT_COMPETITION_FAILED] -- non-fatal",
      );
    }
  }

  async appendUnitCompetitionCheckpoint(
    signalId: string,
    candidate: "atr1m" | "atr3m" | "atr5m",
    checkpoint: UnitCompetitionCandidateDoc["checkpoints"][number],
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne(
        { signalId },
        {
          $push: {
            [`unitCompetitionResearch.${candidate}.checkpoints`]: checkpoint,
          },
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId, candidate },
        "[GLOBAL_SIGNAL_APPEND_UNIT_COMPETITION_CHECKPOINT_FAILED] -- non-fatal",
      );
    }
  }

  async setUnitCompetitionWinner(
    signalId: string,
    winnerCandidate: "atr1m" | "atr3m" | "atr5m",
    winnerEntryTs: number,
    meta: { symbol: string; side: "LONG" | "SHORT"; signalTs: number },
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne(
        { signalId },
        {
          $set: {
            "unitCompetitionResearch.winnerCandidate": winnerCandidate,
            "unitCompetitionResearch.winnerEntryTs": winnerEntryTs,
          },
          $setOnInsert: {
            symbol: meta.symbol,
            side: meta.side,
            signalTs: meta.signalTs,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId, winnerCandidate },
        "[GLOBAL_SIGNAL_SET_UNIT_COMPETITION_WINNER_FAILED] -- non-fatal",
      );
    }
  }

  async setUnitCompetitionWinnerResult(
    signalId: string,
    result: "TP" | "SL",
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne(
        { signalId },
        { $set: { "unitCompetitionResearch.winnerResult": result } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId, result },
        "[GLOBAL_SIGNAL_SET_UNIT_COMPETITION_WINNER_RESULT_FAILED] -- non-fatal",
      );
    }
  }

  /** Sep 10 2026 (Karo), operator-requested RESEARCH-ONLY common-horizon
   *  Wilder-ATR experiment ("common-horizon-4h-v1"). Same $setOnInsert
   *  pattern for symbol/side/signalTs + the version tag. */
  async setCommonHorizonCandidate(
    signalId: string,
    candidate: "atr1m" | "atr3m" | "atr5m",
    doc: CommonHorizonCandidateDoc,
    meta: { symbol: string; side: "LONG" | "SHORT"; signalTs: number },
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne(
        { signalId },
        {
          $set: { [`commonHorizonResearch.${candidate}`]: doc },
          $setOnInsert: {
            symbol: meta.symbol,
            side: meta.side,
            signalTs: meta.signalTs,
            "commonHorizonResearch.version": "common-horizon-4h-v1",
          },
        },
        { upsert: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId, candidate },
        "[GLOBAL_SIGNAL_SET_COMMON_HORIZON_CANDIDATE_FAILED] -- non-fatal",
      );
    }
  }

  async setCommonHorizonWinner(
    signalId: string,
    winnerCandidate: "atr1m" | "atr3m" | "atr5m",
    winnerEntryTs: number,
    meta: { symbol: string; side: "LONG" | "SHORT"; signalTs: number },
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne(
        { signalId },
        {
          $set: {
            "commonHorizonResearch.winnerCandidate": winnerCandidate,
            "commonHorizonResearch.winnerEntryTs": winnerEntryTs,
          },
          $setOnInsert: {
            symbol: meta.symbol,
            side: meta.side,
            signalTs: meta.signalTs,
            "commonHorizonResearch.version": "common-horizon-4h-v1",
          },
        },
        { upsert: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId, winnerCandidate },
        "[GLOBAL_SIGNAL_SET_COMMON_HORIZON_WINNER_FAILED] -- non-fatal",
      );
    }
  }

  async setCommonHorizonWinnerResult(
    signalId: string,
    result: "TP" | "SL",
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne(
        { signalId },
        { $set: { "commonHorizonResearch.winnerResult": result } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId, result },
        "[GLOBAL_SIGNAL_SET_COMMON_HORIZON_WINNER_RESULT_FAILED] -- non-fatal",
      );
    }
  }

  async appendCommonHorizonCheckpoint(
    signalId: string,
    candidate: "atr1m" | "atr3m" | "atr5m",
    checkpoint: CommonHorizonCandidateDoc["checkpoints"][number],
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne(
        { signalId },
        {
          $push: {
            [`commonHorizonResearch.${candidate}.checkpoints`]: checkpoint,
          },
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId, candidate },
        "[GLOBAL_SIGNAL_APPEND_COMMON_HORIZON_CHECKPOINT_FAILED] -- non-fatal",
      );
    }
  }

  /** Sep 8 2026 (Karo) -- finalizes MAIN's OWN canonical close, set by
   *  V5WaveService.onPriceTickForTrades() detecting a market-price TP/
   *  SL touch -- completely independent of any user's own Binance
   *  reconciliation (see reconcile-user-position.usecase.ts, which
   *  never touches this collection at all). */
  async finalizeMainClose(
    signalId: string,
    fields: {
      status: "CLOSED_TP" | "CLOSED_SL";
      closedAt: number;
      closePrice: number;
      maxFavorableR: number;
      maxAdverseR: number;
    },
  ): Promise<void> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return;
      await col.updateOne({ signalId }, { $set: fields });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, signalId },
        "[GLOBAL_SIGNAL_FINALIZE_MAIN_CLOSE_FAILED]",
      );
    }
  }

  /** Sep 8 2026 (Karo) -- for restart-hydration of the MAIN same-
   *  symbol lock (market-data-orchestrator.ts's own hydrateMainLocks()).
   *  status="SIGNAL" is the ONLY "open" state -- see GlobalSignalDoc's
   *  own doc comment for the full status-value breakdown. */
  async findOpenMainSignals(): Promise<GlobalSignalDoc[]> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return [];
      return (await col
        .find({ status: "SIGNAL" })
        .toArray()) as unknown as GlobalSignalDoc[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "[GLOBAL_SIGNAL_FIND_OPEN_MAIN_FAILED]");
      return [];
    }
  }

  /** Sep 14 2026 (Karo), operator-approved -- V5 ROTATION mode causal
   *  cumulative-episode-total P95 history. Reads the SAME already-
   *  persisted GlobalSignalDoc records every terminal outcome (signal
   *  or non-signal) already writes -- no new collection, no new
   *  write path. Filtered to `rotationDiagnostics.entryMode ===
   *  "ROTATION"` so WAVE-mode episode totals (a structurally
   *  different quantity -- Wave1/Wave2 chains vs one continuous
   *  watch) never leak into this distribution. `beforeTs` must be the
   *  CURRENT watch's own createdAt -- only episodes with `createdAt <
   *  beforeTs` are ever included, so a live process can never see
   *  its own or a future episode's total. `totalEpisodePressure` on
   *  every one of these records already reflects the correct
   *  snapshot for its own outcome (at-entry for a fired signal, since
   *  evaluateSignal() reads it synchronously before the watch is
   *  released; final-at-expiry for a terminal non-signal). */
  async findCompletedRotationEpisodeTotals(
    symbol: string,
    victim: "LONG" | "SHORT",
    beforeTs: number,
    limit = 500,
  ): Promise<{ totalUsd: number; completedAt: number }[]> {
    try {
      const col = await this.mongo.globalSignals();
      if (!col) return [];
      const docs = (await col
        .find({
          symbol,
          victim,
          createdAt: { $lt: beforeTs },
          "rotationDiagnostics.entryMode": "ROTATION",
        })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray()) as unknown as GlobalSignalDoc[];
      return docs.map((d) => ({
        totalUsd: d.totalEpisodePressure,
        completedAt: d.createdAt,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { symbol, victim, err: msg },
        "[GLOBAL_SIGNAL_FIND_ROTATION_EPISODES_FAILED]",
      );
      return [];
    }
  }
}
