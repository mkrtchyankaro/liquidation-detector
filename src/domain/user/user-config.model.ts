export interface TelegramUserConfig {
  enabled: boolean;
  botToken: string;
  /** Sep 8 2026 (Karo) -- ARRAY, not a single id, matching liqwatch-bot's
   *  own proven TELEGRAM_CHAT_ID pattern exactly (main bot's own .env:
   *  "TELEGRAM_CHAT_ID=1313457310,1317696535" -- every signal already
   *  goes to BOTH ids there). Lets one user's own Telegram delivery
   *  fan out to multiple chats -- e.g. Artak's own config can list his
   *  own chat id AND Karo's chat id, so Artak's signals also reach
   *  Karo, without needing a second "user". */
  chatIds: string[];
}

export interface BinanceUserConfig {
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
  /** Matches liqwatch-bot's own BINANCE_EXECUTION_MODE values exactly. */
  mode: "live" | "shadow";
  /** Sep 8 2026 (Karo) -- kept as a SEPARATE flag from `mode`,
   *  deliberately preserving the original two-key safety design
   *  (BinanceExecutionService.isLiveArmed requires BOTH mode==="live"
   *  AND this===true). A user is only ever truly live-armed if they
   *  explicitly set BOTH -- setting mode="live" alone still results
   *  in shadow behavior, exactly matching how liqwatch-bot's own main
   *  bot has been run (BINANCE_EXECUTION_MODE=live,
   *  BINANCE_ORDER_EXECUTION_ENABLED=false -- confirmed live,
   *  deliberate SHADOW state). Defaults to false if omitted -- the
   *  safe default. */
  orderExecutionEnabled: boolean;
  leverage: number;
  marginMode: "ISOLATED" | "CROSSED";
}

export interface RiskUserConfig {
  riskUsd: number;
  accountBudgetUsd: number;
  dailyLossLimitPct: number;
}

export interface UserConfig {
  /** Already normalized+validated by the time this type is populated
   *  -- see infrastructure/config/users.config.loader.ts and
   *  domain/user/user-id.validator.ts. */
  userId: string;
  enabled: boolean;
  telegram: TelegramUserConfig | null;
  binance: BinanceUserConfig | null;
  risk: RiskUserConfig;
  /** Sep 8 2026 (Karo) -- ported from liqwatch-bot's own V5_BTC_BLOCK
   *  (per-instance env flag there; per-user config field here, same
   *  underlying rule). When true, for THIS user only:
   *    1. BTC's own signal never reaches them at all (no Telegram, no
   *       execution) -- BTC is used purely as a directional filter.
   *    2. Any OTHER symbol's signal is blocked entirely (no Telegram,
   *       no execution) for this user if BTC currently has an active,
   *       unresolved SAME-SIDE setup (btcIntendedSideAtSignalTime on
   *       the global signal === this signal's own side).
   *  Every user (including one with btcBlockEnabled=false, e.g.
   *  "main") still sees the informational "BTC_BLOCK would apply
   *  here: YES/NO" line on every Telegram message regardless -- that
   *  diagnostic is unconditional, baked into the shared formatter
   *  (infrastructure/telegram/signal.formatter.ts), not gated by this
   *  flag at all. This flag ONLY controls whether the block is
   *  actually ENFORCED for this user's own delivery/execution. */
  btcBlockEnabled: boolean;
  /** Sep 8 2026 (Karo) -- per-user directional kill-switch. Both
   *  default to true (nothing disabled) if omitted. Deliberately
   *  implemented at the SIGNAL-DISTRIBUTION level (services/
   *  signal-distributor.ts), NOT inside V5WaveService's own watch-
   *  qualification gate -- V5WaveService is ONE global, shared engine
   *  across every user; gating qualification there would disable that
   *  direction for EVERYONE, including "main" (which must always see
   *  every signal -- its only filter is TP/SL, per explicit operator
   *  instruction). Setting longEnabled=false for one user only stops
   *  THEIR OWN Telegram/execution for LONG signals -- the underlying
   *  global strategy engine, and every other user, are completely
   *  unaffected. Example real use case (operator's own): "tonight
   *  Trump might announce something, I don't want to trade either
   *  direction for a while" -> set BOTH longEnabled=false AND
   *  shortEnabled=false for that one user, temporarily. */
  longEnabled: boolean;
  shortEnabled: boolean;
}
