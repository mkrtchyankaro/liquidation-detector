"""COIN VIEW and --best.  Text tables + optional PNG + a JSON snapshot of everything shown."""
import json, os, numpy as np, pandas as pd
from .config import HOME, COINS
from .maps import coin_maps, quality, layers, zone, LO, STEP_PCT
from .sources import from_min
RESEARCH_CAL = 'research calibration (23 alts, 10-05..10-16, n=552): predicted 0.16/0.37/0.52/0.69/0.87 -> realised 0.09/0.33/0.46/0.63/0.95'
def fmt_usd(x):
    return '-' if x is None or not np.isfinite(x) else (f'{x/1e6:.2f}M' if abs(x) >= 1e6 else f'{x/1e3:.0f}k')
def fmt_px(x): return f'{x:.6g}'
def ts(m): return '-' if m is None else from_min(m).strftime('%Y-%m-%d %H:%M')
def hourly(raw):
    h = raw.copy(); h['h'] = h.index - h.index % 60
    return h.groupby('h').agg(open=('open', 'first'), high=('high', 'max'), low=('low', 'min'), close=('close', 'last'), qv=('quote_volume', 'sum'))
def tdr_and_preach(raw, now_min):
    h = hourly(raw); h = h[h.index < now_min]
    d = h.copy(); d['d'] = d.index - d.index % 1440; dd = d[d.index >= now_min - 7 * 1440].groupby('d').agg(high=('high', 'max'), low=('low', 'min'), close=('close', 'last'))
    TDR = float(((dd.high - dd.low) / dd.close * 100).median()) if len(dd) else np.nan
    c = h.close.values; hi = h.high.values; lo = h.low.values; up = []; dn = []; starts = h.index.values
    for i in range(len(h) - 24):
        if starts[i] + 60 > now_min - 1440: break
        up.append((hi[i + 1:i + 25].max() / c[i] - 1) * 100); dn.append((1 - lo[i + 1:i + 25].min() / c[i]) * 100)
    vol = float(h[h.index >= now_min - 7 * 1440].qv.median()) if len(h) else np.nan
    return TDR, np.array(up), np.array(dn), vol
def save_snapshot(kind, payload):
    t = pd.Timestamp.now('UTC'); d = os.path.join(HOME, 'snapshots', t.strftime('%Y%m%d')); os.makedirs(d, exist_ok=True)
    f = os.path.join(d, f"{t.strftime('%H%M%S')}_{kind}.json"); json.dump(payload, open(f, 'w'), default=lambda o: o.item() if hasattr(o, 'item') else str(o)); return f

def coin_view(sym, wall_now_min, png=True, n_show=8):
    mp = coin_maps(sym)
    if mp is None: return f'{sym}: no state yet - run the update first.', None
    meta = mp['meta']; price_now = (meta.get('fetch') or {}).get('last_price') or mp['ref']
    Q = quality(mp, wall_now_min); T = layers(mp, price_now)
    lines = [f"=== {sym}   latest price {fmt_px(price_now)}   (map built at the close of the bar ending {ts(Q['last_bar_end_min'])} UTC, price there {fmt_px(mp['ref'])})",
             f"DATA  last 5m candle {ts(Q['last_kline_min'])} | last Binance OI point {ts(Q['last_oi_min'])} | last DB minute {ts(Q['last_db_minute'])} | "
             f"map lag {Q['map_lag_min']} min | bars waiting for OI {Q['pending_bars']}",
             f"      liquidation collector coverage 24h {Q['liq_coverage_24h']*100:.0f} % | OI corrections 24h {Q['oi_flags_24h']} | OI missing 24h {Q['oi_missing_24h']} | "
             f"history {Q['history_days']} d | OI with known entry {Q['mapped_share']*100:.0f} % | invariant violations {Q['invariant_violations']}"
             + (f" | DB vs Binance OI {Q['db_vs_api_oi_median_pct']:.3f} %" if Q['db_vs_api_oi_median_pct'] is not None else ''),
             'MODEL = possible liquidation levels of positions the model thinks are still open (median of 27 scenarios, [min-max]); NOT recorded events.',
             'RECORDED = liquidations really recorded by our collector in the last 24h at those prices.']
    warn = []
    if Q['liq_coverage_24h'] < 0.9: warn.append('liquidation collector incomplete in the last 24h')
    if Q['map_lag_min'] > 20: warn.append(f"map is {Q['map_lag_min']} min old")
    if Q['mapped_share'] < 0.3: warn.append('less than 30 % of OI has a known entry (young history)')
    if warn: lines.append('WARNING: ' + '; '.join(warn))
    for side, title in (('SHORT', 'ABOVE the price: SHORT liquidation levels (price going UP would hit them)'), ('LONG', 'BELOW the price: LONG liquidation levels (price going DOWN would hit them)')):
        t = T[T.side == side].copy(); sig = t[t.significant]
        lines.append(f'\n{title}')
        if sig.empty: lines.append('  no reliable layer within 12 % (no band passes: >= 25 % of the side maximum and present in >= 2/3 of scenarios)')
        t['cum_usd'] = t.usd_med.cumsum()
        top3 = set(t[t.usd_med > 0].sort_values('usd_med', ascending=False).head(3).index)
        show = t[((t.usd_med > 0) & (t.dist_now_pct.abs() <= 4.0)) | t.significant | t.index.isin(top3)]
        lines.append(f"  {'band':>10} {'price range':>23} {'to near edge':>12} {'model USD [min-max]':>24} {'cumulative':>10} {'present':>8} {'>24h old':>9} {'24h-map':>8} {'conf.':>7} {'recorded 24h':>13}")
        for _, r in show.iterrows():
            mark = ' *' if r.significant else ('  ' if r.name not in top3 else ' D')
            lines.append(f"{mark}{r.band:>10} {fmt_px(r.lo_px):>11}-{fmt_px(r.hi_px):<11} {r.dist_now_pct:+11.2f}% {fmt_usd(r.usd_med):>8} [{fmt_usd(r.usd_min)}-{fmt_usd(r.usd_max)}]".ljust(84)
                         + f" {fmt_usd(r.cum_usd):>10} {r.presence:7.2f} {('-' if not np.isfinite(r.old_share) else f'{r.old_share*100:.0f} %'):>9} {('yes' if r.w24_agrees else 'no'):>8} {r.confidence:>7} {fmt_usd(r.recorded_liq_24h_usd):>13}")
        top = t[t.usd_med > 0].sort_values('usd_med', ascending=False).head(3)
        if len(top): lines.append('  densest: ' + ' | '.join(f"{r.band} ({fmt_px(r.lo_px)}-{fmt_px(r.hi_px)}) {fmt_usd(r.usd_med)}" for _, r in top.iterrows()))
        if len(sig): lines.append('  sequence of reliable layers from the price outward: ' + ' -> '.join(f"{r.dist_now_pct:+.1f}% {fmt_usd(r.usd_med)}" for _, r in sig.iterrows()))
    lines.append('\n* = reliable layer (>= 25 % of the side maximum in >= 2/3 of the scenarios); D = among the 3 densest; cumulative = model USD from the price out to that band.  Amounts are model estimates whose absolute size depends on assumptions (leverage mix, hedged share); compare layers, not dollars.')
    snap = dict(kind='coin', sym=sym, wall_now=ts(wall_now_min), price_now=price_now, map_ref=mp['ref'], quality=Q, layers=T.to_dict('records'))
    f = save_snapshot(f'coin_{sym}', snap); lines.append(f'snapshot: {f}')
    pngf = None
    if png:
        try: pngf = coin_png(sym, mp, T, price_now)
        except Exception as e: lines.append(f'(PNG skipped: {e})')
        if pngf: lines.append(f'chart: {pngf}')
    return '\n'.join(lines), snap

def coin_png(sym, mp, T, price_now):
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    raw = mp['raw']; x = raw[raw.index >= raw.index.max() - 3 * 1440]; tt = pd.to_datetime(x.index * 60, unit='s')
    fig, (a0, a1) = plt.subplots(1, 2, figsize=(13, 6.5), width_ratios=[2.3, 1.2], sharey=True)
    a0.plot(tt, x.close, color='#1f1f1d', lw=1); a0.axhline(price_now, color='#1f1f1d', ls='--', lw=0.6)
    for col, pcol, colr in (('liqL', 'liqL_px', '#eb6834'), ('liqS', 'liqS_px', '#2a78d6')):
        m = x[col] > x[col].quantile(0.97)
        if m.any(): a0.scatter(pd.to_datetime(x.index[m] * 60, unit='s'), x[pcol][m].fillna(x.close[m]), s=np.clip(x[col][m] / x[col].max() * 90, 6, 90), color=colr, alpha=0.8, label=f'recorded {col[-1]} liq')
    a0.set_title(f'{sym}  last 3 days (5m), recorded liquidations as dots'); a0.legend(frameon=False, fontsize=7); a0.grid(color='#e6e4df', lw=0.5)
    for _, r in T.iterrows():
        v = r.usd_med / 1e6 * (-1 if r.side == 'LONG' else 1); colr = '#eb6834' if r.side == 'LONG' else '#2a78d6'
        a1.barh((r.lo_px + r.hi_px) / 2, v, height=(r.hi_px - r.lo_px) * 0.9, color=colr, alpha=0.9 if r.significant else 0.35)
        if r.usd_max > 0: a1.plot([np.sign(v) * r.usd_min / 1e6, np.sign(v) * r.usd_max / 1e6], [(r.lo_px + r.hi_px) / 2] * 2, color='#1f1f1d', lw=0.6)
    a1.axhline(price_now, color='#1f1f1d', ls='--', lw=0.6); a1.axvline(0, color='#77756f', lw=0.5)
    a1.set_title('MODEL liquidation levels, 0.5 % bands, M$\nLONG left / SHORT right, dark = reliable,\nline = min-max of 27 scenarios', fontsize=9); a1.grid(color='#e6e4df', lw=0.5)
    lo = min(T.lo_px.min(), x.low.min()); hi = max(T.hi_px.max(), x.high.max()); a0.set_ylim(max(lo, price_now * 0.88), min(hi, price_now * 1.12))
    d = os.path.join(HOME, 'charts'); os.makedirs(d, exist_ok=True); f = os.path.join(d, f"{sym}_{pd.Timestamp.now('UTC').strftime('%Y%m%d_%H%M')}.png")
    fig.tight_layout(); fig.savefig(f, dpi=100); plt.close(fig); return f

def best(wall_now_min, coins=COINS, k=2):
    rows = []
    for sym in coins:
        mp = coin_maps(sym)
        if mp is None: continue
        Q = quality(mp, wall_now_min); raw = mp['raw']; now_min = mp['now_min']; price_now = (mp['meta'].get('fetch') or {}).get('last_price') or mp['ref']
        TDR, up, dn, hv = tdr_and_preach(raw, now_min)
        q_ok = (Q['liq_coverage_24h'] >= 0.9) and (Q['oi_flags_24h'] <= 3) and (Q['mapped_share'] >= 0.30) and (Q['map_lag_min'] <= 30)
        cL = np.median(mp['L'], 0); cS = np.median(mp['S'], 0); wL = np.median(mp['WL'], 0); wS = np.median(mp['WS'], 0)
        m04L = cL[(LO >= -4) & (LO + STEP_PCT <= 0)].sum(); m04S = cS[(LO >= 0) & (LO + STEP_PCT <= 4)].sum()
        T = layers(mp, price_now)
        for side, arr, W, X, O in (('LONG', cL, wL, mp['L'], mp['OL']), ('SHORT', cS, wS, mp['S'], mp['OS'])):
            z = zone(arr, side, 0.25, TDR) if np.isfinite(TDR) else (np.nan, np.nan, 0.0)
            if not np.isfinite(z[0]): rows.append(dict(sym=sym, side=side, eligible=False, why_not='no reachable zone')); continue
            cen = (z[0] + z[1]) / 2; cens = [np.mean(zone(X[i], side, 0.25, TDR)[:2]) for i in range(len(X))]
            rob = float(np.mean([abs(c - cen) <= 0.75 for c in cens if np.isfinite(c)]))
            near = -z[1] if side == 'LONG' else z[0]; ex = dn if side == 'LONG' else up; pr = float(np.mean(ex >= near)) if len(ex) else np.nan
            asym = (m04L / m04S if side == 'LONG' else m04S / m04L) if min(m04L, m04S) > 0 else np.inf
            wz = zone(W, side, 0.25, TDR); agree = bool(np.isfinite(wz[0]) and abs((wz[0] + wz[1]) / 2 - cen) <= 0.75)
            sel = (LO >= z[0]) & (LO < z[1]); zr = X[:, sel].sum(1); old = np.median(O[:, sel].sum(1))
            behind = T[(T.side == side) & T.significant & ((T.lo_px < mp['ref'] * (1 + z[0] / 100)) if side == 'LONG' else (T.hi_px > mp['ref'] * (1 + z[1] / 100)))]
            behind = behind[behind.dist_now_pct.abs() <= abs(near) + TDR]
            why = [] if q_ok else ['data quality']
            if rob < 0.67: why.append('zone location not robust')
            if asym < 1.5: why.append('other side as heavy (asymmetry < 1.5)')
            rows.append(dict(sym=sym, side=side, dir='DOWN' if side == 'LONG' else 'UP', price_now=price_now, map_ref=mp['ref'],
                             zone_lo=mp['ref'] * (1 + z[0] / 100), zone_hi=mp['ref'] * (1 + z[1] / 100), dist_pct=near, dist_tdr=near / TDR, TDR=TDR,
                             zone_usd=z[2], zone_usd_min=float(zr.min()), zone_usd_max=float(zr.max()), opposite_0_4=(m04S if side == 'LONG' else m04L), asym=asym, robustness=rob,
                             old_share=old / z[2] if z[2] > 0 else np.nan, w24_agrees=agree, p_reach=pr, fuel=z[2] / hv if hv > 0 else np.nan,
                             layers_behind=len(behind), usd_behind=float(behind.usd_med.sum()), quality_ok=q_ok, eligible=not why, why_not='; '.join(why), quality=Q))
    R = pd.DataFrame(rows)
    E = R[R.eligible].copy() if len(R) and 'eligible' in R else R
    lines = [f"=== BEST liquidation structures now ({ts(wall_now_min)} UTC).  NOT a direction forecast: it says where a move WOULD meet the most model liquidations, and how often",
             f"    each coin has historically moved that far within 24h.  {RESEARCH_CAL}.  Live calibration: see --evaluate."]
    picks = []
    if len(E):
        E['fuel_pct'] = E.fuel.rank(pct=True); E['score'] = E.p_reach * (0.5 + 0.5 * E.fuel_pct)
        for side, title in (('LONG', 'DOWN side (LONG liquidations below the price)'), ('SHORT', 'UP side (SHORT liquidations above the price)')):
            s = E[(E.side == side) & (E.p_reach >= 0.30)].sort_values('score', ascending=False).head(k)
            lines.append(f'\n{title}:')
            if s.empty: lines.append('  NONE - no coin passes quality, robustness >= 0.67, asymmetry >= 1.5 and base rate >= 0.30'); continue
            for _, r in s.iterrows():
                picks.append(r.to_dict())
                lines.append(f"  {r.sym:10s} price {fmt_px(r.price_now)} -> zone {fmt_px(r.zone_lo)}-{fmt_px(r.zone_hi)} ({r.dist_pct:.2f} % away = {r.dist_tdr:.2f} of a typical day's range)")
                lines.append(f"     model USD {fmt_usd(r.zone_usd)} [{fmt_usd(r.zone_usd_min)}-{fmt_usd(r.zone_usd_max)}], = {r.fuel:.2f} x median hourly volume (rank {r.fuel_pct:.2f}); "
                             f"opposite side 0-4 %: {fmt_usd(r.opposite_0_4)} -> asymmetry {r.asym:.1f}x")
                lines.append(f"     robustness {r.robustness:.2f}, {r.old_share*100:.0f} % older than 24h, 24h-map {'agrees' if r.w24_agrees else 'disagrees'}, "
                             f"{r.layers_behind} more reliable layers behind it ({fmt_usd(r.usd_behind)}); historical 24h base rate of reaching it {r.p_reach:.2f}")
    else: lines.append('\nNONE - no coin passes the quality and structure gates right now (a map older than 30 min also fails the quality gate).')
    if len(R):
        blocked = R[~R.eligible].groupby('why_not').size().sort_values(ascending=False).head(5)
        lines.append('\nwhy the others were not eligible: ' + '; '.join(f'{k} ({v})' for k, v in blocked.items()))
    snap = dict(kind='best', wall_now=ts(wall_now_min), picks=picks, all=R.drop(columns=['quality'], errors='ignore').to_dict('records'))
    f = save_snapshot('best', snap); lines.append(f'snapshot: {f}')
    return '\n'.join(lines), snap
