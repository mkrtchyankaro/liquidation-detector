/**
 * Sep 8 2026, operator-approved (Karo). In-memory, per-signal
 * reconciliation-health tracker for V5's own live-position polling
 * (reconcileV5LiveTrade in app.ts). Deliberately NOT Mongo-backed --
 * operator explicit instruction: "I do not want another Mongo
 * collection for reconciliation failures." This is transient,
 * operational health-tracking, not durable trade state; losing it on
 * restart is fine (a fresh restart just re-observes the same ongoing
 * failure and re-times its own 5-minute window from zero, which is an
 * acceptable, harmless reset -- never a correctness issue).
 *
 * Absolute, load-bearing invariant this class NEVER violates: it has
 * no method that can mark a position closed, finalize a trade, or
 * touch Mongo/Telegram-CLOSE in any way. It exists ONLY to (a) reduce
 * redundant Binance REST calls during an outage (backoff) and (b) get
 * the operator's attention if an outage persists (one alert, not
 * spam). The real close lifecycle remains gated EXCLUSIVELY on a
 * genuine, positive Binance confirmation (positionAmt === 0) --
 * reconcileV5LiveTradeImpl's own control flow already guarantees this
 * (a caught exception always `return`s before reaching any close
 * logic); this class doesn't change that in any way.
 */
export interface ReconciliationHealthConfig {
  /** Minimum time between two failed-reconciliation attempts for the
   *  SAME signal before another is allowed -- reduces hammering the
   *  Binance REST API during an outage. Correctness is unaffected
   *  either way (a skipped tick just means "try again very soon"). */
  backoffMs: number;
  /** How long a continuous failure episode (no successful
   *  reconciliation at all, for this signal) must persist before ONE
   *  critical Telegram alert fires. */
  alertThresholdMs: number;
}

const DEFAULT_CONFIG: ReconciliationHealthConfig = {
  backoffMs: 5_000,
  alertThresholdMs: 5 * 60_000,
};

interface FailureEpisode {
  firstFailureTs: number;
  lastAttemptTs: number;
  alertSent: boolean;
}

export class ReconciliationHealthTracker {
  private readonly episodes = new Map<string, FailureEpisode>();
  private readonly cfg: ReconciliationHealthConfig;

  constructor(cfg: Partial<ReconciliationHealthConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  /** True if a retry attempt for `key` should be SKIPPED right now
   *  (still within the backoff window since the last failed attempt).
   *  False if there's no ongoing failure episode, or the backoff
   *  window has elapsed. */
  shouldSkipRetry(key: string, now: number): boolean {
    const episode = this.episodes.get(key);
    if (!episode) return false;
    return now - episode.lastAttemptTs < this.cfg.backoffMs;
  }

  /** Call exactly once per FAILED reconciliation attempt. Returns
   *  true the FIRST time this failure episode crosses the alert
   *  threshold (caller should send the one critical alert then) --
   *  false every other time (including every subsequent failed
   *  attempt in the same still-ongoing episode -- never re-alerts). */
  recordFailure(key: string, now: number): boolean {
    const existing = this.episodes.get(key);
    if (!existing) {
      this.episodes.set(key, { firstFailureTs: now, lastAttemptTs: now, alertSent: false });
      return false;
    }
    existing.lastAttemptTs = now;
    if (!existing.alertSent && now - existing.firstFailureTs >= this.cfg.alertThresholdMs) {
      existing.alertSent = true;
      return true;
    }
    return false;
  }

  /** Call exactly once per SUCCESSFUL reconciliation attempt
   *  (regardless of whether the position turned out to still be open
   *  or closed -- "successful" means the Binance API call itself
   *  worked). Clears all failure/backoff/alert state for `key`.
   *  Returns true if there WAS an ongoing failure episode that just
   *  recovered (so the caller can log the recovery) -- false if
   *  reconciliation was already healthy (no episode existed), so
   *  healthy ticks never produce log noise. */
  recordSuccess(key: string): boolean {
    const hadEpisode = this.episodes.has(key);
    this.episodes.delete(key);
    return hadEpisode;
  }

  /** Explicit cleanup when a signal is no longer tracked at all (e.g.
   *  the trade closed) -- prevents unbounded memory growth from
   *  signalIds that are gone for reasons other than a recorded
   *  success (defensive; recordSuccess already clears the common
   *  path). Idempotent, safe no-op if nothing was tracked. */
  clear(key: string): void {
    this.episodes.delete(key);
  }
}
