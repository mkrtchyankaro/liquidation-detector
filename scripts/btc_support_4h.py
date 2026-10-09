#!/usr/bin/env python3
"""
BTC 4H 3-TOUCH SUPPORTS vs OUR COINS (Johnny, Oct 9 2026). READ-ONLY research: Binance PUBLIC 4H klines only (no keys,
no DB). Writes reports/btc-support-4h/ and packs reports/btc-support-4h.tgz. Standard library only.

  python3 scripts/btc_support_4h.py                    # coins = SYMBOLS from .env, last 61 days of CLOSED 4H candles
  options: --symbols A,B,...  --days 61

RULES (agreed with Johnny before any result; the same for every coin):
  tol     BTC: 0.5 % x (BTC 4H ATR% / BTC 1D ATR%), both ATRs from the 14 days BEFORE the window (past only).
          Coin:  BTC tol x (coin 4H ATR% / BTC 4H ATR%), same 14 days -> a more volatile coin gets a wider band.
  touch   a 4H candle whose LOW enters the band while the previous 4H close was ABOVE the band, and whose CLOSE is back
          ABOVE the band (the price tried to go lower and came back). Only lower supports are studied.
  zone    band = [low, low x (1 + tol)] from the first touch. A later touch joins when its low is in the band; a deeper
          low that keeps every touch within tol moves the band down; a deeper wick that closes back above = a touch.
  wall    3 touches within 1 day: the 3rd touch is at most 5 candles after the first (6 candles = 24 h).
          A touch more than 5 candles after the first before the 3rd touch starts the zone again from that touch.
          RECOGNISED at the close of the 3rd touch (nothing later is used for it).
  note    "ACTIVE" walls: "now vs band" = last close vs the band top -- a wall far below the price was never tested again.
  after   every later touch is counted (4th, 5th, ...) until the BREAK = the first 4H CLOSE below the band.
          lifetime = recognition -> break (or "active" at the end of the data).
  coins   for each BTC wall: a coin's MATCHING wall = its own wall recognised between BTC's first touch - 24 h and BTC's
          recognition + 24 h. For it: touches, lifetime, broke before / same candle / after BTC. Every coin: its largest
          fall from BTC's recognition close to BTC's break. Chance level: how many coins would have a wall recognised in a
          window of the same length if walls were spread evenly over the 61 days.
"""
import argparse, csv, json, os, time, urllib.request, urllib.error, tarfile
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


def klines(sym, interval, start, end):
    base = os.environ.get("BINANCE_FAPI_URL", "https://fapi.binance.com"); out = []; s = start
    while s < end:
        url = f"{base}/fapi/v1/klines?symbol={sym}&interval={interval}&startTime={s}&endTime={end - 1}&limit=1500"
        for i in range(5):
            try: rows = json.loads(urllib.request.urlopen(url, timeout=30).read()); break
            except urllib.error.HTTPError as e:
                if e.code == 400: raise SystemExit(f"{sym}: {e.read().decode()[:150]}")
                time.sleep(2 ** i)
            except Exception: time.sleep(2 ** i)
        else: raise SystemExit(f"{sym}: download failed")
        if not rows: break
        out += [dict(t=int(r[0]), o=float(r[1]), h=float(r[2]), l=float(r[3]), c=float(r[4])) for r in rows if int(r[6]) < end]
        s = int(rows[-1][0]) + 1
        if len(rows) < 1500: break
        time.sleep(0.2)
    return out


def atr_pct(k):
    tr = [max(k[i]["h"] - k[i]["l"], abs(k[i]["h"] - k[i - 1]["c"]), abs(k[i]["l"] - k[i - 1]["c"])) / k[i - 1]["c"] for i in range(1, len(k))]
    return 100 * sum(tr) / len(tr)


def walls(k, tol):
    f = 1 + tol / 100; zones = []
    for i in range(1, len(k)):
        lo, cl, prev = k[i]["l"], k[i]["c"], k[i - 1]["c"]
        for z in zones:                                                    # breaks of recognised walls
            if z["recog"] is not None and z["broken"] is None and i > z["touches"][-1] and cl < z["lo"]: z["broken"] = i
        for z in zones:                                                    # unrecognised candidates die on a close below too
            if z["recog"] is None and not z.get("dead") and i > z["touches"][-1] and cl < z["lo"]: z["dead"] = True
        hit = None
        for z in zones:
            if z.get("dead") or z["broken"] is not None or i in z["touches"]: continue
            hi = z["lo"] * f
            if prev > hi and lo <= hi and cl > hi: hit = z; break
        if hit is not None:
            if hit["recog"] is None and i - hit["touches"][0] > 5:            # too late for the 1-day rule: restart from here
                hit["touches"] = [i]; hit["lo"] = lo; continue
            top = max(k[j]["l"] for j in hit["touches"])
            if lo < hit["lo"] and lo >= top / f: hit["lo"] = lo
            hit["touches"].append(i)
            if hit["recog"] is None and len(hit["touches"]) == 3: hit["recog"] = i
            continue
        if prev > lo * f and cl > lo * f: zones.append(dict(lo=lo, touches=[i], recog=None, broken=None))
    W = [z for z in zones if z["recog"] is not None]
    for z in W: z["hi"] = z["lo"] * f
    return sorted(W, key=lambda z: z["recog"])


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--symbols"); ap.add_argument("--days", type=int, default=61)
    ap.add_argument("--out", default=os.path.join("reports", "btc-support-4h")); a = ap.parse_args()
    coins = [s.upper() for s in a.symbols.split(",")] if a.symbols else env_symbols()
    coins = [c for c in coins if c != "BTCUSDT"]
    if not coins: raise SystemExit("no coin list: --symbols or SYMBOLS in .env")
    os.makedirs(a.out, exist_ok=True)
    now = int(time.time() * 1000); end = now // H4 * H4; start = end // D_MS * D_MS - a.days * D_MS; pre = start - 15 * D_MS
    log = []; say = lambda s="": (print(s), log.append(s))
    say(f"═══ BTC 4H 3-touch supports (within 24 h) vs {len(coins)} coins · {ts(start)} → {ts(end)} UTC (closed 4H candles) ═══")
    K = {}; P = {}
    for s in ["BTCUSDT"] + coins:
        k = klines(s, "4h", pre, end); got = {x["t"] for x in k}
        miss = [ts(t) for t in range(pre, end, H4) if t not in got]
        K[s] = [x for x in k if x["t"] >= start]; P[s] = [x for x in k if x["t"] < start]
        with open(os.path.join(a.out, f"{s}-4h.csv"), "w", newline="") as fh:
            w = csv.writer(fh); w.writerow(["time", "open", "high", "low", "close"]); [w.writerow([ts(x["t"]), x["o"], x["h"], x["l"], x["c"]]) for x in k]
        say(f"  {s:14s} {len(K[s])} 4H candles in the window" + (f" · MISSING {len(miss)}: {', '.join(miss[:5])}" if miss else " · complete"))
    bd = klines("BTCUSDT", "1d", pre, start)
    atr4 = {s: atr_pct(P[s][-85:]) for s in K if len(P[s]) >= 85}
    tol = {"BTCUSDT": 0.5 * atr4["BTCUSDT"] / atr_pct(bd[-15:])}
    for c in coins:
        if c in atr4: tol[c] = tol["BTCUSDT"] * atr4[c] / atr4["BTCUSDT"]
    say(f"  BTC 4H ATR {atr4['BTCUSDT']:.2f}% · 1D ATR {atr_pct(bd[-15:]):.2f}% → BTC tol {tol['BTCUSDT']:.3f}% · coins: " + ", ".join(f"{c.replace('USDT','')} {tol[c]:.2f}%" for c in coins if c in tol))
    Wl = {s: walls(K[s], tol[s]) for s in tol}
    T = lambda s, i: K[s][i]["t"]
    bt = Wl["BTCUSDT"]; nB = len(K["BTCUSDT"])
    say(f"\nBTC walls (3 touches within 24 h): {len(bt)}")
    say("| # | BTC zone | 1st touch | recognised (3rd) | touches after recognition | total touches | last touch | broken | lifetime | now vs band |")
    res = dict(window=[ts(start), ts(end)], tol=tol, coins=coins, btc=[])
    for n, z in enumerate(bt, 1):
        after = len(z["touches"]) - 3
        dist = "–" if z["broken"] is not None else "%+.1f%%" % (100 * (K["BTCUSDT"][-1]["c"] / z["hi"] - 1))
        life = (T("BTCUSDT", z["broken"]) - T("BTCUSDT", z["recog"])) / 3600_000 if z["broken"] is not None else (end - T("BTCUSDT", z["recog"]) - H4) / 3600_000
        say(f"| {n} | {z['lo']:,.0f}–{z['hi']:,.0f} | {ts(T('BTCUSDT', z['touches'][0]))} | {ts(T('BTCUSDT', z['recog']) + H4)} | {after} | {len(z['touches'])} | {ts(T('BTCUSDT', z['touches'][-1]) + H4)} | {ts(T('BTCUSDT', z['broken']) + H4) if z['broken'] is not None else 'ACTIVE'} | {life / 24:.1f} d{'+' if z['broken'] is None else ''} | {dist} |")
    tot = [len(z["touches"]) for z in bt]
    if bt:
        say("\nTouch counts: " + ", ".join(f">= {k}: {sum(t >= k for t in tot)}" for k in (3, 4, 5, 6, 7, 8)))
        lifes = sorted(((T("BTCUSDT", z["broken"]) - T("BTCUSDT", z["recog"])) / 3600_000) for z in bt if z["broken"] is not None)
        if lifes: say(f"Lifetime of broken walls (h): median {lifes[len(lifes) // 2]:.0f} · min {lifes[0]:.0f} · max {lifes[-1]:.0f} · still active {sum(z['broken'] is None for z in bt)}")
    # coin walls everywhere (for the chance level)
    span = (end - start) / 3600_000
    for n, z in enumerate(bt, 1):
        t_first, t_rec = T("BTCUSDT", z["touches"][0]), T("BTCUSDT", z["recog"])
        t_brk = T("BTCUSDT", z["broken"]) if z["broken"] is not None else end - H4
        lo_w, hi_w = t_first - D_MS, t_rec + D_MS
        say(f"\n── BTC wall #{n} {z['lo']:,.0f}–{z['hi']:,.0f} · recognised {ts(t_rec + H4)} · {'broken ' + ts(t_brk + H4) if z['broken'] is not None else 'ACTIVE'} ──")
        say("| coin | matching wall | recognised | touches | broken | lifetime | vs BTC break | fall while BTC wall alive |")
        rows = []; c_cnt = dict(match=0, longer=0, before=0, same=0, after=0, active=0); expect = 0.0
        for c in coins:
            if c not in Wl: continue
            ix = {x["t"]: i for i, x in enumerate(K[c])}
            if t_rec not in ix or t_brk not in ix: continue
            seg = K[c][ix[t_rec]:ix[t_brk] + 1]; fall = 100 * (min(x["l"] for x in seg) / K[c][ix[t_rec]]["c"] - 1)
            allw = Wl[c]; expect += min(1.0, len(allw) * ((hi_w - lo_w) / 3600_000) / span)
            m = [w for w in allw if lo_w <= T(c, w["recog"]) <= hi_w]
            if not m:
                rows.append(dict(coin=c, match=None, fall=fall)); say(f"| {c.replace('USDT','')} | none | – | – | – | – | – | {fall:+.1f}% |"); continue
            w = m[0]; c_cnt["match"] += 1
            wb = T(c, w["broken"]) if w["broken"] is not None else None
            lifec = ((wb if wb else end - H4) - T(c, w["recog"])) / 3600_000
            if wb is None: vs = "still active"; c_cnt["active"] += 1
            elif z["broken"] is None or wb < t_brk: vs = "before BTC"; c_cnt["before"] += 1
            elif wb == t_brk: vs = "same candle"; c_cnt["same"] += 1
            else: vs = "after BTC"; c_cnt["after"] += 1
            if (wb or end) > t_brk: c_cnt["longer"] += 1
            rows.append(dict(coin=c, match=[w["lo"], w["hi"]], recog=ts(T(c, w["recog"]) + H4), touches=len(w["touches"]), broken=ts(wb + H4) if wb else None, life_h=lifec, vs=vs, fall=fall))
            say(f"| {c.replace('USDT','')} | {w['lo']:.6g}–{w['hi']:.6g} | {ts(T(c, w['recog']) + H4)} | {len(w['touches'])} | {ts(wb + H4) if wb else 'ACTIVE'} | {lifec / 24:.1f} d | {vs} | {fall:+.1f}% |")
        say(f"BTC: {len(z['touches'])} touches, lifetime {(t_brk - t_rec) / D_MS:.1f} d · coins with a matching wall {c_cnt['match']}/{len(rows)} (chance level ≈ {expect:.1f}) · "
            f"outlived BTC's wall {c_cnt['longer']} · broke before BTC {c_cnt['before']} · same candle {c_cnt['same']} · after {c_cnt['after']} · still active {c_cnt['active']}")
        res["btc"].append(dict(n=n, zone=[z["lo"], z["hi"]], touches=[ts(T("BTCUSDT", j)) for j in z["touches"]], recog=ts(t_rec + H4),
                               broken=ts(t_brk + H4) if z["broken"] is not None else None, coins=rows, counts=c_cnt, chance=expect))
    if not bt: say("\nNo BTC wall with 3 touches within 24 h in this window -- the rule was NOT changed.")
    res["coin_walls"] = {c: [dict(zone=[w["lo"], w["hi"]], touches=[ts(T(c, j)) for j in w["touches"]], recog=ts(T(c, w["recog"]) + H4),
                                  broken=ts(T(c, w["broken"]) + H4) if w["broken"] is not None else None) for w in Wl[c]] for c in coins if c in Wl}
    res["btc_walls"] = [dict(zone=[z["lo"], z["hi"]], touches=[ts(T("BTCUSDT", j)) for j in z["touches"]], recog=ts(T("BTCUSDT", z["recog"]) + H4),
                             broken=ts(T("BTCUSDT", z["broken"]) + H4) if z["broken"] is not None else None) for z in bt]
    json.dump(res, open(os.path.join(a.out, "results.json"), "w"), indent=1)
    open(os.path.join(a.out, "report.txt"), "w").write("\n".join(log) + "\n")
    with tarfile.open(os.path.join(os.path.dirname(a.out) or ".", "btc-support-4h.tgz"), "w:gz") as t: t.add(a.out, arcname="btc-support-4h")
    print(f"\npack: {os.path.join(os.path.dirname(a.out) or '.', 'btc-support-4h.tgz')}")


if __name__ == "__main__":
    main()
