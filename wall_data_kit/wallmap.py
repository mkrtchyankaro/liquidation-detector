"""WALL MAP v2 (2026-10-16). KIT COPY: only CUT (data cut) and OIDIR (OI archive folder) are configurable via env; all wall rules are byte-identical to zz/wallmap.py.
 Census only - no entries, no PnL. Data cut at 2026-10-01 00:00 UTC (October holdout untouched).
Zigzag: TradingView ZigZag 5 % / 10 legs on 4H (zigzag.py).  A zigzag point (touch) is KNOWN when its pivot is confirmed (5 bars)
AND price has moved >= 5 % away from it ('touched and came back').
Rules fixed BEFORE counting (user, 2026-10-16):
- Support walls from zigzag LOWS, resistance walls from HIGHS (mirrored by 1/price). Each wall lives on its own; several walls at once.
- Forming level: a new point joins an existing forming level if all its points stay within 3 % (max/min-1 <= 3 %); otherwise it starts a
  new level.  Zigzag points that do not reach a level (e.g. AVAX 6.745 on 07-05) are simply ignored by that level.
- WALL = level with 3 touches.  Zone = [min, max] of the first 3 touches and it is FIXED (never widens).
- BREAK = a 4H CLOSE beyond the wall edge by more than 1.5 % (support: close < low*(0.985)); the wall is closed at that close.
  A zigzag point beyond the edge without such a close = SWEEP (wall survives).
- APPROACH n (n = 4, 5, ...) = after the last touch is known, the first 4H bar whose low <= zone top (support) / high >= zone bottom.
  Its touch is added when the zigzag point of that leg becomes known.  Outcome of each approach: INSIDE / SWEEP / BREAK / OPEN_AT_END.
- Origin flag (descriptive): around the 1st touch, max 4H quote volume (bars i-1..i+1) >= 3x median of previous 180 bars AND OI
  (Binance archive, from 2025-08) up >= 15 % over 24h ending at the close of bar i+1."""
import pandas as pd, numpy as np, zigzag as ZG, os
MIN_T = int(os.environ.get('MIN_T', '3')); AGE = int(os.environ.get('AGE', '0')); CLEAN = os.environ.get('CLEAN', '0') == '1'
SUF = ('' if MIN_T == 3 else f'_t{MIN_T}') + ('_v3' if (AGE and CLEAN) else '_age' if AGE else '_clean' if CLEAN else '')
AGE_BARS = AGE * 6
FAR = float(os.environ.get('FAR', '0')) / 100.0
if FAR: SUF += f'_far{int(FAR*100)}'
ATRK = float(os.environ.get('ATRK', '0'))
if ATRK: SUF += f'_atr{ATRK:g}'
KL = os.environ.get('KLINES', '../fin/fin_export_202610150638/klines_4h.csv'); SUF += os.environ.get('XSUF', '')
ATRP = None
W_MAX, BRK, DEV = float(os.environ.get('WMAX', '0.03')), float(os.environ.get('BRKP', '0.015')), float(os.environ.get('ZZDEV', '5')) / 100
CUT = os.environ.get('CUT', '2026-10-01 00:00')   # kit: data cut is configurable (default = the research copy's cut); wall logic unchanged
d = pd.read_csv(KL); d = d[d.open_time_utc < CUT]
def yv(s): return (pd.Timestamp(s) + pd.Timedelta(hours=4)).strftime('%Y-%m-%d %H:%M')

def run_side(t, H, L, C, P, typ):
    """support logic on (lows); for resistance caller passes mirrored arrays (1/high as low etc.)."""
    pts = []
    for p in P:
        if p['typ'] != typ: continue
        i = p['i']; pr = L[i]
        kk = next((k for k in range(i, len(H)) if H[k] >= pr * (1 + DEV)), None)
        if kk is None: continue
        pts.append(dict(i=i, price=pr, kk=max(p['known_i'], kk)))
    by_k = {}
    for q in pts: by_k.setdefault(q['kk'], []).append(q)
    levels, walls_out, appr = [], [], []
    for k in range(len(H)):
        # 1) break check on this close
        for lv in levels:
            if lv['broken'] is not None: continue
            lo = min(x['price'] for x in lv['tp'][:MIN_T]) if lv['active'] is not None else min(x['price'] for x in lv['tp'])
            if C[k] < lo * (1 - BRK):
                lv['broken'] = k
                if lv.get('cur') is not None: lv['cur']['outcome'] = 'BREAK'; lv['cur']['break_i'] = k; lv['cur'] = None
        # 1b) v3: expiry - no touch for more than AGE days (forming levels and active walls without a running approach)
        if AGE_BARS:
            for lv in levels:
                if lv['broken'] is None and lv.get('cur') is None and k - lv['tp'][-1]['i'] > AGE_BARS:
                    lv['broken'] = k; lv['reason'] = 'EXPIRED'
        # 1c) FAR rule: the level/wall dies if price moves more than FAR away from it (away side) while no approach is running
        if FAR:
            for lv in levels:
                if lv['broken'] is None and lv.get('cur') is None:
                    top = lv['hi'] if lv['active'] is not None else max(x['price'] for x in lv['tp'])
                    if k > lv['tp'][-1]['i'] and H[k] >= top * (1 + FAR):
                        lv['broken'] = k; lv['reason'] = 'FAR'
        # 2) approach start for active walls
        for lv in levels:
            if lv['active'] is None or lv['broken'] is not None or lv.get('cur') is not None: continue
            if k > lv['last_kk'] and L[k] <= lv['hi']:
                ev = dict(lv=lv, n=len(lv['tp']) + 1, i=k, outcome='OPEN_AT_END', break_i=None, touch_price=None); lv['cur'] = ev; appr.append(ev)
        # 3) points known at this close
        for q in by_k.get(k, []):
            took = False
            for lv in levels:   # active wall waiting for this leg's touch
                if lv['active'] is None or lv['broken'] is not None or lv.get('cur') is None: continue
                if q['price'] <= lv['hi'] and q['i'] >= lv['cur']['i'] - 0:
                    ev = lv['cur']; ev['touch_price'] = q['price']; ev['outcome'] = 'INSIDE' if q['price'] >= lv['lo'] else 'SWEEP'
                    lv['tp'].append(q); lv['last_kk'] = q['kk']; lv['cur'] = None; took = True
            if took: continue
            for lv in levels:   # active wall touched without a recorded approach (approach bar already passed inside the same leg)
                if lv['active'] is None or lv['broken'] is not None: continue
                if lv['lo'] * 0 + q['price'] <= lv['hi'] and q['i'] > lv['tp'][-1]['i']:
                    lv['tp'].append(q); lv['last_kk'] = q['kk']; took = True
            if took: continue
            cand = [lv for lv in levels if lv['active'] is None and lv['broken'] is None and
                    max([x['price'] for x in lv['tp']] + [q['price']]) / min([x['price'] for x in lv['tp']] + [q['price']]) - 1 <= (ATRK * ATRP[k] if ATRK else W_MAX)]
            if CLEAN:   # v3: a same-type point BEYOND a forming level (lower low for support / higher high for resistance) kills that level
                for lv in levels:
                    if lv['active'] is None and lv['broken'] is None and lv not in cand and q['price'] < min(x['price'] for x in lv['tp']):
                        lv['broken'] = k; lv['reason'] = 'DIRTY'
            if cand:
                lv = max(cand, key=lambda v: (len(v['tp']), -abs(np.mean([x['price'] for x in v['tp']]) / q['price'] - 1)))
                lv['tp'].append(q)
                if len(lv['tp']) == MIN_T:
                    lv['active'] = q['kk']; lv['last_kk'] = q['kk']
                    lv['lo'] = min(x['price'] for x in lv['tp']); lv['hi'] = max(x['price'] for x in lv['tp'])
            else:
                levels.append(dict(tp=[q], active=None, broken=None, cur=None))
    return [lv for lv in levels if lv['active'] is not None], appr

O_CACHE = {}
def oi_series(coin):
    if coin not in O_CACHE:
        try:
            o = pd.read_csv(os.path.join(os.environ.get('OIDIR', '../ls/liqproxy/oi_archive/oi5m'), f'{coin}.csv')); o['t'] = pd.to_datetime(o.ts_ms // 1000 + 300, unit='s')   # kit: OI folder configurable
            O_CACHE[coin] = o.set_index('t').sum_open_interest.sort_index()
        except FileNotFoundError: O_CACHE[coin] = None
    return O_CACHE[coin]

WALLS, APPR, TOUCH = [], [], []
for c, s in d.groupby('symbol'):
    s = s.reset_index(drop=True); t = s.open_time_utc.values; tc = s.close_time_utc.values
    H, L, C, V = s.high.values, s.low.values, s.close.values, s.quote_volume.values
    P = ZG.zigzag(H, L, dev=DEV * 100); oi = oi_series(c)
    pc = np.roll(C, 1); pc[0] = C[0]; tr = np.maximum(H - L, np.maximum(abs(H - pc), abs(L - pc)))
    ATRP = (pd.Series(tr).ewm(alpha=1 / 14, adjust=False).mean().values / C)
    for side, typ, (h, l, cl), conv in (('SUPPORT', 'L', (H, L, C), lambda x: x), ('RESISTANCE', 'H', (1 / L, 1 / H, 1 / C), lambda x: 1 / x)):
        walls, appr = run_side(t, h, l, cl, P, typ)
        wid = {}
        for n, lv in enumerate(walls):
            i1 = lv['tp'][0]['i']; vr = V[max(0, i1 - 1):i1 + 2].max() / np.median(V[max(0, i1 - 181):max(1, i1 - 1)])
            oc = np.nan
            if oi is not None:
                te = pd.Timestamp(tc[min(i1 + 1, len(tc) - 1)]); a = oi.asof(te); b = oi.asof(te - pd.Timedelta(hours=24))
                if pd.notna(a) and pd.notna(b) and te - pd.Timedelta(hours=24) >= oi.index[0]: oc = a / b - 1
            lo, hi = sorted((conv(lv['lo']), conv(lv['hi'])))
            wid[id(lv)] = f'{c[:-4]}-{side[0]}{n:03d}'
            for m, q in enumerate(lv['tp'], 1):
                TOUCH.append(dict(wall_id=wid[id(lv)], coin=c, wall=side, touch_no=m, bar_UTC=t[q['i']], price=conv(q['price']), known_UTC=tc[q['kk']]))
            WALLS.append(dict(wall_id=wid[id(lv)], coin=c, wall=side, zone_low=lo, zone_high=hi, width_pct=round((hi / lo - 1) * 100, 2),
                              touch1_UTC=t[lv['tp'][0]['i']], touch1=conv(lv['tp'][0]['price']), touch2_UTC=t[lv['tp'][1]['i']], touch2=conv(lv['tp'][1]['price']),
                              touch3_UTC=t[lv['tp'][2]['i']] if len(lv['tp']) > 2 else '', touch3=conv(lv['tp'][2]['price']) if len(lv['tp']) > 2 else '', active_UTC=tc[lv['active']],
                              broken_UTC=tc[lv['broken']] if lv['broken'] is not None else '', end_reason=lv.get('reason', 'BREAK' if lv['broken'] is not None else ''), total_touches=len(lv['tp']),
                              days_touch1_to_3=round((lv['tp'][MIN_T-1]['i'] - lv['tp'][0]['i']) / 6, 1),
                              origin_vol_x=round(vr, 2), origin_oi_24h_pct=round(oc * 100, 1) if pd.notna(oc) else '',
                              origin_flag=bool(vr >= 3 and pd.notna(oc) and oc >= 0.15)))
        for ev in appr:
            lv = ev['lv']
            if id(lv) not in wid: continue
            APPR.append(dict(wall_id=wid[id(lv)], coin=c, wall=side, approach_no=ev['n'], approach_bar_UTC=t[ev['i']], approach_Yerevan=yv(t[ev['i']]),
                             zone_low=sorted((conv(lv['lo']), conv(lv['hi'])))[0], zone_high=sorted((conv(lv['lo']), conv(lv['hi'])))[1],
                             outcome=ev['outcome'], touch_price=conv(ev['touch_price']) if ev['touch_price'] is not None else '',
                             break_close_UTC=tc[ev['break_i']] if ev['break_i'] is not None else ''))
Wd = pd.DataFrame(WALLS); A = pd.DataFrame(APPR)
Wd.to_csv(f'wallmap_walls{SUF}.csv', index=False); pd.DataFrame(TOUCH).to_csv(f'wallmap_touches{SUF}.csv', index=False); A.to_csv(f'wallmap_approaches{SUF}.csv', index=False)
A12 = A[(A.approach_bar_UTC >= '2025-10-01') & (A.approach_bar_UTC < '2026-10-01')]
print('walls (active any time, incl. warm-up):', len(Wd), ' active in window:', (Wd.active_UTC >= '2025-10-01').sum())
print('approaches in window by number:'); print(A12.groupby(['approach_no']).size().to_string())
print(A12.groupby('wall').size().to_string()); print('coins', A12.coin.nunique())
print('4th approaches per coin:'); print(A12[A12.approach_no == MIN_T + 1].groupby('coin').size().to_string())
print(A12[A12.approach_no == MIN_T + 1].groupby(A12.approach_bar_UTC.str[:7]).size().to_string())
print('width of walls with a 4th approach:', A12[A12.approach_no==MIN_T+1].merge(Wd[['wall_id','width_pct','origin_flag']], on='wall_id').width_pct.describe().round(2).to_string())
print('origin flags among walls with 4th approach:', A12[A12.approach_no==MIN_T+1].merge(Wd[['wall_id','origin_flag']], on='wall_id').origin_flag.sum())
