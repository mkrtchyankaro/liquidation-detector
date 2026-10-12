/** Number formatting shared by every strategy's Telegram messages (was in v9-telegram.ts, unchanged). */
export function fmtPrice(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "n/a";
  const a = Math.abs(p);
  const decimals =
    a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
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
