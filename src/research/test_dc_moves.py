"""Tests for dc_moves.py (no network). Run: python research/py/test_dc_moves.py"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_moves import HOUR, MIN, atr_wilder, directional_change, threshold_at

passed = failed = 0
def scenario(name, fn):
    global passed, failed
    try:
        fn(); passed += 1; print(f"  ✓ {name}")
    except AssertionError as e:
        failed += 1; print(f"  ✗ {name}\n      {e}")

def path(prices):
    p = np.array(prices, float)
    t = np.arange(len(p)) * MIN
    return t, p + 0.1, p - 0.1  # high / low around the price

def test_up_down():
    # 100 -> 110 (up 10), -> 104 (down 6), -> 112 (up 8); threshold 3
    pr = list(np.linspace(100, 110, 11)) + list(np.linspace(109, 104, 6)) + list(np.linspace(105, 112, 8))
    t, hi, lo = path(pr)
    mv = directional_change(t, hi, lo, np.full(len(t), 3.0))
    dirs = [m.dir for m in mv]
    assert dirs[:3] == ["UP", "DOWN", "UP"], dirs
    up = mv[0]
    assert abs(up.p1 - 110.1) < 1e-9 and up.end == 10 * MIN, (up.p1, up.end)
    # confirmed only when the price came back >= 3 from 110.1: low <= 107.1 -> price 107 (index 13)
    assert up.known == 13 * MIN + MIN, up.known
    assert mv[-1].known == -1  # the last one is still going

def test_small_wiggles_ignored():
    pr = [100 + 0.5 * np.sin(i) for i in range(200)]
    t, hi, lo = path(pr)
    assert directional_change(t, hi, lo, np.full(len(t), 3.0)) == []

def test_no_lookahead():
    pr = list(np.linspace(100, 110, 11)) + list(np.linspace(109, 104, 6)) + list(np.linspace(105, 112, 8))
    t, hi, lo = path(pr)
    th = np.full(len(t), 3.0)
    full = directional_change(t, hi, lo, th)
    cut = directional_change(t[:15], hi[:15], lo[:15], th[:15])
    assert cut[0] == full[0], (cut[0], full[0])  # the confirmed first move is identical with less data

def test_threshold_uses_closed_hours_only():
    h_t = np.array([0, HOUR, 2 * HOUR])
    atr = np.array([10.0, 20.0, 30.0])
    m_t = np.array([HOUR - MIN, HOUR, 2 * HOUR + 5 * MIN])
    th = threshold_at(m_t, h_t, atr, 2.0)
    # minute before the first hour closed: nothing known; at 1h: hour 0 closed (10); at 2h05: hour 1 closed (20)
    assert np.isnan(th[0]) and th[1] == 20.0 and th[2] == 40.0, th

def test_atr():
    h = pd.DataFrame({"high": [11.0] * 30, "low": [9.0] * 30, "close": [10.0] * 30})
    a = atr_wilder(h, 14)
    assert np.isnan(a.iloc[12]) and abs(a.iloc[-1] - 2.0) < 1e-9

for n, f in list(globals().items()):
    if n.startswith("test_"):
        scenario(n, f)
print(f"\nRESULTS: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
