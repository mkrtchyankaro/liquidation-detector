#!/usr/bin/env python3
"""liqmap - LIVE liquidation-level map for our 25 coins.  Research / observation tool: no orders, no signals, DB read-only.

  python3 main.py AVAXUSDT            update that coin, then show its map (table + PNG + snapshot)
  python3 main.py --best              update all coins, then show the best DOWN / UP structures or NONE
  python3 main.py --update            update all coins (for cron), nothing shown
  python3 main.py --status            data freshness per coin
  python3 main.py --verify            rebuild a sample of books from the cached inputs and compare with the live state
  python3 main.py --evaluate          score past --best snapshots (reached? recorded liquidations?)
  python3 main.py --selftest          check python packages, node, Binance, DB access, disk (run this first)
  python3 main.py --bundle            write a diagnostic ZIP (inputs, meta, logs, snapshots, code hash) to send for checking
Options: --project PATH  liquidation-detector folder (.env + node_modules) for the read-only DB reader (default: env LIQMAP_PROJECT or .)
         --no-update     show from the saved state only            --no-png    skip the chart
         --home DIR      where liqmap keeps its state (default ./data or env LIQMAP_HOME)
Testing only: --replay EXPORT_DIR --replay-now "2026-10-12 06:00" [--replay-liq FILE --replay-quality FILE]"""
import argparse, fcntl, os, sys, time
ap = argparse.ArgumentParser(add_help=True)
ap.add_argument('symbol', nargs='?'); ap.add_argument('--best', action='store_true'); ap.add_argument('--update', action='store_true')
ap.add_argument('--status', action='store_true'); ap.add_argument('--verify', action='store_true'); ap.add_argument('--evaluate', action='store_true')
ap.add_argument('--bundle', action='store_true'); ap.add_argument('--selftest', action='store_true'); ap.add_argument('--no-update', action='store_true'); ap.add_argument('--no-png', action='store_true')
ap.add_argument('--project', default=os.environ.get('LIQMAP_PROJECT', '.')); ap.add_argument('--home', default=None)
ap.add_argument('--replay'); ap.add_argument('--replay-now'); ap.add_argument('--replay-liq'); ap.add_argument('--replay-quality'); ap.add_argument('--coins')
a = ap.parse_args()
if a.home: os.environ['LIQMAP_HOME'] = os.path.abspath(a.home)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pandas as pd
from liqmap.config import COINS, HOME
from liqmap.update import update_coin, log, load_meta
from liqmap.sources import BinanceSource, DbSource, ReplaySource, to_min, from_min
os.makedirs(HOME, exist_ok=True)
coins = [c.strip().upper() + ('' if c.strip().upper().endswith('USDT') else 'USDT') for c in a.coins.split(',')] if a.coins else COINS
if a.replay:
    src = ReplaySource(a.replay, a.replay_liq, a.replay_quality); src.set_now(a.replay_now); db = None; now = pd.Timestamp(a.replay_now)
else:
    src = BinanceSource(); db = DbSource(a.project); now = None
wall_now_min = to_min(now) if now is not None else int(time.time() // 60)
def run_update(syms):
    lock = open(os.path.join(HOME, '.lock'), 'w')
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: print('another liqmap update is running; using the saved state'); return
    t0 = time.time(); n = 0
    for s in syms:
        try:
            r = update_coin(s, src, db, now); n += r['new_bars']
            msg = log(f"update {s}: +{r['new_bars']} bars" + (f" to {r.get('last_bar')}" if r['new_bars'] else '') + (f" OI corrections {len(r['flags'])}" if r.get('flags') else '') +
                      (f" INVARIANT VIOLATIONS {r['inv_bad']}" if r.get('inv_bad') else '') + f" ({r['secs']} s)")
            if r['new_bars'] > 300 or r.get('inv_bad'): print(msg)
        except Exception as e:
            print(log(f'update {s} FAILED: {type(e).__name__}: {e}'))
    print(log(f'update done: {len(syms)} coins, {n} new bars, {time.time()-t0:.0f} s'))
    fcntl.flock(lock, fcntl.LOCK_UN)
if a.symbol:
    sym = a.symbol.upper() + ('' if a.symbol.upper().endswith('USDT') else 'USDT')
    if sym not in COINS: print(f'{sym} is not one of the 25 coins'); sys.exit(2)
    if not a.no_update: run_update([sym])
    from liqmap.views import coin_view
    txt, _ = coin_view(sym, wall_now_min, png=not a.no_png); print(txt)
elif a.best:
    if not a.no_update: run_update(coins)
    from liqmap.views import best
    txt, _ = best(wall_now_min, coins); print(txt)
elif a.update: run_update(coins)
elif a.status:
    from liqmap.views import ts
    for s in coins:
        m = load_meta(s)
        if not m: print(f'{s:10s} no state'); continue
        f = m.get('fetch') or {}
        print(f"{s:10s} map to {ts(m['last_bar'] + 5)}  last candle {ts(f.get('last_kline'))}  last OI {ts(f.get('last_oi'))}  last DB minute {ts(f.get('last_minute'))}  "
              f"waiting {f.get('pending')}  history from {ts(m['bootstrap_start'])}  invariant violations {m.get('inv_bad')}")
elif a.verify:
    from liqmap.checks import verify
    V = verify([c for c in coins] if a.coins else None); txt = V.to_string(index=False); print(txt)
    open(os.path.join(HOME, f"verify_{pd.Timestamp.now('UTC').strftime('%Y%m%dT%H%M%S')}.txt"), 'w').write(txt)
    print('ALL IDENTICAL' if V.identical.all() else 'MISMATCH - send --bundle')
elif a.evaluate:
    from liqmap.checks import evaluate
    E = evaluate(); print(E.to_string(index=False) if len(E) else 'no snapshot is older than 24h yet')
elif a.selftest:
    from liqmap.checks import selftest
    print(selftest(a.project))
elif a.bundle:
    from liqmap.checks import bundle
    print('bundle:', bundle())
else: ap.print_help()
