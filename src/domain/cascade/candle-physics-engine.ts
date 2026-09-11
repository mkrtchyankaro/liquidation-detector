import type { Side, Liquidation } from "../../shared/common.types";

/**
 * Sep 11 2026 (Karo), operator-requested. Production wave-detection
 * engine, replacing the OLD 1x-UNIT-recovery W1/W2 state machine
 * entirely. Ported EXACTLY from the tested replay script
 * (scripts/replay-signal-candle-physics.js, --no-extreme-test mode --
 * the operator's own explicit instruction NOT to add
 * WAIT_EXTREME_TEST or any new threshold in this implementation).
 *
 * Core idea: liquidation is PRESSURE, price is the RESULT, UNIT
 * (frozen 1m Wilder ATR(240)) is the RULER. Every CLOSED 1-minute
 * candle is judged for what the liquidation pressure actually
 * accomplished, using ONLY the wave's own prior candle history for
 * comparison -- never a fixed numeric threshold.
 *
 * State machine (per symbol+victim watch):
 *   NO_WAVE
 *     -> (same-side liquidation arrives, closed candle shows real
 *        directional extension) -> ACTIVE
 *     -> (same-side liquidation arrives, closed candle shows ZERO
 *        extension) -> stays NO_WAVE (never a permanent invalid state
 *        -- the next liquidation may freely open a fresh candidate)
 *   ACTIVE
 *     -> (new directional extreme made) -> stays ACTIVE
 *     -> (no new extreme, recovery > this wave's own prior median
 *        recovery) -> EXHAUSTING
 *   EXHAUSTING
 *     -> (new directional extreme made) -> reverts to ACTIVE (the
 *        wave was NOT really complete)
 *     -> (still no new extreme, a second consecutive stalling candle)
 *        -> wave COMPLETE: compare its own efficiency
 *        (totalExtensionUnits / (totalLiqUsd/1e6)) against the current
 *        dominant prior wave's own efficiency:
 *          efficiency >= dominant -> CONTINUATION: this wave becomes
 *            the new dominant reference, state -> WAIT_NEXT_PRESSURE
 *          efficiency < dominant -> EXHAUSTION CONFIRMED -> ENTRY,
 *            immediately, at this candle's own close price
 *   WAIT_NEXT_PRESSURE
 *     -> next same-side liquidation opens a fresh wave candidate,
 *        judged exactly the same way as the very first one
 *
 * This is the ONLY production wave-decision path -- the OLD 1x-UNIT-
 * recovery cascade-candidate.service.ts is no longer called from any
 * live entry point (still present, unused, per the operator's own
 * "do not delete" instruction elsewhere in this project).
 */

export type CandlePhysicsState =
  | "NO_WAVE"
  | "ACTIVE"
  | "EXHAUSTING"
  | "WAIT_NEXT_PRESSURE"
  | "ENTERED"
  | "TERMINAL_CANCELLED";

export interface WaveCandleMetric {
  readonly candleStart: number;
  readonly sameSideLiqUsd: number;
  readonly sameSideLiqEvents: number;
  readonly maxSameSideLiqEvent: number;
  readonly newDirectionalExtensionUnits: number;
  readonly recoveryUnits: number;
}

export interface CompletedWaveSummary {
  readonly waveNumber: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly totalLiqUsd: number;
  readonly totalEvents: number;
  readonly maxEvent: number;
  readonly extreme: number;
  readonly totalExtensionUnits: number;
  readonly efficiency: number | null;
  readonly candles: readonly WaveCandleMetric[];
}

export interface CandlePhysicsEntryEvent {
  readonly kind: "ENTRY";
  readonly symbol: string;
  readonly victim: Side;
  readonly entryPrice: number;
  readonly entryTs: number;
  readonly unitAbs: number;
  readonly episodeStartTs: number;
  readonly signalWave: CompletedWaveSummary;
  readonly dominantWave: CompletedWaveSummary;
  readonly allWaves: readonly CompletedWaveSummary[];
  /** Sep 11 2026 (Karo), operator-requested -- the largest SINGLE raw
   *  liquidation event notional seen anywhere in this episode (across
   *  every wave, including any single-event waves that were
   *  discarded). Purely a raw, episode-level maximum -- this engine
   *  itself has no knowledge of P95 or any other threshold; the
   *  caller (market-data-orchestrator.ts) is the ONLY place that
   *  compares this value against P95 as a final gate before allowing
   *  ENTRY, per the operator's own explicit "P95 lives OUTSIDE the
   *  candle-physics engine" instruction. */
  readonly maxIndividualEventUsd: number;
}

export interface CandlePhysicsCancelEvent {
  readonly kind: "CANCEL";
  readonly symbol: string;
  readonly victim: Side;
  readonly reason:
    | "CANCEL_NO_NEXT_WAVE"
    | "EPISODE_EXPIRED_INACTIVITY"
    | "EPISODE_EXPIRED_SAFETY_TIMEOUT";
  readonly cancelTs: number;
  readonly episodeStartTs: number;
  readonly allWaves: readonly CompletedWaveSummary[];
}

interface Watch {
  symbol: string;
  victim: Side;
  unitAbs: number;
  episodeStartTs: number;
  state: CandlePhysicsState;
  waveNumber: number;
  currentWaveCandles: WaveCandleMetric[];
  currentWaveStart: number | null;
  episodeExtreme: number;
  dominantWave: CompletedWaveSummary | null;
  completedWaves: CompletedWaveSummary[];
  pendingLiqUsd: number;
  pendingLiqEvents: number;
  pendingMaxEvent: number;
  lastWaveCompletedAt: number;
  /** Sep 11 2026 (Karo), operator-requested -- raw, episode-level
   *  maximum of any SINGLE liquidation event's own notional seen
   *  since this episode began (never reset per-wave, persists across
   *  discarded single-event waves too -- "somewhere in the CURRENT
   *  episode, before that ENTRY"). Purely tracked here; never
   *  compared against anything inside this engine. */
  episodeMaxIndividualEventUsd: number;
}

const INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const SAFETY_TIMEOUT_MS = 30 * 60_000;

function keyFor(symbol: string, victim: Side): string {
  return symbol + "|" + victim;
}

function median(arr: readonly number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function waveSummary(
  waveNumber: number,
  candles: readonly WaveCandleMetric[],
  extreme: number,
): CompletedWaveSummary {
  const totalLiqUsd = candles.reduce((s, c) => s + c.sameSideLiqUsd, 0);
  const totalEvents = candles.reduce((s, c) => s + c.sameSideLiqEvents, 0);
  const maxEvent = candles.reduce(
    (m, c) => Math.max(m, c.maxSameSideLiqEvent),
    0,
  );
  const totalExtensionUnits = candles.reduce(
    (s, c) => s + Math.max(0, c.newDirectionalExtensionUnits),
    0,
  );
  const liqMillions = totalLiqUsd / 1_000_000;
  const efficiency = liqMillions > 0 ? totalExtensionUnits / liqMillions : null;
  return {
    waveNumber,
    startTime: candles[0]!.candleStart,
    endTime: candles[candles.length - 1]!.candleStart,
    totalLiqUsd,
    totalEvents,
    maxEvent,
    extreme,
    totalExtensionUnits,
    efficiency,
    candles,
  };
}

export class CandlePhysicsEngine {
  private readonly watches = new Map<string, Watch>();

  onLiquidation(
    symbol: string,
    victim: Side,
    liq: Liquidation,
    unitAbsForNewEpisode: number,
    priceForNewEpisode: number,
    ts: number,
  ): void {
    const key = keyFor(symbol, victim);
    let w = this.watches.get(key);
    if (!w || w.state === "TERMINAL_CANCELLED") {
      w = {
        symbol,
        victim,
        unitAbs: unitAbsForNewEpisode,
        episodeStartTs: ts,
        state: "NO_WAVE",
        waveNumber: 0,
        currentWaveCandles: [],
        currentWaveStart: null,
        episodeExtreme: priceForNewEpisode,
        dominantWave: null,
        completedWaves: [],
        pendingLiqUsd: 0,
        pendingLiqEvents: 0,
        pendingMaxEvent: 0,
        lastWaveCompletedAt: ts,
        episodeMaxIndividualEventUsd: 0,
      };
      this.watches.set(key, w);
    }
    w.pendingLiqUsd += liq.quoteQty;
    w.pendingLiqEvents += 1;
    w.pendingMaxEvent = Math.max(w.pendingMaxEvent, liq.quoteQty);
    w.episodeMaxIndividualEventUsd = Math.max(
      w.episodeMaxIndividualEventUsd,
      liq.quoteQty,
    );
  }

  onClosedCandle(
    symbol: string,
    victim: Side,
    candleStart: number,
    open: number,
    high: number,
    low: number,
    close: number,
  ): CandlePhysicsEntryEvent | CandlePhysicsCancelEvent | null {
    const key = keyFor(symbol, victim);
    const w = this.watches.get(key);
    if (!w || w.state === "TERMINAL_CANCELLED" || w.state === "ENTERED")
      return null;

    const forcedDown = victim === "LONG";
    const sameSideLiqUsd = w.pendingLiqUsd;
    const sameSideLiqEvents = w.pendingLiqEvents;
    const maxSameSideLiqEvent = w.pendingMaxEvent;
    w.pendingLiqUsd = 0;
    w.pendingLiqEvents = 0;
    w.pendingMaxEvent = 0;

    const priorExtreme = w.episodeExtreme;
    const newDirectionalExtension = forcedDown
      ? Math.max(0, priorExtreme - low)
      : Math.max(0, high - priorExtreme);
    const newDirectionalExtensionUnits =
      w.unitAbs > 0 ? newDirectionalExtension / w.unitAbs : 0;
    w.episodeExtreme = forcedDown
      ? Math.min(w.episodeExtreme, low)
      : Math.max(w.episodeExtreme, high);

    const recoveryFromExtreme = forcedDown
      ? close - w.episodeExtreme
      : w.episodeExtreme - close;
    const recoveryUnits = w.unitAbs > 0 ? recoveryFromExtreme / w.unitAbs : 0;
    const madeNewExtreme = newDirectionalExtensionUnits > 0;

    const metric: WaveCandleMetric = {
      candleStart,
      sameSideLiqUsd,
      sameSideLiqEvents,
      maxSameSideLiqEvent,
      newDirectionalExtensionUnits,
      recoveryUnits,
    };

    if (
      w.state === "WAIT_NEXT_PRESSURE" &&
      candleStart - w.lastWaveCompletedAt >= INACTIVITY_TIMEOUT_MS &&
      sameSideLiqUsd === 0
    ) {
      w.state = "TERMINAL_CANCELLED";
      return {
        kind: "CANCEL",
        symbol,
        victim,
        reason: "EPISODE_EXPIRED_INACTIVITY",
        cancelTs: candleStart,
        episodeStartTs: w.episodeStartTs,
        allWaves: w.completedWaves,
      };
    }
    if (candleStart - w.episodeStartTs >= SAFETY_TIMEOUT_MS) {
      w.state = "TERMINAL_CANCELLED";
      return {
        kind: "CANCEL",
        symbol,
        victim,
        reason: "EPISODE_EXPIRED_SAFETY_TIMEOUT",
        cancelTs: candleStart,
        episodeStartTs: w.episodeStartTs,
        allWaves: w.completedWaves,
      };
    }

    if (w.state === "NO_WAVE" || w.state === "WAIT_NEXT_PRESSURE") {
      if (sameSideLiqUsd > 0) {
        if (madeNewExtreme) {
          w.waveNumber++;
          w.currentWaveCandles = [metric];
          w.currentWaveStart = candleStart;
          w.state = "ACTIVE";
        }
      }
      return null;
    }

    if (w.state === "ACTIVE" || w.state === "EXHAUSTING") {
      w.currentWaveCandles.push(metric);
      if (madeNewExtreme) {
        w.state = "ACTIVE";
        return null;
      }
      const priorCandles = w.currentWaveCandles.slice(0, -1);
      const priorMedianRecovery =
        median(priorCandles.map((c) => c.recoveryUnits)) ?? 0;

      if (w.state === "ACTIVE") {
        if (recoveryUnits > priorMedianRecovery) w.state = "EXHAUSTING";
        return null;
      }

      const summary = waveSummary(
        w.waveNumber,
        w.currentWaveCandles,
        w.episodeExtreme,
      );

      // Sep 11 2026 (Karo), operator-requested -- a wave that naturally
      // completes with exactly ONE liquidation event across its whole
      // life is discarded entirely: it never becomes a meaningful
      // wave, never becomes dominant, never enters efficiency
      // comparison, never triggers ENTRY, and its own wave number is
      // reused by the next real candidate (waveNumber is decremented
      // back). This check runs ONLY at natural completion -- a
      // single-event candidate is still tracked normally through
      // ACTIVE/EXHAUSTING exactly as before, since more events may
      // still arrive while it is active.
      if (summary.totalEvents === 1) {
        w.waveNumber--;
        w.currentWaveCandles = [];
        w.currentWaveStart = null;
        w.state = w.dominantWave === null ? "NO_WAVE" : "WAIT_NEXT_PRESSURE";
        w.lastWaveCompletedAt = candleStart;
        return null;
      }

      w.completedWaves.push(summary);

      if (w.dominantWave === null) {
        w.dominantWave = summary;
        w.state = "WAIT_NEXT_PRESSURE";
        w.lastWaveCompletedAt = candleStart;
        return null;
      }

      const domEff = w.dominantWave.efficiency;
      const curEff = summary.efficiency;
      if (domEff === null || curEff === null || curEff >= domEff) {
        w.dominantWave = summary;
        w.state = "WAIT_NEXT_PRESSURE";
        w.lastWaveCompletedAt = candleStart;
        return null;
      }

      w.state = "ENTERED";
      return {
        kind: "ENTRY",
        symbol,
        victim,
        entryPrice: close,
        entryTs: candleStart,
        unitAbs: w.unitAbs,
        episodeStartTs: w.episodeStartTs,
        signalWave: summary,
        dominantWave: w.dominantWave,
        allWaves: w.completedWaves,
        maxIndividualEventUsd: w.episodeMaxIndividualEventUsd,
      };
    }

    return null;
  }

  peekWatch(symbol: string, victim: Side): Readonly<Watch> | null {
    return this.watches.get(keyFor(symbol, victim)) ?? null;
  }

  clearTerminal(symbol: string, victim: Side): void {
    const key = keyFor(symbol, victim);
    const w = this.watches.get(key);
    if (w && (w.state === "ENTERED" || w.state === "TERMINAL_CANCELLED"))
      this.watches.delete(key);
  }
}
