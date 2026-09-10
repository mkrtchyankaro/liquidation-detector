import type { Liquidation, Side } from "../../shared/common.types";

/**
 * Sep 10 2026 (Karo), operator-requested production V5 multi-timeframe
 * cascade lifecycle -- REPLACES V5WaveService's own role in cascade
 * detection/signal-creation for the 1m/3m/5m candidate model.
 * V5WaveService itself is UNCHANGED and still used for MAIN's own
 * canonical position-tracking (onPriceTickForTrades/installTrade).
 *
 * Wave lifecycle (identical structural rule for every timeframe, per
 * the operator's own explicit spec):
 *   liquidation starts -> price extends to an extreme -> price
 *   recovers 1x UNIT from that wave's own extreme -> wave COMPLETE.
 *   W1 can NEVER produce a signal. After a wave completes, if the NEXT
 *   same-victim liquidation arrives before price recovers 2x UNIT from
 *   that wave's own extreme, the next wave starts; otherwise the
 *   candidate is CANCELLED. No time-based timeout anywhere.
 *
 * Signal-readiness (arbitrary wave count, no artificial maximum):
 *   once WaveN (N>=2) completes, compare its own liqNotionalUsd against
 *   Wave(N-1)'s own: if WaveN <= Wave(N-1), the cascade has stopped
 *   intensifying -- SIGNAL-READY. If WaveN > Wave(N-1), it is still
 *   intensifying -- wait for Wave(N+1) and repeat the SAME comparison
 *   recursively. Deliberately NO exhaustion/absorption/hasP95Event/
 *   min-event-count physics -- this single comparison is the entire
 *   rule, per the operator's own explicit instruction.
 */

interface CascadeWave {
  waveNumber: number;
  state: "ACTIVE" | "COMPLETED";
  anchorPrice: number;
  anchorTs: number;
  extremePrice: number;
  extremeTs: number;
  liqNotionalUsd: number;
  liqEvents: number;
}

interface CascadeCandidateWatch {
  symbol: string;
  victim: Side;
  cascadeId: string;
  timeframe: "1m" | "3m" | "5m";
  unitAbs: number; // frozen once, at cascade start -- never changes
  waves: CascadeWave[];
  createdAt: number;
  terminal: boolean;
}

export interface WaveSummary {
  readonly waveNumber: number;
  readonly anchorPrice: number;
  readonly anchorTs: number;
  readonly extremePrice: number;
  readonly extremeTs: number;
  readonly liqUsd: number;
  readonly liqEvents: number;
}

/** Sep 10 2026 (Karo), operator-requested restart-safe persistence.
 *  WaveSummary PLUS the wave's own ACTIVE/COMPLETED state -- needed for
 *  exact reconstruction after a restart (WaveSummary alone is
 *  sufficient for read-only reporting, but not for resuming the state
 *  machine exactly where it left off). */
export interface CascadeWaveState extends WaveSummary {
  readonly state: "ACTIVE" | "COMPLETED";
}

/** Sep 10 2026 (Karo), operator-requested restart-safe persistence.
 *  The full, exact internal state of one still-ACTIVE (non-terminal)
 *  candidate watch -- everything exportState()/restoreWatch() need to
 *  round-trip a watch through Mongo and resume it EXACTLY where it
 *  left off (same wave count, same phase, same frozen UNIT, same
 *  extreme). */
export interface CascadeCandidateState {
  readonly cascadeId: string;
  readonly timeframe: "1m" | "3m" | "5m";
  readonly unitAbs: number;
  readonly waves: readonly CascadeWaveState[];
  readonly createdAt: number;
}

export interface CascadeSignalReadyEvent {
  readonly cascadeId: string;
  readonly symbol: string;
  readonly victim: Side;
  readonly side: Side;
  readonly timeframe: "1m" | "3m" | "5m";
  readonly entryPrice: number;
  readonly entryTs: number;
  readonly unitAbs: number;
  readonly cascadeStartTs: number;
  readonly waveHistory: readonly WaveSummary[];
}

export interface CascadeCancelEvent {
  readonly cascadeId: string;
  readonly symbol: string;
  readonly victim: Side;
  readonly timeframe: "1m" | "3m" | "5m";
  readonly cascadeStartTs: number;
  readonly reason: "CANCEL_NO_NEXT_WAVE";
  readonly waveHistory: readonly WaveSummary[];
  /** Sep 10 2026 (Karo), operator-requested -- exact diagnostics
   *  proving WHY this specific cancellation happened, captured at the
   *  precise moment of cancellation (never re-derived/approximated
   *  later). The wave that was last COMPLETED before this cancellation
   *  (its own extreme is the 2x-UNIT recovery anchor). */
  readonly lastCompletedWaveNumber: number;
  readonly waveExtreme: number;
  readonly frozenUnitAbs: number;
  readonly cancelPrice: number;
  readonly cancelTs: number;
  readonly recoveryDistance: number;
  readonly recoveryUnits: number;
}

export type CascadePhase = "WAITING_WAVE_RECOVERY" | "WAITING_NEXT_WAVE";

export interface CascadePeek {
  readonly phase: CascadePhase;
  readonly waveCount: number;
  readonly waveHistory: readonly WaveSummary[];
  readonly nextTargetPrice: number;
}

export class CascadeCandidateService {
  private readonly watches = new Map<string, CascadeCandidateWatch>();

  private keyFor(symbol: string, victim: Side): string {
    return `${symbol}:${victim}`;
  }

  private summarize(w: CascadeWave): WaveSummary {
    return {
      waveNumber: w.waveNumber,
      anchorPrice: w.anchorPrice,
      anchorTs: w.anchorTs,
      extremePrice: w.extremePrice,
      extremeTs: w.extremeTs,
      liqUsd: w.liqNotionalUsd,
      liqEvents: w.liqEvents,
    };
  }

  private historyOf(watch: CascadeCandidateWatch): WaveSummary[] {
    return watch.waves.map((w) => this.summarize(w));
  }

  startCascade(
    symbol: string,
    victim: Side,
    cascadeId: string,
    timeframe: "1m" | "3m" | "5m",
    unitAbs: number,
    firstLiqPrice: number,
    firstLiqTs: number,
    firstLiqUsd: number,
    now: number,
  ): void {
    const key = this.keyFor(symbol, victim);
    if (this.watches.has(key)) return;
    if (!(unitAbs > 0)) return;
    const w1: CascadeWave = {
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
      cascadeId,
      timeframe,
      unitAbs,
      waves: [w1],
      createdAt: now,
      terminal: false,
    });
  }

  onLiquidation(liq: Liquidation, victim: Side): void {
    const key = this.keyFor(liq.symbol, victim);
    const watch = this.watches.get(key);
    if (!watch || watch.terminal) return;

    const lastWave = watch.waves[watch.waves.length - 1]!;

    if (lastWave.state === "COMPLETED") {
      const nextWave: CascadeWave = {
        waveNumber: lastWave.waveNumber + 1,
        state: "ACTIVE",
        anchorPrice: liq.price,
        anchorTs: liq.timestamp,
        extremePrice: liq.price,
        extremeTs: liq.timestamp,
        liqNotionalUsd: liq.quoteQty,
        liqEvents: 1,
      };
      watch.waves.push(nextWave);
      return;
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

  onTick(
    symbol: string,
    victim: Side,
    mid: number,
    ts: number,
  ): CascadeSignalReadyEvent | CascadeCancelEvent | null {
    const key = this.keyFor(symbol, victim);
    const watch = this.watches.get(key);
    if (!watch || watch.terminal) return null;

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
        return null;
      }

      const prevWave = watch.waves[watch.waves.length - 2]!;
      if (currentWave.liqNotionalUsd <= prevWave.liqNotionalUsd) {
        watch.terminal = true;
        this.watches.delete(key);
        return {
          cascadeId: watch.cascadeId,
          symbol,
          victim,
          side: victim,
          timeframe: watch.timeframe,
          entryPrice: mid,
          entryTs: ts,
          unitAbs: watch.unitAbs,
          cascadeStartTs: watch.createdAt,
          waveHistory: this.historyOf(watch),
        };
      }
      return null;
    }

    const recoveryDistance = Math.abs(mid - currentWave.extremePrice);
    if (recoveryDistance < 2 * watch.unitAbs) return null;

    watch.terminal = true;
    this.watches.delete(key);
    return {
      cascadeId: watch.cascadeId,
      symbol,
      victim,
      timeframe: watch.timeframe,
      cascadeStartTs: watch.createdAt,
      reason: "CANCEL_NO_NEXT_WAVE",
      waveHistory: this.historyOf(watch),
      lastCompletedWaveNumber: currentWave.waveNumber,
      waveExtreme: currentWave.extremePrice,
      frozenUnitAbs: watch.unitAbs,
      cancelPrice: mid,
      cancelTs: ts,
      recoveryDistance,
      recoveryUnits: recoveryDistance / watch.unitAbs,
    };
  }

  peekWatch(symbol: string, victim: Side): CascadePeek | null {
    const watch = this.watches.get(this.keyFor(symbol, victim));
    if (!watch || watch.terminal) return null;
    const currentWave = watch.waves[watch.waves.length - 1]!;
    if (currentWave.state === "ACTIVE") {
      const target =
        victim === "LONG"
          ? currentWave.extremePrice + watch.unitAbs
          : currentWave.extremePrice - watch.unitAbs;
      return {
        phase: "WAITING_WAVE_RECOVERY",
        waveCount: watch.waves.length,
        waveHistory: this.historyOf(watch),
        nextTargetPrice: target,
      };
    }
    const target =
      victim === "LONG"
        ? currentWave.extremePrice + 2 * watch.unitAbs
        : currentWave.extremePrice - 2 * watch.unitAbs;
    return {
      phase: "WAITING_NEXT_WAVE",
      waveCount: watch.waves.length,
      waveHistory: this.historyOf(watch),
      nextTargetPrice: target,
    };
  }

  /** Sep 10 2026 (Karo), operator-requested restart-safe persistence.
   *  PURE READ (like peekWatch()), but exports the FULL internal wave
   *  array (including each wave's own ACTIVE/COMPLETED state) rather
   *  than just the summarized phase/target used for live reporting --
   *  everything needed to restoreWatch() this EXACT watch after a
   *  restart. Returns null for a terminal/nonexistent watch (a
   *  terminal watch is, by design, already removed from `watches` the
   *  moment it becomes terminal -- its own final result is captured by
   *  the caller from the onTick() return value at that moment instead,
   *  which is what gets persisted for a terminal candidate). */
  exportState(symbol: string, victim: Side): CascadeCandidateState | null {
    const watch = this.watches.get(this.keyFor(symbol, victim));
    if (!watch || watch.terminal) return null;
    return {
      cascadeId: watch.cascadeId,
      timeframe: watch.timeframe,
      unitAbs: watch.unitAbs,
      waves: watch.waves.map((w) => ({ ...this.summarize(w), state: w.state })),
      createdAt: watch.createdAt,
    };
  }

  /** Sep 10 2026 (Karo), operator-requested restart-safe persistence.
   *  Reconstructs a watch DIRECTLY from a previously-exported state --
   *  used ONLY during startup hydration, never during live event
   *  processing (unlike startCascade(), this OVERWRITES any existing
   *  watch for the same symbol/victim rather than no-op'ing, since
   *  hydration runs once, before any WS ticks flow, on a guaranteed-
   *  empty `watches` map). */
  restoreWatch(
    symbol: string,
    victim: Side,
    state: CascadeCandidateState,
  ): void {
    const waves: CascadeWave[] = state.waves.map((w) => ({
      waveNumber: w.waveNumber,
      state: w.state,
      anchorPrice: w.anchorPrice,
      anchorTs: w.anchorTs,
      extremePrice: w.extremePrice,
      extremeTs: w.extremeTs,
      liqNotionalUsd: w.liqUsd,
      liqEvents: w.liqEvents,
    }));
    this.watches.set(this.keyFor(symbol, victim), {
      symbol,
      victim,
      cascadeId: state.cascadeId,
      timeframe: state.timeframe,
      unitAbs: state.unitAbs,
      waves,
      createdAt: state.createdAt,
      terminal: false,
    });
  }

  get activeWatchCount(): number {
    return this.watches.size;
  }
}
