// FOUR-EPISODE EVENT-LEVEL IMPACT -- RESEARCH ONLY.
// Does NOT modify production code, episode detection, or macro merge
// logic. Pure historical read + print. Event-level (not episode-
// level) forensic analysis of the four already-known episodes.
//
//   node scripts/four-episodes-event-impact.js
//
// SCHEMA (confirmed from source in an earlier investigation this
// session, not guessed): oi_second_observations.price is an
// INDEPENDENT stored field (not derived from openInterestUsd/
// openInterest); liq_raw_events has timestamp/price/quoteQty/victim.
// Taker flow is intentionally NOT used anywhere in this script, per
// instruction.
//
// READ-ONLY: no writes/updates/deletes anywhere in this file.

require("dotenv/config");
const { MongoClient } = require("mongodb");

const SYMBOL = "BTCUSDT";
const EPISODES = [
  {
    name: "EP31",
    startMs: Date.parse("2026-09-20T02:24:27.128Z"),
    endMs: Date.parse("2026-09-20T02:36:15.129Z"),
  },
  {
    name: "EP32",
    startMs: Date.parse("2026-09-20T02:39:21.185Z"),
    endMs: Date.parse("2026-09-20T02:45:58.188Z"),
  },
  {
    name: "EP33",
    startMs: Date.parse("2026-09-20T02:54:09.182Z"),
    endMs: Date.parse("2026-09-20T03:02:37.147Z"),
  },
  {
    name: "EP34",
    startMs: Date.parse("2026-09-20T03:14:42.177Z"),
    endMs: Date.parse("2026-09-20T03:16:19.199Z"),
  },
];
const WINDOWS_SEC = [10, 30, 60];

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function hhmmssMs(ms) {
  return new Date(ms).toISOString().slice(11, 23);
}
function fmtUsd(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}
function fmtUsdPlain(n) {
  if (n === null || n === undefined) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
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
function fmtPriceDelta(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
}
function fmtPct(n) {
  return n === null || n === undefined
    ? "N/A"
    : `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
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
    "FOUR-EPISODE EVENT-LEVEL IMPACT (research only, no production changes)",
  );
  console.log("=".repeat(160));

  const fullStart = EPISODES[0].startMs - 5000;
  const fullEnd = EPISODES[EPISODES.length - 1].endMs + 65_000;
  const allOi = await oiCol
    .find({
      symbol: SYMBOL,
      timestamp: { $gte: new Date(fullStart), $lte: new Date(fullEnd) },
    })
    .project({ timestamp: 1, openInterest: 1, price: 1 })
    .sort({ timestamp: 1 })
    .toArray()
    .then((docs) =>
      docs.map((d) => ({
        ts: d.timestamp instanceof Date ? d.timestamp.getTime() : d.timestamp,
        contracts: d.openInterest,
        price: d.price,
      })),
    );
  console.log(`\nLoaded ${allOi.length} OI observations for the full span.`);

  function obsAtOrBefore(targetMs) {
    let best = null;
    for (const d of allOi) {
      if (d.ts <= targetMs) best = d;
      else break;
    }
    return best && d_valid(best) ? best : null;
  }
  function d_valid(d) {
    return (
      d &&
      d.contracts !== undefined &&
      d.contracts !== null &&
      d.price !== undefined &&
      d.price !== null
    );
  }
  function obsAtOrAfter(targetMs) {
    for (const d of allOi) {
      if (d.ts >= targetMs && d_valid(d)) return d;
    }
    return null;
  }

  const episodeEventLists = {};
  for (const ep of EPISODES) {
    episodeEventLists[ep.name] = await liqCol
      .find({ symbol: SYMBOL, timestamp: { $gte: ep.startMs, $lte: ep.endMs } })
      .project({ timestamp: 1, price: 1, quoteQty: 1, victim: 1 })
      .sort({ timestamp: 1 })
      .toArray();
  }

  // ============================================================
  // STEP 2 + 3 + 4 + 5 + 6 + 7: per-event listing, windowed impact,
  // decomposition, main table, ratios, overlap flags.
  // ============================================================
  const allEventRecords = {}; // episode name -> array of {event, windows[], nextGapSec, flags}

  for (const ep of EPISODES) {
    console.log(`\n${"=".repeat(160)}`);
    console.log(`${ep.name}`);
    console.log("=".repeat(160));

    const events = episodeEventLists[ep.name];
    const records = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      console.log(`\n${ep.name} EVENT #${i + 1}`);
      console.log(`${hhmmssMs(e.timestamp)}`);
      console.log(`${e.victim}`);
      console.log(`${fmtUsdPlain(e.quoteQty)}`);
      console.log(`${fmtPrice(e.price)}`);

      const baseline = obsAtOrBefore(e.timestamp);
      const next = events[i + 1];
      const nextGapSec = next ? (next.timestamp - e.timestamp) / 1000 : null;
      const flags = {
        inside10s: nextGapSec !== null && nextGapSec < 10,
        inside30s: nextGapSec !== null && nextGapSec < 30,
        inside60s: nextGapSec !== null && nextGapSec < 60,
      };

      const windows = [];
      for (const w of WINDOWS_SEC) {
        const afterObs = obsAtOrAfter(e.timestamp + w * 1000);
        if (!baseline || !afterObs) {
          windows.push({ w, valid: false });
          continue;
        }
        const priceDeltaUsd = afterObs.price - baseline.price;
        const priceDeltaPct =
          baseline.price !== 0 ? (priceDeltaUsd / baseline.price) * 100 : null;
        const oiDeltaBtc = afterObs.contracts - baseline.contracts;
        const contractEffectUsd = oiDeltaBtc * baseline.price;
        const priceEffectUsd = afterObs.contracts * priceDeltaUsd;
        const totalOiUsdChange = contractEffectUsd + priceEffectUsd;
        const liqUsd = e.quoteQty ?? 0;
        const per100k = liqUsd > 0 ? liqUsd / 100000 : null;
        windows.push({
          w,
          valid: true,
          priceBefore: baseline.price,
          priceAfter: afterObs.price,
          priceDeltaUsd,
          priceDeltaPct,
          oiBefore: baseline.contracts,
          oiAfter: afterObs.contracts,
          oiDeltaBtc,
          contractEffectUsd,
          priceEffectUsd,
          totalOiUsdChange,
          priceEffectPer100k: per100k
            ? Math.abs(priceEffectUsd) / per100k
            : null,
          contractEffectPer100k: per100k ? contractEffectUsd / per100k : null,
          priceMovePer100k: per100k ? priceDeltaUsd / per100k : null,
        });
      }

      records.push({ event: e, baseline, windows, nextGapSec, flags });
    }

    console.log(`\n${ep.name} MAIN EVENT TABLE`);
    console.log(
      "EVENT | TIME         | LIQ USD  | LIQ PRICE  | WINDOW | PRICE Δ   | OI Δ BTC | CONTRACT EFFECT | PRICE EFFECT ON OI USD | TOTAL OI USD Δ | NEXT GAP | <10s | <30s | <60s",
    );
    console.log("-".repeat(160));
    records.forEach((r, idx) => {
      r.windows.forEach((win) => {
        const row = win.valid
          ? `${fmtPriceDelta(win.priceDeltaUsd).padEnd(9)} | ${fmtBtcDelta(win.oiDeltaBtc).padEnd(8)} | ${fmtUsd(win.contractEffectUsd).padEnd(15)} | ${fmtUsd(win.priceEffectUsd).padEnd(23)} | ${fmtUsd(win.totalOiUsdChange)}`
          : `N/A (no valid observation in window)`;
        console.log(
          `#${String(idx + 1).padEnd(4)} | ${hhmmssMs(r.event.timestamp)} | ${fmtUsdPlain(r.event.quoteQty).padEnd(8)} | ${fmtPrice(r.event.price).padEnd(10)} | ${String(win.w).padStart(2)}s    | ${row}` +
            (win.w === 60
              ? `   | ${r.nextGapSec !== null ? r.nextGapSec.toFixed(1) + "s" : "N/A"} | ${r.flags.inside10s ? "YES" : "no"}  | ${r.flags.inside30s ? "YES" : "no"}  | ${r.flags.inside60s ? "YES" : "no"}`
              : ""),
        );
      });
    });

    console.log(
      `\n${ep.name} IMPACT RATIOS (per $100K liquidated, research metric only):`,
    );
    console.log(
      "EVENT | WINDOW | PRICE EFFECT/100K | CONTRACT EFFECT/100K | PRICE MOVE/100K",
    );
    records.forEach((r, idx) => {
      r.windows.forEach((win) => {
        if (!win.valid) return;
        console.log(
          `#${String(idx + 1).padEnd(4)} | ${String(win.w).padStart(2)}s    | ${fmtUsd(win.priceEffectPer100k).padEnd(18)} | ${fmtUsd(win.contractEffectPer100k).padEnd(21)} | ${fmtUsd(win.priceMovePer100k)}`,
        );
      });
    });

    allEventRecords[ep.name] = records;
  }

  // ============================================================
  // STEP 8: CLUSTER VIEW
  // ============================================================
  console.log(`\n${"=".repeat(160)}`);
  console.log("STEP 8 -- CLUSTER VIEW");
  console.log("=".repeat(160));

  const allGapsSec = [];
  for (const ep of EPISODES) {
    const events = episodeEventLists[ep.name];
    for (let i = 1; i < events.length; i++)
      allGapsSec.push((events[i].timestamp - events[i - 1].timestamp) / 1000);
  }
  allGapsSec.sort((a, b) => a - b);
  const p = (pct) =>
    allGapsSec.length
      ? allGapsSec[Math.floor((pct / 100) * (allGapsSec.length - 1))]
      : null;
  console.log(
    `\nEvent-spacing distribution across all 4 episodes (N=${allGapsSec.length} gaps):`,
  );
  console.log(
    `  min=${allGapsSec[0]?.toFixed(2)}s  p25=${p(25)?.toFixed(2)}s  median=${p(50)?.toFixed(2)}s  p75=${p(75)?.toFixed(2)}s  max=${allGapsSec[allGapsSec.length - 1]?.toFixed(2)}s`,
  );
  const clusterThresholdSec = p(50) ?? 5;
  console.log(
    `\nCLUSTER_GAP_THRESHOLD = median gap = ${clusterThresholdSec.toFixed(2)}s (data-derived, not an arbitrary fixed window:`,
  );
  console.log(
    `a gap smaller than the typical event-to-event spacing indicates unusually rapid succession).`,
  );

  const episodeClusters = {};
  for (const ep of EPISODES) {
    const events = episodeEventLists[ep.name];
    const clusters = [];
    let cur = events.length > 0 ? [events[0]] : [];
    for (let i = 1; i < events.length; i++) {
      const gapSec = (events[i].timestamp - events[i - 1].timestamp) / 1000;
      if (gapSec <= clusterThresholdSec) cur.push(events[i]);
      else {
        clusters.push(cur);
        cur = [events[i]];
      }
    }
    if (cur.length > 0) clusters.push(cur);
    episodeClusters[ep.name] = clusters;

    console.log(`\n${ep.name} CLUSTERS (${clusters.length}):`);
    clusters.forEach((c, idx) => {
      const startMs = c[0].timestamp,
        endMs = c[c.length - 1].timestamp;
      const totalUsd = c.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
      const startObs = obsAtOrBefore(startMs);
      const endObs = obsAtOrBefore(endMs);
      const oiDeltaBtc =
        startObs && endObs ? endObs.contracts - startObs.contracts : null;
      const contractEffectUsd =
        oiDeltaBtc !== null && startObs ? oiDeltaBtc * startObs.price : null;
      const priceEffectUsd =
        startObs && endObs
          ? endObs.contracts * (endObs.price - startObs.price)
          : null;

      console.log(`\nCLUSTER #${idx + 1}`);
      console.log(
        `START: ${hhmmssMs(startMs)}   END: ${hhmmssMs(endMs)}   DURATION: ${((endMs - startMs) / 1000).toFixed(1)}s`,
      );
      console.log(
        `EVENT COUNT: ${c.length}   TOTAL LIQ USD: ${fmtUsdPlain(totalUsd)}`,
      );
      console.log(
        `START PRICE: ${fmtPrice(startObs?.price)}   END PRICE: ${fmtPrice(endObs?.price)}   PRICE Δ: ${fmtPriceDelta(endObs && startObs ? endObs.price - startObs.price : null)}`,
      );
      console.log(
        `START OI: ${fmtBtc(startObs?.contracts)}   END OI: ${fmtBtc(endObs?.contracts)}   OI Δ BTC: ${fmtBtcDelta(oiDeltaBtc)}`,
      );
      console.log(
        `CONTRACT EFFECT USD: ${fmtUsd(contractEffectUsd)}   PRICE EFFECT ON OI USD: ${fmtUsd(priceEffectUsd)}`,
      );

      console.log(`Cluster impact AFTER cluster end:`);
      for (const w of WINDOWS_SEC) {
        const afterObs = obsAtOrAfter(endMs + w * 1000);
        if (!endObs || !afterObs) {
          console.log(`  +${w}s: N/A`);
          continue;
        }
        const pd = afterObs.price - endObs.price;
        const od = afterObs.contracts - endObs.contracts;
        const ce = od * endObs.price;
        const pe = afterObs.contracts * pd;
        console.log(
          `  +${w}s: price=${fmtPrice(afterObs.price)} (Δ${fmtPriceDelta(pd)})  OI=${fmtBtc(afterObs.contracts)} (Δ${fmtBtcDelta(od)})  CONTRACT_EFFECT=${fmtUsd(ce)}  PRICE_EFFECT_ON_OI_USD=${fmtUsd(pe)}`,
        );
      }
    });
  }

  // ============================================================
  // STEP 9: EPISODE SUMMARY
  // ============================================================
  console.log(`\n${"=".repeat(160)}`);
  console.log("STEP 9 -- EPISODE SUMMARY");
  console.log("=".repeat(160));
  console.log(
    "EPISODE | EVENTS | CLUSTERS | TOTAL LIQ  | PRICE Δ    | OI Δ BTC   | CONTRACT EFFECT | PRICE EFFECT ON OI USD",
  );
  console.log("-".repeat(120));

  for (const ep of EPISODES) {
    const events = episodeEventLists[ep.name];
    const totalLiq = events.reduce((a, e) => a + (e.quoteQty ?? 0), 0);
    const startObs = obsAtOrBefore(ep.startMs);
    const endObs = obsAtOrBefore(ep.endMs);
    const priceDelta =
      startObs && endObs ? endObs.price - startObs.price : null;
    const oiDeltaBtc =
      startObs && endObs ? endObs.contracts - startObs.contracts : null;
    const contractEffectUsd =
      oiDeltaBtc !== null && startObs ? oiDeltaBtc * startObs.price : null;
    const priceEffectUsd =
      startObs && endObs ? endObs.contracts * priceDelta : null;

    console.log(
      `${ep.name.padEnd(7)} | ${String(events.length).padEnd(6)} | ${String(episodeClusters[ep.name].length).padEnd(8)} | ${fmtUsdPlain(totalLiq).padEnd(10)} | ${fmtPriceDelta(priceDelta).padEnd(10)} | ${fmtBtcDelta(oiDeltaBtc).padEnd(10)} | ${fmtUsd(contractEffectUsd).padEnd(16)} | ${fmtUsd(priceEffectUsd)}`,
    );
  }

  for (const ep of EPISODES) {
    console.log(`\n${ep.name}:`);
    const events = episodeEventLists[ep.name];
    const clusters = episodeClusters[ep.name];
    const records = allEventRecords[ep.name];

    const largestEvent = [...events].sort(
      (a, b) => (b.quoteQty ?? 0) - (a.quoteQty ?? 0),
    )[0];
    console.log(
      `  LARGEST LIQ EVENT: ${largestEvent ? `${hhmmssMs(largestEvent.timestamp)} ${fmtUsdPlain(largestEvent.quoteQty)}` : "N/A"}`,
    );

    const clusterTotals = clusters.map((c) =>
      c.reduce((a, e) => a + (e.quoteQty ?? 0), 0),
    );
    const largestClusterIdx = clusterTotals.length
      ? clusterTotals.indexOf(Math.max(...clusterTotals))
      : -1;
    console.log(
      `  LARGEST LIQ CLUSTER: ${largestClusterIdx >= 0 ? `#${largestClusterIdx + 1} ${fmtUsdPlain(clusterTotals[largestClusterIdx])}` : "N/A"}`,
    );

    const all60sWindows = records
      .map((r, idx) => ({ idx, win: r.windows.find((w) => w.w === 60) }))
      .filter((x) => x.win && x.win.valid);
    const largestNegOi = [...all60sWindows].sort(
      (a, b) => a.win.oiDeltaBtc - b.win.oiDeltaBtc,
    )[0];
    const largestPosOi = [...all60sWindows].sort(
      (a, b) => b.win.oiDeltaBtc - a.win.oiDeltaBtc,
    )[0];
    console.log(
      `  LARGEST NEGATIVE OI MOVE AFTER EVENT (60s): ${largestNegOi ? `event #${largestNegOi.idx + 1} ${fmtBtcDelta(largestNegOi.win.oiDeltaBtc)} BTC` : "N/A"}`,
    );
    console.log(
      `  LARGEST POSITIVE OI MOVE AFTER EVENT (60s): ${largestPosOi ? `event #${largestPosOi.idx + 1} ${fmtBtcDelta(largestPosOi.win.oiDeltaBtc)} BTC` : "N/A"}`,
    );

    const largestNegPe = [...all60sWindows].sort(
      (a, b) => a.win.priceEffectUsd - b.win.priceEffectUsd,
    )[0];
    const largestPosPe = [...all60sWindows].sort(
      (a, b) => b.win.priceEffectUsd - a.win.priceEffectUsd,
    )[0];
    console.log(
      `  LARGEST NEGATIVE PRICE EFFECT (60s): ${largestNegPe ? `event #${largestNegPe.idx + 1} ${fmtUsd(largestNegPe.win.priceEffectUsd)}` : "N/A"}`,
    );
    console.log(
      `  LARGEST POSITIVE PRICE EFFECT (60s): ${largestPosPe ? `event #${largestPosPe.idx + 1} ${fmtUsd(largestPosPe.win.priceEffectUsd)}` : "N/A"}`,
    );
  }
  console.log(
    "\n(These are magnitude rankings, not causal proof, per instruction.)",
  );

  // ============================================================
  // STEP 10: SPECIAL COMPARISON EP31 vs EP32
  // ============================================================
  console.log(`\n${"=".repeat(160)}`);
  console.log(
    "STEP 10 -- SPECIAL COMPARISON: EP31 vs EP32 (numerically, where did OI destruction concentrate)",
  );
  console.log("=".repeat(160));

  for (const epName of ["EP31", "EP32"]) {
    console.log(
      `\n${epName} -- per-event OI level immediately before/after (60s window), chronological:`,
    );
    console.log(
      "EVENT | TIME         | LIQ USD  | OI BEFORE  | OI AFTER (60s) | OI Δ (60s) | RUNNING OI (at event's own baseline)",
    );
    const records = allEventRecords[epName];
    records.forEach((r, idx) => {
      const win60 = r.windows.find((w) => w.w === 60);
      console.log(
        `#${String(idx + 1).padEnd(4)} | ${hhmmssMs(r.event.timestamp)} | ${fmtUsdPlain(r.event.quoteQty).padEnd(8)} | ${fmtBtc(r.baseline?.contracts).padEnd(10)} | ${(win60?.valid ? fmtBtc(win60.oiAfter) : "N/A").padEnd(15)} | ${(win60?.valid ? fmtBtcDelta(win60.oiDeltaBtc) : "N/A").padEnd(10)} | ${fmtBtc(r.baseline?.contracts)}`,
      );
    });
  }
  console.log(
    "\nRead the OI BEFORE column top-to-bottom within each episode above to see numerically whether OI rose",
  );
  console.log(
    "then fell, or fell steadily, or fell concentrated around one specific event -- no speculation added here.",
  );

  // ============================================================
  // FOOTER
  // ============================================================
  console.log(`\n${"=".repeat(160)}`);
  console.log("FILES CREATED");
  console.log("  scripts/four-episodes-event-impact.js");
  console.log("FILES MODIFIED");
  console.log("  (none)");
  console.log("COLLECTIONS USED");
  console.log("  oi_second_observations, liq_raw_events");
  console.log("FIELDS USED");
  console.log(
    "  oi_second_observations: symbol, timestamp, openInterest, price",
  );
  console.log("  liq_raw_events: symbol, timestamp, price, quoteQty, victim");
  console.log("DATA LIMITATIONS");
  console.log(
    "  - +10s/+30s/+60s 'after' values use the first valid OI observation AT OR AFTER the target",
  );
  console.log(
    "    timestamp (~1s polling), not an exact tick at exactly +10.000s -- printed windows are the",
  );
  console.log(
    "    nearest causally-valid observation, never interpolated or invented.",
  );
  console.log(
    "  - Overlapping windows are NOT summed into episode totals anywhere in this script (Step 7/9",
  );
  console.log(
    "    totals use direct episode-level start/end deltas, not a sum of per-event window deltas).",
  );
  console.log("  - Taker flow not used in this script, per instruction.");
  console.log(
    "  - oi_second_observations has a 3-day TTL; if run long after Sep 20 2026 some data may be gone.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
