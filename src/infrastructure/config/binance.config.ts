export interface BinanceConfig {
  restBaseUrl: string;
  wsBaseUrl: string;
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
  /** Server-side recvWindow for signed requests (ms). */
  recvWindowMs: number;
}

const PROD_REST = 'https://fapi.binance.com';
const PROD_WS = 'wss://fstream.binance.com';
const TEST_REST = 'https://testnet.binancefuture.com';
const TEST_WS = 'wss://stream.binancefuture.com';

export function loadBinanceConfig(): BinanceConfig {
  const testnet = (process.env.BINANCE_TESTNET ?? 'false').toLowerCase() === 'true';
  return {
    restBaseUrl: testnet ? TEST_REST : PROD_REST,
    wsBaseUrl: testnet ? TEST_WS : PROD_WS,
    apiKey: process.env.BINANCE_API_KEY ?? '',
    apiSecret: process.env.BINANCE_API_SECRET ?? '',
    testnet,
    recvWindowMs: 5_000,
  };
}

/** Sep 19 2026 (Karo), operator-requested Spot-vs-Futures order-flow
 *  observation -- Binance SPOT's own WebSocket base URL, a completely
 *  separate endpoint/connection from the Futures one above. Reuses
 *  the SAME BINANCE_TESTNET env var for consistency, since the
 *  operator's own testnet/prod choice should apply uniformly. */
const PROD_SPOT_WS = 'wss://stream.binance.com:9443';
const TEST_SPOT_WS = 'wss://testnet.binance.vision';

export function loadBinanceSpotWsConfig(): { wsBaseUrl: string } {
  const testnet = (process.env.BINANCE_TESTNET ?? 'false').toLowerCase() === 'true';
  return { wsBaseUrl: testnet ? TEST_SPOT_WS : PROD_SPOT_WS };
}
