import { fmtPrice, fmtQty, fmtUsd } from "../v9/v9-telegram";
import type { ZzTradeDoc } from "./zz-paper.service";

/**
 * ZZ PAPER messages (plain text). 🟣 entry · ✅ TP · ❌ SL · 🔸 A/B episode seen, no trade.
 * $ figures use THIS user's riskUsd.
 */
const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const hm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const SEP = "------------------------------";
const coins = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0));
const money = (v: number): string => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);

function story(t: ZzTradeDoc): string[] {
  const coin = t.symbol.replace("USDT", "");
  return [
    `Cleaning ${t.cleaning.victim} [${t.grade}] ${hm(t.cleaning.startTs)} -> ${hm(t.cleaning.endTs)}: closed ${coins(t.cleaning.coins)} ${coin}, price ${t.cleaning.movePct.toFixed(2)}%, liq ${money(t.cleaning.liqUsd)}`,
    `   speed ${t.quality.speed.toFixed(0)}x · forced ${t.quality.forcedPct.toFixed(0)}% · push ${t.quality.pushAtr.toFixed(1)} ATR`,
    `Accumulation ${hm(t.accumulation.startTs)} -> ${hm(t.accumulation.endTs)}: opened ${coins(t.accumulation.coins)} ${coin}`,
    `Expected ${t.expectedPct.toFixed(2)}% · already moved ${t.alreadyMovedPct >= 0 ? "+" : ""}${t.alreadyMovedPct.toFixed(2)}% · remaining ${t.remainingPct.toFixed(2)}%`,
  ];
}

export function formatZzEntry(t: ZzTradeDoc, riskUsd: number): string {
  const slPct = (100 * Math.abs(t.slPrice! - t.entry)) / t.entry;
  const qty = riskUsd / Math.abs(t.entry - t.slPrice!);
  return [
    `🟣 ZZ ${t.symbol} · ${t.side === "LONG" ? "LONG (BUY)" : "SHORT (SELL)"} · PAPER [${t.grade}]`,
    SEP,
    `📍 ENTRY · ${utc(t.decidedTs + 60_000)}`,
    `🆔 ${t.signalId}`,
    "",
    `Entry ${fmtPrice(t.entry)}`,
    `TP ${fmtPrice(t.tpPrice)} (${t.side === "LONG" ? "+" : "-"}${t.remainingPct.toFixed(2)}%) ${fmtUsd(riskUsd * t.rr)}`,
    `SL ${fmtPrice(t.slPrice)} (${t.side === "LONG" ? "-" : "+"}${slPct.toFixed(2)}%) ${fmtUsd(-riskUsd)}`,
    `Risk ${fmtUsd(riskUsd, false)} · RR ${t.rr} · Position ${fmtQty(qty)} ${t.symbol.replace("USDT", "")} (${fmtUsd(qty * t.entry, false)})`,
    "",
    ...story(t),
  ].join("\n");
}

export function formatZzClose(t: ZzTradeDoc, riskUsd: number): string {
  const tp = t.result === "TP";
  return [
    `${tp ? "✅ TAKE PROFIT" : "❌ STOP LOSS"} · ZZ ${t.symbol} · ${t.side} · PAPER [${t.grade}]`,
    SEP,
    `🆔 ${t.signalId}`,
    `Entry ${fmtPrice(t.entry)} -> Exit ${fmtPrice(t.exitPrice)}`,
    `Net ${fmtUsd(riskUsd * (t.netR ?? 0))} (${(t.netR ?? 0) >= 0 ? "+" : ""}${(t.netR ?? 0).toFixed(2)}R, fees included)`,
    `Held ${t.minutes ?? "?"} min`,
  ].join("\n");
}

export function formatZzSkip(t: ZzTradeDoc): string {
  return [`🔸 ZZ ${t.symbol} [${t.grade}] episode, NO TRADE`, `Reason: ${t.skipReason}`, ...story(t)].join("\n");
}
