export interface TelegramUserConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
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
}
