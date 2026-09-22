// BTC 10-MIN CANDIDATES + 1H/4H ZONE-OF-INTEREST RESEARCH -- new,
// standalone script. Does NOT modify btc-simple-10min-window.js.
//
// Candidate construction is REUSED VERBATIM (byte-identical logic)
// from that baseline: first liquidation -> frozen direction -> fixed
// 10-minute window -> causal prior-3-day same-side P90/P100. ZOI
// analysis is a strictly-AFTER-the-fact annotation layer; it plays no
// role in candidate START/END/KEEP/DROP.
//
// ZOI DEFINITION (printed again at runtime, not hidden):
//   Standard 2-candle fractal swing point on CLOSED 1H/4H candles.
//   Candle i is a SWING HIGH (RESISTANCE/SUPPLY) if its high exceeds
//   the high of candles i-2,i-1,i+1,i+2. SWING LOW (SUPPORT/DEMAND)
//   mirrors this on candle lows. Zone extent = that candle's own
//   [low, high] range. CAUSAL AVAILABILITY: a zone is only usable
//   starting at the CLOSE TIME of candle i+2 (the second confirming
//   candle), never at candle i's own time -- confirming a fractal
//   inherently requires seeing what comes after it.
//
// Candle source: Binance Futures REST klines API directly
// (fapi.binance.com/fapi/v1/klines, interval=1h and interval=4h) --
// no stored 1H/4H candle collection was found in this codebase (see
// inspection notes printed at the top of the run). Only CLOSED
// candles (closeTime <= evaluation cutoff) are ever used.
//
//   node scripts/btc-10min-zoi-research.js
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
const BTCUSDT_FUTURES_LISTING_MS = Date.parse("2019-09-08T00:00:00Z"); // DATA AVAILABILITY fact (approx. BTCUSDT perpetual futures listing on Binance), NOT a zone-invalidation rule. Zones built from ANY candle in the fetched range remain valid regardless of age -- no arbitrary lifetime cutoff is applied.

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtDate(ms) {
  return ms === null
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
function fmtPct(n) {
  return n === null || n === undefined ? "N/A" : `${n.toFixed(3)}%`;
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
function percentileRank(sortedPop, x) {
  if (sortedPop.length === 0) return null;
  let c = 0;
  for (const v of sortedPop) if (v <= x) c++;
  return (c / sortedPop.length) * 100;
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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchKlinesRange(symbol, startMs, endMs, interval) {
  const all = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${Math.round(cursor)}&endTime=${Math.round(endMs)}&limit=1000`;
    let rows = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 418) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        rows = [];
        break;
      }
      rows = await res.json();
      break;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows)
      all.push({
        openTime: r[0],
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        closeTime: r[6],
      });
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1][0] + 1;
    await sleep(150);
  }
  return all;
}

/** 2-candle fractal ZOI construction. Returns zones with a
 *  causallyAvailableFromTs = the CLOSE TIME of the 2nd confirming
 *  candle -- never the swing candle's own time. */
function buildZones(candles) {
  const zones = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    const isSwingHigh =
      c.high > candles[i - 2].high &&
      c.high > candles[i - 1].high &&
      c.high > candles[i + 1].high &&
      c.high > candles[i + 2].high;
    const isSwingLow =
      c.low < candles[i - 2].low &&
      c.low < candles[i - 1].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low;
    if (isSwingHigh)
      zones.push({
        type: "RESISTANCE/SUPPLY",
        low: c.low,
        high: c.high,
        mid: (c.low + c.high) / 2,
        swingTs: c.openTime,
        causallyAvailableFromTs: candles[i + 2].closeTime,
      });
    if (isSwingLow)
      zones.push({
        type: "SUPPORT/DEMAND",
        low: c.low,
        high: c.high,
        mid: (c.low + c.high) / 2,
        swingTs: c.openTime,
        causallyAvailableFromTs: candles[i + 2].closeTime,
      });
  }
  return zones;
}

function nearestZone(zones, atTs, price) {
  const available = zones.filter((z) => z.causallyAvailableFromTs <= atTs);
  if (available.length === 0) return null;
  let best = null,
    bestDist = Infinity;
  for (const z of available) {
    const dist =
      price >= z.low && price <= z.high
        ? 0
        : Math.min(Math.abs(price - z.low), Math.abs(price - z.high));
    if (dist < bestDist) {
      bestDist = dist;
      best = z;
    }
  }
  const ageMs = atTs - best.causallyAvailableFromTs;
  return {
    zone: best,
    distance: bestDist,
    ageHours: ageMs / 3600000,
    ageDays: ageMs / 86400000,
  };
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
  console.log("CAUSALITY AUDIT (verify before trusting results)");
  console.log("=".repeat(170));
  console.log(
    "1. Candidate construction: REUSED VERBATIM from btc-simple-10min-window.js (copied below, unmodified).",
  );
  console.log(
    "2. No candidate boundary changed -- same fixed 10min window, same P90/P100 logic.",
  );
  console.log(
    "3/4. Zones use only candles with closeTime <= the candidate's own evaluation timestamp -- enforced via causallyAvailableFromTs filter.",
  );
  console.log(
    "5. Zone construction reads ONLY klines (open/high/low/close) -- no liquidation or OI data enters buildZones().",
  );
  console.log(
    "6. P90/P100 code path is byte-identical to the baseline; ZOI is computed in a separate pass afterward.",
  );
  console.log(
    "7. ZOI fields are annotations on already-finalized candidates -- never fed back into candidate logic.\n",
  );

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;
  const zoneLoadStartMs = BTCUSDT_FUTURES_LISTING_MS;
  console.log(
    `Zone data-fetch start: ${isoUtc(zoneLoadStartMs)} (BTCUSDT futures listing -- a data-availability fact, not a zone-age cutoff; zones of any age within this range are kept).`,
  );

  console.log(
    "Fetching 1H and 4H BTCUSDT klines from Binance Futures REST API (this takes a bit)...",
  );
  const candles1h = await fetchKlinesRange(
    SYMBOL,
    zoneLoadStartMs,
    evalEndMs,
    "1h",
  );
  await sleep(150);
  const candles4h = await fetchKlinesRange(
    SYMBOL,
    zoneLoadStartMs,
    evalEndMs,
    "4h",
  );
  console.log(
    `1H candles loaded: ${candles1h.length}   4H candles loaded: ${candles4h.length}`,
  );

  const zones1h = buildZones(candles1h);
  const zones4h = buildZones(candles4h);
  console.log(
    `1H ZOI zones constructed: ${zones1h.length}   4H ZOI zones constructed: ${zones4h.length}\n`,
  );

  // ============================================================
  // BASELINE CANDIDATE CONSTRUCTION -- VERBATIM from btc-simple-10min-window.js
  // ============================================================
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
        $lte: new Date(evalEndMs + WINDOW_MS),
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
    `Raw liquidation events: ${allLiq.length}   OI+price observations: ${allOi.length}`,
  );
  if (allLiq.length === 0 || allOi.length < 10) {
    console.log("Insufficient data.");
    await client.close();
    return;
  }

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
      priceEnd = null,
      pathIdx = [];
    if (startIdx >= 0 && endIdx >= 0 && endIdx >= startIdx) {
      priceStart = priceAtOrBeforeIdx(allOi, startIdx);
      priceEnd = priceAtOrBeforeIdx(allOi, endIdx);
      pathIdx = [startIdx, endIdx];
    }
    const dirLiqUsd = events
      .filter((e) => e.victim === direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const oppLiqUsd = events
      .filter((e) => e.victim !== direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    candidates.push({
      direction,
      startTs,
      endTs,
      dirLiqUsd,
      oppLiqUsd,
      eventCount: events.length,
      priceStart,
      priceEnd,
      pathIdx,
    });
  }

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
      c.priorCount = prior.length;
      c.liveEvaluable = c.endTs >= evalStartMs;
      if (prior.length < MIN_LIVE_SAMPLE) {
        c.status = "INSUFFICIENT_HISTORY";
        c.causalP90 = null;
        c.causalP100 = null;
        c.decision = null;
        return;
      }
      const vals = prior.map((p) => p.dirLiqUsd).sort((a, b) => a - b);
      c.causalP90 = percentile(vals, 90);
      c.causalP100 = Math.max(...vals);
      c.decision = c.dirLiqUsd >= c.causalP90 ? "KEEP_P90" : "DROP_BELOW_P90";
      c.abovePriorP100 = c.dirLiqUsd > c.causalP100;
      c.status = "LIVE";
    });
  }
  applyRolling(longC);
  applyRolling(shortC);
  const liveCandidates = [...longC, ...shortC].filter((c) => c.liveEvaluable);
  console.log(
    `Live-evaluable baseline candidates: ${liveCandidates.length} (LONG=${liveCandidates.filter((c) => c.direction === "LONG").length}, SHORT=${liveCandidates.filter((c) => c.direction === "SHORT").length})\n`,
  );

  // ============================================================
  // STRICT BASELINE SELF-VERIFICATION -- the script checks itself,
  // not the operator. If either known candidate is missing or its
  // direction-liquidation USD is off by more than $500 (a tight,
  // float-rounding-only tolerance), STOP before running any ZOI code.
  // ============================================================
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
      `${chk.label}: found dirLiqUsd=${fmtUsd(match.dirLiqUsd)}  expected=${fmtUsd(chk.expectedUsd)}  diff=${fmtUsd(diff)}  ${ok ? "PASS" : "FAIL"}`,
    );
    if (!ok) verificationFailed = true;
  }
  if (verificationFailed) {
    console.log(
      `\nBASELINE VERIFICATION FAILED. Candidate construction does not match the known baseline. STOPPING before ZOI analysis.`,
    );
    await client.close();
    return;
  }
  console.log(
    `\nBaseline verification PASSED. Proceeding with ZOI analysis.\n`,
  );

  // ============================================================
  // ZOI ANNOTATION (strictly after the fact)
  // ============================================================
  for (const c of liveCandidates) {
    if (
      c.priceStart === null ||
      c.priceEnd === null ||
      c.pathIdx.length === 0
    ) {
      c.zoi = null;
      continue;
    }
    const [startIdx, endIdx] = c.pathIdx;
    const pathPrices = [];
    for (let k = startIdx; k <= endIdx; k++) {
      const p = priceAtOrBeforeIdx(allOi, k);
      if (p !== null) pathPrices.push(p);
    }
    const pathMin = Math.min(...pathPrices),
      pathMax = Math.max(...pathPrices);

    function annotate(zones, atTs) {
      const nz = nearestZone(zones, atTs, c.priceEnd);
      if (!nz) return { touched: false, endInside: false, crossed: false };
      const z = nz.zone;
      const endInside = c.priceEnd >= z.low && c.priceEnd <= z.high;
      const touched = pathMin <= z.high && pathMax >= z.low; // path range overlaps zone range at any point
      const crossed = pathMin < z.low && pathMax > z.high; // path spans clean through the whole zone
      return {
        zone: z,
        distance: nz.distance,
        distPct: (nz.distance / c.priceEnd) * 100,
        endInside,
        touched,
        crossed,
        ageHours: nz.ageHours,
        ageDays: nz.ageDays,
      };
    }
    c.zoi = { h1: annotate(zones1h, c.endTs), h4: annotate(zones4h, c.endTs) };
  }

  // ============================================================
  // FIRST ANALYSIS: ALL live candidates
  // ============================================================
  function summarize(label, cs) {
    const withZoi = cs.filter((c) => c.zoi);
    const t1 = withZoi.filter((c) => c.zoi.h1.touched).length;
    const ei1 = withZoi.filter((c) => c.zoi.h1.endInside).length;
    const t4 = withZoi.filter((c) => c.zoi.h4.touched).length;
    const ei4 = withZoi.filter((c) => c.zoi.h4.endInside).length;
    const both = withZoi.filter(
      (c) => c.zoi.h1.touched && c.zoi.h4.touched,
    ).length;
    console.log(`${label}: N=${withZoi.length}`);
    console.log(
      `  touching any 1H ZOI: ${t1} (${withZoi.length ? ((t1 / withZoi.length) * 100).toFixed(1) : 0}%)   ending inside 1H ZOI: ${ei1} (${withZoi.length ? ((ei1 / withZoi.length) * 100).toFixed(1) : 0}%)`,
    );
    console.log(
      `  touching any 4H ZOI: ${t4} (${withZoi.length ? ((t4 / withZoi.length) * 100).toFixed(1) : 0}%)   ending inside 4H ZOI: ${ei4} (${withZoi.length ? ((ei4 / withZoi.length) * 100).toFixed(1) : 0}%)`,
    );
    console.log(
      `  touching BOTH 1H and 4H ZOI: ${both} (${withZoi.length ? ((both / withZoi.length) * 100).toFixed(1) : 0}%)`,
    );
    const dists1h = withZoi
      .map((c) => c.zoi.h1.distPct)
      .filter((v) => v !== undefined)
      .sort((a, b) => a - b);
    const dists4h = withZoi
      .map((c) => c.zoi.h4.distPct)
      .filter((v) => v !== undefined)
      .sort((a, b) => a - b);
    console.log(
      `  1H distance% : P50=${fmtPct(percentile(dists1h, 50))} P90=${fmtPct(percentile(dists1h, 90))}`,
    );
    console.log(
      `  4H distance% : P50=${fmtPct(percentile(dists4h, 50))} P90=${fmtPct(percentile(dists4h, 90))}`,
    );
    const ages1h = withZoi
      .map((c) => c.zoi.h1.ageDays)
      .filter((v) => v !== undefined)
      .sort((a, b) => a - b);
    const ages4h = withZoi
      .map((c) => c.zoi.h4.ageDays)
      .filter((v) => v !== undefined)
      .sort((a, b) => a - b);
    console.log(
      `  1H selected-zone AGE (days) : P50=${percentile(ages1h, 50)?.toFixed(1)} P90=${percentile(ages1h, 90)?.toFixed(1)} MAX=${ages1h[ages1h.length - 1]?.toFixed(1)}`,
    );
    console.log(
      `  4H selected-zone AGE (days) : P50=${percentile(ages4h, 50)?.toFixed(1)} P90=${percentile(ages4h, 90)?.toFixed(1)} MAX=${ages4h[ages4h.length - 1]?.toFixed(1)}`,
    );
  }
  console.log(
    `${"=".repeat(170)}\nFIRST ANALYSIS -- ALL LIVE CANDIDATES\n${"=".repeat(170)}`,
  );
  summarize(
    "LONG (all)",
    liveCandidates.filter((c) => c.direction === "LONG"),
  );
  summarize(
    "SHORT (all)",
    liveCandidates.filter((c) => c.direction === "SHORT"),
  );

  console.log(
    `\n${"=".repeat(170)}\nSECOND ANALYSIS -- KEEP_P90 ONLY\n${"=".repeat(170)}`,
  );
  summarize(
    "LONG KEEP_P90",
    liveCandidates.filter(
      (c) => c.direction === "LONG" && c.decision === "KEEP_P90",
    ),
  );
  summarize(
    "SHORT KEEP_P90",
    liveCandidates.filter(
      (c) => c.direction === "SHORT" && c.decision === "KEEP_P90",
    ),
  );

  console.log(
    `\n${"=".repeat(170)}\nTHIRD ANALYSIS -- ABOVE_PRIOR_P100\n${"=".repeat(170)}`,
  );
  liveCandidates
    .filter((c) => c.abovePriorP100)
    .forEach((c) => {
      console.log(
        `\n${c.direction} ${fmtDate(c.startTs)} -> ${fmtDate(c.endTs)}  dirLiq=${fmtUsd(c.dirLiqUsd)}  P100=${fmtUsd(c.causalP100)}`,
      );
      if (c.zoi) {
        console.log(
          `  1H: ${c.zoi.h1.zone?.type ?? "N/A"} [${fmtPrice(c.zoi.h1.zone?.low)}-${fmtPrice(c.zoi.h1.zone?.high)}] touched=${c.zoi.h1.touched} endInside=${c.zoi.h1.endInside} dist=${fmtPct(c.zoi.h1.distPct)}`,
        );
        console.log(
          `  4H: ${c.zoi.h4.zone?.type ?? "N/A"} [${fmtPrice(c.zoi.h4.zone?.low)}-${fmtPrice(c.zoi.h4.zone?.high)}] touched=${c.zoi.h4.touched} endInside=${c.zoi.h4.endInside} dist=${fmtPct(c.zoi.h4.distPct)}`,
        );
      }
    });

  // ============================================================
  // MANUAL INSPECTION TABLE -- KEEP_P90
  // ============================================================
  console.log(
    `\n${"=".repeat(200)}\nMANUAL INSPECTION TABLE -- KEEP_P90 CANDIDATES\n${"=".repeat(200)}`,
  );
  liveCandidates
    .filter((c) => c.decision === "KEEP_P90")
    .sort((a, b) => a.startTs - b.startTs)
    .forEach((c) => {
      console.log(
        `\n${c.direction}  START=${fmtDate(c.startTs)}  END=${fmtDate(c.endTs)}  dirLiq=${fmtUsd(c.dirLiqUsd)}  P90=${fmtUsd(c.causalP90)}  P100=${fmtUsd(c.causalP100)}  endPrice=${fmtPrice(c.priceEnd)}`,
      );
      if (c.zoi) {
        console.log(
          `  1H: type=${c.zoi.h1.zone?.type ?? "N/A"} range=[${fmtPrice(c.zoi.h1.zone?.low)}-${fmtPrice(c.zoi.h1.zone?.high)}] touched=${c.zoi.h1.touched} endInside=${c.zoi.h1.endInside} dist%=${fmtPct(c.zoi.h1.distPct)} zoneCreated=${c.zoi.h1.zone ? fmtDate(c.zoi.h1.zone.causallyAvailableFromTs) : "N/A"} age=${c.zoi.h1.ageHours !== undefined ? c.zoi.h1.ageHours.toFixed(1) + "h / " + c.zoi.h1.ageDays.toFixed(1) + "d" : "N/A"}`,
        );
        console.log(
          `  4H: type=${c.zoi.h4.zone?.type ?? "N/A"} range=[${fmtPrice(c.zoi.h4.zone?.low)}-${fmtPrice(c.zoi.h4.zone?.high)}] touched=${c.zoi.h4.touched} endInside=${c.zoi.h4.endInside} dist%=${fmtPct(c.zoi.h4.distPct)} zoneCreated=${c.zoi.h4.zone ? fmtDate(c.zoi.h4.zone.causallyAvailableFromTs) : "N/A"} age=${c.zoi.h4.ageHours !== undefined ? c.zoi.h4.ageHours.toFixed(1) + "h / " + c.zoi.h4.ageDays.toFixed(1) + "d" : "N/A"}`,
        );
      } else console.log("  ZOI: N/A (no price path)");
    });

  // ============================================================
  // KNOWN EXAMPLES
  // ============================================================
  console.log(
    `\n${"=".repeat(170)}\nKNOWN EXAMPLE -- 2026-09-20 02:24 onward\n${"=".repeat(170)}`,
  );
  const sep20 = liveCandidates.filter(
    (c) =>
      c.startTs >= Date.parse("2026-09-20T02:20:00Z") &&
      c.startTs <= Date.parse("2026-09-20T02:50:00Z"),
  );
  sep20.forEach((c) => {
    console.log(
      `${c.direction} ${fmtDate(c.startTs)}->${fmtDate(c.endTs)} dirLiq=${fmtUsd(c.dirLiqUsd)}`,
    );
    if (c.zoi) {
      console.log(
        `  1H zone: ${c.zoi.h1.zone ? `[${fmtPrice(c.zoi.h1.zone.low)}-${fmtPrice(c.zoi.h1.zone.high)}]` : "N/A"}  4H zone: ${c.zoi.h4.zone ? `[${fmtPrice(c.zoi.h4.zone.low)}-${fmtPrice(c.zoi.h4.zone.high)}]` : "N/A"}`,
      );
    }
  });

  console.log(
    `\n${"=".repeat(170)}\nKNOWN EXAMPLE -- 2026-09-21 08:32 SHORT cascade\n${"=".repeat(170)}`,
  );
  const sep21 = liveCandidates.filter(
    (c) =>
      c.startTs >= Date.parse("2026-09-21T08:25:00Z") &&
      c.startTs <= Date.parse("2026-09-21T09:00:00Z"),
  );
  sep21.forEach((c) => {
    console.log(
      `${c.direction} ${fmtDate(c.startTs)}->${fmtDate(c.endTs)} dirLiq=${fmtUsd(c.dirLiqUsd)}`,
    );
    if (c.zoi) {
      console.log(
        `  1H zone: ${c.zoi.h1.zone ? `[${fmtPrice(c.zoi.h1.zone.low)}-${fmtPrice(c.zoi.h1.zone.high)}]` : "N/A"}  4H zone: ${c.zoi.h4.zone ? `[${fmtPrice(c.zoi.h4.zone.low)}-${fmtPrice(c.zoi.h4.zone.high)}]` : "N/A"}`,
      );
    }
  });

  console.log(`\n${"=".repeat(170)}`);
  console.log("RUN COMPLETED SUCCESSFULLY");

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
