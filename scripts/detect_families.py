#!/usr/bin/env python3
"""
PHASE 1 · 4H STRUCTURAL PRICE FAMILIES (Johnny, Oct 9 2026). READ-ONLY research tool.
It reads our MongoDB (minute_bars) and, for history our DB does not hold, Binance's PUBLIC 4H klines.
It writes only files under reports/families/. It changes nothing in the DB, the collector or the bot.

  python3 scripts/detect_families.py --symbol XRPUSDT --days 20
  options:
    --source auto|db|binance   auto (default): 4H candles our minute_bars fully cover (all 240 minutes) come from the DB,
                               every older / incomplete 4H candle from Binance public klines.
                               db: our DB only (warns when the history is too short).  binance: Binance only.
    --history 180              how many days BEFORE the window are read so that families which started earlier are found
                               with their real start (the detector runs from the first candle; the window only filters)
    --csv5m FILE               offline: build the 4H candles from a 5m kline CSV (t,o,h,l,c,...) instead of DB/Binance
    --out reports/families     where the JSON and CSV go
  needs: python3, pymongo (pip3 install pymongo) for --source auto/db; MONGO_URI from the environment or .env

THE METHOD (unchanged from the phase-1 report; no ATR, no % thresholds, nothing tuned for profit):
  swing         a 4H high (low) that is the max (min) of 5 candles (2 left, 2 right); known 2 candles later
  major swing   a swing high above both its previous and next swing high (low: below both); known when the next one is
  recognition   in a transition: the last two major swings that formed after the break, of opposite kinds (a high and a
                low), with a 4H close between them -> a family is RECOGNISED (forming). Real start = the earlier swing.
  confirmation  the family holds >= 2 major highs and >= 2 major lows (the price turned at least twice at each side)
  boundaries    MAIN = range of the 4H CLOSES from the real start to recognition (may widen by false breaks while forming,
                fixed once confirmed). FULL = high/low incl. wicks up to the break. A wick alone never moves the MAIN.
  break         a 4H CLOSE outside MAIN starts a break test; a close back inside = false break (the family continues).
                The break is CONFIRMED when the first counter-swing after it (a swing high after a break down) closes
                still outside (failed retest), or when price closes one full family height beyond the boundary.
                Then a TRANSITION starts at the break candle and lasts until the next recognition.
  Only CLOSED 4H candles are used, in time order; every swing is used only from the candle it becomes known.
TIMES (UTC): "real start" and a transition's start = the OPEN of that 4H candle; recognised / confirmed / break /
  events = the CLOSE of the 4H candle on which the algorithm knew it. family_id = coin + real start (stable across runs);
  "family" = a running number inside this run only.
"""
import argparse, csv, json, os, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

H4_MS = 4 * 3600_000
MIN_MS = 60_000
L = 2


def utc(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def load_env():
    if os.environ.get("MONGO_URI"):
        return
    for p in (".env", os.path.join(os.path.dirname(__file__), "..", ".env")):
        if os.path.exists(p):
            for line in open(p, encoding="utf-8"):
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            return


# ── data ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
def binance_4h(symbol, start_ms, end_ms):
    """Binance PUBLIC 4H klines [start_ms, end_ms), closed candles only"""
    base = os.environ.get("BINANCE_FAPI_URL", "https://fapi.binance.com")
    out, s = {}, start_ms
    while s < end_ms:
        url = f"{base}/fapi/v1/klines?symbol={symbol}&interval=4h&startTime={s}&endTime={end_ms - 1}&limit=1500"
        for attempt in range(5):
            try:
                rows = json.loads(urllib.request.urlopen(url, timeout=30).read())
                break
            except urllib.error.HTTPError as e:
                if e.code == 400:
                    raise SystemExit(f"Binance does not know the symbol {symbol} ({e.read().decode()[:200]})")
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        if not rows:
            break
        for r in rows:
            t = int(r[0])
            if t + H4_MS <= end_ms:
                out[t] = dict(t=t, o=float(r[1]), h=float(r[2]), l=float(r[3]), c=float(r[4]), src="binance")
        s = int(rows[-1][0]) + H4_MS
        if len(rows) < 1500:
            break
        time.sleep(0.3)
    return out


def db_4h(symbol, start_ms, end_ms):
    """4H candles from our minute_bars; a 4H candle is used only when all 240 of its minutes have a price"""
    try:
        from pymongo import MongoClient
    except ImportError:
        raise SystemExit("pymongo is missing: pip3 install pymongo (or use --source binance)")
    load_env()
    uri = os.environ.get("MONGO_URI")
    if not uri:
        raise SystemExit("MONGO_URI is not set (environment or .env)")
    cli = MongoClient(uri, readPreference="secondaryPreferred", serverSelectionTimeoutMS=15000)
    try:
        col = cli[os.environ.get("MONGO_OWN_DB", "liquidation_detector")]["minute_bars"]
        first = col.find_one({"symbol": symbol}, sort=[("ts", 1)], projection={"ts": 1})
        last = col.find_one({"symbol": symbol}, sort=[("ts", -1)], projection={"ts": 1})
        if not first:
            return {}, None
        span = (int(first["ts"].replace(tzinfo=timezone.utc).timestamp() * 1000), int(last["ts"].replace(tzinfo=timezone.utc).timestamp() * 1000))
        agg = {}
        q = {"symbol": symbol, "ts": {"$gte": datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc), "$lt": datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc)}}
        for b in col.find(q, projection={"_id": 0, "ts": 1, "open": 1, "high": 1, "low": 1, "close": 1}).sort("ts", 1):
            if b.get("close") is None or b.get("high") is None:
                continue
            t = int(b["ts"].replace(tzinfo=timezone.utc).timestamp() * 1000)
            k = t - t % H4_MS
            a = agg.get(k)
            if a is None:
                agg[k] = dict(t=k, o=float(b["open"]), h=float(b["high"]), l=float(b["low"]), c=float(b["close"]), n=1, last=t, first=t)
            else:
                if t < a["first"]:
                    a["first"], a["o"] = t, float(b["open"])
                if t >= a["last"]:
                    a["last"], a["c"] = t, float(b["close"])
                a["h"] = max(a["h"], float(b["high"])); a["l"] = min(a["l"], float(b["low"])); a["n"] += 1
        out = {k: dict(t=k, o=a["o"], h=a["h"], l=a["l"], c=a["c"], src="db") for k, a in agg.items() if a["n"] >= 240 and k + H4_MS <= end_ms}
        return out, span
    finally:
        cli.close()


def csv5m_4h(path, end_ms):
    import gzip
    op = gzip.open if path.endswith(".gz") else open
    agg = {}
    with op(path, "rt") as f:
        for r in csv.DictReader(f):
            t = int(float(r["t"])); k = t - t % H4_MS
            o, h, l, c = float(r["o"]), float(r["h"]), float(r["l"]), float(r["c"])
            a = agg.get(k)
            if a is None:
                agg[k] = dict(t=k, o=o, h=h, l=l, c=c, n=1, first=t, last=t)
            else:
                if t < a["first"]: a["first"], a["o"] = t, o
                if t >= a["last"]: a["last"], a["c"] = t, c
                a["h"] = max(a["h"], h); a["l"] = min(a["l"], l); a["n"] += 1
    return {k: dict(t=k, o=a["o"], h=a["h"], l=a["l"], c=a["c"], src="csv") for k, a in agg.items() if a["n"] == 48 and k + H4_MS <= end_ms}


# ── the detector (phase 1 method) ────────────────────────────────────────────────────────────────────────────────────
def detect(bars):
    T = [b["t"] for b in bars]; h = [b["h"] for b in bars]; l = [b["l"] for b in bars]; c = [b["c"] for b in bars]
    N = len(bars)
    sw = []  # (pivot, known, kind, price)
    for i in range(L, N - L):
        if h[i] == max(h[i - L:i + L + 1]) and h[i] > max(h[i - L:i]):
            sw.append((i, i + L, "H", h[i]))
        if l[i] == min(l[i - L:i + L + 1]) and l[i] < min(l[i - L:i]):
            sw.append((i, i + L, "L", l[i]))
    sw.sort(key=lambda x: (x[1], x[0]))
    mj = []
    for kind in "HL":
        s = [x for x in sw if x[2] == kind]
        for a, b, d in zip(s, s[1:], s[2:]):
            if (kind == "H" and b[3] > a[3] and b[3] > d[3]) or (kind == "L" and b[3] < a[3] and b[3] < d[3]):
                mj.append((b[0], d[1], kind, b[3]))
    mj.sort(key=lambda x: (x[1], x[0]))
    known = {}
    for x in sw: known.setdefault(x[1], []).append(("1",) + x)
    for x in mj: known.setdefault(x[1], []).append(("2",) + x)
    fams, events, transitions = [], [], []
    tr_start, fam, brk = 0, None, None
    lv1, lv2 = [], []

    def ev(i, kind, fam_id, text):
        events.append(dict(time=utc(T[i] + H4_MS), kind=kind, family=fam_id, text=text, close=c[i]))

    for i in range(N):
        for s in known.get(i, []):
            (lv1 if s[0] == "1" else lv2).append(s[1:])
            if fam is not None and s[0] == "2" and s[1] >= fam["start_i"] and brk is None:
                fam["mH" if s[3] == "H" else "mL"] += 1
        if fam is None:
            m = sorted([s for s in lv2 if s[0] >= tr_start], key=lambda s: s[0])
            if len(m) >= 2 and m[-1][2] != m[-2][2]:
                a2, b2 = m[-2], m[-1]
                mh = a2 if a2[2] == "H" else b2
                ml = b2 if mh is a2 else a2
                if ml[3] < c[i] < mh[3]:
                    st = a2[0]
                    transitions.append(dict(from_i=tr_start, to_i=i))
                    fam = dict(id=len(fams) + 1, start_i=st, recog_i=i, conf_i=None, end_i=None, endconf_i=None,
                               ctop=max(c[st:i + 1]), cbot=min(c[st:i + 1]), mH=1, mL=1, false_breaks=0, status="FORMING", brk_up=None, how=None)
                    ev(i, "recognised", fam["id"], "family recognised")
            continue
        if brk is None:
            if c[i] > fam["ctop"] or c[i] < fam["cbot"]:
                brk = dict(i=i, up=c[i] > fam["ctop"], edge=fam["ctop"] if c[i] > fam["ctop"] else fam["cbot"])
                ev(i, "break_test", fam["id"], "4H close outside the main boundary " + ("up" if brk["up"] else "down"))
        else:
            up, edge, height = brk["up"], brk["edge"], fam["ctop"] - fam["cbot"]
            if (c[i] <= edge) if up else (c[i] >= edge):
                if fam["status"] == "FORMING":
                    fam["ctop"] = max(fam["ctop"], max(c[brk["i"]:i])); fam["cbot"] = min(fam["cbot"], min(c[brk["i"]:i]))
                fam["false_breaks"] += 1
                ev(i, "false_break", fam["id"], "closed back inside")
                brk = None
            else:
                retest = any(s[0] > brk["i"] and s[1] == i and s[2] == ("L" if up else "H") and ((c[s[0]] > edge) if up else (c[s[0]] < edge)) for s in lv1)
                far = (c[i] >= edge + height) if up else (c[i] <= edge - height)
                if retest or far:
                    fam.update(end_i=brk["i"] - 1, endconf_i=i, brk_up=up, how="failed retest" if retest else "one family height", status="ENDED")
                    ev(i, "break_confirmed", fam["id"], "structure broken " + ("up" if up else "down"))
                    fam["brk_i"] = brk["i"]
                    fams.append(fam); fam = None; tr_start = brk["i"]; brk = None
                    continue
        if fam is not None and fam["status"] == "FORMING" and fam["mH"] >= 2 and fam["mL"] >= 2:
            fam["status"] = "CONFIRMED"; fam["conf_i"] = i
            ev(i, "confirmed", fam["id"], "family confirmed")
    if fam is not None:
        if brk is not None:
            fam["pending_i"] = brk["i"]; fam["pending_up"] = brk["up"]
        fams.append(fam)
    else:
        transitions.append(dict(from_i=tr_start, to_i=None))
    return fams, events, transitions


def describe(f, bars):
    T = [b["t"] for b in bars]; h = [b["h"] for b in bars]; l = [b["l"] for b in bars]; N = len(bars)
    a = f["start_i"]
    if f["end_i"] is not None: b = f["end_i"]
    elif f.get("pending_i") is not None: b = f["pending_i"] - 1
    else: b = N - 1
    if f["status"] == "ENDED":
        state = "ENDED" if f["conf_i"] is not None else "ENDED_UNCONFIRMED"
    elif f.get("pending_i") is not None:
        state = "BREAK_TEST"
    else:
        state = f["status"]
    ftop, fbot = max(h[a:b + 1]), min(l[a:b + 1])
    return dict(
        family=f["id"], family_id=f"{SYMBOL}-{datetime.fromtimestamp(T[a] / 1000, tz=timezone.utc).strftime('%Y%m%d-%H')}", state=state, confirmed=f["conf_i"] is not None,
        real_start_utc=utc(T[a]), recognised_utc=utc(T[f["recog_i"]] + H4_MS), recognition_lag_hours=(T[f["recog_i"]] + H4_MS - T[a]) // 3600_000,
        confirmed_utc=utc(T[f["conf_i"]] + H4_MS) if f["conf_i"] is not None else None,
        end_utc=utc(T[f["end_i"]] + H4_MS) if f["end_i"] is not None else None,
        break_confirmed_utc=utc(T[f["endconf_i"]] + H4_MS) if f.get("endconf_i") is not None else None,
        break_direction=("up" if f["brk_up"] else "down") if f["brk_up"] is not None else (("up" if f.get("pending_up") else "down") if f.get("pending_i") is not None else None),
        break_how=f["how"], break_test_since_utc=utc(T[f["pending_i"]] + H4_MS) if f.get("pending_i") is not None else None,
        main_top=f["ctop"], main_bottom=f["cbot"], main_width_pct=round(100 * (f["ctop"] / f["cbot"] - 1), 2),
        full_top=ftop, full_bottom=fbot, full_width_pct=round(100 * (ftop / fbot - 1), 2),
        candles_4h=b - a + 1, major_highs=f["mH"], major_lows=f["mL"], false_breaks=f["false_breaks"],
        _a=T[a], _b=T[b] + H4_MS,
    )


SYMBOL = ""
STATE_AM = {"FORMING": "ձևավորվող", "CONFIRMED": "հաստատված", "BREAK_TEST": "ճեղքման փուլում", "ENDED": "ավարտված",
            "ENDED_UNCONFIRMED": "ավարտված (չհաստատված փորձ)"}


def main():
    ap = argparse.ArgumentParser(description="4H structural price families (read-only)")
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--days", type=float, required=True)
    ap.add_argument("--source", choices=["auto", "db", "binance"], default="auto")
    ap.add_argument("--history", type=float, default=180)
    ap.add_argument("--csv5m")
    ap.add_argument("--end", help="offline/testing: treat this UTC time (YYYY-MM-DD HH:MM) as now")
    ap.add_argument("--out", default=os.path.join("reports", "families"))
    a = ap.parse_args()
    global SYMBOL
    sym = a.symbol.upper(); SYMBOL = sym.replace("USDT", "")
    now = int(datetime.strptime(a.end, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp() * 1000) if a.end else int(time.time() * 1000)
    end = now - now % H4_MS                      # only closed 4H candles
    win_from = now - int(a.days * 86400_000)
    hist_from = win_from - int(a.history * 86400_000)
    hist_from -= hist_from % H4_MS
    notes = []
    if a.csv5m:
        candles = csv5m_4h(a.csv5m, end); candles = {k: v for k, v in candles.items() if k >= hist_from}
        src_used = "csv"
    else:
        candles, span = {}, None
        if a.source in ("auto", "db"):
            candles, span = db_4h(sym, hist_from, end)
            if span is None:
                msg = f"our DB (minute_bars) has NO data for {sym}"
                if a.source == "db":
                    raise SystemExit(msg + " -- nothing to detect. (Binance public klines: --source binance)")
                raise SystemExit(msg + " -- stopped. Run with --source binance to use Binance public 4H klines instead.")
            notes.append(f"DB minute_bars for {sym}: {utc(span[0])} -> {utc(span[1])} UTC (mark price from the 1/s polls)")
        if a.source in ("auto", "binance"):
            bn = binance_4h(sym, hist_from, end)
            for k, v in bn.items():
                candles.setdefault(k, v)
        src_used = a.source
    bars = [candles[k] for k in sorted(candles)]
    if len(bars) < 30:
        raise SystemExit(f"only {len(bars)} closed 4H candles for {sym} -- too few to find structure")
    gaps = [(bars[i - 1]["t"], bars[i]["t"]) for i in range(1, len(bars)) if bars[i]["t"] - bars[i - 1]["t"] != H4_MS]
    n_db = sum(1 for b in bars if b["src"] == "db"); n_bn = sum(1 for b in bars if b["src"] == "binance")
    notes.append(f"4H candles: {len(bars)} ({utc(bars[0]['t'])} -> {utc(bars[-1]['t'] + H4_MS)} UTC) · from DB {n_db} · from Binance {n_bn}" + (f" · from CSV {len(bars) - n_db - n_bn}" if a.csv5m else ""))
    if gaps:
        notes.append(f"WARNING: {len(gaps)} gaps in the 4H series, first {utc(gaps[0][0])} -> {utc(gaps[0][1])}")
    if src_used == "db" and bars[0]["t"] > win_from - 20 * 86400_000:
        notes.append("WARNING: DB-only history starts near the window -- a family that started earlier may be missing or shown late")

    fams, events, transitions = detect(bars)
    T = [b["t"] for b in bars]
    rows = [describe(f, bars) for f in fams]
    win = [r for r in rows if r["_b"] > win_from and r["_a"] <= end]
    if win and min(r["_a"] for r in win) <= bars[0]["t"] + 10 * H4_MS:
        notes.append("WARNING: a family starts at the beginning of the read history -- raise --history")
    trs = []
    for tr in transitions:
        a0 = T[tr["from_i"]]; b0 = (T[tr["to_i"]] + H4_MS) if tr["to_i"] is not None else end
        if b0 > win_from and tr["from_i"] > 0:
            trs.append(dict(from_utc=utc(a0), to_utc=utc(b0) if tr["to_i"] is not None else None, ongoing=tr["to_i"] is None))
    evs = [e for e in events if e["time"] >= utc(win_from)]
    current = None
    last = rows[-1] if rows else None
    if last and last["state"] in ("FORMING", "CONFIRMED", "BREAK_TEST"):
        current = f"family {last['family']} · {last['state']}" + (f" since {last['break_test_since_utc']}" if last["state"] == "BREAK_TEST" else "")
    else:
        current = f"TRANSITION since {trs[-1]['from_utc']} -- no new family yet" if trs and trs[-1]["ongoing"] else "TRANSITION"

    # ── terminal ──
    print(f"\n═══ {sym} · 4H structural families · window: last {a.days:g} days ({utc(win_from)} -> {utc(end)} UTC) ═══")
    for n in notes: print("  " + n)
    hdr = ["id", "state", "real start", "recognised", "lag h", "confirmed", "end / break", "main top", "main bot", "main %", "full top", "full bot", "full %", "4H"]
    tab = []
    for r in win:
        endtxt = r["end_utc"] or (f"test since {r['break_test_since_utc']}" if r["state"] == "BREAK_TEST" else "active")
        tab.append([r["family_id"], STATE_AM[r["state"]], r["real_start_utc"], r["recognised_utc"], r["recognition_lag_hours"], r["confirmed_utc"] or "-",
                    endtxt, f"{r['main_top']:.6g}", f"{r['main_bottom']:.6g}", f"{r['main_width_pct']:.2f}", f"{r['full_top']:.6g}", f"{r['full_bottom']:.6g}", f"{r['full_width_pct']:.2f}", r["candles_4h"]])
    w = [max(len(str(x)) for x in col) for col in zip(hdr, *tab)] if tab else [len(x) for x in hdr]
    print("\n  " + "  ".join(str(x).ljust(w[i]) for i, x in enumerate(hdr)))
    for t in tab: print("  " + "  ".join(str(x).ljust(w[i]) for i, x in enumerate(t)))
    if not tab: print("  (no family intersects the window)")
    if trs:
        print("\n  Transitions (old family broken, new one not recognised yet):")
        for t in trs: print(f"    {t['from_utc']} -> {t['to_utc'] or 'NOW (ongoing) -- no new family yet'}")
    print(f"\n  NOW: {current}")
    if evs:
        print("\n  Events in the window (time = close of the 4H candle, UTC):")
        for e in evs: print(f"    {e['time']}  family {e['family']:<3} {e['kind']:<16} close {e['close']:.6g}")

    # ── files ──
    os.makedirs(a.out, exist_ok=True)
    stamp = utc(end).replace(" ", "T").replace(":", "")
    base = os.path.join(a.out, f"{sym}-{a.days:g}d-{stamp}")
    clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in win]
    json.dump(dict(symbol=sym, days=a.days, window_from_utc=utc(win_from), window_to_utc=utc(end), source=src_used, notes=notes,
                   now=current, families=clean, transitions=trs, events=evs, method="phase-1 4H structural families (see the script header)"),
              open(base + ".json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    if clean:
        with open(base + ".csv", "w", newline="", encoding="utf-8") as f:
            wr = csv.DictWriter(f, fieldnames=list(clean[0].keys())); wr.writeheader(); wr.writerows(clean)
    print(f"\n  files: {base}.json  {base}.csv\n")


if __name__ == "__main__":
    main()
