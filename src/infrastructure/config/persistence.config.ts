/**
 * Step E — liquidation persistence configuration.
 *
 * Controls whether the bot writes 1-minute liquidation aggregates to Mongo so
 * it can warm up percentile thresholds on restart instead of cold-starting
 * from tier defaults.
 *
 * This is OBSERVATION-ONLY persistence: nothing here drives signals or
 * orders. It only restores percentile state across bot restarts.
 *
 *   LIQ_PERSIST_ENABLED       master switch — false skips warmup AND flush
 *   LIQ_TOP_EVENTS=3          how many largest events/minute we keep (1..10)
 *   LIQ_RETENTION_DAYS=7      Mongo TTL on liq_minute_aggregates  (1..30)
 *   LIQ_FLUSH_INTERVAL_SEC=60 cadence of the flush timer          (10..600)
 *   LIQ_WARMUP_HOURS=24       how far back to read on boot         (1..72)
 *
 * FUTURE NOTE — wall persistence (NOT in Step E):
 * When walls become decision-making inputs, add a sibling
 * `wall_minute_aggregates` collection and a parallel `WALL_PERSIST_*` env
 * namespace so the toggles stay independent of liquidation persistence.
 * That is intentionally deferred — Step E is liquidation-only.
 */

export interface PersistenceConfig {
  enabled: boolean;
  topEventsPerMinute: number;
  retentionDays: number;
  flushIntervalMs: number;
  warmupMs: number;
}

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

export function loadPersistenceConfig(): PersistenceConfig {
  return {
    enabled: parseBoolEnv("LIQ_PERSIST_ENABLED", true),
    topEventsPerMinute: parseIntEnv("LIQ_TOP_EVENTS", 3, 1, 10),
    retentionDays: parseIntEnv("LIQ_RETENTION_DAYS", 7, 1, 30),
    flushIntervalMs: parseIntEnv("LIQ_FLUSH_INTERVAL_SEC", 60, 10, 600) * 1000,
    warmupMs: parseIntEnv("LIQ_WARMUP_HOURS", 24, 1, 72) * 60 * 60 * 1000,
  };
}
