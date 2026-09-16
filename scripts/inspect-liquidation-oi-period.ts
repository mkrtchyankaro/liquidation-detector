import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../src/infrastructure/mongo/mongo.client";
import { loadRawEvents } from "../src/domain/research/displacement-balanced-core";
import { fetchKlinesWithRetry } from "../src/domain/research/research-fetch-retry";
import {
  buildMinuteTimeline,
  buildLastLiquidationAnchor,
  annotateOiObservations,
  oiAtOrBefore,
  type OiObservation,
  type LiquidationEvent,
} from "../src/domain/research/liquidation-oi-inspection";

/**
 * Sep 16 2026 (Karo), operator-requested. Reusable, READ-ONLY
 * liquidation + OI + price inspector -- any symbol, any time window,
 * not hard-coded to BTC or any timestamp. No writes/updates/deletes/
 * index-creates anywhere in this file; only find()/sort() plus
 * in-memory aggregation, mirroring inspect-liquidation-period.ts's own
 * safety stance.
 *
 * SCHEMA CORRECTION (operator-verified against a real document):
 * oi_second_observations.openInterestUsd and .price are effectively
 * always null in practice. This script therefore NEVER reads price
 * from the OI documents -- it fetches price independently via
 * historical candles and aligns it causally (see
 * liquidation-oi-inspection.ts's own header).
 *
 *   npx tsx scripts/inspect-liquidation-oi-period.ts ETHUSDT "2026-09-16 11:25" "2026-09-16 12:30"
 *   npx tsx scripts/inspect-liquidation-oi-period.ts BTCUSDT "2026-09-16 12:20" "2026-09-16 13:10" LONG
 */

function parseUtcDatetime(input: string): number {
  if (input.trim().toLowerCase() === "now") return Date.now();
  let s = input.trim();
  const hasExplicitOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!hasExplicitOffset) s = s + "Z";
  const ms = Date.parse(s);
  if (Number.isNaN(ms))
    throw new Error(`Could not parse datetime: "${input}" (tried "${s}")`);
  return ms;
}
function fmtUtc(ms: number): string {
  return new Date(ms).toISOString();
}

function mongoConfig(): MongoDetectorConfig {
  return {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
}

async function loadOiObservations(
  mongo: MongoClientWrapper,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<OiObservation[]> {
  const col = await mongo.oiSecondObservations();
  if (!col)
    throw new Error(
      "Could not obtain the oi_second_observations collection handle",
    );
  const docs = await col
    .find({
      symbol,
      timestamp: { $gte: new Date(fromMs), $lte: new Date(toMs) },
    })
    .sort({ timestamp: 1 })
    .toArray();
  return docs.map((d) => ({
    symbol: d.symbol,
    timestamp:
      d.timestamp instanceof Date
        ? d.timestamp.getTime()
        : new Date(d.timestamp as unknown as string).getTime(),
    oiUpdatedAtMs: d.oiUpdatedAt
      ? d.oiUpdatedAt instanceof Date
        ? d.oiUpdatedAt.getTime()
        : new Date(d.oiUpdatedAt as unknown as string).getTime()
      : null,
    openInterest: d.openInterest,
  }));
}

async function getOiCollectionCoverage(
  mongo: MongoClientWrapper,
  symbol: string,
): Promise<{ earliestMs: number | null; latestMs: number | null }> {
  const col = await mongo.oiSecondObservations();
  if (!col) return { earliestMs: null, latestMs: null };
  const earliest = await col
    .find({ symbol })
    .sort({ timestamp: 1 })
    .limit(1)
    .toArray();
  const latest = await col
    .find({ symbol })
    .sort({ timestamp: -1 })
    .limit(1)
    .toArray();
  const toMsVal = (d: unknown): number | null =>
    d instanceof Date ? d.getTime() : null;
  return {
    earliestMs: earliest[0] ? toMsVal(earliest[0].timestamp) : null,
    latestMs: latest[0] ? toMsVal(latest[0].timestamp) : null,
  };
}

async function main(): Promise<void> {
  const [, , symbolArg, fromArg, toArg, directionArg] = process.argv;
  if (!symbolArg || !fromArg || !toArg) {
    console.error(
      'Usage: npx tsx scripts/inspect-liquidation-oi-period.ts SYMBOL "FROM" "TO" [LONG|SHORT|ALL]',
    );
    process.exit(1);
  }
  const symbol = symbolArg.toUpperCase();
  const fromMs = parseUtcDatetime(fromArg);
  const toMs = parseUtcDatetime(toArg);
  const direction = (directionArg ?? "ALL").toUpperCase();
  if (!["LONG", "SHORT", "ALL"].includes(direction)) {
    console.error(
      `Invalid direction filter "${directionArg}" -- must be LONG, SHORT, or ALL`,
    );
    process.exit(1);
  }
  if (toMs <= fromMs) {
    console.error("TO must be after FROM");
    process.exit(1);
  }

  console.log(`Symbol: ${symbol}`);
  console.log(`Requested FROM: ${fmtUtc(fromMs)}`);
  console.log(`Requested TO:   ${fmtUtc(toMs)}`);
  console.log(`Direction filter: ${direction}`);

  const mongo = new MongoClientWrapper(mongoConfig());
  let liquidations: LiquidationEvent[];
  let oiObservations: OiObservation[];
  let oiCollectionCoverage: {
    earliestMs: number | null;
    latestMs: number | null;
  };
  try {
    const rawEvents = await loadRawEvents(symbol, fromMs, toMs);
    liquidations = rawEvents.map((e) => ({
      timestamp: e.timestamp,
      victim: e.victim,
      price: e.price,
      quoteQty: e.quoteQty,
    }));
    oiObservations = await loadOiObservations(mongo, symbol, fromMs, toMs);
    oiCollectionCoverage = await getOiCollectionCoverage(mongo, symbol);
  } finally {
    await mongo.close();
  }

  const candles = await fetchKlinesWithRetry(
    symbol,
    60_000,
    fromMs - 60_000,
    toMs + 60_000,
  );

  console.log(`\n=== COVERAGE ===`);
  const oiFirst = oiObservations[0] ?? null;
  const oiLast = oiObservations[oiObservations.length - 1] ?? null;
  console.log(`OI observations in requested window: ${oiObservations.length}`);
  console.log(
    `First OI observation (in window): ${oiFirst ? fmtUtc(oiFirst.timestamp) : "none"}`,
  );
  console.log(
    `Last OI observation (in window):  ${oiLast ? fmtUtc(oiLast.timestamp) : "none"}`,
  );
  if (
    oiCollectionCoverage.earliestMs !== null &&
    oiCollectionCoverage.earliestMs > fromMs
  ) {
    console.log(
      `*** OI DATA STARTS AT ${fmtUtc(oiCollectionCoverage.earliestMs)} -- this is AFTER your requested FROM (${fmtUtc(fromMs)}). No earlier OI exists; nothing has been fabricated. ***`,
    );
  }
  const liqFirst = liquidations[0] ?? null;
  const liqLast = liquidations[liquidations.length - 1] ?? null;
  console.log(`Liquidation events: ${liquidations.length}`);
  console.log(
    `First liquidation: ${liqFirst ? fmtUtc(liqFirst.timestamp) : "none"}`,
  );
  console.log(
    `Last liquidation:  ${liqLast ? fmtUtc(liqLast.timestamp) : "none"}`,
  );
  const longUsd = liquidations
    .filter((l) => l.victim === "LONG")
    .reduce((s, l) => s + l.quoteQty, 0);
  const shortUsd = liquidations
    .filter((l) => l.victim === "SHORT")
    .reduce((s, l) => s + l.quoteQty, 0);
  console.log(`LONG liquidation total USD:  ${longUsd.toFixed(0)}`);
  console.log(`SHORT liquidation total USD: ${shortUsd.toFixed(0)}`);

  const timeline = buildMinuteTimeline(
    fromMs,
    toMs,
    candles,
    oiObservations,
    liquidations,
  );
  console.log(
    `\n=== MINUTE TIMELINE (${timeline.length} minutes, full requested window regardless of liquidation activity) ===`,
  );
  let carryOi: number | null = null;
  for (const row of timeline) {
    const displayOiEnd = row.oiEnd ?? carryOi;
    if (row.oiEnd !== null) carryOi = row.oiEnd;
    const liqNote =
      row.longLiqCount + row.shortLiqCount > 0
        ? ` LIQ(L:${row.longLiqCount}/$${row.longLiqUsd.toFixed(0)} S:${row.shortLiqCount}/$${row.shortLiqUsd.toFixed(0)})`
        : "";
    console.log(
      `  ${fmtUtc(row.minuteStartMs).slice(11, 16)} price=${row.priceClose?.toFixed(4) ?? "n/a"} oi=${displayOiEnd?.toFixed(2) ?? "n/a"}${row.oiEnd === null ? " (carried, no new obs this minute)" : ""}${liqNote}`,
    );
  }

  console.log(`\n=== RAW LIQUIDATIONS (oldest -> newest) ===`);
  for (const l of liquidations)
    console.log(
      `  ${fmtUtc(l.timestamp)} ${l.victim} price=${l.price} quoteQty=${l.quoteQty.toFixed(0)}`,
    );

  const relevantLiqs =
    direction === "ALL"
      ? liquidations
      : liquidations.filter((l) => l.victim === direction);
  const lastLongLiq =
    liquidations.filter((l) => l.victim === "LONG").slice(-1)[0] ?? null;
  const lastShortLiq =
    liquidations.filter((l) => l.victim === "SHORT").slice(-1)[0] ?? null;
  const lastAnyLiq = liquidations.slice(-1)[0] ?? null;
  console.log(
    `\nLAST_LONG_LIQ:  ${lastLongLiq ? `${fmtUtc(lastLongLiq.timestamp)} price=${lastLongLiq.price} usd=${lastLongLiq.quoteQty.toFixed(0)} nearestOI=${oiAtOrBefore(oiObservations, lastLongLiq.timestamp)?.openInterest ?? "n/a"}` : "none"}`,
  );
  console.log(
    `LAST_SHORT_LIQ: ${lastShortLiq ? `${fmtUtc(lastShortLiq.timestamp)} price=${lastShortLiq.price} usd=${lastShortLiq.quoteQty.toFixed(0)} nearestOI=${oiAtOrBefore(oiObservations, lastShortLiq.timestamp)?.openInterest ?? "n/a"}` : "none"}`,
  );
  console.log(
    `LAST_LIQ_ANY:   ${lastAnyLiq ? `${fmtUtc(lastAnyLiq.timestamp)} ${lastAnyLiq.victim} price=${lastAnyLiq.price} usd=${lastAnyLiq.quoteQty.toFixed(0)} nearestOI=${oiAtOrBefore(oiObservations, lastAnyLiq.timestamp)?.openInterest ?? "n/a"}` : "none"}`,
  );

  const lastRelevantLiq = relevantLiqs.slice(-1)[0] ?? null;
  const annotated = annotateOiObservations(
    oiObservations,
    candles,
    lastRelevantLiq?.timestamp ?? null,
  );
  console.log(
    `\n=== HIGH-RESOLUTION OI (${annotated.length} raw ~1s observations, no interpolation) ===`,
  );
  console.log(
    `(full series written to the output JSON; showing first 5 and last 5 here)`,
  );
  for (const o of [
    ...annotated.slice(0, 5),
    ...(annotated.length > 10 ? annotated.slice(-5) : []),
  ]) {
    console.log(
      `  ${fmtUtc(o.timestamp)} oi=${o.openInterest.toFixed(4)} causalPrice=${o.causalPrice?.toFixed(4) ?? "n/a"} estOiUsd=${o.estimatedOiUsd?.toFixed(0) ?? "n/a"}(derived) dOiPrev%=${o.deltaOiPctFromPrevious?.toFixed(4) ?? "n/a"} dOiFromLastLiq%=${o.deltaOiPctFromLastLiquidation?.toFixed(4) ?? "n/a"}`,
    );
  }

  let lastLiquidationAnchors: ReturnType<typeof buildLastLiquidationAnchor>[] =
    [];
  console.log(
    `\n=== LAST LIQUIDATION ANCHOR (direction filter: ${direction}) ===`,
  );
  if (lastRelevantLiq === null) {
    console.log(
      `  No ${direction} liquidation found in the requested window -- no anchor to compute.`,
    );
  } else {
    const anchor = buildLastLiquidationAnchor(
      lastRelevantLiq,
      oiObservations,
      candles,
      toMs,
    );
    lastLiquidationAnchors = [anchor];
    console.log(
      `  Last relevant (${lastRelevantLiq.victim}) liquidation: ${fmtUtc(anchor.lastLiquidationTs)} price=${anchor.priceAtLastLiquidation} usd=${anchor.liquidationUsd.toFixed(0)}`,
    );
    console.log(
      `  Nearest causal OI: ${anchor.nearestCausalOi ? `${anchor.nearestCausalOi.openInterest.toFixed(4)} @ ${fmtUtc(anchor.nearestCausalOi.timestamp)} (offset ${(anchor.nearestCausalOiOffsetMs! / 1000).toFixed(1)}s)` : "none available"}`,
    );
    for (const h of anchor.horizons) {
      if (h.actualTimestamp === null) {
        console.log(
          `    +${h.targetOffsetSeconds}s target: unavailable (past requested TO or no observation)`,
        );
      } else {
        console.log(
          `    +${h.targetOffsetSeconds}s target -> actual +${h.actualOffsetSeconds!.toFixed(1)}s @ ${fmtUtc(h.actualTimestamp)}: price=${h.price?.toFixed(4) ?? "n/a"} (${h.priceChangeFromLastLiqPct?.toFixed(3) ?? "n/a"}%) oi=${h.openInterest?.toFixed(4) ?? "n/a"} (${h.oiChangeFromLastLiqPct?.toFixed(4) ?? "n/a"}%)`,
        );
      }
    }
  }

  const outDir = path.join(process.cwd(), "research-output");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const tag = `${symbol}_${fmtUtc(fromMs).replace(/[:.]/g, "-")}_to_${fmtUtc(toMs).replace(/[:.]/g, "-")}`;

  const jsonOut = {
    metadata: {
      symbol,
      requestedFromIso: fmtUtc(fromMs),
      requestedToIso: fmtUtc(toMs),
      direction,
      generatedAt: new Date().toISOString(),
    },
    coverage: {
      oiObservationCountInWindow: oiObservations.length,
      oiFirstInWindowIso: oiFirst ? fmtUtc(oiFirst.timestamp) : null,
      oiLastInWindowIso: oiLast ? fmtUtc(oiLast.timestamp) : null,
      oiCollectionEarliestIso:
        oiCollectionCoverage.earliestMs !== null
          ? fmtUtc(oiCollectionCoverage.earliestMs)
          : null,
      oiDataStartsAfterRequestedFrom:
        oiCollectionCoverage.earliestMs !== null &&
        oiCollectionCoverage.earliestMs > fromMs,
      liquidationCount: liquidations.length,
      liqFirstIso: liqFirst ? fmtUtc(liqFirst.timestamp) : null,
      liqLastIso: liqLast ? fmtUtc(liqLast.timestamp) : null,
      longLiqUsd: longUsd,
      shortLiqUsd: shortUsd,
    },
    summary: {
      minuteCount: timeline.length,
      lastLongLiq,
      lastShortLiq,
      lastAnyLiq,
    },
    rawLiquidations: liquidations,
    oiObservations: annotated,
    minuteTimeline: timeline,
    lastLiquidationAnchors,
  };
  const jsonPath = path.join(outDir, `inspect-liq-oi-${tag}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2));

  const csvHeader = [
    "minuteUtc",
    "priceOpen",
    "priceHigh",
    "priceLow",
    "priceClose",
    "priceChangePct",
    "oiStart",
    "oiEnd",
    "oiMin",
    "oiMax",
    "oiChange",
    "oiChangePct",
    "longLiqUsd",
    "shortLiqUsd",
    "longLiqCount",
    "shortLiqCount",
  ];
  const csvRows = timeline.map((r) =>
    [
      fmtUtc(r.minuteStartMs),
      r.priceOpen ?? "",
      r.priceHigh ?? "",
      r.priceLow ?? "",
      r.priceClose ?? "",
      r.priceChangePct?.toFixed(4) ?? "",
      r.oiStart ?? "",
      r.oiEnd ?? "",
      r.oiMin ?? "",
      r.oiMax ?? "",
      r.oiChange ?? "",
      r.oiChangePct?.toFixed(4) ?? "",
      r.longLiqUsd.toFixed(0),
      r.shortLiqUsd.toFixed(0),
      r.longLiqCount,
      r.shortLiqCount,
    ].join(","),
  );
  const csvPath = path.join(outDir, `inspect-liq-oi-${tag}.csv`);
  fs.writeFileSync(csvPath, [csvHeader.join(","), ...csvRows].join("\n"));

  console.log(`\nJSON: ${jsonPath}`);
  console.log(`CSV (minute timeline): ${csvPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
