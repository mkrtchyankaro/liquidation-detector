import axios, { type AxiosInstance } from "axios";
import type { Db } from "mongodb";
import { D, H, type WCandle, type WallData, type WLiq } from "./wall-engine";

/**
 * V10 · WALL data (Oct 7 2026) -- exactly what the research test used (src/tools/wall-trade-test.ts):
 *   Binance PUBLIC klines (no keys): 1d, 4h, 15m · our liquidations (liq_raw_events: timestamp ms, victim, quoteQty, price)
 * Kept in memory per coin and refreshed incrementally (the last candle is always re-read, it may still have been open).
 * Only what the walls can use is kept (the field is at most 30 days).
 */
export interface WallSource {
  /** the coin's data up to now (the engine itself uses only what was closed / known at its t) */
  data(
    symbol: string,
    now: number,
  ): Promise<WallData & { firstLiqT: number | null }>;
}

/** the walls look back up to 30 days from each hour; after a restart the touch memory is rebuilt from 72 h back -> 34 days */
const KEEP = { "1d": 75 * D, "4h": 45 * D, "15m": 34 * D } as const;
const STEP = { "1d": D, "4h": 4 * H, "15m": 15 * 60_000 } as const;
type Iv = keyof typeof KEEP;
/** liquidations arriving a little late (the stream writes them as they come): re-read this much each time */
const LIQ_OVERLAP_MS = 5 * 60_000;

export class BinanceMongoWallSource implements WallSource {
  private readonly fapi: AxiosInstance;
  private readonly candles = new Map<string, WCandle[]>();
  private readonly liqs = new Map<string, { list: WLiq[]; upTo: number }>();
  private readonly firstLiq = new Map<string, number | null>();

  constructor(
    private readonly getDb: () => Promise<Db | null>,
    baseURL = process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  ) {
    this.fapi = axios.create({ baseURL, timeout: 20_000 });
  }

  private async klines(
    symbol: string,
    iv: Iv,
    now: number,
  ): Promise<WCandle[]> {
    const key = `${symbol}|${iv}`,
      have = this.candles.get(key) ?? [];
    const from = have.length ? have[have.length - 1].t : now - KEEP[iv];
    const fresh: WCandle[] = [];
    for (let s = from; s < now; ) {
      // ask only for what is missing (+2): a small limit costs Binance weight 1 instead of 10
      const limit = Math.min(1500, Math.ceil((now - s) / STEP[iv]) + 2);
      const rows: unknown[][] = (
        await this.fapi.get("/fapi/v1/klines", {
          params: {
            symbol,
            interval: iv,
            startTime: s,
            endTime: now - 1,
            limit,
          },
        })
      ).data;
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows)
        fresh.push({
          t: Number(r[0]),
          o: Number(r[1]),
          h: Number(r[2]),
          l: Number(r[3]),
          c: Number(r[4]),
        });
      s = Number(rows[rows.length - 1][0]) + 1;
      if (rows.length < limit) break;
    }
    const firstNew = fresh.length ? fresh[0].t : Infinity;
    const merged = [...have.filter((c) => c.t < firstNew), ...fresh].filter(
      (c) => c.t >= now - KEEP[iv],
    );
    this.candles.set(key, merged);
    return merged;
  }

  private async liquidations(symbol: string, now: number): Promise<WLiq[]> {
    const db = await this.getDb();
    if (!db) throw new Error("Mongo unavailable");
    const have = this.liqs.get(symbol);
    const cutoff = have ? have.upTo - LIQ_OVERLAP_MS : now - KEEP["15m"];
    const rows = await db
      .collection("liq_raw_events")
      .find({
        symbol,
        victim: { $in: ["LONG", "SHORT"] },
        timestamp: { $gte: cutoff, $lt: now },
      })
      .project({ _id: 0, timestamp: 1, victim: 1, quoteQty: 1, price: 1 })
      .toArray();
    const fresh = rows
      .map((d) => ({
        t: Number(d.timestamp),
        long: d.victim === "LONG",
        usd: Number(d.quoteQty),
        p: Number(d.price),
      }))
      .filter((x) => x.p > 0 && Number.isFinite(x.usd) && Number.isFinite(x.t));
    const list = [
      ...(have?.list ?? []).filter(
        (x) => x.t < cutoff && x.t >= now - KEEP["15m"],
      ),
      ...fresh,
    ].sort((a, b) => a.t - b.t);
    this.liqs.set(symbol, { list, upTo: now });
    return list;
  }

  private async firstLiqT(symbol: string): Promise<number | null> {
    const known = this.firstLiq.get(symbol);
    if (known !== undefined && known !== null) return known; // a coin without any liquidation yet is asked again
    const db = await this.getDb();
    if (!db) throw new Error("Mongo unavailable");
    const r = await db
      .collection("liq_raw_events")
      .find({ symbol })
      .project({ _id: 0, timestamp: 1 })
      .sort({ timestamp: 1 })
      .limit(1)
      .toArray();
    const t = r.length ? Number(r[0].timestamp) : null;
    this.firstLiq.set(symbol, t);
    return t;
  }

  async data(
    symbol: string,
    now: number,
  ): Promise<WallData & { firstLiqT: number | null }> {
    const end = Math.floor(now / H) * H + H; // read up to the end of the current hour (the engine filters by time)
    const [d1, h4, q15] = [
      await this.klines(symbol, "1d", end),
      await this.klines(symbol, "4h", end),
      await this.klines(symbol, "15m", end),
    ];
    const liqs = await this.liquidations(symbol, now);
    return { d1, h4, q15, liqs, firstLiqT: await this.firstLiqT(symbol) };
  }
}
