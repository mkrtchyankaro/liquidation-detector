import { fmtPrice, fmtQty, fmtUsd } from "../v9/v9-telegram";
import { estimateFeesUsd } from "../v9/v9-fees";
import type { V10SignalDoc, V10TradeDoc } from "./v10-repository";

/**
 * V10 messages (plain text). Header "V10 · BTC" on every message so it is never mixed up with V9.
 * 🔻 SHORT entry · 🔺 LONG entry · ✅ TP · ❌ SL · ⚪ other close · ⚠️ not opened. $ figures use THIS user's trade.
 * The story is told in 15m candles, UTC.
 */
const SEP = "------------------------------";
const utc = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const hm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const dhm = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const coin = (s: string): string => s.replace(/USDT$/, "");
const W = 15 * 60_000;

export function v10Story(
  sig: Pick<V10SignalDoc, "btc" | "rankWindowHours">,
  t: Pick<V10TradeDoc, "symbol" | "side" | "pick">,
  picks: number,
): string[] {
  const b = sig.btc,
    top = t.side === "SHORT";
  return [
    `📖 Ինչու (15m մոմեր, UTC)`,
    ``,
    `1️⃣ BTC-ն ${top ? "բարձրացավ" : "իջավ"} · ${dhm(b.moveStartT)} → ${hm(b.extremeT + W)}`,
    `Գինը ${sp(b.movePct)} · OI ${sp(b.moveOiPct)} · OI-ով ամենամեծը վերջին ${sig.rankWindowHours} ժամի ${b.prior} շարժումից`,
    ``,
    `2️⃣ ${top ? "Գագաթ" : "Հատակ"} · ${hm(b.candleEnd - W)}–${hm(b.candleEnd)} մոմը`,
    `${b.label} · OI ${sp(b.candleOiPct)} · BTC ${fmtPrice(b.price)}`,
    ``,
    `3️⃣ ${coin(t.symbol)}-ն ${top ? "բարձրացավ" : "իջավ"} BTC-ի հետ`,
    `${sp(t.pick.coinPct)} (BTC-ից x${t.pick.x.toFixed(2)} անգամ) · R² ${t.pick.follow.toFixed(2)} · ընտրված #${t.pick.rank} / ${picks}`,
  ];
}

export function formatV10Entry(sig: V10SignalDoc, t: V10TradeDoc): string {
  const long = t.side === "LONG",
    risk = t.actualRiskUsd ?? t.plannedRiskUsd;
  const entry = t.entryPrice!,
    sl = t.slPrice!,
    tp = t.tpPrice;
  const notional = t.quantity !== null ? entry * t.quantity : NaN;
  const fees = estimateFeesUsd(notional);
  const pctOf = (p: number): string => sp((100 * (p - entry)) / entry);
  const rr = tp !== null ? Math.abs(tp - entry) / Math.abs(entry - sl) : NaN;
  return [
    `${long ? "🔺" : "🔻"} V10 · BTC · ${t.symbol} · ${long ? "LONG (BUY)" : "SHORT (SELL)"} · ${t.mode}`,
    SEP,
    `📍 ENTRY · ${utc(t.createdAt)}`,
    `🆔 ${t.orderSignalId}`,
    ``,
    `Entry     ${fmtPrice(entry)}`,
    `TP        ${tp !== null ? `${fmtPrice(tp)}  (${pctOf(tp)})  ${fmtUsd(risk * rr)}` : `n/a${t.binance?.tpFailureReason ? ` -- ${t.binance.tpFailureReason}` : ""}`}`,
    `SL        ${fmtPrice(sl)}  (${pctOf(sl)})  ${fmtUsd(-risk)}`,
    ``,
    `Risk      ${fmtUsd(risk, false)}  ·  RR ${Number.isFinite(rr) ? rr.toFixed(2) : "n/a"}`,
    `Position  ${fmtQty(t.quantity)} ${coin(t.symbol)} (${fmtUsd(notional, false)})`,
    `Fees ≈    ${fmtUsd(fees.tp, false)} at TP · ${fmtUsd(fees.sl, false)} at SL`,
    ``,
    ...v10Story(sig, t, sig.picks.length),
  ].join("\n");
}

const REASON: Record<string, string> = {
  TP_FILLED: "✅ TAKE PROFIT",
  SL_FILLED: "❌ STOP LOSS",
  POSITION_CLOSED_EXTERNALLY: "⚪ CLOSED OUTSIDE THE BOT",
  CLOSED_NO_FILLS_FOUND: "⚪ CLOSED (no fills found)",
  FAILSAFE_CLOSED: "⚪ FAIL-SAFE CLOSE (no SL found)",
};

export function formatV10Close(t: V10TradeDoc): string {
  const held =
    t.closedAt !== null
      ? Math.max(0, Math.round((t.closedAt - t.createdAt) / 60_000))
      : null;
  return [
    `${REASON[t.closeReason ?? ""] ?? "⚪ CLOSED"} · V10 · BTC · ${t.symbol} · ${t.side} · ${t.mode}`,
    SEP,
    `🆔 ${t.orderSignalId}`,
    `Entry     ${fmtPrice(t.entryPrice)}`,
    `Exit      ${fmtPrice(t.exitPrice)}`,
    `Net PnL   ${fmtUsd(t.pnlUsd)}${t.pnlR !== null ? `  (${t.pnlR >= 0 ? "+" : ""}${t.pnlR.toFixed(2)}R, fees included)` : ""}`,
    `Held      ${held ?? "?"} min`,
  ].join("\n");
}

export function formatV10Failure(
  t: Pick<
    V10TradeDoc,
    "symbol" | "side" | "mode" | "orderSignalId" | "failureReason" | "state"
  >,
): string {
  return [
    `⚠️ V10 · BTC · ${t.symbol} · ${t.side} · ${t.mode} · ${t.state === "SKIPPED" ? "NOT OPENED (skipped)" : "NOT OPENED"}`,
    SEP,
    `🆔 ${t.orderSignalId}`,
    `Reason: ${t.failureReason ?? "unknown"}`,
  ].join("\n");
}
