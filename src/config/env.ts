/** Environment settings (.env). Everything about users/trading lives in users.config.json. */
export interface EnvConfig {
  mongoUri: string;
  mongoDb: string;
  symbols: string[];
  usersConfigPath: string;
}

export function loadEnv(): EnvConfig {
  const mongoUri = process.env.MONGO_URI ?? "";
  if (!mongoUri) throw new Error("MONGO_URI is not set (.env)");
  const symbols = (process.env.SYMBOLS ?? "BTCUSDT,ETHUSDT").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) throw new Error("SYMBOLS is empty (.env)");
  return {
    mongoUri,
    mongoDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
    symbols,
    usersConfigPath: process.env.USERS_CONFIG_PATH ?? `${process.cwd()}/users.config.json`,
  };
}
