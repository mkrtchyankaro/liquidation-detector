"""From the scenario books to a map: densities, layers, reachable zones, quality.  All USD here is MODEL output."""
import numpy as np, pandas as pd
from .config import MEMORY, SHORTMEM, scen_name, STEP_PCT, RANGE_PCT
from .update import load_book, load_raw, load_meta
EDGES = np.arange(-RANGE_PCT, RANGE_PCT + 1e-9, STEP_PCT); LO = EDGES[:-1]
def dens(snap, ref, old_h=None, now_min=None):
    m = snap['LV'] > 0
    if old_h is not None: m &= (now_min - snap['BT']) / 60.0 >= old_h
    rel = (snap['LP'][m] / ref - 1) * 100; usd = snap['A'][m] * snap['LP'][m]; sd = snap['SD'][m]
    return np.histogram(rel[sd == 1], EDGES, weights=usd[sd == 1])[0], np.histogram(rel[sd == -1], EDGES, weights=usd[sd == -1])[0]
def coin_maps(sym):
    raw = load_raw(sym); meta = load_meta(sym)
    if meta is None or not len(raw): return None
    ref = float(raw.close.iloc[-1]); now_min = int(raw.index.max()) + 5
    L, S, OL, OS, mapped, inv = [], [], [], [], [], 0
    for sc in MEMORY:
        b = load_book(sym, sc); sn = b.snapshot(ref); a, z = dens(sn, ref); oa, oz = dens(sn, ref, 24, now_min)
        L.append(a); S.append(z); OL.append(oa); OS.append(oz); mapped.append(sn['A'].sum() / 2 / sn['oi']); inv += b.inv_bad
    WL, WS = [], []
    for sc in SHORTMEM:
        b = load_book(sym, sc); sn = b.snapshot(ref); a, z = dens(sn, ref); WL.append(a); WS.append(z); inv += b.inv_bad
    return dict(sym=sym, ref=ref, now_min=now_min, L=np.array(L), S=np.array(S), OL=np.array(OL), OS=np.array(OS), WL=np.array(WL), WS=np.array(WS),
                mapped=float(np.median(mapped)), inv=inv, raw=raw, meta=meta)
def quality(mp, wall_now_min):
    raw, meta = mp['raw'], mp['meta']; last = int(raw.index.max()); r24 = raw[raw.index >= last + 5 - 1440]
    f = meta.get('fetch', {}) or {}
    return dict(last_bar_end_min=last + 5, map_lag_min=wall_now_min - (last + 5), last_kline_min=f.get('last_kline'), last_oi_min=f.get('last_oi'),
                last_db_minute=f.get('last_minute'), pending_bars=f.get('pending'), liq_coverage_24h=float(r24.liq_minutes.sum() / (5 * len(r24))) if len(r24) else np.nan,
                oi_flags_24h=int((r24.oi_flag.fillna('').astype(str) != '').sum()), oi_missing_24h=int(r24.oi_close.isna().sum()),
                history_days=round((last + 5 - meta['bootstrap_start']) / 1440, 1), mapped_share=mp['mapped'], invariant_violations=mp['inv'],
                db_vs_api_oi_median_pct=float((r24.db_oi_end / r24.oi_close - 1).abs().median() * 100) if r24.db_oi_end.notna().any() else None)
BAND = 0.5
def layers(mp, price_now):
    """0.5 % bands outward from the map price, per side, with consensus (median of 27), range, presence, age, 24h-map agreement,
    and the RECORDED liquidations of the last 24h at those prices (observed, separate)."""
    ref = mp['ref']; raw = mp['raw']; r24 = raw[raw.index >= raw.index.max() + 5 - 1440]; out = []
    for side, D, O, W, col, pcol in (('LONG', mp['L'], mp['OL'], mp['WL'], 'liqL', 'liqL_px'), ('SHORT', mp['S'], mp['OS'], mp['WS'], 'liqS', 'liqS_px')):
        sgn = -1 if side == 'LONG' else 1; nb = int(RANGE_PCT / BAND); per = int(BAND / STEP_PCT)
        bands = []
        for k in range(nb):
            a, z = (k * BAND, (k + 1) * BAND)
            sel = ((LO >= -z) & (LO + STEP_PCT <= -a)) if side == 'LONG' else ((LO >= a) & (LO + STEP_PCT <= z))
            v = D[:, sel].sum(1); o = np.median(O[:, sel].sum(1)); w = W[:, sel].sum(1)
            bands.append((a, z, v, o, w))
        side_max = np.array([b[2] for b in bands]).max(0)          # per scenario, its own largest band
        cons = np.array([np.median(b[2]) for b in bands]); cmax = cons.max() if cons.max() > 0 else 1
        wmax = np.array([b[4] for b in bands]).max(0)
        for (a, z, v, o, w), c in zip(bands, cons):
            lo_px, hi_px = (ref * (1 - z / 100), ref * (1 - a / 100)) if side == 'LONG' else (ref * (1 + a / 100), ref * (1 + z / 100))
            presence = float(np.mean(v >= 0.25 * np.maximum(side_max, 1e-9)))
            w_ok = bool(np.median(w) >= 0.25 * np.median(wmax)) if np.median(wmax) > 0 else False
            rec = r24[(r24[pcol] >= lo_px) & (r24[pcol] <= hi_px)][col].sum() if pcol in r24 else 0.0
            sig = bool(c >= 0.25 * cmax and presence >= 0.67 and c > 0)
            conf = 'HIGH' if (presence >= 0.85 and w_ok and (o / c if c > 0 else 1) < 0.5) else ('MEDIUM' if presence >= 0.67 else 'LOW')
            near = hi_px if side == 'LONG' else lo_px
            out.append(dict(side=side, band=f'{a:.1f}-{z:.1f}%', lo_px=lo_px, hi_px=hi_px, dist_now_pct=(near / price_now - 1) * 100, usd_med=float(c), usd_min=float(v.min()),
                            usd_max=float(v.max()), presence=presence, old_share=float(o / c) if c > 0 else np.nan, w24_agrees=w_ok, significant=sig, confidence=conf if c > 0 else '-',
                            recorded_liq_24h_usd=float(rec)))
    T = pd.DataFrame(out); T['rank_in_side'] = T.groupby('side').usd_med.rank(ascending=False, method='first').astype(int)
    return T
def zone(arr, side, dmin, dmax_edge, width=4):
    best = (np.nan, np.nan, 0.0)
    for i in range(len(LO) - width + 1):
        a, z = LO[i], LO[i] + width * STEP_PCT
        if side == 'LONG':
            if z > 0: continue
            near = -z
        else:
            if a < 0: continue
            near = a
        if near < dmin or near > dmax_edge: continue
        m = arr[i:i + width].sum()
        if m > best[2]: best = (a, z, m)
    return best
