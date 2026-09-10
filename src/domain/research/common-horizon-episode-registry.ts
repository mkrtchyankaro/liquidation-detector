import type { Side } from "../../shared/common.types";
import type { UnitResearchShadowService } from "./unit-research-shadow.service";

/**
 * Sep 10 2026 (Karo), operator-reported CRITICAL FIX. The single
 * source of truth for "is there currently an active common-horizon-
 * 4h-v1 competition episode for this symbol+victim, and if so, what
 * signalId/episodeStartTs does it own". Extracted from
 * market-data-orchestrator.ts's own feedCommonHorizonCompetition() so
 * this class can be genuinely unit-tested with REAL
 * UnitResearchShadowService instances, not just source-inspection.
 *
 * THE INVARIANT THIS ENFORCES: ONE competition episode per
 * (symbol, victim) at a time -- it owns ALL THREE candidates
 * (1m/3m/5m) simultaneously, using ONE shared signalId and ONE shared
 * episodeStartTs. A new episode may only start once the previous one
 * is FULLY terminal: every candidate has reached a terminal state
 * (PASS/FAIL/CANCEL) AND, if a winner was declared, its own
 * hypothetical position has closed (TP or SL touched) -- an OPEN
 * winner keeps the symbol occupied too, per the operator's own
 * explicit requirement.
 *
 * Deliberately decoupled from V5WaveService's own watch-lifecycle --
 * see market-data-orchestrator.ts's own feedUnitResearchShadowAfter()
 * doc comment for the exact corruption bug this decoupling fixes
 * (V5's own watch cycles far faster than a common-horizon episode's
 * own natural lifetime, so tying episode-boundaries to it caused
 * candidates to split across different signalId documents).
 */
export class CommonHorizonEpisodeRegistry {
  private readonly ownership = new Map<
    string,
    { signalId: string; episodeStartTs: number }
  >();

  constructor(
    private readonly shadow1m: UnitResearchShadowService,
    private readonly shadow3m: UnitResearchShadowService,
    private readonly shadow5m: UnitResearchShadowService,
    /** Returns true if a winner has been declared for this signalId
     *  AND its own hypothetical research position is still OPEN
     *  (TP/SL not yet touched). Injected rather than owned here so
     *  this class stays independently testable without needing the
     *  full winner-tracking state. */
    private readonly hasOpenWinner: (signalId: string) => boolean,
  ) {}

  private key(symbol: string, victim: Side): string {
    return `${symbol}:${victim}`;
  }

  /** True if ANY of the three candidates is still actively tracked
   *  (pure read via peekWatch()), or a declared winner's own position
   *  is still open. */
  private isEpisodeStillActive(
    symbol: string,
    victim: Side,
    signalId: string,
  ): boolean {
    if (this.shadow1m.peekWatch(symbol, victim) !== null) return true;
    if (this.shadow3m.peekWatch(symbol, victim) !== null) return true;
    if (this.shadow5m.peekWatch(symbol, victim) !== null) return true;
    if (this.hasOpenWinner(signalId)) return true;
    return false;
  }

  /** Read-only: is there currently an active episode for this
   *  symbol+victim (used by callers that only need a yes/no, e.g. the
   *  live-phase snapshot path, which must never touch ownership
   *  itself). */
  isActive(symbol: string, victim: Side): boolean {
    const existing = this.ownership.get(this.key(symbol, victim));
    if (!existing) return false;
    return this.isEpisodeStillActive(symbol, victim, existing.signalId);
  }

  /** Returns the signalId/episodeStartTs the CURRENT liquidation event
   *  should be associated with -- the EXISTING active episode's own
   *  (route this event into it, `isNew: false`), or a brand-new one
   *  (`isNew: true`) if none is active. A stale ownership entry (the
   *  previous episode has gone fully terminal) is cleaned up here,
   *  lazily, the next time a liquidation for this symbol/victim
   *  arrives. */
  resolve(
    symbol: string,
    victim: Side,
    now: number,
    makeSignalId: () => string,
  ): { signalId: string; episodeStartTs: number; isNew: boolean } {
    const key = this.key(symbol, victim);
    const existing = this.ownership.get(key);
    if (
      existing &&
      this.isEpisodeStillActive(symbol, victim, existing.signalId)
    ) {
      return {
        signalId: existing.signalId,
        episodeStartTs: existing.episodeStartTs,
        isNew: false,
      };
    }
    if (existing) this.ownership.delete(key);
    const fresh = { signalId: makeSignalId(), episodeStartTs: now };
    this.ownership.set(key, fresh);
    return { ...fresh, isNew: true };
  }

  /** Read-only lookup of the currently-owning signalId for this
   *  symbol+victim, or null if no active episode owns it. Used by the
   *  live-phase snapshot path to join persisted docs to the correct
   *  episode, without itself deciding active/fresh. */
  currentSignalId(symbol: string, victim: Side): string | null {
    return this.ownership.get(this.key(symbol, victim))?.signalId ?? null;
  }
}
