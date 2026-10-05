import { fmtPrice, fmtQty, fmtUsd } from "../v9/v9-telegram";
import { estimateFeesUsd } from "../v9/v9-fees";
import type { V10SignalDoc, V10TradeDoc } from "./v10-repository";
import { formatBookLines, formatWallLines } from "./v10-book";
import { formatZoneLine } from "./v10-zone";

/**
 * V10 messages (plain text). Header "V10 · BTC" (part 1, BTC-led) or "V10 · ALT" (part 2, the alt's own move) on every
 * message so it is never mixed up with V9 or with the other part.
 * 🔻 SHORT entry · 🔺 LONG entry · ✅ TP · ❌ SL · ⚪ other close · ⚠️ not opened. $ figures use THIS user's trade.
 * The story = Johnny's 3 points, 15m, UTC, mirrored for LONG: "atr" -- OI grew with the price -> OI below its peak ->
 * the close 1 ATR back from the top (bottom); "oiPeak" -- OI up -> OI falls after its peak -> the first red (green) candle.
 */
const SEP = "------------------------------";
const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const hm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const dhm = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const sp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const coin = (s: string): string => s.replace(/USDT$/, "");
const W = 15 * 60_000;

/** "V10 · BTC" / "V10 · ALT" */
export const v10Head = (t: { kind?: string }): string => `V10 · ${t.kind === "OWN" ? "ALT" : "BTC"}`;

/** "10-03 01:30" -- every time in UTC */
const t15 = (ms: number): string => dhm(ms);

/** Johnny's 3 points, short, UTC (Oct 3). `who` = whose candles (BTC or the alt). */
function threePoints(a: V10SignalDoc["turn"], who: string, rankH: number): string[] {
  const top = a.side === "SHORT";
  if (a.entry === "flush") {
    // Oct 4, the ALT LONG: a fall with OI DOWN (longs closed / liquidated, RANK 1), then a candle with OI UP 1 ATR off the low
    const back = (100 * (a.price - a.extreme)) / a.extreme;
    return [
      `1️⃣ ${t15(a.moveStartT)} → ${hm(a.extremeT + W)} · ${who} ${top ? "⬆️" : "⬇️"} ${sp(a.movePct)} · OI ${sp(a.moveOiPct)} (դիրքերը փակվեցին · RANK 1 · ${a.prior} շարժում / ${rankH}ժ)`,
      `2️⃣ ${hm(a.candleEnd - W)} մոմ · OI ${sp(a.candleOiPct)} (նոր դիրքեր) · փակվեց ${top ? "գագաթից" : "հատակից"} ${sp(top ? -back : back)} (≥ 1 ATR) → entry`,
    ];
  }
  if (a.declineOiPct !== undefined && a.atr !== undefined) {
    // the "story" entry (Johnny Oct 3): growth -> OI falls while the price still goes on -> the red candle 1 ATR back
    const atrPct = (100 * a.atr) / a.extreme;
    return [
      `1️⃣ ${t15(a.moveStartT)} → ${hm(a.peakT)} · ${who} · OI ${sp(a.moveOiPct)} · գինը ${sp(a.buildPricePct ?? NaN)} (RANK 1 · ${a.prior} շարժում / ${rankH}ժ)`,
      `2️⃣ ${hm(a.peakT)} → ${hm(a.topT ?? a.extremeT + W)} · OI ${sp(a.declineOiPct)} · գինը ${sp(a.declinePricePct ?? NaN)} → ${top ? "գագաթ" : "հատակ"}`,
      `3️⃣ ${hm(a.candleEnd - W)} ${top ? "կարմիր" : "կանաչ"} մոմ · ${top ? "գագաթից" : "հատակից"} ${sp(top ? -(a.backPct ?? NaN) : a.backPct ?? NaN)} (1 ATR = ${atrPct.toFixed(2)}%${a.entry === "storyFrozen" ? ", շարժման սկզբից" : ""}) → entry`,
    ];
  }
  if (a.atr !== undefined) {
    // the ATR entry (Johnny Oct 3): OI grew with the price -> OI below its peak -> the close 1 ATR back from the top
    const atrPct = (100 * a.atr) / a.extreme;
    return [
      `1️⃣ ${t15(a.moveStartT)} → ${hm(a.extremeT + W)} · ${who} ${top ? "⬆️" : "⬇️"} ${sp(a.movePct)} · OI ${sp(a.moveOiPct)} (RANK 1 · ${a.prior} շարժում / ${rankH}ժ)`,
      `2️⃣ OI-ի գագաթից հետո OI ${sp(a.fromPeakOiPct)}`,
      `3️⃣ ${hm(a.candleEnd - W)} մոմը փակվեց ${top ? "գագաթից" : "հատակից"} ${sp(top ? -(a.backPct ?? NaN) : a.backPct ?? NaN)} (1 ATR = ${atrPct.toFixed(2)}%${a.entry === "atrFrozen" ? ", շարժման սկզբից" : ""}) → entry`,
    ];
  }
  return [
    `1️⃣ ${t15(a.moveStartT)} → ${hm(a.peakT)} · ${who} ${top ? "⬆️" : "⬇️"} ${sp(a.movePct)} · OI ${sp(a.moveOiPct)} (RANK 1 · ${a.prior} շարժում / ${rankH}ժ)`,
    `2️⃣ OI-ի գագաթից հետո OI ${sp(a.fromPeakOiPct)}`,
    `3️⃣ ${hm(a.candleEnd - W)} ${top ? "կարմիր" : "կանաչ"} մոմ · OI ${sp(a.candleOiPct)} → entry`,
  ];
}

/** part 2: the alt moved on its own */
export function v10OwnStory(sig: Pick<V10SignalDoc, "turn" | "rankWindowHours" | "own">, t: Pick<V10TradeDoc, "symbol" | "side">): string[] {
  const o = sig.own;
  return [
    `📖 ${coin(t.symbol)} · 15m · UTC`,
    ...threePoints(sig.turn, coin(t.symbol), sig.rankWindowHours),
    `BTC-ն այդ ընթացքում ${o ? sp(o.btcPct) : "n/a"} · ${o?.how === "BTC OPPOSITE" ? "գնաց հակառակ" : "բացատրում է կեսից քիչը"} (R² ${o ? o.follow.toFixed(2) : "n/a"}${o?.r2Minutes ? `, ${o.r2Minutes}m` : ""})`,
  ];
}

/** part 1: BTC's 3 points, then this alt with BTC */
export function v10Story(sig: Pick<V10SignalDoc, "turn" | "rankWindowHours">, t: Pick<V10TradeDoc, "symbol" | "side" | "pick">, picks: number): string[] {
  return [
    `📖 BTC · 15m · UTC`,
    ...threePoints(sig.turn, "BTC", sig.rankWindowHours),
    `${coin(t.symbol)}-ն BTC-ի հետ ${sp(t.pick.coinPct)} (x${t.pick.x.toFixed(2)}, R² ${t.pick.follow.toFixed(2)}) · #${t.pick.rank}/${picks}`,
  ];
}

/** Oct 5 (Johnny, ADA 10-04 20:15): where the move started vs the entry and the TP -- the min move is measured to the
 *  top, so after a deep pullback the TP can lie beyond the move's start (it asks back more than the whole move) */
export function roomLine(turn: Pick<V10SignalDoc["turn"], "extreme" | "movePct">, side: "LONG" | "SHORT", entry: number, tp: number | null): string[] {
  const start = turn.extreme / (1 + turn.movePct / 100);
  if (!(start > 0) || !(entry > 0)) return [];
  const short = side === "SHORT", left = ((short ? 1 : -1) * 100 * (entry - start)) / start;
  const beyond = tp === null ? null : short ? tp < start : tp > start;
  const ch = short ? left : -left;   // the price change from the start to the entry, signed
  const gb = (100 * (turn.extreme - entry)) / (turn.extreme - start);
  return [`📏 Շարժման սկիզբ ${fmtPrice(start)} · սկզբից մինչև մուտք ${ch >= 0 ? "+" : ""}${ch.toFixed(2)}% · շարժման ${Number.isFinite(gb) ? gb.toFixed(0) : "?"}%-ն արդեն հետ է եկել${short && gb >= 50 ? " ⚠️" : ""}${beyond === null ? "" : beyond ? " · ⚠️ TP-ն շարժման սկզբից էլ անդին է" : " · TP-ն շարժման մեջ է ✅"}`];
}

export function formatV10Entry(sig: V10SignalDoc, t: V10TradeDoc): string {
  const long = t.side === "LONG", risk = t.actualRiskUsd ?? t.plannedRiskUsd;
  const entry = t.entryPrice!, sl = t.slPrice!, tp = t.tpPrice;
  const notional = t.quantity !== null ? entry * t.quantity : NaN;
  const fees = estimateFeesUsd(notional);
  const pctOf = (p: number): string => sp((100 * (p - entry)) / entry);
  const rr = tp !== null ? Math.abs(tp - entry) / Math.abs(entry - sl) : NaN;
  return [
    `${long ? "🔺" : "🔻"} ${v10Head(t)} · ${t.symbol} · ${long ? "LONG (BUY)" : "SHORT (SELL)"} · ${t.mode}`,
    SEP,
    `📍 ${utc(t.createdAt)} · 🆔 ${t.orderSignalId}`,
    `Entry ${fmtPrice(entry)}`,
    `TP    ${tp !== null ? `${fmtPrice(tp)} (${pctOf(tp)}) ${fmtUsd(risk * rr)}` : `n/a${t.binance?.tpFailureReason ? ` -- ${t.binance.tpFailureReason}` : ""}`}`,
    `SL    ${fmtPrice(sl)} (${pctOf(sl)}) ${fmtUsd(-risk)}`,
    `Risk ${fmtUsd(risk, false)} · RR ${Number.isFinite(rr) ? rr.toFixed(2) : "n/a"}`,
    `Position ${fmtQty(t.quantity)} ${coin(t.symbol)} (${fmtUsd(notional, false)})`,
    `Fees ≈ ${fmtUsd(fees.tp, false)} at TP · ${fmtUsd(fees.sl, false)} at SL`,
    ``,
    ...(sig.kind === "OWN" ? v10OwnStory(sig, t) : v10Story(sig, t, sig.picks.length)),
    ...(sig.kind === "OWN" ? roomLine(sig.turn, t.side, entry, tp) : []),
    ...("book" in t ? ["", ...formatBookLines(t.book, t.side)] : []),
    ...("book" in t && t.book?.walls ? ["", ...formatWallLines(t.book, { side: t.side, entry, tp })] : []),
    ...("zone4h" in t ? ["", formatZoneLine(t.zone4h, { side: t.side, entry, tp })] : []),
  ].join("\n");
}

const REASON: Record<string, string> = {
  TP_FILLED: "✅ TAKE PROFIT", SL_FILLED: "❌ STOP LOSS",
  POSITION_CLOSED_EXTERNALLY: "⚪ CLOSED OUTSIDE THE BOT", CLOSED_NO_FILLS_FOUND: "⚪ CLOSED (no fills found)",
  FAILSAFE_CLOSED: "⚪ FAIL-SAFE CLOSE (no SL found)", MANUAL_CLOSE: "⚪ CLOSED BY HAND",
};

export function formatV10Close(t: V10TradeDoc): string {
  const held = t.closedAt !== null ? Math.max(0, Math.round((t.closedAt - t.createdAt) / 60_000)) : null;
  return [
    `${REASON[t.closeReason ?? ""] ?? "⚪ CLOSED"} · ${v10Head(t)} · ${t.symbol} · ${t.side} · ${t.mode}`,
    SEP,
    `🆔 ${t.orderSignalId}`,
    `Entry     ${fmtPrice(t.entryPrice)}`,
    `Exit      ${fmtPrice(t.exitPrice)}`,
    `Net PnL   ${fmtUsd(t.pnlUsd)}${t.pnlR !== null ? `  (${t.pnlR >= 0 ? "+" : ""}${t.pnlR.toFixed(2)}R, fees included)` : ""}`,
    `Held      ${held ?? "?"} min`,
  ].join("\n");
}

export function formatV10Failure(t: Pick<V10TradeDoc, "symbol" | "side" | "mode" | "orderSignalId" | "failureReason" | "state" | "kind">): string {
  return [
    `⚠️ ${v10Head(t)} · ${t.symbol} · ${t.side} · ${t.mode} · ${t.state === "SKIPPED" ? "NOT OPENED (skipped)" : "NOT OPENED"}`,
    SEP,
    `🆔 ${t.orderSignalId}`,
    `Reason: ${t.failureReason ?? "unknown"}`,
  ].join("\n");
}
