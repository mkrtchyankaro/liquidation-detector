import type { MongoClientWrapper } from "./mongo.client";
import type { GlobalSignalDoc } from "../../domain/signal/global-signal.model";
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
