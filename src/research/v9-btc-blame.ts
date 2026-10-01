/**
 * HOW MUCH WAS BTC TO BLAME (Johnny, Oct 1 2026) -- research only. For one closed trade, from the 1-minute closes of
 * the coin and of BTCUSDT between the entry and the exit:
 *   coinPct  the coin's move in the TRADE's direction (+ = for the trade, - = against it)
 *   btcPct   BTC's move in the trade's direction over the same minutes (- = BTC went against the trade)
 *   ratio    coin move / BTC move (how strongly the coin amplified BTC in this trade; only when BTC moved)
 *   r2       share of the coin's minute-by-minute moves that BTC's minute moves explain (0 = the coin moved on its
 *            own, 1 = it only followed BTC) -- the square of the correlation of the two 1-minute return series
 * No thresholds: the tool only reports the numbers and splits them by result.
 */
export interface BlameBar {
  t: number;
  close: number;
}
export interface Blame {
  minutes: number;
  coinPct: number;
  btcPct: number;
  ratio: number | null;
  r2: number | null;
}

export function blameOf(
  side: "LONG" | "SHORT",
  coin: readonly BlameBar[],
  btc: readonly BlameBar[],
  from: number,
  to: number,
): Blame | null {
  const b = new Map(
    btc
      .filter((x) => x.t >= from && x.t <= to && x.close > 0)
      .map((x) => [x.t, x.close]),
  );
  const pairs = coin
    .filter((x) => x.t >= from && x.t <= to && x.close > 0 && b.has(x.t))
    .map((x) => [x.close, b.get(x.t)!] as const);
  if (pairs.length < 2) return null;
  const sgn = side === "LONG" ? 1 : -1;
  const pct = (a: number, z: number): number => (100 * (z - a)) / a;
  const coinPct = sgn * pct(pairs[0][0], pairs[pairs.length - 1][0]);
  const btcPct = sgn * pct(pairs[0][1], pairs[pairs.length - 1][1]);
  const rc: number[] = [],
    rb: number[] = [];
  for (let i = 1; i < pairs.length; i++) {
    rc.push(pairs[i][0] / pairs[i - 1][0] - 1);
    rb.push(pairs[i][1] / pairs[i - 1][1] - 1);
  }
  const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
  const mc = mean(rc),
    mb = mean(rb);
  let cov = 0,
    vc = 0,
    vb = 0;
  for (let i = 0; i < rc.length; i++) {
    cov += (rc[i] - mc) * (rb[i] - mb);
    vc += (rc[i] - mc) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  const r2 = vc > 0 && vb > 0 ? (cov * cov) / (vc * vb) : null;
  return {
    minutes: pairs.length,
    coinPct,
    btcPct,
    ratio: Math.abs(btcPct) > 0 ? coinPct / btcPct : null,
    r2,
  };
}
