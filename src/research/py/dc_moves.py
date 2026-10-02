"""
BTC MOVES by DIRECTIONAL CHANGE (Johnny, Oct 2 2026) -- research only, read-only (Binance public API).

What is "a move"? The Directional-Change method (Olsen / Glattfelder / Tsang): the price runs one way making new
extremes; when it comes back from the extreme by a threshold, that run is OVER (and the new one has started).
  * the threshold is not a fixed %: it is k x the 1-hour ATR known at that moment (past only), so "big" is
    relative to the current market. Small k finds small moves, big k only the big ones ("zoom levels").
  * live-safe: a move is CONFIRMED only when the price came back by the threshold -- that moment is printed too
    ("known at"); the start and end are the real extremes, known only afterwards.
For every move: start -> end (UTC by default), price %, size in ATRs, hours, BTC OI change (5-minute OI).
A chart (PNG) is saved with the moves of one zoom level drawn on the price, and OI below.

    python src/research/py/dc_moves.py                       # BTC, last 24h, k = 1, UTC
    python src/research/py/dc_moves.py --hours 72 --k 1,2,3 --plot-k 2 --symbol ETHUSDT
"""
from __future__ import annotations

import argparse
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

FAPI = "https://fapi.binance.com"
TZ = timezone.utc  # default UTC; --tz 4 for Yerevan
MIN, HOUR = 60_000, 3_600_000


# ---------------------------------------------------------------- data (Binance, public, read-only)
def _get(path: str, params: dict) -> list:
    import requests
    for attempt in range(5):
        r = requests.get(FAPI + path, params=params, timeout=20)
        if r.status_code == 200:
            return r.json()
        if r.status_code in (418, 429):
            time.sleep(5 * (attempt + 1))
            continue
        r.raise_for_status()
    raise RuntimeError(f"Binance {path} failed")


def klines(symbol: str, interval: str, start: int, end: int) -> pd.DataFrame:
    step = {"1m": MIN, "5m": 5 * MIN, "15m": 15 * MIN, "1h": HOUR}[interval]
    rows, s = [], start
    while s < end:
        data = _get("/fapi/v1/klines", {"symbol": symbol, "interval": interval, "startTime": s, "endTime": end - 1, "limit": 1500})
        if not data:
            break
        rows += [r for r in data if r[0] + step <= end]  # closed candles only
        s = data[-1][0] + step
        time.sleep(0.2)
    df = pd.DataFrame(rows, columns=list(range(12)))[[0, 1, 2, 3, 4]] if rows else pd.DataFrame(columns=[0, 1, 2, 3, 4])
    df.columns = ["t", "open", "high", "low", "close"]
    return df.astype({"t": "int64", "open": float, "high": float, "low": float, "close": float}).drop_duplicates("t").reset_index(drop=True)


def open_interest(symbol: str, start: int, end: int) -> pd.Series:
    """5-minute OI (Binance keeps 30 days). Index = timestamp ms."""
    out, s, step = {}, start, 400 * 5 * MIN
    while s < end:
        data = _get("/futures/data/openInterestHist", {"symbol": symbol, "period": "5m", "startTime": s, "endTime": min(end, s + step), "limit": 500})
        for x in data:
            out[int(x["timestamp"])] = float(x["sumOpenInterest"])
        s += step
        time.sleep(0.2)
    return pd.Series(out, dtype=float).sort_index()


# ---------------------------------------------------------------- pure logic
def atr_wilder(h: pd.DataFrame, n: int = 14) -> pd.Series:
    """Wilder ATR of hourly candles; value at a candle = known at that candle's CLOSE."""
    prev = h["close"].shift(1)
    tr = pd.concat([h["high"] - h["low"], (h["high"] - prev).abs(), (h["low"] - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def threshold_at(m_t: np.ndarray, h_t: np.ndarray, h_atr: np.ndarray, k: float) -> np.ndarray:
    """for each minute: k x the ATR of the last hourly candle CLOSED before it (past only)"""
    close_t = h_t + HOUR
    idx = np.searchsorted(close_t, m_t, side="right") - 1
    th = np.full(len(m_t), np.nan)
    ok = idx >= 0
    th[ok] = k * h_atr[idx[ok]]
    return th


@dataclass
class Move:
    dir: str          # "UP" / "DOWN"
    start: int        # ms of the extreme where it started
    end: int          # ms of the extreme where it ended
    known: int        # ms when the end was CONFIRMED live (price came back by the threshold); -1 = still going
    p0: float
    p1: float
    threshold: float  # price units, at confirmation (or now)


def directional_change(t: np.ndarray, high: np.ndarray, low: np.ndarray, th: np.ndarray) -> list[Move]:
    """Directional-change moves on 1-minute high/low with a per-minute threshold (price units)."""
    moves: list[Move] = []
    mode = None
    hi_i = lo_i = -1
    ext_i = start_i = 0
    for i in range(len(t)):
        d = th[i]
        if not np.isfinite(d) or d <= 0:
            continue
        if mode is None:
            if hi_i < 0 or high[i] > high[hi_i]: hi_i = i
            if lo_i < 0 or low[i] < low[lo_i]: lo_i = i
            if high[i] - low[lo_i] >= d:
                mode, start_i, ext_i = "UP", lo_i, i
            elif high[hi_i] - low[i] >= d:
                mode, start_i, ext_i = "DOWN", hi_i, i
            continue
        if mode == "UP":
            if high[i] >= high[ext_i]:
                ext_i = i
            elif high[ext_i] - low[i] >= d:
                moves.append(Move("UP", int(t[start_i]), int(t[ext_i]), int(t[i]) + MIN, low[start_i], high[ext_i], d))
                mode, start_i, ext_i = "DOWN", ext_i, i
        else:
            if low[i] <= low[ext_i]:
                ext_i = i
            elif high[i] - low[ext_i] >= d:
                moves.append(Move("DOWN", int(t[start_i]), int(t[ext_i]), int(t[i]) + MIN, high[start_i], low[ext_i], d))
                mode, start_i, ext_i = "UP", ext_i, i
    if mode is not None:  # the move still going: its end is not known yet
        p0 = low[start_i] if mode == "UP" else high[start_i]
        p1 = high[ext_i] if mode == "UP" else low[ext_i]
        moves.append(Move(mode, int(t[start_i]), int(t[ext_i]), -1, p0, p1, th[-1]))
    return moves


def oi_at(oi: pd.Series, ts: int) -> float:
    if oi.empty:
        return float("nan")
    i = oi.index.searchsorted(ts, side="right") - 1
    return float(oi.iloc[i]) if i >= 0 and ts - oi.index[i] <= 15 * MIN else float("nan")


# ---------------------------------------------------------------- report + chart
def set_tz(hours: float) -> None:
    global TZ
    TZ = timezone(timedelta(hours=hours))


def tz_name() -> str:
    off = TZ.utcoffset(None).total_seconds() / 3600
    return "UTC" if off == 0 else f"UTC{off:+g}"


def fmt(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, TZ).strftime("%m-%d %H:%M")


def report(symbol: str, k: float, moves: list[Move], atr_now: float, oi: pd.Series, since: int) -> pd.DataFrame:
    rows = []
    for m in moves:
        if m.end < since:
            continue
        pct = 100 * (m.p1 - m.p0) / m.p0
        o0, o1 = oi_at(oi, m.start), oi_at(oi, m.end)
        rows.append({
            "dir": m.dir, "start": fmt(m.start), "end": fmt(m.end), "known_at": fmt(m.known) if m.known > 0 else "still going",
            "wait_min": round((m.known - m.end) / MIN) if m.known > 0 else None,
            "hours": round((m.end - m.start) / HOUR, 1), "price_%": round(pct, 2),
            "size_ATR": round(abs(m.p1 - m.p0) / (m.threshold / k), 1),
            "late_%": round(100 * m.threshold / m.p1, 2) if m.known > 0 else None,
            "OI_%": round(100 * (o1 - o0) / o0, 2) if o0 and np.isfinite(o0) and np.isfinite(o1) else None,
        })
    df = pd.DataFrame(rows)
    print(f"\n=== {symbol} · zoom k = {k} (a move ends when the price comes back {k} x 1h-ATR; ATR now = {atr_now:,.1f}) · {len(df)} moves · {tz_name()}")
    if df.empty:
        print("   none")
    else:
        print(df.to_string(index=False))
    return df


def chart(path: str, symbol: str, m: pd.DataFrame, oi: pd.Series, moves: list[Move], k: float, since: int) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    when = lambda ms: datetime.fromtimestamp(ms / 1000, TZ).replace(tzinfo=None)
    mm = m[m["t"] >= since]
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(16, 9), sharex=True, gridspec_kw={"height_ratios": [3, 1]})
    a1.plot([when(x) for x in mm["t"]], mm["close"], color="#888", lw=0.8)
    for mv in moves:
        if mv.end < since:
            continue
        c = "#1a9850" if mv.dir == "UP" else "#d73027"
        a1.plot([when(mv.start), when(mv.end)], [mv.p0, mv.p1], color=c, lw=2.2)
        pct = 100 * (mv.p1 - mv.p0) / mv.p0
        a1.annotate(f"{pct:+.2f}%", (when(mv.end), mv.p1), color=c, fontsize=8, ha="center", va="bottom" if mv.dir == "UP" else "top")
        if mv.known > 0:
            a1.axvline(when(mv.known), color=c, lw=0.6, ls=":")
    a1.set_title(f"{symbol} · moves at zoom k={k} (green up, red down; dotted = when it became known live) · {tz_name()}")
    oo = oi[oi.index >= since]
    a2.plot([when(x) for x in oo.index], oo.values, color="#4575b4", lw=1)
    a2.set_ylabel("OI")
    a2.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d %H:%M"))
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="BTCUSDT")
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--k", default="1", help="zoom levels: multiples of the 1h ATR, e.g. 0.5,1,2")
    ap.add_argument("--tz", type=float, default=0, help="hours from UTC for printed times (0 = UTC, 4 = Yerevan)")
    ap.add_argument("--plot-k", type=float, default=None, help="which zoom to draw (default: the middle one)")
    ap.add_argument("--out", default=os.path.expanduser("~/research-out"))
    a = ap.parse_args()
    set_tz(a.tz)
    ks = [float(x) for x in a.k.split(",")]
    now = int(time.time() * 1000) // MIN * MIN
    since = now - int(a.hours * HOUR)
    warm = since - 3 * 24 * HOUR  # ATR warm-up + moves that started before the window
    h = klines(a.symbol, "1h", warm - 2 * 24 * HOUR, now)
    m = klines(a.symbol, "1m", warm, now)
    oi = open_interest(a.symbol, since - 24 * HOUR, now)
    h["atr"] = atr_wilder(h)
    t, hi, lo = m["t"].to_numpy(), m["high"].to_numpy(), m["low"].to_numpy()
    os.makedirs(a.out, exist_ok=True)
    plot_k = a.plot_k if a.plot_k is not None else ks[len(ks) // 2]
    atr_now = float(h["atr"].iloc[-1])
    print(f"{a.symbol} · last {a.hours:g}h · 1-minute candles · 1h ATR(14) now {atr_now:,.1f} ({100 * atr_now / m['close'].iloc[-1]:.2f}% of price)")
    print("columns: start/end = the real extremes · known_at = when it was confirmed live · wait_min = minutes from the end to that moment · size_ATR = move / 1h-ATR · "
          "late_% = how far the price had already come back when it became known · OI_% = BTC OI start -> end")
    for k in ks:
        th = threshold_at(t, h["t"].to_numpy(), h["atr"].to_numpy(), k)
        moves = directional_change(t, hi, lo, th)
        df = report(a.symbol, k, moves, atr_now, oi, since)
        tag = datetime.fromtimestamp(now / 1000, TZ).strftime("%Y%m%d-%H%M")
        if not df.empty:
            df.to_csv(os.path.join(a.out, f"dc_{a.symbol}_k{k:g}_{tag}.csv"), index=False)
        if k == plot_k:
            p = os.path.join(a.out, f"dc_{a.symbol}_k{k:g}_{tag}.png")
            chart(p, a.symbol, m, oi, moves, k, since)
            print(f"   chart: {p}")


if __name__ == "__main__":
    main()
