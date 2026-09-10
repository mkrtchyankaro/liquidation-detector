import type { Side } from "../../shared/common.types";
import type { CascadeCandidateService } from "./cascade-candidate.service";

/**
 * Sep 10 2026 (Karo), operator-requested production V5 multi-timeframe
 * cascade lifecycle. The single source of truth for "is there
 * currently an active cascade for this SYMBOL, and if so, what
 * cascadeId/cascadeStartTs/victim does it own".
 *
 * THE INVARIANT: ONE cascade per SYMBOL at a time, regardless of
 * liquidation victim side -- it owns all three timeframe candidates
 * (1m/3m/5m) simultaneously, using ONE shared cascadeId and ONE shared
 * cascadeStartTs. A new cascade may only start once the previous one
 * is FULLY terminal: every one of the three candidates has reached its
 * own terminal state (SIGNAL-READY or CANCELLED).
 *
 * CRITICAL DISTINCTION (operator's own explicit clarification): this
 * class governs ONLY whether a new cascade/comparison-group may start
 * -- it has NOTHING to do with mainSymbolLocks, which continues to
 * govern MAIN's own real-Binance-position-overlap safety, completely
 * unchanged. Three independent candidate SIGNAL results are expected
 * and allowed; three simultaneous real MAIN positions are not, and
 * this class plays no role in preventing that (mainSymbolLocks alone
 * does).
 *
 * Same architectural pattern as the earlier (now-removed)
 * CommonHorizonEpisodeRegistry -- a genuinely separate, symbol-keyed
 * ownership map, decoupled from V5WaveService's own watch-lifecycle,
 * checked live via peekWatch() (pure reads) rather than a separate,
 * independently-updated "is active" boolean that could drift out of
 * sync.
 */
export type CascadeResolution =
  | {
      readonly action: "route";
      readonly cascadeId: string;
      readonly cascadeStartTs: number;
      readonly victim: Side;
    }
  | { readonly action: "ignore" }
  | {
      readonly action: "start";
      readonly cascadeId: string;
      readonly cascadeStartTs: number;
      readonly victim: Side;
    };

export class CascadeRegistry {
  private readonly ownership = new Map<
    string,
    { cascadeId: string; cascadeStartTs: number; victim: Side }
  >();

  constructor(
    private readonly candidate1m: CascadeCandidateService,
    private readonly candidate3m: CascadeCandidateService,
    private readonly candidate5m: CascadeCandidateService,
  ) {}

  private isCascadeStillActive(symbol: string, victim: Side): boolean {
    if (this.candidate1m.peekWatch(symbol, victim) !== null) return true;
    if (this.candidate3m.peekWatch(symbol, victim) !== null) return true;
    if (this.candidate5m.peekWatch(symbol, victim) !== null) return true;
    return false;
  }

  isActive(symbol: string): boolean {
    const existing = this.ownership.get(symbol);
    if (!existing) return false;
    return this.isCascadeStillActive(symbol, existing.victim);
  }

  /** Decides what to do with a liquidation event for (symbol, victim):
   *   - "route": an active cascade already owns this symbol, under the
   *     SAME victim -- route this event into the existing candidates.
   *   - "ignore": an active cascade already owns this symbol, under
   *     the OPPOSITE victim -- must not start a second cascade, must
   *     not be treated as advancing the existing one either.
   *   - "start": no active cascade owns this symbol -- start a
   *     genuinely fresh one, with a NEW cascadeId, under THIS event's
   *     own victim. */
  resolve(
    symbol: string,
    victim: Side,
    now: number,
    makeCascadeId: () => string,
  ): CascadeResolution {
    const existing = this.ownership.get(symbol);
    if (existing && this.isCascadeStillActive(symbol, existing.victim)) {
      if (existing.victim === victim) {
        return {
          action: "route",
          cascadeId: existing.cascadeId,
          cascadeStartTs: existing.cascadeStartTs,
          victim: existing.victim,
        };
      }
      return { action: "ignore" };
    }
    if (existing) this.ownership.delete(symbol);
    const fresh = { cascadeId: makeCascadeId(), cascadeStartTs: now, victim };
    this.ownership.set(symbol, fresh);
    return { action: "start", ...fresh };
  }

  /** Read-only lookup of the currently-owning cascadeId + victim for
   *  this symbol, or null if no active cascade owns it. */
  current(symbol: string): { cascadeId: string; victim: Side } | null {
    const e = this.ownership.get(symbol);
    return e ? { cascadeId: e.cascadeId, victim: e.victim } : null;
  }

  /** Sep 10 2026 (Karo), operator-requested restart-safe persistence.
   *  Directly sets an ownership entry -- used ONLY during startup
   *  hydration (never during live event processing, unlike resolve()),
   *  to restore "symbol X is still owned by cascade Y" from a
   *  persisted, non-terminal cascade document, before any WS ticks
   *  flow. */
  restoreOwnership(
    symbol: string,
    cascadeId: string,
    cascadeStartTs: number,
    victim: Side,
  ): void {
    this.ownership.set(symbol, { cascadeId, cascadeStartTs, victim });
  }
}
