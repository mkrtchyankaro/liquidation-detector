export interface SymbolConfig {
  symbol: string;
  /** Optional price precision override; will be fetched from exchangeInfo otherwise. */
  pricePrecision?: number;
  /** Optional quantity precision override. */
  quantityPrecision?: number;
  /** Optional min notional (USDT). */
  minNotional?: number;
}

export function loadSymbolsConfig(): SymbolConfig[] {
  const raw = process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT';
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((symbol) => ({ symbol }));
}
