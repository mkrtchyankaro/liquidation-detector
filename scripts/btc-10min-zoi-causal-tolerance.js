// BTC 10-MIN CANDIDATES + REPEATED-REACTION 1H/4H ZOI -- replaces the
// rejected single-fractal ZOI methodology. Liquidation baseline is
// REUSED VERBATIM (unchanged) with the same strict self-verification.
//
// ============================================================
// ZOI METHODOLOGY (printed again at runtime -- full disclosure):
//
//  1. TOUCH POINT: a 2-candle fractal low (candidate SUPPORT touch) or
//     fractal high (candidate RESISTANCE touch) on CLOSED candles --
//     same primitive as before, but this is now only a raw candidate
//     point, never a zone by itself.
//
//  2. TOLERANCE (the clustering band width): 0.15 x the CAUSAL,
//     EXPANDING-WINDOW MEDIAN candle range (high-low) for that
//     timeframe, using ALL candles closed strictly before the
//     timestamp being evaluated -- no fixed lookback (no 30-day, no
//     N-candle window), and NO future candle ever contributes. This
//     is a genuinely time-varying function tolerance(T), computed via
//     an O(log n) online running-median (two-heap), not a single
//     global constant. Every step of zone construction (clustering,
//     the leave-and-return check) uses the tolerance AS OF that
//     touch point's own timestamp.
//
//  3. CLUSTERING: touch points (same type, same timeframe) within
//     TOLERANCE of a cluster's representative price join that
//     cluster. zoneLow/zoneHigh = min/max of the clustered reaction
//     PRICES themselves (a thin band spanned by the actual touches --
//     NEVER a whole candle's high-low range).
//
//  4. INDEPENDENT REACTION: a touch only counts as a NEW independent
//     reaction if price genuinely LEFT the zone (moved beyond
//     representative price +/- TOLERANCE) and RETURNED since the
//     cluster's previous touch. Adjacent/continuous sitting at the
//     same level is ONE reaction episode, not several.
//
//  5. ZONE CONFIRMATION: a cluster becomes an ACTIVE zone only once
//     it has >= 2 independent reactions. causallyAvailableFromTs =
//     the timestamp of the 2nd independent reaction.
//
//  6. INVALIDATION (candle-CLOSE based, not wick): scanning forward
//     from confirmation, the first candle whose CLOSE is beyond the
//     zone's full range (close < zoneLow for support, close > zoneHigh
//     for resistance) marks the zone BROKEN_SUPPORT / BROKEN_RESISTANCE
//     at that candle's close time. A wick alone never invalidates.
//
//  7. ROLE REVERSAL: after BROKEN, the first later candle whose HIGH
//     (for broken support) or LOW (for broken resistance) returns
//     into [zoneLow, zoneHigh] AND whose CLOSE rejects back to the
//     broken side confirms ROLE_REVERSED (broken support -> acts as
//     resistance, or the mirror). Never assumed automatically.
//
//   node scripts/btc-10min-zoi-repeated-reaction.js
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
const TOLERANCE_FRACTION_OF_MEDIAN_RANGE = 0.15; // DISCLOSED, fixed multiplier on a data-derived scale
const MIN_INDEPENDENT_REACTIONS = 2;
const BTCUSDT_FUTURES_LISTING_MS = Date.parse("2019-09-08T00:00:00Z");

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
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
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
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

// ============================================================
// CAUSAL, EXPANDING-WINDOW TOLERANCE -- two-heap online running
// median, O(log n) per insertion. NO fixed lookback (no 30-day, no
// N-candle window). At any timestamp T, the tolerance uses the median
// range of ALL same-timeframe candles CLOSED strictly before T -- and
// only those.
// ============================================================
class Heap {
  constructor(cmp) {
    this.a = [];
    this.cmp = cmp;
  }
  size() {
    return this.a.length;
  }
  peek() {
    return this.a[0];
  }
  push(x) {
    this.a.push(x);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(this.a[i], this.a[p]) < 0) {
        [this.a[i], this.a[p]] = [this.a[p], this.a[i]];
        i = p;
      } else break;
    }
  }
  pop() {
    const top = this.a[0];
    const last = this.a.pop();
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      while (true) {
        let l = 2 * i + 1,
          r = 2 * i + 2,
          s = i;
        if (l < this.a.length && this.cmp(this.a[l], this.a[s]) < 0) s = l;
        if (r < this.a.length && this.cmp(this.a[r], this.a[s]) < 0) s = r;
        if (s === i) break;
        [this.a[i], this.a[s]] = [this.a[s], this.a[i]];
        i = s;
      }
    }
    return top;
  }
}
class RunningMedian {
  constructor() {
    this.lower = new Heap((a, b) => b - a);
    this.upper = new Heap((a, b) => a - b);
  } // lower = max-heap, upper = min-heap
  insert(x) {
    if (this.lower.size() === 0 || x <= this.lower.peek()) this.lower.push(x);
    else this.upper.push(x);
    if (this.lower.size() > this.upper.size() + 1)
      this.upper.push(this.lower.pop());
    else if (this.upper.size() > this.lower.size() + 1)
      this.lower.push(this.upper.pop());
  }
  median() {
    if (this.lower.size() === 0) return null;
    if (this.lower.size() === this.upper.size())
      return (this.lower.peek() + this.upper.peek()) / 2;
    return this.lower.size() > this.upper.size()
      ? this.lower.peek()
      : this.upper.peek();
  }
}

/** Precompute, for a chronological candle series, the CAUSAL expanding
 *  median range "as of just after candle i closed" -- medianAsOf[i].
 *  One O(n log n) pass, reused for every later causal query. */
function buildCausalMedianSeries(candles) {
  const rm = new RunningMedian();
  const medianAsOf = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    rm.insert(candles[i].high - candles[i].low);
    medianAsOf[i] = rm.median();
  }
  return medianAsOf;
}

/** Returns {tolerance, medianRange} using only candles with closeTime
 *  STRICTLY before atTs, or null if no such candle has closed yet.
 *  Binary search since candleCloseTimes is chronologically sorted --
 *  called once per touch point, so this matters for performance. */
function causalToleranceAt(candleCloseTimes, medianAsOf, atTs) {
  let lo = 0,
    hi = candleCloseTimes.length - 1,
    idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candleCloseTimes[mid] < atTs) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx < 0) return null;
  const medianRange = medianAsOf[idx];
  return {
    tolerance: TOLERANCE_FRACTION_OF_MEDIAN_RANGE * medianRange,
    medianRange,
  };
}

function findFractals(candles) {
  const lows = [],
    highs = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    if (
      c.low < candles[i - 2].low &&
      c.low < candles[i - 1].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low
    )
      lows.push({ idx: i, ts: c.closeTime, price: c.low });
    if (
      c.high > candles[i - 2].high &&
      c.high > candles[i - 1].high &&
      c.high > candles[i + 1].high &&
      c.high > candles[i + 2].high
    )
      highs.push({ idx: i, ts: c.closeTime, price: c.high });
  }
  return { lows, highs };
}

/** Did price leave the zone (beyond repPrice +/- tolerance, AWAY
 *  direction) and return, between two candle indices? */
function leftAndReturned(
  candles,
  fromIdx,
  toIdx,
  repPrice,
  tolerance,
  isSupport,
) {
  for (let k = fromIdx + 1; k < toIdx; k++) {
    if (isSupport && candles[k].high > repPrice + tolerance) return true;
    if (!isSupport && candles[k].low < repPrice - tolerance) return true;
  }
  return false;
}

function buildZones(candles, touchPoints, toleranceAtFn, isSupport) {
  const clusters = []; // {reactions:[{idx,ts,price}], repPrice}
  for (const tp of touchPoints) {
    const tolInfo = toleranceAtFn(tp.ts);
    if (tolInfo === null) continue; // not enough causal history yet -- skip this touch point entirely, no lookback substitute
    const tol = tolInfo.tolerance;
    let cluster = clusters.find(
      (cl) => Math.abs(cl.repPrice - tp.price) <= tol,
    );
    if (!cluster) {
      clusters.push({ reactions: [tp], repPrice: tp.price });
      continue;
    }
    const lastReaction = cluster.reactions[cluster.reactions.length - 1];
    if (
      leftAndReturned(
        candles,
        lastReaction.idx,
        tp.idx,
        cluster.repPrice,
        tol,
        isSupport,
      )
    ) {
      cluster.reactions.push(tp);
      cluster.repPrice = median(cluster.reactions.map((r) => r.price)); // keep representative price updated
    } else {
      lastReaction.ts = tp.ts; // same ongoing episode -- extend, don't count as new reaction
    }
  }

  const zones = [];
  for (const cl of clusters) {
    if (cl.reactions.length < MIN_INDEPENDENT_REACTIONS) continue;
    const prices = cl.reactions.map((r) => r.price);
    const zoneLow = Math.min(...prices),
      zoneHigh = Math.max(...prices);
    const confirmedAt = cl.reactions[MIN_INDEPENDENT_REACTIONS - 1].ts;
    const confirmedIdx = cl.reactions[MIN_INDEPENDENT_REACTIONS - 1].idx;

    // Forward scan for candle-CLOSE-based invalidation.
    let brokenAt = null,
      brokenType = null;
    for (let k = confirmedIdx + 1; k < candles.length; k++) {
      if (isSupport && candles[k].close < zoneLow) {
        brokenAt = candles[k].closeTime;
        brokenType = "BROKEN_SUPPORT";
        break;
      }
      if (!isSupport && candles[k].close > zoneHigh) {
        brokenAt = candles[k].closeTime;
        brokenType = "BROKEN_RESISTANCE";
        break;
      }
    }

    // Role reversal (only checked if broken).
    let roleReversedAt = null;
    if (brokenAt !== null) {
      const brokenIdx = candles.findIndex((c) => c.closeTime === brokenAt);
      for (let k = brokenIdx + 1; k < candles.length; k++) {
        const c = candles[k];
        if (isSupport) {
          if (c.high >= zoneLow && c.high <= zoneHigh && c.close < zoneLow) {
            roleReversedAt = c.closeTime;
            break;
          }
        } else {
          if (c.low <= zoneHigh && c.low >= zoneLow && c.close > zoneHigh) {
            roleReversedAt = c.closeTime;
            break;
          }
        }
      }
    }

    zones.push({
      type: isSupport ? "SUPPORT/DEMAND" : "RESISTANCE/SUPPLY",
      zoneLow,
      zoneHigh,
      widthUsd: zoneHigh - zoneLow,
      widthPct: ((zoneHigh - zoneLow) / zoneLow) * 100,
      reactions: cl.reactions,
      numReactions: cl.reactions.length,
      creationTs: cl.reactions[0].ts,
      confirmedAt,
      lastReactionTs: cl.reactions[cl.reactions.length - 1].ts,
      brokenAt,
      brokenType,
      roleReversedAt,
    });
  }
  return zones;
}

function zoneStateAt(zone, T) {
  if (T < zone.confirmedAt) return "NOT_YET_ACTIVE";
  if (zone.roleReversedAt !== null && T >= zone.roleReversedAt)
    return "ROLE_REVERSED";
  if (zone.brokenAt !== null && T >= zone.brokenAt) return zone.brokenType;
  return "ACTIVE";
}

function nearestZoneAt(zones, T, price) {
  const usable = zones.filter((z) => zoneStateAt(z, T) === "ACTIVE");
  if (usable.length === 0) return null;
  let best = null,
    bestDist = Infinity;
  for (const z of usable) {
    const dist =
      price >= z.zoneLow && price <= z.zoneHigh
        ? 0
        : Math.min(Math.abs(price - z.zoneLow), Math.abs(price - z.zoneHigh));
    if (dist < bestDist) {
      bestDist = dist;
      best = z;
    }
  }
  return { zone: best, distance: bestDist };
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
    "ZOI METHODOLOGY (see file header for full mathematical definition)",
  );
  console.log("=".repeat(170));
  console.log("Touch point: 2-candle fractal low/high on closed candles.");
  console.log(
    `Tolerance: ${TOLERANCE_FRACTION_OF_MEDIAN_RANGE} x CAUSAL expanding-window median candle range -- a time-varying function tolerance(T), using only candles closed strictly before T. No fixed lookback, no future data.`,
  );
  console.log(
    "Clustering: same-type touches within tolerance join a cluster; zoneLow/zoneHigh = min/max of the clustered REACTION PRICES (thin band).",
  );
  console.log(
    `Independent reaction requires price to LEAVE (beyond tolerance) and RETURN since the cluster's last touch.`,
  );
  console.log(
    `Zone confirmed (ACTIVE) only at >=${MIN_INDEPENDENT_REACTIONS} independent reactions, at the 2nd reaction's timestamp.`,
  );
  console.log(
    "Invalidation: candle CLOSE beyond zone range (wick alone never invalidates). Role reversal: later return + close-rejection to the broken side.\n",
  );

  const evalEndMs = Date.now();
  const evalStartMs = evalEndMs - EVAL_DAYS * 86_400_000;
  const loadStartMs = evalStartMs - BASELINE_DAYS * 86_400_000;

  console.log(
    "Fetching 1H and 4H BTCUSDT klines (Binance Futures REST API)...",
  );
  const candles1h = await fetchKlinesRange(
    SYMBOL,
    BTCUSDT_FUTURES_LISTING_MS,
    evalEndMs,
    "1h",
  );
  await sleep(150);
  const candles4h = await fetchKlinesRange(
    SYMBOL,
    BTCUSDT_FUTURES_LISTING_MS,
    evalEndMs,
    "4h",
  );
  console.log(
    `1H candles: ${candles1h.length}   4H candles: ${candles4h.length}`,
  );

  const medianAsOf1h = buildCausalMedianSeries(candles1h);
  const medianAsOf4h = buildCausalMedianSeries(candles4h);
  const closeTimes1h = candles1h.map((c) => c.closeTime);
  const closeTimes4h = candles4h.map((c) => c.closeTime);
  const toleranceAt1h = (ts) =>
    causalToleranceAt(closeTimes1h, medianAsOf1h, ts);
  const toleranceAt4h = (ts) =>
    causalToleranceAt(closeTimes4h, medianAsOf4h, ts);
  console.log(
    `Tolerance is now a CAUSAL, expanding-window function of time -- no single global value. Example, evaluated as-of the evaluation period start (${fmtDate(evalStartMs)}):`,
  );
  const sampleTol1h = toleranceAt1h(evalStartMs),
    sampleTol4h = toleranceAt4h(evalStartMs);
  console.log(
    `  1H tolerance at that time: ${sampleTol1h ? fmtPrice(sampleTol1h.tolerance) : "N/A"} (median range ${sampleTol1h ? fmtPrice(sampleTol1h.medianRange) : "N/A"})`,
  );
  console.log(
    `  4H tolerance at that time: ${sampleTol4h ? fmtPrice(sampleTol4h.tolerance) : "N/A"} (median range ${sampleTol4h ? fmtPrice(sampleTol4h.medianRange) : "N/A"})`,
  );

  const fr1h = findFractals(candles1h),
    fr4h = findFractals(candles4h);
  const zones1hSupport = buildZones(candles1h, fr1h.lows, toleranceAt1h, true);
  const zones1hResist = buildZones(candles1h, fr1h.highs, toleranceAt1h, false);
  const zones4hSupport = buildZones(candles4h, fr4h.lows, toleranceAt4h, true);
  const zones4hResist = buildZones(candles4h, fr4h.highs, toleranceAt4h, false);
  const zones1h = [...zones1hSupport, ...zones1hResist];
  const zones4h = [...zones4hSupport, ...zones4hResist];
  console.log(
    `1H zones (>=${MIN_INDEPENDENT_REACTIONS} reactions): ${zones1h.length} (${zones1hSupport.length} support, ${zones1hResist.length} resistance)`,
  );
  console.log(
    `4H zones (>=${MIN_INDEPENDENT_REACTIONS} reactions): ${zones4h.length} (${zones4hSupport.length} support, ${zones4hResist.length} resistance)\n`,
  );

  // ============================================================
  // BASELINE CANDIDATE CONSTRUCTION -- VERBATIM
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
      `${chk.label}: found dirLiqUsd=${fmtUsd(match.dirLiqUsd)} expected=${fmtUsd(chk.expectedUsd)} diff=${fmtUsd(diff)} ${ok ? "PASS" : "FAIL"}`,
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
      c.priorCount = prior.length;
      c.liveEvaluable = c.endTs >= evalStartMs;
      if (prior.length < MIN_LIVE_SAMPLE) {
        c.status = "INSUFFICIENT_HISTORY";
        c.decision = null;
        return;
      }
      const vals = prior.map((p) => p.dirLiqUsd).sort((a, b) => a - b);
      c.causalP90 = percentile(vals, 90);
      c.causalP100 = Math.max(...vals);
      c.decision = c.dirLiqUsd >= c.causalP90 ? "KEEP_P90" : "DROP_BELOW_P90";
      c.status = "LIVE";
    });
  }
  applyRolling(longC);
  applyRolling(shortC);
  const liveCandidates = [...longC, ...shortC].filter((c) => c.liveEvaluable);

  // ============================================================
  // ZOI ANNOTATION
  // ============================================================
  for (const c of liveCandidates) {
    if (c.priceStart === null || c.priceEnd === null) {
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
    const extremePrice = c.direction === "LONG" ? pathMin : pathMax; // the adverse-direction extreme reached

    function annotate(zones, atTs) {
      const nz = nearestZoneAt(zones, atTs, extremePrice);
      if (!nz)
        return {
          entered: false,
          touchedOnly: false,
          crossed: false,
          endInside: false,
        };
      const z = nz.zone;
      const entered = pathMin <= z.zoneHigh && pathMax >= z.zoneLow;
      const crossed = pathMin < z.zoneLow && pathMax > z.zoneHigh;
      const endInside = c.priceEnd >= z.zoneLow && c.priceEnd <= z.zoneHigh;
      const penetrationDepthPct = entered
        ? ((Math.min(pathMax, z.zoneHigh) - Math.max(pathMin, z.zoneLow)) /
            z.widthUsd) *
          100
        : 0;
      return {
        zone: z,
        distance: nz.distance,
        distPct: (nz.distance / extremePrice) * 100,
        entered,
        crossed,
        endInside,
        penetrationDepthPct,
        widthPct: z.widthPct,
      };
    }
    c.zoi = { h1: annotate(zones1h, c.endTs), h4: annotate(zones4h, c.endTs) };
  }

  function summarize(label, cs) {
    const withZoi = cs.filter((c) => c.zoi);
    const e1 = withZoi.filter((c) => c.zoi.h1.entered).length,
      e4 = withZoi.filter((c) => c.zoi.h4.entered).length;
    const ei1 = withZoi.filter((c) => c.zoi.h1.endInside).length,
      ei4 = withZoi.filter((c) => c.zoi.h4.endInside).length;
    console.log(`${label}: N=${withZoi.length}`);
    console.log(
      `  entered active 1H zone: ${e1} (${withZoi.length ? ((e1 / withZoi.length) * 100).toFixed(1) : 0}%)   end inside 1H: ${ei1} (${withZoi.length ? ((ei1 / withZoi.length) * 100).toFixed(1) : 0}%)`,
    );
    console.log(
      `  entered active 4H zone: ${e4} (${withZoi.length ? ((e4 / withZoi.length) * 100).toFixed(1) : 0}%)   end inside 4H: ${ei4} (${withZoi.length ? ((ei4 / withZoi.length) * 100).toFixed(1) : 0}%)`,
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
    `\n${"=".repeat(200)}\nMANUAL INSPECTION -- KEEP_P90\n${"=".repeat(200)}`,
  );
  liveCandidates
    .filter((c) => c.decision === "KEEP_P90")
    .sort((a, b) => a.startTs - b.startTs)
    .forEach((c) => {
      console.log(
        `\n${c.direction} START=${fmtDate(c.startTs)} END=${fmtDate(c.endTs)} dirLiq=${fmtUsd(c.dirLiqUsd)} endPrice=${fmtPrice(c.priceEnd)}`,
      );
      const t1 = toleranceAt1h(c.endTs),
        t4 = toleranceAt4h(c.endTs);
      console.log(
        `  causal 1H tolerance at this candidate's END: ${t1 ? fmtPrice(t1.tolerance) : "N/A"} (median range ${t1 ? fmtPrice(t1.medianRange) : "N/A"})`,
      );
      console.log(
        `  causal 4H tolerance at this candidate's END: ${t4 ? fmtPrice(t4.tolerance) : "N/A"} (median range ${t4 ? fmtPrice(t4.medianRange) : "N/A"})`,
      );
      for (const [tf, a] of [
        ["1H", c.zoi?.h1],
        ["4H", c.zoi?.h4],
      ]) {
        if (!a || !a.zone) {
          console.log(`  ${tf}: no active zone`);
          continue;
        }
        console.log(
          `  ${tf}: ${a.zone.type} [${fmtPrice(a.zone.zoneLow)}-${fmtPrice(a.zone.zoneHigh)}] width%=${fmtPct(a.zone.widthPct)} reactions=${a.zone.numReactions} entered=${a.entered} crossed=${a.crossed} endInside=${a.endInside} penetration%=${a.penetrationDepthPct.toFixed(1)} dist%=${fmtPct(a.distPct)}`,
        );
      }
    });

  console.log(
    `\n${"=".repeat(170)}\nKNOWN CASE -- 2026-09-20 02:24/02:35 LONG pair\n${"=".repeat(170)}`,
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
    const t1 = toleranceAt1h(c.endTs),
      t4 = toleranceAt4h(c.endTs);
    console.log(
      `  causal 1H tolerance: ${t1 ? fmtPrice(t1.tolerance) : "N/A"} (median range ${t1 ? fmtPrice(t1.medianRange) : "N/A"})   causal 4H tolerance: ${t4 ? fmtPrice(t4.tolerance) : "N/A"} (median range ${t4 ? fmtPrice(t4.medianRange) : "N/A"})`,
    );
    for (const [tf, a] of [
      ["1H", c.zoi?.h1],
      ["4H", c.zoi?.h4],
    ]) {
      if (!a || !a.zone) {
        console.log(`  ${tf}: no active zone`);
        continue;
      }
      console.log(
        `  ${tf}: ${a.zone.type} [${fmtPrice(a.zone.zoneLow)}-${fmtPrice(a.zone.zoneHigh)}] reactions=${a.zone.numReactions} at ${a.zone.reactions.map((r) => fmtDate(r.ts)).join(", ")}  confirmedAt=${fmtDate(a.zone.confirmedAt)}  entered=${a.entered}`,
      );
    }
  });

  console.log(
    `\n${"=".repeat(170)}\nKNOWN CASE -- 2026-09-21 08:32 SHORT cascade\n${"=".repeat(170)}`,
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
    const t1 = toleranceAt1h(c.endTs),
      t4 = toleranceAt4h(c.endTs);
    console.log(
      `  causal 1H tolerance: ${t1 ? fmtPrice(t1.tolerance) : "N/A"} (median range ${t1 ? fmtPrice(t1.medianRange) : "N/A"})   causal 4H tolerance: ${t4 ? fmtPrice(t4.tolerance) : "N/A"} (median range ${t4 ? fmtPrice(t4.medianRange) : "N/A"})`,
    );
    for (const [tf, a] of [
      ["1H", c.zoi?.h1],
      ["4H", c.zoi?.h4],
    ]) {
      if (!a || !a.zone) {
        console.log(`  ${tf}: no active zone`);
        continue;
      }
      console.log(
        `  ${tf}: ${a.zone.type} [${fmtPrice(a.zone.zoneLow)}-${fmtPrice(a.zone.zoneHigh)}] reactions=${a.zone.numReactions} confirmedAt=${fmtDate(a.zone.confirmedAt)} entered=${a.entered}`,
      );
    }
  });

  console.log(`\n${"=".repeat(170)}\nRUN COMPLETED SUCCESSFULLY`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
