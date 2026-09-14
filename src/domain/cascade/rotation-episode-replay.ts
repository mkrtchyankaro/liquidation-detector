import type { Side, Liquidation } from "../../shared/common.types";
import {
  CandlePhysicsEngine,
  type CandlePhysicsCancelEvent,
} from "./candle-physics-engine";
import {
  DirectionalAtrTracker,
  type ClosedCandle,
} from "../../strategy/v5/directional-atr";

/**
 * Sep 14 2026 (Karo), operator-requested. The historical counterpart
 * of the LIVE ROTATION wiring in market-data-orchestrator.ts -- reuses
 * CandlePhysicsEngine and DirectionalAtrTracker COMPLETELY UNMODIFIED,
 * fed the same event shapes in the same causal order live production
 * uses, so reconstructed episodes can never structurally drift from
 * what production would have produced watching the same raw data live.
 *
 * CRITICAL DESIGN NOTE: this replay NEVER calls
 * CandlePhysicsEngine.setRotationCausalP95() for any watch. Since
 * ENTRY requires rotationCausalP95 !== null (see onClosedCandle()'s
 * own p95Reached gate), leaving it permanently null makes ENTRY
 * structurally impossible during replay -- every ROTATION watch this
 * produces can only ever terminate via CANCEL (15-minute inactivity).
 * This is what satisfies "do NOT create fake historical CANCEL
 * signals" and its symmetric counterpart (never fabricate a historical
 * ENTRY either) -- not a special case, a direct consequence of not
 * wiring P95 feedback into the replay at all.
 */

export interface HistoricalCandle extends ClosedCandle {
  open: number;
}

export interface ReconstructedEpisode {
  symbol: string;
  victim: Side;
  episodeStartTs: number;
  episodeEndTs: number;
  cumulativeLiqUsd: number;
  eventCount: number;
  maxSingleLiqUsd: number;
  startPrice: number;
  adverseExtremePrice: number;
  adverseExtremeTs: number;
  preLiqDownAtr: number | null;
  preLiqUpAtr: number | null;
  finalDownAtr: number | null;
  finalUpAtr: number | null;
  durationMs: number;
}

export interface ReplayStats {
  liquidationEventsProcessed: number;
  candlesProcessed: number;
  episodesProduced: number;
}

/**
 * Replays one symbol's own raw liquidation events + closed 1m candles,
 * in causal order, through a fresh CandlePhysicsEngine (mode=ROTATION)
 * + DirectionalAtrTracker pair, and returns every episode that
 * completed via 15-minute inactivity.
 *
 * `liquidations` and `candles` must each already be sorted ascending
 * by timestamp/openTime -- this function does not re-sort (callers
 * fetching from Mongo/Binance should sort at the query level, which
 * is cheaper and more obviously correct than re-sorting here).
 *
 * Causal ordering per candle: every liquidation with
 * `candle.openTime <= liq.timestamp < candle.openTime + 60000` is fed
 * to onLiquidation() BEFORE that candle is fed to onClosedCandle() --
 * exactly mirroring live production's own event order (liquidations
 * arrive continuously through the minute; the candle closes at the
 * end of it). No future leakage: a candle's own high/low/close is
 * NEVER available to onLiquidation() calls for liquidations that
 * arrived earlier in the same minute (onLiquidation() never reads
 * candle data at all), and onClosedCandle() for THIS candle is never
 * called before all of THIS minute's own liquidations have been fed.
 */
export function replayRotationEpisodes(
  symbol: string,
  liquidations: readonly Liquidation[],
  candles: readonly HistoricalCandle[],
): { episodes: ReconstructedEpisode[]; stats: ReplayStats } {
  const engine = new CandlePhysicsEngine();
  const directionalAtr = new DirectionalAtrTracker();
  const episodes: ReconstructedEpisode[] = [];
  let liqIdx = 0;
  let candlesProcessed = 0;

  const recordCancel = (
    victim: Side,
    cancel: CandlePhysicsCancelEvent,
    candleEndTs: number,
  ): void => {
    // Read the watch's own final state BEFORE clearTerminal() deletes
    // it below -- same ordering discipline as the live
    // handleCandlePhysicsCancel() uses.
    const watch = engine.peekWatch(symbol, victim);
    if (!watch || watch.mode !== "ROTATION") return; // defensive; should never happen for a CANCEL from a mode="ROTATION" watch
    episodes.push({
      symbol,
      victim,
      episodeStartTs: watch.episodeStartTs,
      episodeEndTs: cancel.cancelTs,
      cumulativeLiqUsd: watch.cumulativeSameSideLiqUsd,
      eventCount: watch.rotationEventCount,
      maxSingleLiqUsd: watch.episodeMaxIndividualEventUsd,
      startPrice: watch.episodeStartPrice,
      adverseExtremePrice: watch.episodeExtreme,
      adverseExtremeTs: watch.adverseExtremeTs,
      preLiqDownAtr: watch.preLiqDownAtr,
      preLiqUpAtr: watch.preLiqUpAtr,
      finalDownAtr: directionalAtr.getDownAtr(symbol),
      finalUpAtr: directionalAtr.getUpAtr(symbol),
      durationMs: cancel.cancelTs - watch.episodeStartTs,
    });
    engine.clearTerminal(symbol, victim);
    void candleEndTs;
  };

  for (const candle of candles) {
    const candleEnd = candle.openTime + 60_000;

    // Feed every liquidation strictly within this candle's own minute,
    // BEFORE the candle itself closes -- causal order.
    while (
      liqIdx < liquidations.length &&
      liquidations[liqIdx]!.timestamp < candleEnd
    ) {
      const liq = liquidations[liqIdx]!;
      liqIdx++;
      if (liq.symbol !== symbol) continue;
      const victim: Side = liq.side === "SELL" ? "LONG" : "SHORT";
      const isNewWatch = engine.peekWatch(symbol, victim) === null;
      const preLiqDownAtr = isNewWatch
        ? directionalAtr.getDownAtr(symbol)
        : null;
      const preLiqUpAtr = isNewWatch ? directionalAtr.getUpAtr(symbol) : null;
      engine.onLiquidation(
        symbol,
        victim,
        liq,
        1,
        liq.price,
        liq.timestamp,
        "ROTATION",
        preLiqDownAtr,
        preLiqUpAtr,
      );
    }

    // Directional ATR fed at the SAME closed-candle site live
    // production uses, BEFORE this candle's own onClosedCandle() call
    // so a newly-opened watch this same candle already sees a
    // consistent, just-updated ATR state (matches live ordering).
    directionalAtr.onCandle(candle);
    candlesProcessed++;

    for (const victim of ["LONG", "SHORT"] as const) {
      const rotDownAtr = directionalAtr.getDownAtr(symbol);
      const rotUpAtr = directionalAtr.getUpAtr(symbol);
      const watchBefore = engine.peekWatch(symbol, victim);
      let rotDownSlope: number | null = null;
      let rotUpSlope: number | null = null;
      if (watchBefore?.mode === "ROTATION") {
        if (watchBefore.preLiqDownAtr !== null)
          rotDownSlope = directionalAtr.getDownSlopeNormalized(
            symbol,
            2,
            watchBefore.preLiqDownAtr,
          );
        if (watchBefore.preLiqUpAtr !== null)
          rotUpSlope = directionalAtr.getUpSlopeNormalized(
            symbol,
            2,
            watchBefore.preLiqUpAtr,
          );
      }
      // rotationCausalP95 is DELIBERATELY never set (see this file's
      // own header doc comment) -- ENTRY can never fire during replay.
      const result = engine.onClosedCandle(
        symbol,
        victim,
        candle.openTime,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        null,
        rotDownAtr,
        rotUpAtr,
        rotDownSlope,
        rotUpSlope,
      );
      if (result?.kind === "CANCEL") recordCancel(victim, result, candleEnd);
      // ENTRY/PRE_W1_DISCARD are structurally impossible for a
      // ROTATION-mode watch with no P95 ever supplied -- PRE_W1_DISCARD
      // is a WAVE-only outcome kind entirely. Nothing else to handle.
    }
  }

  return {
    episodes,
    stats: {
      liquidationEventsProcessed: liqIdx,
      candlesProcessed,
      episodesProduced: episodes.length,
    },
  };
}
