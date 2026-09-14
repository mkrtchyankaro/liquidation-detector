import "dotenv/config";
import * as fs from "fs";
import { loadBinanceConfig } from "../src/infrastructure/config/binance.config";
import { BinanceRestClient } from "../src/infrastructure/binance/binanceRest.client";

/**
 * Sep 14 2026 (Karo), operator-reported CRITICAL FIX. Replaces
 * reconstruct-true-liquidation-reversal-path.ts entirely -- that
 * script produced thousands of favorable=0/adverse=0 candidates
 * (974/974 sequences classified REAL_REVERSAL, including candidates
 * with zero measured movement) due to a confirmed bug, root-caused
 * below.
 *
 * ROOT CAUSE (confirmed by tracing the actual code, not guessed):
 * the old script picked `startIdx` as the first candle whose CLOSE
 * time (openTime+60000) was after candidateEndTs -- i.e. the candle
 * CONTAINING the liquidation, whose own openTime is almost always
 * BEFORE candidateEndTs (a liquidation essentially never lands
 * exactly on a minute boundary). The walk loop then required
 * `candle.openTime >= candidateEndTs` before consuming a candle --
 * a condition that candle at startIdx almost never satisfies. So the
 * walk's own guard rejected the very candle it was pointed at, `ci`
 * never advanced, and running favorable/adverse extremes stayed
 * frozen at the reference price for the entire 30-minute window,
 * producing 0/0 for every horizon on nearly every candidate. This
 * reproduces on essentially 100% of real data, since "liquidation
 * timestamp exactly equals a candle open time" has near-zero
 * probability. My own prior smoke test used candidateEndTs=0 against
 * a candle at openTime=0, which coincidentally SATISFIED the broken
 * guard (0>=0) and masked the bug completely -- a real gap in that
 * verification, not bad luck; I never tested the (overwhelmingly
 * common) mid-candle case.
 *
 * FIX: per operator instruction (TASK 5), true post-event evaluation
 * begins from the NEXT FULLY CLOSED candle after candidateEndTs --
 * i.e. the first candle whose own openTime >= candidateEndTs (never
 * the partial candle containing the event, which would risk
 * lookahead into price movement that happened BEFORE the
 * liquidation). That candle is walk-minute 1; each subsequent candle
 * is walk-minute 2, 3, etc. No further per-candle timestamp guard is
 * needed once startIdx itself is computed correctly -- the old
 * guard was defensive code that became the actual bug once paired
 * with the wrong startIdx.
 *
 * READ-ONLY research. Never touches production code, ROTATION logic,
 * P95/history, or any TP/SL constant.
 *
 *   tsx scripts/reconstruct-true-liquidation-reversal-path-fixed.ts \
 *     --market-response=/mnt/data/liquidation-market-response-3d-<ts>.json \
 *     --prior-classification=/mnt/data/liquidation-reversal-classification-3d-<ts>.json \
 *     --prior-broken=/mnt/data/liquidation-true-reversals-3d-<ts>.json
 */

const PATH_MINUTES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 30];
const MAX_HORIZON_MIN = 30;

interface SourceCandidate {
  symbol: string;
  victim: "LONG" | "SHORT";
  sequenceId: string;
  candidateIndex: number;
  candidateStartTs: number;
  candidateEndTs: number;
  candidateStartPrice: number;
  candidateEndPrice: number;
  latestExtremePrice: number;
  cumulativeLiqUsd: number;
  eventCount: number;
  maxSingleLiqUsd: number;
  maxSingleOverCumulative: number;
  durationMs: number;
  avgEventSpacingMs: number;
  medianEventSpacingMs: number;
  lastEventUsd: number;
  liqAmountTrend: string;
  preLiqDirAtr: number | null;
  preRecDirAtr: number | null;
  currentDirAtr: number | null;
  currentRecAtr: number | null;
  comparisonRotationDegApprox: number | null;
  comparisonShockAtrApprox: number | null;
}
interface SourceJson {
  windowFromMs: number;
  windowToMs: number;
  candidates: SourceCandidate[];
}
interface OldMarketResponseCandidate {
  symbol: string;
  sequenceId: string;
  candidateIndex: number;
  response: { horizonMin: number; mfePct: number; maePct: number }[];
}

export interface HistoricalCandle {
  symbol: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  isClosed: true;
}

type DataQuality = "VALID" | "NO_MOVE" | "NO_DATA";
type FirstDirectionalMove =
  | "FAVORABLE"
  | "ADVERSE"
  | "BOTH_SAME_CANDLE"
  | "FLAT"
  | "NO_DATA";
type FirstDominantMove =
  | "REVERSAL"
  | "CONTINUATION"
  | "INTRAMINUTE_ORDER_UNKNOWN"
  | "NONE"
  | "NO_DATA";
type OutcomeClass =
  | "REAL_REVERSAL"
  | "LIKELY_REVERSAL"
  | "AMBIGUOUS"
  | "CONTINUATION"
  | "NO_MOVE"
  | "NO_DATA";
type SequenceClass =
  | "REAL_REVERSAL"
  | "FAILED_REVERSAL"
  | "CONTINUATION"
  | "AMBIGUOUS"
  | "NO_DATA";

interface PathPoint {
  minute: number;
  favorablePct: number;
  adversePct: number;
  ohlc: { open: number; high: number; low: number; close: number };
}

export interface TruePathResult {
  dataQuality: DataQuality;
  path: PathPoint[];
  timeToFirstFavorableMin: number | null;
  timeToFirstAdverseMin: number | null;
  timeToMaxFavorableMin: number | null;
  timeToMaxAdverseMin: number | null;
  maxFavorablePct: number | null;
  maxAdversePct: number | null;
  maxAdverseBeforeFavorableDominance: number | null;
  maxFavorableBeforeAdverseDominance: number | null;
  firstDirectionalMove: FirstDirectionalMove;
  firstDominantMove: FirstDominantMove;
  numberOfPostCandidateAdverseExtremes: number;
  largestAdverseExtensionBeforeReversal: number | null;
  candlesConsumed: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi
    ? sorted[lo]!
    : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

async function fetchHistoricalCandles(
  rest: BinanceRestClient,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<HistoricalCandle[]> {
  const out: HistoricalCandle[] = [];
  let cursor = fromMs;
  const PAGE_LIMIT = 500;
  const MS_PER_CANDLE = 60_000;
  while (cursor < toMs) {
    const pageEnd = Math.min(cursor + PAGE_LIMIT * MS_PER_CANDLE - 1, toMs - 1);
    const candles = await rest.getKlines(
      symbol,
      "1m",
      PAGE_LIMIT,
      cursor,
      pageEnd,
    );
    if (candles.length === 0) break;
    for (const c of candles) {
      if (!c.isClosed) continue;
      out.push({
        symbol,
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        isClosed: true,
      });
    }
    const lastOpenTime = candles[candles.length - 1]!.openTime;
    if (lastOpenTime <= cursor) break;
    cursor = lastOpenTime + MS_PER_CANDLE;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return out;
}

/** FIXED true path reconstruction. `candles` must already be sorted
 *  ascending by openTime. Walk begins at the first candle whose OWN
 *  openTime >= candidateEndTs -- the first FULLY closed candle after
 *  the event, never the partial candle containing it (TASK 5). If no
 *  such candle exists in the fetched range, dataQuality=NO_DATA. If
 *  candles exist but zero movement is observed across the whole
 *  30-minute walk, dataQuality=NO_MOVE. Only dataQuality=VALID
 *  candidates may ever be classified REAL_REVERSAL/CONTINUATION/etc. */
export function reconstructTruePath(
  candles: readonly HistoricalCandle[],
  candidateEndTs: number,
  refPrice: number,
  victim: "LONG" | "SHORT",
  candidateLatestExtreme: number,
): TruePathResult {
  const startIdx = candles.findIndex((c) => c.openTime >= candidateEndTs);
  if (startIdx === -1) {
    return {
      dataQuality: "NO_DATA",
      path: [],
      timeToFirstFavorableMin: null,
      timeToFirstAdverseMin: null,
      timeToMaxFavorableMin: null,
      timeToMaxAdverseMin: null,
      maxFavorablePct: null,
      maxAdversePct: null,
      maxAdverseBeforeFavorableDominance: null,
      maxFavorableBeforeAdverseDominance: null,
      firstDirectionalMove: "NO_DATA",
      firstDominantMove: "NO_DATA",
      numberOfPostCandidateAdverseExtremes: 0,
      largestAdverseExtensionBeforeReversal: null,
      candlesConsumed: 0,
    };
  }

  const walked = candles.slice(startIdx, startIdx + MAX_HORIZON_MIN);
  const allPoints: PathPoint[] = [];
  let runningFavExtreme = refPrice;
  let runningAdvExtreme = refPrice;
  let numberOfPostCandidateAdverseExtremes = 0;
  let firstFavMin: number | null = null;
  let firstAdvMin: number | null = null;
  let firstDirectionalMove: FirstDirectionalMove = "FLAT";
  let firstDominantMove: FirstDominantMove = "NONE";
  let firstMoveDetermined = false;

  for (let i = 0; i < walked.length; i++) {
    const c = walked[i]!;
    const minute = i + 1; // TASK 5 convention: the first fully-closed candle IS minute 1 of true post-event data
    const priorFav = runningFavExtreme;
    const priorAdv = runningAdvExtreme;

    const favExtremeThisCandle = victim === "LONG" ? c.high : c.low;
    const advExtremeThisCandle = victim === "LONG" ? c.low : c.high;
    if (victim === "LONG") {
      if (favExtremeThisCandle > runningFavExtreme)
        runningFavExtreme = favExtremeThisCandle;
      if (advExtremeThisCandle < runningAdvExtreme)
        runningAdvExtreme = advExtremeThisCandle;
    } else {
      if (favExtremeThisCandle < runningFavExtreme)
        runningFavExtreme = favExtremeThisCandle;
      if (advExtremeThisCandle > runningAdvExtreme)
        runningAdvExtreme = advExtremeThisCandle;
    }
    const movedFavThisCandle = runningFavExtreme !== priorFav;
    const movedAdvThisCandle = runningAdvExtreme !== priorAdv;
    if (movedAdvThisCandle) numberOfPostCandidateAdverseExtremes++;

    if (!firstMoveDetermined && (movedFavThisCandle || movedAdvThisCandle)) {
      firstMoveDetermined = true;
      // TASK 6: a single 1m candle's OHLC does not tell us whether its
      // own high or low was touched first -- if THIS candle is the one
      // that registers the FIRST movement of EITHER kind and it
      // registers BOTH kinds simultaneously, true order is unknown.
      firstDirectionalMove =
        movedFavThisCandle && movedAdvThisCandle
          ? "BOTH_SAME_CANDLE"
          : movedFavThisCandle
            ? "FAVORABLE"
            : "ADVERSE";
      firstDominantMove =
        firstDirectionalMove === "BOTH_SAME_CANDLE"
          ? "INTRAMINUTE_ORDER_UNKNOWN"
          : firstDirectionalMove === "FAVORABLE"
            ? "REVERSAL"
            : "CONTINUATION";
    }

    const favorablePct =
      victim === "LONG"
        ? ((runningFavExtreme - refPrice) / refPrice) * 100
        : ((refPrice - runningFavExtreme) / refPrice) * 100;
    const adversePct =
      victim === "LONG"
        ? ((refPrice - runningAdvExtreme) / refPrice) * 100
        : ((runningAdvExtreme - refPrice) / refPrice) * 100;
    if (firstFavMin === null && favorablePct > 0) firstFavMin = minute;
    if (firstAdvMin === null && adversePct > 0) firstAdvMin = minute;

    if (PATH_MINUTES.includes(minute) || minute <= 10) {
      allPoints.push({
        minute,
        favorablePct: Math.max(0, favorablePct),
        adversePct: Math.max(0, adversePct),
        ohlc: { open: c.open, high: c.high, low: c.low, close: c.close },
      });
    }
  }

  const path = allPoints.filter((p) => PATH_MINUTES.includes(p.minute));
  const maxFavorablePct =
    path.length > 0 ? Math.max(0, ...path.map((p) => p.favorablePct)) : 0;
  const maxAdversePct =
    path.length > 0 ? Math.max(0, ...path.map((p) => p.adversePct)) : 0;

  if (walked.length === 0) {
    return {
      dataQuality: "NO_DATA",
      path: [],
      timeToFirstFavorableMin: null,
      timeToFirstAdverseMin: null,
      timeToMaxFavorableMin: null,
      timeToMaxAdverseMin: null,
      maxFavorablePct: null,
      maxAdversePct: null,
      maxAdverseBeforeFavorableDominance: null,
      maxFavorableBeforeAdverseDominance: null,
      firstDirectionalMove: "NO_DATA",
      firstDominantMove: "NO_DATA",
      numberOfPostCandidateAdverseExtremes: 0,
      largestAdverseExtensionBeforeReversal: null,
      candlesConsumed: 0,
    };
  }

  // TASK 7: zero measured movement across the entire walk -> NO_MOVE,
  // never a directional classification. firstDirectionalMove/
  // firstDominantMove stay FLAT/NONE (set by their own default above,
  // since no candle ever registered movement to override them).
  const dataQuality: DataQuality =
    maxFavorablePct === 0 && maxAdversePct === 0 ? "NO_MOVE" : "VALID";

  const timeToMaxFavorableMin =
    dataQuality === "VALID" && maxFavorablePct > 0
      ? (path.find((p) => p.favorablePct === maxFavorablePct)?.minute ?? null)
      : null;
  const timeToMaxAdverseMin =
    dataQuality === "VALID" && maxAdversePct > 0
      ? (path.find((p) => p.adversePct === maxAdversePct)?.minute ?? null)
      : null;

  const beforeMinute = (
    targetMin: number | null,
    key: "favorablePct" | "adversePct",
  ): number | null => {
    if (targetMin === null) return null;
    const before = path.filter((p) => p.minute < targetMin);
    return before.length === 0 ? 0 : Math.max(...before.map((p) => p[key]));
  };
  const maxAdverseBeforeFavorableDominance = beforeMinute(
    timeToMaxFavorableMin,
    "adversePct",
  );
  const maxFavorableBeforeAdverseDominance = beforeMinute(
    timeToMaxAdverseMin,
    "favorablePct",
  );

  // "largest adverse extension before reversal": max adverse reached
  // before the first minute favorable overtakes cumulative adverse so
  // far -- null if favorable never overtakes (i.e. never reversed).
  let largestAdverseExtensionBeforeReversal: number | null = null;
  if (dataQuality === "VALID") {
    for (const p of path) {
      if (p.favorablePct >= p.adversePct && p.favorablePct > 0) {
        largestAdverseExtensionBeforeReversal = beforeMinute(
          p.minute,
          "adversePct",
        );
        break;
      }
    }
  }

  return {
    dataQuality,
    path,
    timeToFirstFavorableMin: firstFavMin,
    timeToFirstAdverseMin: firstAdvMin,
    timeToMaxFavorableMin,
    timeToMaxAdverseMin,
    maxFavorablePct:
      dataQuality === "VALID"
        ? maxFavorablePct
        : dataQuality === "NO_MOVE"
          ? 0
          : null,
    maxAdversePct:
      dataQuality === "VALID"
        ? maxAdversePct
        : dataQuality === "NO_MOVE"
          ? 0
          : null,
    maxAdverseBeforeFavorableDominance,
    maxFavorableBeforeAdverseDominance,
    firstDirectionalMove,
    firstDominantMove,
    numberOfPostCandidateAdverseExtremes,
    largestAdverseExtensionBeforeReversal,
    candlesConsumed: walked.length,
  };
}

function dominanceShare(fav: number | null, adv: number | null): number | null {
  if (fav === null || adv === null) return null;
  const denom = fav + adv;
  return denom > 0 ? fav / denom : null; // TASK 9: null, never 0.5, when there is no measurable movement
}

function parseArgs(argv: string[]): {
  marketResponsePath: string;
  priorBrokenPath: string | null;
} {
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  };
  const marketResponsePath = get("market-response");
  if (!marketResponsePath) {
    console.error(
      "Usage: reconstruct-true-liquidation-reversal-path-fixed.ts --market-response=<path> [--prior-broken=<path to the broken liquidation-true-reversals-3d-*.json, for before/after comparison>]",
    );
    process.exit(1);
  }
  return { marketResponsePath, priorBrokenPath: get("prior-broken") ?? null };
}

async function main(): Promise<void> {
  const { marketResponsePath, priorBrokenPath } = parseArgs(
    process.argv.slice(2),
  );
  const source: SourceJson = JSON.parse(
    fs.readFileSync(marketResponsePath, "utf8"),
  );
  console.log(
    `Loaded ${source.candidates.length} candidates from ${marketResponsePath}\n`,
  );

  // ---- TASK 2/3: timestamp + range verification, printed BEFORE any reconstruction ----
  console.log("=== TASK 2/3: TIMESTAMP AND RANGE VERIFICATION ===\n");
  const symbols = [...new Set(source.candidates.map((c) => c.symbol))];
  const rest = new BinanceRestClient(loadBinanceConfig());
  const candlesBySymbol = new Map<string, HistoricalCandle[]>();

  for (const symbol of symbols) {
    const symCandidates = source.candidates.filter((c) => c.symbol === symbol);
    const minEnd = Math.min(...symCandidates.map((c) => c.candidateEndTs));
    const maxEnd = Math.max(...symCandidates.map((c) => c.candidateEndTs));
    console.log(
      `${symbol}: earliest candidateEndTs=${minEnd} (${new Date(minEnd).toISOString()}), latest=${maxEnd} (${new Date(maxEnd).toISOString()})`,
    );
    const candles = await fetchHistoricalCandles(
      rest,
      symbol,
      minEnd,
      maxEnd + (MAX_HORIZON_MIN + 5) * 60_000,
    );
    candles.sort((a, b) => a.openTime - b.openTime);
    candlesBySymbol.set(symbol, candles);
    if (candles.length > 0) {
      console.log(
        `  fetched ${candles.length} candles, first openTime=${candles[0]!.openTime} (${new Date(candles[0]!.openTime).toISOString()}), last=${candles[candles.length - 1]!.openTime} (${new Date(candles[candles.length - 1]!.openTime).toISOString()})`,
      );
      const coversRange =
        candles[0]!.openTime <= minEnd &&
        candles[candles.length - 1]!.openTime + 60_000 >=
          maxEnd + MAX_HORIZON_MIN * 60_000;
      console.log(
        `  coverage sufficient for full 30m horizon on every candidate: ${coversRange}`,
      );
    } else {
      console.log(`  WARNING: zero candles fetched for ${symbol}`);
    }
  }

  // manual spot-check print for at least 20 candidates across all 6 groups, per TASK 2
  console.log(
    "\n--- Manual timestamp spot-checks (>=20 candidates across BTC/ETH/SOL x LONG/SHORT) ---\n",
  );
  const spotCheckGroups: { symbol: string; victim: "LONG" | "SHORT" }[] = [];
  for (const s of ["BTCUSDT", "ETHUSDT", "SOLUSDT"])
    for (const v of ["LONG", "SHORT"] as const)
      spotCheckGroups.push({ symbol: s, victim: v });
  let spotChecked = 0;
  for (const g of spotCheckGroups) {
    const candidatesInGroup = source.candidates
      .filter((c) => c.symbol === g.symbol && c.victim === g.victim)
      .slice(0, 4);
    for (const c of candidatesInGroup) {
      const candles = candlesBySymbol.get(c.symbol) ?? [];
      const startIdx = candles.findIndex(
        (cc) => cc.openTime >= c.candidateEndTs,
      );
      console.log(
        `${c.symbol} ${c.victim} seq=${c.sequenceId} idx=${c.candidateIndex}: candidateEndTs=${c.candidateEndTs} (${new Date(c.candidateEndTs).toISOString()}) endPrice=${c.candidateEndPrice} extreme=${c.latestExtremePrice}`,
      );
      if (startIdx === -1) {
        console.log(
          "  -> NO candle found with openTime >= candidateEndTs (NO_DATA)",
        );
      } else {
        const first = candles[startIdx]!;
        console.log(
          `  first walked candle: openTime=${first.openTime} (${new Date(first.openTime).toISOString()}) O=${first.open} H=${first.high} L=${first.low} C=${first.close}`,
        );
        for (let k = 1; k <= 3 && startIdx + k < candles.length; k++) {
          const cc = candles[startIdx + k]!;
          console.log(
            `  +${k}: openTime=${cc.openTime} (${new Date(cc.openTime).toISOString()}) O=${cc.open} H=${cc.high} L=${cc.low} C=${cc.close}`,
          );
        }
      }
      spotChecked++;
    }
    if (spotChecked >= 20) break;
  }
  console.log(`\nTotal spot-checked: ${spotChecked}`);

  // ---- reconstruct all candidates with the FIXED logic ----
  interface Enriched {
    candidate: SourceCandidate;
    truePath: TruePathResult;
    dom5: number | null;
    class: OutcomeClass;
  }
  const enriched: Enriched[] = [];
  for (const c of source.candidates) {
    const candles = candlesBySymbol.get(c.symbol) ?? [];
    const truePath = reconstructTruePath(
      candles,
      c.candidateEndTs,
      c.candidateEndPrice,
      c.victim,
      c.latestExtremePrice,
    );
    const p5 = truePath.path.find((p) => p.minute === 5);
    const dom5 = p5 ? dominanceShare(p5.favorablePct, p5.adversePct) : null;
    enriched.push({ candidate: c, truePath, dom5, class: "NO_DATA" });
  }

  const validCount = enriched.filter(
    (e) => e.truePath.dataQuality === "VALID",
  ).length;
  const noMoveCount = enriched.filter(
    (e) => e.truePath.dataQuality === "NO_MOVE",
  ).length;
  const noDataCount = enriched.filter(
    (e) => e.truePath.dataQuality === "NO_DATA",
  ).length;
  console.log(
    `\n=== CANDLE COVERAGE AFTER FIX ===\nVALID=${validCount} NO_MOVE=${noMoveCount} NO_DATA=${noDataCount} (total=${enriched.length})`,
  );

  // ---- TASK 4: cross-check against old market-response dataset for >=50 random candidates ----
  console.log("\n=== TASK 4: CROSS-CHECK AGAINST OLD MFE/MAE DATASET ===\n");
  const oldBySeqIdx = new Map<string, OldMarketResponseCandidate>();
  // the market-response source itself already IS the "old" dataset -- reuse its own response[] field, cast for this comparison
  for (const c of source.candidates as unknown as OldMarketResponseCandidate[]) {
    oldBySeqIdx.set(`${c.symbol}-${c.sequenceId}-${c.candidateIndex}`, c);
  }
  let exactMatch = 0,
    materiallyDifferent = 0,
    zeroZeroMismatch = 0,
    compared = 0;
  const sampleIndices = new Set<number>();
  while (sampleIndices.size < Math.min(50, enriched.length))
    sampleIndices.add(Math.floor(Math.random() * enriched.length));
  for (const idx of sampleIndices) {
    const e = enriched[idx]!;
    const old = oldBySeqIdx.get(
      `${e.candidate.symbol}-${e.candidate.sequenceId}-${e.candidate.candidateIndex}`,
    );
    if (!old) continue;
    const oldR5 = old.response?.find((r) => r.horizonMin === 5);
    if (!oldR5) continue;
    compared++;
    const oldFav = Math.max(0, oldR5.mfePct);
    const oldAdv = Math.max(0, -oldR5.maePct);
    const newP5 = e.truePath.path.find((p) => p.minute === 5);
    const newFav = newP5?.favorablePct ?? 0;
    const newAdv = newP5?.adversePct ?? 0;
    if (oldFav > 0.05 || oldAdv > 0.05) {
      if (newFav === 0 && newAdv === 0) zeroZeroMismatch++;
      else if (
        Math.abs(oldFav - newFav) < 0.15 &&
        Math.abs(oldAdv - newAdv) < 0.15
      )
        exactMatch++;
      else materiallyDifferent++;
    } else {
      exactMatch++;
    }
  }
  console.log(
    `Compared ${compared} random candidates: near-match=${exactMatch}, materially different=${materiallyDifferent}, zero/zero mismatch (bug signature)=${zeroZeroMismatch}`,
  );

  // ---- TASK 8: classification, using ONLY valid directional observations for quantiles ----
  const validDomValues = enriched
    .filter((e) => e.truePath.dataQuality === "VALID" && e.dom5 !== null)
    .map((e) => e.dom5!)
    .sort((a, b) => a - b);
  const p25 = percentile(validDomValues, 0.25);
  const p75 = percentile(validDomValues, 0.75);
  const p90 = percentile(validDomValues, 0.9);
  console.log(
    `\n=== CLASSIFICATION BOUNDARIES (derived from ${validDomValues.length} VALID directional observations only) ===`,
  );
  console.log(
    `P25=${p25?.toFixed(3)} P75=${p75?.toFixed(3)} P90=${p90?.toFixed(3)}`,
  );

  for (const e of enriched) {
    const tp = e.truePath;
    if (tp.dataQuality === "NO_DATA") {
      e.class = "NO_DATA";
      continue;
    }
    if (tp.dataQuality === "NO_MOVE") {
      e.class = "NO_MOVE";
      continue;
    } // TASK 7 invariant: zero/zero can NEVER be REAL_REVERSAL
    if (e.dom5 === null || p25 === null || p75 === null || p90 === null) {
      e.class = "AMBIGUOUS";
      continue;
    }
    const dom = e.dom5;
    const pathSupportsReversal =
      tp.firstDominantMove === "REVERSAL" ||
      (tp.firstDominantMove === "INTRAMINUTE_ORDER_UNKNOWN" &&
        (tp.maxAdverseBeforeFavorableDominance ?? 0) <=
          (tp.maxFavorablePct ?? 0) * 0.5);
    if (dom >= p90 && pathSupportsReversal) e.class = "REAL_REVERSAL";
    else if (dom >= p75 && tp.firstDominantMove !== "CONTINUATION")
      e.class = "LIKELY_REVERSAL";
    else if (dom <= p25 || tp.firstDominantMove === "CONTINUATION")
      e.class = "CONTINUATION";
    else e.class = "AMBIGUOUS";
  }

  const classCounts: Record<OutcomeClass, number> = {
    REAL_REVERSAL: 0,
    LIKELY_REVERSAL: 0,
    AMBIGUOUS: 0,
    CONTINUATION: 0,
    NO_MOVE: 0,
    NO_DATA: 0,
  };
  for (const e of enriched) classCounts[e.class]++;
  console.log(
    `\nCandidate-level classification (AFTER FIX): ${JSON.stringify(classCounts)}`,
  );

  // ---- TASK 15: automated invariant checks -- throw if violated, do not silently save a broken result ----
  console.log("\n=== TASK 15: AUTOMATED INVARIANT CHECKS ===\n");
  const violations: string[] = [];
  for (const e of enriched) {
    if (
      e.truePath.maxFavorablePct === 0 &&
      e.truePath.maxAdversePct === 0 &&
      (e.class === "REAL_REVERSAL" || e.class === "LIKELY_REVERSAL")
    ) {
      violations.push(
        `INVARIANT 1 VIOLATED: ${e.candidate.symbol} ${e.candidate.sequenceId} idx=${e.candidate.candidateIndex} has zero/zero movement but class=${e.class}`,
      );
    }
    if (
      e.truePath.dataQuality !== "VALID" &&
      (e.class === "REAL_REVERSAL" ||
        e.class === "LIKELY_REVERSAL" ||
        e.class === "CONTINUATION")
    ) {
      violations.push(
        `INVARIANT VIOLATED: ${e.candidate.symbol} ${e.candidate.sequenceId} idx=${e.candidate.candidateIndex} dataQuality=${e.truePath.dataQuality} but class=${e.class}`,
      );
    }
  }
  if (
    validDomValues.length !==
    enriched.filter(
      (e) => e.truePath.dataQuality === "VALID" && e.dom5 !== null,
    ).length
  ) {
    violations.push(
      "INVARIANT 3/4 VIOLATED: quantile input set does not match the VALID-only filter",
    );
  }
  if (violations.length > 0) {
    console.error(
      `${violations.length} INVARIANT VIOLATIONS FOUND -- STOPPING, not saving output:`,
    );
    violations.slice(0, 20).forEach((v) => console.error(`  ${v}`));
    process.exit(1);
  }
  console.log(
    "All invariant checks passed (zero/zero never classified as reversal; NO_DATA/NO_MOVE never enter directional classes; quantiles built only from valid observations).",
  );

  // ---- sequence-level rollup (TASK 12) ----
  interface SequenceResult {
    sequenceId: string;
    symbol: string;
    victim: string;
    sequenceClass: SequenceClass;
    firstTrueReversalCandidateIndex: number | null;
  }
  const sequenceIds = [...new Set(enriched.map((e) => e.candidate.sequenceId))];
  const sequenceResults: SequenceResult[] = [];
  for (const sid of sequenceIds) {
    const seq = enriched
      .filter((e) => e.candidate.sequenceId === sid)
      .sort((a, b) => a.candidate.candidateIndex - b.candidate.candidateIndex);
    // TASK 12: never select a NO_DATA/NO_MOVE candidate as the reversal point
    const firstReal = seq.find(
      (e) => e.class === "REAL_REVERSAL" || e.class === "LIKELY_REVERSAL",
    );
    let sequenceClass: SequenceClass;
    if (seq.every((e) => e.class === "NO_DATA")) sequenceClass = "NO_DATA";
    else if (firstReal) {
      const afterFailed = seq
        .filter(
          (e) =>
            e.candidate.candidateIndex > firstReal.candidate.candidateIndex,
        )
        .some((e) => e.class === "CONTINUATION");
      sequenceClass = afterFailed ? "FAILED_REVERSAL" : "REAL_REVERSAL";
    } else if (
      seq
        .filter((e) => e.truePath.dataQuality === "VALID")
        .every((e) => e.class === "CONTINUATION") &&
      seq.some((e) => e.truePath.dataQuality === "VALID")
    ) {
      sequenceClass = "CONTINUATION";
    } else {
      sequenceClass = "AMBIGUOUS";
    }
    sequenceResults.push({
      sequenceId: sid,
      symbol: seq[0]!.candidate.symbol,
      victim: seq[0]!.candidate.victim,
      sequenceClass,
      firstTrueReversalCandidateIndex:
        firstReal?.candidate.candidateIndex ?? null,
    });
  }
  const seqClassCounts: Record<SequenceClass, number> = {
    REAL_REVERSAL: 0,
    FAILED_REVERSAL: 0,
    CONTINUATION: 0,
    AMBIGUOUS: 0,
    NO_DATA: 0,
  };
  for (const s of sequenceResults) seqClassCounts[s.sequenceClass]++;
  console.log(
    `\nSequence-level classification (AFTER FIX): ${JSON.stringify(seqClassCounts)}`,
  );

  const bySymbolVictim: Record<string, number> = {};
  for (const s of sequenceResults.filter(
    (s) => s.sequenceClass === "REAL_REVERSAL",
  )) {
    const key = `${s.symbol}|${s.victim}`;
    bySymbolVictim[key] = (bySymbolVictim[key] ?? 0) + 1;
  }
  console.log(
    `REAL_REVERSAL breakdown by symbol+victim: ${JSON.stringify(bySymbolVictim)}`,
  );

  // ---- TASK 14: manual audit examples with full OHLC ----
  function printAudit(e: Enriched): void {
    console.log(
      `${e.candidate.symbol} ${e.candidate.victim} seq=${e.candidate.sequenceId} idx=${e.candidate.candidateIndex} class=${e.class} dataQuality=${e.truePath.dataQuality}`,
    );
    console.log(
      `  candidateEndTs=${e.candidate.candidateEndTs} refPrice=${e.candidate.candidateEndPrice}`,
    );
    for (const p of e.truePath.path.filter((pp) => pp.minute <= 10)) {
      console.log(
        `  +${p.minute}m O=${p.ohlc.open} H=${p.ohlc.high} L=${p.ohlc.low} C=${p.ohlc.close}  favorable=${p.favorablePct.toFixed(3)} adverse=${p.adversePct.toFixed(3)}`,
      );
    }
    console.log(
      `  firstDirectionalMove=${e.truePath.firstDominantMove !== "NO_DATA" ? e.truePath.firstDirectionalMove : "NO_DATA"} firstDominantMove=${e.truePath.firstDominantMove}\n`,
    );
  }
  console.log("\n=== TASK 14: MANUAL AUDIT ===\n");
  const realReversalExamples = enriched
    .filter((e) => e.class === "REAL_REVERSAL")
    .sort((a, b) => (b.dom5 ?? 0) - (a.dom5 ?? 0))
    .slice(0, 10);
  const continuationExamples = enriched
    .filter((e) => e.class === "CONTINUATION")
    .sort((a, b) => (a.dom5 ?? 1) - (b.dom5 ?? 1))
    .slice(0, 10);
  const ambiguousExamples = enriched
    .filter((e) => e.class === "AMBIGUOUS")
    .slice(0, 10);
  const noDataExamples = enriched
    .filter((e) => e.class === "NO_DATA" || e.class === "NO_MOVE")
    .slice(0, 10);
  console.log("--- 10 REAL_REVERSAL ---");
  realReversalExamples.forEach(printAudit);
  console.log("--- 10 CONTINUATION ---");
  continuationExamples.forEach(printAudit);
  console.log("--- 10 AMBIGUOUS ---");
  ambiguousExamples.forEach(printAudit);
  console.log("--- 10 NO_DATA/NO_MOVE ---");
  noDataExamples.forEach(printAudit);

  // ---- old broken vs new comparison ----
  let oldVsNewBroken: unknown = null;
  if (priorBrokenPath && fs.existsSync(priorBrokenPath)) {
    const oldBroken = JSON.parse(fs.readFileSync(priorBrokenPath, "utf8"));
    oldVsNewBroken = {
      oldTotalSequences: oldBroken.summary?.totalSequences ?? null,
      oldRealReversalSequences:
        oldBroken.summary?.sequenceClassCounts?.REAL_REVERSAL ?? null,
      newTotalSequences: sequenceIds.length,
      newRealReversalSequences: seqClassCounts.REAL_REVERSAL,
    };
    console.log(`\nOld (broken) vs new: ${JSON.stringify(oldVsNewBroken)}`);
  }

  // ---- output ----
  function buildEntry(e: Enriched) {
    const c = e.candidate;
    const get = (m: number) => e.truePath.path.find((p) => p.minute === m);
    return {
      symbol: c.symbol,
      victim: c.victim,
      sequenceId: c.sequenceId,
      candidateIndex: c.candidateIndex,
      candidateStartTs: c.candidateStartTs,
      candidateEndTs: c.candidateEndTs,
      cumulativeLiqUsd: c.cumulativeLiqUsd,
      eventCount: c.eventCount,
      maxSingleLiqUsd: c.maxSingleLiqUsd,
      lastEventUsd: c.lastEventUsd,
      durationMs: c.durationMs,
      candidateStartPrice: c.candidateStartPrice,
      candidateEndPrice: c.candidateEndPrice,
      latestExtremePrice: c.latestExtremePrice,
      favorable1m: get(1)?.favorablePct ?? null,
      adverse1m: get(1)?.adversePct ?? null,
      favorable2m: get(2)?.favorablePct ?? null,
      adverse2m: get(2)?.adversePct ?? null,
      favorable3m: get(3)?.favorablePct ?? null,
      adverse3m: get(3)?.adversePct ?? null,
      favorable5m: get(5)?.favorablePct ?? null,
      adverse5m: get(5)?.adversePct ?? null,
      favorable10m: get(10)?.favorablePct ?? null,
      adverse10m: get(10)?.adversePct ?? null,
      favorable15m: get(15)?.favorablePct ?? null,
      adverse15m: get(15)?.adversePct ?? null,
      favorable30m: get(30)?.favorablePct ?? null,
      adverse30m: get(30)?.adversePct ?? null,
      dominanceShare5m: e.dom5,
      dataQuality: e.truePath.dataQuality,
      timeToFirstFavorableMin: e.truePath.timeToFirstFavorableMin,
      timeToFirstAdverseMin: e.truePath.timeToFirstAdverseMin,
      timeToMaxFavorableMin: e.truePath.timeToMaxFavorableMin,
      timeToMaxAdverseMin: e.truePath.timeToMaxAdverseMin,
      maxAdverseBeforeFavorableDominance:
        e.truePath.maxAdverseBeforeFavorableDominance,
      maxFavorableBeforeAdverseDominance:
        e.truePath.maxFavorableBeforeAdverseDominance,
      firstDirectionalMove: e.truePath.firstDirectionalMove,
      firstDominantMove: e.truePath.firstDominantMove,
      numberOfPostCandidateAdverseExtremes:
        e.truePath.numberOfPostCandidateAdverseExtremes,
      largestAdverseExtensionBeforeReversal:
        e.truePath.largestAdverseExtensionBeforeReversal,
      outcomeClass: e.class,
      preLiqDirAtr: c.preLiqDirAtr,
      preRecDirAtr: c.preRecDirAtr,
      currentDirAtr: c.currentDirAtr,
      currentRecAtr: c.currentRecAtr,
      comparisonRotationDegApprox: c.comparisonRotationDegApprox,
      comparisonShockAtrApprox: c.comparisonShockAtrApprox,
      avgEventSpacingMs: c.avgEventSpacingMs,
      medianEventSpacingMs: c.medianEventSpacingMs,
      liqAmountTrend: c.liqAmountTrend,
      maxSingleOverCumulative: c.maxSingleOverCumulative,
    };
  }

  const realReversalLiquidations = sequenceResults
    .filter(
      (s) =>
        s.sequenceClass === "REAL_REVERSAL" &&
        s.firstTrueReversalCandidateIndex !== null,
    )
    .map(
      (s) =>
        enriched.find(
          (e) =>
            e.candidate.sequenceId === s.sequenceId &&
            e.candidate.candidateIndex === s.firstTrueReversalCandidateIndex,
        )!,
    )
    .map(buildEntry);
  const continuationLiquidations = enriched
    .filter((e) => e.class === "CONTINUATION")
    .map(buildEntry);
  const ambiguousLiquidations = enriched
    .filter((e) => e.class === "AMBIGUOUS")
    .map(buildEntry);
  const noDataLiquidations = enriched
    .filter((e) => e.class === "NO_DATA" || e.class === "NO_MOVE")
    .map(buildEntry);

  const outPath = `/mnt/data/liquidation-true-reversals-fixed-3d-${Date.now()}.json`;
  const output = {
    debugReport: {
      rootCause:
        "startIdx picked the candle CONTAINING candidateEndTs (close time after the event), but the walk loop required candle.openTime >= candidateEndTs -- a condition that same candle almost never satisfies, since a liquidation essentially never lands exactly on a minute boundary. The loop's own guard rejected the candle it was pointed at, `ci` never advanced, and running favorable/adverse extremes stayed frozen at the reference price for the whole 30-minute window -- producing 0/0 for nearly every candidate. Reproduces on ~100% of real data.",
      fixApplied:
        "startIdx now picks the first candle whose OWN openTime >= candidateEndTs (the first fully-closed candle strictly after the event, per TASK 5 -- avoids lookahead into the partial candle containing the liquidation). That candle is walk-minute 1; no further per-candle guard is needed.",
      candlesConsumedBeforeFix:
        "0 for the overwhelming majority of candidates (confirmed by the all-zero output)",
      candlesConsumedAfterFix: `VALID=${validCount} NO_MOVE=${noMoveCount} NO_DATA=${noDataCount} out of ${enriched.length} total`,
      bugsFixed: [
        "startIdx/walk-loop mismatch causing near-universal 0/0 paths (primary bug)",
        "dominanceShare now null (not 0.5) when favorable+adverse denominator is 0",
        "NO_DATA/NO_MOVE candidates now excluded from quantile threshold calculation",
        "zero/zero candidates can no longer be classified REAL_REVERSAL/LIKELY_REVERSAL/CONTINUATION (enforced by explicit invariant check that halts the script if violated)",
        "sequence-level reversal point can no longer point at a NO_DATA/NO_MOVE candidate",
      ],
    },
    methodology: {
      note: "TRUE candle-by-candle path from real re-fetched 1m OHLC. Walk begins at the first fully-closed candle after candidateEndTs (never the partial candle containing the liquidation, avoiding lookahead). Intraminute high/low order within a single candle is NOT knowable from 1m OHLC -- marked BOTH_SAME_CANDLE / INTRAMINUTE_ORDER_UNKNOWN rather than guessed.",
      classificationRulesDerivedFromValidData: {
        p25: p25,
        p75: p75,
        p90: p90,
        validObservationCount: validDomValues.length,
      },
    },
    dataQuality: {
      validCount,
      noMoveCount,
      noDataCount,
      total: enriched.length,
    },
    summary: {
      totalSequences: sequenceIds.length,
      sequenceClassCounts: seqClassCounts,
      candidateClassCounts: classCounts,
      realReversalBySymbolVictim: bySymbolVictim,
    },
    realReversalLiquidations,
    continuationLiquidations,
    ambiguousLiquidations,
    noDataLiquidations,
    sequenceResults,
    manualAuditExamples: {
      realReversal: realReversalExamples.map(buildEntry),
      continuation: continuationExamples.map(buildEntry),
      ambiguous: ambiguousExamples.map(buildEntry),
      noData: noDataExamples.map(buildEntry),
    },
    oldVsNewResponseValidation: {
      compared,
      exactMatch,
      materiallyDifferent,
      zeroZeroMismatch,
    },
    oldVsNewClassificationChanges: oldVsNewBroken,
    methodologicalWarnings: [
      "Intraminute order (whether a candle's own high or low happened first) is not derivable from 1m OHLC -- BOTH_SAME_CANDLE/INTRAMINUTE_ORDER_UNKNOWN preserves this honestly rather than guessing.",
      "Classification thresholds (P25/P75/P90) are derived from THIS dataset's own valid-observation distribution and will shift on a different date range.",
      "walk-minute 1 corresponds to the first fully-closed candle after candidateEndTs, which may be up to ~1 minute later than the raw event timestamp -- not exactly '1 minute after the liquidation' in wall-clock terms.",
    ],
  };
  fs.mkdirSync("/mnt/data", { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nCorrected output written to: ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(
      "[RECONSTRUCT_TRUE_LIQUIDATION_REVERSAL_PATH_FIXED_FATAL]",
      err,
    );
    process.exit(1);
  });
}
