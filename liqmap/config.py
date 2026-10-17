import os
COINS = ["ADA", "ALGO", "AVAX", "BCH", "BNB", "BTC", "DOGE", "DOT", "ENA", "ETH", "HBAR", "HYPE", "LINK", "LTC", "NEAR", "ONDO", "SOL",
         "STRK", "SUI", "UNI", "WLD", "XLM", "XRP", "XTZ", "ZEC"]
COINS = [c + "USDT" for c in COINS]
HOME = os.environ.get("LIQMAP_HOME", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
HISTORY_DAYS = 28          # bootstrap depth (Binance openInterestHist keeps ~30 days; 28 leaves a margin)
BAR_MS = 300_000
# scenarios = the research v3 set: 27 memory scenarios + 3 short-memory (24h) ones for the "memory vs 24h agree" check
MEMORY = [(m, o, c, None) for m in ("M1", "M2", "M3") for o in ("P", "YF", "OF") for c in (0.0, 0.02, 0.08)]
SHORTMEM = [(m, "P", 0.02, 24) for m in ("M1", "M2", "M3")]
SCENARIOS = MEMORY + SHORTMEM
def scen_name(s):
    m, o, c, w = s; return f"{m}-{o}-c{c:g}" + (f"-W{w}" if w else "")
STEP_PCT = 0.25            # density bin width (% of price)
RANGE_PCT = 12.0           # map range each side
