/**
 * Sep 12 2026 (Karo), operator-requested. Pure extraction/formatting
 * script -- reads an ALREADY-GENERATED research JSON (from
 * research-cascade-end-detection.js) and prints the 6 requested
 * decision-tables. No new data fetching, no re-running research.
 */
const fs = require("fs");

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error("Usage: node extract-cascade-end-tables.js <path-to-json>");
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

function fmtUsd(n) {
  if (n === null || n === undefined) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(2) + "k";
  return "$" + n.toFixed(2);
}
function fmtMs(ms) {
  if (ms === null || ms === undefined) return "n/a";
  const s = ms / 1000;
  if (Math.abs(s) < 60) return s.toFixed(1) + "s";
  return (s / 60).toFixed(1) + "m";
}
function fmtPct(n) {
  return n === null || n === undefined ? "n/a" : n.toFixed(1) + "%";
}
function median(arr) {
  const s = [...arr]
    .filter((x) => x !== null && x !== undefined)
    .sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(arr, p) {
  const s = [...arr]
    .filter((x) => x !== null && x !== undefined)
    .sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

console.log("=".repeat(100));
console.log("1. END-DETECTION COMPARISON");
console.log("=".repeat(100));
if (data.sectionH_endDetectionCandidates) {
  console.log(
    "(NOTE, per the research script's own honest limitation note: only 'quiet gap' and 'event-size collapse' were actually computed with real numbers below. Rate-collapse, no-new-extreme, price-recovery, and their combinations were NOT pre-computed as detectors in the saved JSON -- only the raw per-event rolling-intensity data these would need is present, inside sectionC_D_representativeEpisodes, for the 20 representative episodes only. LONG/SHORT are NOT separated in the saved output.)",
  );
  console.log(
    "\nmethod | evaluated | correct-end% | false-end% | median delay | p75 delay | p90 delay",
  );
  for (const [name, r] of Object.entries(
    data.sectionH_endDetectionCandidates,
  )) {
    console.log(
      name +
        " | " +
        r.evaluatedEpisodes +
        " | " +
        fmtPct(r.correctEndPct) +
        " | " +
        fmtPct(r.falseEndPct) +
        " | " +
        fmtMs(r.medianDetectionDelayMs) +
        " | n/a (not saved) | n/a (not saved)",
    );
  }
  console.log(
    "\n  MISSING FROM SAVED JSON (would require a small follow-up pass, not a full re-run):",
  );
  console.log(
    "  - B (liquidation-rate collapse), D (no new extreme), E (price recovery), F/G/H (combinations)",
  );
  console.log("  - p75/p90 delay for A and C");
  console.log("  - median price movement lost while waiting, for any detector");
  console.log("  - LONG vs SHORT split");
} else console.log("sectionH_endDetectionCandidates not found in this JSON.");

console.log("\n" + "=".repeat(100));
console.log("2. QUIET-GAP FALSE-END TABLE");
console.log("=".repeat(100));
if (data.sectionG_falseEndAnalysis) {
  const gaps = ["10s", "20s", "30s", "60s", "90s", "120s"];
  console.log(
    "(aggregated across all " +
      data.sectionG_falseEndAnalysis.length +
      " multi-event episodes, weighted by candidate-endpoint count)",
  );
  console.log(
    "\ngap | candidate endings (total) | falseEnd% anyLater | falseEnd% >=medianSize | falseEnd% >=prior60sMedian | meaningful-extreme%",
  );
  for (const gap of gaps) {
    let totalCandidates = 0,
      sumAny = 0,
      sumMedSize = 0,
      sumPrior60 = 0;
    for (const ep of data.sectionG_falseEndAnalysis) {
      const a = ep.analysis[gap];
      if (!a || !a.candidateEndPoints) continue;
      totalCandidates += a.candidateEndPoints;
      sumAny += (a.falseEnd_anyLaterLiq_pct ?? 0) * a.candidateEndPoints;
      sumMedSize += (a.falseEnd_geMedianSize_pct ?? 0) * a.candidateEndPoints;
      sumPrior60 +=
        (a.falseEnd_gePrior60sMedian_pct ?? 0) * a.candidateEndPoints;
    }
    console.log(
      gap +
        " | " +
        totalCandidates +
        " | " +
        (totalCandidates ? fmtPct(sumAny / totalCandidates) : "n/a") +
        " | " +
        (totalCandidates ? fmtPct(sumMedSize / totalCandidates) : "n/a") +
        " | " +
        (totalCandidates ? fmtPct(sumPrior60 / totalCandidates) : "n/a") +
        " | NOT SAVED (meaningful-new-price-extreme false-end definition was not computed in sectionG)",
    );
  }
} else console.log("sectionG_falseEndAnalysis not found in this JSON.");

console.log("\n" + "=".repeat(100));
console.log("3. PRICE EXTREME VS LIQUIDATION END TIMING");
console.log("=".repeat(100));
if (data.sectionI_extremeVsEndOrdering) {
  const c = data.sectionI_extremeVsEndOrdering.counts;
  const total = data.sectionI_extremeVsEndOrdering.totalEpisodesClassified;
  const before = c["CASE_B_liq_ends_then_price_extreme"] || 0; // extreme AFTER final liq
  const atOrContinues = c["CASE_A_liq_continues_to_extreme_then_ends"] || 0;
  const after = c["CASE_C_intensity_collapse_residual_liqs_after_extreme"] || 0; // extreme BEFORE final liq (residual liqs after)
  console.log(
    "Total multi/single-event episodes classified: " +
      total +
      " (" +
      (c["UNKNOWN_NO_CANDLE_DATA"] || 0) +
      " excluded: no candle data)",
  );
  console.log(
    "\n% extreme occurs BEFORE final liquidation (residual liqs continued after the extreme): " +
      fmtPct((after / total) * 100),
  );
  console.log(
    "% extreme occurs approximately AT final liquidation (liq continues right up to the extreme, then ends): " +
      fmtPct((atOrContinues / total) * 100),
  );
  console.log(
    "% extreme occurs AFTER final liquidation (liq ends, price keeps moving to the extreme afterward): " +
      fmtPct((before / total) * 100),
  );
  console.log(
    "\nMedian timeExtremeToLastLiq / timeStartToExtreme are NOT pre-aggregated across all episodes in the saved JSON -- only per-representative-episode (n=" +
      (data.sectionC_D_representativeEpisodes?.length ?? 0) +
      ") values exist. Extracting from that small sample:",
  );
  if (data.sectionC_D_representativeEpisodes) {
    const extremeToLast = data.sectionC_D_representativeEpisodes
      .map((e) => e.priceBehavior.timeExtremeToLastLiqMs)
      .filter((v) => v !== null && v >= 0);
    const startToExtreme = data.sectionC_D_representativeEpisodes
      .map((e) => e.priceBehavior.timeStartToExtremeMs)
      .filter((v) => v !== null);
    console.log(
      "  median(extreme -> final liq), n=" +
        extremeToLast.length +
        " representative episodes: " +
        fmtMs(median(extremeToLast)),
    );
    console.log(
      "  median(start -> extreme), n=" +
        startToExtreme.length +
        " representative episodes: " +
        fmtMs(median(startToExtreme)),
    );
  }
} else console.log("sectionI_extremeVsEndOrdering not found in this JSON.");

console.log("\n" + "=".repeat(100));
console.log("4. RESIDUAL LIQUIDATION AFTER PRICE EXTREME");
console.log("=".repeat(100));
console.log("NOT COMPUTABLE FROM THE SAVED JSON AS-IS.");
console.log(
  "Reason: this requires the full per-event sequence AFTER each episode's own market-price",
);
console.log(
  "extreme, for EVERY episode where extreme occurred before the final liquidation event.",
);
console.log(
  "The saved JSON only persists full event-sequences for the 20 representative episodes",
);
console.log(
  "(sectionC_D_representativeEpisodes) -- the other ~" +
    ((data.sectionB_gapThresholdComparison?.find(
      (r) => r.gapThresholdSec === 60,
    )?.totalEpisodes ?? "?") -
      (data.sectionC_D_representativeEpisodes?.length ?? 0)) +
    " episodes only have aggregate totals saved, not their raw event arrays.",
);
console.log(
  "\nPartial answer from the 20-episode representative sample only (NOT the full 72h population):",
);
if (data.sectionC_D_representativeEpisodes) {
  const withResidual = data.sectionC_D_representativeEpisodes.filter(
    (e) =>
      e.priceBehavior.finalLiqOccurredBeforeExtreme === false &&
      e.priceBehavior.marketExtremeTs !== null,
  );
  const residualStats = withResidual.map((ep) => {
    const postExtreme = ep.events.filter(
      (e) => e.timestamp > ep.priceBehavior.marketExtremeTs,
    );
    return {
      count: postExtreme.length,
      usd: postExtreme.reduce((s, e) => s + e.quoteQty, 0),
      pctOfTotal:
        (postExtreme.reduce((s, e) => s + e.quoteQty, 0) / ep.totalLiqUsd) *
        100,
      timeToLastMs: ep.priceBehavior.timeExtremeToLastLiqMs,
    };
  });
  console.log(
    "  sample size: " +
      withResidual.length +
      " representative episodes with residual post-extreme liquidation",
  );
  console.log(
    "  median events after extreme: " +
      median(residualStats.map((r) => r.count)),
  );
  console.log(
    "  median USD after extreme: " +
      fmtUsd(median(residualStats.map((r) => r.usd))),
  );
  console.log(
    "  median % of episode total after extreme: " +
      fmtPct(median(residualStats.map((r) => r.pctOfTotal))),
  );
  console.log(
    "  median time extreme->final liq: " +
      fmtMs(median(residualStats.map((r) => r.timeToLastMs))),
  );
  console.log(
    "  p75 time: " +
      fmtMs(
        percentile(
          residualStats.map((r) => r.timeToLastMs),
          75,
        ),
      ),
  );
  console.log(
    "  p90 time: " +
      fmtMs(
        percentile(
          residualStats.map((r) => r.timeToLastMs),
          90,
        ),
      ),
  );
} else console.log("  (no representative episodes in this JSON)");
console.log(
  "\nTo get this across the FULL 72h population (not just 20 episodes), a small follow-up pass",
);
console.log(
  "re-reading liq_raw_events + the already-fetched candle range is needed -- this was NOT run",
);
console.log(
  "here per your own 'do not rerun research' instruction. Say the word and I'll write it.",
);

console.log("\n" + "=".repeat(100));
console.log(
  "5. SECOND-PUSH / FALSE-REVERSAL EXAMPLES (up to 10, from sectionH2)",
);
console.log("=".repeat(100));
if (data.sectionH2_falseEndExamples && data.sectionH2_falseEndExamples.length) {
  data.sectionH2_falseEndExamples.slice(0, 10).forEach((ep, i) => {
    const evs = ep.events;
    // crude split: find the largest internal gap as the "quiet gap" candidate
    let maxGapIdx = 0,
      maxGap = 0;
    for (let j = 1; j < evs.length; j++) {
      const g = evs[j].timeFromStartMs - evs[j - 1].timeFromStartMs;
      if (g > maxGap) {
        maxGap = g;
        maxGapIdx = j;
      }
    }
    const firstBurst = evs.slice(0, maxGapIdx);
    const secondPush = evs.slice(maxGapIdx);
    const firstBurstUsd = firstBurst.reduce((s, e) => s + e.quoteQty, 0);
    const secondPushUsd = secondPush.reduce((s, e) => s + e.quoteQty, 0);
    console.log(
      "\n#" +
        (i + 1) +
        " " +
        ep.episodeId +
        " victim=" +
        ep.victim +
        " totalLiq=" +
        fmtUsd(ep.totalLiqUsd),
    );
    console.log(
      "  first burst: " +
        firstBurst.length +
        " events, " +
        fmtUsd(firstBurstUsd),
    );
    console.log("  quiet gap length: " + fmtMs(maxGap));
    console.log(
      "  second push: " +
        secondPush.length +
        " events, " +
        fmtUsd(secondPushUsd),
    );
    console.log(
      "  did second push make a new price extreme? " +
        (ep.priceBehavior.finalLiqOccurredBeforeExtreme === false
          ? "YES (extreme at/after final liq)"
          : "UNCLEAR/NO from saved data"),
    );
    console.log("  time between pushes: " + fmtMs(maxGap));
  });
} else
  console.log(
    "sectionH2_falseEndExamples is empty or missing in this JSON -- no qualifying examples were found among the 20 representative episodes (the false-end filter in the research script only checked the 30s-gap definition).",
  );

console.log("\n" + "=".repeat(100));
console.log(
  "6. CLEAN-END EXAMPLES (up to 10, from remaining representative episodes)",
);
console.log("=".repeat(100));
if (data.sectionC_D_representativeEpisodes) {
  const falseIds = new Set(
    (data.sectionH2_falseEndExamples || []).map((e) => e.episodeId),
  );
  const clean = data.sectionC_D_representativeEpisodes.filter(
    (e) => !falseIds.has(e.episodeId),
  );
  clean.slice(0, 10).forEach((ep, i) => {
    console.log(
      "\n#" +
        (i + 1) +
        " " +
        ep.episodeId +
        " victim=" +
        ep.victim +
        " totalLiq=" +
        fmtUsd(ep.totalLiqUsd) +
        " events=" +
        ep.eventCount,
    );
    console.log("  duration: " + fmtMs(ep.durationMs));
    console.log(
      "  directional move: " + fmtPct(ep.priceBehavior.directionalMovePct),
    );
    console.log(
      "  final liq before extreme (residual after)? " +
        (ep.priceBehavior.finalLiqOccurredBeforeExtreme === false
          ? "YES"
          : ep.priceBehavior.finalLiqOccurredBeforeExtreme === true
            ? "NO (liq ended before extreme)"
            : "n/a"),
    );
  });
} else console.log("sectionC_D_representativeEpisodes not found in this JSON.");
