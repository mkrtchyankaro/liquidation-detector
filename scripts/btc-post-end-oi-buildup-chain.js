// BTC POST-END OI BUILD-UP CHAIN -- new, standalone research script.
// Fixed 10-minute liquidation baseline REUSED VERBATIM, unmodified.
// Does NOT use f_END or any prior post-END detector logic.
//
// RULE (exactly as specified, zero invented magnitude thresholds):
//   Starting right after episode END, walk consecutive raw OI ticks.
//     ΔOI == 0  -> skip (no information, chain unaffected)
//     ΔOI > 0   -> append to the chain, continue
//     ΔOI < 0   -> STOP (the first strictly-negative tick ends it)
//   "Meaningful" ΔOI<0 = any non-zero negative tick -- no magnitude
//   threshold is invented; zero-delta ticks are simply skipped as
//   carrying no directional information, which is the only sense in
//   which a threshold-free reading of "meaningful" is possible here.
//
//   node scripts/btc-post-end-oi-buildup-chain.js
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
const SAFETY_CAP_MIN = 180; // disclosed DATA-LOADING/computation safety bound only -- not part of the stop rule itself

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
function fmtBtcDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
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
    "RESEARCH ONLY -- fixed baseline unchanged. Chain rule: consecutive ΔOI>0 continues, first ΔOI<0 stops. No fixed minutes, no magnitude threshold.",
  );
  console.log("=".repeat(170));

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;
  const loadEndMs = evalEndMs + SAFETY_CAP_MIN * 60_000;

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

  // ---- Baseline construction (verbatim) ----
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
  const allCandidates = [...longC, ...shortC]
    .filter((c) => c.liveEvaluable && c.priceStart !== null)
    .sort((a, b) => a.startTs - b.startTs);
  allCandidates.forEach((c, i) => {
    c.id = `E${String(i + 1).padStart(3, "0")}`;
  });
  console.log(`ALL live-evaluable episodes: ${allCandidates.length}\n`);

  // ============================================================
  // POST-END OI BUILD-UP CHAIN
  // ============================================================
  for (const c of allCandidates) {
    const capTs = c.endTs + SAFETY_CAP_MIN * 60000;
    const capIdx = nearestObsIdxAtOrBefore(allOi, capTs, c.endIdx);
    if (capIdx < c.endIdx) {
      c.chain = null;
      continue;
    }

    const chain = [];
    let cumOi = 0,
      cumPriceLog = 0;
    let stopTs = null,
      stopIdx = null,
      stopReason = null;
    let prevIdx = c.endIdx;

    for (let k = c.endIdx + 1; k <= capIdx; k++) {
      const p = priceAtOrBeforeIdx(allOi, k);
      const pPrev = priceAtOrBeforeIdx(allOi, prevIdx);
      if (p === null || pPrev === null) {
        prevIdx = k;
        continue;
      }
      const dOi = allOi[k].contracts - allOi[prevIdx].contracts;
      if (dOi === 0) {
        prevIdx = k;
        continue;
      } // skip -- no information, chain unaffected
      if (dOi < 0) {
        stopTs = allOi[k].ts;
        stopIdx = k;
        stopReason = "FIRST_NEGATIVE_DELTA";
        break;
      }
      // dOi > 0
      const dPriceLog = Math.log(p / pPrev) * 100;
      cumOi += dOi;
      cumPriceLog += dPriceLog;
      chain.push({
        ts: allOi[k].ts,
        dOi,
        cumOi,
        price: p,
        dPriceLog,
        cumPriceLog,
        durationFromEndMs: allOi[k].ts - c.endTs,
      });
      prevIdx = k;
    }
    if (stopTs === null) stopReason = "UNRESOLVED_SAFETY_CAP_REACHED";

    c.chain = chain;
    c.stopTs = stopTs;
    c.stopReason = stopReason;
    c.stopPrice = stopIdx !== null ? priceAtOrBeforeIdx(allOi, stopIdx) : null;
  }

  // ============================================================
  // PER-EPISODE OUTPUT
  // ============================================================
  console.log(
    `${"=".repeat(200)}\nPER-EPISODE END->STOP CHAIN\n${"=".repeat(200)}`,
  );
  allCandidates.forEach((c) => {
    if (!c.chain) {
      console.log(`\n${c.id}: no usable data.`);
      return;
    }
    console.log(
      `\n${c.id}  ${c.direction}  END=${fmtDate(c.endTs)}  priceEnd=${fmtPrice(c.priceEnd)}`,
    );
    console.log(
      `Chain length: ${c.chain.length} positive ΔOI ticks   STOP reason: ${c.stopReason}   STOP timestamp: ${fmtDate(c.stopTs)}`,
    );
    if (c.chain.length === 0) {
      console.log(
        "  (empty chain -- first post-END tick was already a negative ΔOI, or no ΔOI>0 occurred before stop)",
      );
    } else {
      console.log(
        "TIME                      | ΔOI       | cumΔOI     | price      | ΔPrice%    | cumΔPrice% | duration",
      );
      c.chain.forEach((r) => {
        console.log(
          `${fmtDate(r.ts)} | ${fmtBtcDelta(r.dOi).padEnd(9)} | ${fmtBtcDelta(r.cumOi).padEnd(10)} | ${fmtPrice(r.price).padEnd(10)} | ${fmtPct(r.dPriceLog).padEnd(10)} | ${fmtPct(r.cumPriceLog).padEnd(10)} | ${fmtSec(r.durationFromEndMs)}`,
        );
      });
    }
    if (c.stopTs !== null) console.log(`STOP: price=${fmtPrice(c.stopPrice)}`);
  });

  // ============================================================
  // AGGREGATE SUMMARY
  // ============================================================
  console.log(`\n${"=".repeat(170)}\nAGGREGATE SUMMARY\n${"=".repeat(170)}`);
  const withChain = allCandidates.filter((c) => c.chain);
  const resolved = withChain.filter(
    (c) => c.stopReason === "FIRST_NEGATIVE_DELTA",
  );
  const unresolved = withChain.filter(
    (c) => c.stopReason === "UNRESOLVED_SAFETY_CAP_REACHED",
  );
  console.log(
    `Episodes with usable chain: ${withChain.length}   resolved (stopped by negative ΔOI): ${resolved.length}   unresolved (hit ${SAFETY_CAP_MIN}min safety cap): ${unresolved.length}`,
  );

  const chainLengths = resolved.map((c) => c.chain.length);
  const cumOiAtStop = resolved.map((c) =>
    c.chain.length > 0 ? c.chain[c.chain.length - 1].cumOi : 0,
  );
  const cumPriceAtStop = resolved.map((c) =>
    c.chain.length > 0 ? c.chain[c.chain.length - 1].cumPriceLog : 0,
  );
  const durationAtStop = resolved.map((c) => c.stopTs - c.endTs);
  console.log(
    `\nChain length (positive-ΔOI tick count): median=${median(chainLengths)}  P25=${percentile(
      [...chainLengths].sort((a, b) => a - b),
      25,
    )}  P75=${percentile(
      [...chainLengths].sort((a, b) => a - b),
      75,
    )}`,
  );
  console.log(
    `Cumulative ΔOI at STOP: median=${fmtBtcDelta(median(cumOiAtStop))}`,
  );
  console.log(
    `Cumulative ΔPrice at STOP: median=${fmtPct(median(cumPriceAtStop))}`,
  );
  console.log(`Duration END->STOP: median=${fmtSec(median(durationAtStop))}`);

  const emptyChains = resolved.filter((c) => c.chain.length === 0).length;
  console.log(
    `\nEpisodes with an EMPTY chain (immediate negative ΔOI post-END, no build-up at all): ${emptyChains} of ${resolved.length}`,
  );

  console.log(`\n${"=".repeat(170)}\nRUN COMPLETED SUCCESSFULLY`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
