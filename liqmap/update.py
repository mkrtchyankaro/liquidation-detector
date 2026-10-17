"""Incremental updater: fetch new closed 5m bars, clean OI causally, feed every scenario book, save state.
State never has to be rebuilt; --verify rebuilds a sample from the cached raw data and compares."""
import json, os, time, numpy as np, pandas as pd
from .config import HOME, HISTORY_DAYS, SCENARIOS, scen_name
from .engine import Book
from .clean import OiCleaner
from .sources import to_min, from_min, bars_from_minutes, replay_bars_from_minutes, ReplaySource
RAW_COLS = ['open', 'high', 'low', 'close', 'quote_volume', 'taker_buy_quote', 'oi_open', 'oi_close', 'doi_raw', 'doi', 'oi_flag',
            'liqL', 'liqS', 'liqL_px', 'liqS_px', 'liq_minutes', 'db_oi_end']
OI_WAIT_MIN = 30           # wait at most this long for Binance to publish the OI point of a closed bar
LIQ_SETTLE_MIN = 5         # minute_bars are rewritten for 3 minutes after the minute; wait 5
def p(*a): return os.path.join(HOME, *a)
def log(msg):
    os.makedirs(p('logs'), exist_ok=True); line = f"[{pd.Timestamp.now('UTC').strftime('%Y-%m-%d %H:%M:%S')}Z] {msg}"
    with open(p('logs', 'liqmap.log'), 'a') as f: f.write(line + '\n')
    return line
def load_raw(sym):
    f = p('raw', f'{sym}.csv')
    if not os.path.exists(f): return pd.DataFrame(columns=RAW_COLS)
    return pd.read_csv(f, index_col=0)
def save_raw(sym, df):
    os.makedirs(p('raw'), exist_ok=True); tmp = p('raw', f'{sym}.csv.tmp'); df.to_csv(tmp); os.replace(tmp, p('raw', f'{sym}.csv'))
def load_meta(sym):
    f = p('state', sym, 'meta.json'); return json.load(open(f)) if os.path.exists(f) else None
def save_meta(sym, meta):
    os.makedirs(p('state', sym), exist_ok=True); tmp = p('state', sym, 'meta.json.tmp'); json.dump(meta, open(tmp, 'w')); os.replace(tmp, p('state', sym, 'meta.json'))
def load_book(sym, sc):
    f = p('state', sym, scen_name(sc) + '.npz')
    if not os.path.exists(f): return None
    with np.load(f, allow_pickle=False) as z: return Book.from_dict({k: z[k] for k in z.files})
def save_book(sym, sc, b):
    os.makedirs(p('state', sym), exist_ok=True); tmp = p('state', sym, scen_name(sc) + '.tmp.npz')
    np.savez_compressed(tmp, **b.to_dict()); os.replace(tmp, p('state', sym, scen_name(sc) + '.npz'))

def fetch_new(sym, src, db, now_min, last_t):
    """returns new READY rows (bar open t > last_t) as a DataFrame with RAW_COLS except the cleaned columns"""
    start = (now_min - now_min % 1440) - HISTORY_DAYS * 1440 if last_t is None else last_t + 5
    if start >= now_min - 5: return pd.DataFrame(columns=RAW_COLS), {}
    k = src.klines(sym, start, now_min)
    if k.empty: return pd.DataFrame(columns=RAW_COLS), {'klines': 0}
    oi = src.oi(sym, start - 60, now_min)
    mins = (db or src).minute_bars([sym], start, now_min)
    mb = (replay_bars_from_minutes(mins) if isinstance(db or src, ReplaySource) else bars_from_minutes(mins)) if len(mins) else pd.DataFrame()
    df = k.copy()
    df['oi_open'] = oi.reindex(df.index).values; df['oi_close'] = oi.reindex(df.index + 5).values
    for c in ('liqL', 'liqS', 'liqL_px', 'liqS_px', 'liq_minutes', 'db_oi_end'):
        df[c] = mb[c].reindex(df.index).values if c in mb else np.nan
    df[['liqL', 'liqS', 'liq_minutes']] = df[['liqL', 'liqS', 'liq_minutes']].fillna(0)
    # readiness: keep bars in order; stop at the first bar whose OI is not yet published (unless it is overdue)
    ready = []
    for t, r in df.iterrows():
        end = t + 5
        if now_min < end + LIQ_SETTLE_MIN: break
        if not np.isfinite(r.oi_close) and now_min < end + OI_WAIT_MIN: break
        ready.append(t)
    info = dict(klines=len(k), last_kline=int(k.index.max()), last_price=float(k.close.iloc[-1]), last_oi=int(oi.index.max()) if len(oi) else None,
                last_minute=int(mins.t.max()) if len(mins) else None, pending=len(df) - len(ready))
    return df.loc[ready], info

def update_coin(sym, src, db=None, now=None, log_fn=print):
    t_start = time.time(); now_min = to_min(now) if now is not None else int(time.time() // 60)
    meta = load_meta(sym); raw = load_raw(sym)
    last_t = int(raw.index.max()) if len(raw) else None
    new, info = fetch_new(sym, src, db, now_min, last_t)
    if new.empty:
        if meta: meta['last_check_min'] = now_min; meta['fetch'] = info; save_meta(sym, meta)
        return dict(sym=sym, new_bars=0, info=info, secs=round(time.time() - t_start, 1))
    cl = OiCleaner(*(meta['cleaner'] if meta else (None, None)))
    prev_oi = meta['last_oi'] if meta else None
    doi_raw, doi, flags = [], [], []
    for t, r in new.iterrows():
        base = r.oi_open if np.isfinite(r.oi_open) else prev_oi
        d = (r.oi_close - base) if (np.isfinite(r.oi_close) and base is not None and np.isfinite(base)) else np.nan
        dc, f = cl.step(int(t), d, r.close, r.quote_volume)
        doi_raw.append(d); doi.append(dc); flags.append(f)
        if np.isfinite(r.oi_close): prev_oi = float(r.oi_close)
    new = new.assign(doi_raw=doi_raw, doi=doi, oi_flag=flags)[RAW_COLS]
    first_oi = new.oi_open.dropna().iloc[0] if meta is None else None
    X = new[['open', 'high', 'low', 'close', 'quote_volume', 'taker_buy_quote', 'doi', 'liqL', 'liqS', 'liqL_px', 'liqS_px']].to_numpy(dtype=float)
    T = new.index.values.astype(np.int64); inv = 0
    for sc in SCENARIOS:
        b = load_book(sym, sc) if meta else None
        if b is None:
            if meta is not None: raise RuntimeError(f'{sym} {scen_name(sc)}: state file missing while meta exists - run --rebuild {sym}')
            b = Book(sc[0], sc[1], sc[2], sc[3]); b.start(first_oi, int(T[0]))
        for i in range(len(T)): b.step(int(T[i]), *X[i])
        inv += b.inv_bad; save_book(sym, sc, b)
    raw = pd.concat([raw, new]) if len(raw) else new
    raw = raw[raw.index >= raw.index.max() - (HISTORY_DAYS + 31) * 1440]          # keep ~60 days of raw input
    save_raw(sym, raw)
    meta = dict(sym=sym, version=1, bootstrap_start=int(meta['bootstrap_start']) if meta else int(T[0]), last_bar=int(T[-1]), last_oi=prev_oi,
                cleaner=[cl.pending, cl.absd[-5000:]], last_check_min=now_min, fetch=info, inv_bad=int(inv), bars_total=int(len(raw)))
    save_meta(sym, meta)
    return dict(sym=sym, new_bars=int(len(new)), last_bar=str(from_min(T[-1])), info=info, flags=[f for f in flags if f], inv_bad=int(inv), secs=round(time.time() - t_start, 1))

def rebuild_from_raw(sym, scenarios):
    """recompute books from the cached raw input only (for --verify): must equal the incremental state."""
    raw = load_raw(sym); meta = load_meta(sym)
    raw = raw[raw.index >= meta['bootstrap_start']]
    X = raw[['open', 'high', 'low', 'close', 'quote_volume', 'taker_buy_quote', 'doi', 'liqL', 'liqS', 'liqL_px', 'liqS_px']].to_numpy(dtype=float); T = raw.index.values.astype(np.int64)
    out = {}
    for sc in scenarios:
        b = Book(sc[0], sc[1], sc[2], sc[3]); b.start(raw.oi_open.dropna().iloc[0], int(T[0]))
        for i in range(len(T)): b.step(int(T[i]), *X[i])
        out[scen_name(sc)] = b
    return out
