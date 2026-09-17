/**
 * Sep 17 2026 (Karo), operator-requested Telegram UX pass. DISPLAY
 * ONLY -- never touches persisted prices, sizing, or order
 * placement. Magnitude-based (not per-symbol hardcoded): decimal
 * precision is derived from the price's own value, not a symbol
 * lookup table. This does NOT call Binance (no getExchangeInfo
 * fetch) -- PAPER mode's own "zero Binance calls" invariant must
 * never be broken by a Telegram formatting concern.
 */

export function formatPrice(price: number): string {
  const abs = Math.abs(price);
  let decimals: number;
  if (abs === 0) decimals = 2;
  else if (abs >= 1) {
    // ~6 significant figures total (e.g. 75164.2, 2477.43), never fewer than 1 decimal shown.
    const intDigits = Math.floor(Math.log10(abs)) + 1;
    decimals = Math.max(1, 6 - intDigits);
  } else {
    // sub-1 prices: ~5 significant figures counted from the first nonzero digit (e.g. 0.19926).
    const magnitude = Math.floor(Math.log10(abs));
    decimals = Math.min(8, -magnitude + 4);
  }

  let fixed = price.toFixed(decimals);
  if (fixed.includes(".")) fixed = fixed.replace(/0+$/, "").replace(/\.$/, "");

  const [intPart, decPart] = fixed.split(".");
  const withCommas = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart ? `${withCommas}.${decPart}` : withCommas;
}

export function formatSignedUsd(usd: number, digits = 2): string {
  const sign = usd > 0 ? "+" : usd < 0 ? "-" : "";
  return `${sign}$${Math.abs(usd).toFixed(digits)}`;
}

export function formatCompactUsd(usd: number): string {
  const abs = Math.abs(usd);
  const sign = usd < 0 ? "-" : "";
  if (abs >= 1_000_000)
    return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000)
    return `${sign}$${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export function formatUtcTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} UTC`;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

export function displayNameFromUserId(userId: string): string {
  return userId
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
