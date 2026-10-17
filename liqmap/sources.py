"""Data sources.  Everything is READ-ONLY.
  BinanceSource : public REST (no keys): 5m klines, 5m openInterestHist (OI at T)
  DbSource      : our Mongo minute_bars via db_read.cjs (the project's own node driver): per-minute LONG/SHORT liquidation USD,
                  collector polls (coverage) and the 1/s OI (cross-check only - it never moves the book)
  ReplaySource  : the 10-16 research export, cut at a simulated 'now' (testing)
Each source returns pandas frames keyed by minute-since-epoch integers (t_min = bar OPEN time)."""
import json, os, subprocess, time, urllib.request, urllib.parse, numpy as np, pandas as pd
EPOCH = pd.Timestamp('1970-01-01')
def to_min(ts): return int((pd.Timestamp(ts) - EPOCH) // pd.Timedelta(minutes=1))
def from_min(m): return EPOCH + pd.Timedelta(minutes=int(m))

class BinanceSource:
    BASE = 'https://fapi.binance.com'
    def __init__(self, min_gap=0.15): self.min_gap = min_gap; self.last = 0; self.calls = 0
    def _get(self, path, params):
        url = self.BASE + path + '?' + urllib.parse.urlencode(params)
        for k in range(6):
            gap = time.time() - self.last
            if gap < self.min_gap: time.sleep(self.min_gap - gap)
            self.last = time.time(); self.calls += 1
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'liqmap/1.0'}), timeout=20) as r: return json.loads(r.read())
            except Exception as e:
                err = e; time.sleep(1.5 * (k + 1))
        raise RuntimeError(f'Binance {path} failed: {err}')
    def klines(self, sym, from_min, to_min):
        """closed 5m klines with open time in [from_min, to_min)"""
        out, cur = [], from_min * 60_000
        while cur < to_min * 60_000:
            d = self._get('/fapi/v1/klines', dict(symbol=sym, interval='5m', startTime=cur, endTime=to_min * 60_000 - 1, limit=1500))
            if not d: break
            out += d; cur = d[-1][0] + 300_000
        now_ms = int(time.time() * 1000)
        rows = [(r[0] // 60_000, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[7]), float(r[10])) for r in out if r[0] + 300_000 <= now_ms]
        return pd.DataFrame(rows, columns=['t', 'open', 'high', 'low', 'close', 'quote_volume', 'taker_buy_quote']).drop_duplicates('t').set_index('t')
    def oi(self, sym, from_min, to_min):
        """5m OI points with timestamp in [from_min, to_min]  (value = OI AT that time, contracts)"""
        out, s = {}, from_min * 60_000
        while s <= to_min * 60_000:
            e = min(to_min * 60_000, s + 499 * 300_000)
            for r in self._get('/futures/data/openInterestHist', dict(symbol=sym, period='5m', startTime=s, endTime=e, limit=500)):
                out[int(r['timestamp']) // 60_000] = float(r['sumOpenInterest'])
            s = e + 300_000
        return pd.Series(out, dtype=float).sort_index()

class DbSource:
    def __init__(self, project):
        self.project = os.path.abspath(project); self.helper = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'db_read.cjs')
    def minute_bars(self, syms, from_min, to_min):
        cmd = ['node', self.helper, '--project', self.project, '--symbols', ','.join(syms), '--from', str(from_min * 60_000), '--to', str(to_min * 60_000)]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if p.returncode != 0: raise RuntimeError(p.stderr.strip()[-400:])
        rows = [json.loads(x) for x in p.stdout.splitlines() if x.startswith('{"s"')]
        df = pd.DataFrame(rows, columns=['s', 't', 'c', 'p', 'oi', 'L', 'S'])
        df['t'] = df.t // 60_000; return df

def bars_from_minutes(mb):
    """minute_bars of ONE symbol -> per 5m bar: liqL, liqS (USD), USD-weighted price (minute close), collector minutes (polls>0), db OI at bar end."""
    if mb.empty: return pd.DataFrame(columns=['liqL', 'liqS', 'liqL_px', 'liqS_px', 'liq_minutes', 'db_oi_end'])
    m = mb.copy(); m['bar'] = m.t - m.t % 5; m['c'] = pd.to_numeric(m.c, errors='coerce'); m['L'] = pd.to_numeric(m.L).fillna(0); m['S'] = pd.to_numeric(m.S).fillna(0)
    m['Lp'] = m.L * m.c; m['Sp'] = m.S * m.c; m['ok'] = (pd.to_numeric(m.p).fillna(0) > 0).astype(int)
    g = m.sort_values('t').groupby('bar').agg(liqL=('L', 'sum'), liqS=('S', 'sum'), Lp=('Lp', 'sum'), Sp=('Sp', 'sum'), liq_minutes=('ok', 'sum'), db_oi_end=('oi', 'last'))
    g['liqL_px'] = np.where(g.liqL > 0, g.Lp / g.liqL.replace(0, np.nan), np.nan); g['liqS_px'] = np.where(g.liqS > 0, g.Sp / g.liqS.replace(0, np.nan), np.nan)
    return g.drop(columns=['Lp', 'Sp'])

class ReplaySource:
    """research export, cut at 'now'; liquidations from the research merged file, coverage from the hourly quality file"""
    def __init__(self, export_dir, liq_file, quality_file):
        self.K = pd.read_csv(os.path.join(export_dir, 'candles_5m.csv')); self.K['t'] = self.K.open_time_ms // 60_000
        self.O = pd.read_csv(os.path.join(export_dir, 'oi_5m.csv')); self.O['t'] = self.O.timestamp_ms // 60_000
        L = pd.read_csv(liq_file); L['t'] = L.timestamp_ms // 60_000; self.L = L
        Q = pd.read_csv(quality_file); Q['t'] = Q.hour_utc.map(to_min); self.Q = Q; self.now_min = None
    def set_now(self, now): self.now_min = to_min(now)
    def klines(self, sym, a, b):
        k = self.K[(self.K.symbol == sym) & (self.K.t >= a) & (self.K.t < b) & (self.K.t + 5 <= self.now_min)]
        return k.set_index('t')[['open', 'high', 'low', 'close', 'quote_volume', 'taker_buy_quote']].astype(float)
    def oi(self, sym, a, b):
        o = self.O[(self.O.symbol == sym) & (self.O.t >= a) & (self.O.t <= b) & (self.O.t <= self.now_min)]
        return o.set_index('t').sumOpenInterest.astype(float).sort_index()
    def minute_bars(self, syms, a, b):
        rows = []
        for s in syms:
            l = self.L[(self.L.symbol == s) & (self.L.t >= a) & (self.L.t < min(b, self.now_min))].copy()
            q = self.Q[(self.Q.symbol == s)]
            mins = pd.DataFrame({'t': np.arange(a, min(b, self.now_min))}); mins['h'] = mins.t - mins.t % 60
            qq = q.set_index('t').quality.reindex(mins.h).values; mins['p'] = np.where(qq == 'COMPLETE', 1, 0)
            if len(l):
                l['L'] = np.where(l.victim == 'LONG', l.usd, 0.0); l['S'] = np.where(l.victim == 'SHORT', l.usd, 0.0); l['pl'] = l.price * l.L; l['ps'] = l.price * l.S
                gl = l.groupby('t').agg(L=('L', 'sum'), S=('S', 'sum'), pl=('pl', 'sum'), ps=('ps', 'sum'))
                mins = mins.join(gl, on='t')
            for col in ('L', 'S', 'pl', 'ps'):
                if col not in mins: mins[col] = 0.0
            mins = mins.fillna({'L': 0, 'S': 0, 'pl': 0, 'ps': 0})
            # replay keeps the EXACT event prices (research path); live uses the minute close
            mins['c'] = np.where(mins.L + mins.S > 0, (mins.pl + mins.ps) / (mins.L + mins.S).replace(0, np.nan), np.nan)
            mins['s'] = s; mins['oi'] = np.nan; rows.append(mins[['s', 't', 'c', 'p', 'oi', 'L', 'S', 'pl', 'ps']])
        return pd.concat(rows) if rows else pd.DataFrame(columns=['s', 't', 'c', 'p', 'oi', 'L', 'S'])
def replay_bars_from_minutes(mb):
    m = mb.copy(); m['bar'] = m.t - m.t % 5
    g = m.groupby('bar').agg(liqL=('L', 'sum'), liqS=('S', 'sum'), pl=('pl', 'sum'), ps=('ps', 'sum'), liq_minutes=('p', 'sum'))
    g['liqL_px'] = np.where(g.liqL > 0, g.pl / g.liqL.replace(0, np.nan), np.nan); g['liqS_px'] = np.where(g.liqS > 0, g.ps / g.liqS.replace(0, np.nan), np.nan); g['db_oi_end'] = np.nan
    return g.drop(columns=['pl', 'ps'])
