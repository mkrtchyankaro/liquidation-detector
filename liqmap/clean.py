"""Causal 5m OI cleaner (same rules as solpos2/oi_clean.py, applied bar by bar):
R1 impossible step: |dOI| x close > bar quote volume -> dOI := 0 and remembered for 24h;
R2 reversal: a later bar within 24h with opposite sign, |size| within +-20 % of a remembered R1 step and >= 5 x the median |dOI| -> dOI := 0.
The median |dOI| is the median over the whole history fed so far (research used the full window; see README for the tiny difference)."""
import numpy as np
class OiCleaner:
    def __init__(self, pending=None, absd=None):
        self.pending = pending or []           # list of [t_min, size]
        self.absd = absd or []                 # |dOI| history (rounded sample, for the median)
    def step(self, t_min, d, close, qv):
        flag = ''
        if not np.isfinite(d): return np.nan, 'missing'
        self.pending = [p for p in self.pending if t_min - p[0] <= 1440]
        med = float(np.median(self.absd)) if self.absd else 0.0
        if abs(d) * close > qv: flag = 'R1_impossible'; self.pending.append([t_min, d])
        else:
            for p in self.pending:
                if t_min > p[0] and np.sign(d) == -np.sign(p[1]) and abs(abs(d) / abs(p[1]) - 1) <= 0.2 and abs(d) >= 5 * med:
                    flag = 'R2_reversal'; self.pending.remove(p); break
        self.absd.append(abs(d))
        if len(self.absd) > 20000: self.absd = self.absd[-20000:]
        return (0.0 if flag else d), flag
