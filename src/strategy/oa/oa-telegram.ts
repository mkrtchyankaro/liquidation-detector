import { fmtPrice, fmtQty, fmtUsd } from "../v9/v9-telegram";
import type { OaTradeDoc } from "./oa-paper.service";

/**
 * OA PAPER messages (plain text). 🟠 entry · ✅ TP · ❌ SL · ⏱ 48h time exit. $ figures use THIS user's riskUsd.
 * The story is told in 1h candles, UTC.
 */
const SEP = "------------------------------";
const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const dh = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const hm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const money = (v: number): string => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);
const sp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const H = 3_600_000;

export function oaTypeLine(t: Pick<OaTradeDoc, "variant" | "side" | "episode">): string {
  if (t.variant === "A") return `🎯 Տեսակ Ա · ՌԵՎԵՐՍԱԼ (${t.episode.dir === "UP" ? "գագաթում շորտերի stop-երը վերցրին" : "հատակում լոնգերի stop-երը վերցրին"})`;
  return `🎯 Տեսակ Բ · ՇԱՐՈՒՆԱԿՈՒԹՅՈՒՆ (${t.episode.dir === "UP" ? "լոնգերին մաքրեցին, շարժումը շարունակվում է վերև" : "շորտերին մաքրեցին, շարժումը շարունակվում է ներքև"})`;
}

function story(t: OaTradeDoc): string[] {
  const up = t.episode.dir === "UP";
  const victim = t.side === "LONG" ? "լոնգերի" : "շորտերի";
  const what = t.variant === "A"
    ? `նոր ${up ? "գագաթ" : "հատակ"}, ${victim} լիկվիդացիա ${money(t.oiDrop.liqUsd)}`
    : `մոմը ${up ? "կարմիր" : "կանաչ"}, ${victim} լիկվիդացիա ${money(t.oiDrop.liqUsd)}`;
  return [
    `📖 Ի՞նչ տեղի ունեցավ (1h մոմեր, UTC)`,
    ``,
    `1️⃣ Կուտակում · ${dh(t.episode.since)}-ից`,
    `Գինը ${sp(t.episode.movePct)}, OI ${sp(t.episode.oiPct)} (նոր դիրքեր)`,
    ``,
    `2️⃣ OI-ն իջավ · ${hm(t.oiDrop.hour)}–${hm(t.oiDrop.hour + H)}`,
    `OI ${sp(t.oiDrop.pct)} · ${what}`,
    ``,
    `3️⃣ Հաստատում · ${hm(t.confirmHour)}–${hm(t.confirmHour + H)}`,
    `${t.side === "LONG" ? "Կանաչ մոմ, փակվեց" : "Կարմիր մոմ, փակվեց"} ${fmtPrice(t.oiDrop.close)}-ից ${t.side === "LONG" ? "վերև" : "ներքև"}`,
    ``,
    oaTypeLine(t),
  ];
}

export function formatOaEntry(t: OaTradeDoc, riskUsd: number): string {
  const risk = Math.abs(t.entry - t.slPrice), qty = riskUsd / risk, long = t.side === "LONG";
  return [
    `🟠 OA ${t.symbol} · ${long ? "LONG (BUY)" : "SHORT (SELL)"} · PAPER · ${t.variant === "A" ? "Ա ռևերսալ" : "Բ շարունակություն"}`,
    SEP,
    `📍 ENTRY · ${utc(t.entryTs)}`,
    `🆔 ${t.signalId}`,
    ``,
    `Entry     ${fmtPrice(t.entry)}`,
    `TP        ${fmtPrice(t.tpPrice)}  (${long ? "+" : "-"}${((100 * Math.abs(t.tpPrice - t.entry)) / t.entry).toFixed(2)}%)  ${fmtUsd(riskUsd * t.rr)}`,
    `SL        ${fmtPrice(t.slPrice)}  (${long ? "-" : "+"}${t.slPct.toFixed(2)}%)  ${fmtUsd(-riskUsd)}`,
    ``,
    `Risk      ${fmtUsd(riskUsd, false)}  ·  RR ${t.rr}`,
    `Position  ${fmtQty(qty)} ${t.symbol.replace("USDT", "")} (${fmtUsd(qty * t.entry, false)})`,
    ``,
    ...story(t),
  ].join("\n");
}

export function formatOaClose(t: OaTradeDoc, riskUsd: number): string {
  const head = t.result === "TP" ? "✅ TAKE PROFIT" : t.result === "SL" ? "❌ STOP LOSS" : "⏱ 48h TIME EXIT";
  return [
    `${head} · OA ${t.symbol} · ${t.side} · PAPER · ${t.variant === "A" ? "Ա ռևերսալ" : "Բ շարունակություն"}`,
    SEP,
    `🆔 ${t.signalId}`,
    `Entry     ${fmtPrice(t.entry)}`,
    `Exit      ${fmtPrice(t.exitPrice)}`,
    `Net PnL   ${fmtUsd(riskUsd * (t.netR ?? 0))}  (${(t.netR ?? 0) >= 0 ? "+" : ""}${(t.netR ?? 0).toFixed(2)}R, fees included)`,
    `Held      ${t.minutes ?? "?"} min`,
  ].join("\n");
}
