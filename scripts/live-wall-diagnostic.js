// TEMPORARY LIVE WALL DIAGNOSTIC -- standalone, does NOT touch
// production code or process. Connects directly to Binance's PUBLIC
// depth20@100ms stream and replicates the EXACT logic found in
// src/domain/liquidation/wall-tracker.service.ts (config defaults
// from src/infrastructure/config/observability.config.ts), with
// added instrumentation to print the precise reason every candidate
// wall lives or dies -- specifically testing whether walls are being
// PULLED before reaching minPersistenceMs (3000ms), which is the
// code-proven mechanism identified for why nearestBidWall*/
// nearestAskWall* end up null even when wallsPulled1m > 0.
//
//   node scripts/live-wall-diagnostic.js BTCUSDT 300
//
// (arg1 = symbol, default BTCUSDT; arg2 = run duration in seconds,
// default 300 = 5 minutes)
//
// READ-ONLY / OBSERVE-ONLY: opens a public WebSocket, computes in
// memory, prints to console. No writes anywhere, no connection to
// the production bot or its database.
//
// REQUIRES Node 22+ (native global WebSocket). If your VPS runs an
// older Node and this errors with "WebSocket is not defined", run:
//   npm install ws --no-save
// then replace the two lines below marked NODE<22 FALLBACK.

const SYMBOL = (process.argv[2] ?? "BTCUSDT").toUpperCase();
const RUN_SECONDS = Number(process.argv[3] ?? "300");

// Exact config values read from observability.config.ts (loadObservabilityConfig()).
const CFG = {
  throttleMs: 250,
  bandPctOfMid: 0.0001,
  minPersistenceMs: 3_000,
  pullShrinkPct: 0.7,
  pullProximityPct: 0.001,
  maxTrackedPerSymbol: 50,
  evictAfterMs: 30_000,
};
const TIER_MULTIPLIER = {
  btc: 5,
  eth: 5,
  largeAlt: 2.5,
  midAlt: 3,
  smallAlt: 3,
};
function tierFor(symbol) {
  if (symbol === "BTCUSDT") return "btc";
  if (symbol === "ETHUSDT") return "eth";
  return "largeAlt"; // reasonable default for this diagnostic
}
const MULTIPLIER = TIER_MULTIPLIER[tierFor(SYMBOL)];

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function aggregateIntoBands(levels, bandSize) {
  const out = new Map();
  for (const [priceStr, qtyStr] of levels) {
    const price = Number(priceStr),
      qty = Number(qtyStr);
    const notional = price * qty;
    if (notional <= 0) continue;
    const key = Math.round(price / bandSize);
    const cur = out.get(key);
    if (cur) cur.sum += notional;
    else out.set(key, { sum: notional, bestPrice: price });
  }
  return out;
}

// Tracked wall state, mirroring TrackedWall in wall-tracker.service.ts.
const bidWalls = new Map();
const askWalls = new Map();
let lastProcessedMs = 0;
let lastMid = 0;

// Diagnostic counters.
let candidatesCreated = 0;
let reachedPersistence = 0;
let pulledBeforePersistence = 0;
let pulledAfterPersistence = 0;
const timeToPullMsForPrePersistencePulls = [];

function isoUtc(ms) {
  return new Date(ms).toISOString();
}
function fmtUsd(n) {
  return `$${(n / 1000).toFixed(1)}K`;
}

function updateSide(tracked, side, bands, minWallNotional, bandSize, mid, now) {
  const present = new Map();
  for (const [key, val] of bands)
    if (val.sum >= minWallNotional) present.set(key, val);

  for (const [key, val] of present) {
    const existing = tracked.get(key);
    if (existing) {
      existing.lastSeenAt = now;
      existing.currentNotional = val.sum;
      if (val.sum > existing.peakNotional) existing.peakNotional = val.sum;
    } else {
      tracked.set(key, {
        side,
        bandKey: key,
        representativePrice: val.bestPrice,
        firstSeenAt: now,
        lastSeenAt: now,
        peakNotional: val.sum,
        currentNotional: val.sum,
        pulledAt: null,
        everBecamePersistent: false,
        loggedPersistence: false,
      });
      candidatesCreated++;
      console.log(
        `[${isoUtc(now)}] NEW CANDIDATE ${side} @ ${val.bestPrice.toFixed(2)}  notional=${fmtUsd(val.sum)}  (threshold was ${fmtUsd(minWallNotional)})`,
      );
    }
  }

  for (const w of tracked.values()) {
    // Check persistence transition (mirrors isPersistent computation).
    const ageMs = now - w.firstSeenAt;
    const isPersistentNow =
      ageMs >= CFG.minPersistenceMs &&
      w.pulledAt === null &&
      w.currentNotional > 0;
    if (isPersistentNow && !w.loggedPersistence) {
      w.loggedPersistence = true;
      w.everBecamePersistent = true;
      reachedPersistence++;
      console.log(
        `[${isoUtc(now)}] BECAME PERSISTENT ${w.side} @ ${w.representativePrice.toFixed(2)}  ageMs=${ageMs}  (this WOULD populate nearestBidWall*/nearestAskWall* now)`,
      );
    }

    if (present.has(w.bandKey)) continue;
    const stillThere = bands.get(w.bandKey);
    const currentNow = stillThere?.sum ?? 0;
    const peakOrTiny = w.peakNotional > 0 ? w.peakNotional : 1;
    const shrinkPct = (peakOrTiny - currentNow) / peakOrTiny;
    const distToMid = Math.abs(w.representativePrice - mid) / mid;
    const wasApproached = distToMid <= CFG.pullProximityPct;
    if (
      w.pulledAt === null &&
      (shrinkPct >= CFG.pullShrinkPct || (wasApproached && currentNow === 0))
    ) {
      w.pulledAt = now;
      const ageAtPullMs = now - w.firstSeenAt;
      const reason =
        shrinkPct >= CFG.pullShrinkPct
          ? `shrunk ${(shrinkPct * 100).toFixed(0)}% vs peak`
          : "approached mid then vanished";
      if (ageAtPullMs < CFG.minPersistenceMs) {
        pulledBeforePersistence++;
        timeToPullMsForPrePersistencePulls.push(ageAtPullMs);
        console.log(
          `[${isoUtc(now)}] PULLED (PRE-PERSISTENCE) ${w.side} @ ${w.representativePrice.toFixed(2)}  ageAtPullMs=${ageAtPullMs} (< ${CFG.minPersistenceMs} threshold)  reason=${reason}  ==> this wall NEVER populated nearestBidWall*/nearestAskWall*, but DID count toward wallsPulled1m`,
        );
      } else {
        pulledAfterPersistence++;
        console.log(
          `[${isoUtc(now)}] PULLED (post-persistence) ${w.side} @ ${w.representativePrice.toFixed(2)}  ageAtPullMs=${ageAtPullMs}  reason=${reason}`,
        );
      }
    }
    w.currentNotional = currentNow;
  }

  const staleCutoff = now - CFG.evictAfterMs;
  for (const [key, w] of tracked)
    if (w.lastSeenAt < staleCutoff) tracked.delete(key);
}

function ingest(bids, asks, timestamp) {
  if (bids.length === 0 || asks.length === 0) return;
  const now = timestamp;
  if (now - lastProcessedMs < CFG.throttleMs) return;
  lastProcessedMs = now;

  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  const mid = (bestBid + bestAsk) / 2;
  if (!(mid > 0)) return;
  lastMid = mid;

  const bandSize = mid * CFG.bandPctOfMid;
  if (!(bandSize > 0)) return;

  const bidNotionals = bids.map(([p, q]) => Number(p) * Number(q));
  const askNotionals = asks.map(([p, q]) => Number(p) * Number(q));
  const minBidWall = median(bidNotionals) * MULTIPLIER;
  const minAskWall = median(askNotionals) * MULTIPLIER;

  const bidBands = aggregateIntoBands(bids, bandSize);
  const askBands = aggregateIntoBands(asks, bandSize);

  updateSide(bidWalls, "BID", bidBands, minBidWall, bandSize, mid, now);
  updateSide(askWalls, "ASK", askBands, minAskWall, bandSize, mid, now);
}

console.log("=".repeat(110));
console.log(
  `LIVE WALL DIAGNOSTIC -- ${SYMBOL}, running for ${RUN_SECONDS}s, replicating production wall-tracker.service.ts logic exactly`,
);
console.log(
  `Config: throttleMs=${CFG.throttleMs} bandPctOfMid=${CFG.bandPctOfMid} minPersistenceMs=${CFG.minPersistenceMs} pullShrinkPct=${CFG.pullShrinkPct} multiplier=${MULTIPLIER} (tier=${tierFor(SYMBOL)})`,
);
console.log("=".repeat(110));

const wsUrl = `wss://fstream.binance.com/ws/${SYMBOL.toLowerCase()}@depth20@100ms`;
const ws = new WebSocket(wsUrl); // NODE<22 FALLBACK: const { WebSocket } = require("ws"); const ws = new WebSocket(wsUrl);

ws.addEventListener("open", () => console.log(`\nConnected to ${wsUrl}\n`));
ws.addEventListener("error", (e) => console.error("WS ERROR:", e.message ?? e));
ws.addEventListener("message", (event) => {
  try {
    const msg = JSON.parse(event.data.toString());
    if (!msg.b || !msg.a) return;
    ingest(msg.b, msg.a, Date.now());
  } catch (err) {
    console.error("parse error:", err.message);
  }
});

setTimeout(() => {
  ws.close();
  console.log(`\n${"=".repeat(110)}`);
  console.log("SUMMARY");
  console.log("=".repeat(110));
  console.log(`Candidate walls created: ${candidatesCreated}`);
  console.log(
    `Reached persistence (would populate nearestBidWall*/nearestAskWall*): ${reachedPersistence}`,
  );
  console.log(
    `Pulled BEFORE reaching persistence (never populated, but counted in wallsPulled1m): ${pulledBeforePersistence}`,
  );
  console.log(`Pulled AFTER persistence: ${pulledAfterPersistence}`);
  if (timeToPullMsForPrePersistencePulls.length > 0) {
    const avg =
      timeToPullMsForPrePersistencePulls.reduce((a, b) => a + b, 0) /
      timeToPullMsForPrePersistencePulls.length;
    console.log(
      `Avg time-to-pull for pre-persistence pulls: ${avg.toFixed(0)}ms (threshold is ${CFG.minPersistenceMs}ms)`,
    );
  }
  const totalPulled = pulledBeforePersistence + pulledAfterPersistence;
  if (totalPulled > 0) {
    console.log(
      `\n${((pulledBeforePersistence / totalPulled) * 100).toFixed(1)}% of all pulled walls were pulled BEFORE ever reaching persistence.`,
    );
  }
  console.log(
    "\nThis never touches live strategy, trading logic, or the production bot process.",
  );
  process.exit(0);
}, RUN_SECONDS * 1000);
