"""TradingView built-in ZigZag replica (Price deviation %, Pivot legs). Research copy, 2026-10-16.
Pivot legs L -> half = L//2 bars each side. Pivot high at bar i: high[i] > max(high[i-half:i]) and high[i] >= max(high[i+1:i+half+1]).
Pivot low mirrored. A pivot at bar i becomes KNOWN at the close of bar i+half (no look-ahead: known_i = i+half).
Processing in order of known time: vs last zigzag point -> same type & more extreme: replace; opposite type & |p/last-1|>=dev: append; else ignore.
A point is FINAL when the next opposite point is appended (final_i = known_i of that next point)."""
import numpy as np

def zigzag(high, low, dev=5.0, legs=10):
    h = legs // 2; n = len(high); pts = []  # dict(i, price, typ 'H'/'L', known_i, final_i)
    for k in range(h, n):           # at close of bar k we learn about pivot candidate i = k-h
        i = k - h
        if i - h < 0: continue
        cands = []
        if high[i] > high[i-h:i].max() and high[i] >= high[i+1:k+1].max(): cands.append(('H', high[i]))
        if low[i] < low[i-h:i].min() and low[i] <= low[i+1:k+1].min(): cands.append(('L', low[i]))
        for typ, p in cands:
            if not pts: pts.append(dict(i=i, price=p, typ=typ, known_i=k, final_i=None)); continue
            last = pts[-1]
            if last['typ'] == typ:
                if (typ == 'H' and p > last['price']) or (typ == 'L' and p < last['price']):
                    last.update(i=i, price=p, known_i=k)
            elif abs(p / last['price'] - 1) * 100 >= dev:
                last['final_i'] = k
                pts.append(dict(i=i, price=p, typ=typ, known_i=k, final_i=None))
    return pts
