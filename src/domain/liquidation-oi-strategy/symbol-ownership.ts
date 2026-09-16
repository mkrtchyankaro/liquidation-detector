import type { Side } from "../../shared/common.types";

/**
 * Sep 16 2026 (Karo), operator-approved architecture, Phase 2.
 *
 * ARCHITECTURE FINDING (reported per the operator's own request to
 * flag anything that changes the approved design): CascadeRegistry
 * cannot be literally reused here. Its constructor is hard-wired to
 * three CascadeCandidateService instances (1m/3m/5m V5 cascade
 * candidates) and its isCascadeStillActive() check calls their own
 * peekWatch() methods -- concepts this strategy has no equivalent of
 * (one state machine per symbol, not three timeframe candidates).
 * Modifying CascadeRegistry itself to serve two unrelated callers
 * would risk V5's own production ownership logic for no benefit.
 * Instead this is a NEW, symbol-keyed registry that reuses
 * CascadeRegistry's PROVEN PATTERN (route/ignore/start resolution)
 * without touching or depending on it -- two completely independent
 * ownership maps, since a symbol can never simultaneously be a V5
 * cascade candidate AND a Liquidation+OI Exhaustion setup regardless
 * (mainSymbolLocks -- unchanged, Phase 5+ concern -- still prevents
 * two REAL positions on the same symbol even if this were violated).
 *
 * OWNERSHIP TIMING (per the approved architecture): ownership is
 * claimed only when episode tracking is PROMOTED to WATCH_QUALIFIED --
 * never during lightweight EPISODE_TRACKING itself. Before any
 * ownership exists for a symbol, BOTH a LONG-victim and a SHORT-
 * victim episode may be silently tracked in parallel by the
 * orchestrator (Phase 3) -- whichever one reaches WATCH_QUALIFIED
 * first calls resolve() here and wins; the orchestrator discards the
 * other side's still-tracking episode at that point (see
 * liquidation-oi-watch-manager.ts). Once ownership exists, resolve()
 * for the OTHER victim side returns "ignore", and the orchestrator
 * must not even continue tracking that opposite-side episode.
 */

export type OwnershipResolution =
  | { readonly action: "route"; readonly ownershipId: string }
  | { readonly action: "ignore" }
  | { readonly action: "start"; readonly ownershipId: string };

interface OwnershipEntry {
  ownershipId: string;
  symbol: string;
  victim: Side;
}

export class SymbolOwnershipRegistry {
  private readonly ownership = new Map<string, OwnershipEntry>();

  isOwned(symbol: string): boolean {
    return this.ownership.has(symbol);
  }

  peek(symbol: string): OwnershipEntry | null {
    return this.ownership.get(symbol) ?? null;
  }

  /** Called ONLY at WATCH_QUALIFIED promotion, never on a raw
   *  liquidation event or during EPISODE_TRACKING -- see this file's
   *  own header. "route": an existing owner under the SAME victim --
   *  should not normally happen (WATCH_QUALIFIED promotion happens
   *  once per episode), included for defensive completeness, matching
   *  CascadeRegistry's own shape. "ignore": owned by the OPPOSITE
   *  victim -- this attempt must be discarded, no new setup. "start":
   *  no existing owner -- this episode wins the symbol. */
  resolve(
    symbol: string,
    victim: Side,
    makeOwnershipId: () => string,
  ): OwnershipResolution {
    const existing = this.ownership.get(symbol);
    if (existing) {
      if (existing.victim === victim)
        return { action: "route", ownershipId: existing.ownershipId };
      return { action: "ignore" };
    }
    const ownershipId = makeOwnershipId();
    this.ownership.set(symbol, { ownershipId, symbol, victim });
    return { action: "start", ownershipId };
  }

  /** Called ONLY when the global lifecycle reaches a terminal state
   *  (CLOSED or CANCELLED) with all Phase-1 close-eligibility
   *  conditions satisfied -- see lifecycle.types.ts's own
   *  isGlobalCloseEligible(). Releasing early (e.g. merely because one
   *  user closed) would violate the approved architecture's own
   *  "symbol ownership ends ONLY after complete global terminal
   *  cleanup" requirement -- this class has no way to enforce that
   *  itself; the orchestrator is responsible for calling this only at
   *  the correct moment. */
  release(symbol: string): void {
    this.ownership.delete(symbol);
  }

  /** Restart recovery: reconstructs ownership from a persisted global
   *  signal document whose lifecycle state still holds ownership
   *  (per lifecycle.types.ts's own holdsSymbolOwnership()) -- called
   *  once per such document during startup hydration, before any new
   *  liquidation event is processed. Overwrites any existing entry
   *  for the symbol (there should never be one yet at this point in
   *  startup, but this makes hydration idempotent if called twice). */
  hydrate(symbol: string, ownershipId: string, victim: Side): void {
    this.ownership.set(symbol, { ownershipId, symbol, victim });
  }
}
