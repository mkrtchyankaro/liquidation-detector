#!/usr/bin/env python3
"""WALL DATA EXPORT (read-only research collector), 2026-10-16.

Collects everything needed to study OI changes and real liquidations around our 4H zigzag walls, and writes ONE ZIP.
No trading, no signals, no TP/SL. The DB is only READ (find / listIndexes / estimatedDocumentCount); nothing is written to it.

Window: [--start, last complete UTC hour at run time). Default start 2026-10-02 00:00 UTC.
Sources
  Binance USDT-M futures (public, no keys):
    /fapi/v1/klines              4H (from --h4-start, history needed to rebuild walls), 1H (from --h1-start), 5m (window only)
    /futures/data/openInterestHist  period=5m, window only (Binance keeps about the last 30 days)
  Our MongoDB (project .env: MONGO_URI, MONGO_OWN_DB default "liquidation_detector"), read-only:
    liq_raw_events   every stored liquidation event in the window, ALL original fields (TTL 14 days -> run soon)
    minute_bars      per-minute collector rows in the window (used for liquidation coverage: was the collector alive?)
  Walls: the project's research wall map (wallmap.py + zigzag.py in this kit; identical rules, only the data cut is configurable),
         run with CLEAN=1 FAR=30 on the downloaded 4H candles, cut at the window end. Needs pandas + numpy; if missing, the walls step
         is SKIPPED (reported) and can be rebuilt later from candles_4h.csv.

Usage (from the project folder that contains .env and node_modules):
    python3 /path/to/wall_data_kit/wall_data_export.py --project .
Options: --start "2026-10-02 00:00"  --out DIR  --skip-db  --skip-walls  --db-mode auto|pymongo|node
Standard library only for Binance/ZIP. DB: pymongo if installed, otherwise the project's own node 'mongodb' driver.
"""
import argparse, csv, datetime as dt, hashlib, json, os, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request, zipfile

COINS = ["ADA", "ALGO", "AVAX", "BCH", "BNB", "BTC", "DOGE", "DOT", "ENA", "ETH", "HBAR", "HYPE", "LINK", "LTC", "NEAR", "ONDO", "SOL",
         "STRK", "SUI", "UNI", "WLD", "XLM", "XRP", "XTZ", "ZEC"]           # the project's 25 coins (same list as the research exports)
COINS = [c + "USDT" for c in COINS]
KIT = os.path.dirname(os.path.abspath(__file__))
UTC = dt.timezone.utc
IV_MS = {"5m": 300_000, "1h": 3_600_000, "4h": 14_400_000}
LOG = []


def log(msg):
    line = f"[{dt.datetime.now(UTC).strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True); LOG.append(line)


def ms(s):
    return int(dt.datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=UTC).timestamp() * 1000)


def iso(m, sec=False):
    return dt.datetime.fromtimestamp(m / 1000, UTC).strftime("%Y-%m-%d %H:%M:%S" if sec else "%Y-%m-%d %H:%M")


# ------------------------------------------------------------------ HTTP with retry + rate limit
class Http:
    def __init__(self, base_fapi, min_gap=0.25):
        self.base = base_fapi.rstrip("/"); self.min_gap = min_gap; self.last = 0.0; self.calls = 0; self.retries = 0

    def get(self, path, params, tries=8):
        url = self.base + path + "?" + urllib.parse.urlencode(params)
        for a in range(tries):
            gap = time.time() - self.last
            if gap < self.min_gap: time.sleep(self.min_gap - gap)
            self.last = time.time(); self.calls += 1
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "wall-data-export/1.0"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    used = r.headers.get("X-MBX-USED-WEIGHT-1M")
                    body = json.loads(r.read().decode())
                    if used and int(used) > 1800: log(f"weight {used}/2400 -> pause 20 s"); time.sleep(20)
                    return body
            except urllib.error.HTTPError as e:
                txt = e.read().decode(errors="replace")[:300]
                if e.code in (418, 429):
                    wait = int(e.headers.get("Retry-After") or 60); log(f"HTTP {e.code} rate limit -> wait {wait} s"); time.sleep(wait)
                elif e.code >= 500:
                    time.sleep(min(60, 2 ** a))
                else:
                    raise RuntimeError(f"HTTP {e.code} {path} {params}: {txt}")
            except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
                time.sleep(min(60, 2 ** a)); log(f"network error {type(e).__name__}: {e} (retry {a + 1})")
            self.retries += 1
        raise RuntimeError(f"giving up after {tries} tries: {path} {params}")


# ------------------------------------------------------------------ gaps / coverage helpers
def gaps(times, start, end, step):
    """missing grid points in [first_available, end) and before first (listing); returns (expected, missing_list)."""
    have = set(times); exp = list(range(start, end, step)); miss = [t for t in exp if t not in have]
    return len(exp), miss


def ranges(miss, step):
    out = []
    for t in miss:
        if out and t == out[-1][1] + step: out[-1][1] = t
        else: out.append([t, t])
    return ";".join(f"{iso(a)}..{iso(b)}" if a != b else iso(a) for a, b in out)


# ------------------------------------------------------------------ Binance downloads
def klines(http, sym, iv, start, end):
    step = IV_MS[iv]; rows = {}; cur = start
    while cur < end:
        data = http.get("/fapi/v1/klines", {"symbol": sym, "interval": iv, "startTime": cur, "endTime": end - 1, "limit": 1500})
        if not data: break
        for k in data:
            ot = int(k[0])
            if start <= ot and ot + step <= end: rows[ot] = k               # closed candles only, dedupe by open time
        nxt = int(data[-1][0]) + step
        if nxt <= cur: break
        cur = nxt
        if len(data) < 1500 and cur >= end: break
    return [rows[t] for t in sorted(rows)]


def oi_hist(http, sym, start, end):
    """openInterestHist 5m in chunks of <= 500 points (each chunk fully inside its own [s, e] window -> independent of server ordering)."""
    step = IV_MS["5m"]; rows = {}; dup = 0; s = start
    while s < end:
        e = min(end - 1, s + 499 * step)
        data = http.get("/futures/data/openInterestHist", {"symbol": sym, "period": "5m", "startTime": s, "endTime": e, "limit": 500})
        for r in data or []:
            t = int(r["timestamp"])
            if start <= t < end:
                if t in rows: dup += 1
                rows[t] = r
        s = e + 1
    return [rows[t] for t in sorted(rows)], dup


# ------------------------------------------------------------------ DB (read-only)
def read_env(project):
    env = {}
    p = os.path.join(project, ".env")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line: continue
            k, v = line.split("=", 1); env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("MONGO_URI", "MONGO_OWN_DB"):
        if os.environ.get(k): env[k] = os.environ[k]
    return env


def jsonable(v):
    if isinstance(v, dt.datetime):
        if v.tzinfo is None: v = v.replace(tzinfo=UTC)
        return v.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    if isinstance(v, (dict, list)): return json.dumps(v, default=str)
    if v is None: return ""
    t = type(v).__name__
    if t in ("ObjectId", "Decimal128", "Int64"): return str(v)
    return v


def db_pymongo(uri, dbname, start, end, outdir):
    import pymongo
    cli = pymongo.MongoClient(uri, readPreference="secondaryPreferred", appname="wall-data-export-readonly")
    try:
        db = cli[dbname]; inv = {"db_name": dbname, "collections": {}}
        for c in ("liq_raw_events", "minute_bars"):
            inv["collections"][c] = {"estimated_docs": db[c].estimated_document_count(),
                                     "indexes": [{"key": dict(i["key"]), "ttl_seconds": i.get("expireAfterSeconds")} for i in db[c].list_indexes()]}
        with open(os.path.join(outdir, "liq.jsonl"), "w") as f:
            for sym in COINS:
                for d in db.liq_raw_events.find({"symbol": sym, "timestamp": {"$gte": start, "$lt": end}}).sort("timestamp", 1):
                    f.write(json.dumps({k: jsonable(v) for k, v in d.items()}) + "\n")
        with open(os.path.join(outdir, "mb.jsonl"), "w") as f:
            s, e = dt.datetime.fromtimestamp(start / 1000, UTC), dt.datetime.fromtimestamp(end / 1000, UTC)
            for sym in COINS:
                for d in db.minute_bars.find({"symbol": sym, "ts": {"$gte": s, "$lt": e}}, {"_id": 0}).sort("ts", 1):
                    f.write(json.dumps({k: jsonable(v) for k, v in d.items()}) + "\n")
        return inv
    finally:
        cli.close()


NODE_JS = r"""
// READ-ONLY: find / listIndexes / estimatedDocumentCount only. Usage: node x.cjs <project> <start_ms> <end_ms> <outdir> <coins_csv>
"use strict";
const path = require("path"), fs = require("fs");
const [P, S, E, OUT, CO] = process.argv.slice(2); const start = Number(S), end = Number(E), coins = CO.split(",");
require(path.join(P, "node_modules", "dotenv")).config({ path: path.join(P, ".env") });
const { MongoClient } = require(path.join(P, "node_modules", "mongodb"));
const conv = (v) => v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : (v && v._bsontype) ? String(v) :
  (typeof v === "object") ? JSON.stringify(v) : v;
(async () => {
  const cli = new MongoClient(process.env.MONGO_URI, { readPreference: "secondaryPreferred", appName: "wall-data-export-readonly" });
  await cli.connect();
  try {
    const db = cli.db(process.env.MONGO_OWN_DB || "liquidation_detector"); const inv = { db_name: db.databaseName, collections: {} };
    for (const c of ["liq_raw_events", "minute_bars"]) {
      inv.collections[c] = { estimated_docs: await db.collection(c).estimatedDocumentCount(),
        indexes: (await db.collection(c).listIndexes().toArray()).map((i) => ({ key: i.key, ttl_seconds: i.expireAfterSeconds })) };
    }
    const dump = async (file, coll, qf, proj) => {
      const w = fs.createWriteStream(path.join(OUT, file));
      for (const sym of coins) {
        const cur = db.collection(coll).find(qf(sym), { projection: proj }).sort({ [coll === "minute_bars" ? "ts" : "timestamp"]: 1 });
        for await (const d of cur) { const o = {}; for (const [k, v] of Object.entries(d)) o[k] = conv(v);
          if (!w.write(JSON.stringify(o) + "\n")) await new Promise((r) => w.once("drain", r)); }
      }
      await new Promise((r) => w.end(r));
    };
    await dump("liq.jsonl", "liq_raw_events", (s) => ({ symbol: s, timestamp: { $gte: start, $lt: end } }), {});
    await dump("mb.jsonl", "minute_bars", (s) => ({ symbol: s, ts: { $gte: new Date(start), $lt: new Date(end) } }), { _id: 0 });
    fs.writeFileSync(path.join(OUT, "inv.json"), JSON.stringify(inv));
  } finally { await cli.close(); }
})().catch((e) => { console.error("db read failed: " + (e && e.message ? e.message : e)); process.exit(1); });
"""


def db_node(project, start, end, outdir):
    js = os.path.join(outdir, "db_read_only.cjs"); open(js, "w").write(NODE_JS)
    r = subprocess.run(["node", js, project, str(start), str(end), outdir, ",".join(COINS)], capture_output=True, text=True)
    if r.returncode != 0: raise RuntimeError("node DB read failed: " + (r.stderr or r.stdout)[-500:])
    os.remove(js)
    return json.load(open(os.path.join(outdir, "inv.json")))


def jsonl_to_csv(src, dst, first_cols):
    keys, n = [], 0
    with open(src) as f:
        for line in f:
            for k in json.loads(line):
                if k not in keys: keys.append(k)
            n += 1
    cols = [c for c in first_cols if c in keys] + sorted(k for k in keys if k not in first_cols)
    return cols, n


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default=".")
    ap.add_argument("--start", default="2026-10-02 00:00", help="window start, UTC 'YYYY-MM-DD HH:MM'")
    ap.add_argument("--end", default=None, help="window end (default: last complete UTC hour now)")
    ap.add_argument("--h4-start", default="2025-04-01 00:00", help="4H history start (walls need long history)")
    ap.add_argument("--h1-start", default="2026-09-01 00:00", help="1H history start (context / ATR before the window)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--skip-db", action="store_true"); ap.add_argument("--skip-walls", action="store_true")
    ap.add_argument("--db-mode", default="auto", choices=["auto", "pymongo", "node"])
    ap.add_argument("--fapi", default="https://fapi.binance.com", help=argparse.SUPPRESS)       # test hook only
    a = ap.parse_args()

    project = os.path.abspath(a.project)
    now = dt.datetime.now(UTC)
    END = ms(a.end) if a.end else int(now.replace(minute=0, second=0, microsecond=0).timestamp() * 1000)
    START = ms(a.start)
    if START >= END: sys.exit("start must be before the last complete hour")
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    out = os.path.abspath(a.out or os.path.join(project, "reports", f"wall-data-{stamp}"))
    if os.path.exists(out): sys.exit(f"{out} exists - refusing to overwrite")
    os.makedirs(out); work = tempfile.mkdtemp(prefix="walldata_")
    log(f"window [{iso(START)}, {iso(END)}) UTC  ->  {out}")
    http = Http(a.fapi); cov = []; errors = []; counts = {}

    # ---- 1. candles
    specs = [("4h", ms(a.h4_start)), ("1h", ms(a.h1_start)), ("5m", START)]
    for iv, s0 in specs:
        path = os.path.join(out, f"candles_{iv}.csv"); n_all = 0
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["symbol", "interval", "open_time_ms", "open_time_utc", "close_time_utc", "open", "high", "low", "close", "volume",
                        "quote_volume", "trades", "taker_buy_base", "taker_buy_quote", "binance_close_time_ms"])
            for sym in COINS:
                try:
                    rows = klines(http, sym, iv, s0, END)
                except Exception as e:
                    errors.append(f"klines {iv} {sym}: {e}"); log(errors[-1]); rows = []
                for k in rows:
                    ot = int(k[0])
                    w.writerow([sym, iv, ot, iso(ot), iso(ot + IV_MS[iv]), k[1], k[2], k[3], k[4], k[5], k[7], k[8], k[9], k[10], k[6]])
                t = [int(k[0]) for k in rows]
                first = t[0] if t else None
                exp, miss = gaps(t, first if first is not None else s0, END, IV_MS[iv]) if t else (0, [])
                cov.append(dict(dataset=f"candles_{iv}", symbol=sym, requested_from=iso(s0), requested_to=iso(END),
                                first=iso(first) if t else "", last=iso(t[-1]) if t else "", rows=len(t), expected_from_first=exp,
                                missing=len(miss), missing_ranges=ranges(miss, IV_MS[iv])[:2000], starts_late=bool(t and first > s0),
                                status="OK" if t and not miss else ("NO_DATA" if not t else "GAPS")))
                counts.setdefault(sym, {})[f"candles_{iv}"] = len(t); n_all += len(t)
        log(f"candles {iv}: {n_all} rows")

    # ---- 2. open interest 5m
    with open(os.path.join(out, "oi_5m.csv"), "w", newline="") as f:
        w = None; n_all = 0
        for sym in COINS:
            try:
                rows, dup = oi_hist(http, sym, START, END)
            except Exception as e:
                errors.append(f"openInterestHist {sym}: {e}"); log(errors[-1]); rows, dup = [], 0
            for r in rows:
                if w is None:
                    fields = ["symbol", "timestamp_ms", "time_utc"] + [k for k in r if k not in ("symbol", "timestamp")]
                    w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore"); w.writeheader()
                d = {k: v for k, v in r.items() if k != "timestamp"}; d.update(symbol=sym, timestamp_ms=int(r["timestamp"]), time_utc=iso(int(r["timestamp"]), True))
                w.writerow(d)
            t = [int(r["timestamp"]) for r in rows]; exp, miss = gaps(t, START, END, IV_MS["5m"])
            cov.append(dict(dataset="oi_5m", symbol=sym, requested_from=iso(START), requested_to=iso(END), first=iso(t[0]) if t else "",
                            last=iso(t[-1]) if t else "", rows=len(t), expected_from_first=exp, missing=len(miss),
                            missing_ranges=ranges(miss, IV_MS["5m"])[:2000], duplicates_dropped=dup,
                            status="OK" if t and not miss else ("NO_DATA" if not t else "GAPS")))
            counts.setdefault(sym, {})["oi_5m"] = len(t); n_all += len(t)
        if w is None: f.write("symbol,timestamp_ms,time_utc\n")
    log(f"open interest 5m: {n_all} rows")

    # ---- 3. liquidations (read-only DB)
    db_info = {"status": "SKIPPED (--skip-db)"}
    if not a.skip_db:
        env = read_env(project); mode = a.db_mode
        try:
            if mode in ("auto", "pymongo"):
                try:
                    import pymongo  # noqa
                    mode = "pymongo"
                except ImportError:
                    if mode == "pymongo": raise
                    mode = "node"
            if mode == "pymongo":
                if not env.get("MONGO_URI"): raise RuntimeError(f"MONGO_URI not found in {project}/.env")
                inv = db_pymongo(env["MONGO_URI"], env.get("MONGO_OWN_DB") or "liquidation_detector", START, END, work)
            else:
                inv = db_node(project, START, END, work)
            db_info = {"status": "OK", "driver": mode, "inventory": inv}
            # liquidations_raw.csv : every event, all original fields
            first = ["symbol", "timestamp", "time_utc", "victim", "side", "price", "avgPrice", "averagePrice", "qty", "quantity", "origQty",
                     "lastFilledQty", "filledQty", "quoteQty", "usd", "eventTime", "eventTimeDate", "_id"]
            cols, n = jsonl_to_csv(os.path.join(work, "liq.jsonl"), None, first)
            cols = [c for c in cols if c != "time_utc"]; cols = cols[:1] + ["timestamp_ms", "time_utc"] + [c for c in cols[1:] if c != "timestamp"]
            has_qty = any(c in cols for c in ("qty", "quantity", "origQty", "lastFilledQty", "filledQty"))
            if not has_qty: cols.append("qty_derived_quoteQty_div_price")
            per = {}; hours = {}
            with open(os.path.join(work, "liq.jsonl")) as fi, open(os.path.join(out, "liquidations_raw.csv"), "w", newline="") as fo:
                w = csv.DictWriter(fo, fieldnames=cols, extrasaction="ignore"); w.writeheader()
                for line in fi:
                    d = json.loads(line); t = int(float(d.get("timestamp")))
                    d["timestamp_ms"] = t; d["time_utc"] = iso(t, True)
                    if not has_qty:
                        try: d["qty_derived_quoteQty_div_price"] = float(d["quoteQty"]) / float(d["price"])
                        except Exception: d["qty_derived_quoteQty_div_price"] = ""
                    w.writerow(d)
                    s = d.get("symbol"); p = per.setdefault(s, [0, t, t]); p[0] += 1; p[1] = min(p[1], t); p[2] = max(p[2], t)
                    h = hours.setdefault((s, t // 3_600_000 * 3_600_000), [0, 0.0, 0.0])
                    usd = float(d.get("quoteQty") or d.get("usd") or 0); h[0] += 1
                    if str(d.get("victim", "")).upper() == "LONG": h[1] += usd
                    else: h[2] += usd
            # minute_bars -> per hour collector minutes (coverage of the liquidation stream)
            mb = {}
            mcols = None
            with open(os.path.join(work, "mb.jsonl")) as fi, open(os.path.join(out, "db_minute_bars.csv"), "w", newline="") as fo:
                for line in fi:
                    d = json.loads(line)
                    if mcols is None:
                        mcols = ["symbol", "ts"] + sorted(k for k in d if k not in ("symbol", "ts")); w = csv.DictWriter(fo, fieldnames=mcols, extrasaction="ignore"); w.writeheader()
                    w.writerow(d)
                    tt = dt.datetime.strptime(d["ts"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC); hk = int(tt.timestamp() * 1000) // 3_600_000 * 3_600_000
                    mb[(d["symbol"], hk)] = mb.get((d["symbol"], hk), 0) + 1
                if mcols is None: fo.write("symbol,ts\n")
            with open(os.path.join(out, "liq_hourly_coverage.csv"), "w", newline="") as fo:
                w = csv.writer(fo); w.writerow(["symbol", "hour_utc", "collector_minutes", "liq_events", "long_liq_usd", "short_liq_usd", "status"])
                for sym in COINS:
                    bad = 0; empty = 0
                    for hk in range(START, END, 3_600_000):
                        m = mb.get((sym, hk), 0); e = hours.get((sym, hk), [0, 0.0, 0.0])
                        st = "COMPLETE" if m >= 60 else ("NO_COLLECTOR_DATA" if m == 0 else "PARTIAL")
                        bad += st != "COMPLETE"; empty += e[0] == 0
                        w.writerow([sym, iso(hk), m, e[0], round(e[1], 2), round(e[2], 2), st])
                    p = per.get(sym)
                    ttl_risk = bool(p is None or p[1] > START + 3 * 3_600_000)
                    cov.append(dict(dataset="liquidations_raw", symbol=sym, requested_from=iso(START), requested_to=iso(END),
                                    first=iso(p[1], True) if p else "", last=iso(p[2], True) if p else "", rows=p[0] if p else 0,
                                    hours_not_complete=bad, hours_without_events=empty,
                                    status=("NO_DATA" if not p else "FIRST_EVENT_LATE(TTL?)" if ttl_risk else "OK")))
                    counts.setdefault(sym, {})["liquidations"] = p[0] if p else 0
            db_info["liq_events"] = n
            log(f"liquidations: {n} raw events ({mode})")
        except Exception as e:
            db_info = {"status": f"ERROR: {e}"}; errors.append(f"DB: {e}"); log(errors[-1])

    # ---- 4. walls (existing research wall map, CLEAN + FAR30)
    walls_info = {"status": "SKIPPED (--skip-walls)"}
    if not a.skip_walls:
        try:
            import pandas, numpy  # noqa: F401
            k4 = os.path.join(work, "klines_4h.csv")
            with open(os.path.join(out, "candles_4h.csv")) as fi, open(k4, "w", newline="") as fo:
                r = csv.DictReader(fi); w = csv.writer(fo)
                w.writerow(["symbol", "open_time_utc", "close_time_utc", "open", "high", "low", "close", "volume", "quote_volume"])
                for x in r: w.writerow([x["symbol"], x["open_time_utc"], x["close_time_utc"], x["open"], x["high"], x["low"], x["close"], x["volume"], x["quote_volume"]])
            wd = os.path.join(work, "walls"); os.makedirs(wd)
            env = dict(os.environ, CLEAN="1", FAR="30", KLINES=k4, CUT=iso(END), OIDIR=os.path.join(work, "no_oi_archive"),
                       PYTHONPATH=KIT + os.pathsep + os.environ.get("PYTHONPATH", ""))
            rr = subprocess.run([sys.executable, os.path.join(KIT, "wallmap.py")], cwd=wd, env=env, capture_output=True, text=True)
            if rr.returncode != 0: raise RuntimeError(rr.stderr[-800:])
            import pandas as pd
            Wd = pd.read_csv(os.path.join(wd, "wallmap_walls_clean_far30.csv")); T = pd.read_csv(os.path.join(wd, "wallmap_touches_clean_far30.csv"))
            A = pd.read_csv(os.path.join(wd, "wallmap_approaches_clean_far30.csv"))
            s_, e_ = iso(START), iso(END)
            ended = Wd.broken_UTC.fillna("").astype(str)
            Wd["relevant_to_window"] = (Wd.active_UTC < e_) & ((ended == "") | (ended >= s_))
            Wd["approaches_in_window"] = Wd.wall_id.map(A[(A.approach_bar_UTC >= s_) & (A.approach_bar_UTC < e_)].groupby("wall_id").size()).fillna(0).astype(int)
            Wd.drop(columns=[c for c in ("origin_oi_24h_pct", "origin_flag") if c in Wd], inplace=True)   # needs the year OI archive; not exported
            Wd.to_csv(os.path.join(out, "walls.csv"), index=False); T.to_csv(os.path.join(out, "wall_touches.csv"), index=False)
            A.to_csv(os.path.join(out, "wall_approaches.csv"), index=False)
            walls_info = {"status": "OK", "rules": "CLEAN=1 FAR=30, width <= 3 %, zigzag 5 %/10 on 4H, break = 4H close > 1.5 % beyond",
                          "walls_total": int(len(Wd)), "walls_relevant_to_window": int(Wd.relevant_to_window.sum()),
                          "approaches_in_window": int(Wd.approaches_in_window.sum()),
                          "code_sha256": {f: hashlib.sha256(open(os.path.join(KIT, f), "rb").read()).hexdigest() for f in ("wallmap.py", "zigzag.py")}}
            log(f"walls: {len(Wd)} total, {int(Wd.relevant_to_window.sum())} relevant to the window")
        except ImportError:
            walls_info = {"status": "SKIPPED: pandas/numpy not installed (walls can be rebuilt from candles_4h.csv)"}; log(walls_info["status"])
        except Exception as e:
            walls_info = {"status": f"ERROR: {e}"}; errors.append(f"walls: {e}"); log(errors[-1])

    # ---- 5. coverage, manifest, ZIP
    keys = []
    for c in cov:
        for k in c:
            if k not in keys: keys.append(k)
    with open(os.path.join(out, "coverage_report.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); [w.writerow(c) for c in cov]
    files = sorted(x for x in os.listdir(out) if os.path.isfile(os.path.join(out, x)))
    man = {"run_utc": now.strftime("%Y-%m-%d %H:%M:%S"), "window_utc": {"from": iso(START), "to_exclusive": iso(END)},
           "coins": COINS, "history": {"candles_4h_from": a.h4_start, "candles_1h_from": a.h1_start, "candles_5m_from": iso(START)},
           "sources": {"klines": "Binance USDT-M /fapi/v1/klines (closed candles only, deduped by open time)",
                       "open_interest": "Binance /futures/data/openInterestHist period=5m (raw values kept; Binance keeps ~30 days)",
                       "liquidations": "project MongoDB liq_raw_events (read-only, all original fields); minute_bars for collector coverage",
                       "walls": "project research wall map (wallmap.py + zigzag.py of this kit), CLEAN + FAR30"},
           "notes": ["All times UTC. candles: open_time_utc = bar start, close_time_utc = bar end.",
                     "Binance forceOrder stream sends at most one liquidation per symbol per second: totals are a LOWER bound, especially in cascades.",
                     "liq_raw_events has a 14-day TTL: events older than 14 days before the run are already deleted (see coverage_report).",
                     "October 2026 data: descriptive study only (user permission 2026-10-16); no strategy / TP / SL work.",
                     "Wall known time = active_UTC (close of the bar when the 3rd touch became known); touches have known_UTC; the map is computed bar by bar and every event carries the time it became known."],
           "database": db_info, "walls": walls_info, "errors": errors,
           "http": {"calls": http.calls, "retries": http.retries}, "per_coin_counts": counts,
           "files": {x: {"bytes": os.path.getsize(os.path.join(out, x)), "sha256": hashlib.sha256(open(os.path.join(out, x), "rb").read()).hexdigest()} for x in files}}
    json.dump(man, open(os.path.join(out, "manifest.json"), "w"), indent=1, default=str)
    open(os.path.join(out, "run_log.txt"), "w").write("\n".join(LOG) + "\n")
    zp = out + ".zip"
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
        for x in sorted(os.listdir(out)): z.write(os.path.join(out, x), arcname=os.path.join(os.path.basename(out), x))
        for x in ("wall_data_export.py", "wallmap.py", "zigzag.py"): z.write(os.path.join(KIT, x), arcname=os.path.join(os.path.basename(out), "code", x))
    shutil.rmtree(work, ignore_errors=True)

    print("\n================ RESULT ================")
    print(f"ZIP: {zp}  ({os.path.getsize(zp) / 1e6:.1f} MB)")
    for x in sorted(os.listdir(out)): print(f"  {x:28s} {os.path.getsize(os.path.join(out, x)) / 1e6:9.2f} MB")
    print(f"\n{'coin':10s} {'4h':>6s} {'1h':>6s} {'5m':>6s} {'oi_5m':>6s} {'liq':>7s}")
    for sym in COINS:
        c = counts.get(sym, {})
        print(f"{sym:10s} {c.get('candles_4h', 0):6d} {c.get('candles_1h', 0):6d} {c.get('candles_5m', 0):6d} {c.get('oi_5m', 0):6d} {c.get('liquidations', '-'):>7}")
    print(f"\nDB: {db_info.get('status')} | walls: {walls_info.get('status')} | errors: {len(errors)}")
    for e in errors: print("  ERROR", e)
    print("Bad coverage rows:", sum(1 for c in cov if c.get("status") not in ("OK",)), "(see coverage_report.csv)")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
