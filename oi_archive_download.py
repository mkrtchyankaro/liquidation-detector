#!/usr/bin/env python3
"""Binance USDT-M open-interest history downloader (research only).

- Public data only. No API keys and no orders.
- Does not touch the bot, the DB or production. It writes only into its own output folder.
- Python 3.8+ with the standard library only, so no pip install is needed.

WHAT IT DOWNLOADS
  1) ARCHIVE: https://data.binance.vision/data/futures/um/daily/metrics/<SYM>/<SYM>-metrics-<YYYY-MM-DD>.zip
     One file per day, normally with 288 rows of 5-minute points. Columns:
       create_time, symbol, sum_open_interest, sum_open_interest_value,
       count_toptrader_long_short_ratio, sum_toptrader_long_short_ratio,
       count_long_short_ratio, sum_taker_long_short_vol_ratio
     Each zip is checked against its .CHECKSUM (sha256) file.
  2) REST: https://fapi.binance.com/futures/data/openInterestHist?period=5m
     Binance keeps only about the last 30 days here. It is the same source our 10-14 export used. Our earlier check (oi_data_check.txt)
     showed that a REST point stamped T is the OI AT time T (it matches our ~1 s polling best).

THE '5 MINUTES' QUESTION
  The archive's create_time may be shifted against the REST timestamp, for example 5 minutes late. The script does not guess:
  - It saves the archive times RAW, exactly as in the files.
  - It compares archive with REST on the overlapping days, for every shift from -30 to +30 minutes in 5-minute steps.
  - It reports per coin which shift makes the two series match. That measured shift is applied later, in the analysis.

USAGE
  python3 oi_archive_download.py                      # defaults: 24 coins, 2025-08-01 .. yesterday (UTC)
  python3 oi_archive_download.py --start 2025-08-01 --end 2026-10-14 --workers 6
  The script is resumable: files that were already downloaded and verified are skipped. Run it again after a network error.

OUTPUT (in --out, default ./oi_archive_<today>)
  raw_zip/<SYM>/...zip       original archive files, verified
  oi5m/<SYM>.csv             all archive days merged, sorted, de-duplicated (create_time_utc RAW, ts_ms, all columns)
  rest5m/<SYM>.csv           REST 5-minute points for the last ~30 days
  report.json / report.txt   per-coin day coverage, missing days, rows per day, gaps, duplicates, and the measured archive-vs-REST shift
  oi_archive_<today>.zip     everything above except raw_zip. Send this file back.
"""
import argparse, csv, datetime as dt, hashlib, io, json, os, sys, time, urllib.error, urllib.request, zipfile, statistics as st
from concurrent.futures import ThreadPoolExecutor, as_completed

COINS = ['ADA', 'ALGO', 'AVAX', 'BCH', 'BNB', 'DOGE', 'DOT', 'ENA', 'HBAR', 'LINK', 'LTC', 'NEAR', 'ONDO', 'SOL', 'STRK', 'SUI', 'UNI', 'WLD',
         'XLM', 'XRP', 'XTZ', 'ZEC', 'BTC', 'ETH']          # the 22 study coins + BTC / ETH for market context
ARCH = 'https://data.binance.vision/data/futures/um/daily/metrics/{s}/{s}-metrics-{d}.zip'
REST = 'https://fapi.binance.com/futures/data/openInterestHist?symbol={s}&period=5m&limit=500&startTime={a}&endTime={b}'
UA = {'User-Agent': 'oi-research-downloader/1.0'}
FIVE = 300_000

def get(url, tries=5, timeout=60):
    """bytes, or None for a 404. Network errors are retried with backoff."""
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r: return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if e.code in (418, 429): time.sleep(30 * (k + 1)); continue          # rate limit: wait longer
            time.sleep(2 ** k)
        except Exception:
            time.sleep(2 ** k)
    raise RuntimeError(f'failed after {tries} tries: {url}')

def to_ms(s):
    """create_time can be '2025-10-01 00:05:00' or epoch ms, depending on the file version"""
    s = s.strip()
    if s.isdigit(): return int(s)
    for f in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M'):
        try: return int(dt.datetime.strptime(s, f).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
        except ValueError: pass
    raise ValueError(f'unknown time format {s!r}')

def fetch_day(out, sym, day):
    """download + verify one archive day; returns (status, rows)"""
    d = os.path.join(out, 'raw_zip', sym); os.makedirs(d, exist_ok=True)
    fn = f'{sym}-metrics-{day}.zip'; p = os.path.join(d, fn); ok = p + '.ok'
    if not os.path.exists(ok):
        url = ARCH.format(s=sym, d=day); data = get(url)
        if data is None: return 'MISSING', []
        cs = get(url + '.CHECKSUM')
        if cs is not None and cs.split()[0].decode() != hashlib.sha256(data).hexdigest(): return 'CHECKSUM_BAD', []
        with open(p, 'wb') as g: g.write(data)
        open(ok, 'w').write('checksum ok' if cs is not None else 'no checksum file')
    with zipfile.ZipFile(p) as z:
        txt = z.read(z.namelist()[0]).decode()
    rows = []
    for r in csv.reader(io.StringIO(txt)):
        if not r or r[0].strip().lower() in ('create_time', ''): continue
        rows.append([to_ms(r[0]), r[0].strip()] + [x.strip() for x in r[1:]])
    return 'OK', rows

def fetch_rest(sym, days=29):
    end = int(time.time() * 1000) // FIVE * FIVE; a = end - days * 86_400_000; out = {}
    while a < end:
        b = min(a + 499 * FIVE, end); data = get(REST.format(s=sym, a=a, b=b))
        for r in json.loads(data or b'[]'): out[int(r['timestamp'])] = (float(r['sumOpenInterest']), float(r['sumOpenInterestValue']))
        a = b + FIVE; time.sleep(0.25)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', default='2025-08-01'); ap.add_argument('--end', default=(dt.datetime.utcnow().date() - dt.timedelta(days=1)).isoformat())
    ap.add_argument('--coins', default=','.join(COINS)); ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--out', default=f'oi_archive_{dt.datetime.utcnow():%Y%m%d}'); ap.add_argument('--no-rest', action='store_true')
    A = ap.parse_args(); out = A.out; os.makedirs(out, exist_ok=True)
    syms = [c.strip().upper() + 'USDT' for c in A.coins.split(',') if c.strip()]
    d0, d1 = dt.date.fromisoformat(A.start), dt.date.fromisoformat(A.end); days = [(d0 + dt.timedelta(n)).isoformat() for n in range((d1 - d0).days + 1)]
    print(f'{len(syms)} coins x {len(days)} days = {len(syms) * len(days)} files -> {out}', flush=True)
    REP = {'run_utc': f'{dt.datetime.utcnow():%Y-%m-%d %H:%M:%S}', 'start': A.start, 'end': A.end, 'coins': {}}
    for sym in syms:
        res = {}
        with ThreadPoolExecutor(A.workers) as ex:
            fut = {ex.submit(fetch_day, out, sym, d): d for d in days}
            for f in as_completed(fut):
                try: res[fut[f]] = f.result()
                except Exception as e: res[fut[f]] = (f'ERROR {e}', [])
        rows = {}; per_day = {}; dup = 0
        for d in days:
            stt, rr = res[d]; per_day[d] = (stt, len(rr))
            for r in rr:
                if r[0] in rows: dup += 1
                rows[r[0]] = r
        ts = sorted(rows); gaps = [(ts[i - 1], ts[i]) for i in range(1, len(ts)) if ts[i] - ts[i - 1] != FIVE]
        offgrid = sum(1 for t in ts if t % FIVE)
        os.makedirs(f'{out}/oi5m', exist_ok=True)
        with open(f'{out}/oi5m/{sym}.csv', 'w', newline='') as g:
            w = csv.writer(g); w.writerow(['ts_ms', 'create_time_raw', 'symbol', 'sum_open_interest', 'sum_open_interest_value', 'count_toptrader_long_short_ratio',
                                         'sum_toptrader_long_short_ratio', 'count_long_short_ratio', 'sum_taker_long_short_vol_ratio'])
            for t in ts: w.writerow(rows[t])
        cr = {'days': len(days), 'days_ok': sum(1 for v in per_day.values() if v[0] == 'OK'),
              'days_missing': [d for d, v in per_day.items() if v[0] == 'MISSING'], 'days_error': {d: v[0] for d, v in per_day.items() if v[0] not in ('OK', 'MISSING')},
              'days_not_288_rows': {d: v[1] for d, v in per_day.items() if v[0] == 'OK' and v[1] != 288}, 'rows': len(ts), 'duplicates': dup,
              'gaps_not_5min': len(gaps), 'gap_examples': [(dt.datetime.utcfromtimestamp(a / 1000).isoformat(), dt.datetime.utcfromtimestamp(b / 1000).isoformat()) for a, b in gaps[:10]],
              'off_5min_grid': offgrid,
              'first': dt.datetime.utcfromtimestamp(ts[0] / 1000).isoformat() if ts else None, 'last': dt.datetime.utcfromtimestamp(ts[-1] / 1000).isoformat() if ts else None}
        # archive vs REST: which time shift makes them identical?
        if not A.no_rest:
            try:
                R = fetch_rest(sym); os.makedirs(f'{out}/rest5m', exist_ok=True)
                with open(f'{out}/rest5m/{sym}.csv', 'w', newline='') as g:
                    w = csv.writer(g); w.writerow(['ts_ms', 'time_utc', 'sumOpenInterest', 'sumOpenInterestValue'])
                    for t in sorted(R): w.writerow([t, dt.datetime.utcfromtimestamp(t / 1000).strftime('%Y-%m-%d %H:%M'), *R[t]])
                sh = {}
                for k in range(-6, 7):                     # archive time + k*5 min  ==  REST time ?
                    diffs = [abs(float(rows[t][3]) / R[t + k * FIVE][0] - 1) for t in ts if t + k * FIVE in R and R[t + k * FIVE][0] > 0 and rows[t][3]]
                    if diffs: sh[k * 5] = dict(n=len(diffs), median_abs_pct=round(100 * st.median(diffs), 5), exact_share=round(sum(x < 1e-9 for x in diffs) / len(diffs), 3))
                best = min(sh, key=lambda m: sh[m]['median_abs_pct']) if sh else None
                cr['rest_points'] = len(R); cr['shift_test_minutes'] = sh; cr['best_shift_minutes'] = best
            except Exception as e:
                cr['rest_error'] = str(e)
        REP['coins'][sym] = cr
        print(f"{sym}: days ok {cr['days_ok']}/{cr['days']}, missing {len(cr['days_missing'])}, rows {cr['rows']}, gaps {cr['gaps_not_5min']}, "
              f"best archive->REST shift {cr.get('best_shift_minutes')} min", flush=True)
        json.dump(REP, open(f'{out}/report.json', 'w'), indent=1)
    shifts = [v.get('best_shift_minutes') for v in REP['coins'].values() if v.get('best_shift_minutes') is not None]
    REP['summary'] = {'best_shift_minutes_by_coin': {k: v.get('best_shift_minutes') for k, v in REP['coins'].items()},
                      'all_coins_same_shift': len(set(shifts)) == 1 if shifts else None}
    json.dump(REP, open(f'{out}/report.json', 'w'), indent=1)
    with open(f'{out}/report.txt', 'w') as g:
        for k, v in REP['coins'].items():
            g.write(f"{k}: {v['first']} -> {v['last']}, days ok {v['days_ok']}/{v['days']}, missing {len(v['days_missing'])}, not-288 {len(v['days_not_288_rows'])}, "
                    f"gaps {v['gaps_not_5min']}, dups {v['duplicates']}, best shift {v.get('best_shift_minutes')} min\n")
        g.write(json.dumps(REP['summary'], indent=1))
    zp = os.path.join(out, f'{os.path.basename(out)}.zip')
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        for sub in ('oi5m', 'rest5m'):
            if os.path.isdir(f'{out}/{sub}'):
                for f in sorted(os.listdir(f'{out}/{sub}')): z.write(f'{out}/{sub}/{f}', f'{sub}/{f}')
        z.write(f'{out}/report.json', 'report.json'); z.write(f'{out}/report.txt', 'report.txt'); z.write(__file__, 'oi_archive_download.py')
    print(f'\nDONE -> {zp}\n' + json.dumps(REP['summary'], indent=1))

if __name__ == '__main__':
    main()
