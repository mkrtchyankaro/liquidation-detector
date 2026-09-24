import type { V9Decision } from "./v9-causal-engine";
import type { V9TradeDoc } from "./v9-repository";

/** Plain text (no HTML/Markdown special characters), one message per event. */
const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const price = (p: number | null): string => (p === null || !Number.isFinite(p) ? "n/a" : p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(5));
const usd = (v: number | null): string => (v === null || !Number.isFinite(v) ? "n/a" : `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`);
const compact = (v: number): string => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);
const pct = (from: number, to: number): string => `${(((to - from) / from) * 100).toFixed(2)}%`;
const SEP = "------------------------------";

export function formatV9Entry(d: V9Decision, t: V9TradeDoc): string {
  const buy = t.side === "LONG";
  const e = d.episode, f = d.features;
  const lines = [
    `${t.mode === "REAL" ? "🔴" : "🟢"} V9 ${d.symbol} · ${buy ? "BUY (LONG)" : "SELL (SHORT)"} · ${t.mode}`,
    SEP,
    `📍 ENTRY · ${utc(t.createdAt)}`,
    `🆔 ${t.signalId}`,
    "",
    `Entry   ${price(t.entryPrice)}`,
    `SL      ${price(t.slPrice)}  (${t.entryPrice ? pct(t.entryPrice, t.slPrice) : "n/a"})  ${usd(t.actualRiskUsd !== null ? -t.actualRiskUsd : -t.plannedRiskUsd)}`,
    `TP      ${price(t.tpPrice)}  (${t.entryPrice && t.tpPrice ? pct(t.entryPrice, t.tpPrice) : "n/a"})  ${usd((t.actualRiskUsd ?? t.plannedRiskUsd) * t.rr)}  [${t.rr}R]`,
    `Qty     ${t.quantity ?? "n/a"}  (${t.entryPrice && t.quantity ? compact(t.entryPrice * t.quantity) : "n/a"})`,
    "",
    `⚡ ${d.episode.victim} liquidations ${compact(e.victim === "LONG" ? e.long : e.short)} vs ${compact(e.victim === "LONG" ? e.short : e.long)}`,
    `Episode ${utc(e.start)} -> confirmed ${utc(e.confirmTs)} (${e.parts} part${e.parts > 1 ? "s" : ""})`,
    `OI drop ${e.oiDropPct.toFixed(2)}% · move ${f.dirMove.toFixed(2)}% · CLR ${f.clr.toFixed(2)} (median ${d.reference.medianClr.toFixed(2)})`,
  ];
  if (t.binance?.tpFailureReason) lines.push("", `⚠️ TP not placed: ${t.binance.tpFailureReason} -- SL is active`);
  return lines.join("\n");
}

export function formatV9Close(t: V9TradeDoc): string {
  const label = t.closeReason === "TP_FILLED" ? "✅ TAKE PROFIT" : t.closeReason === "SL_FILLED" ? "❌ STOP LOSS" : `⚪ ${t.closeReason ?? "CLOSED"}`;
  return [
    `${label} · V9 ${t.symbol} · ${t.side === "LONG" ? "LONG" : "SHORT"} · ${t.mode}`,
    SEP,
    `🆔 ${t.signalId}`,
    `Entry   ${price(t.entryPrice)}`,
    `Exit    ${price(t.exitPrice)}`,
    `PnL     ${usd(t.pnlUsd)}${t.pnlR !== null ? `  (${t.pnlR >= 0 ? "+" : ""}${t.pnlR.toFixed(2)}R)` : ""}${t.feesUsd ? `  fees $${t.feesUsd.toFixed(2)}` : ""}`,
    `Held    ${t.closedAt && t.createdAt ? Math.round((t.closedAt - t.createdAt) / 60_000) : "n/a"} min`,
  ].join("\n");
}

export function formatV9Failure(t: V9TradeDoc): string {
  return [
    `⚠️ V9 ${t.symbol} · ${t.side === "LONG" ? "BUY" : "SELL"} · ${t.mode} -- NOT OPENED`,
    `🆔 ${t.signalId}`,
    `Reason: ${t.failureReason ?? "unknown"}`,
  ].join("\n");
}
