/**
 * V5's own, isolated feature flag and symbol universe. Deliberately
 * separate from V3/V4's own config -- V5 must be understandable and
 * disableable without touching anything V3/V4-related.
 */

export function isV5Enabled(): boolean {
  const raw = (process.env.V5_ENABLED ?? "true").toLowerCase();
  return raw !== "false" && raw !== "0";
}

/** Same 10-symbol universe as V3/V4 -- V5 observes every symbol they
 *  already do. Duplicated here (not imported) deliberately, so V5's
 *  own module never needs to import anything from V3/V4's files. */
export const V5_TRACKED_SYMBOLS: ReadonlySet<string> = new Set([
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
]);

/**
 * Sep 7 2026, operator-approved (Karo) -- large, diagnostic-only
 * safety valve so a watch can never track forever. Explicitly NEVER a
 * wave-completion or trading-quality decision -- price structure and
 * liquidation-event occurrence are the only inputs to wave completion
 * (see v5-wave.model.ts's own module doc comment). Every timeout
 * saves the full wave-chain fingerprint and an exact terminal reason,
 * nothing is ever silently discarded.
 *
 *   - INACTIVITY: how long with no qualifying-side liquidation activity
 *     before an unreclaimed episode is abandoned.
 *   - SAFETY_TIMEOUT: hard ceiling on total episode age, regardless of
 *     activity, purely to prevent a pathological, never-ending watch.
 */
export function v5EpisodeInactivityMs(): number {
  const raw = Number(process.env.V5_EPISODE_INACTIVITY_MIN);
  return (Number.isFinite(raw) && raw > 0 ? raw : 15) * 60_000; // default 15min, matches the validated offline replay
}

export function v5EpisodeSafetyTimeoutMs(): number {
  const raw = Number(process.env.V5_EPISODE_SAFETY_TIMEOUT_MIN);
  return (Number.isFinite(raw) && raw > 0 ? raw : 240) * 60_000; // default 4h, matches the validated offline replay
}

/**
 * Sep 7 2026, operator-approved (Karo) -- the meaningful-extreme gate
 * threshold, chosen from historical replay comparison (v5_cache/,
 * 7-day BTC/ETH/SOL/XRP): OLD_100=+0.259R, ALWAYS_50=+0.249R,
 * HYBRID 0.05=+0.390R, 0.10=+0.485R (chosen), 0.15=+0.361R,
 * 0.20=+0.422R, 0.30=+0.112R. Verified clean (no lookahead, no
 * qualification-count artifact, no extreme-size scaling) before
 * activation -- see v5_task_a_verification.ts.
 *
 * Wave 1: distanceATR < this -> the ENTIRE episode is discarded (no
 *   entry, no 100% fallback, no Wave 2 continuation) -- persisted as
 *   its own terminal reason, W1_EXTREME_TOO_SMALL, never silently
 *   dropped. distanceATR >= this -> 50% recovery entry.
 * Wave 2+: distanceATR < this -> 100% own-anchor reclaim (same as the
 *   old model). distanceATR >= this -> 50% recovery entry.
 */
export function v5MinMeaningfulExtremeAtr(): number {
  const raw = Number(process.env.V5_MIN_MEANINGFUL_EXTREME_ATR);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.1;
}

/**
 * Sep 7 2026, operator-approved (Karo) -- Wave 1's own minimum-
 * liquidation-events gate. Explicitly Wave1-only (see
 * v5-wave.service.ts's own gate site): once an episode reaches Wave 2,
 * that wave already exists BECAUSE a fresh, additional liquidation
 * event arrived to start it -- Wave 2+ never needs this check, it's
 * structurally self-satisfying.
 *
 * REVISED philosophy (superseding an earlier, softer version), per
 * explicit operator instruction: if Wave 1 reaches its own recovery/
 * entry trigger while it still has fewer than this many liquidation
 * events, the ENTIRE episode is terminated IMMEDIATELY (watch
 * released) -- regardless of that event's size, price displacement,
 * P95 ratio, or speed. A later liquidation on the same symbol+victim
 * starts a genuinely NEW, independent episode; it can never resurrect
 * the terminated one as a fake "Wave 2". The operator does not want a
 * single-event Wave1 to stay alive waiting for confirmation at all --
 * an unrelated, much-later, tiny liquidation event was observed
 * incorrectly chaining onto a stale single-event Wave1 under the
 * earlier "wait and suppress" version of this gate.
 */
export function v5MinWave1LiqEvents(): number {
  const raw = Number(process.env.V5_MIN_W1_LIQ_EVENTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

/**
 * Sep 7 2026, operator-requested (Karo) -- manual, operator-controlled
 * directional kill-switch. Default: both ON, unchanged behavior. Meant
 * for days with an active, ASYMMETRIC macro/geopolitical risk (e.g.
 * an active Iran-US energy-infrastructure escalation biasing risk
 * strongly toward a BTC downside shock) -- the operator can disable
 * ONE side entirely for the day via .env, without any code change or
 * redeploy beyond a restart. Checked ONLY at the exact moment a NEW
 * watch would be qualified (onLiquidation's own qualification gate)
 * -- an already-running watch on the disabled side is left alone
 * (never abruptly killed mid-life), it simply cannot be CREATED fresh
 * while disabled. This is a coarse, deliberate, manual override --
 * NOT an automated news-reading system; the operator decides when to
 * flip it, based on their own judgment of the day's conditions.
 */
export function v5LongEnabled(): boolean {
  const raw = (process.env.V5_LONG_ENABLED ?? "true").toLowerCase();
  return raw !== "false" && raw !== "0";
}

export function v5ShortEnabled(): boolean {
  const raw = (process.env.V5_SHORT_ENABLED ?? "true").toLowerCase();
  return raw !== "false" && raw !== "0";
}

/**
 * Sep 7 2026, operator-approved (Karo) -- BTC-specific, three-state
 * manual control, env-controlled per instance (MAIN/FRIEND/BROTHER
 * each independently configurable, zero code difference):
 *
 *   NORMAL (default)  -- BTC behaves exactly like every other tracked
 *                         symbol. Nothing changes from today.
 *   EXCLUDE            -- BTC is removed from the tracked-symbol set
 *                         entirely. No watch, no episode, no signal,
 *                         ever, for BTCUSDT specifically.
 *   FILTER              -- BTC is STILL tracked internally (its own
 *                         watch/wave-chain state fully maintained, for
 *                         the filter's own purpose), but BTC itself
 *                         NEVER produces an entry/trade. Additionally,
 *                         while BTC currently has ANY active watch
 *                         (either victim side), NEW watch qualification
 *                         is BLOCKED for every OTHER tracked symbol --
 *                         mirroring the existing, already-proven
 *                         V3 opposing-BTC-watch-safety concept, just
 *                         applied as a qualification-time gate instead
 *                         of a post-hoc BTC-safety-status check.
 */
export type V5BtcMode = "NORMAL" | "EXCLUDE" | "FILTER";

export function v5BtcMode(): V5BtcMode {
  const raw = (process.env.V5_BTC_MODE ?? "NORMAL").toUpperCase();
  if (raw === "EXCLUDE" || raw === "FILTER") return raw;
  return "NORMAL";
}

/**
 * Sep 8 2026, operator-approved (Karo) -- FINAL, precisely-specified
 * BTC block, replacing the earlier (incorrectly-understood)
 * "any-direction FILTER" logic. Explicit operator wording, verbatim:
 * "Do not call this an opposing BTC watch... it is actually a
 * same-side BTC block."
 *
 * When true:
 *   1. BTC itself NEVER produces an executable trade/signal (no
 *      Telegram, no Binance order) -- BTC is used PURELY as a
 *      directional filter for other symbols. See app.ts's own
 *      BTC's-own-entry-block site.
 *   2. For every OTHER tracked symbol, at the moment its own entry
 *      would fire: if BTC currently has an active, unresolved watch
 *      (getBtcWatchVictim() -- BTC's own "intended side", the side it
 *      would trade if BTC itself were allowed to), and that side is
 *      the SAME as the alt's own side, the alt's entry is blocked
 *      entirely (no Telegram, no Binance) -- NOT when opposite.
 *
 *      blockAlt = btcHasActiveSetup && btcIntendedSide === altSide
 *
 *      ALT LONG  + BTC LONG  => BLOCK   ALT SHORT + BTC LONG  => ALLOW
 *      ALT SHORT + BTC SHORT => BLOCK   ALT LONG  + BTC SHORT => ALLOW
 *
 *      Intuition (operator's own words): BTC wanting LONG means BTC is
 *      currently in a downward/liquidation condition looking for its
 *      own reversal -- entering an ALT LONG at the same moment is
 *      correlated risk, not a genuinely independent signal. BTC
 *      wanting SHORT is the mirror case.
 *
 * When false, this entire mechanism is disabled -- BTC and every ALT
 * behave exactly per their own normal, independent V5 logic, with zero
 * cross-symbol interaction. Per-instance (MAIN/FRIEND/BROTHER each set
 * this independently via their own .env, zero code difference).
 */
export function v5BtcBlockEnabled(): boolean {
  const raw = (process.env.V5_BTC_BLOCK ?? "false").toLowerCase();
  return raw === "true" || raw === "1";
}

/**
 * Sep 14 2026 (Karo), operator-approved -- V5 ROTATION mode.
 * Entry-mode switch. "WAVE" (default) preserves 100% of the existing,
 * unmodified Wave1/Wave2 lifecycle -- every branch behind this check
 * being "WAVE" runs byte-identical to before this feature existed.
 * "ROTATION" is the new, experimental single-watch directional-ATR-
 * rotation entry path, isolated behind its own branches throughout
 * v5-wave.service.ts. Per-instance, same convention as every other
 * V5 flag here.
 */
export function v5EntryMode(): "WAVE" | "ROTATION" {
  const raw = (process.env.V5_ENTRY_MODE ?? "WAVE").toUpperCase();
  return raw === "ROTATION" ? "ROTATION" : "WAVE";
}

/**
 * Sep 14 2026 (Karo), operator-approved -- V5 ROTATION mode.
 * Experimental entry-condition constants, ported directly from the
 * research thread's own validated candidate (rotation-15deg-feature-
 * diagnosis.ts and its predecessors). Deliberately NOT optimized or
 * tuned here -- these are the exact values approved for this
 * production port; visible/configurable via env for operational
 * flexibility only, not because a better value is expected to be
 * found by adjusting them casually.
 */
export function v5RotationDegreesRequired(): number {
  const raw = Number(process.env.V5_ROTATION_DEGREES_REQUIRED);
  return Number.isFinite(raw) && raw > 0 ? raw : 15;
}
export function v5RotationShockAtrRequired(): number {
  const raw = Number(process.env.V5_ROTATION_SHOCK_ATR_REQUIRED);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}
export function v5RotationMaxTimeFromExtremeMin(): number {
  const raw = Number(process.env.V5_ROTATION_MAX_TIME_FROM_EXTREME_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}
export function v5RotationForceRequired(): number {
  const raw = Number(process.env.V5_ROTATION_FORCE_REQUIRED);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.3;
}
export function v5RotationSlopeWindowMin(): number {
  return 2; // fixed, per the approved research candidate -- not exposed as a tunable
}
export function v5RotationMinPriorEpisodeSamples(): number {
  const raw = Number(process.env.V5_ROTATION_MIN_PRIOR_SAMPLES);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
}
/** Sep 14 2026 (Karo), operator-approved -- V5 ROTATION mode. Genuinely
 *  separate from v5EpisodeInactivityMs() above (that constant belongs
 *  to the disconnected, dead V5WaveService engine, a conceptually
 *  different feature with its own env var) -- 15 minutes, measured
 *  from the last raw same-side liquidation event, per explicit
 *  operator instruction. */
export function v5RotationInactivityMs(): number {
  const raw = Number(process.env.V5_ROTATION_INACTIVITY_MIN);
  return (Number.isFinite(raw) && raw > 0 ? raw : 15) * 60_000;
}

/**
 * Sep 14 2026 (Karo), operator-approved -- V5 ROTATION mode fixed
 * risk plan (explicitly NOT the dynamic deriveLiquidationPhysicsTradePlan()
 * used by WAVE mode -- a single-wave rotation watch has no genuine
 * W1/W2 structure to feed that function, so ROTATION mode uses a
 * simple, fixed SL/TP instead, per explicit operator decision).
 */
export function v5RotationSlPct(): number {
  const raw = Number(process.env.V5_ROTATION_SL_PCT);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.003; // 0.30%
}
export function v5RotationTpPct(): number {
  const raw = Number(process.env.V5_ROTATION_TP_PCT);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.006; // 0.60%, RR=2.0
}
