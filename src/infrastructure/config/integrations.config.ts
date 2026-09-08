export interface MongoConfig {
  enabled: boolean;
  uri: string;
  db: string;
  /** Collection name for paper-trading signals (strategy-v2 lifecycle). */
  paperSignalsCollection: string;
  /** Aug 23 2026, operator-requested (Karo) — collection name for real
   *  Binance execution records. Was previously HARDCODED to
   *  "execution_records" inside mongo.client.ts, which is a real
   *  safety gap once two bot instances share the same MONGO_DB: their
   *  real trading-execution state would have been silently merged.
   *  Now configurable, same pattern as paperSignalsCollection, so
   *  main/friend can point to the SAME db but keep this collection
   *  bot-specific via MONGO_EXECUTION_RECORDS_COLLECTION. */
  executionRecordsCollection: string;
  /** Sep 7 2026, operator-caught fix (Karo) -- SAME safety gap as
   *  executionRecordsCollection above (see that field's own doc
   *  comment), but for v5_signals -- was HARDCODED inside
   *  mongo.client.ts's own v5Signals() method, meaning MAIN/FRIEND/
   *  BROTHER sharing the same MONGO_DB would have had their V5
   *  signals silently merged into ONE shared collection. Now
   *  configurable via MONGO_V5_SIGNALS_COLLECTION, same pattern. */
  v5SignalsCollection: string;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  /** One or more chat IDs. Env var `TELEGRAM_CHAT_ID` accepts a comma-separated list. */
  chatIds: string[];
  /** Parse mode for message formatting. "HTML" leaves our plain text unchanged and lets us emit <b>/<i> if needed later. */
  parseMode: "HTML" | "Markdown" | "MarkdownV2" | "none";
  /** If true, silent messages (no notification sound). */
  disableNotification: boolean;
}

export interface IntegrationsConfig {
  mongo: MongoConfig;
  telegram: TelegramConfig;
}

export function loadIntegrationsConfig(): IntegrationsConfig {
  const mongoUri = process.env.MONGO_URI ?? "";
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatIdsRaw = process.env.TELEGRAM_CHAT_ID ?? "";
  const chatIds = chatIdsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    mongo: {
      enabled: !!mongoUri,
      uri: mongoUri,
      db: process.env.MONGO_DB ?? "liqwatch_bot",
      paperSignalsCollection:
        process.env.MONGO_PAPER_SIGNALS_COLLECTION ?? "paper_signals",
      executionRecordsCollection:
        process.env.MONGO_EXECUTION_RECORDS_COLLECTION ?? "execution_records",
      v5SignalsCollection:
        process.env.MONGO_V5_SIGNALS_COLLECTION ?? "v5_signals",
    },
    telegram: {
      enabled: !!(botToken && chatIds.length > 0),
      botToken,
      chatIds,
      parseMode:
        (process.env.TELEGRAM_PARSE_MODE as TelegramConfig["parseMode"]) ||
        "none",
      disableNotification:
        (process.env.TELEGRAM_SILENT ?? "false").toLowerCase() === "true",
    },
  };
}
