import axios from "axios";
import { checkFrame, FRAME_LOOK_MS, H4_MS, type K, type V9FrameInfo } from "./v9-frame-core";

/** Checks one signal against the 4h frame. Throws when Binance cannot be reached. */
export type V9FrameSource = (symbol: string, long: boolean, episodeStart: number, decisionTs: number) => Promise<V9FrameInfo>;

/** Binance public klines (no key): 4h for the frame, 1m for the episode's real low/high (with wicks). */
export function binanceFrameSource(baseURL = process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com"): V9FrameSource {
  const http = axios.create({ baseURL, timeout: 10_000 });
  const klines = async (symbol: string, interval: string, startTime: number, endTime: number): Promise<K[]> => {
    const res = await http.get<Array<[number, string, string, string, string]>>("/fapi/v1/klines", { params: { symbol, interval, startTime, endTime, limit: 1500 } });
    return res.data.map((k) => ({ ts: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) }));
  };
  return async (symbol, long, episodeStart, decisionTs) => {
    const c4 = await klines(symbol, "4h", episodeStart - FRAME_LOOK_MS - H4_MS, episodeStart);
    // an episode lasts hours; 1500 minutes (25h) is plenty -- the start of a longer one is still the extreme's side
    const m1 = await klines(symbol, "1m", Math.max(episodeStart, decisionTs - 1499 * 60_000), decisionTs);
    return checkFrame(c4, m1, long, episodeStart, decisionTs);
  };
}
