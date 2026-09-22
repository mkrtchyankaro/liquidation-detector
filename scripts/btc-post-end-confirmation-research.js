// BTC POST-END CONFIRMATION/REJECTION RESEARCH -- new, standalone,
// RESEARCH ONLY (not production code). Fixed 10-minute liquidation
// baseline REUSED VERBATIM, unmodified. Does NOT reuse the discarded
// f_END/implied-move calculation from earlier -- a fresh, purpose-
// built post-END confirmation stage.
//
// ============================================================
// POST-END CONFIRMATION (causal, self-relative, no fixed time window):
//
//  Starting AT episode END (not before), track, using ONLY
//  observations after END:
//    cumGrossOI_postEnd(t)     = Σ|ΔOI| from END to t
//    cumDirProgress_postEnd(t) = signed % price progress in the
//                                 ORIGINAL liquidation direction from
//                                 priceEnd to price(t) (positive =
//                                 still adverse, negative = favorable)
//
//  RECENT WINDOW: the most recent 25% of cumGrossOI_postEnd(t)
//  accumulated so far (same self-relative-window convention used
//  throughout this research thread), found via a monotonic
//  two-pointer scan.
//    recentEfficiency_postEnd(t) = (cumDirProgress(t)-cumDirProgress(ref))
//                                 / (cumGrossOI(t)-cumGrossOI(ref))
//
//  CONFIRMED: the FIRST post-END timestamp where
//  recentEfficiency_postEnd(t) < 0 (strictly negative) -- recent
//  post-END OI activity is now net-associated with FAVORABLE price
//  movement. Zero-parameter, sign-based -- no fixed +1 minute, no
//  magic percentage.
//
//  REJECTED: no such point found within RESEARCH_CAP_MIN minutes
//  after END. This cap is a DISCLOSED OPERATIONAL RESEARCH BOUND
//  (like the earlier FINISHED/DROP_TIMEOUT distinction in this
//  research thread), not a market claim.
//
//   node scripts/btc-post-end-confirmation-research.js
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
const RECENT_WINDOW_FRACTION = 0.25; // same convention reused throughout this research thread
const RESEARCH_CAP_MIN = 60; // disclosed operational research bound, NOT a market claim
const POST_CONFIRM_HORIZONS_MIN = [5, 10, 30];

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
    : n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
}
function fmtMin(n) {
  return n === null || n === undefined ? "N/A" : `${n.toFixed(1)}m`;
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
    "This is a RESEARCH script, NOT production code. Fixed 10-minute baseline unchanged.",
  );
  console.log("=".repeat(170));

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;
  const loadEndMs = evalEndMs + RESEARCH_CAP_MIN * 60_000;

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
        c.causalP90 = null;
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
  // POST-END CONFIRMATION / REJECTION
  // ============================================================
  for (const c of allCandidates) {
    const revUp = c.direction === "LONG";
    const capTs = c.endTs + RESEARCH_CAP_MIN * 60000;
    const capIdx = nearestObsIdxAtOrBefore(allOi, capTs, c.endIdx);
    if (capIdx < c.endIdx) {
      c.result = "INSUFFICIENT_DATA";
      continue;
    }

    let cumGrossOI = 0,
      cumDirProgress = 0;
    const cumGrossArr = [],
      cumProgArr = [],
      tsArr = [],
      priceArr = [],
      oiArr = [];
    let refIdx = 0;
    let confirmTs = null,
      confirmRow = null;

    for (let k = c.endIdx; k <= capIdx; k++) {
      const p = priceAtOrBeforeIdx(allOi, k);
      if (p === null) continue;
      if (k > c.endIdx) {
        const dOi = allOi[k].contracts - allOi[k - 1].contracts;
        cumGrossOI += Math.abs(dOi);
      }
      const dirProgressRaw = revUp ? c.priceEnd - p : p - c.priceEnd;
      cumDirProgress = (dirProgressRaw / c.priceEnd) * 100;
      cumGrossArr.push(cumGrossOI);
      cumProgArr.push(cumDirProgress);
      tsArr.push(allOi[k].ts);
      priceArr.push(p);
      oiArr.push(allOi[k].contracts);

      const idxHere = cumGrossArr.length - 1;
      const target = (1 - RECENT_WINDOW_FRACTION) * cumGrossOI;
      while (refIdx < idxHere && cumGrossArr[refIdx] < target) refIdx++;
      const recentGross = cumGrossOI - cumGrossArr[refIdx];
      const recentProg = cumDirProgress - cumProgArr[refIdx];
      const recentEfficiency =
        recentGross > 0 ? recentProg / recentGross : null;

      if (
        confirmTs === null &&
        recentEfficiency !== null &&
        recentEfficiency < 0
      ) {
        confirmTs = allOi[k].ts;
        confirmRow = {
          ts: allOi[k].ts,
          price: p,
          oi: allOi[k].contracts,
          cumGrossOI,
          cumDirProgress,
          recentEfficiency,
        };
      }
    }

    if (confirmTs !== null) {
      c.result = "CONFIRMED";
      c.confirmTs = confirmTs;
      c.confirmRow = confirmRow;
      c.postConfirm = {};
      for (const h of POST_CONFIRM_HORIZONS_MIN) {
        const hEndTs = confirmTs + h * 60000;
        const hEndIdx = nearestObsIdxAtOrBefore(allOi, hEndTs, c.endIdx);
        if (hEndIdx < c.endIdx) {
          c.postConfirm[h] = null;
          continue;
        }
        let fav = null,
          favTs = null,
          adv = null;
        for (let k = 0; k < tsArr.length; k++) {
          if (tsArr[k] < confirmTs || tsArr[k] > hEndTs) continue;
          const p = priceArr[k];
          if (revUp) {
            if (fav === null || p > fav) {
              fav = p;
              favTs = tsArr[k];
            }
            if (adv === null || p < adv) adv = p;
          } else {
            if (fav === null || p < fav) {
              fav = p;
              favTs = tsArr[k];
            }
            if (adv === null || p > adv) adv = p;
          }
        }
        if (fav === null) {
          c.postConfirm[h] = null;
          continue;
        }
        const MFE = revUp
          ? (fav / confirmRow.price - 1) * 100
          : (confirmRow.price / fav - 1) * 100;
        const MAE = revUp
          ? (confirmRow.price / adv - 1) * 100
          : (adv / confirmRow.price - 1) * 100;
        c.postConfirm[h] = {
          MFE,
          MAE,
          minutesToMFE: (favTs - confirmTs) / 60000,
        };
      }
    } else {
      c.result = "REJECTED";
      c.rejectionInfo = {
        finalCumDirProgress: cumDirProgress,
        finalOi: oiArr[oiArr.length - 1],
        finalPrice: priceArr[priceArr.length - 1],
      };
      // Report what ACTUALLY happened over the full cap window despite no confirmation (honest false-negative check).
      let fav = null,
        favTs = null,
        adv = null;
      for (let k = 0; k < tsArr.length; k++) {
        const p = priceArr[k];
        if (revUp) {
          if (fav === null || p > fav) {
            fav = p;
            favTs = tsArr[k];
          }
          if (adv === null || p < adv) adv = p;
        } else {
          if (fav === null || p < fav) {
            fav = p;
            favTs = tsArr[k];
          }
          if (adv === null || p > adv) adv = p;
        }
      }
      const MFE =
        fav !== null
          ? revUp
            ? (fav / c.priceEnd - 1) * 100
            : (c.priceEnd / fav - 1) * 100
          : null;
      const MAE =
        adv !== null
          ? revUp
            ? (c.priceEnd / adv - 1) * 100
            : (adv / c.priceEnd - 1) * 100
          : null;
      c.rejectedActual = {
        MFE,
        MAE,
        minutesToMFE: favTs !== null ? (favTs - c.endTs) / 60000 : null,
      };
    }
  }

  // ============================================================
  // PER-EPISODE OUTPUT
  // ============================================================
  console.log(`${"=".repeat(200)}\nPER-EPISODE RESULT\n${"=".repeat(200)}`);
  allCandidates.forEach((c) => {
    console.log(
      `\n${c.id}  ${c.direction}  END=${fmtDate(c.endTs)}  RESULT=${c.result}`,
    );
    if (c.result === "CONFIRMED") {
      console.log(
        `  Confirmation time: ${fmtDate(c.confirmTs)} (${((c.confirmTs - c.endTs) / 60000).toFixed(1)}m after END)`,
      );
      console.log(
        `  Cause: recentEfficiency=${c.confirmRow.recentEfficiency.toFixed(6)}  cumGrossOI(post-END)=${fmtBtc(c.confirmRow.cumGrossOI)}  cumDirProgress(post-END)=${fmtPct(c.confirmRow.cumDirProgress)}  price=${fmtPrice(c.confirmRow.price)}  OI=${fmtBtc(c.confirmRow.oi)}`,
      );
      for (const h of POST_CONFIRM_HORIZONS_MIN) {
        const o = c.postConfirm[h];
        console.log(
          `  post-confirm ${h}m: ${o ? `MFE=${fmtPct(o.MFE)} MAE=${fmtPct(o.MAE)} timeToMFE=${fmtMin(o.minutesToMFE)}` : "N/A"}`,
        );
      }
    } else if (c.result === "REJECTED") {
      console.log(
        `  No confirmation within ${RESEARCH_CAP_MIN}m research cap.`,
      );
      console.log(
        `  At cap: cumDirProgress(post-END)=${fmtPct(c.rejectionInfo.finalCumDirProgress)}  price=${fmtPrice(c.rejectionInfo.finalPrice)}  OI=${fmtBtc(c.rejectionInfo.finalOi)}`,
      );
      console.log(
        `  Actual path despite no confirmation (${RESEARCH_CAP_MIN}m): MFE=${fmtPct(c.rejectedActual.MFE)} MAE=${fmtPct(c.rejectedActual.MAE)} timeToMFE=${fmtMin(c.rejectedActual.minutesToMFE)}`,
      );
    } else console.log(`  ${c.result}`);
  });

  // ============================================================
  // CONFIRMED vs REJECTED COMPARISON
  // ============================================================
  console.log(
    `\n${"=".repeat(170)}\nCONFIRMED vs REJECTED COMPARISON\n${"=".repeat(170)}`,
  );
  const confirmed = allCandidates.filter((c) => c.result === "CONFIRMED");
  const rejected = allCandidates.filter((c) => c.result === "REJECTED");
  console.log(
    `CONFIRMED: N=${confirmed.length}   REJECTED: N=${rejected.length}   confirmation rate=${((confirmed.length / (confirmed.length + rejected.length)) * 100).toFixed(1)}%\n`,
  );

  console.log("CONFIRMED episodes -- post-confirmation outcome distributions:");
  for (const h of POST_CONFIRM_HORIZONS_MIN) {
    const mfe = confirmed
      .map((c) => c.postConfirm[h]?.MFE)
      .filter((v) => v !== null && v !== undefined);
    const mae = confirmed
      .map((c) => c.postConfirm[h]?.MAE)
      .filter((v) => v !== null && v !== undefined);
    const t2mfe = confirmed
      .map((c) => c.postConfirm[h]?.minutesToMFE)
      .filter((v) => v !== null && v !== undefined);
    console.log(
      `  ${h}m: median MFE=${fmtPct(median(mfe))}  median MAE=${fmtPct(median(mae))}  median timeToMFE=${fmtMin(median(t2mfe))}`,
    );
  }
  console.log(
    `  time to confirmation itself: median=${fmtMin(median(confirmed.map((c) => (c.confirmTs - c.endTs) / 60000)))}`,
  );

  console.log(
    "\nREJECTED episodes -- actual path despite no confirmation (over the full research cap window):",
  );
  const rMfe = rejected
    .map((c) => c.rejectedActual.MFE)
    .filter((v) => v !== null);
  const rMae = rejected
    .map((c) => c.rejectedActual.MAE)
    .filter((v) => v !== null);
  console.log(
    `  median MFE=${fmtPct(median(rMfe))}  median MAE=${fmtPct(median(rMae))}`,
  );
  console.log(
    `  (compare against CONFIRMED's post-confirmation numbers above to judge whether this filter actually separates cleaner from noisier outcomes)`,
  );

  console.log(`\n${"=".repeat(170)}\nRUN COMPLETED SUCCESSFULLY`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
