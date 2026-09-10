import type { Side } from "../../shared/common.types";
import type { UnitResearchShadowService } from "./unit-research-shadow.service";

/**
 * Sep 10 2026 (Karo), operator-reported CRITICAL FIX. The single
 * source of truth for "is there currently an active common-horizon-
 * 4h-v1 competition episode for this SYMBOL, and if so, what
 * signalId/episodeStartTs/victim does it own". Extracted from
 * market-data-orchestrator.ts's own feedCommonHorizonCompetition() so
 * this class can be genuinely unit-tested with REAL
 * UnitResearchShadowService instances, not just source-inspection.
 *
 * THE INVARIANT THIS ENFORCES: ONE competition episode per SYMBOL at a
 * time, REGARDLESS of liquidation victim side -- it owns ALL THREE
 * candidates (1m/3m/5m) simultaneously, using ONE shared signalId and
 * ONE shared episodeStartTs. A new episode may only start once the
 * previous one is FULLY terminal: every candidate has reached a
 * terminal state (PASS/FAIL/CANCEL) AND, if a winner was declared, its
 * own hypothetical position has closed (TP or SL touched) -- an OPEN
 * winner keeps the symbol occupied too, per the operator's own
 * explicit requirement.
 *
 * Sep 10 2026 (Karo), operator-requested lifecycle correction -- the
 * ownership KEY is now `symbol` alone (was `symbol:victim`). The
 * episode's own ORIGINAL victim side is stored inside the episode
 * record and drives how subsequent liquidations for that symbol are
 * handled:
 *   - SAME victim as the active episode -> routed into it (accumulate/
 *     Wave-2-trigger, exactly as before, via the SAME-victim shadow
 *     watches -- W1/W2 rules themselves are completely unchanged).
 *   - OPPOSITE victim, while an episode is already active for this
 *     symbol -> IGNORED for research purposes. It must NOT become a
 *     Wave 2 (there is no active same-key watch for the opposite
 *     victim to accumulate into -- the shadow's own onLiquidation() is
 *     simply never called for it), and it must NOT start a second,
 *     simultaneous episode on the same symbol.
 *
 * Deliberately decoupled from V5WaveService's own watch-lifecycle --
 * see market-data-orchestrator.ts's own feedUnitResearchShadowAfter()
 * doc comment for the exact corruption bug this decoupling fixes
 * (V5's own watch cycles far faster than a common-horizon episode's
 * own natural lifetime, so tying episode-boundaries to it caused
 * candidates to split across different signalId documents).
 */
export type CommonHorizonResolution =
  | {
      readonly action: "route";
      readonly signalId: string;
      readonly episodeStartTs: number;
      readonly victim: Side;
    }
  | { readonly action: "ignore" }
  | {
      readonly action: "start";
      readonly signalId: string;
      readonly episodeStartTs: number;
      readonly victim: Side;
    };

export class CommonHorizonEpisodeRegistry {
  private readonly ownership = new Map<
    string,
    { signalId: string; episodeStartTs: number; victim: Side }
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

  /** True if ANY of the three candidates (tracked under the episode's
   *  OWN, ORIGINAL victim -- shadow watches are still keyed by
   *  symbol+victim internally, W1/W2 rules unchanged) is still
   *  actively tracked (pure read via peekWatch()), or a declared
   *  winner's own position is still open. */
  private isEpisodeStillActive(
    symbol: string,
    episodeVictim: Side,
    signalId: string,
  ): boolean {
    if (this.shadow1m.peekWatch(symbol, episodeVictim) !== null) return true;
    if (this.shadow3m.peekWatch(symbol, episodeVictim) !== null) return true;
    if (this.shadow5m.peekWatch(symbol, episodeVictim) !== null) return true;
    if (this.hasOpenWinner(signalId)) return true;
    return false;
  }

  /** Read-only: is there currently an active episode for this symbol
   *  (any victim). */
  isActive(symbol: string): boolean {
    const existing = this.ownership.get(symbol);
    if (!existing) return false;
    return this.isEpisodeStillActive(
      symbol,
      existing.victim,
      existing.signalId,
    );
  }

  /** Decides what to do with a liquidation event for (symbol, victim):
   *   - "route": an active episode already owns this symbol, under
   *     the SAME victim -- route this event into it.
   *   - "ignore": an active episode already owns this symbol, under
   *     the OPPOSITE victim -- must not start a second episode, must
   *     not be treated as Wave 2 for the existing one either.
   *   - "start": no active episode owns this symbol -- start a
   *     genuinely fresh one, with a NEW signalId, under THIS event's
   *     own victim. A stale ownership entry (the previous episode has
   *     gone fully terminal) is cleaned up here, lazily. */
  resolve(
    symbol: string,
    victim: Side,
    now: number,
    makeSignalId: () => string,
  ): CommonHorizonResolution {
    const existing = this.ownership.get(symbol);
    if (
      existing &&
      this.isEpisodeStillActive(symbol, existing.victim, existing.signalId)
    ) {
      if (existing.victim === victim) {
        return {
          action: "route",
          signalId: existing.signalId,
          episodeStartTs: existing.episodeStartTs,
          victim: existing.victim,
        };
      }
      return { action: "ignore" };
    }
    if (existing) this.ownership.delete(symbol);
    const fresh = { signalId: makeSignalId(), episodeStartTs: now, victim };
    this.ownership.set(symbol, fresh);
    return { action: "start", ...fresh };
  }

  /** Read-only lookup of the currently-owning signalId + victim for
   *  this symbol, or null if no active episode owns it. Used by the
   *  live-phase snapshot path to join persisted docs to the correct
   *  episode, without itself deciding active/fresh. */
  current(symbol: string): { signalId: string; victim: Side } | null {
    const e = this.ownership.get(symbol);
    return e ? { signalId: e.signalId, victim: e.victim } : null;
  }
}
