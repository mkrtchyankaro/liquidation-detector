/**
 * Phase 1 — observability-only configuration.
 *
 * These services are passive consumers of WS data. Nothing here drives signals,
 * orders, or strategy decisions; they exist so we can SEE liquidation
 * distributions and orderbook walls before any strategy logic is built on top
 * of them.
 *
 * Master switch:  OBS_ENABLED=false disables everything.
 * Per-service:    OBS_LIQ_STATS_ENABLED, OBS_WALL_TRACKER_ENABLED.
 * Cadence:        OBS_LOG_INTERVAL_SEC (default 60).
 * Tier overrides: OBS_TIER_OVERRIDES=PEPEUSDT:smallAlt,WIFUSDT:midAlt
 */

export type SymbolTier = "btc" | "eth" | "largeAlt" | "midAlt" | "smallAlt";

export interface TierThreshold {
  largeLiqUsd: number;
  cluster1mUsd: number;
  cluster5mUsd: number;
}

export interface LiquidationStatsConfig {
  enabled: boolean;
  /** Number of sealed 1-minute buckets retained per symbol (60 = one hour). */
  bucket1mCount: number;
  /** Per-symbol ring buffer size for individual liquidation notional samples. */
  sampleCapacity: number;
  /** Below this many samples we fall back to tier defaults instead of percentiles. */
  minSamplesForPercentiles: number;
}

export interface WallTrackerConfig {
  enabled: boolean;
  /** Minimum gap (ms) between processed depth snapshots per symbol. */
  throttleMs: number;
  /** Price-band width as a fraction of mid (0.0001 = 0.01% bands). */
  bandPctOfMid: number;
  /** A wall is "persistent" once it has lived this long without being pulled. */
  minPersistenceMs: number;
  /** Notional shrink fraction (vs peak) that flags a wall as pulled. */
  pullShrinkPct: number;
  /** Approach radius (fraction of mid) that counts as "price approached the wall". */
  pullProximityPct: number;
  /** Hard cap on tracked candidate walls per symbol per side. */
  maxTrackedPerSymbol: number;
  /** Tracked walls not seen for this long are evicted from memory. */
  evictAfterMs: number;
  /**
   * Per-tier multiplier: a level qualifies as a candidate wall when its
   * notional ≥ multiplier × the snapshot's median level notional on that
   * side. Tuned per tier because alt-coin orderbooks tend to have flatter
   * notional distributions than BTC/ETH (a 5× cutoff that works well on
   * BTC/ETH excludes legitimate walls on most large-cap alts).
   */
  wallMedianMultiplierByTier: Record<SymbolTier, number>;
}

export interface ObservabilityConfig {
  enabled: boolean;
  logIntervalMs: number;
  liquidationStats: LiquidationStatsConfig;
  wallTracker: WallTrackerConfig;
  tierThresholds: Record<SymbolTier, TierThreshold>;
  tierMap: Record<string, SymbolTier>;
  defaultTier: SymbolTier;
}

const DEFAULT_TIER_THRESHOLDS: Record<SymbolTier, TierThreshold> = {
  btc: {
    largeLiqUsd: 250_000,
    cluster1mUsd: 1_000_000,
    cluster5mUsd: 3_000_000,
  },
  eth: { largeLiqUsd: 100_000, cluster1mUsd: 400_000, cluster5mUsd: 1_200_000 },
  largeAlt: {
    largeLiqUsd: 30_000,
    cluster1mUsd: 100_000,
    cluster5mUsd: 300_000,
  },
  midAlt: { largeLiqUsd: 15_000, cluster1mUsd: 50_000, cluster5mUsd: 150_000 },
  smallAlt: {
    largeLiqUsd: 10_000,
    cluster1mUsd: 35_000,
    cluster5mUsd: 100_000,
  },
};

const DEFAULT_TIER_MAP: Record<string, SymbolTier> = {
  // Tier: btc
  BTCUSDT: "btc",
  // Tier: eth
  ETHUSDT: "eth",
  // Tier: largeAlt
  SOLUSDT: "largeAlt",
  BNBUSDT: "largeAlt",
  XRPUSDT: "largeAlt",
  ADAUSDT: "largeAlt",
  LINKUSDT: "largeAlt",
  AVAXUSDT: "largeAlt",
  DOTUSDT: "largeAlt",
  TRXUSDT: "largeAlt",
  DOGEUSDT: "largeAlt",
  // Tier: midAlt
  ARBUSDT: "midAlt",
  OPUSDT: "midAlt",
  MATICUSDT: "midAlt",
  NEARUSDT: "midAlt",
  APTUSDT: "midAlt",
  SUIUSDT: "midAlt",
  INJUSDT: "midAlt",
  FILUSDT: "midAlt",
  LTCUSDT: "midAlt",
  BCHUSDT: "midAlt",
  // Anything not listed falls through to defaultTier ('smallAlt').
};

const VALID_TIERS = new Set<SymbolTier>([
  "btc",
  "eth",
  "largeAlt",
  "midAlt",
  "smallAlt",
]);

function parseBoolEnv(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return v.trim().toLowerCase() === "true";
}

function parseIntEnv(
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v)) return def;
  if (v < min || v > max) return def;
  return Math.floor(v);
}

function parseTierOverrides(raw: string): Record<string, SymbolTier> {
  const out: Record<string, SymbolTier> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const parts = pair.trim().split(":");
    if (parts.length !== 2) continue;
    const sym = (parts[0] ?? "").trim().toUpperCase();
    const tier = (parts[1] ?? "").trim() as SymbolTier;
    if (!sym || !VALID_TIERS.has(tier)) continue;
    out[sym] = tier;
  }
  return out;
}

export function loadObservabilityConfig(): ObservabilityConfig {
  const enabled = parseBoolEnv("OBS_ENABLED", true);
  const liqStatsEnabled = parseBoolEnv("OBS_LIQ_STATS_ENABLED", true);
  const wallTrackerEnabled = parseBoolEnv("OBS_WALL_TRACKER_ENABLED", true);
  const logIntervalSec = parseIntEnv("OBS_LOG_INTERVAL_SEC", 60, 5, 600);

  const tierMap: Record<string, SymbolTier> = { ...DEFAULT_TIER_MAP };
  Object.assign(
    tierMap,
    parseTierOverrides(process.env.OBS_TIER_OVERRIDES ?? ""),
  );

  return {
    enabled,
    logIntervalMs: logIntervalSec * 1000,
    liquidationStats: {
      enabled: liqStatsEnabled,
      bucket1mCount: 60,
      sampleCapacity: 5_000,
      minSamplesForPercentiles: 30,
    },
    wallTracker: {
      enabled: wallTrackerEnabled,
      throttleMs: 250,
      bandPctOfMid: 0.0001,
      minPersistenceMs: 3_000,
      pullShrinkPct: 0.7,
      pullProximityPct: 0.001,
      maxTrackedPerSymbol: 50,
      evictAfterMs: 30_000,
      wallMedianMultiplierByTier: {
        btc: 5,
        eth: 5,
        largeAlt: 2.5,
        midAlt: 3,
        smallAlt: 3,
      },
    },
    tierThresholds: DEFAULT_TIER_THRESHOLDS,
    tierMap,
    defaultTier: "smallAlt",
  };
}
