import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import {
  fetchKlines,
  loadRawEvents,
  computeAtrSeries,
  reconstructEpisodesForVariant,
  percentile,
  episodeSummary,
  PRIMARY_VARIANT,
  MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE,
  type Atrs,
  type Episode,
  type Variant,
} from "../src/domain/research/displacement-balanced-core";

/**
 * Sep 16 2026 (Karo), operator-requested. STAGE 1 ONLY: historical
 * DISPLACEMENT_BALANCED episode-size distribution, per symbol. Does
 * NOT touch the PHYSICS model at all -- that is explicitly a separate
 * (Stage 2) research problem, per the operator's own instruction to
 * keep them apart. READ-ONLY research: no writes/updates/deletes
 * anywhere in this file, no production code touched.
 *
 *   npx tsx scripts/research-episode-percentiles.ts --days 30
 *   npx tsx scripts/research-episode-percentiles.ts --symbols BTCUSDT,ETHUSDT --hours 24
 *   npx tsx scripts/research-episode-percentiles.ts --from "2026-08-15 00:00" --to "2026-09-16 00:00"
 *
 * REUSE, NOT DUPLICATION: the DISPLACEMENT_BALANCED state machine
 * itself (reconstructEpisodesForVariant/runStateMachine), its exact
 * configuration (PRIMARY_VARIANT), the ATR series builder, and the
 * kline/event loaders are all imported directly from
 * research-liquidation-episodes.ts -- unchanged, not reimplemented.
 * Only the export shape here is different (per-symbol percentile
 * summaries instead of full episode transition logs).
 *
 * BOUNDARY EPISODES (left/right censoring) -- explained here since
 * the operator asked for the exact handling, not just a claim of
 * correctness:
 *   - A PADDING window (default 6h, --paddingHours) is fetched BEFORE
 *     the requested `from`. The full causal reconstruction runs over
 *     [from - padding, to], so an episode that genuinely started
 *     during the padding period is tracked correctly (its true
 *     extreme, its true USD total) rather than the first liquidation
 *     after `from` being wrongly treated as a fresh episode start.
 *   - Any episode whose OWN startTime falls before the requested
 *     `from` is then EXCLUDED from the percentile set (left-censored)
 *     -- it was needed for correct causal state, but its own start
 *     isn't within the measured window, and a sufficiently long real
 *     episode could in principle still start before the padding
 *     window even begins (padding is a practical, not theoretically
 *     unbounded, safeguard -- stated plainly, not hidden).
 *   - Any episode with endTime === null (still open as of `to`) is
 *     EXCLUDED from the percentile set (right-censored) -- its true
 *     total USD isn't known yet.
 *   - Only episodes with `from <= startTime` AND `endTime !== null`
 *     AND `endTime <= to` count as COMPLETE and enter the percentile
 *     calculation.
 */

const DEFAULT_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
];
const DEFAULT_PADDING_HOURS = 6;

interface CliArgs {
  symbols: string[];
  fromMs: number;
  toMs: number;
  paddingMs: number;
}

function parseUtcDatetime(input: string): number {
  if (input.trim().toLowerCase() === "now") return Date.now();
  let s = input.trim();
  const hasExplicitOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!hasExplicitOffset) s = s + "Z";
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Could not parse datetime: "${input}"`);
  return ms;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const symbolsArg = get("--symbols");
  const symbols = symbolsArg
    ? symbolsArg.split(",").map((s) => s.trim().toUpperCase())
    : DEFAULT_SYMBOLS;

  let fromMs: number, toMs: number;
  const hoursArg = get("--hours"),
    daysArg = get("--days");
  if (hoursArg) {
    toMs = Date.now();
    fromMs = toMs - Number(hoursArg) * 3_600_000;
  } else if (daysArg) {
    toMs = Date.now();
    fromMs = toMs - Number(daysArg) * 86_400_000;
  } else {
    const fromArg = get("--from"),
      toArg = get("--to");
    if (!fromArg) {
      console.error(
        "Must provide --hours, --days, or --from/--to. Example: --days 30",
      );
      process.exit(1);
    }
    fromMs = parseUtcDatetime(fromArg);
    toMs = toArg ? parseUtcDatetime(toArg) : Date.now();
  }
  const paddingHours = Number(get("--paddingHours") ?? DEFAULT_PADDING_HOURS);
  return { symbols, fromMs, toMs, paddingMs: paddingHours * 3_600_000 };
}

/** True collection coverage for this symbol -- NOT bounded by the
 *  requested window. Used to honestly report whether Mongo actually
 *  holds the full requested period, per the operator's explicit
 *  "do not pretend it does" instruction. */
async function getCollectionCoverage(
  symbol: string,
): Promise<{ earliestMs: number | null; latestMs: number | null }> {
  const mongoCfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  if (!mongoCfg.enabled) throw new Error("MONGO_URI not set");
  const mongo = new MongoClientWrapper(mongoCfg);
  const coll = await mongo.rawLiquidationEvents();
  if (!coll) {
    await mongo.close();
    throw new Error("Could not obtain the liq_raw_events collection handle");
  }
  const earliest = await coll
    .find({ symbol })
    .sort({ timestamp: 1 })
    .limit(1)
    .toArray();
  const latest = await coll
    .find({ symbol })
    .sort({ timestamp: -1 })
    .limit(1)
    .toArray();
  await mongo.close();
  return {
    earliestMs: earliest[0]?.timestamp ?? null,
    latestMs: latest[0]?.timestamp ?? null,
  };
}

interface PercentileSet {
  p50: number | null;
  p70: number | null;
  p75: number | null;
  p80: number | null;
  p90: number | null;
  p95: number | null;
  p975: number | null;
  p99: number | null;
}
function percentileSet(values: readonly number[]): PercentileSet {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p70: percentile(sorted, 0.7),
    p75: percentile(sorted, 0.75),
    p80: percentile(sorted, 0.8),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p975: percentile(sorted, 0.975),
    p99: percentile(sorted, 0.99),
  };
}

async function processSymbol(
  symbol: string,
  args: CliArgs,
): Promise<Record<string, unknown>> {
  console.log(`\n=== ${symbol} ===`);
  const coverage = await getCollectionCoverage(symbol);
  console.log(
    `Collection coverage: earliest=${coverage.earliestMs !== null ? new Date(coverage.earliestMs).toISOString() : "none"} latest=${coverage.latestMs !== null ? new Date(coverage.latestMs).toISOString() : "none"}`,
  );
  const requestedFrom = args.fromMs,
    requestedTo = args.toMs;
  const coverageWarning =
    coverage.earliestMs !== null && coverage.earliestMs > requestedFrom
      ? `Requested FROM (${new Date(requestedFrom).toISOString()}) is earlier than the earliest available data (${new Date(coverage.earliestMs).toISOString()}) -- actual usable window starts later than requested.`
      : null;
  if (coverageWarning) console.warn(`  WARNING: ${coverageWarning}`);

  const paddedFrom = args.fromMs - args.paddingMs;
  console.log(
    `Fetching klines and raw events for [${new Date(paddedFrom).toISOString()} (padded)  ->  ${new Date(requestedTo).toISOString()}]...`,
  );
  const c1m = await fetchKlines(symbol, 60_000, paddedFrom, requestedTo);
  const c3m = await fetchKlines(symbol, 180_000, paddedFrom, requestedTo);
  const c5m = await fetchKlines(symbol, 300_000, paddedFrom, requestedTo);
  const atrs: Atrs = {
    c1m,
    c3m,
    c5m,
    series1m: computeAtrSeries(c1m),
    series3m: computeAtrSeries(c3m),
    series5m: computeAtrSeries(c5m),
  };
  const events = await loadRawEvents(symbol, paddedFrom, requestedTo);
  console.log(`Raw events (padded window): ${events.length}`);

  const variant: Variant = PRIMARY_VARIANT;
  const allEpisodes = reconstructEpisodesForVariant(
    events,
    atrs,
    variant,
    requestedTo,
  );

  // ---- boundary handling, exactly as documented in this file's header ----
  const leftCensoredCount = allEpisodes.filter(
    (e) => e.startTime < requestedFrom,
  ).length;
  const rightCensoredCount = allEpisodes.filter(
    (e) => e.endTime === null,
  ).length;
  const completeEpisodes = allEpisodes.filter(
    (e) =>
      e.startTime >= requestedFrom &&
      e.endTime !== null &&
      e.endTime <= requestedTo,
  );
  console.log(
    `Episodes in padded reconstruction: ${allEpisodes.length}  Left-censored (excluded): ${leftCensoredCount}  Right-censored/still-open (excluded): ${rightCensoredCount}  Complete (used for percentiles): ${completeEpisodes.length}`,
  );

  const episodeUsd = (e: Episode): number =>
    e.sameDirectionEvents.reduce((s, ev) => s + ev.quoteQty, 0);
  const allUsd = completeEpisodes.map(episodeUsd);
  const longEpisodes = completeEpisodes.filter((e) => e.direction === "LONG");
  const shortEpisodes = completeEpisodes.filter((e) => e.direction === "SHORT");
  const longUsd = longEpisodes.map(episodeUsd);
  const shortUsd = shortEpisodes.map(episodeUsd);

  const allPct = percentileSet(allUsd);
  const longPct = percentileSet(longUsd);
  const shortPct = percentileSet(shortUsd);

  console.log(
    `Complete episodes: ${completeEpisodes.length} (LONG=${longEpisodes.length} SHORT=${shortEpisodes.length})`,
  );
  console.log(
    `ALL   P90=${allPct.p90?.toFixed(0)} P95=${allPct.p95?.toFixed(0)} P99=${allPct.p99?.toFixed(0)}`,
  );
  console.log(
    `LONG  P90=${longPct.p90?.toFixed(0)} P95=${longPct.p95?.toFixed(0)} P99=${longPct.p99?.toFixed(0)}`,
  );
  console.log(
    `SHORT P90=${shortPct.p90?.toFixed(0)} P95=${shortPct.p95?.toFixed(0)} P99=${shortPct.p99?.toFixed(0)}`,
  );

  return {
    symbol,
    from: requestedFrom,
    to: requestedTo,
    fromIso: new Date(requestedFrom).toISOString(),
    toIso: new Date(requestedTo).toISOString(),
    dataCoverage: {
      earliestAvailableMs: coverage.earliestMs,
      latestAvailableMs: coverage.latestMs,
      coverageWarning,
    },
    rawEventCount: events.length,
    completedEpisodeCount: completeEpisodes.length,
    longEpisodeCount: longEpisodes.length,
    shortEpisodeCount: shortEpisodes.length,
    leftCensoredExcluded: leftCensoredCount,
    rightCensoredExcluded: rightCensoredCount,
    percentilesAll: allPct,
    percentilesLong: longPct,
    percentilesShort: shortPct,
    episodes: completeEpisodes.map((e) => {
      const sum = episodeSummary(e);
      return {
        startTime: e.startTime,
        endTime: e.endTime,
        direction: e.direction,
        sameDirectionUsd: episodeUsd(e),
        durationMs: sum.durationMs,
        startPrice: e.firstPrice,
        extremePrice: e.extremePrice,
      };
    }),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(`Symbols: ${args.symbols.join(", ")}`);
  console.log(
    `Requested window: ${new Date(args.fromMs).toISOString()} -> ${new Date(args.toMs).toISOString()}`,
  );
  console.log(
    `Padding: ${args.paddingMs / 3_600_000}h (practical safeguard against left-censored episodes -- see this file's own header for the exact handling)`,
  );
  console.log(
    `Variant: DISPLACEMENT_BALANCED (unchanged, imported from research-liquidation-episodes.ts) -- ${JSON.stringify(PRIMARY_VARIANT)}, minDisplacementAtr3mForFractionGate=${MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE}`,
  );

  const results: Record<string, unknown>[] = [];
  for (const symbol of args.symbols) {
    try {
      results.push(await processSymbol(symbol, args));
    } catch (err) {
      console.error(
        `  FAILED for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
      results.push({
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(`\n=== COMBINED SUMMARY ===`);
  console.log(`Symbol       | Episodes | P90 (ALL) | P95 (ALL) | P99 (ALL)`);
  for (const r of results) {
    if ("error" in r) {
      console.log(`${String(r.symbol).padEnd(12)} | FAILED: ${r.error}`);
      continue;
    }
    const p = r.percentilesAll as PercentileSet;
    console.log(
      `${String(r.symbol).padEnd(12)} | ${String(r.completedEpisodeCount).padStart(8)} | ${p.p90?.toFixed(0).padStart(9) ?? "n/a"} | ${p.p95?.toFixed(0).padStart(9) ?? "n/a"} | ${p.p99?.toFixed(0).padStart(9) ?? "n/a"}`,
    );
  }

  const outDir = path.join(process.cwd(), "research-output");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const tag = `${new Date(args.fromMs).toISOString().slice(0, 10)}_to_${new Date(args.toMs).toISOString().slice(0, 10)}`;
  const jsonPath = path.join(outDir, `episode-percentiles-${tag}.json`);
  const payload = {
    metadata: {
      generatedAt: new Date().toISOString(),
      requestedFromMs: args.fromMs,
      requestedToMs: args.toMs,
      paddingMs: args.paddingMs,
      symbols: args.symbols,
      variant: PRIMARY_VARIANT,
      minDisplacementAtr3mForFractionGate:
        MIN_DISPLACEMENT_ATR3M_FOR_FRACTION_GATE,
    },
    combinedSummary: results.map((r) =>
      "error" in r
        ? { symbol: r.symbol, error: r.error }
        : {
            symbol: r.symbol,
            completedEpisodeCount: r.completedEpisodeCount,
            p90All: (r.percentilesAll as PercentileSet).p90,
            p95All: (r.percentilesAll as PercentileSet).p95,
            p99All: (r.percentilesAll as PercentileSet).p99,
          },
    ),
    perSymbol: results,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  console.log(`\nJSON: ${jsonPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
