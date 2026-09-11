/**
 * Sep 11 2026 (Karo), operator-requested. OBSERVATIONAL/ANALYTICAL
 * LOGGING ONLY -- computes the liquidation-pressure efficiency
 * relationship between the DOMINANT prior wave and the wave that
 * actually produced the signal. Never influences wave-lifecycle
 * transitions, entry decisions, UNIT, or SL/TP -- purely additive
 * data for later observation of whether TP/SL outcomes correlate
 * with liquidation-efficiency collapse.
 *
 * dominantWave = the largest-liquidation COMPLETED wave among every
 * wave BEFORE the signal-triggering wave (never hardcoded to W1 --
 * for a W1/W2/W3/W4 sequence where W3 produced the signal, dominant
 * is whichever of W1/W2 had the larger liqUsd, NOT necessarily W1).
 *
 * waveEfficiency = priceProgressUnits / (liqNotionalUsd / 1_000_000)
 *   -- UNITs of directional price movement produced per $1M of
 *   forced liquidation pressure.
 *
 * efficiencyRatio = signalWaveEfficiency / dominantWaveEfficiency
 *   -- NEVER clamped. A ratio > 1 (signal wave MORE efficient than
 *   the dominant wave) is genuine, valid information, logged as-is.
 *
 * exhaustion = 1 - efficiencyRatio
 */

export interface WaveEfficiencyMetrics {
  readonly waveNumber: number;
  readonly liqUsd: number;
  readonly anchorPrice: number;
  readonly extremePrice: number;
  readonly priceProgress: number;
  readonly progressUnits: number;
  readonly efficiency: number;
}

export interface WaveEfficiencyAnalysis {
  readonly dominant: WaveEfficiencyMetrics;
  readonly signal: WaveEfficiencyMetrics;
  readonly liqRatio: number;
  readonly efficiencyRatio: number;
  readonly exhaustion: number;
  readonly exhaustionPct: number;
  readonly previousEpisodeExtreme: number;
  readonly newExtremeExtension: number;
  readonly newExtremeExtensionUnits: number;
  readonly unitAbs: number;
}

interface WaveLike {
  readonly waveNumber: number;
  readonly anchorPrice: number;
  readonly extremePrice: number;
  readonly liqUsd: number;
}

function computeWaveMetrics(
  w: WaveLike,
  unitAbs: number,
): WaveEfficiencyMetrics {
  const priceProgress = Math.abs(w.anchorPrice - w.extremePrice);
  const progressUnits = unitAbs > 0 ? priceProgress / unitAbs : 0;
  const liqMillions = w.liqUsd / 1_000_000;
  const efficiency = liqMillions > 0 ? progressUnits / liqMillions : 0;
  return {
    waveNumber: w.waveNumber,
    liqUsd: w.liqUsd,
    anchorPrice: w.anchorPrice,
    extremePrice: w.extremePrice,
    priceProgress,
    progressUnits,
    efficiency,
  };
}

/**
 * `waveHistory` must be sorted ascending by waveNumber (the same
 * ordering already used everywhere else in this project's own
 * waveHistory arrays). `signalWaveNumber` is the wave whose own
 * completion produced SIGNAL_READY. Returns null if there is no wave
 * before the signal wave (W1 alone can never signal in this project's
 * own state machine, so this should never actually happen in
 * production -- returned as null rather than throwing, so a caller
 * can log-and-skip defensively instead of crashing the signal path).
 */
export function computeWaveEfficiencyAnalysis(
  waveHistory: readonly WaveLike[],
  signalWaveNumber: number,
  unitAbs: number,
  victim: "LONG" | "SHORT",
): WaveEfficiencyAnalysis | null {
  const signalWave = waveHistory.find((w) => w.waveNumber === signalWaveNumber);
  const priorWaves = waveHistory.filter((w) => w.waveNumber < signalWaveNumber);
  if (!signalWave || priorWaves.length === 0) return null;

  const dominantWave = priorWaves.reduce(
    (best, w) => (w.liqUsd > best.liqUsd ? w : best),
    priorWaves[0]!,
  );

  const dominant = computeWaveMetrics(dominantWave, unitAbs);
  const signal = computeWaveMetrics(signalWave, unitAbs);

  const efficiencyRatio =
    dominant.efficiency !== 0 ? signal.efficiency / dominant.efficiency : 0;
  const exhaustion = 1 - efficiencyRatio;
  const liqRatio = dominant.liqUsd > 0 ? signal.liqUsd / dominant.liqUsd : 0;

  const previousEpisodeExtreme = priorWaves.reduce(
    (best, w) =>
      victim === "LONG"
        ? Math.min(best, w.extremePrice)
        : Math.max(best, w.extremePrice),
    priorWaves[0]!.extremePrice,
  );
  const newExtremeExtension =
    victim === "LONG"
      ? Math.max(0, previousEpisodeExtreme - signalWave.extremePrice)
      : Math.max(0, signalWave.extremePrice - previousEpisodeExtreme);
  const newExtremeExtensionUnits =
    unitAbs > 0 ? newExtremeExtension / unitAbs : 0;

  return {
    dominant,
    signal,
    liqRatio,
    efficiencyRatio,
    exhaustion,
    exhaustionPct: exhaustion * 100,
    previousEpisodeExtreme,
    newExtremeExtension,
    newExtremeExtensionUnits,
    unitAbs,
  };
}
