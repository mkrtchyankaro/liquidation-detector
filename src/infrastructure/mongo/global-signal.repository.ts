import type { MongoClientWrapper } from "./mongo.client";
import type {
  GlobalSignalDoc,
  UnitResearchCandidateDoc,
  UnitCompetitionCandidateDoc,
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
   *  no-entry) summary via $set on unitResearch.<label>. upsert:true --
   *  a shadow candidate (3m or 5m UNIT) can genuinely reach its own
   *  terminal state BEFORE OR AFTER production's own 1m-UNIT episode
   *  does (that is precisely the timing difference this whole
   *  experiment measures), so the production doc may not exist yet.
   *  KNOWN, ACCEPTED LIMITATION: in that race, this creates a partial
   *  document (signalId + unitResearch.<label> only) that production's
   *  own later insert does not currently merge into -- a rare, non-
   *  critical research-data-completeness gap, not a production-safety
   *  concern (this method never runs on the production entry/execution
   *  path in either order). */
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
   *  candidate's own checkpoints array, mirroring appendCheckpoint()'s
   *  own $push pattern exactly. */
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
   *  "dragon" competition -- SAME pattern as setUnitResearchCandidate()
   *  above, writing into the SEPARATE unitCompetitionResearch field
   *  instead. upsert:true for the exact same race-tolerance reason
   *  (candidates of different UNIT-timeframes resolve at different
   *  wall-clock times, independent of when/whether the production
   *  signal doc itself has been created yet).
   *
   *  Sep 10 2026 (Karo), operator-requested surgical fix -- also
   *  writes symbol/side/signalTs via $setOnInsert (NEVER $set): these
   *  values are mathematically guaranteed identical to production's
   *  own canonical values (same liquidation event, same victim-
   *  computation expression, same episode-start moment -- see
   *  market-data-orchestrator.ts's own call-site for the exact
   *  sourcing), but $setOnInsert is used regardless, as a hard,
   *  structural guarantee: if production's own canonical write has
   *  ALREADY created this document first, this call can NEVER touch
   *  symbol/side/signalTs again, no matter what. Purely additive
   *  metadata for the monitoring script's own display -- read by
   *  nothing else in this codebase. */
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

  /** Sep 10 2026 (Karo) -- appends ONE MFE/MAE checkpoint to a dragon
   *  candidate's own checkpoints array (PASS-verdict candidates only). */
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

  /** Sep 10 2026 (Karo), operator-requested MAIN-only Telegram research
   *  lifecycle. Sets the winner fields exactly once (the caller's own
   *  logic guarantees this is only invoked on the FIRST PASS for a
   *  given episode). upsert:true, same race-tolerance reasoning as
   *  setUnitCompetitionCandidate() above. Same $setOnInsert treatment
   *  for symbol/side/signalTs, same reasoning. */
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

  /** Sep 10 2026 (Karo) -- records the winner's own final TP/SL outcome,
   *  once the hypothetical position actually closes. */
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
}
