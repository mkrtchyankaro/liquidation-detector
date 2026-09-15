import * as fs from "fs";

/**
 * Sep 15 2026 (Karo), operator-requested audit. READ-ONLY: reads an
 * already-exported research-output/<SYMBOL>-...json file (produced by
 * inspect-liquidation-period.ts) and independently re-derives:
 *   - a raw, unaggregated event listing for a requested sub-window
 *   - minute buckets, rebuilt from scratch here (not copy-pasted from
 *     the exporter's own bucket logic) and cross-checked against the
 *     JSON's own `minuteBuckets` field
 * Touches no database, no detector/production code. Pure local file
 * read + in-memory arithmetic.
 *
 *   npx tsx scripts/audit-liquidation-buckets.ts \
 *     research-output/BTCUSDT-2026-09-15-13-20_to_2026-09-15-15-10.json \
 *     "2026-09-15 14:50" "2026-09-15 14:57"
 *
 * IMPORTANT SCHEMA NOTE (see the audit's own final report for the
 * full explanation): RawLiquidationEventDoc does NOT persist Binance's
 * raw forceOrder `side` (SELL/BUY) separately -- only the already-
 * converted `victim` (LONG/SHORT) is stored. So "raw side" below is
 * RE-DERIVED from victim via the exact inverse of the one fixed
 * formula used everywhere in the codebase (victim===LONG -> SELL,
 * victim===SHORT -> BUY) -- it is not read from an independent field,
 * because no such field was ever persisted.
 */

interface RawEvent {
  _id: string;
  timestamp: number;
  victim: "LONG" | "SHORT";
  price: number;
  quoteQty: number;
}
interface MinuteBucketExport {
  minute: string;
  longCount: number;
  longUsd: number;
  shortCount: number;
  shortUsd: number;
}
interface ExportFile {
  rawEvents: RawEvent[];
  minuteBuckets: MinuteBucketExport[];
}

function parseUtcDatetime(input: string): number {
  let s = input.trim();
  const hasExplicitOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!hasExplicitOffset) s = s + "Z";
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Could not parse datetime: "${input}"`);
  return ms;
}
function fmtMs(ts: number): string {
  return new Date(ts).toISOString();
}
function fmtMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function main(): void {
  const [, , filePath, fromArg, toArg] = process.argv;
  if (!filePath || !fromArg || !toArg) {
    console.error(
      'Usage: audit-liquidation-buckets.ts <research-output.json> "<FROM>" "<TO>"',
    );
    process.exit(1);
  }
  const fromMs = parseUtcDatetime(fromArg),
    toMs = parseUtcDatetime(toArg);
  const raw: ExportFile = JSON.parse(fs.readFileSync(filePath, "utf8"));

  const inWindow = raw.rawEvents
    .filter((e) => e.timestamp >= fromMs && e.timestamp <= toMs)
    .sort((a, b) => a.timestamp - b.timestamp);
  console.log(
    `=== RAW EVENTS ${fmtMs(fromMs)} -> ${fmtMs(toMs)} (${inWindow.length} events) ===`,
  );
  console.log(
    "timestampUTC\t\t\tsymbol\trederivedRawSide\tvictimSide\tprice\tquoteQty\t_id",
  );
  for (const e of inWindow) {
    const rederivedRawSide = e.victim === "LONG" ? "SELL" : "BUY";
    console.log(
      `${fmtMs(e.timestamp)}\tBTCUSDT\t${rederivedRawSide}\t\t\t${e.victim}\t\t${e.price}\t${e.quoteQty.toFixed(4)}\t${e._id}`,
    );
  }

  const idCounts = new Map<string, number>();
  for (const e of inWindow) idCounts.set(e._id, (idCounts.get(e._id) ?? 0) + 1);
  const dupes = [...idCounts.entries()].filter(([, c]) => c > 1);
  console.log(
    `\nDuplicate _id check: ${dupes.length === 0 ? "PASS (no duplicates)" : `FAIL -- ${JSON.stringify(dupes)}`}`,
  );

  const byMinute = new Map<string, RawEvent[]>();
  for (const e of inWindow) {
    const key = fmtMinute(e.timestamp);
    let arr = byMinute.get(key);
    if (!arr) {
      arr = [];
      byMinute.set(key, arr);
    }
    arr.push(e);
  }
  console.log(`\n=== INDEPENDENTLY REBUILT MINUTE BUCKETS ===`);
  const rebuiltBuckets: MinuteBucketExport[] = [];
  for (const minute of [...byMinute.keys()].sort()) {
    const events = byMinute.get(minute)!;
    const longs = events.filter((e) => e.victim === "LONG"),
      shorts = events.filter((e) => e.victim === "SHORT");
    const longUsd = longs.reduce((s, e) => s + e.quoteQty, 0),
      shortUsd = shorts.reduce((s, e) => s + e.quoteQty, 0);
    rebuiltBuckets.push({
      minute,
      longCount: longs.length,
      longUsd,
      shortCount: shorts.length,
      shortUsd,
    });
    console.log(
      `${minute} UTC: LONG ${longs.length}ev $${longUsd.toFixed(2)}  SHORT ${shorts.length}ev $${shortUsd.toFixed(2)}`,
    );
  }

  console.log(`\n=== CROSS-CHECK vs exporter's own minuteBuckets ===`);
  let allMatch = true;
  for (const rb of rebuiltBuckets) {
    const exported = raw.minuteBuckets.find((b) => b.minute === rb.minute);
    if (!exported) {
      console.log(
        `${rb.minute}: FAIL -- no matching bucket in exported minuteBuckets`,
      );
      allMatch = false;
      continue;
    }
    const longMatch =
      exported.longCount === rb.longCount &&
      Math.abs(exported.longUsd - rb.longUsd) < 1e-6;
    const shortMatch =
      exported.shortCount === rb.shortCount &&
      Math.abs(exported.shortUsd - rb.shortUsd) < 1e-6;
    if (longMatch && shortMatch) {
      console.log(`${rb.minute}: MATCH`);
    } else {
      allMatch = false;
      console.log(
        `${rb.minute}: MISMATCH -- rebuilt(long=${rb.longCount}/$${rb.longUsd.toFixed(2)}, short=${rb.shortCount}/$${rb.shortUsd.toFixed(2)}) vs exported(long=${exported.longCount}/$${exported.longUsd.toFixed(2)}, short=${exported.shortCount}/$${exported.shortUsd.toFixed(2)})`,
      );
    }
  }
  console.log(
    `\nOverall cross-check: ${allMatch ? "PASS -- independently rebuilt buckets exactly match the exporter's own output" : "FAIL -- see mismatches above"}`,
  );

  const boundaryEvents = inWindow.filter((e) => {
    const s = new Date(e.timestamp).getUTCSeconds();
    return s === 0 || s === 59;
  });
  if (boundaryEvents.length > 0) {
    console.log(`\n=== MINUTE-BOUNDARY EVENTS (sanity check) ===`);
    for (const e of boundaryEvents)
      console.log(
        `${fmtMs(e.timestamp)} -> bucketed as "${fmtMinute(e.timestamp)}"`,
      );
  }
}

main();
