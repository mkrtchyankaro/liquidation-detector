import { fmtPrice, fmtQty, fmtUsd } from "../shared/format";
import { estimateFeesUsd } from "../shared/fees";
import type { V11SignalDoc, V11TradeDoc } from "./v11-repository";

/**
 * V11 messages (plain text, the same layout as V10 · WALL). "V11" on every message so it is never mixed up with V10.
 * 🔻 SHORT entry · 🔺 LONG entry · ✅ TP · ❌ SL · ⏱ time-out · ⚪ other close · ⚠️ not opened. $ = THIS user's trade.
 * Every time in UTC with the date (in Armenia it can already be the next day). The story: when the move started, how
 * OI moved, the liquidations of the wick against the coin's own norm, the confirmation candle.
 */
const SEP = "------------------------------";
const coin = (s: string): string => s.replace(/USDT$/, "");
const sp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const arrow = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? "⬆️" : "⬇️"}${Math.abs(v).toFixed(2)}%` : "n/a");
/** "12.10.2026 14:00" */
const dmy = (ms: number): string => { const d = new Date(ms).toISOString(); return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)} ${d.slice(11, 16)}`; };
/** "12.10 14:00" */
const dm = (ms: number): string => { const d = new Date(ms).toISOString(); return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)}`; };
const hm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const H = 3_600_000;
const pct = (a: number, b: number): number => (100 * (b - a)) / a;
const usdShort = (v: number): string => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);

export const V11_HEAD = "V11";

const TYPE: Record<string, { s: string; l: string }> = {
  T1: { s: "T1 squeeze · OI ընկավ (շորթերը փակվեցին)", l: "T1 flush · OI ընկավ (լոնգերը փակվեցին)" },
  T2: { s: "T2 նոր փող · OI աճեց", l: "T2 նոր փող · OI աճեց" },
  FLAT: { s: "OI-ն գրեթե նույնն է", l: "OI-ն գրեթե նույնն է" },
};

/** the short story (Johnny Oct 12): the move's start, OI, the wick's liquidations, the confirmation */
export function v11Story(sig: Pick<V11SignalDoc, "side" | "wick" | "confirm" | "entryT">): string[] {
  const short = sig.side === "SHORT", w = sig.wick, r = w.rally, c = sig.confirm;
  const x = r.normPct > 0 ? Math.abs(r.movePct) / r.normPct : NaN;
  const lx = w.liqNorm > 0 ? w.liqUsd / w.liqNorm : NaN;
  return [
    "📖 Պատմություն (1h, UTC)",
    `1️⃣ ${short ? "Ռալի" : "Անկում"}՝ ${dm(r.startT)} (${fmtPrice(r.startPrice)}) → ${dm(r.t)} · գին ${arrow(r.movePct)}${Number.isFinite(x) ? ` (սովորականի ${x.toFixed(1)}×)` : ""} · OI ${arrow(r.oiPct)} → ${TYPE[r.type]?.[short ? "s" : "l"] ?? r.type} · սկզբից մինչև wick-ի ${short ? "գագաթ" : "հատակ"} ${arrow(pct(r.startPrice, short ? w.h : w.l))}`,
    `2️⃣ Wick՝ ${dm(w.t)}–${hm(w.t + H)} մոմ · նոր ${short ? "գագաթ" : "հատակ"} ${fmtPrice(short ? w.h : w.l)} · ${short ? "շորթ" : "լոնգ"} լիկվիդացիա ${usdShort(w.liqUsd)} (մետաղադրամի p85 ${usdShort(w.liqNorm)}${Number.isFinite(lx) ? `, ${lx.toFixed(1)}×` : ""})${w.meaningful ? " ✅ նշանակալի" : ""} · փակվեց մոմի ${short ? "ներքևի" : "վերևի"} կեսում`,
    `3️⃣ Հաստատում՝ ${dm(c.t)}–${hm(c.t + H)} մոմ (wick-ից ${c.n}-${c.n === 1 ? "ին" : "րդ"}) · OI ${arrow(c.oiPct)} · գին ${arrow(c.pricePct)} · նոր ${short ? "գագաթ" : "հատակ"} չկա → մուտք ${hm(sig.entryT)}`,
  ];
}

export function formatV11Entry(sig: V11SignalDoc, t: V11TradeDoc): string {
  const long = t.side === "LONG", risk = t.actualRiskUsd ?? t.plannedRiskUsd;
  const entry = t.entryPrice!, sl = t.slPrice!, tp = t.tpPrice;
  const notional = t.quantity !== null ? entry * t.quantity : NaN;
  const fees = estimateFeesUsd(notional);
  const pctOf = (p: number): string => sp((100 * (p - entry)) / entry);
  const rr = tp !== null ? Math.abs(tp - entry) / Math.abs(entry - sl) : NaN;
  const out: string[] = [
    `${long ? "🔺" : "🔻"} ${coin(t.symbol)} · ${t.side} · ${t.mode} · ${V11_HEAD}`,
    `📅 ${dmy(t.createdAt)} UTC`,
    `Entry ${fmtPrice(entry)}`,
    `TP    ${tp !== null ? `${fmtPrice(tp)} (${pctOf(tp)}) ${fmtUsd(risk * rr)}` : `n/a${t.binance?.tpFailureReason ? ` -- ${t.binance.tpFailureReason}` : ""}`}`,
    `SL    ${fmtPrice(sl)} (${pctOf(sl)}) ${fmtUsd(-risk)}`,
    `Risk ${fmtUsd(risk, false)} · RR ${Number.isFinite(rr) ? rr.toFixed(2) : "n/a"} · ${fmtQty(t.quantity)} ${coin(t.symbol)} (${fmtUsd(notional, false)})`,
    `Fees ≈ ${fmtUsd(fees.tp, false)} at TP · ${fmtUsd(fees.sl, false)} at SL`,
  ];
  if (t.timeoutAt !== undefined) out.push(`⏱ փակում՝ ${dmy(t.timeoutAt)} UTC (եթե մինչ այդ SL / TP չլինի)`);
  out.push("", ...v11Story(sig));
  out.push("", `✋ Ձեռքով՝ SL ${fmtPrice(sl)} · TP ${tp !== null ? fmtPrice(tp) : fmtPrice(t.tpTarget)}`);
  out.push(`🆔 ${t.orderSignalId}`);
  return out.join("\n");
}

const REASON: Record<string, string> = {
  TP_FILLED: "✅ TAKE PROFIT", SL_FILLED: "❌ STOP LOSS",
  POSITION_CLOSED_EXTERNALLY: "⚪ CLOSED OUTSIDE THE BOT", CLOSED_NO_FILLS_FOUND: "⚪ CLOSED (no fills found)",
  FAILSAFE_CLOSED: "⚪ FAIL-SAFE CLOSE (no SL found)", MANUAL_CLOSE: "⚪ CLOSED BY HAND",
  TIMEOUT_CLOSED: "⏱ TIME OUT -- CLOSED AT MARKET",
};

export function formatV11Close(t: V11TradeDoc): string {
  const held = t.closedAt !== null ? Math.max(0, Math.round((t.closedAt - t.createdAt) / 60_000)) : null;
  return [
    `${REASON[t.closeReason ?? ""] ?? "⚪ CLOSED"} · ${V11_HEAD} · ${t.symbol} · ${t.side} · ${t.mode}`,
    SEP,
    `🆔 ${t.orderSignalId}`,
    ...(t.closedAt !== null ? [`📅 ${dmy(t.closedAt)} UTC`] : []),
    `Entry     ${fmtPrice(t.entryPrice)}`,
    `Exit      ${fmtPrice(t.exitPrice)}`,
    `Net PnL   ${fmtUsd(t.pnlUsd)}${t.pnlR !== null ? `  (${t.pnlR >= 0 ? "+" : ""}${t.pnlR.toFixed(2)}R, fees included)` : ""}`,
    `Held      ${held === null ? "?" : held >= 120 ? `${(held / 60).toFixed(1)} h` : `${held} min`}`,
  ].join("\n");
}

export function formatV11Failure(t: Pick<V11TradeDoc, "symbol" | "side" | "mode" | "orderSignalId" | "failureReason" | "state">): string {
  return [
    `⚠️ ${V11_HEAD} · ${t.symbol} · ${t.side} · ${t.mode} · ${t.state === "SKIPPED" ? "NOT OPENED (skipped)" : "NOT OPENED"}`,
    SEP,
    `🆔 ${t.orderSignalId}`,
    `Reason: ${t.failureReason ?? "unknown"}`,
  ].join("\n");
}

/** one line for the log / a hand-check: the signal in short */
export function v11SignalLine(sig: V11SignalDoc): string {
  return `${sig.symbol} ${sig.side} entry ${dm(sig.entryT)} @ ${fmtPrice(sig.price)} SL ${fmtPrice(sig.stop)} · rally ${dm(sig.wick.rally.startT)}→${dm(sig.wick.rally.t)} ${sp(sig.wick.rally.movePct)} OI ${sp(sig.wick.rally.oiPct)} ${sig.wick.rally.type} · wick ${dm(sig.wick.t)} liq ${usdShort(sig.wick.liqUsd)} (p85 ${usdShort(sig.wick.liqNorm)}) · confirm ${dm(sig.confirm.t)} OI ${sp(sig.confirm.oiPct)}`;
}
