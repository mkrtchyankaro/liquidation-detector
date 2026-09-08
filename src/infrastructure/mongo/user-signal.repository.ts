import type { MongoClientWrapper } from "./mongo.client";
import type { UserSignalDoc } from "../../domain/signal/user-signal.model";
import type { UserSignalRepositoryPort } from "../../application/ports";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "user-signal-repo" });

/** Sep 8 2026 (Karo). ONE instance per user (see services/user-runtime.ts),
 *  backed by that user's OWN collection (v5_signals_&lt;userId&gt;) --
 *  never a shared collection with a userId field, per explicit
 *  operator correction. A manual close for Karo can therefore only
 *  ever touch Karo's own collection -- there is no query shape that
 *  could accidentally reach Friend's or Artak's documents. */
export class UserSignalRepository implements UserSignalRepositoryPort {
  private indexesEnsured = false;

  constructor(
    private readonly mongo: MongoClientWrapper,
    private readonly userId: string,
  ) {}

  /** Sep 8 2026 (Karo) -- signalId unique WITHIN this user's own
   *  collection (v5_signals_&lt;userId&gt;) -- naturally scoped per-user
   *  by virtue of being a separate collection per user, matching the
   *  isolation model exactly (no cross-user uniqueness constraint is
   *  possible or desired -- the SAME signalId legitimately has one
   *  document in EACH applicable user's own collection). Same
   *  throw-on-failure/startup-blocker severity as
   *  execution-claim/record's own ensureIndexes(). */
  async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) return;
    const col = await this.mongo.userSignals(this.userId);
    if (!col) return;
    try {
      await col.createIndexes([
        {
          key: { signalId: 1 },
          name: "user_signal_signalId_unique",
          unique: true,
        },
        { key: { status: 1 }, name: "user_signal_status" },
      ]);
      this.indexesEnsured = true;
      log.info(`user signal indexes ensured for userId=${this.userId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId: this.userId },
        "FAILED to ensure user signal indexes -- treat as a startup blocker",
      );
      throw err;
    }
  }

  async upsert(userId: string, doc: UserSignalDoc): Promise<void> {
    if (userId !== this.userId) {
      // Defense-in-depth: this instance is permanently bound to ONE
      // user at construction time. A caller passing a different
      // userId is a programming error, not a runtime condition to
      // silently tolerate.
      throw new Error(
        `UserSignalRepository for "${this.userId}" was called with userId="${userId}"`,
      );
    }
    try {
      const col = await this.mongo.userSignals(this.userId);
      if (!col) return;
      await col.updateOne(
        { signalId: doc.signalId },
        { $set: doc },
        { upsert: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId: this.userId, signalId: doc.signalId },
        "[USER_SIGNAL_UPSERT_FAILED]",
      );
    }
  }

  async findOpen(userId: string): Promise<UserSignalDoc[]> {
    if (userId !== this.userId)
      throw new Error(
        `UserSignalRepository for "${this.userId}" was called with userId="${userId}"`,
      );
    try {
      const col = await this.mongo.userSignals(this.userId);
      if (!col) return [];
      return (await col
        .find({ status: "OPEN" })
        .toArray()) as unknown as UserSignalDoc[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId: this.userId },
        "[USER_SIGNAL_FIND_OPEN_FAILED]",
      );
      return [];
    }
  }

  /** Sep 8 2026 (Karo) -- for DailyLossLimitTracker.initializeFromDb()
   *  (see that method's own doc comment: "without this, a restart
   *  would silently reset the counter to 0 even if the account had
   *  already hit the limit moments before" -- confirmed as a real,
   *  previously-unwired gap, found during a full manual audit). Same
   *  net-P&L formula as reconcile-user-position.usecase.ts's own
   *  (grossPnl - fees, FEE_ROUNDTRIP_PCT=0.001) -- kept in sync
   *  manually since it's a small, stable formula; if that one ever
   *  changes, this must change identically. */
  async sumClosedNetPnlInRange(
    userId: string,
    startMs: number,
    endMs: number,
  ): Promise<{ total: number; tradeCount: number }> {
    if (userId !== this.userId)
      throw new Error(
        `UserSignalRepository for "${this.userId}" was called with userId="${userId}"`,
      );
    try {
      const col = await this.mongo.userSignals(this.userId);
      if (!col) return { total: 0, tradeCount: 0 };
      const docs = (await col
        .find({
          status: { $in: ["CLOSED_TP", "CLOSED_SL", "CLOSED_MANUAL"] },
          closedAt: { $gte: startMs, $lt: endMs },
        })
        .toArray()) as unknown as UserSignalDoc[];
      const FEE_ROUNDTRIP_PCT = 0.001;
      let total = 0;
      for (const d of docs) {
        if (
          d.entry === null ||
          d.closePrice === null ||
          d.positionQty === null ||
          d.notional === null
        )
          continue;
        const dirMul = d.side === "LONG" ? 1 : -1;
        const grossPnl = (d.closePrice - d.entry) * d.positionQty * dirMul;
        const fees = d.notional * FEE_ROUNDTRIP_PCT;
        total += grossPnl - fees;
      }
      return { total, tradeCount: docs.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId: this.userId },
        "[USER_SIGNAL_SUM_CLOSED_PNL_FAILED]",
      );
      return { total: 0, tradeCount: 0 };
    }
  }

  async findBySignalId(
    userId: string,
    signalId: string,
  ): Promise<UserSignalDoc | null> {
    if (userId !== this.userId)
      throw new Error(
        `UserSignalRepository for "${this.userId}" was called with userId="${userId}"`,
      );
    try {
      const col = await this.mongo.userSignals(this.userId);
      if (!col) return null;
      return (await col.findOne({
        signalId,
      })) as unknown as UserSignalDoc | null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg, userId: this.userId, signalId },
        "[USER_SIGNAL_FIND_BY_ID_FAILED]",
      );
      return null;
    }
  }
}
