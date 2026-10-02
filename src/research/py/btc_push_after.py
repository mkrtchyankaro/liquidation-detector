"""
BTC PUSHES WITH NEW POSITIONS -- what happens AFTER to the coins that followed it? (Johnny, Oct 2 2026)
Research only, read-only (Binance public API).

1. BTC's moves by Directional Change (dc_moves.py, k x 1h-ATR). Only the moves where BTC's OI GREW
   (new positions: someone big is driving it). --all to see every move.
2. The coins that moved WITH BTC in that move: follow (R2 of 1-minute moves on BTC's inside the move) in the upper
   half of that move, and the coin moved the same way as BTC. They are split:
     OI UP    the coin opened positions too
     OI DOWN  the coin's positions were closed -- BTC dragged it, forced liquidations
3. AFTER: from the moment the end of BTC's move became known LIVE (known_at, not the top), 1h and 4h later:
     coin %      the coin alone, signed by its move: + it went on the same way, - it came back
     vs BTC %    coin - beta x BTC (beta from the coin's 1-minute moves on BTC's in the 24h BEFORE the move),
                 signed the same way: + went on more than BTC explains, - came back against BTC
   Everything used to pick a coin is known at known_at; only the result is after it.

    python src/research/py/btc_push_after.py --hours 168 --min-atr 2
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import pandas as pd

import dc_moves as dc
from btc_coins import DEFAULT, oi_pct, window_stats


def price_at(df: pd.DataFrame, ts: int) -> float:
    """close of the last 1-minute candle that has CLOSED by ts"""
    i = df["t"].searchsorted(ts - dc.MIN, side="right") - 1
    return float(df["close"].iloc[i]) if i >= 0 and ts - dc.MIN - df["t"].iloc[i] <= 5 * dc.MIN else float("nan")


def beta_before(coin: pd.DataFrame, btc: pd.DataFrame, start: int, hours: float = 24) -> float:
    lo = start - int(hours * dc.HOUR)
    c = coin[(coin["t"] >= lo) & (coin["t"] < start)].set_index("t")["close"]
    b = btc[(btc["t"] >= lo) & (btc["t"] < start)].set_index("t")["close"]
    j = pd.concat([c.rename("c"), b.rename("b")], axis=1, join="inner").pct_change().dropna()
    if len(j) < 60 or j["b"].var() <= 0:
        return float("nan")
    return float(j["c"].cov(j["b"]) / j["b"].var())


def after(coin: pd.DataFrame, btc: pd.DataFrame, known: int, hours: float, sign: float, beta: float) -> tuple[float, float]:
    c0, c1 = price_at(coin, known), price_at(coin, known + int(hours * dc.HOUR))
    b0, b1 = price_at(btc, known), price_at(btc, known + int(hours * dc.HOUR))
    if not all(np.isfinite([c0, c1, b0, b1])):
        return float("nan"), float("nan")
    rc, rb = 100 * (c1 / c0 - 1), 100 * (b1 / b0 - 1)
    return sign * rc, sign * (rc - beta * rb) if np.isfinite(beta) else float("nan")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=168)
    ap.add_argument("--k", type=float, default=1.0)
    ap.add_argument("--min-atr", type=float, default=2.0)
    ap.add_argument("--all", action="store_true", help="also BTC moves where its OI did not grow")
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
    moves = [m for m in dc.directional_change(btc["t"].to_numpy(), btc["high"].to_numpy(), btc["low"].to_numpy(), th)
             if m.end >= since and m.known > 0 and abs(m.p1 - m.p0) / (m.threshold / a.k) >= a.min_atr]
    moves = [(m, oi_pct(btc_oi, m.start, m.end)) for m in moves]
    if not a.all:
        moves = [(m, o) for m, o in moves if o > 0]
    if not moves:
        print("no BTC moves like that in this window")
        return
    first = min(m.start for m, _ in moves)

    data = {}
    for c in coins:
        s = c + "USDT"
        try:
            data[c] = (dc.klines(s, "1m", first - 25 * dc.HOUR, now), dc.open_interest(s, first - dc.HOUR, now))
        except Exception as e:  # noqa: BLE001
            print(f"  {s}: failed ({e})")

    print(f"BTC moves >= {a.min_atr} ATR (k={a.k}){'' if a.all else ' where BTC OI GREW (new positions)'} · last {a.hours:g}h · {dc.tz_name()}")
    print("followers = upper half by follow (R2 inside the move) that moved the same way as BTC · AFTER = from known_at (live)")
    print("coin = the coin alone, + went on / - came back · vs BTC = beyond what BTC explains (beta from the 24h before)\n")
    rows = []
    for m, b_oi in moves:
        b_pct = 100 * (m.p1 - m.p0) / m.p0
        print(f"BTC {'▲' if m.dir == 'UP' else '▼'} {dc.fmt(m.start)} -> {dc.fmt(m.end)} · price {b_pct:+.2f}% · "
              f"{abs(m.p1 - m.p0) / (m.threshold / a.k):.1f} ATR · BTC OI {b_oi:+.2f}% · known {dc.fmt(m.known)}")
        stats = []
        for c, (k, oi) in data.items():
            st = window_stats(k, btc, m.start, m.end)
            stats.append({"coin": c, **st, "OI_%": oi_pct(oi, m.start, m.end)})
        df = pd.DataFrame(stats).dropna(subset=["follow", "price_%"])
        cut = df["follow"].median()
        print("   group          coin    follow  price    OI      | 1h coin  1h vsBTC | 4h coin  4h vsBTC")
        for _, r in df.sort_values("follow", ascending=False).iterrows():
            same_way = np.sign(r["price_%"]) == np.sign(b_pct)
            follower = r["follow"] >= cut and same_way
            group = ("FOLLOW OI UP" if r["OI_%"] > 0 else "FOLLOW OI DOWN") if follower else "other"
            k, _ = data[r["coin"]]
            sign = float(np.sign(r["price_%"]))
            beta = beta_before(k, btc, m.start)
            c1, v1 = after(k, btc, m.known, 1, sign, beta)
            c4, v4 = after(k, btc, m.known, 4, sign, beta)
            rows.append({"move": dc.fmt(m.start), "group": group, "coin": r["coin"], "c1": c1, "v1": v1, "c4": c4, "v4": v4})
            if follower:
                f = lambda v: f"{v:+6.2f}%" if np.isfinite(v) else "   n/a "
                print(f"   {group:<14} {r['coin']:<6} {r['follow']:.2f}  {r['price_%']:+6.2f}% {r['OI_%']:+6.2f}% | {f(c1)} {f(v1)} | {f(c4)} {f(v4)}")
        print("")

    s = pd.DataFrame(rows)
    print("SUMMARY · after BTC's move became known (known_at)")
    print("   group           cases | 1h: came back  avg coin  avg vs BTC | 4h: came back  avg coin  avg vs BTC")
    for g in ["FOLLOW OI UP", "FOLLOW OI DOWN", "other"]:
        x = s[s["group"] == g]
        def part(c: str, v: str) -> str:
            cc, vv = x[c].dropna(), x[v].dropna()
            back = int((vv < 0).sum())
            return f"{back:3d}/{len(vv):<3d} ({100 * back / len(vv) if len(vv) else 0:3.0f}%)  {cc.mean():+6.2f}%  {vv.mean():+6.2f}%"
        print(f"   {g:<15} {len(x):5d} | {part('c1', 'v1')} | {part('c4', 'v4')}")
    print(f"\nmoves: {len(moves)} · came back = vs BTC < 0 · n/a = not 1h / 4h after known_at yet")


if __name__ == "__main__":
    main()
