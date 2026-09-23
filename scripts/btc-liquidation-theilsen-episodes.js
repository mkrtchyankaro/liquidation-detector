// BTC LIQUIDATION -> PRICE THEIL-SEN EPISODES -- new, standalone.
// Does NOT touch the existing OI Theil-Sen research scripts (kept as
// reference for later production work). Episodes are discovered
// ENTIRELY from liquidation + price -- OI is loaded only for the
// AFTER-THE-FACT comparison section, never used to construct or end
// an episode.
//
// ============================================================
// EPISODE START
//
//  Causal, per-side, rolling PRIOR-3-day P90/P95 of INDIVIDUAL
//  liquidation event USD sizes (not episode totals -- individual
//  events, since episodes don't exist yet at this stage). While
//  IDLE, the first liquidation event whose OWN USD >= the causal
//  same-side P90 (computed from prior events only) STARTS an
//  episode; direction freezes from that event. Opposite-side events
//  during the episode are absorbed as context, never split/redirect
//  it.
//
// LIQUIDATION -> PRICE MODEL
//
//  Training observations: for each SAME-DIRECTION liquidation event
//  after the first, X = that event's own USD size, Y = signed price
//  response from the PREVIOUS same-direction event's own execution
//  price to THIS event's own execution price (liq_raw_events' own
//  `price` field -- liquidation events are the natural time boundary
//  here, no invented window). Theil-Sen fit causally, updated after
//  each new same-direction observation.
//
// END (two independent reasons, whichever occurs first):
//
//  THEIL_SEN: the FIRST same-direction event (once the model has
//  >=2 training pairs) whose ACTUAL signed price response has the
//  OPPOSITE sign from the expected adverse direction (LONG: actual
//  Y>=0; SHORT: actual Y<=0) -- i.e. continued same-direction
//  liquidation force no longer pushes price adversely AT ALL. This
//  is a pure sign check -- zero invented tolerance/multiplier/
//  minimum, the least-ambiguous literal reading of "the response has
//  reversed" per the operator's own instruction to print ambiguity
//  rather than invent a rule. f(X) is printed alongside as context,
//  never as part of the trigger itself (a magnitude-matching version
//  would require an invented comparison tolerance -- explicitly
//  avoided).
//
//  QUIET_10M: if 10 consecutive minutes pass with NO liquidation
//  event at all while the episode is active, END = the last
//  liquidation event before that silence (explicit fallback rule
//  given by the operator, not invented here).
//
//   node scripts/btc-liquidation-theilsen-episodes.js
//
// READ-ONLY: no writes/updates/deletes anywhere in this file. No
// files created. Text output only.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const EVAL_DAYS = 3;
const BASELINE_DAYS = 3;
const MIN_LIVE_SAMPLE = 30; // minimum prior same-side INDIVIDUAL liquidation events before a causal P90 is considered meaningful (event-level sampling is much denser than episode-level, hence a larger minimum than earlier episode-level experiments)
const QUIET_GAP_MS = 10 * 60 * 1000; // explicit operator-specified fallback, not invented

function fmtDate(ms) {
  return ms === null || ms === undefined
    ? "N/A"
    : new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
function fmtUsd(n) {
  return n === null || n === undefined
    ? "N/A"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPrice(n) {
  return n === null || n === undefined
    ? "N/A"
    : n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
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
    : `${n >= 0 ? "+" : ""}${n.toFixed(5)}%`;
}
function fmtMin(n) {
  return n === null || n === undefined ? "N/A" : `${n.toFixed(2)}min`;
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

function theilSen(points) {
  if (points.length < 2) return null;
  const slopes = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x;
      if (dx === 0) continue;
      slopes.push((points[j].y - points[i].y) / dx);
    }
  if (slopes.length === 0) return null;
  slopes.sort((a, b) => a - b);
  const slope = percentile(slopes, 50);
  const intercepts = points.map((p) => p.y - slope * p.x).sort((a, b) => a - b);
  const intercept = percentile(intercepts, 50);
  return { slope, intercept };
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
    "Episodes discovered ENTIRELY from liquidation+price. OI loaded only for after-the-fact comparison. Existing OI Theil-Sen research untouched.",
  );
  console.log("=".repeat(170));

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;

  const allLiq = await liqCol
    .find({ symbol: SYMBOL, timestamp: { $gte: loadStartMs, $lte: evalEndMs } })
    .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
    .sort({ timestamp: 1 })
    .toArray();
  console.log(`DATASET: raw liquidation events=${allLiq.length}`);
  if (allLiq.length < 100) {
    console.log("Insufficient data.");
    await client.close();
    return;
  }
  const withPrice = allLiq.filter(
    (e) => e.price !== null && e.price !== undefined,
  ).length;
  console.log(
    `Liquidation events with own price field: ${withPrice} of ${allLiq.length}`,
  );

  const longEvents = allLiq
    .filter((e) => e.victim === "LONG")
    .sort((a, b) => a.timestamp - b.timestamp);
  const shortEvents = allLiq
    .filter((e) => e.victim === "SHORT")
    .sort((a, b) => a.timestamp - b.timestamp);

  // ============================================================
  // EPISODE DISCOVERY -- pure liquidation-flow state machine
  // ============================================================
  const episodes = [];
  let state = "IDLE"; // IDLE | ACTIVE
  let active = null;

  function causalP90P95(events, side, atTs) {
    const prior = events.filter(
      (e) =>
        e.victim === side &&
        e.timestamp < atTs &&
        e.timestamp >= atTs - BASELINE_DAYS * 86_400_000,
    );
    if (prior.length < MIN_LIVE_SAMPLE) return null;
    const vals = prior.map((e) => e.quoteQty ?? 0).sort((a, b) => a - b);
    return {
      p90: percentile(vals, 90),
      p95: percentile(vals, 95),
      n: prior.length,
    };
  }

  for (let i = 0; i < allLiq.length; i++) {
    const e = allLiq[i];
    if (state === "IDLE") {
      if (e.timestamp < evalStartMs) continue; // only start episodes within the evaluation period
      const stats = causalP90P95(allLiq, e.victim, e.timestamp);
      if (!stats) continue;
      if ((e.quoteQty ?? 0) >= stats.p90) {
        active = {
          direction: e.victim,
          startTs: e.timestamp,
          startEvent: e,
          events: [e],
          qualifyingP90: stats.p90,
          qualifyingP95: stats.p95,
          qualifyingN: stats.n,
          trainPoints: [],
          lastSameDirEvent: e,
          model: null,
          endReason: null,
          endTs: null,
          endTrigger: null,
          trace: [],
        };
        state = "ACTIVE";
      }
      continue;
    }
    // ACTIVE
    const gap = e.timestamp - active.events[active.events.length - 1].timestamp;
    if (gap > QUIET_GAP_MS) {
      active.endTs = active.events[active.events.length - 1].timestamp;
      active.endReason = "QUIET_10M";
      episodes.push(active);
      state = "IDLE";
      active = null;
      i--; // re-process this event as a potential new episode start
      continue;
    }

    active.events.push(e);
    if (e.victim === active.direction) {
      const X = e.quoteQty ?? 0;
      if (e.price !== null && active.lastSameDirEvent.price !== null) {
        const dPriceLog =
          Math.log(e.price / active.lastSameDirEvent.price) * 100;
        const model = active.model; // model BEFORE this observation
        const Yexp = model ? model.slope * X + model.intercept : null;
        const isReversal =
          active.direction === "LONG" ? dPriceLog >= 0 : dPriceLog <= 0;
        active.trace.push({
          ts: e.timestamp,
          X,
          actual: dPriceLog,
          modelBefore: model,
          Yexp,
          reversal: isReversal && active.trainPoints.length >= 2,
        });
        if (active.trainPoints.length >= 2 && isReversal) {
          active.endTs = e.timestamp;
          active.endReason = "THEIL_SEN";
          active.endTrigger = { X, actual: dPriceLog, Yexp, model };
          episodes.push(active);
          state = "IDLE";
          active = null;
          continue;
        }
        active.trainPoints.push({ x: X, y: dPriceLog });
        active.model = theilSen(active.trainPoints);
      }
      active.lastSameDirEvent = e;
    }
  }
  if (active) {
    active.endTs = active.events[active.events.length - 1].timestamp;
    active.endReason = "QUIET_10M(end-of-data)";
    episodes.push(active);
  }

  episodes.forEach((ep, i) => {
    ep.id = `L${String(i + 1).padStart(3, "0")}`;
  });
  console.log(`\nEpisodes discovered: ${episodes.length}`);

  // ============================================================
  // OI COMPARISON (after the fact, same START->END interval)
  // ============================================================
  const loadEndMs = evalEndMs;
  const allOiRaw = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: {
        $gte: new Date(loadStartMs - 65000),
        $lte: new Date(loadEndMs + 65000),
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
  for (const ep of episodes) {
    const startIdx = nearestObsIdxAtOrBefore(allOi, ep.startTs);
    const endIdx = nearestObsIdxAtOrBefore(allOi, ep.endTs);
    if (startIdx >= 0 && endIdx >= startIdx) {
      ep.oiStart = allOi[startIdx].contracts;
      ep.oiEnd = allOi[endIdx].contracts;
      ep.oiDelta = ep.oiEnd - ep.oiStart;
      ep.priceStartOi = priceAtOrBeforeIdx(allOi, startIdx);
      ep.priceEndOi = priceAtOrBeforeIdx(allOi, endIdx);
      ep.priceDeltaOi =
        ep.priceStartOi !== null && ep.priceEndOi !== null
          ? Math.log(ep.priceEndOi / ep.priceStartOi) * 100
          : null;
    }
    ep.sameDirUsd = ep.events
      .filter((e) => e.victim === ep.direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    ep.oppDirUsd = ep.events
      .filter((e) => e.victim !== ep.direction)
      .reduce((a, e) => a + (e.quoteQty ?? 0), 0);
  }

  // ============================================================
  // OUTPUT
  // ============================================================
  console.log(`\n${"=".repeat(170)}\nSUMMARY\n${"=".repeat(170)}`);
  console.log(`total liquidation episodes: ${episodes.length}`);
  console.log(
    `LONG: ${episodes.filter((e) => e.direction === "LONG").length}   SHORT: ${episodes.filter((e) => e.direction === "SHORT").length}`,
  );
  console.log(
    `THEIL_SEN end: ${episodes.filter((e) => e.endReason === "THEIL_SEN").length}   QUIET_10M end: ${episodes.filter((e) => e.endReason.startsWith("QUIET_10M")).length}`,
  );
  const durs = episodes
    .map((e) => (e.endTs - e.startTs) / 60000)
    .sort((a, b) => a - b);
  console.log(
    `\nduration distribution (min): median=${median(durs)?.toFixed(2)} P25=${percentile(durs, 25)?.toFixed(2)} P75=${percentile(durs, 75)?.toFixed(2)} MAX=${durs[durs.length - 1]?.toFixed(2)}`,
  );
  const usds = episodes.map((e) => e.sameDirUsd).sort((a, b) => a - b);
  console.log(
    `same-direction liquidation USD distribution: median=${fmtUsd(median(usds))} P25=${fmtUsd(percentile(usds, 25))} P75=${fmtUsd(percentile(usds, 75))}`,
  );

  console.log(`\n${"=".repeat(220)}\nCHRONOLOGICAL TABLE\n${"=".repeat(220)}`);
  console.log(
    "ID    | START                    | END                      | DIR   | DURATION | LIQ_USD    | END_REASON | OI_START   | OI_END     | OI_DELTA   | PRICE_START  | PRICE_END    | PRICE_DELTA",
  );
  episodes.forEach((ep) => {
    console.log(
      `${ep.id} | ${fmtDate(ep.startTs)} | ${fmtDate(ep.endTs)} | ${ep.direction.padEnd(5)} | ${fmtMin((ep.endTs - ep.startTs) / 60000).padEnd(8)} | ${fmtUsd(ep.sameDirUsd).padEnd(10)} | ${ep.endReason.padEnd(10)} | ${fmtBtc(ep.oiStart).padEnd(10)} | ${fmtBtc(ep.oiEnd).padEnd(10)} | ${fmtBtcDelta(ep.oiDelta).padEnd(10)} | ${fmtPrice(ep.priceStartOi).padEnd(12)} | ${fmtPrice(ep.priceEndOi).padEnd(12)} | ${fmtPct(ep.priceDeltaOi)}`,
    );
  });

  console.log(`\n${"=".repeat(170)}\nPER-EPISODE DETAIL\n${"=".repeat(170)}`);
  episodes.forEach((ep) => {
    console.log(`\n${ep.id}`);
    console.log(
      `START: ${fmtDate(ep.startTs)}   END: ${fmtDate(ep.endTs)}   END_REASON: ${ep.endReason}   direction: ${ep.direction}   duration: ${fmtMin((ep.endTs - ep.startTs) / 60000)}`,
    );
    console.log(
      `total same-direction liquidation USD: ${fmtUsd(ep.sameDirUsd)}   total opposite-direction: ${fmtUsd(ep.oppDirUsd)}`,
    );
    console.log(
      `P90 at start (qualifying threshold): ${fmtUsd(ep.qualifyingP90)}   P95: ${fmtUsd(ep.qualifyingP95)}   (from ${ep.qualifyingN} prior same-side events)`,
    );
    console.log(
      `number of liquidation observations: ${ep.events.length}   (${ep.trainPoints.length} same-direction training pairs)`,
    );
    console.log(
      `final Theil-Sen function: ${ep.model ? `f(X)=${ep.model.slope.toFixed(8)}*X+${ep.model.intercept.toFixed(6)}` : "N/A (insufficient pairs)"}`,
    );
    console.log(
      `OI over same interval: start=${fmtBtc(ep.oiStart)} end=${fmtBtc(ep.oiEnd)} delta=${fmtBtcDelta(ep.oiDelta)}   PRICE(OI-collection): start=${fmtPrice(ep.priceStartOi)} end=${fmtPrice(ep.priceEndOi)} delta=${fmtPct(ep.priceDeltaOi)}`,
    );
    if (ep.endReason === "THEIL_SEN" && ep.endTrigger) {
      console.log(
        `TRIGGER: X=${fmtUsd(ep.endTrigger.X)}  f(X)_before=${ep.endTrigger.Yexp !== null ? fmtPct(ep.endTrigger.Yexp) : "N/A"}  actual=${fmtPct(ep.endTrigger.actual)}  (sign-reversal vs adverse direction)`,
      );
    }
  });

  // ============================================================
  // SEVERAL FULL TRACES
  // ============================================================
  console.log(
    `\n${"=".repeat(200)}\nFULL TRACES -- first 3 episodes\n${"=".repeat(200)}`,
  );
  episodes.slice(0, 3).forEach((ep) => {
    console.log(`\n${ep.id}  ${ep.direction}  START=${fmtDate(ep.startTs)}`);
    ep.trace.forEach((t) => {
      console.log(
        `  event @ ${fmtDate(t.ts)}: X(liqUSD)=${fmtUsd(t.X)}  actual price response=${fmtPct(t.actual)}  model_before=${t.modelBefore ? `f(X)=${t.modelBefore.slope.toFixed(8)}*X+${t.modelBefore.intercept.toFixed(6)}` : "N/A"}  f(X)=${t.Yexp !== null ? fmtPct(t.Yexp) : "N/A"}  ${t.reversal ? "*** REVERSAL (would end here) ***" : "still ACTIVE (same-direction adverse sign preserved)"}`,
      );
    });
  });

  console.log(`\n${"=".repeat(170)}\nRUN COMPLETED SUCCESSFULLY`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
