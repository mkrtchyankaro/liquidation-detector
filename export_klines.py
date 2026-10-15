#!/usr/bin/env python3
"""READ-ONLY export of Binance USDT-M futures klines for the 4H zone study.
- Uses ONLY the public endpoint GET https://fapi.binance.com/fapi/v1/klines (no API key, no account access, no orders).
- Does not touch the bot, the DB or any config.
- 23 altcoins (BTC and ETH excluded), intervals 1d, 4h and 1h, 2026-06-15 00:00 UTC -> 2026-10-15 00:00 UTC (end exclusive).
  (06-15 start = 90-day zone window before 10-01 plus ATR(14) warm-up.)
- Keeps only CLOSED candles (close_time < time of the request).
- Writes klines_1d.csv, klines_4h.csv, klines_1h.csv, integrity.json and zones4h_export.zip in the output folder.

Usage:  python3 export_klines.py [--out ./zones4h_export] [--start 2026-06-15] [--end 2026-10-15]
Needs only the Python 3 standard library."""
import argparse, csv, datetime as dt, hashlib, json, os, sys, time, urllib.request, urllib.error, zipfile

SYMBOLS = ['ADAUSDT', 'ALGOUSDT', 'AVAXUSDT', 'BCHUSDT', 'BNBUSDT', 'DOGEUSDT', 'DOTUSDT', 'ENAUSDT', 'HBARUSDT', 'HYPEUSDT',
           'LINKUSDT', 'LTCUSDT', 'NEARUSDT', 'ONDOUSDT', 'SOLUSDT', 'STRKUSDT', 'SUIUSDT', 'UNIUSDT', 'WLDUSDT', 'XLMUSDT',
           'XRPUSDT', 'XTZUSDT', 'ZECUSDT']
BASE = 'https://fapi.binance.com/fapi/v1/klines'
STEP = {'1d': 24 * 3600 * 1000, '4h': 4 * 3600 * 1000, '1h': 3600 * 1000}
COLS = ['symbol', 'interval', 'open_time_utc', 'close_time_utc', 'open_ms', 'open', 'high', 'low', 'close', 'volume',
        'quote_volume', 'trades', 'taker_buy_base', 'taker_buy_quote']
UTC = dt.timezone.utc

def ms(d): return int(d.replace(tzinfo=UTC).timestamp() * 1000)
def iso(m): return dt.datetime.fromtimestamp(m / 1000, UTC).strftime('%Y-%m-%d %H:%M')

def get(url, tries=6):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'zones4h-readonly-export'}), timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (418, 429):                       # rate limit -> back off
                time.sleep(int(e.headers.get('Retry-After', 30)) + 1); continue
            if k == tries - 1: raise
        except Exception:
            if k == tries - 1: raise
        time.sleep(2 * (k + 1))

def fetch(symbol, interval, start_ms, end_ms, now_ms):
    out, cur = [], start_ms
    while cur < end_ms:
        rows = get(f'{BASE}?symbol={symbol}&interval={interval}&startTime={cur}&endTime={end_ms - 1}&limit=1500')
        if not rows: break
        for k in rows:
            o, c = int(k[0]), int(k[6])
            if o >= end_ms: continue
            if c >= now_ms: continue                       # still open -> not allowed
            out.append(dict(symbol=symbol, interval=interval, open_time_utc=iso(o), close_time_utc=iso(c + 1), open_ms=o,
                            open=k[1], high=k[2], low=k[3], close=k[4], volume=k[5], quote_volume=k[7], trades=k[8],
                            taker_buy_base=k[9], taker_buy_quote=k[10]))
        nxt = int(rows[-1][0]) + STEP[interval]
        if nxt <= cur: break
        cur = nxt
        time.sleep(0.25)                                   # gentle on the public API
    dedup = {r['open_ms']: r for r in out}
    return [dedup[k] for k in sorted(dedup)]

def check(rows, interval, start_ms, end_ms, now_ms):
    step = STEP[interval]; exp_end = min(end_ms, (now_ms // step) * step)
    expected = list(range(start_ms, exp_end, step)); have = {r['open_ms'] for r in rows}
    missing = [iso(m) for m in expected if m not in have]
    bad_ohlc = [r['open_time_utc'] for r in rows if not (float(r['low']) <= min(float(r['open']), float(r['close'])) and
                                                         float(r['high']) >= max(float(r['open']), float(r['close'])))]
    zero_vol = [r['open_time_utc'] for r in rows if float(r['volume']) == 0]
    return dict(expected=len(expected), got=len(rows), missing=len(missing), missing_first=missing[:20],
                first=rows[0]['open_time_utc'] if rows else None, last=rows[-1]['open_time_utc'] if rows else None,
                bad_ohlc=len(bad_ohlc), bad_ohlc_first=bad_ohlc[:10], zero_volume=len(zero_vol), zero_volume_first=zero_vol[:10])

def agg_check(r4, r1, small='1h', k=4):
    """A bigger candle must equal the aggregate of its k smaller candles (open, high, low, close): 4h = 4 x 1h, 1d = 6 x 4h."""
    by1 = {r['open_ms']: r for r in r1}; bad = []; n = 0
    for r in r4:
        parts = [by1.get(r['open_ms'] + i * STEP[small]) for i in range(k)]
        if any(p is None for p in parts): continue
        n += 1
        o, c = float(parts[0]['open']), float(parts[-1]['close'])
        h, l = max(float(p['high']) for p in parts), min(float(p['low']) for p in parts)
        if (abs(o - float(r['open'])) > 1e-12 or abs(c - float(r['close'])) > 1e-12 or
                abs(h - float(r['high'])) > 1e-12 or abs(l - float(r['low'])) > 1e-12):
            bad.append(r['open_time_utc'])
    return dict(compared=n, mismatches=len(bad), mismatch_first=bad[:10])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='./zones4h_export'); ap.add_argument('--start', default='2026-06-15'); ap.add_argument('--end', default='2026-10-15')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    s_ms = ms(dt.datetime.strptime(a.start, '%Y-%m-%d')); e_ms = ms(dt.datetime.strptime(a.end, '%Y-%m-%d'))
    now_ms = int(time.time() * 1000)
    if now_ms < e_ms:
        print(f'NOTE: end {a.end} 00:00 UTC is in the future; only candles closed before now ({iso(now_ms)} UTC) are exported.')
    rep = dict(created_utc=iso(now_ms), start=a.start, end_exclusive=a.end, endpoint=BASE, symbols={})
    files = {}
    for itv in ('1d', '4h', '1h'):
        path = os.path.join(a.out, f'klines_{itv}.csv'); files[itv] = path
        with open(path, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=COLS); w.writeheader()
            for sym in SYMBOLS:
                rows = fetch(sym, itv, s_ms, e_ms, now_ms)
                for r in rows: w.writerow(r)
                rep['symbols'].setdefault(sym, {})[itv] = check(rows, itv, s_ms, e_ms, now_ms)
                rep['symbols'][sym].setdefault('_rows', {})[itv] = rows
                c = rep['symbols'][sym][itv]
                print(f"{sym:10s} {itv}: {c['got']}/{c['expected']} candles, missing {c['missing']}, bad OHLC {c['bad_ohlc']}, first {c['first']}, last {c['last']}")
    for sym in SYMBOLS:
        rows = rep['symbols'][sym].pop('_rows')
        rep['symbols'][sym]['4h_vs_1h'] = agg_check(rows['4h'], rows['1h'], '1h', 4)
        rep['symbols'][sym]['1d_vs_4h'] = agg_check(rows['1d'], rows['4h'], '4h', 6)
    rep['summary'] = dict(symbols=len(SYMBOLS),
                          missing_1d=sum(v['1d']['missing'] for v in rep['symbols'].values()),
                          missing_4h=sum(v['4h']['missing'] for v in rep['symbols'].values()),
                          missing_1h=sum(v['1h']['missing'] for v in rep['symbols'].values()),
                          bad_ohlc=sum(v['1d']['bad_ohlc'] + v['4h']['bad_ohlc'] + v['1h']['bad_ohlc'] for v in rep['symbols'].values()),
                          agg_mismatches=sum(v['4h_vs_1h']['mismatches'] + v['1d_vs_4h']['mismatches'] for v in rep['symbols'].values()))
    for itv, p in files.items():
        rep[f'sha256_{itv}'] = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    jp = os.path.join(a.out, 'integrity.json'); json.dump(rep, open(jp, 'w'), indent=1)
    zp = os.path.join(a.out, 'zones4h_export.zip')
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        for p in list(files.values()) + [jp]: z.write(p, os.path.basename(p))
    print('\nSUMMARY', json.dumps(rep['summary']))
    print('Send this file back:', os.path.abspath(zp))

if __name__ == '__main__':
    main()
