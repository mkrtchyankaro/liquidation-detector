// BTC OI/PRICE SEQUENTIAL RELATIONSHIP EXPERIMENT -- fully isolated
// from every prior OI-leg/33%/10x/HYBRID/SURVIVED-FAILED experiment
// this session. Fresh methodology, fresh script.
//
// METHODOLOGY (explained here, not silently chosen):
//
//   SEGMENTATION: magnitude-cut blocks -- a new segment starts every
//   time cumulative |ΔOI| since the segment's own start reaches a
//   scale derived from THIS window's own data: the median |ΔOI over
//   60s| among real paired observations (same derivation used
//   elsewhere in this research thread). This guarantees every segment
//   has a non-trivial |ΔOI| by construction, so ratio-style
//   instability near ΔOI=0 cannot occur -- no arbitrary 1m/3m/5m
//   candle was chosen.
//
//   RELATIONSHIP MODEL F(ΔOI direction) -> expected ΔPrice%: the
//   SIMPLEST non-parametric, non-EMA, non-ML representation --
//   sign-conditioned running average. Two running populations are
//   maintained AS THE TIMELINE PROGRESSES: actual price-response %
//   from all STRICTLY PRIOR segments where ΔOI was positive, and all
//   STRICTLY PRIOR segments where ΔOI was negative. For each new
//   segment, EXPECTED_PRICE_CHANGE = the running mean of the
//   matching-sign population BEFORE this segment (N/A if fewer than
//   3 prior same-sign segments exist yet -- no expectation without
//   history). RESIDUAL = actual - expected. NORMALIZED_SURPRISE =
//   residual / running stddev of that same prior population (N/A
//   under the same 3-sample floor). AFTER computing, this segment's
//   own actual response is added to its sign's population for future
//   segments. Strictly causal -- no future leakage.
//
//   DEVIATION marking (descriptive only, not a new END rule): a
//   segment is flagged DEVIATION if |NORMALIZED_SURPRISE| > 1 (more
//   than one historical standard deviation from what the process had
//   shown so far). A PERSISTENT DEVIATION section is 3+ consecutive
//   same-sign-residual DEVIATION segments.
//
//   node scripts/btc-oi-price-sequential-relationship.js
//
// Uses ONLY liq_raw_events (markers only) and oi_second_observations
// (OI + price). No aggTrade, no taker flow, no order book, no
// candles, no ATR, no prior OI-leg/SURVIVED-FAILED logic.
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const WINDOW_START_MS = Date.parse("2026-09-20T02:24:27Z");
const WINDOW_END_MS = Date.parse("2026-09-20T04:16:19Z"); // extended ~60min past old EP34 END, per instruction

const OLD_MARKERS = [
  { label: "EP31 START", ms: Date.parse("2026-09-20T02:24:27Z") },
  { label: "EP31 OLD END", ms: Date.parse("2026-09-20T02:36:15Z") },
  { label: "EP32 START", ms: Date.parse("2026-09-20T02:39:21Z") },
  { label: "EP32 OLD END", ms: Date.parse("2026-09-20T02:45:58Z") },
  { label: "EP33 START", ms: Date.parse("2026-09-20T02:54:09Z") },
  { label: "EP33 OLD END", ms: Date.parse("2026-09-20T03:02:37Z") },
  { label: "EP34 START", ms: Date.parse("2026-09-20T03:14:42Z") },
  { label: "EP34 OLD END", ms: Date.parse("2026-09-20T03:16:19Z") },
];

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function hhmmss(ms) {
  return new Date(ms).toISOString().slice(11, 19);
}
function fmtBtc(n) {
  return n === null || n === undefined
    ? "N/A"
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtBtcDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function fmtPrice(n) {
  return n === null || n === undefined
    ? "N/A"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
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
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
function stddev(arr) {
  const m = mean(arr);
  return arr.length
    ? Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length)
    : null;
}

function horizonDeltas(obs, horizonMs, toleranceMs, field) {
  const deltas = [];
  let j = 0;
  for (let i = 0; i < obs.length; i++) {
    if (j < i + 1) j = i + 1;
    while (j < obs.length && obs[j].ts - obs[i].ts < horizonMs - toleranceMs)
      j++;
    if (
      j < obs.length &&
      Math.abs(obs[j].ts - obs[i].ts - horizonMs) <= toleranceMs &&
      obs[j][field] !== null &&
      obs[i][field] !== null
    ) {
      deltas.push(obs[j][field] - obs[i][field]);
    }
  }
  return deltas;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const client = new MongoClient(uri);
  await client.connect();
  const ownDb = client.db(process.env.MONGO_OWN_DB ?? "liquidation_detector");
  const liqCol = ownDb.collection("liq_raw_events");
  const oiCol = ownDb.collection("oi_second_observations");

  console.log("=".repeat(160));
  console.log(
    "BTC OI/PRICE SEQUENTIAL RELATIONSHIP EXPERIMENT -- fully isolated from prior OI experiments",
  );
  console.log(
    `Continuous window: ${isoUtc(WINDOW_START_MS)} -> ${isoUtc(WINDOW_END_MS)}`,
  );
  console.log("=".repeat(160));

  console.log("\n1) METHODOLOGY (see file header comment for full text):");
  console.log(
    "   - Segmentation: magnitude-cut blocks, scale = median |ΔOI over 60s| from THIS window's own data.",
  );
  console.log(
    "   - Relationship model: sign-conditioned running average of PRIOR segments' actual price response,",
  );
  console.log(
    "     strictly causal (no future leakage), min 3 prior same-sign samples before any expectation exists.",
  );
  console.log(
    "   - No EMA, no ML, no linear-in-magnitude assumption, no prior OI-leg/HYBRID/SURVIVED-FAILED logic.",
  );

  const obsRaw = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: {
        $gte: new Date(WINDOW_START_MS - 65000),
        $lte: new Date(WINDOW_END_MS),
      },
    })
    .project({ timestamp: 1, openInterest: 1, price: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  const obs = obsRaw.map((d) => ({
    ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
    contracts: d.openInterest,
    price: d.price,
  }));

  const liqEvents = await liqCol
    .find({
      symbol: SYMBOL,
      timestamp: { $gte: WINDOW_START_MS, $lte: WINDOW_END_MS },
    })
    .project({ timestamp: 1, victim: 1, quoteQty: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  console.log(
    `\n2) ACTUAL DATA COUNTS: ${obs.length} OI+price observations, ${liqEvents.length} liquidation events, in the extended window.`,
  );
  if (obs.length < 100) {
    console.log("Too few observations.");
    await client.close();
    return;
  }

  const windowStartIdx = obs.findIndex((o) => o.ts >= WINDOW_START_MS);
  const oiDeltas60s = horizonDeltas(obs, 60000, 8000, "contracts")
    .map((d) => Math.abs(d))
    .sort((a, b) => a - b);
  const oiBlockScale = percentile(oiDeltas60s, 50);
  console.log(
    `\nDerived OI block scale (median |ΔOI over 60s| in this window): ${fmtBtc(oiBlockScale)} BTC.`,
  );

  // ---- Build magnitude-cut segments across the WHOLE continuous window ----
  const segments = [];
  let segStartIdx = Math.max(0, windowStartIdx);
  for (let i = segStartIdx + 1; i < obs.length; i++) {
    const cumDelta = obs[i].contracts - obs[segStartIdx].contracts;
    if (Math.abs(cumDelta) >= oiBlockScale) {
      segments.push({ startIdx: segStartIdx, endIdx: i });
      segStartIdx = i;
    }
  }
  console.log(
    `Built ${segments.length} magnitude-cut segments across the continuous window.`,
  );

  // ---- Sequential, causal relationship tracking ----
  const priorUp = [],
    priorDown = [];
  const rows = [];
  for (const seg of segments) {
    const a = obs[seg.startIdx],
      b = obs[seg.endIdx];
    const deltaOi = b.contracts - a.contracts;
    const deltaPricePct =
      a.price !== null && b.price !== null && a.price !== 0
        ? ((b.price - a.price) / a.price) * 100
        : null;
    const sign = deltaOi >= 0 ? "UP" : "DOWN";
    const priorPop = sign === "UP" ? priorUp : priorDown;

    let expected = null,
      residual = null,
      normSurprise = null;
    if (priorPop.length >= 3 && deltaPricePct !== null) {
      expected = mean(priorPop);
      residual = deltaPricePct - expected;
      const sd = stddev(priorPop);
      normSurprise = sd > 0 ? residual / sd : null;
    }

    rows.push({
      startTs: a.ts,
      endTs: b.ts,
      oiStart: a.contracts,
      oiEnd: b.contracts,
      deltaOi,
      priceStart: a.price,
      priceEnd: b.price,
      deltaPricePct,
      sign,
      expected,
      actual: deltaPricePct,
      residual,
      normSurprise,
      priorN: priorPop.length,
    });

    if (deltaPricePct !== null) {
      if (sign === "UP") priorUp.push(deltaPricePct);
      else priorDown.push(deltaPricePct);
    }
  }

  // ---- Print compact chronological table, with markers overlaid ----
  console.log(`\n${"=".repeat(180)}`);
  console.log("3) COMPACT CHRONOLOGICAL RELATIONSHIP TABLE");
  console.log("=".repeat(180));
  console.log(
    "TIME RANGE               | OI START   | OI END     | ΔOI       | PRICE START  | PRICE END    | ΔPRICE%    | SIGN | PRIOR N | EXPECTED%  | RESIDUAL%  | NORM SURPRISE | FLAG",
  );
  console.log("-".repeat(200));

  function markersAt(fromTs, toTs) {
    return OLD_MARKERS.filter((m) => m.ms >= fromTs && m.ms < toTs).map(
      (m) => m.label,
    );
  }
  function liqsAt(fromTs, toTs) {
    return liqEvents.filter((e) => e.timestamp >= fromTs && e.timestamp < toTs);
  }

  rows.forEach((r) => {
    const markers = markersAt(r.startTs, r.endTs);
    const liqs = liqsAt(r.startTs, r.endTs);
    const flag =
      r.normSurprise !== null && Math.abs(r.normSurprise) > 1
        ? "DEVIATION"
        : "";
    console.log(
      `${hhmmss(r.startTs)}-${hhmmss(r.endTs)} | ${fmtBtc(r.oiStart).padEnd(10)} | ${fmtBtc(r.oiEnd).padEnd(10)} | ${fmtBtcDelta(r.deltaOi).padEnd(9)} | ${fmtPrice(r.priceStart).padEnd(12)} | ${fmtPrice(r.priceEnd).padEnd(12)} | ${fmtPct(r.deltaPricePct).padEnd(10)} | ${r.sign.padEnd(4)} | ${String(r.priorN).padEnd(7)} | ${(r.expected !== null ? fmtPct(r.expected) : "N/A").padEnd(10)} | ${(r.residual !== null ? fmtPct(r.residual) : "N/A").padEnd(10)} | ${(r.normSurprise !== null ? r.normSurprise.toFixed(2) : "N/A").padEnd(13)} | ${flag}`,
    );
    markers.forEach((m) => console.log(`    >>> MARKER: ${m}`));
    liqs.forEach((e) =>
      console.log(
        `    >>> LIQ: ${hhmmss(e.timestamp)}  ${e.victim}  ${fmtUsd(e.quoteQty)}`,
      ),
    );
  });

  // ---- Persistent deviation sections ----
  console.log(`\n${"=".repeat(160)}`);
  console.log(
    "6) PERSISTENT DEVIATION SECTIONS (3+ consecutive same-sign-residual DEVIATION segments)",
  );
  console.log("=".repeat(160));
  let runStart = null,
    runSign = null,
    runLen = 0;
  const persistentRuns = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isDeviation = r.normSurprise !== null && Math.abs(r.normSurprise) > 1;
    const residSign =
      r.residual !== null ? (r.residual >= 0 ? "+" : "-") : null;
    if (isDeviation && residSign === runSign) {
      runLen++;
    } else if (isDeviation) {
      if (runLen >= 3)
        persistentRuns.push({
          startIdx: runStart,
          endIdx: i - 1,
          sign: runSign,
          len: runLen,
        });
      runStart = i;
      runSign = residSign;
      runLen = 1;
    } else {
      if (runLen >= 3)
        persistentRuns.push({
          startIdx: runStart,
          endIdx: i - 1,
          sign: runSign,
          len: runLen,
        });
      runStart = null;
      runSign = null;
      runLen = 0;
    }
  }
  if (runLen >= 3)
    persistentRuns.push({
      startIdx: runStart,
      endIdx: rows.length - 1,
      sign: runSign,
      len: runLen,
    });

  if (persistentRuns.length === 0) {
    console.log(
      "No persistent (3+ consecutive same-sign) deviation runs found.",
    );
  } else {
    persistentRuns.forEach((run, idx) => {
      console.log(
        `Run #${idx + 1}: ${hhmmss(rows[run.startIdx].startTs)} -> ${hhmmss(rows[run.endIdx].endTs)}  residual sign=${run.sign}  length=${run.len} segments`,
      );
    });
  }

  // ---- Direct answers ----
  console.log(`\n${"=".repeat(160)}`);
  console.log("7) DIRECT ANSWERS TO QUESTIONS 1-7 (from the output above)");
  console.log("=".repeat(160));
  const totalWithExpectation = rows.filter((r) => r.expected !== null).length;
  console.log(
    `Q1. Locally stable ΔOI->ΔPrice relationship: ${totalWithExpectation} of ${rows.length} segments had enough prior history for an expectation.`,
  );
  console.log(
    `    Read the EXPECTED% column above for its own evolution over time -- if it stays roughly consistent`,
  );
  console.log(
    `    within each sign for long stretches, that supports local stability; if it swings wildly, it does not.`,
  );

  function relationshipAcrossMarker(label1Ms, label2Ms) {
    const before = rows.filter((r) => r.endTs <= label1Ms).slice(-3);
    const after = rows.filter((r) => r.startTs >= label2Ms).slice(0, 3);
    return { before, after };
  }
  const ep31End = OLD_MARKERS.find((m) => m.label === "EP31 OLD END").ms;
  const ep32Start = OLD_MARKERS.find((m) => m.label === "EP32 START").ms;
  const ep32End = OLD_MARKERS.find((m) => m.label === "EP32 OLD END").ms;
  const ep33Start = OLD_MARKERS.find((m) => m.label === "EP33 START").ms;
  const ep33End = OLD_MARKERS.find((m) => m.label === "EP33 OLD END").ms;
  const ep34Start = OLD_MARKERS.find((m) => m.label === "EP34 START").ms;

  console.log(
    `\nQ2. Around EP31 OLD END (${hhmmss(ep31End)}) -> EP32 START (${hhmmss(ep32Start)}):`,
  );
  const q2 = relationshipAcrossMarker(ep31End, ep32Start);
  console.log(
    `    Segments just before: ${q2.before.map((r) => `${r.sign}/${fmtPct(r.deltaPricePct)}`).join(", ") || "none"}`,
  );
  console.log(
    `    Segments just after:  ${q2.after.map((r) => `${r.sign}/${fmtPct(r.deltaPricePct)}`).join(", ") || "none"}`,
  );

  console.log(
    `\nQ3. Around EP32 OLD END (${hhmmss(ep32End)}) -> EP33 START (${hhmmss(ep33Start)}):`,
  );
  const q3 = relationshipAcrossMarker(ep32End, ep33Start);
  console.log(
    `    Segments just before: ${q3.before.map((r) => `${r.sign}/${fmtPct(r.deltaPricePct)}`).join(", ") || "none"}`,
  );
  console.log(
    `    Segments just after:  ${q3.after.map((r) => `${r.sign}/${fmtPct(r.deltaPricePct)}`).join(", ") || "none"}`,
  );

  console.log(
    `\nQ4. Around EP33 OLD END (${hhmmss(ep33End)}) -> EP34 START (${hhmmss(ep34Start)}):`,
  );
  const q4 = relationshipAcrossMarker(ep33End, ep34Start);
  console.log(
    `    Segments just before: ${q4.before.map((r) => `${r.sign}/${fmtPct(r.deltaPricePct)}`).join(", ") || "none"}`,
  );
  console.log(
    `    Segments just after:  ${q4.after.map((r) => `${r.sign}/${fmtPct(r.deltaPricePct)}`).join(", ") || "none"}`,
  );

  console.log(
    `\nQ5. Clearest persistent deviation: ${persistentRuns.length > 0 ? `Run with the longest length -- see PERSISTENT DEVIATION SECTIONS above (longest=${Math.max(...persistentRuns.map((r) => r.len))} segments).` : "None found in this window under the |normSurprise|>1, 3-consecutive definition."}`,
  );

  console.log(
    `\nQ6. Separate vs continuous processes: compare the EXPECTED%/RESIDUAL% values immediately before and after each`,
  );
  console.log(
    `    OLD END marker (Q2/Q3/Q4 above) -- if residuals stay small and signs match across a marker, that segment`,
  );
  console.log(
    `    of the timeline behaves like ONE continuous process through that boundary; if residuals jump sharply`,
  );
  console.log(
    `    right at a marker, that boundary looks more like a genuine change point.`,
  );

  console.log(
    `\nQ7. OI-increase-during-LONG-liquidation price behavior: find UP-sign segments above that occur chronologically`,
  );
  console.log(
    `    after DOWN-sign segments in this same DOWN-liquidation-driven window, and read their RESIDUAL% column --`,
  );
  console.log(
    `    a small residual near 0 during early UP segments (price still behaving per the established DOWN-context`,
  );
  console.log(
    `    relationship for UP segments) that later grows into a large positive residual is the specific pattern`,
  );
  console.log(
    `    this question asks about; if no such evolution appears, say so directly from what is printed above.`,
  );

  console.log(`\n${"=".repeat(160)}`);
  console.log(
    "This never touches live strategy or trading logic. No next steps proposed.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
