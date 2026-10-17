"""--verify (incremental state == rebuild from cached inputs), --evaluate (score old snapshots), --bundle (diagnostic ZIP)."""
import glob, hashlib, json, os, platform, random, zipfile, numpy as np, pandas as pd
from .config import HOME, COINS, SCENARIOS, scen_name
from .update import load_book, load_meta, load_raw, rebuild_from_raw
from .sources import to_min, from_min
def verify(coins=None, n_coins=2, scen_idx=(0, 13, 26, 28), seed=None):
    rnd = random.Random(seed); have = [c for c in COINS if load_meta(c)]
    coins = coins or rnd.sample(have, min(n_coins, len(have))); out = []
    for c in coins:
        scs = [SCENARIOS[i] for i in scen_idx]; rb = rebuild_from_raw(c, scs)
        for sc in scs:
            a = load_book(c, sc); b = rb[scen_name(sc)]
            same = len(a.A) == len(b.A) and all(np.allclose(np.sort(getattr(a, f)), np.sort(getattr(b, f)), equal_nan=True, rtol=1e-9, atol=1e-9) for f in ('A', 'E', 'LP')) \
                and abs(a.leg[1] - b.leg[1]) < 1e-6 * max(1, a.oi) and a.last_bar_min == b.last_bar_min
            out.append(dict(coin=c, scenario=scen_name(sc), identical=bool(same), slices=len(a.A), inv_bad=a.inv_bad))
    return pd.DataFrame(out)
def evaluate():
    rows = []
    for f in sorted(glob.glob(os.path.join(HOME, 'snapshots', '*', '*_best.json'))):
        s = json.load(open(f)); t0 = to_min(pd.Timestamp(s['wall_now']))
        for p in s.get('picks', []):
            raw = load_raw(p['sym']); w = raw[(raw.index >= t0) & (raw.index < t0 + 1440)]
            if len(w) < 280: continue
            hit = (w.low <= p['zone_hi']).any() if p['side'] == 'LONG' else (w.high >= p['zone_lo']).any()
            col, pcol = ('liqL', 'liqL_px') if p['side'] == 'LONG' else ('liqS', 'liqS_px')
            inz = w[(w[pcol] >= p['zone_lo']) & (w[pcol] <= p['zone_hi'])][col].sum()
            rows.append(dict(snapshot=os.path.basename(f), sym=p['sym'], side=p['side'], p_reach=p['p_reach'], reached=bool(hit), recorded_liq_in_zone=inz, recorded_liq_side_24h=w[col].sum()))
    E = pd.DataFrame(rows)
    if len(E): E.to_csv(os.path.join(HOME, 'evaluations.csv'), index=False)
    return E
def bundle(extra_text=''):
    t = pd.Timestamp.now('UTC').strftime('%Y%m%dT%H%M%SZ'); f = os.path.join(HOME, f'liqmap_bundle_{t}.zip'); code = os.path.dirname(os.path.abspath(__file__))
    h = hashlib.sha256()
    for p in sorted(glob.glob(os.path.join(code, '*.py'))): h.update(open(p, 'rb').read())
    info = dict(created=t, code_sha256=h.hexdigest(), python=platform.python_version(), numpy=np.__version__, pandas=pd.__version__, home=HOME)
    with zipfile.ZipFile(f, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('info.json', json.dumps(info, indent=1)); z.writestr('notes.txt', extra_text)
        for p in glob.glob(os.path.join(HOME, 'raw', '*.csv')): z.write(p, 'raw/' + os.path.basename(p))
        for p in glob.glob(os.path.join(HOME, 'state', '*', 'meta.json')): z.write(p, 'meta/' + p.split(os.sep)[-2] + '.json')
        for p in glob.glob(os.path.join(HOME, 'logs', '*')): z.write(p, 'logs/' + os.path.basename(p))
        snaps = sorted(glob.glob(os.path.join(HOME, 'snapshots', '*', '*.json')))[-400:]
        for p in snaps: z.write(p, 'snapshots/' + '/'.join(p.split(os.sep)[-2:]))
        for p in sorted(glob.glob(os.path.join(HOME, 'charts', '*.png')))[-10:]: z.write(p, 'charts/' + os.path.basename(p))
        for p in glob.glob(os.path.join(HOME, '*.csv')) + glob.glob(os.path.join(HOME, 'verify_*.txt')): z.write(p, os.path.basename(p))
        for p in glob.glob(os.path.join(code, '*.py')): z.write(p, 'code/liqmap/' + os.path.basename(p))
        root = os.path.dirname(code)
        for n in ('main.py', 'db_read.cjs', 'README.md'):
            if os.path.exists(os.path.join(root, n)): z.write(os.path.join(root, n), 'code/' + n)
    return f

def selftest(project):
    """environment check before the first bootstrap: versions, Binance reachability and lag, DB read, disk."""
    import shutil, subprocess, time, importlib
    out = []
    import sys; out.append(f'python {sys.version.split()[0]} (need >= 3.8)')
    for m in ('numpy', 'pandas', 'matplotlib'):
        try: out.append(f'{m} {importlib.import_module(m).__version__}')
        except Exception: out.append(f'{m} MISSING' + (' (charts will be skipped)' if m == 'matplotlib' else ' (REQUIRED: pip install --user ' + m + ')'))
    try: out.append('node ' + subprocess.run(['node', '--version'], capture_output=True, text=True).stdout.strip())
    except Exception: out.append('node MISSING (needed for the read-only DB reader)')
    from .sources import BinanceSource, DbSource
    try:
        b = BinanceSource(); now = int(time.time() // 60); o = b.oi('BTCUSDT', now - 60, now); k = b.klines('BTCUSDT', now - 30, now)
        out.append(f'Binance OK: last BTC 5m OI point {now - int(o.index.max())} min ago, last closed kline opened {now - int(k.index.max())} min ago')
        o30 = b.oi('BTCUSDT', now - 28 * 1440, now - 28 * 1440 + 60); out.append(f'Binance OI 28 days back available: {len(o30) > 0}')
    except Exception as e: out.append(f'Binance FAILED: {e}')
    try:
        mb = DbSource(project).minute_bars(['BTCUSDT'], int(time.time() // 60) - 120, int(time.time() // 60))
        out.append(f'DB minute_bars (read-only) OK: {len(mb)} rows in the last 2h for BTCUSDT, polls>0 in {int((mb.p > 0).sum())}')
    except Exception as e: out.append(f'DB FAILED: {e}')
    du = shutil.disk_usage(HOME); out.append(f'disk free {du.free / 1e9:.1f} GB at {HOME} (state for 25 coins needs ~60-100 MB)')
    return '\n'.join(out)
