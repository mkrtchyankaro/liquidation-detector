"""v3 vintage position book, RESUMABLE.  Same rules as the research engine solpos3/vbook.py (2026-10-17):
crossings -> price-compatible real-liquidation attribution -> OI accounting (removed = max(crossed, real, -dOI), added = dOI + removed)
-> voluntary closes by close order (P / YF / OF) -> churn -> openings at the bar typical price; H = 0.5 never liquidates.
Every number it holds is a MODEL estimate; only the inputs (price, OI, recorded liquidations) are observed.
Differences to the research code: state can be saved/loaded and fed bar by bar; birth time is absolute (minutes since epoch);
compaction runs when a bar ends at 00:00 UTC (identical to the research run, which started at 00:00); no per-vintage ledger."""
import numpy as np
MIXES = {'M1': ([10, 20, 50], [1/3, 1/3, 1/3]), 'M2': ([5, 10, 20, 50], [.4, .3, .2, .1]), 'M3': ([10, 25, 50, 75], [.2, .3, .3, .2])}
MM, H, TAU_H, COMPAT = 0.005, 0.5, 24.0, 0.01
def liq_price(e, side, L):
    return np.where(side == 1, e * (1 - 1 / L) / (1 - MM), e * (1 + 1 / L) / (1 + MM))
def waterfill(A, w, R):
    rem = np.zeros_like(A); R = float(R); act = (A > 0) & (w > 0)
    for _ in range(30):
        if R <= 1e-12 or not act.any(): break
        aw = A[act] * w[act] - rem[act] * w[act]; s = aw.sum()
        if s <= 0: break
        k = R / s; take = np.minimum(aw * k, A[act] - rem[act]); rem[act] += take; R -= take.sum()
        act = act & (rem < A - 1e-15)
    return rem

class Book:
    FIELDS = ('BT', 'SD', 'E', 'LV', 'LP', 'A')
    def __init__(self, mix='M1', order='P', churn=0.0, window_h=None, H=H):
        self.mix, self.order, self.churn, self.window_h, self.H = mix, order, churn, window_h, H
        self.BT = np.zeros(0, np.int64); self.SD = np.zeros(0, np.int8); self.E = np.zeros(0); self.LV = np.zeros(0); self.LP = np.zeros(0); self.A = np.zeros(0)
        self.leg = {1: 0.0, -1: 0.0}; self.oi = None; self.t0_min = None; self.last_bar_min = None; self.inv_bad = 0; self.bars = 0
    # ---------------- persistence
    def to_dict(self):
        d = {f: getattr(self, f) for f in self.FIELDS}
        d['meta'] = np.array([self.leg[1], self.leg[-1], self.oi if self.oi is not None else np.nan, self.t0_min or 0, self.last_bar_min or 0, self.inv_bad, self.bars,
                              self.churn, self.window_h or 0, self.H], dtype=np.float64)
        d['cfg'] = np.array([self.mix, self.order]); return d
    @classmethod
    def from_dict(cls, d):
        meta = d['meta']; mix, order = [str(x) for x in d['cfg']]
        b = cls(mix, order, float(meta[7]), int(meta[8]) or None, float(meta[9]))
        for f in cls.FIELDS: setattr(b, f, d[f].copy())
        b.leg = {1: float(meta[0]), -1: float(meta[1])}; b.oi = None if np.isnan(meta[2]) else float(meta[2]); b.t0_min = int(meta[3]) or None
        b.last_bar_min = int(meta[4]) or None; b.inv_bad = int(meta[5]); b.bars = int(meta[6]); return b
    def start(self, oi_start, t0_min):
        self.leg = {1: float(oi_start), -1: float(oi_start)}; self.oi = float(oi_start); self.t0_min = int(t0_min)
    # ---------------- one closed 5m bar
    def step(self, t_min, o, h, l, c, qv, tb, d, rL, rS, pL, pS):
        """t_min: bar OPEN time in minutes since epoch; d: cleaned dOI (contracts) over the bar; rL/rS real liquidation USD; pL/pS their price."""
        if self.last_bar_min is not None and t_min <= self.last_bar_min: raise ValueError('bar out of order')
        levs, wts = MIXES[self.mix]; levs = np.array(levs, float); wts = np.array(wts); nl = len(levs)
        BT, SD, E, LV, LP, A, leg = self.BT, self.SD, self.E, self.LV, self.LP, self.A, self.leg
        d = 0.0 if not np.isfinite(d) else d
        age_h = (t_min - BT) / 60.0
        hit = (LV > 0) & (A > 0) & (((SD == 1) & (l <= LP)) | ((SD == -1) & (h >= LP)))
        cross = {1: A[hit & (SD == 1)].sum(), -1: A[hit & (SD == -1)].sum()}
        cross_usd = {1: float((A[hit & (SD == 1)] * LP[hit & (SD == 1)]).sum()), -1: float((A[hit & (SD == -1)] * LP[hit & (SD == -1)]).sum())}
        A = np.where(hit, 0.0, A)
        real = {1: rL / c, -1: rS / c}; rpx = {1: pL if np.isfinite(pL) and pL > 0 else l, -1: pS if np.isfinite(pS) and pS > 0 else h}
        s_dir = np.sign(c - o) if abs(c / o - 1) >= 0.0005 else (np.sign(2 * tb - qv) if abs(2 * tb - qv) / max(qv, 1) >= 0.05 else 0)
        added = {}
        for X in (1, -1):
            removed = max(cross[X], real[X], max(0.0, -d)); added[X] = d + removed
            extra = max(0.0, real[X] - cross[X])
            if extra > 0:
                m = (SD == X) & (LV > 0) & (A > 0) & (np.abs(LP / rpx[X] - 1) <= COMPAT)
                if m.any():
                    w = np.where(m, 1 - np.abs(LP / rpx[X] - 1) / COMPAT + 1e-6, 0.0); r = waterfill(A, w, extra); A = A - r; extra -= r.sum()
                if extra > 1e-12:
                    take = min(extra, leg[X]); leg[X] -= take; extra -= take
                if extra > 1e-12:
                    m = (SD == X) & (A > 0); r = waterfill(A, m.astype(float), extra); A = A - r
            vol = removed - cross[X] - max(0.0, real[X] - cross[X])
            ch = min(self.churn * qv / c, 0.02 * self.oi) if self.churn > 0 else 0.0
            for amount, kind in ((vol, 'vol'), (ch, 'churn')):
                if amount <= 1e-12: continue
                m = (SD == X) & (A > 0)
                if self.order == 'P': w = m.astype(float); wl = 1.0
                elif self.order == 'YF': w = np.where(m, np.exp(-age_h / TAU_H), 0.0); wl = np.exp(-(((t_min - self.t0_min) / 60.0) + 168) / TAU_H)
                else: w = np.where(m, 1 - np.exp(-age_h / TAU_H) + 0.02, 0.0); wl = 1.02
                AA = np.r_[A, leg[X]]; WW = np.r_[w, wl if leg[X] > 0 else 0.0]
                r = waterfill(AA, WW, amount); left = amount - r.sum()
                if left > 1e-12: r = r + waterfill(AA - r, np.r_[m.astype(float), 1.0 if leg[X] > 0 else 0.0], left)
                A = A - r[:-1]; leg[X] -= r[-1]
                if kind == 'churn': added[X] += amount
        tp = (h + l + c) / 3
        for X in (1, -1):
            if added[X] <= 1e-12: continue
            BT = np.r_[BT, np.full(nl + 1, t_min, np.int64)]; SD = np.r_[SD, np.full(nl + 1, X, np.int8)]; E = np.r_[E, np.full(nl + 1, tp)]
            LV = np.r_[LV, levs, 0.0]; LP = np.r_[LP, liq_price(np.full(nl, tp), np.full(nl, X), levs), np.nan]; A = np.r_[A, added[X] * (1 - self.H) * wts, added[X] * self.H]
        self.oi += d
        if self.window_h is not None and len(BT):
            old = ((t_min - BT) / 60.0 > self.window_h) & (A > 0)
            if old.any():
                for X in (1, -1): leg[X] += A[old & (SD == X)].sum()
                A = np.where(old, 0.0, A)
        bl = A[SD == 1].sum() + leg[1]; bs = A[SD == -1].sum() + leg[-1]
        if abs(bl - self.oi) > 1e-6 * self.oi or abs(bs - self.oi) > 1e-6 * self.oi or (A < -1e-9).any() or leg[1] < -1e-6 or leg[-1] < -1e-6: self.inv_bad += 1
        self.bars += 1
        if (t_min + 5) % 1440 == 0 and len(BT):          # bar ends at 00:00 UTC -> prune + compaction (same as research)
            k = A > 1e-12; BT, SD, E, LV, LP, A = BT[k], SD[k], E[k], LV[k], LP[k], A[k]
            old = (t_min - BT) / 60.0 > 24
            if old.sum() > 50:
                import pandas as pd
                rel = self.t0_min                                 # vintage day as in research (days since the start day)
                vday = ((BT[old] - (rel - rel % 1440)) // 1440)
                key = pd.DataFrame(dict(v=vday, s=SD[old], lv=LV[old], eb=np.round(np.log(E[old]) / 0.001).astype(np.int64), a=A[old], ea=A[old] * E[old], bi=BT[old] * A[old]))
                g = key.groupby(['v', 's', 'lv', 'eb'], sort=False).agg(a=('a', 'sum'), ea=('ea', 'sum'), bi=('bi', 'sum')).reset_index(); g = g[g.a > 0]
                nE = (g.ea / g.a).values; base = rel - rel % 1440
                nBT = (np.round((g.bi / g.a - base) / 5).astype(np.int64) * 5 + base).values   # bar units, as in research
                nLP = np.where(g.lv.values > 0, liq_price(nE, g.s.values, np.where(g.lv.values > 0, g.lv.values, 1)), np.nan)
                BT = np.r_[BT[~old], nBT]; SD = np.r_[SD[~old], g.s.values.astype(np.int8)]; E = np.r_[E[~old], nE]; LV = np.r_[LV[~old], g.lv.values]
                LP = np.r_[LP[~old], nLP]; A = np.r_[A[~old], g.a.values]
        self.BT, self.SD, self.E, self.LV, self.LP, self.A, self.leg = BT, SD, E, LV, LP, A, leg
        self.last_bar_min = t_min
        return cross_usd
    def snapshot(self, close):
        k = self.A > 1e-12
        return dict(BT=self.BT[k], SD=self.SD[k], E=self.E[k], LV=self.LV[k], LP=self.LP[k], A=self.A[k], close=close, leg_L=self.leg[1], leg_S=self.leg[-1], oi=self.oi,
                    t_min=self.last_bar_min + 5 if self.last_bar_min else None)
