import type { V9Decision } from "./v9-causal-engine";
import type { V9TradeDoc } from "./v9-repository";
import { estimateFeesUsd } from "./v9-fees";

/**
 * V9 Telegram messages (plain text, no HTML/Markdown characters).
 * Every number comes from THIS user's own trade (their risk, their fill),
 * so changing riskUsd changes every $ figure in their messages.
 * Colours: 🔵 entry · ✅ take profit · ❌ stop loss · ⚪ other close · ⚠️ not opened.
 */
export function fmtPrice(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "n/a";
  const a = Math.abs(p);
  const decimals = a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
  return p.toFixed(decimals);
}
export function fmtQty(q: number | null): string {
  if (q === null || !Number.isFinite(q)) return "n/a";
  const a = Math.abs(q);
  const decimals = a >= 1000 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 5;
  return Number(q.toFixed(decimals)).toString();
}
export function fmtUsd(v: number | null, signed = true): string {
  if (v === null || !Number.isFinite(v)) return "n/a";
  const s = `$${Math.abs(v).toFixed(2)}`;
  return signed ? `${v >= 0 ? "+" : "-"}${s}` : s;
}
const compact = (v: number): string => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);
const pct = (from: number, to: number): string => `${(to - from) / from >= 0 ? "+" : ""}${(((to - from) / from) * 100).toFixed(2)}%`;
const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const r = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
const SEP = "------------------------------";

export function formatV9Entry(d: V9Decision, t: V9TradeDoc): string {
  const risk = t.actualRiskUsd ?? t.plannedRiskUsd;
  const notional = t.entryPrice !== null && t.quantity !== null ? t.entryPrice * t.quantity : NaN;
  const fees = estimateFeesUsd(notional);
  const e = d.episode, f = d.features;
  const lines = [
    `🔵 V9 ${d.symbol} · ${t.side === "LONG" ? "LONG (BUY)" : "SHORT (SELL)"} · ${t.mode}`,
    SEP,
    `📍 ENTRY · ${utc(t.createdAt)}`,
    `🆔 ${t.signalId}`,
    "",
    `Entry     ${fmtPrice(t.entryPrice)}`,
    `TP        ${fmtPrice(t.tpPrice)}  (${t.entryPrice && t.tpPrice ? pct(t.entryPrice, t.tpPrice) : "n/a"})  ${fmtUsd(risk * t.rr)}`,
    `SL        ${fmtPrice(t.slPrice)}  (${t.entryPrice ? pct(t.entryPrice, t.slPrice) : "n/a"})  ${fmtUsd(-risk)}`,
    "",
    `Risk      ${fmtUsd(risk, false)}  ·  RR ${t.rr}`,
    `Position  ${fmtQty(t.quantity)} ${d.symbol.replace(/USDT$/, "")}  (${Number.isFinite(notional) ? compact(notional) : "n/a"})`,
    `Fees est  TP ${fmtUsd(fees.tp, false)} (${(fees.tp / risk).toFixed(2)}R)  ·  SL ${fmtUsd(fees.sl, false)} (${(fees.sl / risk).toFixed(2)}R)`,
    "",
    `⚡ ${e.victim} liq ${compact(e.victim === "LONG" ? e.long : e.short)} vs ${compact(e.victim === "LONG" ? e.short : e.long)}`,
    `Episode   ${utc(e.start)} -> ${utc(e.confirmTs)} (${e.parts} part${e.parts > 1 ? "s" : ""})`,
    `OI drop ${e.oiDropPct.toFixed(2)}% · move ${f.dirMove.toFixed(2)}% · CLR ${f.clr.toFixed(2)} (median ${d.reference.medianClr.toFixed(2)})`,
  ];
  if (t.binance?.tpFailureReason) lines.push("", `⚠️ TP not placed: ${t.binance.tpFailureReason} -- SL is active`);
  return lines.join("\n");
}

export function formatV9Close(t: V9TradeDoc): string {
  const label = t.closeReason === "TP_FILLED" ? "✅ TAKE PROFIT" : t.closeReason === "SL_FILLED" ? "❌ STOP LOSS" : t.closeReason === "POSITION_CLOSED_EXTERNALLY" ? "⚪ CLOSED MANUALLY" : `⚪ ${t.closeReason ?? "CLOSED"}`;
  const gross = t.pnlUsd !== null && t.feesUsd !== null ? t.pnlUsd + t.feesUsd : null;
  return [
    `${label} · V9 ${t.symbol} · ${t.side} · ${t.mode}`,
    SEP,
    `🆔 ${t.signalId}`,
    `Entry     ${fmtPrice(t.entryPrice)}`,
    `Exit      ${fmtPrice(t.exitPrice)}`,
    "",
    ...(gross !== null ? [`Gross     ${fmtUsd(gross)}`, `Fees      ${fmtUsd(-(t.feesUsd as number))}`] : []),
    `Net PnL   ${fmtUsd(t.pnlUsd)}${t.pnlR !== null ? `  (${r(t.pnlR)})` : ""}`,
    `Held      ${t.closedAt && t.createdAt ? Math.round((t.closedAt - t.createdAt) / 60_000) : "n/a"} min`,
  ].join("\n");
}

export function formatV9Failure(t: V9TradeDoc): string {
  return [
    `⚠️ V9 ${t.symbol} · ${t.side === "LONG" ? "LONG (BUY)" : "SHORT (SELL)"} · ${t.mode} -- NOT OPENED`,
    `🆔 ${t.signalId}`,
    `Reason: ${t.failureReason ?? "unknown"}`,
  ].join("\n");
}
