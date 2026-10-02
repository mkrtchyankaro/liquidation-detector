"""Tests for btc_coins.py (no network). Run: python src/research/py/test_btc_coins.py"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from btc_coins import oi_pct, window_stats  # noqa: E402
from dc_moves import MIN  # noqa: E402

passed = failed = 0
def scenario(name, fn):
    global passed, failed
    try:
        fn(); passed += 1; print(f"  ✓ {name}")
    except AssertionError as e:
        failed += 1; print(f"  ✗ {name}\n      {e}")

rng = np.random.default_rng(3)
r = rng.normal(0, 0.001, 200)
t = np.arange(201) * MIN
btc = pd.DataFrame({"t": t, "close": 100 * np.cumprod(np.r_[1, 1 + r])})

def test_follower():
    coin = pd.DataFrame({"t": t, "close": 50 * np.cumprod(np.r_[1, 1 + 1.5 * r])})
    s = window_stats(coin, btc, 0, 200 * MIN)
    assert s["follow"] > 0.99 and abs(s["x_BTC"] - 1.5) < 0.1, s

def test_independent():
    coin = pd.DataFrame({"t": t, "close": 50 * np.cumprod(np.r_[1, 1 + rng.normal(0, 0.001, 200)])})
    assert window_stats(coin, btc, 0, 200 * MIN)["follow"] < 0.2

def test_window_only():
    # outside the window the coin is random, inside it follows -> follow uses the window only
    rr = np.r_[rng.normal(0, 0.001, 100), r[100:]]
    coin = pd.DataFrame({"t": t, "close": 50 * np.cumprod(np.r_[1, 1 + rr])})
    assert window_stats(coin, btc, 101 * MIN, 200 * MIN)["follow"] > 0.99

def test_oi():
    oi = pd.Series([100.0, 98.0, 97.0], index=[0, 5 * MIN, 10 * MIN])
    assert abs(oi_pct(oi, 0, 10 * MIN) + 3) < 1e-9
    assert np.isnan(oi_pct(pd.Series(dtype=float), 0, MIN))

for n, f in list(globals().items()):
    if n.startswith("test_"):
        scenario(n, f)
print(f"\nRESULTS: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
