// BTC REAL-END DISCOVERY (SCALE-MATCHED COMPARISON) -- corrects the
// rejected "min(training OI)" rule. Fixed 10-minute baseline (START,
// liquidation aggregation, P90) REUSED VERBATIM, untouched.
//
// ============================================================
// CORRECTED MECHANISM -- "comparable OI force" (zero new parameters):
//
//  REFERENCE (X, Y): updated to the MOST RECENT adverse-direction
//  MOVEMENT's own literal numbers every time such a movement
//  completes -- X = that movement's own |ΔOI|, Y = that movement's
//  own |ΔPrice|. This is exactly "the latest learned response"
//  (e.g. "100 BTC -> -0.13%"), taken directly from the data, not a
//  model-interpolated or invented value.
//
//  ACCUMULATION: starting immediately after the reference movement,
//  accumulate RAW subsequent ticks (regardless of their own local
//  direction) into:
//    cumGrossOiSinceRef  = running Σ|ΔOI| since the reference point
//    favProgressSinceRef = current signed price progress (in the
//                          FAVORABLE direction) from the reference
//                          point's own price to the current price
//
//  TEST: the FIRST tick where cumGrossOiSinceRef reaches >= X is the
//  test point. At that exact point:
//    favProgressSinceRef >= Y  ->  REAL END (comparable OI force, X,
//                                   produced comparable-or-greater
//                                   favorable response, Y)
//    favProgressSinceRef <  Y  ->  test FAILED; the reference is
//                                   abandoned (X,Y cleared) until the
//                                   NEXT adverse movement establishes
//                                   a fresh reference.
//
//  Any new adverse-direction movement immediately resets (X,Y) and
//  the accumulators to a fresh start, regardless of what stage the
//  previous accumulation was in.
//
//  No fixed time window, no multiplier, no tolerance, no minimum, no
//  bucket, no new segmentation rule -- X and Y come directly from the
//  most recent real adverse movement, nothing else.
//
//   node scripts/btc-real-end-scale-matched.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No
// files created. Text output only.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const EVAL_DAYS = 3;
const BASELINE_DAYS = 3;
const WINDOW_MS = 10 * 60 * 1000;
const MIN_LIVE_SAMPLE = 5;
const SEARCH_CAP_MIN = 180; // disclosed computational safety bound only

function fmtDate(ms) {
  return ms === null || ms === undefined
    ? "N/A"
    : new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
function fmtPrice(n) {
  return n === null || n === undefined
    ? "N/A"
    : n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}
function fmtUsd(n) {
  return n === null || n === undefined
    ? "N/A"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtBtc(n) {
  return n === null || n === undefined
    ? "N/A"
    : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(5)}%`;
}
function fmtSec(ms) {
  return ms === null ? "N/A" : `${(ms / 1000).toFixed(1)}s`;
}
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}
function median(arr) {
  const s = [...arr]
    .filter((v) => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  return percentile(s, 50);
}
function priceAtOrBeforeIdx(obs, idx) {
  for (let k = idx; k >= 0; k--) if (obs[k].price !== null) return obs[k].price;
  return null;
}
function nearestObsIdxAtOrBefore(obs, targetMs, fromIdx = 0) {
  let best = -1;
  for (let k = fromIdx; k < obs.length; k++) {
    if (obs[k].ts <= targetMs) best = k;
    else break;
  }
  return best;
}

/** Single forward pass. Detects adverse-direction MOVEMENTS (own
 *  price field only, no backfill) to update the (X,Y) reference, and
 *  simultaneously accumulates raw-tick OI/price since that reference
 *  to test for REAL END, exactly as described above. Returns a full
 *  trace of every reference update and every test outcome. */
function findRealEnd(allOi, startIdx, adverseDir, capIdx) {
  const trace = [];
  let result = null;

  let runSign = null,
    runStartIdx = null,
    runOiSum = 0;
  let X = null,
    Y = null,
    refIdx = null,
    refPrice = null,
    refTs = null;
  let cumGrossOiSinceRef = 0;

  function evaluateMovement(mvStartIdx, mvEndIdx) {
    const p0 = allOi[mvStartIdx].price,
      p1 = allOi[mvEndIdx].price;
    if (p0 === null || p1 === null) return; // skip, no own-price data
    const absOi = Math.abs(runOiSum);
    const dPriceLog = Math.log(p1 / p0) * 100;
    const isAdverse = adverseDir === "down" ? dPriceLog < 0 : dPriceLog > 0;
    if (isAdverse) {
      X = absOi;
      Y = Math.abs(dPriceLog);
      refIdx = mvEndIdx;
      refPrice = p1;
      refTs = allOi[mvEndIdx].ts;
      cumGrossOiSinceRef = 0;
      trace.push({
        type: "REFERENCE_UPDATE",
        ts: refTs,
        X,
        Y,
        movementStart: allOi[mvStartIdx].ts,
        movementEnd: allOi[mvEndIdx].ts,
      });
    }
  }

  for (let k = startIdx + 1; k <= capIdx; k++) {
    const dOi = allOi[k].contracts - allOi[k - 1].contracts;
    if (dOi === 0) continue;
    const sign = dOi > 0 ? 1 : -1;

    if (runSign === null) {
      runSign = sign;
      runStartIdx = k - 1;
      runOiSum = dOi;
    } else if (sign === runSign) {
      runOiSum += dOi;
    } else {
      evaluateMovement(runStartIdx, k - 1);
      runSign = sign;
      runStartIdx = k - 1;
      runOiSum = dOi;
    }

    if (X !== null) {
      cumGrossOiSinceRef += Math.abs(dOi);
      const currentPrice = allOi[k].price;
      if (currentPrice !== null && cumGrossOiSinceRef >= X) {
        const favProgress =
          adverseDir === "down"
            ? (currentPrice / refPrice - 1) * 100
            : (refPrice / currentPrice - 1) * 100;
        const passed = favProgress >= Y;
        trace.push({
          type: "TEST",
          ts: allOi[k].ts,
          X,
          Y,
          cumGrossOiSinceRef,
          favProgress,
          passed,
          refTs,
          price: currentPrice,
        });
        if (passed) {
          result = {
            ts: allOi[k].ts,
            X,
            Y,
            favProgress,
            price: currentPrice,
            refTs,
          };
          break;
        } else {
          X = null;
          Y = null;
          cumGrossOiSinceRef = 0;
        } // abandon, wait for next adverse movement
      }
    }
  }
  // close any trailing run without a final movement eval needed (no further reference update required after loop end)
  return { trace, result };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(170));
  console.log(
    "FIXED 10-MINUTE BASELINE UNCHANGED. REAL-END: scale-matched comparison, X/Y taken directly from the latest adverse movement.",
  );
  console.log("=".repeat(170));

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;
  const loadEndMs = evalEndMs + SEARCH_CAP_MIN * 60_000;

  const allLiq = await liqCol
    .find({ symbol: SYMBOL, timestamp: { $gte: loadStartMs, $lte: evalEndMs } })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const allOiRaw = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: {
        $gte: new Date(loadStartMs - 65000),
        $lte: new Date(loadEndMs),
      },
    })
    .project({ timestamp: 1, openInterest: 1, price: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const allOi = allOiRaw.map((d) => ({
    ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
    contracts: d.openInterest,
    price: d.price,
  }));
  console.log(
    `DATASET: raw liquidation events=${allLiq.length}  OI+price observations=${allOi.length}`,
  );
  if (allLiq.length === 0 || allOi.length < 10) {
    console.log("Insufficient data.");
    await client.close();
    return;
  }

  // ---- FIXED 10-MINUTE BASELINE (verbatim, untouched) ----
  const candidates = [];
  let liqIdx = 0;
  while (liqIdx < allLiq.length) {
    const startEvent = allLiq[liqIdx];
    const direction = startEvent.victim;
    const startTs = startEvent.timestamp;
    const endTs = startTs + WINDOW_MS;
    const events = [];
    while (liqIdx < allLiq.length && allLiq[liqIdx].timestamp <= endTs) {
      events.push(allLiq[liqIdx]);
      liqIdx++;
    }
    const startIdx = nearestObsIdxAtOrBefore(allOi, startTs);
    const endIdx = nearestObsIdxAtOrBefore(allOi, endTs);
    let priceStart = null,
      priceEnd = null;
    if (startIdx >= 0 && endIdx >= 0 && endIdx >= startIdx) {
      priceStart = priceAtOrBeforeIdx(allOi, startIdx);
      priceEnd = priceAtOrBeforeIdx(allOi, endIdx);
    }
    const dirLiqUsd = events
      .filter((e) => e.victim === direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    candidates.push({
      direction,
      startTs,
      endTs,
      dirLiqUsd,
      eventCount: events.length,
      priceStart,
      priceEnd,
      startIdx,
      endIdx,
    });
  }

  console.log(
    `${"=".repeat(170)}\nSTRICT BASELINE SELF-VERIFICATION\n${"=".repeat(170)}`,
  );
  const knownChecks = [
    {
      label: "EP31 (02:24:27->02:34:27 LONG)",
      startTs: Date.parse("2026-09-20T02:24:27Z"),
      endTs: Date.parse("2026-09-20T02:34:27Z"),
      direction: "LONG",
      expectedUsd: 933038.8,
    },
    {
      label: "EP32 (02:35:59->02:45:59 LONG)",
      startTs: Date.parse("2026-09-20T02:35:59Z"),
      endTs: Date.parse("2026-09-20T02:45:59Z"),
      direction: "LONG",
      expectedUsd: 1138305.8,
    },
    {
      label: "EP33 (03:08:05->03:18:05 LONG)",
      startTs: Date.parse("2026-09-20T03:08:05Z"),
      endTs: Date.parse("2026-09-20T03:18:05Z"),
      direction: "LONG",
      expectedUsd: 557426.62,
    },
  ];
  let verificationFailed = false;
  for (const chk of knownChecks) {
    const match = candidates.find(
      (c) =>
        c.direction === chk.direction &&
        Math.abs(c.startTs - chk.startTs) < 2000 &&
        Math.abs(c.endTs - chk.endTs) < 2000,
    );
    if (!match) {
      console.log(`${chk.label}: NOT FOUND -- FAIL`);
      verificationFailed = true;
      continue;
    }
    const diff = Math.abs(match.dirLiqUsd - chk.expectedUsd);
    const ok = diff < 500;
    console.log(
      `${chk.label}: found dirLiqUsd=${fmtUsd(match.dirLiqUsd)} expected=${fmtUsd(chk.expectedUsd)} ${ok ? "PASS" : "FAIL"}`,
    );
    if (!ok) verificationFailed = true;
  }
  if (verificationFailed) {
    console.log("\nBASELINE VERIFICATION FAILED. STOPPING.");
    await client.close();
    return;
  }
  console.log("\nBaseline verification PASSED.\n");

  const longC = candidates
    .filter((c) => c.direction === "LONG")
    .sort((a, b) => a.endTs - b.endTs);
  const shortC = candidates
    .filter((c) => c.direction === "SHORT")
    .sort((a, b) => a.endTs - b.endTs);
  function applyRolling(cs) {
    cs.forEach((c, idx) => {
      const prior = cs
        .slice(0, idx)
        .filter(
          (p) =>
            p.endTs >= c.endTs - BASELINE_DAYS * 86_400_000 &&
            p.endTs < c.endTs,
        );
      c.liveEvaluable = c.endTs >= evalStartMs;
      if (prior.length < MIN_LIVE_SAMPLE) {
        c.decision = null;
        return;
      }
      const vals = prior.map((p) => p.dirLiqUsd).sort((a, b) => a - b);
      c.causalP90 = percentile(vals, 90);
      c.decision = c.dirLiqUsd >= c.causalP90 ? "KEEP_P90" : "DROP_BELOW_P90";
    });
  }
  applyRolling(longC);
  applyRolling(shortC);
  const p90Candidates = [...longC, ...shortC]
    .filter(
      (c) =>
        c.liveEvaluable && c.decision === "KEEP_P90" && c.priceStart !== null,
    )
    .sort((a, b) => a.startTs - b.startTs);
  p90Candidates.forEach((c, i) => {
    c.id = `P${String(i + 1).padStart(3, "0")}`;
  });
  console.log(
    `KEEP_P90 candidates (baseline unchanged): ${p90Candidates.length}\n`,
  );

  // ============================================================
  // MANUAL TRACE -- 3 requested candidates ONLY (per instruction, do
  // not run/summarize the full dataset yet)
  // ============================================================
  console.log(
    `${"=".repeat(200)}\nMANUAL TRACE -- 3 REQUESTED CANDIDATES\n${"=".repeat(200)}`,
  );
  const traceTargets = [
    Date.parse("2026-09-20T02:24:27Z"),
    Date.parse("2026-09-20T02:35:59Z"),
    Date.parse("2026-09-20T03:08:05Z"),
  ];
  for (const ts of traceTargets) {
    const c = p90Candidates.find((x) => Math.abs(x.startTs - ts) < 2000);
    if (!c) {
      console.log(`\nSTART=${fmtDate(ts)}: NOT in KEEP_P90 set.`);
      continue;
    }
    const adverseDir = c.direction === "LONG" ? "down" : "up";
    const capTs = c.startTs + SEARCH_CAP_MIN * 60000;
    const capIdx = nearestObsIdxAtOrBefore(allOi, capTs, c.startIdx);
    const { trace, result } = findRealEnd(
      allOi,
      c.startIdx,
      adverseDir,
      capIdx,
    );

    console.log(`\n${"#".repeat(80)}`);
    console.log(
      `START: ${fmtDate(c.startTs)}   Fixed-10m candidate END: ${fmtDate(c.endTs)}   Total liquidation USD: ${fmtUsd(c.dirLiqUsd)}`,
    );
    console.log(`\nReference updates and tests, chronological:`);
    trace.forEach((t) => {
      if (t.type === "REFERENCE_UPDATE") {
        console.log(
          `  [REFERENCE UPDATE @ ${fmtDate(t.ts)}]  latest adverse movement (${fmtDate(t.movementStart)} -> ${fmtDate(t.movementEnd)}):  X=|ΔOI|=${fmtBtc(t.X)} BTC   Y=|ΔPrice|=${fmtPct(t.Y)}`,
        );
      } else {
        console.log(
          `    TEST @ ${fmtDate(t.ts)}: cumGrossOiSinceRef reached ${fmtBtc(t.cumGrossOiSinceRef)} BTC (>= X=${fmtBtc(t.X)})  favProgressSinceRef=${fmtPct(t.favProgress)}  vs Y=${fmtPct(t.Y)}  =>  ${t.passed ? "PASS -- REAL END" : "FAIL -- reference abandoned, waiting for next adverse movement"}`,
        );
      }
    });
    if (result) {
      console.log(`\nREAL END: ${fmtDate(result.ts)}`);
      console.log(
        `  Comparable OI force used: X=${fmtBtc(result.X)} BTC (from reference set at ${fmtDate(result.refTs)})`,
      );
      console.log(
        `  Learned adverse response at that scale: Y=${fmtPct(result.Y)}`,
      );
      console.log(
        `  Actual favorable response at matching scale: ${fmtPct(result.favProgress)}`,
      );
      console.log(
        `  Comparison: X BTC -> -${result.Y.toFixed(5)}%  (learned)   vs   comparable X BTC -> +${result.favProgress.toFixed(5)}%  (actual)`,
      );
    } else {
      console.log(
        `\nREAL END: not found within ${SEARCH_CAP_MIN}min search cap (UNRESOLVED).`,
      );
    }
  }

  console.log(`\n${"=".repeat(170)}`);
  console.log(
    "Per instruction: full dataset NOT run yet. Verify the 3 traces above first.",
  );
  console.log("=".repeat(170));

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
