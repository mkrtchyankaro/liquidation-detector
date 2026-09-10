import type { Liquidation, Side } from "../../shared/common.types";

/**
 * Sep 9 2026 (Karo), operator-requested RESEARCH-ONLY ATR-timeframe
 * comparison. Answers ONE question with real data: would ATR3m or
 * ATR5m be a better UNIT ruler than ATR1m for W1/W2 recovery/entry
 * confirmation?
 *
 * ISOLATION GUARANTEE (the single most important property of this
 * file): this class is a completely SEPARATE, self-contained replica
 * of v5-wave.service.ts's own Wave1/Wave2/entry state machine --
 * SEPARATE Map, SEPARATE watch objects, ZERO shared mutable state with
 * V5WaveService. It is fed the SAME liquidation events and price ticks
 * market-data-orchestrator.ts already has (via new, ADDITIVE calls
 * placed immediately AFTER the existing v5.onLiquidation()/v5.onTick()
 * calls -- never before, never replacing them), but it NEVER writes
 * back into V5WaveService, is NEVER read by any entry/execution/
 * Telegram/BTC-safety/reconciliation code path, and its own onTick()
 * return value is used for nothing but logging a research event and
 * persisting it. Two independent instances of this class run (one per
 * shadow candidate, 3m and 5m) -- each owns its own Map, so a bug or
 * divergence in one candidate's own tracking cannot leak into the
 * other's, into production, or into any other symbol/victim's own
 * shadow state.
 *
 * The state-machine logic mirrors V5WaveService's own onLiquidation()/
 * onTick() EXACTLY (same Wave1-never-signals rule, same 1x-UNIT
 * recovery completion, same Wave2-trigger-on-same-victim-liquidation-
 * after-Wave1-completes, same 2x-UNIT-no-Wave2 cancellation, same
 * min-2-events + hasP95Event qualification for entry) -- the ONLY
 * variable is which UNIT value (frozen ATR3m or ATR5m instead of
 * ATR1m) drives the 1x/2x-UNIT thresholds. Deliberately duplicated
 * rather than shared: sharing the production class's own internals
 * here would risk the exact coupling the operator explicitly forbade
 * ("do not let ATR3m/ATR5m influence production in any way").
 */

const MIN_SAMPLES_FOR_QUALIFICATION = 2;

interface ShadowWave {
  waveNumber: number;
  state: "ACTIVE" | "COMPLETED";
  anchorPrice: number;
  anchorTs: number;
  extremePrice: number;
  extremeTs: number;
  liqNotionalUsd: number;
  liqEvents: number;
}

interface ShadowWatch {
  symbol: string;
  victim: Side;
  signalId: string; // the PRODUCTION episode's own canonical signalId -- join key only, never fed back
  unitAbs: number; // frozen once, at shadow-episode start -- never changes
  hasP95Event: boolean;
  waves: ShadowWave[];
  createdAt: number;
  terminal: boolean; // true once entered, cancelled, or expired -- onTick/onLiquidation become no-ops after this
}

export interface ShadowEntryEvent {
  readonly signalId: string;
  readonly symbol: string;
  readonly victim: Side;
  readonly side: Side; // == victim, matching V5's own side==victim convention
  readonly entryPrice: number;
  readonly entryTs: number;
  readonly unitAbs: number;
  readonly episodeStartTs: number;
  readonly w1: {
    anchorPrice: number;
    extremePrice: number;
    liqUsd: number;
    completedTs: number;
  };
  readonly w2: {
    anchorPrice: number;
    extremePrice: number;
    liqUsd: number;
    startedTs: number;
  };
}

export interface ShadowNoEntryEvent {
  readonly signalId: string;
  readonly symbol: string;
  readonly victim: Side;
  readonly unitAbs: number;
  readonly episodeStartTs: number;
  readonly reason:
    | "CANCEL_NO_SECOND_WAVE"
    | "CASCADE_NOT_SERIOUS"
    | "EPISODE_EXPIRED";
  readonly w1: {
    anchorPrice: number;
    extremePrice: number;
    liqUsd: number;
  } | null;
}

/** Sep 10 2026 (Karo), operator-requested research-observability
 *  extension ("common-horizon-4h-v1"). Which structural step an
 *  ACTIVE (non-terminal) candidate is currently waiting on. */
export type ShadowPhase =
  | "WAITING_W1_RECOVERY"
  | "WAITING_W2_START"
  | "WAITING_W2_RECOVERY";

export interface ShadowPeek {
  readonly phase: ShadowPhase;
  readonly episodeStartTs: number;
  readonly unitAbs: number;
  readonly w1: {
    anchorPrice: number;
    extremePrice: number;
    liqUsd: number;
    liqEvents: number;
  } | null;
  readonly w2: {
    anchorPrice: number;
    extremePrice: number;
    liqUsd: number;
    liqEvents: number;
  } | null;
  /** The exact price the candidate needs THIS tick's own mid to reach
   *  for its current phase to resolve (a recovery threshold, or the
   *  2x-UNIT cancellation threshold while awaiting Wave 2). */
  readonly nextTargetPrice: number;
  readonly nextTargetDescription: string;
}

const EPISODE_MAX_AGE_MS = 30 * 60_000; // matches production's own safety-timeout order of magnitude

export class UnitResearchShadowService {
  private readonly watches = new Map<string, ShadowWatch>(); // keyed by symbol:victim, one active shadow-episode at a time per pair

  constructor(
    private readonly getIndividualP95: (symbol: string, victim: Side) => number,
  ) {}

  /** Called ONCE, in lockstep with production's own Wave1 start (the
   *  FIRST liquidation event that creates a NEW production V5WatchState
   *  for this symbol/victim) -- never independently triggered, so the
   *  shadow episode always tracks the EXACT SAME real-world cascade
   *  production is tracking, just measured against a different UNIT. */
  startEpisode(
    symbol: string,
    victim: Side,
    signalId: string,
    unitAbs: number,
    firstLiqPrice: number,
    firstLiqTs: number,
    firstLiqUsd: number,
    now: number,
  ): void {
    const key = this.keyFor(symbol, victim);
    if (this.watches.has(key)) return; // one shadow-episode at a time per pair, mirrors production's own single-watch-per-key invariant
    if (!(unitAbs > 0)) return;
    const p95 = this.getIndividualP95(symbol, victim);
    const w1: ShadowWave = {
      waveNumber: 1,
      state: "ACTIVE",
      anchorPrice: firstLiqPrice,
      anchorTs: firstLiqTs,
      extremePrice: firstLiqPrice,
      extremeTs: firstLiqTs,
      liqNotionalUsd: firstLiqUsd,
      liqEvents: 1,
    };
    this.watches.set(key, {
      symbol,
      victim,
      signalId,
      unitAbs,
      hasP95Event: p95 > 0 && firstLiqUsd >= p95,
      waves: [w1],
      createdAt: now,
      terminal: false,
    });
  }

  /** Called for every subsequent liquidation event for this
   *  symbol/victim -- mirrors V5WaveService.onLiquidation()'s own
   *  accumulate-into-active-wave / start-Wave2-on-completed-Wave1
   *  logic exactly. */
  onLiquidation(liq: Liquidation, victim: Side): void {
    const key = this.keyFor(liq.symbol, victim);
    const watch = this.watches.get(key);
    if (!watch || watch.terminal) return;

    const lastWave = watch.waves[watch.waves.length - 1]!;

    if (watch.waves.length === 1 && lastWave.state === "COMPLETED") {
      // Wave 1 already completed, no Wave 2 yet -- THIS event starts Wave 2.
      const w2: ShadowWave = {
        waveNumber: 2,
        state: "ACTIVE",
        anchorPrice: liq.price,
        anchorTs: liq.timestamp,
        extremePrice: liq.price,
        extremeTs: liq.timestamp,
        liqNotionalUsd: liq.quoteQty,
        liqEvents: 1,
      };
      watch.waves.push(w2);
      const p95 = this.getIndividualP95(liq.symbol, victim);
      watch.hasP95Event = p95 > 0 && liq.quoteQty >= p95;
      return;
    }

    if (lastWave.state !== "ACTIVE") return; // wave 2+ already completed (entered/rejected elsewhere) -- ignore further events

    if (!watch.hasP95Event) {
      const p95 = this.getIndividualP95(liq.symbol, victim);
      if (p95 > 0 && liq.quoteQty >= p95) watch.hasP95Event = true;
    }

    lastWave.liqNotionalUsd += liq.quoteQty;
    lastWave.liqEvents += 1;
    const isDeeper =
      victim === "LONG"
        ? liq.price < lastWave.extremePrice
        : liq.price > lastWave.extremePrice;
    if (isDeeper) {
      lastWave.extremePrice = liq.price;
      lastWave.extremeTs = liq.timestamp;
    }
  }

  /** Called on every relevant price tick -- mirrors V5WaveService.onTick()'s
   *  own extreme-extension / 1x-UNIT-completion / 2x-UNIT-cancellation /
   *  entry-confirmation logic exactly. Returns an entry or no-entry
   *  event the FIRST time this shadow episode reaches a terminal state
   *  (never emits twice for the same episode -- `terminal` guards
   *  this), or null on every other tick. */
  onTick(
    symbol: string,
    victim: Side,
    mid: number,
    ts: number,
  ): ShadowEntryEvent | ShadowNoEntryEvent | null {
    const key = this.keyFor(symbol, victim);
    const watch = this.watches.get(key);
    if (!watch || watch.terminal) return null;

    if (ts - watch.createdAt > EPISODE_MAX_AGE_MS) {
      watch.terminal = true;
      this.watches.delete(key);
      return {
        signalId: watch.signalId,
        symbol,
        victim,
        unitAbs: watch.unitAbs,
        episodeStartTs: watch.createdAt,
        reason: "EPISODE_EXPIRED",
        w1: this.w1Summary(watch),
      };
    }

    const currentWave = watch.waves[watch.waves.length - 1]!;

    if (currentWave.state === "ACTIVE") {
      const isDeeper =
        victim === "LONG"
          ? mid < currentWave.extremePrice
          : mid > currentWave.extremePrice;
      if (isDeeper) {
        currentWave.extremePrice = mid;
        currentWave.extremeTs = ts;
      }
      const recoveryDistance = Math.abs(mid - currentWave.extremePrice);
      if (recoveryDistance < watch.unitAbs) return null;

      currentWave.state = "COMPLETED";

      if (watch.waves.length === 1) {
        return null; // Wave 1 complete, no entry -- awaiting Wave 2 or 2x-UNIT cancel, exactly like production
      }

      // Wave 2 complete -- qualification check, exactly like production.
      watch.terminal = true;
      this.watches.delete(key);
      if (
        watch.hasP95Event &&
        currentWave.liqEvents > MIN_SAMPLES_FOR_QUALIFICATION - 1
      ) {
        const w1 = watch.waves[0]!;
        return {
          signalId: watch.signalId,
          symbol,
          victim,
          side: victim,
          entryPrice: mid,
          entryTs: ts,
          unitAbs: watch.unitAbs,
          episodeStartTs: watch.createdAt,
          w1: {
            anchorPrice: w1.anchorPrice,
            extremePrice: w1.extremePrice,
            liqUsd: w1.liqNotionalUsd,
            completedTs: w1.extremeTs,
          },
          w2: {
            anchorPrice: currentWave.anchorPrice,
            extremePrice: currentWave.extremePrice,
            liqUsd: currentWave.liqNotionalUsd,
            startedTs: currentWave.anchorTs,
          },
        };
      }
      return {
        signalId: watch.signalId,
        symbol,
        victim,
        unitAbs: watch.unitAbs,
        episodeStartTs: watch.createdAt,
        reason: "CASCADE_NOT_SERIOUS",
        w1: this.w1Summary(watch),
      };
    }

    // currentWave.state === "COMPLETED" && waves.length === 1: Wave 1
    // done, awaiting Wave 2 or 2x-UNIT cancellation.
    const recoveryDistance = Math.abs(mid - currentWave.extremePrice);
    if (recoveryDistance < 2 * watch.unitAbs) return null;

    watch.terminal = true;
    this.watches.delete(key);
    return {
      signalId: watch.signalId,
      symbol,
      victim,
      unitAbs: watch.unitAbs,
      episodeStartTs: watch.createdAt,
      reason: "CANCEL_NO_SECOND_WAVE",
      w1: this.w1Summary(watch),
    };
  }

  /** Diagnostic only. */
  get activeWatchCount(): number {
    return this.watches.size;
  }

  /** Sep 10 2026 (Karo), operator-requested research-observability
   *  extension ("common-horizon-4h-v1"). PURE READ, zero mutation --
   *  never advances state, never removes a watch, never affects
   *  onTick()/onLiquidation() in any way. Lets a caller (the market-
   *  data-orchestrator's own periodic phase-snapshot persistence, or a
   *  future direct caller) inspect an in-progress candidate's current
   *  phase and next structural target, for observability only. Returns
   *  null if no active watch exists for this symbol/victim. */
  peekWatch(symbol: string, victim: Side): ShadowPeek | null {
    const watch = this.watches.get(this.keyFor(symbol, victim));
    if (!watch || watch.terminal) return null;
    const w1 = watch.waves[0]!;
    const w2 = watch.waves[1];
    const w1Summary = {
      anchorPrice: w1.anchorPrice,
      extremePrice: w1.extremePrice,
      liqUsd: w1.liqNotionalUsd,
      liqEvents: w1.liqEvents,
    };
    const w2Summary = w2
      ? {
          anchorPrice: w2.anchorPrice,
          extremePrice: w2.extremePrice,
          liqUsd: w2.liqNotionalUsd,
          liqEvents: w2.liqEvents,
        }
      : null;

    if (!w2) {
      if (w1.state === "ACTIVE") {
        const target =
          victim === "LONG"
            ? w1.extremePrice + watch.unitAbs
            : w1.extremePrice - watch.unitAbs;
        return {
          phase: "WAITING_W1_RECOVERY",
          episodeStartTs: watch.createdAt,
          unitAbs: watch.unitAbs,
          w1: w1Summary,
          w2: null,
          nextTargetPrice: target,
          nextTargetDescription:
            "1x UNIT recovery from Wave 1's own extreme completes Wave 1 (no entry yet)",
        };
      }
      // Wave 1 completed, no Wave 2 yet.
      const cancelTarget =
        victim === "LONG"
          ? w1.extremePrice + 2 * watch.unitAbs
          : w1.extremePrice - 2 * watch.unitAbs;
      return {
        phase: "WAITING_W2_START",
        episodeStartTs: watch.createdAt,
        unitAbs: watch.unitAbs,
        w1: w1Summary,
        w2: null,
        nextTargetPrice: cancelTarget,
        nextTargetDescription:
          "2x UNIT recovery with no Wave 2 yet cancels the episode; a new same-victim liquidation before then starts Wave 2",
      };
    }

    const target =
      victim === "LONG"
        ? w2.extremePrice + watch.unitAbs
        : w2.extremePrice - watch.unitAbs;
    return {
      phase: "WAITING_W2_RECOVERY",
      episodeStartTs: watch.createdAt,
      unitAbs: watch.unitAbs,
      w1: w1Summary,
      w2: w2Summary,
      nextTargetPrice: target,
      nextTargetDescription:
        "1x UNIT recovery from Wave 2's own extreme completes Wave 2 -- entry-ready, evaluated by the Dragon immediately",
    };
  }

  private w1Summary(
    watch: ShadowWatch,
  ): { anchorPrice: number; extremePrice: number; liqUsd: number } | null {
    const w1 = watch.waves[0];
    if (!w1) return null;
    return {
      anchorPrice: w1.anchorPrice,
      extremePrice: w1.extremePrice,
      liqUsd: w1.liqNotionalUsd,
    };
  }

  private keyFor(symbol: string, victim: Side): string {
    return `${symbol}:${victim}`;
  }
}
