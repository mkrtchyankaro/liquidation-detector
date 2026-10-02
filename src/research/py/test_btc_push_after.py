"""Tests for btc_push_after.py (no network). Run: python src/research/py/test_btc_push_after.py"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from btc_push_after import after, beta_before, price_at  # noqa: E402
from dc_moves import HOUR, MIN  # noqa: E402

passed = failed = 0
def scenario(name, fn):
    global passed, failed
    try:
        fn(); passed += 1; print(f"  ✓ {name}")
    except AssertionError as e:
        failed += 1; print(f"  ✗ {name}\n      {e}")

rng = np.random.default_rng(7)
n = 30 * 60
t = np.arange(n) * MIN
rb = rng.normal(0, 0.001, n)
btc = pd.DataFrame({"t": t, "close": 100 * np.cumprod(1 + rb)})

def test_price_at_uses_closed_candles():
    # at ts the candle starting at ts is not closed yet -> the one before
    assert price_at(btc, 10 * MIN) == btc["close"].iloc[9]

def test_beta_from_before_only():
    coin = pd.DataFrame({"t": t, "close": 50 * np.cumprod(1 + np.r_[2 * rb[:1500], rng.normal(0, 0.01, n - 1500)])})
    b = beta_before(coin, btc, 1500 * MIN, 24)
    assert abs(b - 2) < 0.05, b  # the wild part after the start is not used

def test_after_signs():
    # coin = 2 x BTC, then after 'known' the coin drops 1% while BTC is flat: an UP mover that came back
    rc = 2 * rb.copy()
    known = 1600
    rb2 = rb.copy(); rb2[known:known + 60] = 0
    rc[known:known + 60] = 0; rc[known + 10] = -0.01
    b = pd.DataFrame({"t": t, "close": 100 * np.cumprod(1 + rb2)})
    c = pd.DataFrame({"t": t, "close": 50 * np.cumprod(1 + rc)})
    coin_pct, vs = after(c, b, known * MIN, 1, +1.0, 2.0)
    assert coin_pct < -0.9 and vs < -0.9, (coin_pct, vs)
    coin_pct, vs = after(c, b, known * MIN, 1, -1.0, 2.0)  # same path for a DOWN mover = it went on
    assert coin_pct > 0.9 and vs > 0.9

def test_after_missing_data():
    assert np.isnan(after(btc, btc, (n - 10) * MIN, 4, 1.0, 1.0)[0])

for nm, f in list(globals().items()):
    if nm.startswith("test_"):
        scenario(nm, f)
print(f"\nRESULTS: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
