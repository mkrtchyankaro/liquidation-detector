import type { MongoClientWrapper } from "./mongo.client";
import type {
  CascadeDoc,
  CascadeCandidateStateDoc,
} from "../../domain/cascade/cascade.model";
import { emptyCandidateStateDoc } from "../../domain/cascade/cascade.model";
import type { Side } from "../../shared/common.types";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "cascade-repository" });

/**
 * Sep 10 2026 (Karo), operator-requested restart-safe persistence for
 * the production V5 multi-timeframe cascade lifecycle. See
 * cascade.model.ts's own doc comment for the full schema rationale.
 * Every write here is a plain upsert against `v5_active_cascades` --
 * failures are logged and swallowed (non-fatal), matching this
 * project's own established convention for every other Mongo write
 * (GlobalSignalRepository).
 */
export class CascadeRepository {
  constructor(private readonly mongo: MongoClientWrapper) {}

  /** Sep 10 2026 (Karo), operator-reported CRITICAL FIX -- root cause
   *  of the duplicate-cascade-document race condition (confirmed in
   *  production: the same cascadeId appearing as TWO separate Mongo
   *  documents, with different candidate states, after the three
   *  concurrent 1m/3m/5m upsertCandidateState() calls raced each
   *  other's own check-then-insert). A UNIQUE index on cascadeId turns
   *  a losing racer's own insert attempt into a hard duplicate-key
   *  error instead of a silently-created second document -- combined
   *  with feedCascade() now awaiting these calls SEQUENTIALLY (see its
   *  own doc comment in market-data-orchestrator.ts) rather than
   *  firing all three concurrently, the race is eliminated at BOTH the
   *  application layer (no longer concurrent) and the data layer (even
   *  if a race somehow still occurred, Mongo itself would now refuse
   *  the second document). Idempotent, safe to call every boot --
   *  never throws, matching every other repository's own
   *  ensureIndexes() convention in this project. */
  async ensureIndexes(): Promise<boolean> {
    try {
      const col = await this.mongo.activeCascades();
      if (!col) return false;
      await col.createIndex({ cascadeId: 1 }, { unique: true });
      await col.createIndex({ symbol: 1, status: 1 });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "[CASCADE_ENSURE_INDEXES_FAILED]");
      return false;
    }
  }

  /** Called on EVERY meaningful state transition for a still-ACTIVE
   *  candidate (cascade start, a new wave starting, a wave completing)
   *  -- upserts the WHOLE cascade document's own candidates.<timeframe>
   *  sub-field. $setOnInsert seeds the cascade-level fields (cascadeId/
   *  symbol/victimSide/startedAt/status/closedAt) exactly once, the
   *  first time ANY candidate for this cascadeId is persisted -- never
   *  overwritten by a later candidate's own upsert. The OTHER two
   *  candidates' own sub-fields are seeded to their own "not started
   *  yet" shape on that same first insert, so the document is always
   *  well-formed even before all three candidates have been fed their
   *  own first liquidation. */
  async upsertCandidateState(
    cascadeId: string,
    symbol: string,
    victim: Side,
    startedAt: number,
    candidate: CascadeCandidateStateDoc,
    now: number,
  ): Promise<void> {
    try {
      const col = await this.mongo.activeCascades();
      if (!col) return;
      await col.updateOne(
        { cascadeId },
        {
          $set: {
            [`candidates.${candidate.timeframe}`]: candidate,
            lastUpdatedTs: now,
          },
          $setOnInsert: {
            symbol,
            victimSide: victim,
            startedAt,
            status: "ACTIVE",
            closedAt: null,
            ...Object.fromEntries(
              (["1m", "3m", "5m"] as const)
                .filter((tf) => tf !== candidate.timeframe)
                .map((tf) => [
                  `candidates.${tf}`,
                  emptyCandidateStateDoc(tf, now),
                ]),
            ),
          },
        },
        { upsert: true },
      );
    } catch (err) {
      // Sep 10 2026 (Karo), operator-reported CRITICAL FIX -- defensive
      // retry for the rare case where the unique cascadeId index (see
      // ensureIndexes() above) rejects this upsert's own insert-attempt
      // as a duplicate-key error (code 11000): another concurrent call
      // for the SAME cascadeId won the race and already created the
      // document. Retrying as a PLAIN update (no upsert) applies this
      // candidate's own $set to that now-existing document instead of
      // silently dropping the update. Every other error remains
      // non-fatal, logged, and swallowed, matching this project's own
      // established Mongo-write convention.
      const isDuplicateKey =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === 11000;
      if (isDuplicateKey) {
        try {
          const col = await this.mongo.activeCascades();
          if (col)
            await col.updateOne(
              { cascadeId },
              {
                $set: {
                  [`candidates.${candidate.timeframe}`]: candidate,
                  lastUpdatedTs: now,
                },
              },
            );
          return;
        } catch (retryErr) {
          const retryMsg =
            retryErr instanceof Error ? retryErr.message : String(retryErr);
          log.error(
            { err: retryMsg, cascadeId, timeframe: candidate.timeframe },
            "[CASCADE_UPSERT_DUPLICATE_KEY_RETRY_FAILED] -- non-fatal",
          );
          return;
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, cascadeId, timeframe: candidate.timeframe },
        "[CASCADE_UPSERT_CANDIDATE_STATE_FAILED] -- non-fatal",
      );
    }
  }

  /** Called ONCE, the moment a candidate reaches a terminal state
   *  (SIGNAL or CANCEL) -- persists its own final state via the SAME
   *  upsert path as upsertCandidateState() (so a candidate that never
   *  had an earlier ACTIVE snapshot -- e.g. it went straight from
   *  NOT_STARTED to terminal within one tick -- is still handled
   *  correctly), then reads the document back to check whether ALL
   *  THREE candidates are now terminal. If so, explicitly marks the
   *  parent cascade CLOSED immediately -- never relying on the next
   *  liquidation event's own lazy isCascadeStillActive() check, per
   *  the operator's own explicit requirement. Returns whether the
   *  parent cascade was just closed by this call. */
  async markCandidateTerminal(
    cascadeId: string,
    symbol: string,
    victim: Side,
    startedAt: number,
    candidate: CascadeCandidateStateDoc,
    now: number,
  ): Promise<{ allTerminal: boolean }> {
    await this.upsertCandidateState(
      cascadeId,
      symbol,
      victim,
      startedAt,
      candidate,
      now,
    );
    try {
      const col = await this.mongo.activeCascades();
      if (!col) return { allTerminal: false };
      const doc = await col.findOne({ cascadeId });
      if (!doc) return { allTerminal: false };
      // Sep 11 2026 (Karo), operator-reported CRITICAL FIX -- since
      // the 1m-only production change, 3m/5m candidates are NEVER
      // started anymore (their own phase stays "NOT_STARTED" forever).
      // The original all-three-terminal check therefore could NEVER
      // become true again, meaning a cascade would never close, ever,
      // for any symbol, going forward. A candidate now counts as
      // "not blocking closure" if it reached a real terminal state
      // (SIGNAL/CANCEL) OR if it was simply never started at all --
      // "NOT_STARTED" is now a genuinely FINAL state for 3m/5m, not a
      // transient one waiting to progress.
      const allTerminal = (["1m", "3m", "5m"] as const).every((tf) => {
        const phase = doc.candidates[tf]?.phase;
        return (
          phase === "TERMINAL_SIGNAL" ||
          phase === "TERMINAL_CANCEL" ||
          phase === undefined ||
          phase === "NOT_STARTED"
        );
      });
      if (allTerminal && doc.status === "ACTIVE") {
        await col.updateOne(
          { cascadeId },
          { $set: { status: "CLOSED", closedAt: now, lastUpdatedTs: now } },
        );
        log.info(
          `[CASCADE_CLOSED] ${symbol} ${victim} cascadeId=${cascadeId} -- all three candidates terminal, symbol released immediately`,
        );
      }
      return { allTerminal };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, cascadeId },
        "[CASCADE_MARK_TERMINAL_CHECK_FAILED] -- non-fatal",
      );
      return { allTerminal: false };
    }
  }

  /** Called ONCE, at startup, before any WS ticks flow -- loads every
   *  non-terminal (status="ACTIVE") cascade document, for
   *  hydrateActiveCascades() to rebuild CascadeRegistry/
   *  CascadeCandidateService state from. */
  async findActiveCascades(): Promise<CascadeDoc[]> {
    try {
      const col = await this.mongo.activeCascades();
      if (!col) return [];
      return (await col
        .find({ status: "ACTIVE" })
        .toArray()) as unknown as CascadeDoc[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "[CASCADE_FIND_ACTIVE_FAILED]");
      return [];
    }
  }
}
