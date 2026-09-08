import {
  deriveLiquidityTradePlan,
  type LiquidityPlanResult,
  type WallSnapshots,
} from '../../domain/trading/trade-plan';
import type { Side } from '../../shared/common.types';

/**
 * V5's own TP/SL entry point -- deliberately a THIN WRAPPER, not a
 * reimplementation. The exact existing, canonical
 * deriveLiquidityTradePlan() (trade-plan.ts) is reused byte-
 * identically -- its RR-flex, Hybrid-C SL cap, wall-cap, and quality-
 * gate logic are NOT approximated or rewritten here.
 *
 * Sep 7 2026, operator-approved (Karo) -- CRITICAL, explicitly-audited
 * input: cumLiq is ALWAYS episodeTotalLiqUsd, the never-reset, full-
 * episode liquidation sum (V5WatchState.totalEpisodePressure), NEVER
 * a single wave's own liqNotionalUsd. This is the exact bug found and
 * fixed during offline replay validation (v5_wave_reclaim_experiment.ts) --
 * the old, pre-fix behavior silently passed only the LAST wave/segment's
 * own pressure, excluding every earlier wave's contribution.
 *
 * atr15mPct is the qualifying (Wave 1's own) episode-start ATR --
 * fixed for the whole episode's life, matching the offline replay's
 * own convention (episode.atrAtStart), never recomputed per-wave.
 */

export interface V5TradePlanInput {
  episodeTotalLiqUsd: number;
  atr15mPct: number;
  liqBaseline: number;
  entry: number;
  side: Side;
  walls: WallSnapshots;
}

export function deriveV5TradePlan(p: V5TradePlanInput): LiquidityPlanResult {
  return deriveLiquidityTradePlan({
    entry: p.entry,
    side: p.side,
    cumLiq: p.episodeTotalLiqUsd,
    liqBaseline: p.liqBaseline,
    atr15mPct: p.atr15mPct,
    walls: p.walls,
  });
}
