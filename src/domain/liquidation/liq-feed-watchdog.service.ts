import type { Logger } from "pino";

/**
 * LiqFeedWatchdogService — monitors forceOrder event freshness.
 *
 * Why it exists:
 * Binance's forceOrder WebSocket can stop delivering events while the TCP
 * connection stays alive (silent disconnect). Without external monitoring,
 * the bot continues logging cached stats and the operator only notices
 * after hours/days of missing signals.
 *
 * Behaviour:
 *   - Call recordEvent() from the liquidation handler on every forceOrder.
 *   - Every 60s the watchdog checks time-since-last-event.
 *   - WARN_THRESHOLD_MS (default 30 min) → WARN log + Telegram alert.
 *   - ALERT_THRESHOLD_MS (default 60 min) → ERROR log + escalated alert.
 *   - On recovery, logs an INFO line and resets latched flags.
 *
 * No auto-restart by default (risk during active trades). To enable
 * pm2-driven auto-restart, uncomment the `process.exit(1)` in checkOnce().
 */

const CHECK_INTERVAL_MS = 60_000;
const WARN_THRESHOLD_MS = 30 * 60_000;
const ALERT_THRESHOLD_MS = 60 * 60_000;
const GRACE_PERIOD_MS = 5 * 60_000;

interface MinimalTelegram {
  sendMessage: (text: string) => Promise<unknown>;
}

export class LiqFeedWatchdogService {
  private lastEventTs: number = 0;
  private lastEventSymbol: string = "";
  private startedAt: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private warnLogged: boolean = false;
  private alertLogged: boolean = false;
  private totalEvents: number = 0;

  constructor(
    private readonly logger: Logger,
    private readonly telegram: MinimalTelegram | null = null,
  ) {}

  /** Call this from the forceOrder event handler on every liquidation. */
  recordEvent(symbol: string): void {
    this.lastEventTs = Date.now();
    this.lastEventSymbol = symbol;
    this.totalEvents += 1;

    if (this.warnLogged || this.alertLogged) {
      const wasOut = this.alertLogged ? "ALERT" : "WARN";
      this.logger.info(
        { mod: "liq-watchdog", symbol, recoveredFrom: wasOut },
        `[liq-watchdog] feed RECOVERED — events flowing again on ${symbol}`,
      );
      this.telegram
        ?.sendMessage(
          `✅ LIQ feed recovered\nFirst event after silence on ${symbol}`,
        )
        .catch(() => undefined);
      this.warnLogged = false;
      this.alertLogged = false;
    }
  }

  start(): void {
    if (this.timer) return;
    const now = Date.now();
    this.startedAt = now;
    this.lastEventTs = now;
    this.timer = setInterval(() => this.checkOnce(), CHECK_INTERVAL_MS);
    this.logger.info(
      {
        mod: "liq-watchdog",
        warnMs: WARN_THRESHOLD_MS,
        alertMs: ALERT_THRESHOLD_MS,
        checkMs: CHECK_INTERVAL_MS,
        graceMs: GRACE_PERIOD_MS,
      },
      "[liq-watchdog] started",
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Diagnostic snapshot — useful for /status command or healthcheck endpoint. */
  status(): {
    lastEventTs: number;
    lastEventSymbol: string;
    sinceLastMs: number;
    totalEvents: number;
    warnLogged: boolean;
    alertLogged: boolean;
  } {
    return {
      lastEventTs: this.lastEventTs,
      lastEventSymbol: this.lastEventSymbol,
      sinceLastMs: Date.now() - this.lastEventTs,
      totalEvents: this.totalEvents,
      warnLogged: this.warnLogged,
      alertLogged: this.alertLogged,
    };
  }

  private checkOnce(): void {
    const now = Date.now();

    // Grace period after startup — don't alert before bot has a chance to warm up.
    if (now - this.startedAt < GRACE_PERIOD_MS) return;

    const sinceLastMs = now - this.lastEventTs;
    const sinceLastMin = Math.floor(sinceLastMs / 60_000);

    if (sinceLastMs >= ALERT_THRESHOLD_MS && !this.alertLogged) {
      this.logger.error(
        { mod: "liq-watchdog", sinceLastMs, totalEvents: this.totalEvents },
        `[liq-watchdog] CRITICAL: no forceOrder events in ${sinceLastMin} min — feed likely DEAD`,
      );
      this.telegram
        ?.sendMessage(
          `🚨 LIQ FEED DEAD\n` +
            `No forceOrder events in ${sinceLastMin} min across all symbols.\n` +
            `Bot likely needs restart:\n` +
            `pm2 restart liquidation-detector`,
        )
        .catch((err) =>
          this.logger.error({ err, mod: "liq-watchdog" }, "tg alert failed"),
        );
      this.alertLogged = true;
      // Uncomment to enable pm2 auto-restart at 60min silence:
      // process.exit(1);
    } else if (sinceLastMs >= WARN_THRESHOLD_MS && !this.warnLogged) {
      this.logger.warn(
        { mod: "liq-watchdog", sinceLastMs, totalEvents: this.totalEvents },
        `[liq-watchdog] WARN: no forceOrder events in ${sinceLastMin} min`,
      );
      this.telegram
        ?.sendMessage(
          `⚠️ LIQ feed quiet\n` +
            `No forceOrder events in ${sinceLastMin} min. May be quiet market or silent disconnect.\n` +
            `Will escalate to CRITICAL at 60 min.`,
        )
        .catch(() => undefined);
      this.warnLogged = true;
    }
  }
}
