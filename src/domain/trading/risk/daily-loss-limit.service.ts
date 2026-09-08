import { childLogger } from '../../../infrastructure/logging/logger';

const log = childLogger({ mod: "daily-loss-limit" });

/**
 * Sep 7 2026, operator-approved (Karo) -- SHARED daily-loss-limit
 * tracker, extracted from SimpleLiquidationService's own
 * DAILY_LOSS_LIMIT design (Aug 2026) so V5's own real-execution path
 * can participate in the SAME, single, real-account safety limit --
 * per explicit operator instruction: "one real account, one real
 * budget, shared between whatever strategies trade it, not two
 * independent $500 allowances."
 *
 * IDENTICAL semantics to the original V3-only implementation (same
 * env vars, same formula, same UTC-day rollover, same DB-backed
 * startup recomputation) -- this is a refactor-by-extraction, not a
 * behavior change for V3. V3's own SimpleLiquidationService continues
 * to hold its OWN private dailyPnlUsd/dailyPnlDateLocal fields
 * completely UNTOUCHED (zero risk to its already-tested code) --
 * this class is used ADDITIVELY: V5 gets its OWN instance, and BOTH
 * V3's own gate-check and V5's own gate-check are extended (via a
 * small, additive cross-awareness callback -- see app.ts's own wiring)
 * to also see the OTHER strategy's contribution, so the combined
 * total is what actually gates entries on both sides.
 */
export class DailyLossLimitTracker {
  private dailyPnlUsd = 0;
  private dailyPnlDateLocal: string | null = null;
  private blockedCount = 0;

  private readonly accountBudgetUsd: number;
  private readonly dailyLossLimitPct: number;

  /** Sep 8 2026 (Karo), multi-user adaptation -- REQUIRED, not a
   *  stylistic cleanup: the original liqwatch-bot version read
   *  process.env.V3_ACCOUNT_BUDGET_USD/V3_DAILY_LOSS_LIMIT_PCT
   *  directly, which is architecturally wrong for multiple users (all
   *  users would silently share ONE budget/pct from one set of env
   *  vars). accountBudgetUsd/dailyLossLimitPct are now explicit
   *  constructor parameters (each user's own UserConfig.risk),
   *  defaulting to the EXACT SAME fallback values (500 / 5) the
   *  original used, if omitted. All comparison/accumulation logic
   *  below this point is otherwise UNCHANGED. */
  constructor(
    private readonly label: string,
    accountBudgetUsd?: number,
    dailyLossLimitPct?: number,
  ) {
    this.accountBudgetUsd = Number.isFinite(accountBudgetUsd) && (accountBudgetUsd as number) > 0 ? (accountBudgetUsd as number) : 500;
    this.dailyLossLimitPct = Number.isFinite(dailyLossLimitPct) && (dailyLossLimitPct as number) > 0 ? (dailyLossLimitPct as number) : 5;
  }

  /** Always negative (or zero) -- the $ floor for cumulative NET
   *  realized P&L today. Once dailyPnlUsd (this tracker's own,
   *  PLUS whatever the caller adds via the cross-awareness callback)
   *  drops to or below this, all new entries are blocked. */
  getLossLimitUsd(): number {
    return -(this.accountBudgetUsd * this.dailyLossLimitPct) / 100;
  }

  private getUtcDateString(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
  }

  /** Idempotent -- safe to call on every check/update regardless of
   *  whether the UTC day actually changed. */
  private checkAndResetIfNewDay(ts: number): void {
    const today = this.getUtcDateString(ts);
    if (this.dailyPnlDateLocal !== today) {
      if (this.dailyPnlDateLocal !== null) {
        log.info(
          `[DAILY_PNL_RESET] label=${this.label} previousDate=${this.dailyPnlDateLocal} ` +
            `previousTotal=${this.dailyPnlUsd.toFixed(2)} newDate=${today}`,
        );
      }
      this.dailyPnlDateLocal = today;
      this.dailyPnlUsd = 0;
    }
  }

  /** Call ONCE at startup, before any entry can fire, to recompute
   *  today's cumulative realized P&L from persistence -- without this,
   *  a restart would silently reset the counter to 0 even if the
   *  account had already hit the limit moments before. */
  async initializeFromDb(sumClosedNetPnlInRange: (startMs: number, endMs: number) => Promise<{ total: number; tradeCount: number }>): Promise<void> {
    const now = Date.now();
    const dateStr = this.getUtcDateString(now);
    const startMs = Date.parse(`${dateStr}T00:00:00.000Z`);
    const endMs = startMs + 24 * 3600 * 1000;
    try {
      const { total, tradeCount } = await sumClosedNetPnlInRange(startMs, endMs);
      this.dailyPnlDateLocal = dateStr;
      this.dailyPnlUsd = total;
      log.info(
        `[DAILY_PNL_INIT_FROM_DB] label=${this.label} date=${dateStr} tradesFoundToday=${tradeCount} ` +
          `recomputedTotalUsd=${total.toFixed(2)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        `[DAILY_PNL_INIT_FROM_DB_FAILED] label=${this.label} date=${dateStr} err=${msg} ` +
          `— starting dailyPnlUsd at 0, NOT blocked. Check manually if today's real P&L might already be near the limit.`,
      );
      this.dailyPnlDateLocal = dateStr;
      this.dailyPnlUsd = 0;
    }
  }

  /** This tracker's OWN running total (its own strategy's trades
   *  only) -- the cross-awareness callback wiring in app.ts is what
   *  combines this with the OTHER strategy's own tracker to gate on
   *  the true combined total. */
  getOwnDailyPnlUsd(ts: number): number {
    this.checkAndResetIfNewDay(ts);
    return this.dailyPnlUsd;
  }

  /** True if THIS tracker's own total ALONE already exceeds the
   *  limit. Callers that need to account for another strategy's
   *  contribution too must add it themselves before comparing against
   *  getLossLimitUsd() -- see app.ts's own combined check at both
   *  V3's and V5's entry-gate sites. */
  isOwnBlocked(ts: number): boolean {
    return this.getOwnDailyPnlUsd(ts) <= this.getLossLimitUsd();
  }

  recordRealizedPnl(netPnlUsd: number, ts: number): void {
    this.checkAndResetIfNewDay(ts);
    this.dailyPnlUsd += netPnlUsd;
    log.info(
      `[DAILY_PNL] label=${this.label} date=${this.dailyPnlDateLocal} tradePnl=${netPnlUsd.toFixed(2)} ` +
        `runningTotalUsd=${this.dailyPnlUsd.toFixed(2)} limitUsd=${this.getLossLimitUsd().toFixed(2)}`,
    );
    if (this.dailyPnlUsd <= this.getLossLimitUsd()) {
      this.blockedCount++;
      log.warn(
        `[DAILY_LOSS_LIMIT_ENGAGED] label=${this.label} date=${this.dailyPnlDateLocal} ` +
          `runningTotalUsd=${this.dailyPnlUsd.toFixed(2)} limitUsd=${this.getLossLimitUsd().toFixed(2)} ` +
          `— this tracker's own entries blocked until next UTC day`,
      );
    }
  }
}
