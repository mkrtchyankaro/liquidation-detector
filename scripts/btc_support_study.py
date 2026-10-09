#!/usr/bin/env python3
"""
BTC 4-TOUCH DAILY SUPPORTS vs OUR COINS (Johnny, Oct 9 2026). READ-ONLY research: Binance PUBLIC daily klines only
(no keys, no DB). Writes files under reports/btc-support/ and packs reports/btc-support.tgz. Standard library only.

  python3 scripts/btc_support_study.py                 # coins = SYMBOLS from .env (our collected coins), last 61 closed days
  options: --symbols A,B,...   --days 61   --tol 0.5   --out reports/btc-support

RULES (fixed before any result was seen; the same for every coin):
  data     1D klines (UTC days), only CLOSED days (today is excluded). Integrity: missing days are listed.
  tol      BTC: 0.5 %. Each other coin: 0.5 % x (coin's daily ATR% / BTC's daily ATR%), both ATRs taken from the 14 days
           BEFORE the study window (past only), so a more volatile coin gets a proportionally wider band.
  touch    a day whose LOW enters the zone band while price came from ABOVE (previous close above the band) and whose
           CLOSE is back ABOVE the band -> the price tried to go lower and came back. One touch per day.
  zone     created by the first touch: band = [low, low x (1 + tol)]. A later touch joins the zone when its low is inside
           the band; a deeper low that still keeps every touch within tol moves the band down (it never gets wider than tol).
           A day whose low goes below the band but closes back above it is a touch (a defended wick); the band stays.
  support  a zone with >= 4 touches on 4 different days. RECOGNISED at the close of the 4th touch day (nothing later is used).
  broken   the first daily CLOSE below the band's low. A zone broken before its 4th touch never becomes a support.
  periods  A = BTC's first touch -> break (or the end of the data);  B = close of BTC's 4th touch -> break (or the end).
  per coin in each period: the coin's own supports (same rule) that are recognised by the end of the period and not
           broken before it starts; held or broken inside the period; recognised before / same day / after BTC;
           broken before / same day / after BTC; largest fall = lowest low in the period vs the close at its start.
"""
import argparse, csv, json, os, sys, time, urllib.request, urllib.error, tarfile
from datetime import datetime, timezone, timedelta

D_MS = 86_400_000
day = lambda ms: datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def env_symbols():
    for p in (".env", os.path.join(os.path.dirname(__file__), "..", ".env")):
        if os.path.exists(p):
            for line in open(p, encoding="utf-8"):
                if line.strip().startswith("SYMBOLS="):
                    return [s.strip().upper() for s in line.split("=", 1)[1].strip().strip('"').strip("'").split(",") if s.strip()]
    return []


def klines_1d(sym, start, end):
    base = os.environ.get("BINANCE_FAPI_URL", "https://fapi.binance.com")
    url = f"{base}/fapi/v1/klines?symbol={sym}&interval=1d&startTime={start}&endTime={end - 1}&limit=1500"
    for i in range(5):
        try:
            rows = json.loads(urllib.request.urlopen(url, timeout=30).read())
            return [dict(t=int(r[0]), o=float(r[1]), h=float(r[2]), l=float(r[3]), c=float(r[4]), v=float(r[5])) for r in rows if int(r[6]) < end]
        except urllib.error.HTTPError as e:
            if e.code == 400: raise SystemExit(f"{sym}: Binance says {e.read().decode()[:150]}")
            time.sleep(2 ** i)
        except Exception:
            time.sleep(2 ** i)
    raise SystemExit(f"{sym}: download failed")


def atr_pct(k):
    tr = [max(k[i]["h"] - k[i]["l"], abs(k[i]["h"] - k[i - 1]["c"]), abs(k[i]["l"] - k[i - 1]["c"])) / k[i - 1]["c"] for i in range(1, len(k))]
    return 100 * sum(tr) / len(tr)


def supports(k, tol):
    """k: closed daily candles in time order. Returns every zone with its touches (indices), recognition and break."""
    zones = []
    for i in range(1, len(k)):
        lo, cl, prev = k[i]["l"], k[i]["c"], k[i - 1]["c"]
        # 1) breaks first: a close below an alive zone's band ends it
        for z in zones:
            if z["broken"] is None and i > z["touches"][-1] and cl < z["lo"]:
                z["broken"] = i
        # 2) touch: came from above, low reached the band (or below it), close back above the band
        hit = None
        for z in zones:
            if z["broken"] is not None or i in z["touches"]: continue
            hi = z["lo"] * (1 + tol / 100)
            if prev > hi and lo <= hi and cl > hi:
                hit = z; break
        if hit is not None:
            top = max(k[j]["l"] for j in hit["touches"])
            if lo < hit["lo"] and lo >= top / (1 + tol / 100):
                hit["lo"] = lo                                     # deeper low, all touches still within tol
            hit["touches"].append(i)
            if len(hit["touches"]) == 4: hit["recog"] = i
            continue
        # 3) a new candidate zone from a defended low (came from above, closed above its own low by the band)
        if prev > lo * (1 + tol / 100) and cl > lo * (1 + tol / 100):
            zones.append(dict(lo=lo, touches=[i], recog=None, broken=None))
    for z in zones:
        z["hi"] = z["lo"] * (1 + tol / 100)
    return zones


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols"); ap.add_argument("--days", type=int, default=61); ap.add_argument("--tol", type=float, default=0.5)
    ap.add_argument("--out", default=os.path.join("reports", "btc-support"))
    a = ap.parse_args()
    coins = [s.upper() for s in a.symbols.split(",")] if a.symbols else env_symbols()
    coins = [c for c in coins if c != "BTCUSDT"]
    if not coins: raise SystemExit("no coin list: give --symbols or set SYMBOLS in .env")
    os.makedirs(a.out, exist_ok=True)
    today = int(time.time() * 1000) // D_MS * D_MS
    start = today - a.days * D_MS; pre = start - 15 * D_MS
    log = []
    say = lambda s="": (print(s), log.append(s))
    say(f"═══ BTC 4-touch supports vs {len(coins)} coins · {day(start)} → {day(today - D_MS)} (closed UTC days) · tol BTC {a.tol}% ═══")
    data = {}
    for s in ["BTCUSDT"] + coins:
        k = klines_1d(s, pre, today); time.sleep(0.2)
        got = {x["t"] for x in k}
        miss = [day(t) for t in range(pre, today, D_MS) if t not in got]
        data[s] = k
        with open(os.path.join(a.out, f"{s}-1d.csv"), "w", newline="") as f:
            w = csv.writer(f); w.writerow(["date", "open", "high", "low", "close", "volume"])
            for x in k: w.writerow([day(x["t"]), x["o"], x["h"], x["l"], x["c"], x["v"]])
        say(f"  {s:14s} {len(k)} daily candles {day(k[0]['t']) if k else '-'} → {day(k[-1]['t']) if k else '-'}" + (f" · MISSING {len(miss)}: {', '.join(miss[:8])}" if miss else " · complete"))
    def split(k): return [x for x in k if x["t"] < start], [x for x in k if x["t"] >= start]
    bpre, bk = split(data["BTCUSDT"]); batr = atr_pct(bpre[-15:])
    tols = {"BTCUSDT": a.tol}
    for c in coins:
        p, kk = split(data[c])
        tols[c] = a.tol * atr_pct(p[-15:]) / batr if len(p) >= 15 else None
    say(f"  BTC daily ATR (14d before the window) {batr:.2f}% · coin tolerances: " + ", ".join(f"{c.replace('USDT','')} {tols[c]:.2f}%" for c in coins if tols[c]))
    Z = {s: supports(split(data[s])[1], tols[s]) for s in ["BTCUSDT"] + coins if tols.get(s)}
    K = {s: split(data[s])[1] for s in Z}
    D = lambda s, i: day(K[s][i]["t"]) if i is not None else None
    btc = [z for z in Z["BTCUSDT"] if z["recog"] is not None]
    say(f"\nBTC zones with >=1 touch: {len(Z['BTCUSDT'])} · with >=2: {sum(len(z['touches'])>=2 for z in Z['BTCUSDT'])} · with >=3: {sum(len(z['touches'])>=3 for z in Z['BTCUSDT'])} · SUPPORTS (>=4): {len(btc)}")
    res = dict(window=[day(start), day(today - D_MS)], tol=tols, btc_atr=batr, btc=[], coins=coins)
    say("\n| BTC support | first touch | 4th touch | end | touches | held/broke |")
    for z in btc:
        say(f"| {z['lo']:,.0f}–{z['hi']:,.0f} | {D('BTCUSDT', z['touches'][0])} | {D('BTCUSDT', z['recog'])} | {D('BTCUSDT', z['broken']) or 'active at data end'} | {len(z['touches'])} ({', '.join(D('BTCUSDT', j) for j in z['touches'])}) | {'BROKE' if z['broken'] is not None else 'held'} |")
    nB = len(K["BTCUSDT"])
    for z in btc:
        out = dict(zone=[z["lo"], z["hi"]], touches=[D("BTCUSDT", j) for j in z["touches"]], recog=D("BTCUSDT", z["recog"]), broken=D("BTCUSDT", z["broken"]), periods={})
        bend = z["broken"] if z["broken"] is not None else nB - 1
        for pname, p0 in (("A", z["touches"][0]), ("B", z["recog"])):
            say(f"\n── BTC {z['lo']:,.0f}–{z['hi']:,.0f} · period {pname}: {D('BTCUSDT', p0)} → {D('BTCUSDT', bend)} ──")
            say("| coin | own support | touches | held/broke in period | recognised vs BTC | broke vs BTC | largest fall |")
            rows = []; cnt = dict(held=0, broke_before=0, broke_same=0, broke_after=0, none=0)
            t0, t1 = K["BTCUSDT"][p0]["t"], K["BTCUSDT"][bend]["t"]
            bfall = 100 * (min(x["l"] for x in K["BTCUSDT"][p0:bend + 1]) / K["BTCUSDT"][p0]["c"] - 1)
            for c in coins:
                if c not in Z: continue
                kc = K[c]; idx = {x["t"]: i for i, x in enumerate(kc)}
                if t0 not in idx or t1 not in idx: continue
                i0, i1 = idx[t0], idx[t1]
                fall = 100 * (min(x["l"] for x in kc[i0:i1 + 1]) / kc[i0]["c"] - 1)
                own = [s for s in Z[c] if s["recog"] is not None and s["recog"] <= i1 and (s["broken"] is None or s["broken"] >= i0)]
                if not own:
                    cnt["none"] += 1; rows.append(dict(coin=c, own=None, fall=fall)); say(f"| {c.replace('USDT','')} | none | – | – | – | – | {fall:+.1f}% |"); continue
                s = max(own, key=lambda s: s["recog"])                       # the most recent own support in the period
                br_in = s["broken"] is not None and s["broken"] <= i1
                rv = "before" if s["recog"] < z["recog"] else "same day" if s["recog"] == z["recog"] else "after"
                if br_in:
                    bb = "before BTC" if (z["broken"] is None or s["broken"] < z["broken"]) else "same day" if s["broken"] == z["broken"] else "after BTC"
                    key = {"before BTC": "broke_before", "same day": "broke_same", "after BTC": "broke_after"}[bb]
                else: bb = "–"; key = "held"
                cnt[key] += 1
                rows.append(dict(coin=c, own=[s["lo"], s["hi"]], touches=[day(kc[j]["t"]) for j in s["touches"]], recog=day(kc[s["recog"]]["t"]),
                                 broken=day(kc[s["broken"]]["t"]) if s["broken"] is not None else None, held=not br_in, recog_vs_btc=rv, broke_vs_btc=bb, fall=fall))
                say(f"| {c.replace('USDT','')} | {s['lo']:.6g}–{s['hi']:.6g} | {len(s['touches'])} | {'BROKE ' + day(kc[s['broken']]['t']) if br_in else 'held'} | {rv} ({day(kc[s['recog']]['t'])}) | {bb} | {fall:+.1f}% |")
            say(f"BTC largest fall in the period {bfall:+.1f}% · coins: held own support {cnt['held']} · broke before BTC {cnt['broke_before']} · same day {cnt['broke_same']} · after BTC {cnt['broke_after']} · no clear support {cnt['none']}")
            out["periods"][pname] = dict(start=D("BTCUSDT", p0), end=D("BTCUSDT", bend), btc_fall=bfall, counts=cnt, coins=rows)
        res["btc"].append(out)
    if not btc: say("\nNo BTC support with 4 touches in this window -- the rule was NOT changed.")
    res["btc_zones_all"] = [dict(zone=[z["lo"], z["hi"]], touches=[D("BTCUSDT", j) for j in z["touches"]], broken=D("BTCUSDT", z["broken"])) for z in Z["BTCUSDT"]]
    res["coin_zones"] = {c: [dict(zone=[s["lo"], s["hi"]], touches=[day(K[c][j]["t"]) for j in s["touches"]], recog=day(K[c][s["recog"]]["t"]) if s["recog"] is not None else None,
                                  broken=day(K[c][s["broken"]]["t"]) if s["broken"] is not None else None) for s in Z[c] if len(s["touches"]) >= 2] for c in coins if c in Z}
    json.dump(res, open(os.path.join(a.out, "results.json"), "w"), indent=1)
    open(os.path.join(a.out, "report.txt"), "w").write("\n".join(log) + "\n")
    with tarfile.open(os.path.join(os.path.dirname(a.out) or ".", "btc-support.tgz"), "w:gz") as t: t.add(a.out, arcname="btc-support")
    print(f"\npack: {os.path.join(os.path.dirname(a.out) or '.', 'btc-support.tgz')}")


if __name__ == "__main__":
    main()
