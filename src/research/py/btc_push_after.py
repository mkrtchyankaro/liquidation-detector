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
    python src/research/py/btc_push_after.py --hours 600 --pre-hours 4      # 25 days (Binance keeps 30 days of OI)

VICTIMS (Johnny, Oct 2): coins that went their OWN way in the hours before the move (lower half by R2 on BTC),
then followed BTC in the move with their OI FALLING -- listed one by one with what they had before / after.
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
    ap.add_argument("--pre-hours", type=float, default=4, help="the hours before the move to call a coin independent or not")
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
            data[c] = (dc.klines(s, "1m", first - 25 * dc.HOUR, now), dc.open_interest(s, first - 25 * dc.HOUR, now))
        except Exception as e:  # noqa: BLE001
            print(f"  {s}: failed ({e})")

    print(f"BTC moves >= {a.min_atr} ATR (k={a.k}){'' if a.all else ' where BTC OI GREW (new positions)'} · last {a.hours:g}h · {dc.tz_name()}")
    print("followers = upper half by follow (R2 inside the move) that moved the same way as BTC · AFTER = from known_at (live)")
    print(f"before = the {a.pre_hours:g}h before the move: 'indep' = lower half by R2 on BTC then (the coin went its own way)")
    print("VICTIM = was independent before, followed BTC in the move, and its OI FELL (dragged by BTC, forced closing)")
    print("coin = the coin alone, + went on / - came back · vs BTC = beyond what BTC explains (beta from the 24h before)\n")
    rows = []
    pre_ms = int(a.pre_hours * dc.HOUR)
    for m, b_oi in moves:
        b_pct = 100 * (m.p1 - m.p0) / m.p0
        print(f"BTC {'▲' if m.dir == 'UP' else '▼'} {dc.fmt(m.start)} -> {dc.fmt(m.end)} · price {b_pct:+.2f}% · "
              f"{abs(m.p1 - m.p0) / (m.threshold / a.k):.1f} ATR · BTC OI {b_oi:+.2f}% · known {dc.fmt(m.known)}")
        stats = []
        for c, (k, oi) in data.items():
            st = window_stats(k, btc, m.start, m.end)
            pre = window_stats(k, btc, m.start - pre_ms, m.start)
            stats.append({"coin": c, **st, "OI_%": oi_pct(oi, m.start, m.end),
                          "pre_follow": pre["follow"], "pre_price_%": pre["price_%"], "pre_OI_%": oi_pct(oi, m.start - pre_ms, m.start)})
        df = pd.DataFrame(stats).dropna(subset=["follow", "price_%", "pre_follow"])
        cut, pre_cut = df["follow"].median(), df["pre_follow"].median()
        print("   group             coin   before  during  price    xBTC   OI      | 1h coin  1h vsBTC | 4h coin  4h vsBTC")
        for _, r in df.sort_values("follow", ascending=False).iterrows():
            follower = r["follow"] >= cut and np.sign(r["price_%"]) == np.sign(b_pct)
            indep = r["pre_follow"] < pre_cut
            if not follower:
                group = "other"
            elif indep:
                group = "VICTIM" if r["OI_%"] < 0 else "WAS INDEP, OI UP"
            else:
                group = "FOLLOWER, OI DOWN" if r["OI_%"] < 0 else "FOLLOWER, OI UP"
            k, _ = data[r["coin"]]
            sign = float(np.sign(r["price_%"]))
            beta = beta_before(k, btc, m.start)
            c1, v1 = after(k, btc, m.known, 1, sign, beta)
            c4, v4 = after(k, btc, m.known, 4, sign, beta)
            rows.append({"move": dc.fmt(m.start), "btc_dir": m.dir, "btc_%": b_pct, "btc_oi": b_oi, "group": group, "coin": r["coin"],
                         "pre_follow": r["pre_follow"], "follow": r["follow"], "price_%": r["price_%"], "x_BTC": r["x_BTC"],
                         "OI_%": r["OI_%"], "pre_price_%": float(np.sign(b_pct)) * r["pre_price_%"], "pre_OI_%": r["pre_OI_%"],
                         "c1": c1, "v1": v1, "c4": c4, "v4": v4})
            if follower:
                f = lambda v: f"{v:+6.2f}%" if np.isfinite(v) else "   n/a "
                print(f"   {group:<17} {r['coin']:<6} {r['pre_follow']:.2f}    {r['follow']:.2f}  {r['price_%']:+6.2f}% {r['x_BTC']:5.2f} {r['OI_%']:+6.2f}% |"
                      f" {f(c1)} {f(v1)} | {f(c4)} {f(v4)}")
        print("")

    s = pd.DataFrame(rows)
    groups = ["VICTIM", "WAS INDEP, OI UP", "FOLLOWER, OI DOWN", "FOLLOWER, OI UP", "other"]
    print("SUMMARY · after BTC's move became known (known_at)")
    print("   group               cases | 1h: came back  avg coin  avg vs BTC | 4h: came back  avg coin  avg vs BTC")
    for g in groups:
        x = s[s["group"] == g]
        def part(c: str, v: str) -> str:
            cc, vv = x[c].dropna(), x[v].dropna()
            back = int((vv < 0).sum())
            return f"{back:3d}/{len(vv):<3d} ({100 * back / len(vv) if len(vv) else 0:3.0f}%)  {cc.mean():+6.2f}%  {vv.mean():+6.2f}%"
        print(f"   {g:<19} {len(x):5d} | {part('c1', 'v1')} | {part('c4', 'v4')}")

    # the same move, victims vs the other followers: the market of that move cancels out
    paired = []
    for mv, x in s.groupby("move"):
        v = x[x["group"] == "VICTIM"]["v4"].dropna()
        o = x[x["group"].isin(["WAS INDEP, OI UP", "FOLLOWER, OI DOWN", "FOLLOWER, OI UP"])]["v4"].dropna()
        if len(v) and len(o):
            paired.append(v.mean() - o.mean())
    if paired:
        p = np.array(paired)
        print(f"\nSAME MOVE, 4h vs BTC: victims minus the other followers · {len(p)} moves · victims came back MORE in "
              f"{int((p < 0).sum())} of {len(p)} · average difference {p.mean():+.2f}%")

    vic = s[s["group"] == "VICTIM"].sort_values("move")
    if len(vic):
        print(f"\nVICTIMS one by one ({len(vic)}): before = R2 on BTC in the {a.pre_hours:g}h before · pre price = the coin's move in those hours (+ = already BTC's way, - = the other way) · pre OI = its OI then")
        print("   move (BTC start)  BTC        coin   before during  price    xBTC  OI      pre price  pre OI  | 1h vsBTC  4h vsBTC")
        f = lambda v: f"{v:+6.2f}%" if np.isfinite(v) else "   n/a "
        for _, r in vic.iterrows():
            print(f"   {r['move']}       {'▲' if r['btc_dir'] == 'UP' else '▼'} {r['btc_%']:+5.2f}%  {r['coin']:<6} {r['pre_follow']:.2f}   {r['follow']:.2f}  "
                  f"{r['price_%']:+6.2f}% {r['x_BTC']:5.2f} {r['OI_%']:+6.2f}%  {f(r['pre_price_%'])}  {f(r['pre_OI_%'])} | {f(r['v1'])}  {f(r['v4'])}")
        print("\n   what they share:")
        print(f"   coins: {', '.join(f'{c} {n}' for c, n in vic['coin'].value_counts().items())}")
        print(f"   BTC up / down moves: {int((vic['btc_dir'] == 'UP').sum())} / {int((vic['btc_dir'] == 'DOWN').sum())}")
        for col, name in [("x_BTC", "x BTC in the move"), ("OI_%", "OI in the move"), ("pre_OI_%", "OI in the hours before"), ("pre_price_%", "price before (+ = BTC's way)")]:
            print(f"   {name:<26} median {vic[col].median():+.2f}   (other followers: {s[s['group'].str.startswith(('WAS', 'FOLLOWER'))][col].median():+.2f})")
    print(f"\nmoves: {len(moves)} · came back = vs BTC < 0 · n/a = not 1h / 4h after known_at yet")


if __name__ == "__main__":
    main()
