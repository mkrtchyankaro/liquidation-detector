#!/usr/bin/env python3
"""
Download 4 months of Binance USDT-M futures history for 25 coins, the same way as the BTC data used in the research:
  - 5m open interest  (data.binance.vision  futures/um/daily/metrics)
  - 5m klines         (data.binance.vision  futures/um/daily/klines/5m)

Only the Python standard library is used (no pip install).  Read-only: it touches nothing but its own output folder.

Run on the server:
    python3 download_binance_oi_klines.py                    # default: 2026-06-11 .. yesterday, all 25 coins
    python3 download_binance_oi_klines.py --start 2026-06-11 --end 2026-10-11
    python3 download_binance_oi_klines.py --symbols ETHUSDT SOLUSDT

Output (one folder per coin, same format the research code already reads):
    binance_history/oi-long-<SYMBOL>/metrics5m.csv.gz   create_time,symbol,sum_open_interest,sum_open_interest_value,...
    binance_history/oi-long-<SYMBOL>/klines5m.csv.gz    t,o,h,l,c,v
    binance_history/oi-long-<SYMBOL>/export.txt         days found / missing
At the end it packs everything into binance_history.tar (send that one file back).
"""
import argparse, csv, datetime as dt, gzip, io, os, sys, tarfile, time, urllib.error, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor

COINS = ['ADAUSDT', 'ALGOUSDT', 'AVAXUSDT', 'BCHUSDT', 'BNBUSDT', 'BTCUSDT', 'DOGEUSDT', 'DOTUSDT', 'ENAUSDT', 'ETHUSDT',
         'HBARUSDT', 'HYPEUSDT', 'LINKUSDT', 'LTCUSDT', 'NEARUSDT', 'ONDOUSDT', 'SOLUSDT', 'STRKUSDT', 'SUIUSDT', 'UNIUSDT',
         'WLDUSDT', 'XLMUSDT', 'XRPUSDT', 'XTZUSDT', 'ZECUSDT']
BASE = 'https://data.binance.vision/data/futures/um/daily'
OUT = 'binance_history'


def fetch(url, tries=4):
    """Return the CSV text inside the zip at url, or None if the file does not exist (404)."""
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'research-download'}), timeout=60) as r:
                z = zipfile.ZipFile(io.BytesIO(r.read()))
                return z.read(z.namelist()[0]).decode()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 * (i + 1))
        except Exception:
            time.sleep(2 * (i + 1))
    return None


def day_files(sym, day):
    d = day.isoformat()
    m = fetch(f'{BASE}/metrics/{sym}/{sym}-metrics-{d}.zip')
    k = fetch(f'{BASE}/klines/{sym}/5m/{sym}-5m-{d}.zip')
    return day, m, k


def run_symbol(sym, days, workers):
    folder = os.path.join(OUT, f'oi-long-{sym}')
    os.makedirs(folder, exist_ok=True)
    with ThreadPoolExecutor(workers) as ex:
        res = sorted(ex.map(lambda d: day_files(sym, d), days), key=lambda x: x[0])
    miss_m, miss_k, n_m, n_k, header = [], [], 0, 0, None
    with gzip.open(os.path.join(folder, 'metrics5m.csv.gz'), 'wt', newline='') as fm, \
         gzip.open(os.path.join(folder, 'klines5m.csv.gz'), 'wt', newline='') as fk:
        wk = csv.writer(fk); wk.writerow(['t', 'o', 'h', 'l', 'c', 'v'])
        for day, m, k in res:
            if m is None:
                miss_m.append(day.isoformat())
            else:
                lines = m.strip().splitlines()
                if header is None:
                    header = lines[0]; fm.write(header + '\n')
                for ln in lines[1:]:
                    fm.write(ln + '\n'); n_m += 1
            if k is None:
                miss_k.append(day.isoformat())
            else:
                for row in csv.reader(io.StringIO(k)):
                    if not row or not row[0].strip().isdigit():
                        continue                      # skip the header line (newer files have one)
                    wk.writerow([int(row[0]), row[1], row[2], row[3], row[4], row[5]]); n_k += 1
    with open(os.path.join(folder, 'export.txt'), 'w') as f:
        f.write(f'{sym} {days[0]} -> {days[-1]} ({len(days)} days)\n')
        f.write(f'metrics rows {n_m}, missing days {len(miss_m)}: {", ".join(miss_m[:30])}{" ..." if len(miss_m) > 30 else ""}\n')
        f.write(f'klines 5m rows {n_k}, missing days {len(miss_k)}: {", ".join(miss_k[:30])}{" ..." if len(miss_k) > 30 else ""}\n')
    return n_m, n_k, len(miss_m), len(miss_k)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', default='2026-06-11')
    ap.add_argument('--end', default=(dt.date.today() - dt.timedelta(days=1)).isoformat())
    ap.add_argument('--symbols', nargs='*', default=COINS)
    ap.add_argument('--workers', type=int, default=8)
    a = ap.parse_args()
    s, e = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    days = [s + dt.timedelta(days=i) for i in range((e - s).days + 1)]
    os.makedirs(OUT, exist_ok=True)
    print(f'{len(a.symbols)} coins, {days[0]} -> {days[-1]} ({len(days)} days)')
    for i, sym in enumerate(a.symbols, 1):
        t0 = time.time()
        n_m, n_k, mm, mk = run_symbol(sym, days, a.workers)
        print(f'[{i}/{len(a.symbols)}] {sym}: OI rows {n_m} (missing days {mm}), 5m klines {n_k} (missing days {mk})  {time.time() - t0:.0f}s', flush=True)
    with tarfile.open(OUT + '.tar', 'w') as t:
        t.add(OUT)
    print(f'done -> {OUT}.tar  ({os.path.getsize(OUT + ".tar") / 1e6:.1f} MB). Send this file back.')


if __name__ == '__main__':
    sys.exit(main())
