import type { Liquidation } from '../../shared/common.types';
import type {
  ObservabilityConfig,
  SymbolTier,
} from '../../infrastructure/config/observability.config';
import { percentile } from '../../shared/math';
import { childLogger } from '../../infrastructure/logging/logger';

/**
 * Who got force-closed by this liquidation.
 *
 * Binance forceOrder side conventions:
 *   forceOrder.side = SELL  =>  a LONG position was force-closed
 *   forceOrder.side = BUY   =>  a SHORT position was force-closed
 */
export type LiqVictim = "LONG" | "SHORT";

export interface LiqStatsSnapshot {
  symbol: string;
  tier: SymbolTier;
  /** ≥ minSamplesForPercentiles individual notionals seen. */
  isWarm: boolean;
  /** Cumulative count of liquidations ingested for this symbol. */
  totalSamples: number;
  // Single-event size percentiles (combined across both victims).
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  // Currently-accumulating 1-minute bucket sums.
  current1mLong: number;
  current1mShort: number;
  // Rolling 5-minute sums (last 4 sealed buckets + current).
  rolling5mLong: number;
  rolling5mShort: number;
  // Highest sealed 1m bucket sum in the retained window per side.
  recent1mMaxLong: number;
  recent1mMaxShort: number;
  /** Effective thresholds in use right now (percentile-based once warm, else tier defaults). */
  threshold: {
    largeLiq: number;
    cluster1m: number;
    cluster5m: number;
    source: "percentile" | "tierDefault";
  };
}

/** Lightweight forensic record of a single liquidation, used both for top-event
 *  retention inside MinuteBucket and as the wire shape exposed to the
 *  persistence layer. Keep it identical to TopEvent in the repository to
 *  avoid an extra translation step. */
export interface LiqEventRecord {
  price: number;
  quantity: number;
  quoteQty: number;
  timestamp: number;
}

/** Snapshot of a sealed minute bucket — used by the persistence layer when it
 *  flushes pending minutes to Mongo. */
export interface SealedMinuteSnapshot {
  symbol: string;
  minuteStart: number;
  longSum: number;
  shortSum: number;
  longCount: number;
  shortCount: number;
  longMax: number;
  shortMax: number;
  topLong: LiqEventRecord[];
  topShort: LiqEventRecord[];
}

interface MinuteBucket {
  startMs: number;
  longSum: number;
  shortSum: number;
  longCount: number;
  shortCount: number;
  longMax: number;
  shortMax: number;
  /** Top-N largest LONG-victim events this minute, sorted desc by quoteQty. */
  topLong: LiqEventRecord[];
  /** Top-N largest SHORT-victim events this minute, sorted desc by quoteQty. */
  topShort: LiqEventRecord[];
}

/** A sealed bucket retained until the persistence layer flushes it. */
interface SealedBucket extends MinuteBucket {}

interface SymbolState {
  tier: SymbolTier;
  /** Sealed 1m sums of LONG-victim notional. Index-aligned with bucketsShort. */
  bucketsLong: number[];
  bucketsShort: number[];
  /** Aug 21 2026, operator-requested (Karo) — MARKET BASELINE shadow
   *  telemetry. Sealed 1m EVENT-COUNT buckets, index-aligned with
   *  bucketsLong/bucketsShort above (same push/shift lifecycle, same
   *  cfg.bucket1mCount retention window). The existing bucketsLong/
   *  bucketsShort arrays only ever retained NOTIONAL sums — event
   *  counts were tracked in the current/pendingFlush bucket but never
   *  kept in a rolling window. Added here (not a new service) since
   *  it's the exact same minute-bucket lifecycle already maintained
   *  by ingest() below — zero new Binance requests, ~8 bytes/minute/
   *  symbol additional memory (same order as the existing arrays). */
  bucketsEventCount: number[];
  bucketStarts: number[];
  current: MinuteBucket | null;
  /** Ring buffer of individual liquidation notionals (combined across victims). */
  notionalSamples: number[];
  notionalSampleIdx: number;
  totalSamples: number;
  /** Sealed buckets queued for flush. Populated when ingest() seals a minute,
   *  drained by exportPendingFlushes()/markFlushed(). Capped by the persistence
   *  layer to prevent unbounded growth if Mongo is down. */
  pendingFlush: SealedBucket[];
  /** True once hydrateFromAggregates() has run for this symbol. Prevents the
   *  service from accidentally double-hydrating on reentry. */
  hydrated: boolean;
}

const BUCKET_MS = 60_000;

/**
 * Per-symbol rolling statistics over Binance forceOrder events.
 *
 * Mirrors the design of `RollingMetricsService`:
 *   - Sealed 1-minute buckets answer "is the current minute's cluster sum big?"
 *   - A ring buffer of per-event notionals answers "is this single liquidation big?"
 *
 * All thresholds are RELATIVE: percentile-based once warm, tier-default fallback
 * before warmup. No hardcoded USDT floors anywhere except the cold-start tier
 * defaults in observability.config.ts.
 *
 * This service is observation-only. It reads liquidations and answers queries.
 * It never emits events, never calls into the strategy layer, and never logs
 * outside debug-level "tracking new symbol" messages. The periodic summary
 * lines are emitted by ObservabilityMonitor, not here.
 */
export class LiquidationStatsService {
  private readonly log = childLogger({ mod: "liq-stats" });
  /** Dedicated child logger for the threshold cache so [baseline] log lines
   *  carry their own mod tag and can be greppable independently. */
  private readonly baselineLog = childLogger({ mod: "baseline" });
  private readonly state = new Map<string, SymbolState>();
  private readonly cfg: ObservabilityConfig["liquidationStats"];
  private readonly tierThresholds: ObservabilityConfig["tierThresholds"];
  private readonly tierMap: ObservabilityConfig["tierMap"];
  private readonly defaultTier: SymbolTier;
  /** How many largest events per minute to retain in `current.topLong`/`topShort`.
   *  Set via setTopEventsPerMinute() by the persistence orchestrator at boot.
   *  Defaults to 0 (= no top-event tracking) if persistence is disabled, which
   *  costs nothing. */
  private topEventsPerMinute = 0;

  /**
   * Step G Lite — per-symbol cache for thresholdLargeLiq().
   *
   * Why only this method: cluster1m/cluster5m are rolling-window sums and
   * MUST stay live (caching defeats their semantics). Wall methods return
   * live state, no baseline computation. The single percentile recompute on
   * the notional sample buffer is the only computation that's both
   * "expensive enough to amortize" and "stable enough to cache."
   *
   * Behavior:
   *  - First call → compute, cache, log [baseline] refreshed at INFO
   *  - Subsequent calls within 15min → return cached, log cache-hit at DEBUG
   *  - Calls after 15min → recompute, refresh cache, log [baseline] refreshed
   *
   * NOT invalidated on ingest() — the 15min TTL is the only invalidation.
   * A symbol crossing cold→warm during a cache lifetime will keep returning
   * the cold tier default for up to 15 minutes. Acceptable lag for v1.
   */
  private readonly thresholdLargeLiqCache = new Map<
    string,
    { value: number; computedAt: number }
  >();
  private readonly THRESHOLD_CACHE_TTL_MS = 15 * 60 * 1000;

  constructor(cfg: ObservabilityConfig) {
    this.cfg = cfg.liquidationStats;
    this.tierThresholds = cfg.tierThresholds;
    this.tierMap = cfg.tierMap;
    this.defaultTier = cfg.defaultTier;
  }

  /** Configures top-event retention. Called once at boot by the persistence
   *  orchestrator. Passing 0 disables top-event tracking entirely (zero cost). */
  setTopEventsPerMinute(n: number): void {
    this.topEventsPerMinute = Math.max(0, Math.floor(n));
  }

  // ── Ingest ───────────────────────────────────────────────────────

  ingest(liq: Liquidation): void {
    const s = this.ensure(liq.symbol);
    const now = liq.timestamp;
    const bucketStart = Math.floor(now / BUCKET_MS) * BUCKET_MS;

    if (!s.current || s.current.startMs !== bucketStart) {
      // Seal prior bucket if any
      if (s.current) {
        s.bucketsLong.push(s.current.longSum);
        s.bucketsShort.push(s.current.shortSum);
        s.bucketStarts.push(s.current.startMs);
        s.bucketsEventCount.push(s.current.longCount + s.current.shortCount);
        if (s.bucketsLong.length > this.cfg.bucket1mCount) {
          s.bucketsLong.shift();
          s.bucketsShort.shift();
          s.bucketStarts.shift();
          s.bucketsEventCount.shift();
        }
        // Queue the sealed bucket for the persistence layer (cheap struct copy).
        if (s.current.longCount + s.current.shortCount > 0) {
          s.pendingFlush.push({
            startMs: s.current.startMs,
            longSum: s.current.longSum,
            shortSum: s.current.shortSum,
            longCount: s.current.longCount,
            shortCount: s.current.shortCount,
            longMax: s.current.longMax,
            shortMax: s.current.shortMax,
            topLong: s.current.topLong,
            topShort: s.current.topShort,
          });
        }
      }
      s.current = {
        startMs: bucketStart,
        longSum: 0,
        shortSum: 0,
        longCount: 0,
        shortCount: 0,
        longMax: 0,
        shortMax: 0,
        topLong: [],
        topShort: [],
      };
    }

    const victim = LiquidationStatsService.victimOf(liq);
    const notional = liq.quoteQty;
    if (victim === "LONG") {
      s.current.longSum += notional;
      s.current.longCount += 1;
      if (notional > s.current.longMax) s.current.longMax = notional;
      this.maybeRetainTopEvent(s.current.topLong, liq);
    } else {
      s.current.shortSum += notional;
      s.current.shortCount += 1;
      if (notional > s.current.shortMax) s.current.shortMax = notional;
      this.maybeRetainTopEvent(s.current.topShort, liq);
    }

    if (s.notionalSamples.length < this.cfg.sampleCapacity) {
      s.notionalSamples.push(notional);
    } else {
      s.notionalSamples[s.notionalSampleIdx] = notional;
      s.notionalSampleIdx = (s.notionalSampleIdx + 1) % this.cfg.sampleCapacity;
    }
    s.totalSamples += 1;
  }

  /** Insert `liq` into the per-minute top-N heap if (a) top-N tracking is on
   *  and (b) `liq` is larger than the current smallest retained event.
   *  Maintains `top` sorted desc by quoteQty. */
  private maybeRetainTopEvent(top: LiqEventRecord[], liq: Liquidation): void {
    const N = this.topEventsPerMinute;
    if (N === 0) return;
    const rec: LiqEventRecord = {
      price: liq.price,
      quantity: liq.quantity,
      quoteQty: liq.quoteQty,
      timestamp: liq.timestamp,
    };
    if (top.length < N) {
      top.push(rec);
      top.sort((a, b) => b.quoteQty - a.quoteQty);
      return;
    }
    // top is full; replace smallest if this is bigger
    const smallest = top[N - 1]!;
    if (rec.quoteQty > smallest.quoteQty) {
      top[N - 1] = rec;
      top.sort((a, b) => b.quoteQty - a.quoteQty);
    }
  }

  // ── Status ───────────────────────────────────────────────────────

  isWarm(symbol: string): boolean {
    const s = this.state.get(symbol);
    if (!s) return false;
    return s.notionalSamples.length >= this.cfg.minSamplesForPercentiles;
  }

  tierOf(symbol: string): SymbolTier {
    return this.tierMap[symbol] ?? this.defaultTier;
  }

  getKnownSymbols(): string[] {
    return Array.from(this.state.keys());
  }

  // ── Queries (used by future strategy code; observability-monitor does not call these directly) ──

  /**
   * Percentile of single-event notional. The `victim` parameter is reserved
   * for a future per-victim ring buffer; the current implementation uses a
   * combined buffer because single-event size is structurally the same
   * regardless of which side got hit.
   */
  notionalPercentile(symbol: string, _victim: LiqVictim, p: number): number {
    const s = this.state.get(symbol);
    if (!s || s.notionalSamples.length < this.cfg.minSamplesForPercentiles)
      return 0;
    return percentile(s.notionalSamples, p);
  }

  /** Current in-progress 1m sum on the given victim side. */
  cluster1mNotional(symbol: string, victim: LiqVictim): number {
    const s = this.state.get(symbol);
    if (!s || !s.current) return 0;
    return victim === "LONG" ? s.current.longSum : s.current.shortSum;
  }

  /** Sum across the last 4 sealed 1m buckets + the current bucket. */
  cluster5mNotional(symbol: string, victim: LiqVictim): number {
    const s = this.state.get(symbol);
    if (!s) return 0;
    const arr = victim === "LONG" ? s.bucketsLong : s.bucketsShort;
    let sum =
      victim === "LONG"
        ? (s.current?.longSum ?? 0)
        : (s.current?.shortSum ?? 0);
    const start = Math.max(0, arr.length - 4);
    for (let i = start; i < arr.length; i += 1) sum += arr[i]!;
    return sum;
  }

  /**
   * Largest single notional in the ring buffer. The `victim` and `ms`
   * parameters are placeholders for a future timestamped per-victim store;
   * use the `LiquidationStore` directly when you need strict freshness.
   */
  largestSingleLast(symbol: string, _victim: LiqVictim, _ms: number): number {
    const s = this.state.get(symbol);
    if (!s || s.notionalSamples.length === 0) return 0;
    let max = 0;
    for (const v of s.notionalSamples) if (v > max) max = v;
    return max;
  }

  // ── Threshold accessors ──────────────────────────────────────────

  thresholdLargeLiq(symbol: string): number {
    const now = Date.now();
    const cached = this.thresholdLargeLiqCache.get(symbol);
    if (cached && now - cached.computedAt < this.THRESHOLD_CACHE_TTL_MS) {
      const ageMin = Math.floor((now - cached.computedAt) / 60_000);
      this.baselineLog.debug(
        `${symbol} cache-hit age=${ageMin}m value=${cached.value}`,
      );
      return cached.value;
    }

    // Cache miss: recompute. Logic preserved exactly as before.
    const tier = this.tierOf(symbol);
    const tierDef = this.tierThresholds[tier].largeLiqUsd;
    const warm = this.isWarm(symbol);
    const samples = this.state.get(symbol)?.notionalSamples.length ?? 0;

    let value: number;
    if (!warm) {
      value = tierDef;
    } else {
      const p95 = this.notionalPercentile(symbol, "LONG", 95);
      value = Math.max(p95, 0.5 * tierDef);
    }

    this.thresholdLargeLiqCache.set(symbol, { value, computedAt: now });

    // Log refresh at INFO. Format: tag the warm-vs-fallback state so we can
    // tell at a glance whether this is real percentile or tier default.
    const prevAgeMin = cached
      ? Math.floor((now - cached.computedAt) / 60_000)
      : -1;
    const ageStr = cached ? `age=${prevAgeMin}m` : `age=initial`;
    const stateStr = warm
      ? `warm samples=${samples}`
      : `cold tierDef=${tierDef}`;
    this.baselineLog.info(
      `${symbol} refreshed ${ageStr} value=${value} (${stateStr})`,
    );

    return value;
  }

  thresholdCluster1m(symbol: string): number {
    const tier = this.tierOf(symbol);
    const tierDef = this.tierThresholds[tier].cluster1mUsd;
    const s = this.state.get(symbol);
    if (!s || s.bucketsLong.length < this.cfg.minSamplesForPercentiles)
      return tierDef;
    const combined = [...s.bucketsLong, ...s.bucketsShort];
    const p95 = percentile(combined, 95);
    return Math.max(p95, 0.5 * tierDef);
  }

  thresholdCluster5m(symbol: string): number {
    const tier = this.tierOf(symbol);
    const tierDef = this.tierThresholds[tier].cluster5mUsd;
    const s = this.state.get(symbol);
    // Need ≥ minSamples + 4 sealed buckets to compute meaningful 5m percentiles.
    if (!s || s.bucketsLong.length < this.cfg.minSamplesForPercentiles + 4)
      return tierDef;
    const sums5m: number[] = [];
    for (let i = 4; i < s.bucketsLong.length; i += 1) {
      let l = 0;
      let sh = 0;
      for (let k = 0; k < 5; k += 1) {
        l += s.bucketsLong[i - k]!;
        sh += s.bucketsShort[i - k]!;
      }
      sums5m.push(l, sh);
    }
    if (sums5m.length === 0) return tierDef;
    const p95 = percentile(sums5m, 95);
    return Math.max(p95, 0.5 * tierDef);
  }

  // ── Snapshot for the monitor ─────────────────────────────────────

  // ── MARKET BASELINE shadow telemetry (Aug 21 2026, operator-
  // requested, Karo) ────────────────────────────────────────────
  // Rolling-median helpers for "how abnormal is THIS signal relative
  // to the market immediately before it" telemetry. NOT used by any
  // trading decision — see V3's [V3_MARKET_BASELINE_SHADOW] log,
  // which is the sole consumer.

  /** Rolling MEDIAN of per-minute total (long+short) liquidation
   *  notional, over the last `windowMinutes` sealed buckets (capped
   *  by however many are actually retained — cfg.bucket1mCount).
   *  Returns null if fewer than 4 sealed buckets exist yet (too
   *  noisy/undefined a median with <4 points). */
  rollingMedianLiqNotionalPerMin(
    symbol: string,
    windowMinutes: number,
  ): number | null {
    const s = this.state.get(symbol);
    if (!s || s.bucketsLong.length < 4) return null;
    const n = Math.min(windowMinutes, s.bucketsLong.length);
    const start = s.bucketsLong.length - n;
    const sums: number[] = [];
    for (let i = start; i < s.bucketsLong.length; i += 1) {
      sums.push(s.bucketsLong[i]! + s.bucketsShort[i]!);
    }
    return percentile(sums, 50);
  }

  /** Rolling MEDIAN of per-minute liquidation EVENT COUNT (long+short
   *  combined), over the last `windowMinutes` sealed buckets. Returns
   *  null under the same cold-start condition as
   *  rollingMedianLiqNotionalPerMin(). */
  rollingMedianEventCountPerMin(
    symbol: string,
    windowMinutes: number,
  ): number | null {
    const s = this.state.get(symbol);
    if (!s || s.bucketsEventCount.length < 4) return null;
    const n = Math.min(windowMinutes, s.bucketsEventCount.length);
    const start = s.bucketsEventCount.length - n;
    const counts = s.bucketsEventCount.slice(start);
    return percentile(counts, 50);
  }

  /** Current (in-progress, not-yet-sealed) minute's total liquidation
   *  notional (long+short). Paired with rollingMedianLiqNotionalPerMin
   *  by the caller to compute a normalized ratio. */
  currentMinuteLiqNotional(symbol: string): number | null {
    const s = this.state.get(symbol);
    if (!s || !s.current) return null;
    return s.current.longSum + s.current.shortSum;
  }

  /** Current (in-progress) minute's liquidation event count. */
  currentMinuteEventCount(symbol: string): number | null {
    const s = this.state.get(symbol);
    if (!s || !s.current) return null;
    return s.current.longCount + s.current.shortCount;
  }

  snapshot(symbol: string): LiqStatsSnapshot {
    const tier = this.tierOf(symbol);
    const s = this.state.get(symbol);
    const warm = this.isWarm(symbol);
    const samples = s?.notionalSamples ?? [];
    const p = (q: number): number => (warm ? percentile(samples, q) : 0);

    let recent1mMaxLong = 0;
    let recent1mMaxShort = 0;
    let rolling5mLong = s?.current?.longSum ?? 0;
    let rolling5mShort = s?.current?.shortSum ?? 0;
    if (s) {
      for (const v of s.bucketsLong)
        if (v > recent1mMaxLong) recent1mMaxLong = v;
      for (const v of s.bucketsShort)
        if (v > recent1mMaxShort) recent1mMaxShort = v;
      const start = Math.max(0, s.bucketsLong.length - 4);
      for (let i = start; i < s.bucketsLong.length; i += 1) {
        rolling5mLong += s.bucketsLong[i]!;
        rolling5mShort += s.bucketsShort[i]!;
      }
    }

    return {
      symbol,
      tier,
      isWarm: warm,
      totalSamples: s?.totalSamples ?? 0,
      p50: p(50),
      p75: p(75),
      p90: p(90),
      p95: p(95),
      p99: p(99),
      current1mLong: s?.current?.longSum ?? 0,
      current1mShort: s?.current?.shortSum ?? 0,
      rolling5mLong,
      rolling5mShort,
      recent1mMaxLong,
      recent1mMaxShort,
      threshold: {
        largeLiq: this.thresholdLargeLiq(symbol),
        cluster1m: this.thresholdCluster1m(symbol),
        cluster5m: this.thresholdCluster5m(symbol),
        source: warm ? "percentile" : "tierDefault",
      },
    };
  }

  // ── Internals ────────────────────────────────────────────────────

  private static victimOf(liq: Liquidation): LiqVictim {
    return liq.side === "SELL" ? "LONG" : "SHORT";
  }

  private ensure(symbol: string): SymbolState {
    let s = this.state.get(symbol);
    if (!s) {
      s = {
        tier: this.tierOf(symbol),
        bucketsLong: [],
        bucketsShort: [],
        bucketStarts: [],
        bucketsEventCount: [],
        current: null,
        notionalSamples: [],
        notionalSampleIdx: 0,
        totalSamples: 0,
        pendingFlush: [],
        hydrated: false,
      };
      this.state.set(symbol, s);
      this.log.debug({ symbol, tier: s.tier }, "tracking new symbol");
    }
    return s;
  }

  // ── Persistence hooks (Step E) ───────────────────────────────────
  // These methods are the ONLY surface used by the persistence orchestrator.
  // The rest of the service stays observation-pure.

  /**
   * Snapshot all sealed minutes that have not been flushed yet, across all
   * tracked symbols. Returns serializable docs ready for upsert to Mongo.
   * Does NOT mutate state — call markFlushed() for each (symbol, minuteStart)
   * after a successful upsert to drop the bucket from the pending queue.
   */
  exportPendingFlushes(): SealedMinuteSnapshot[] {
    const out: SealedMinuteSnapshot[] = [];
    for (const [symbol, s] of this.state) {
      for (const b of s.pendingFlush) {
        out.push({
          symbol,
          minuteStart: b.startMs,
          longSum: b.longSum,
          shortSum: b.shortSum,
          longCount: b.longCount,
          shortCount: b.shortCount,
          longMax: b.longMax,
          shortMax: b.shortMax,
          // shallow-copy the top arrays so caller mutations don't bleed back
          topLong: b.topLong.slice(),
          topShort: b.topShort.slice(),
        });
      }
    }
    return out;
  }

  /** Drops a sealed bucket from the pending-flush queue after Mongo confirmed
   *  the upsert. Idempotent — extra calls for unknown minutes are no-ops. */
  markFlushed(symbol: string, minuteStart: number): void {
    const s = this.state.get(symbol);
    if (!s) return;
    s.pendingFlush = s.pendingFlush.filter((b) => b.startMs !== minuteStart);
  }

  /** Aug 23 2026, operator-requested (Karo) — read-only export of the
   *  ROLLING-WINDOW percentile state (the exact fields thresholdLargeLiq()
   *  actually reads: notionalSamples, bucketsLong/Short/EventCount,
   *  bucketStarts) for every tracked symbol. Deliberately excludes
   *  `current` (the in-progress, not-yet-sealed minute — stays
   *  per-process, correctly, since it's at most ~1 minute stale by the
   *  time it seals into the arrays below anyway) and `pendingFlush`
   *  (writer-specific Mongo-flush queue, meaningless on a reader).
   *  Used by the periodic background snapshot writer in app.ts (see
   *  liquidation-stats-snapshot.ts) — proven root cause (Aug 23 2026
   *  investigation, 29-vs-12-watches discrepancy) of MAIN and FRIEND
   *  independently computing different p95/large-liq thresholds from
   *  their own live WebSocket streams, causing them to create
   *  genuinely different WATCHes for the identical real-world
   *  liquidation stream. */
  exportRollingWindowState(): Map<
    string,
    {
      notionalSamples: number[];
      notionalSampleIdx: number;
      totalSamples: number;
      bucketsLong: number[];
      bucketsShort: number[];
      bucketsEventCount: number[];
      bucketStarts: number[];
    }
  > {
    const out = new Map<
      string,
      {
        notionalSamples: number[];
        notionalSampleIdx: number;
        totalSamples: number;
        bucketsLong: number[];
        bucketsShort: number[];
        bucketsEventCount: number[];
        bucketStarts: number[];
      }
    >();
    for (const [symbol, s] of this.state) {
      out.set(symbol, {
        notionalSamples: s.notionalSamples.slice(),
        notionalSampleIdx: s.notionalSampleIdx,
        totalSamples: s.totalSamples,
        bucketsLong: s.bucketsLong.slice(),
        bucketsShort: s.bucketsShort.slice(),
        bucketsEventCount: s.bucketsEventCount.slice(),
        bucketStarts: s.bucketStarts.slice(),
      });
    }
    return out;
  }

  /** Aug 23 2026, operator-requested (Karo) — REPLACES (never appends
   *  to) each symbol's rolling-window percentile fields with the given
   *  data. Only `current`/`pendingFlush` are left untouched (see
   *  exportRollingWindowState()'s doc comment for why). Used two ways:
   *    - MAIN (writer): not used — MAIN's own live ingestion is the
   *      canonical source.
   *    - FRIEND (reader): called once at boot AND on every periodic
   *      reload thereafter (see app.ts), replacing FRIEND's copy with
   *      MAIN's latest shared snapshot, so both bots' thresholdLargeLiq()
   *      converge on the SAME threshold for the SAME symbol, closing
   *      the watch-creation divergence this was built to fix. */
  hydrateRollingWindowState(
    data: ReadonlyMap<
      string,
      {
        notionalSamples: number[];
        notionalSampleIdx: number;
        totalSamples: number;
        bucketsLong: number[];
        bucketsShort: number[];
        bucketsEventCount: number[];
        bucketStarts: number[];
      }
    >,
  ): void {
    for (const [symbol, d] of data) {
      const s = this.ensure(symbol);
      s.notionalSamples = d.notionalSamples.slice();
      s.notionalSampleIdx = d.notionalSampleIdx;
      s.totalSamples = d.totalSamples;
      s.bucketsLong = d.bucketsLong.slice();
      s.bucketsShort = d.bucketsShort.slice();
      s.bucketsEventCount = d.bucketsEventCount.slice();
      s.bucketStarts = d.bucketStarts.slice();
      s.hydrated = true;
      // Aug 23 2026 (Karo) -- clear the cached threshold so the next
      // thresholdLargeLiq() call recomputes from this fresh data
      // instead of serving a stale value for up to
      // THRESHOLD_CACHE_TTL_MS (15 min).
      this.thresholdLargeLiqCache.delete(symbol);
    }
  }

  /**
   * Hydrate this symbol's percentile state from historical Mongo aggregates.
   * Idempotent per symbol (a second call is a no-op).
   *
   * Hydration strategy:
   *   - bucketsLong / bucketsShort are filled from each doc's longSum/shortSum,
   *     in chronological order, capped at this.cfg.bucket1mCount.
   *   - notionalSamples ring is seeded with each doc's topLong + topShort
   *     records. This biases the ring toward outliers (which is exactly what
   *     drives p95/p99 thresholds — see service-level docstring).
   *   - totalSamples is set to the sum of (longCount + shortCount) across all
   *     docs so cold/warm transition reflects historical activity.
   *
   * Crucially: this method DOES NOT touch s.current. Live ingestion picks up
   * the current minute from scratch, which is correct: we have zero coverage
   * of partial minutes that occurred while the bot was offline.
   */
  hydrateFromAggregates(
    symbol: string,
    docs: ReadonlyArray<{
      minuteStart: number;
      longSum: number;
      shortSum: number;
      longCount: number;
      shortCount: number;
      topLong: ReadonlyArray<LiqEventRecord>;
      topShort: ReadonlyArray<LiqEventRecord>;
    }>,
  ): { samples: number; bucketsLoaded: number } {
    const s = this.ensure(symbol);
    if (s.hydrated)
      return {
        samples: s.notionalSamples.length,
        bucketsLoaded: s.bucketsLong.length,
      };

    const cap = this.cfg.bucket1mCount;
    const ringCap = this.cfg.sampleCapacity;
    let totalCount = 0;

    // docs are passed in chronological order; we want only the most recent
    // `cap` to fill bucketsLong/Short.
    const startIdx = Math.max(0, docs.length - cap);
    for (let i = startIdx; i < docs.length; i += 1) {
      const d = docs[i]!;
      s.bucketsLong.push(d.longSum);
      s.bucketsShort.push(d.shortSum);
      s.bucketStarts.push(d.minuteStart);
      s.bucketsEventCount.push(d.longCount + d.shortCount);
    }

    // Seed notionalSamples from ALL top events across ALL docs (not just the
    // most recent `cap` docs) so percentile thresholds reflect the full
    // warmupHours window even if it exceeds bucket1mCount minutes.
    for (const d of docs) {
      totalCount += d.longCount + d.shortCount;
      for (const e of d.topLong) {
        if (s.notionalSamples.length < ringCap) {
          s.notionalSamples.push(e.quoteQty);
        } else {
          s.notionalSamples[s.notionalSampleIdx] = e.quoteQty;
          s.notionalSampleIdx = (s.notionalSampleIdx + 1) % ringCap;
        }
      }
      for (const e of d.topShort) {
        if (s.notionalSamples.length < ringCap) {
          s.notionalSamples.push(e.quoteQty);
        } else {
          s.notionalSamples[s.notionalSampleIdx] = e.quoteQty;
          s.notionalSampleIdx = (s.notionalSampleIdx + 1) % ringCap;
        }
      }
    }

    s.totalSamples = totalCount;
    s.hydrated = true;
    return {
      samples: s.notionalSamples.length,
      bucketsLoaded: s.bucketsLong.length,
    };
  }
}
