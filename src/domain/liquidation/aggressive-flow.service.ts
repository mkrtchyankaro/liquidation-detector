/**
 * AggressiveFlowService — Phase 2 (May 2026).
 *
 * Tracks taker (aggressive) flow per symbol over a short rolling window
 * via a 30 × 1-second ring buffer. Pure data-collection service —
 * decisions live in V3.
 *
 * Why this exists
 * ─────────────────────────────────────────────────────────────────────
 * V3's cascade-exhaustion gate (Phase 1) waits for either failed-extension
 * or 60s of freshness before allowing entry. Real cascades that have been
 * absorbed often resolve faster than 60s — aggressive flow into a wall of
 * limit liquidity stops moving price almost immediately. Phase 2 detects
 * that pattern and lets the gate shortcut from "freshness-not-met (60s)"
 * to "absorption-confirmed" PASS at ~30s.
 *
 * Data model
 * ─────────────────────────────────────────────────────────────────────
 * For every Binance aggTrade the service records:
 *   - symbol
 *   - quoteQty (USD value of the trade)
 *   - aggressor side (BUY = buyer was taker, SELL = seller was taker)
 *   - 1-second bucket the trade falls into
 *
 * State is held in a 30-element ring keyed by `(bucketStartMs / 1000) %
 * 30`. When a new trade arrives in a slot whose stamp does not match the
 * expected bucketStartMs, the slot is treated as empty (stale ring
 * collision from > 30s ago). This makes pruning automatic — no timer,
 * no sweep, no cleanup pass.
 *
 * Memory bounded ~1.2 KB per symbol regardless of trade rate. CPU per
 * ingest is O(1). CPU per read is O(30) — fixed, not data-dependent.
 *
 * Lifecycle
 * ─────────────────────────────────────────────────────────────────────
 * Stateless service — no timer, no async work, no I/O. Fed by
 * `ws.on('aggTrade', ...)` in app.ts. Consumed by V3 via
 * `getRecentFlow(symbol, lookbackMs)` from inside cascadeExhaustionGate.
 *
 * Restart loses 30s of data. The service refills naturally as new
 * aggTrades stream in. V3's gate falls back to Phase 1 behavior while
 * data is missing (absorbing=null → no shortcut).
 *
 * What this service does NOT do
 * ─────────────────────────────────────────────────────────────────────
 * - No CVD beyond the 30s window
 * - No statistics, no baselines, no calibration
 * - No per-symbol thresholds (absorption thresholding is V3's
 *   responsibility — this service just exposes the raw flow)
 * - No decisions, no log markers (V3 logs at gate-evaluation time)
 * - No persistence — RAM only
 */

import type { Trade } from "../../shared/common.types";
import { childLogger } from "../../infrastructure/logging/logger";

const log = childLogger({ mod: "agg-flow" });

/** Number of 1-second slots in the ring. Sep 15 2026 (Karo),
 *  operator-requested extension: widened from 30 (30s) to 300 (5
 *  minutes) so getRecentFlow() can serve the liquidation-snapshot
 *  enrichment's 10s/30s/1m/2m/3m/5m taker-flow windows from this SAME
 *  ring, without a second data structure. Existing callers (V3's
 *  cascade-exhaustion gate, which only ever requests 30_000ms) are
 *  unaffected -- they simply now read from a larger ring that still
 *  contains their own 30s window intact. Memory cost at 300 slots is
 *  still trivially small (~12KB/symbol worst case, same order of
 *  magnitude class as OiTrackerService's/FundingStatsService's own
 *  retention). */
const RING_SIZE = 300;

/** One 1-second bucket in the ring. */
interface FlowBucket {
  /** Floor(ts / 1000) * 1000 — bucket boundary. Used as the freshness
   *  key: a slot with a stale startMs is treated as empty by readers. */
  startMs: number;
  buyUsd: number;
  sellUsd: number;
  buyCount: number;
  sellCount: number;
}

/** Per-symbol state. */
interface SymbolFlowState {
  /** Fixed-size ring. Slots may be undefined until first write. */
  buckets: Array<FlowBucket | undefined>;
  /** Timestamp of the most recent trade ingested for this symbol. Used
   *  by `hasFreshData` so callers can detect WS gaps and degrade
   *  gracefully (treat absorption as null rather than zero). */
  latestTradeMs: number;
}

/** Aug 21 2026, operator-requested (Karo) — MARKET BASELINE shadow
 *  telemetry. Retention window for the longer-horizon taker-volume
 *  baseline, in MINUTES (not the 30 SECONDS of RING_SIZE above). 240
 *  minutes = 4 hours at 1-minute buckets — same order of magnitude as
 *  LiquidationStatsService's/OiTrackerService's retention windows for
 *  consistency across the new market-baseline telemetry. */
const TAKER_BASELINE_MAX_MINUTES = 240;

interface TakerVolumeMinuteBucket {
  startMs: number;
  buyUsd: number;
  sellUsd: number;
}

interface TakerBaselineSymbolState {
  /** Oldest-first, capped at TAKER_BASELINE_MAX_MINUTES sealed
   *  buckets. */
  sealedMinutes: TakerVolumeMinuteBucket[];
  current: TakerVolumeMinuteBucket | null;
}

/** Snapshot returned by `getRecentFlow`. */
export interface FlowSnapshot {
  /** Sum of taker-buy quoteQty (USD) across the lookback window. */
  buyUsd: number;
  /** Sum of taker-sell quoteQty (USD) across the lookback window. */
  sellUsd: number;
  buyCount: number;
  sellCount: number;
  /** Timestamp of the most recent ingested trade for the symbol (across
   *  all time, not just the window). */
  latestTradeMs: number;
  /** now - latestTradeMs. Callers use this to detect data staleness. */
  ageMs: number;
}

export class AggressiveFlowService {
  private readonly state = new Map<string, SymbolFlowState>();
  /** Aug 21 2026, operator-requested (Karo) — MARKET BASELINE shadow
   *  telemetry. The 30s ring above (RING_SIZE) is intentionally too
   *  short for a "typical taker volume" baseline. This is a SEPARATE,
   *  longer-horizon (minute-bucket, up to TAKER_BASELINE_MAX_MINUTES
   *  retained) structure fed from the exact SAME ingest() call below
   *  — no new Binance subscription, just an additional, coarser-
   *  grained retention alongside the existing fine-grained 30s ring. */
  private readonly baselineState = new Map<string, TakerBaselineSymbolState>();

  constructor() {
    log.info(`[agg-flow] AggressiveFlowService started ringSize=${RING_SIZE}`);
  }

  /** Ingest a single Binance aggTrade. Idempotent against duplicate WS
   *  broadcasts (later writes to the same bucket simply add to the
   *  running sum — duplicates inflate counts but Binance does not
   *  re-broadcast aggTrades under normal operation). Bounded O(1). */
  ingest(trade: Trade): void {
    if (!(trade.quoteQty > 0)) return; // defensive — never happens on real Binance feed

    const ts = trade.timestamp;
    const bucketStartMs = Math.floor(ts / 1000) * 1000;
    const idx = Math.floor(bucketStartMs / 1000) % RING_SIZE;

    let s = this.state.get(trade.symbol);
    if (!s) {
      s = {
        buckets: new Array(RING_SIZE),
        latestTradeMs: 0,
      };
      this.state.set(trade.symbol, s);
    }

    let b = s.buckets[idx];
    if (!b || b.startMs !== bucketStartMs) {
      // Either uninitialized or the slot is stale (last hit > 30s ago).
      // Replace it cleanly — no need to zero stale slots out separately.
      b = {
        startMs: bucketStartMs,
        buyUsd: 0,
        sellUsd: 0,
        buyCount: 0,
        sellCount: 0,
      };
      s.buckets[idx] = b;
    }

    if (trade.aggressor === "BUY") {
      b.buyUsd += trade.quoteQty;
      b.buyCount += 1;
    } else {
      b.sellUsd += trade.quoteQty;
      b.sellCount += 1;
    }

    if (ts > s.latestTradeMs) {
      s.latestTradeMs = ts;
    }

    // MARKET BASELINE shadow telemetry (Aug 21 2026, Karo) — same
    // trade, additionally fed into the longer-horizon minute-bucket
    // structure. Separate from the 30s ring above entirely.
    this.ingestBaseline(trade, ts);
  }

  /** Aug 21 2026, operator-requested (Karo) — feeds the longer-horizon
   *  (minute-bucket) taker-volume baseline. Private; called only from
   *  ingest() above, same trade, same call site — not a second
   *  subscription. */
  private ingestBaseline(trade: Trade, ts: number): void {
    const minuteStartMs = Math.floor(ts / 60_000) * 60_000;
    let bs = this.baselineState.get(trade.symbol);
    if (!bs) {
      bs = { sealedMinutes: [], current: null };
      this.baselineState.set(trade.symbol, bs);
    }
    if (!bs.current || bs.current.startMs !== minuteStartMs) {
      if (bs.current) {
        bs.sealedMinutes.push(bs.current);
        if (bs.sealedMinutes.length > TAKER_BASELINE_MAX_MINUTES) {
          bs.sealedMinutes.shift();
        }
      }
      bs.current = { startMs: minuteStartMs, buyUsd: 0, sellUsd: 0 };
    }
    if (trade.aggressor === "BUY") {
      bs.current.buyUsd += trade.quoteQty;
    } else {
      bs.current.sellUsd += trade.quoteQty;
    }
  }

  /** Rolling MEDIAN of per-minute TOTAL (buy+sell) taker volume, over
   *  the last `windowMinutes` sealed buckets (capped at whatever is
   *  actually retained, up to TAKER_BASELINE_MAX_MINUTES). Returns
   *  null if fewer than 5 sealed minutes exist yet (cold start). */
  getRollingMedianTakerVolume(
    symbol: string,
    windowMinutes: number,
  ): number | null {
    const bs = this.baselineState.get(symbol);
    if (!bs || bs.sealedMinutes.length < 5) return null;
    const n = Math.min(windowMinutes, bs.sealedMinutes.length);
    const start = bs.sealedMinutes.length - n;
    const sums = bs.sealedMinutes.slice(start).map((m) => m.buyUsd + m.sellUsd);
    sums.sort((a, b) => a - b);
    const mid = Math.floor(sums.length / 2);
    return sums.length % 2 === 1
      ? sums[mid]!
      : (sums[mid - 1]! + sums[mid]!) / 2;
  }

  /** Current (in-progress) minute's total taker volume (buy+sell). */
  currentMinuteTakerVolume(symbol: string): number | null {
    const bs = this.baselineState.get(symbol);
    if (!bs || !bs.current) return null;
    return bs.current.buyUsd + bs.current.sellUsd;
  }

  /** Sum aggressive flow for `symbol` over the last `lookbackMs`. Returns
   *  null if the symbol has never been ingested. Stale slots in the ring
   *  (left over from > 30s ago) are filtered by the cutoff check, so
   *  this is safe to call without any prior pruning step.
   *
   *  Lookback is capped at the ring's window — callers requesting more
   *  than 30s of history receive only what the ring holds. */
  getRecentFlow(
    symbol: string,
    lookbackMs: number,
    now: number = Date.now(),
  ): FlowSnapshot | null {
    const s = this.state.get(symbol);
    if (!s) return null;

    const cutoff = now - lookbackMs;
    let buyUsd = 0;
    let sellUsd = 0;
    let buyCount = 0;
    let sellCount = 0;
    for (const b of s.buckets) {
      if (!b) continue;
      if (b.startMs < cutoff) continue; // stale slot or out of window
      if (b.startMs > now) continue; // future bucket (clock skew defensive)
      buyUsd += b.buyUsd;
      sellUsd += b.sellUsd;
      buyCount += b.buyCount;
      sellCount += b.sellCount;
    }

    return {
      buyUsd,
      sellUsd,
      buyCount,
      sellCount,
      latestTradeMs: s.latestTradeMs,
      ageMs: now - s.latestTradeMs,
    };
  }

  /** True iff the symbol has had at least one trade more recently than
   *  `maxStaleMs` ago. Used by V3 to detect WS gaps and degrade
   *  gracefully (return absorbing=null instead of acting on stale data). */
  hasFreshData(
    symbol: string,
    maxStaleMs: number,
    now: number = Date.now(),
  ): boolean {
    const s = this.state.get(symbol);
    if (!s || s.latestTradeMs === 0) return false;
    return now - s.latestTradeMs <= maxStaleMs;
  }
}
