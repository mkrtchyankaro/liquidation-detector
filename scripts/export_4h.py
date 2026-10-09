#!/usr/bin/env python3
"""
4H KLINES EXPORT (Johnny, Oct 9 2026). READ-ONLY: Binance PUBLIC futures klines only (no keys, no DB, no bot).
Writes reports/klines-4h/<SYMBOL>.csv + check.txt and packs reports/klines-4h.tgz. Standard library only.

  python3 scripts/export_4h.py                 # BTC + SYMBOLS from .env, last 365 days of CLOSED 4H candles
  options: --symbols A,B,...  --days 365

Columns: time (UTC open), open, high, low, close, volume (coins), quote_volume ($), trades, taker_buy_volume (coins).
check.txt: per coin first / last candle, missing 4H candles, broken candles (low > open/close or high < open/close),
zero-volume candles. Nothing is filled in or repaired.
"""
import argparse, csv, json, os, tarfile, time, urllib.error, urllib.request
from datetime import datetime, timezone

H4 = 4 * 3600_000; D_MS = 86_400_000
ts = lambda ms: datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def env_symbols():
    for p in (".env", os.path.join(os.path.dirname(__file__), "..", ".env")):
        if os.path.exists(p):
            for line in open(p, encoding="utf-8"):
                if line.strip().startswith("SYMBOLS="):
                    return [s.strip().upper() for s in line.split("=", 1)[1].strip().strip('"').strip("'").split(",") if s.strip()]
    return []


def klines(sym, start, end):
    base = os.environ.get("BINANCE_FAPI_URL", "https://fapi.binance.com"); out = []; s = start
    while s < end:
        url = f"{base}/fapi/v1/klines?symbol={sym}&interval=4h&startTime={s}&endTime={end - 1}&limit=1500"
        for i in range(5):
            try: rows = json.loads(urllib.request.urlopen(url, timeout=30).read()); break
            except urllib.error.HTTPError as e:
                if e.code == 400: raise SystemExit(f"{sym}: {e.read().decode()[:150]}")
                time.sleep(2 ** i)
            except Exception: time.sleep(2 ** i)
        else: raise SystemExit(f"{sym}: download failed")
        if not rows: break
        out += [r for r in rows if int(r[6]) < end]
        s = int(rows[-1][0]) + 1
        if len(rows) < 1500: break
        time.sleep(0.3)
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--symbols"); ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--out", default=os.path.join("reports", "klines-4h")); a = ap.parse_args()
    syms = [s.upper() for s in a.symbols.split(",")] if a.symbols else env_symbols()
    syms = ["BTCUSDT"] + [s for s in syms if s != "BTCUSDT"]
    os.makedirs(a.out, exist_ok=True)
    end = int(time.time() * 1000) // H4 * H4; start = end - a.days * D_MS
    log = []; say = lambda s="": (print(s), log.append(s))
    say(f"═══ 4H klines · {ts(start)} → {ts(end)} UTC (closed candles) · {len(syms)} symbols ═══")
    for s in syms:
        k = klines(s, start, end)
        with open(os.path.join(a.out, f"{s}.csv"), "w", newline="") as fh:
            w = csv.writer(fh); w.writerow(["time", "open", "high", "low", "close", "volume", "quote_volume", "trades", "taker_buy_volume"])
            for r in k: w.writerow([ts(int(r[0])), r[1], r[2], r[3], r[4], r[5], r[7], r[8], r[9]])
        if not k: say(f"  {s:12s} NO DATA"); continue
        got = {int(r[0]) for r in k}; first = int(k[0][0])
        miss = [t for t in range(first, end, H4) if t not in got]
        bad = sum(1 for r in k if not (float(r[3]) <= min(float(r[1]), float(r[4])) and max(float(r[1]), float(r[4])) <= float(r[2])))
        zero = sum(1 for r in k if float(r[5]) == 0)
        say(f"  {s:12s} {len(k)} candles · {ts(first)} → {ts(int(k[-1][0]))}" + (" · starts LATER than asked" if first > start else "")
            + f" · missing {len(miss)}" + (f" ({', '.join(ts(t) for t in miss[:3])}…)" if miss else "") + f" · broken {bad} · zero-volume {zero}")
    open(os.path.join(a.out, "check.txt"), "w").write("\n".join(log) + "\n")
    tgz = os.path.join(os.path.dirname(a.out) or ".", "klines-4h.tgz")
    with tarfile.open(tgz, "w:gz") as t: t.add(a.out, arcname="klines-4h")
    print(f"\npack: {tgz} ({os.path.getsize(tgz) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
