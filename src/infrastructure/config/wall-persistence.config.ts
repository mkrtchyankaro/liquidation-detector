/**
 * Step E2 — wall summary persistence configuration.
 *
 * Controls whether the bot writes 1-minute wall summaries to Mongo for
 * forensic analysis and offline calibration.
 *
 * IMPORTANT — analysis-only persistence: this layer NEVER feeds DB data
 * back into live decision logic. Walls are inherently live state; a wall
 * that existed 30 minutes ago tells you nothing about now. There is
 * intentionally no warmup path. The DB is for queries from mongosh /
 * external scripts only.
 *
 *   WALL_PERSIST_ENABLED       master switch — false skips all writes
 *   WALL_RETENTION_DAYS=14     Mongo TTL on wall_minute_aggregates (1..30)
 *                              Defaults to 14 (vs liq's 7) because the value
 *                              of wall data is forensic, not recovery.
 *   WALL_FLUSH_INTERVAL_SEC=60 cadence of the flush timer            (10..600)
 *
 * This config is fully INDEPENDENT of LIQ_PERSIST_*. Either feature can be
 * disabled without affecting the other. There is also no top-events or
 * warmup-window knob here because walls don't reconstruct percentiles.
 */

export interface WallPersistenceConfig {
  enabled: boolean;
  retentionDays: number;
  flushIntervalMs: number;
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

export function loadWallPersistenceConfig(): WallPersistenceConfig {
  return {
    enabled: parseBoolEnv("WALL_PERSIST_ENABLED", true),
    retentionDays: parseIntEnv("WALL_RETENTION_DAYS", 14, 1, 30),
    flushIntervalMs: parseIntEnv("WALL_FLUSH_INTERVAL_SEC", 60, 10, 600) * 1000,
  };
}
