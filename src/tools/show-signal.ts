/**
 * Sep 8 2026 (Karo). READ-ONLY inspection utility, adapted (not a
 * straight copy) from liqwatch-bot's own src/tools/show-v5-signal.ts
 * -- the underlying data model changed (one global v5_global_signals
 * doc + one v5_signals_<userId> doc PER user, instead of one combined
 * v5_signals doc), so this reads/joins across both collection types.
 *
 * Usage:
 *   npx tsx src/tools/show-signal.ts <signalId>
 *   npx tsx src/tools/show-signal.ts <signalId> --user karo
 *   npx tsx src/tools/show-signal.ts <signalId> --json
 *   npx tsx src/tools/show-signal.ts --list [SYMBOL] [--open] [--json]
 *   npx tsx src/tools/show-signal.ts --latest [SYMBOL]
 *
 * --open (with --list): shows only global signals that currently have
 * AT LEAST ONE user with status=OPEN (a real, live position right
 * now) -- checked across every user listed in users.config.json.
 */
import * as path from "path";
import "dotenv/config";
import {
  MongoClientWrapper,
  type MongoDetectorConfig,
} from "../infrastructure/mongo/mongo.client";
import { loadUsersConfig } from "../infrastructure/config/users.config.loader";
import type { GlobalSignalDoc } from "../domain/signal/global-signal.model";
import type { UserSignalDoc } from "../domain/signal/user-signal.model";

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtTs(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  return new Date(n).toISOString().replace("T", " ").slice(0, 23) + "Z";
}

function buildMongo(): MongoClientWrapper {
  const cfg: MongoDetectorConfig = {
    enabled: (process.env.MONGO_URI ?? "").length > 0,
    uri: process.env.MONGO_URI ?? "",
    sharedMarketDataDb: process.env.MONGO_SHARED_DB ?? "liqwatch_bot",
    ownDb: process.env.MONGO_OWN_DB ?? "liquidation_detector",
  };
  return new MongoClientWrapper(cfg);
}

function fmtDur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "n/a";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}min`;
  return `${(m / 60).toFixed(2)}h`;
}

function num(n: number | null | undefined, digits = 6): string {
  if (n === null || n === undefined) return "n/a";
  return n.toFixed(digits);
}

function printWave(
  w: GlobalSignalDoc["waveHistory"][number],
  entryWaveNumber: number,
): void {
  const isEntryWave = w.waveNumber === entryWaveNumber;
  console.log(
    `W${w.waveNumber} (${w.state})${isEntryWave ? "  <-- ENTRY WAVE" : ""}`,
  );
  console.log(
    `  Anchor:            ${num(w.anchorPrice)} @ ${fmtTs(w.anchorTs)}`,
  );
  console.log(
    `  Extreme:           ${num(w.extremePrice)} @ ${fmtTs(w.extremeTs)}`,
  );
  console.log(
    `  Reclaim:           ${w.reclaimPrice !== null ? num(w.reclaimPrice) + " @ " + fmtTs(w.reclaimTs) : "n/a (SUPERSEDED, never reclaimed)"}`,
  );
  console.log(
    `  Liquidation:       ${fmtUsd(w.liqNotionalUsd)}  (${w.liqEvents} events, max single ${fmtUsd(w.maxSingleEventUsd)})`,
  );
  console.log(`  Max Recovery:      ${num(w.maxRecoveryPrice)}`);
  console.log(
    `  Recovery %:        ${w.recoveryPct !== null ? w.recoveryPct.toFixed(1) + "%" : "n/a (anchor===extreme, undefined)"}`,
  );
  console.log(
    `  Extreme Dist ATR:  ${w.extremeDistanceAtr.toFixed(4)}  (meaningful=${w.isMeaningful})`,
  );
  console.log(
    `  Price Efficiency:  ${w.priceEfficiency !== null ? w.priceEfficiency.toExponential(3) + " ATR/$" : "n/a (layer never completed)"}`,
  );
  console.log(
    `  vs Dominant:       liq=${w.liquidationRatioVsDominant !== null ? w.liquidationRatioVsDominant.toFixed(3) + "x" : "n/a (first-ever layer)"}  efficiency=${w.priceEfficiencyRatioVsDominant !== null ? w.priceEfficiencyRatioVsDominant.toFixed(3) + "x" : "n/a"}`,
  );
  console.log(
    `  Selected Trigger:  ${w.selectedRecoveryPct !== null ? w.selectedRecoveryPct + "%" : "n/a (Wave1, never became meaningful)"}  target=${w.recoveryTargetPrice ?? "n/a"}`,
  );
  console.log(
    `  Recovery 50% at:   ${w.recovery50AtTs !== null ? fmtTs(w.recovery50AtTs) + " (price=" + w.recovery50AtPrice + ")" : "never reached"}`,
  );
  console.log(
    `  Recovery 75% at:   ${w.recovery75AtTs !== null ? fmtTs(w.recovery75AtTs) + " (price=" + w.recovery75AtPrice + ")" : "never reached"}`,
  );
  console.log(
    `  Taker Buy/Sell:    ${fmtUsd(w.takerBuyUsd)} / ${fmtUsd(w.takerSellUsd)}  (imbalance=${num(w.takerImbalance, 3)})`,
  );
  console.log(
    `  OI Start/End:      ${w.oiStart ?? "n/a"} / ${w.oiEnd ?? "n/a"}  (Δ=${w.oiDeltaPct !== null ? w.oiDeltaPct.toFixed(3) + "%" : "n/a"})`,
  );
  console.log("");
}

export function printGlobalReport(doc: GlobalSignalDoc): void {
  console.log("=".repeat(50));
  console.log("GLOBAL V5 SIGNAL (v5_global_signals)");
  console.log("=".repeat(50));
  console.log(`Signal ID:    ${doc.signalId}`);
  console.log(`Symbol:       ${doc.symbol}`);
  console.log(`Side:         ${doc.side}`);
  console.log(`Signal Time:  ${fmtTs(doc.signalTs)}`);
  console.log(`Entry:        ${doc.entry ?? "n/a (rejected before geometry)"}`);
  console.log(
    `Entry Wave:   ${doc.entryWaveNumber || "n/a"} of ${doc.waveHistory.length}`,
  );
  console.log(`TP:           ${doc.tp ?? "n/a"}`);
  console.log(`SL:           ${doc.sl ?? "n/a"}`);
  console.log(`RR:           ${doc.rr ?? "n/a"}`);
  console.log(
    `Status:       ${doc.status}  (strategy-level only -- see per-user status below/with --user)`,
  );
  if (doc.rejectionReason) console.log(`Rejected:     ${doc.rejectionReason}`);
  console.log("");
  console.log("Qualification:");
  console.log(
    `  Qualifying event: ${fmtUsd(doc.qualifyingEventUsd)} @ ${fmtTs(doc.qualifyingEventTs)}`,
  );
  console.log(`  P95 at qualification: ${fmtUsd(doc.p95AtQualification)}`);
  console.log(`  Total episode liquidity: ${fmtUsd(doc.totalEpisodePressure)}`);
  console.log("");
  console.log("Liquidation Layers:");
  console.log(
    `  Dominant layer:    ${doc.dominantLayerLiqUsd !== null ? fmtUsd(doc.dominantLayerLiqUsd) + " (Wave " + doc.dominantLayerWaveNumber + ")" : "n/a"}`,
  );
  console.log(
    `  Exhaustion layer:  ${doc.exhaustionLayerLiqUsd !== null ? fmtUsd(doc.exhaustionLayerLiqUsd) + " (Wave " + doc.exhaustionLayerWaveNumber + ")" : "n/a"}`,
  );
  console.log("");
  console.log("BTC Context:");
  console.log(`  Safety:               ${doc.btcSafetyStatus}`);
  console.log(
    `  Intended side at signal: ${doc.btcIntendedSideAtSignalTime ?? "n/a (no active BTC setup)"}`,
  );
  console.log(
    `  Price at signal:      ${doc.btcContext?.priceAtSignal ?? "n/a"}`,
  );
  console.log(`  OI at signal:         ${doc.btcContext?.oiAtSignal ?? "n/a"}`);
  console.log("");
  console.log("24h Liquidation Context:");
  if (doc.liq24hContext) {
    console.log(`  Day total:  ${fmtUsd(doc.liq24hContext.dayLiqTotalUsd)}`);
    console.log(`  Day events: ${doc.liq24hContext.dayLiqEvents}`);
  } else {
    console.log("  n/a");
  }
  console.log("");
  console.log("Wall Context (at entry):");
  if (doc.wallContext) {
    console.log(
      `  Top bid: ${fmtUsd(doc.wallContext.topBidNotional)} @ ${doc.wallContext.topBidPrice}`,
    );
    console.log(
      `  Top ask: ${fmtUsd(doc.wallContext.topAskNotional)} @ ${doc.wallContext.topAskPrice}`,
    );
    console.log(`  Imbalance: ${doc.wallContext.imbalance.toFixed(3)}`);
  } else {
    console.log("  n/a");
  }
  console.log("");
  console.log("Wave1 Diagnostics (measurement only, never gates entry):");
  if (doc.w1Diagnostics) {
    const d = doc.w1Diagnostics;
    console.log(
      `  Concluded:              ${d.concludedReason} @ ${fmtTs(d.concludedTs)}`,
    );
    console.log(
      `  Qualifying/P95 ratio:   ${d.qualifyingEventToP95Ratio.toFixed(2)}x`,
    );
    console.log(
      `  Anchor->Extreme:        ${fmtDur(d.anchorToExtremeMs)} (${d.anchorToExtremeMs}ms)`,
    );
    console.log(`  Extreme Distance ATR:   ${d.extremeDistanceAtr.toFixed(4)}`);
    console.log(
      `  Speed ATR/min:          ${d.speedAtrPerMinute !== null ? d.speedAtrPerMinute.toFixed(4) : "n/a (instantaneous extreme)"}`,
    );
    console.log(
      `  W1 total liq / events:  ${fmtUsd(d.w1TotalLiqUsd)} / ${d.w1LiqEvents}`,
    );
    console.log(
      `  Continuation liq:       ${fmtUsd(d.continuationLiqUsd)}  (ratio=${d.continuationRatio.toFixed(3)})`,
    );
    console.log(
      `  Price impact per $1M:   ${d.priceImpactPer1M !== null ? d.priceImpactPer1M.toFixed(4) + "%" : "n/a"}`,
    );
    console.log(
      `  Taker Buy/Sell:         ${fmtUsd(d.takerBuyUsd)} / ${fmtUsd(d.takerSellUsd)}  (imbalance=${num(d.takerImbalance, 3)})`,
    );
    console.log(
      `  OI Start/End/Δ:         ${d.oiStart ?? "n/a"} / ${d.oiEnd ?? "n/a"} / ${d.oiDeltaPct !== null ? d.oiDeltaPct.toFixed(3) + "%" : "n/a"}`,
    );
    console.log(
      `  Extreme->Recovery:      ${fmtDur(d.extremeToRecoveryMs)} (${d.extremeToRecoveryMs}ms)`,
    );
    console.log(
      `  Recovery % at entry:    ${d.recoveryPctAtEntry !== null ? d.recoveryPctAtEntry.toFixed(1) + "%" : "n/a"}`,
    );
  } else {
    console.log(
      "  n/a (W1 never concluded, or episode ended before Wave1 finished)",
    );
  }
  console.log("");
  console.log("=".repeat(50));
  console.log(
    `WAVE CHAIN (${doc.waveHistory.length} wave${doc.waveHistory.length === 1 ? "" : "s"})`,
  );
  console.log("=".repeat(50));
  doc.waveHistory.forEach((w) => printWave(w, doc.entryWaveNumber));
  console.log("=".repeat(50));
}

function printUserReport(userId: string, doc: UserSignalDoc | null): void {
  console.log("");
  console.log("-".repeat(50));
  console.log(`USER: ${userId}  (v5_signals_${userId})`);
  console.log("-".repeat(50));
  if (!doc) {
    console.log("  No document -- this user was never fanned out this signal.");
    return;
  }
  console.log(`  Status:        ${doc.status}`);
  console.log(
    `  Telegram sent: ${doc.telegramSent} ${doc.telegramSentAt ? "@ " + fmtTs(doc.telegramSentAt) : ""}`,
  );
  console.log(
    `  Execution:     enabled=${doc.executionEnabled} isLive=${doc.isLive}`,
  );
  if (doc.isLive || doc.status.startsWith("CLOSED")) {
    console.log(`  Entry/SL/TP:   ${doc.entry} / ${doc.sl} / ${doc.tp}`);
    console.log(
      `  Position:      qty=${doc.positionQty} notional=${fmtUsd(doc.notional)} riskUsd=${doc.riskUsd}`,
    );
    console.log(
      `  Order IDs:     SL=${doc.binanceSlOrderId} TP=${doc.binanceTpOrderId}`,
    );
  }
  if (doc.closedAt !== null) {
    console.log(
      `  Closed:        ${doc.closeReason} @ ${fmtTs(doc.closedAt)}  price=${doc.closePrice}`,
    );
    console.log(
      `  MFE:           ${doc.maxFavorableR !== null ? doc.maxFavorableR.toFixed(2) + "R" : "n/a"}`,
    );
    console.log(
      `  MAE:           ${doc.maxAdverseR !== null ? doc.maxAdverseR.toFixed(2) + "R" : "n/a"}`,
    );
  }
}

function printListTable(docs: GlobalSignalDoc[]): void {
  console.log(`GLOBAL SIGNALS - ${docs.length} total`);
  console.log(
    `#   DATE/TIME            SYMBOL      SIDE     STATUS         WAVE    SIGNAL ID`,
  );
  docs.forEach((d, i) => {
    const dt = new Date(d.signalTs)
      .toISOString()
      .replace("T", " ")
      .slice(0, 16);
    const idx = String(i + 1).padEnd(3);
    const date = dt.padEnd(20);
    const symbol = d.symbol.padEnd(11);
    const side = d.side.padEnd(8);
    const status = d.status.padEnd(14);
    const wave = `${d.entryWaveNumber || "-"}/${d.waveHistory.length}`.padEnd(
      7,
    );
    console.log(
      `${idx} ${date} ${symbol} ${side} ${status} ${wave} ${d.signalId}`,
    );
  });
}

async function anyUserHasOpenPosition(
  mongo: MongoClientWrapper,
  signalId: string,
  userIds: string[],
): Promise<boolean> {
  for (const userId of userIds) {
    const col = await mongo.userSignals(userId);
    if (!col) continue;
    const doc = await col.findOne({ signalId, status: "OPEN" });
    if (doc) return true;
  }
  return false;
}

async function findSignals(
  globalCol: Awaited<ReturnType<MongoClientWrapper["globalSignals"]>>,
  filtered: string[],
): Promise<GlobalSignalDoc[] | null> {
  const getFlag = (name: string): string | null => {
    const idx = filtered.indexOf(name);
    return idx !== -1 && filtered[idx + 1] !== undefined
      ? filtered[idx + 1]
      : null;
  };
  const symbolArg = getFlag("--symbol");
  const sideArg = getFlag("--side");
  const aroundArg = getFlag("--around");
  const windowMinutesArg = getFlag("--window-minutes");

  const query: Record<string, unknown> = {};
  if (symbolArg) query.symbol = symbolArg.toUpperCase();
  if (sideArg) query.side = sideArg.toUpperCase();

  let centerTs: number | null = null;
  if (aroundArg) {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(
      aroundArg,
    )
      ? aroundArg.replace(" ", "T") + "Z"
      : aroundArg;
    const parsed = new Date(normalized);
    if (isNaN(parsed.getTime())) {
      console.error(
        `Could not parse --around value "${aroundArg}". Expected e.g. "2026-09-07 15:40".`,
      );
      process.exit(1);
    }
    centerTs = parsed.getTime();
    const windowMinutes = windowMinutesArg ? Number(windowMinutesArg) : 30;
    if (!(windowMinutes > 0)) {
      console.error(`Invalid --window-minutes value "${windowMinutesArg}".`);
      process.exit(1);
    }
    const windowMs = windowMinutes * 60_000;
    query.signalTs = { $gte: centerTs - windowMs, $lte: centerTs + windowMs };
  }

  if (!globalCol) return null;
  let results = (await globalCol
    .find(query)
    .toArray()) as unknown as GlobalSignalDoc[];
  results =
    centerTs !== null
      ? results.sort(
          (a, b) =>
            Math.abs(a.signalTs - centerTs!) - Math.abs(b.signalTs - centerTs!),
        )
      : results.sort((a, b) => b.signalTs - a.signalTs);
  return results;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const filtered = args.filter((a) => a !== "--json");

  const mongo = buildMongo();
  const globalCol = await mongo.globalSignals();
  if (!globalCol) {
    console.error(
      !((process.env.MONGO_URI ?? "").length > 0)
        ? "MONGO_URI not set in .env -- .env wasn't found or is missing MONGO_URI, NOT that zero signals exist."
        : "Mongo is configured but the connection FAILED (network/auth/URI) -- check MONGO_URI and connectivity.",
    );
    process.exit(1);
  }

  let userIds: string[] = [];
  try {
    const usersConfigPath =
      process.env.USERS_CONFIG_PATH ??
      path.join(process.cwd(), "users.config.json");
    userIds = loadUsersConfig(usersConfigPath).map((u) => u.userId);
  } catch {
    // users.config.json missing/invalid -- --open/--user checks simply
    // find nothing, rather than crashing this read-only tool.
  }

  if (filtered[0] === "--find") {
    const results = await findSignals(globalCol, filtered);
    if (results === null) {
      console.log("No matching signals.");
      await mongo.close();
      return;
    }
    if (jsonMode) {
      console.log(JSON.stringify(results, null, 2));
    } else if (results.length === 0) {
      console.log("No matching signals.");
    } else {
      printListTable(results);
    }
    await mongo.close();
    return;
  }

  if (filtered[0] === "--list") {
    const rest = filtered.slice(1);
    const openOnly = rest.includes("--open");
    const symbolArg = rest.find((a) => a !== "--open");
    const query: Record<string, unknown> = {};
    if (symbolArg) query.symbol = symbolArg.toUpperCase();

    let results = (await globalCol
      .find(query)
      .sort({ signalTs: -1 })
      .toArray()) as unknown as GlobalSignalDoc[];

    if (openOnly) {
      const flags = await Promise.all(
        results.map((d) => anyUserHasOpenPosition(mongo, d.signalId, userIds)),
      );
      results = results.filter((_, i) => flags[i]);
    }

    if (jsonMode) {
      console.log(JSON.stringify(results, null, 2));
    } else if (results.length === 0) {
      console.log("No matching signals.");
    } else {
      printListTable(results);
    }
    await mongo.close();
    return;
  }

  if (filtered[0] === "--latest") {
    const symbol = filtered[1];
    const query = symbol ? { symbol: symbol.toUpperCase() } : {};
    const doc = (await globalCol
      .find(query)
      .sort({ signalTs: -1 })
      .limit(1)
      .next()) as GlobalSignalDoc | null;
    if (!doc) {
      console.log("No matching signal.");
      await mongo.close();
      return;
    }
    if (jsonMode) console.log(JSON.stringify(doc, null, 2));
    else printGlobalReport(doc);
    await mongo.close();
    return;
  }

  if (!filtered[0]) {
    console.error(
      "Usage:\n" +
        "  npx tsx src/tools/show-signal.ts <signalId>\n" +
        "  npx tsx src/tools/show-signal.ts <signalId> --user karo\n" +
        "  npx tsx src/tools/show-signal.ts <signalId> --json\n" +
        "  npx tsx src/tools/show-signal.ts --list [SYMBOL] [--open] [--json]\n" +
        '  npx tsx src/tools/show-signal.ts --find --symbol SOLUSDT --side SHORT --around "2026-09-07 15:40" [--window-minutes N]\n' +
        "  npx tsx src/tools/show-signal.ts --latest [SYMBOL]",
    );
    process.exit(1);
  }

  const signalId = filtered[0];
  const doc = (await globalCol.findOne({ signalId })) as GlobalSignalDoc | null;
  if (!doc) {
    console.log("No matching signal found.");
    await mongo.close();
    return;
  }

  const userIdx = filtered.indexOf("--user");
  const requestedUser = userIdx !== -1 ? filtered[userIdx + 1] : null;

  if (jsonMode) {
    const out: Record<string, unknown> = { global: doc };
    if (requestedUser) {
      const col = await mongo.userSignals(requestedUser);
      out[requestedUser] = col ? await col.findOne({ signalId }) : null;
    }
    console.log(JSON.stringify(out, null, 2));
    await mongo.close();
    return;
  }

  printGlobalReport(doc);

  if (requestedUser) {
    const col = await mongo.userSignals(requestedUser);
    const userDoc = col
      ? ((await col.findOne({ signalId })) as UserSignalDoc | null)
      : null;
    printUserReport(requestedUser, userDoc);
  } else if (userIds.length > 0) {
    console.log("");
    console.log(
      `(tip: add --user <userId> to see per-user execution status -- known users: ${userIds.join(", ")})`,
    );
  }

  await mongo.close();
}

main().catch((err) => {
  console.error("show-signal failed:", err);
  process.exit(1);
});
