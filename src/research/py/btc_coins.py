"""
BTC's MOVES and the coins that followed them (Johnny, Oct 2 2026) -- research only, read-only (Binance public API).

1. BTC's moves by Directional Change (dc_moves.py): a move ends when the price comes back k x 1h-ATR (default k=1).
2. For each move: BTC's OI change = the strength of the move (new positions or not).
3. In that same window, every coin:
     follow   R2 of the coin's 1-minute moves on BTC's INSIDE the window (1 = moved exactly with BTC)
     price %  and x BTC = coin % / BTC %
     OI %     the coin's OI change over the window (5-minute OI): down = no new positions there, only closing /
              forced liquidations
   The coins are sorted by follow; the upper half = the coins that followed BTC most in that move.
4. SUMMARY over all moves: BTC OI change vs the followers' OI -- is it "BTC OI up, followers' OI down"?

    python src/research/py/btc_coins.py                    # last 24h, k=1, UTC
    python src/research/py/btc_coins.py --hours 72 --min-atr 2 --coins DOGE,AVAX,SOL
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import pandas as pd

import dc_moves as dc

DEFAULT = "ETH,SOL,XRP,BNB,DOGE,ADA,LINK,AVAX,SUI,HYPE,LTC,BCH,DOT,NEAR,UNI,ENA,ALGO,XTZ,WLD,STRK,HBAR,ZEC,XLM,ONDO"


def window_stats(coin: pd.DataFrame, btc: pd.DataFrame, start: int, end: int) -> dict:
    """coin vs BTC inside [start, end]: R2 of 1-minute returns, price %, x BTC."""
    c = coin[(coin["t"] >= start) & (coin["t"] <= end)].set_index("t")["close"]
    b = btc[(btc["t"] >= start) & (btc["t"] <= end)].set_index("t")["close"]
    j = pd.concat([c.rename("c"), b.rename("b")], axis=1, join="inner").dropna()
    out = {"follow": np.nan, "price_%": np.nan, "x_BTC": np.nan}
    if len(j) < 2:
        return out
    pc = 100 * (j["c"].iloc[-1] / j["c"].iloc[0] - 1)
    pb = 100 * (j["b"].iloc[-1] / j["b"].iloc[0] - 1)
    out["price_%"] = pc
    out["x_BTC"] = pc / pb if pb != 0 else np.nan
    r = j.pct_change().dropna()
    if len(r) >= 10 and r["b"].std() > 0 and r["c"].std() > 0:
        out["follow"] = float(np.corrcoef(r["b"], r["c"])[0, 1] ** 2)
    return out


def oi_pct(oi: pd.Series, start: int, end: int) -> float:
    o0, o1 = dc.oi_at(oi, start), dc.oi_at(oi, end)
    return 100 * (o1 - o0) / o0 if np.isfinite(o0) and np.isfinite(o1) and o0 > 0 else np.nan


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--k", type=float, default=1.0)
    ap.add_argument("--min-atr", type=float, default=0.0, help="only BTC moves at least this many 1h-ATRs")
    ap.add_argument("--coins", default=DEFAULT)
    ap.add_argument("--tz", type=float, default=0)
    a = ap.parse_args()
    dc.set_tz(a.tz)
    coins = [c.strip().upper() for c in a.coins.split(",") if c.strip()]
    now = int(time.time() * 1000) // dc.MIN * dc.MIN
    since = now - int(a.hours * dc.HOUR)
    warm = since - 3 * 24 * dc.HOUR

    h = dc.klines("BTCUSDT", "1h", warm - 2 * 24 * dc.HOUR, now)
    btc = dc.klines("BTCUSDT", "1m", warm, now)
    btc_oi = dc.open_interest("BTCUSDT", warm, now)
    h["atr"] = dc.atr_wilder(h)
    th = dc.threshold_at(btc["t"].to_numpy(), h["t"].to_numpy(), h["atr"].to_numpy(), a.k)
    moves = [m for m in dc.directional_change(btc["t"].to_numpy(), btc["high"].to_numpy(), btc["low"].to_numpy(), th) if m.end >= since]
    moves = [m for m in moves if abs(m.p1 - m.p0) / (m.threshold / a.k) >= a.min_atr]
    first = min((m.start for m in moves), default=since)

    data = {}
    for c in coins:
        s = c + "USDT"
        try:
            data[c] = (dc.klines(s, "1m", first - dc.HOUR, now), dc.open_interest(s, first - dc.HOUR, now))
        except Exception as e:  # noqa: BLE001
            print(f"  {s}: failed ({e})")

    print(f"BTC moves (k={a.k}: a move ends when BTC comes back {a.k} x 1h-ATR) · last {a.hours:g}h · {dc.tz_name()}"
          f"{f' · only moves >= {a.min_atr} ATR' if a.min_atr else ''}")
    print("follow = R2 of the coin's 1-minute moves on BTC's inside the move · x BTC = coin % / BTC % · OI = change over the move\n")
    summary = []
    for m in moves:
        atr = m.threshold / a.k
        b_pct = 100 * (m.p1 - m.p0) / m.p0
        b_oi = oi_pct(btc_oi, m.start, m.end)
        known = f"known {dc.fmt(m.known)} ({round((m.known - m.end) / dc.MIN)} min after the end)" if m.known > 0 else "still going"
        print(f"BTC {'▲' if m.dir == 'UP' else '▼'} {dc.fmt(m.start)} -> {dc.fmt(m.end)} ({(m.end - m.start) / dc.HOUR:.1f}h) · "
              f"price {b_pct:+.2f}% · {abs(m.p1 - m.p0) / atr:.1f} ATR · BTC OI {b_oi:+.2f}% · {known}")
        rows = []
        for c, (k, oi) in data.items():
            st = window_stats(k, btc, m.start, m.end)
            rows.append({"coin": c, **st, "OI_%": oi_pct(oi, m.start, m.end)})
        df = pd.DataFrame(rows).sort_values("follow", ascending=False, na_position="last").reset_index(drop=True)
        half = (len(df) + 1) // 2
        top, rest = df.iloc[:half], df.iloc[half:]
        for i, r in df.iterrows():
            if i == half:
                print("   " + "-" * 52)
            print(f"   {r['coin']:<6} follow {r['follow']:.2f}  price {r['price_%']:+6.2f}%  x {r['x_BTC']:5.2f}  OI {r['OI_%']:+6.2f}%"
                  f"{'  <- OI DOWN' if r['OI_%'] < 0 else ''}")
        down_top = int((top["OI_%"] < 0).sum())
        print(f"   followers (upper half): OI down {down_top} of {len(top)} · avg OI {top['OI_%'].mean():+.2f}%"
              f" · rest: OI down {int((rest['OI_%'] < 0).sum())} of {len(rest)} · avg OI {rest['OI_%'].mean():+.2f}%\n")
        summary.append({"move": f"{'UP' if m.dir == 'UP' else 'DN'} {dc.fmt(m.start)}", "BTC_%": round(b_pct, 2),
                        "size_ATR": round(abs(m.p1 - m.p0) / atr, 1), "BTC_OI_%": round(b_oi, 2),
                        "followers_OI_down": f"{down_top}/{len(top)}", "followers_avg_OI_%": round(top["OI_%"].mean(), 2),
                        "rest_avg_OI_%": round(rest["OI_%"].mean(), 2)})
    if not summary:
        print("no BTC moves in this window")
        return
    s = pd.DataFrame(summary).sort_values("BTC_OI_%", ascending=False)
    print("SUMMARY · moves sorted by BTC's OI change (top = strongest new positions)")
    print(s.to_string(index=False))
    if len(s) >= 5:
        rho = s["BTC_OI_%"].rank().corr(s["followers_avg_OI_%"].rank())
        print(f"\nrank correlation BTC OI % vs followers' OI %: {rho:+.2f}  "
              "(near -1 = the more BTC's OI grows, the more the followers' OI falls; near +1 = they grow together)")


if __name__ == "__main__":
    main()
