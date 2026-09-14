/**
 * Sep 14 2026 (Karo), operator-requested. READ-ONLY research, BTC
 * only. Parts 2-4 of the ATR audit/redesign: side-by-side causal ATR
 * method comparison, two candidate directional-ATR definitions
 * (compared, not chosen), and event-by-event evolution through
 * BURST A and BURST B.
 *
 * CAUSALITY: identical discipline to every prior pass in this
 * research thread. ATR at a given timestamp uses ONLY the last fully
 * CLOSED candle strictly before that timestamp's own minute -- never
 * the in-progress candle, never a later one. No 1-minute candle's
 * full high/low is used to describe price action between two
 * liquidation events (sub-minute price path does not exist in this
 * system).
 *
 * Two directional-ATR candidates are computed and compared, NOT one
 * chosen as correct:
 *   v1 (prior-close-referenced): DownTR = max(0, prevClose - low),
 *      UpTR = max(0, high - prevClose). Simple, symmetric-by-
 *      construction downside/upside excursion beyond the prior close.
 *   v2 (Wilder's own +DM/-DM, from his original ADX definition):
 *      upMove = high_t - high_{t-1}, downMove = low_{t-1} - low_t;
 *      +DM = upMove if upMove > downMove and upMove > 0 else 0;
 *      -DM = downMove if downMove > upMove and downMove > 0 else 0.
 *      This is the more established, peer-published definition,
 *      specifically designed to avoid double-counting a candle that
 *      has both a higher high AND a lower low.
 * Both are then EMA-smoothed for comparison.
 *
 * No winner is chosen here. No threshold. No production code
 * touched. Parts 5-7 (shock/recovery normalization, pressure
 * efficiency, TP-capacity) are explicitly NOT implemented yet, per
 * the operator's own "first return 1-4" instruction.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";

const SYMBOL = "BTCUSDT";
const VICTIM = "LONG";
const OUTPUT_DIR = path.join(__dirname, "..", "research-output");

const BURSTS = [
  {
    label: "BURST A",
    startIso: "2026-09-10T16:05:04.000Z",
    endIso: "2026-09-10T16:10:13.000Z",
  },
  {
    label: "BURST B",
    startIso: "2026-09-10T16:34:17.000Z",
    endIso: "2026-09-10T16:35:57.000Z",
  },
];

function fmtClock(ms: number) {
  return new Date(ms).toISOString().slice(11, 19);
}
function fmtPct(n: number | null, d?: number) {
  return n === null || n === undefined
    ? "n/a"
    : (n >= 0 ? "+" : "") + n.toFixed(d ?? 2) + "%";
}

function httpsGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}
async function fetchKlines(symbol: string, startTime: number, endTime: number) {
  const m = new Map<
    number,
    { t: number; open: number; high: number; low: number; close: number }
  >();
  let cursor = startTime;
  while (cursor <= endTime) {
    const chunkEnd = Math.min(cursor + 1499 * 60000, endTime);
    const raw = await httpsGetJson(
      "https://fapi.binance.com/fapi/v1/klines?symbol=" +
        symbol +
        "&interval=1m&startTime=" +
        cursor +
        "&endTime=" +
        chunkEnd +
        "&limit=1500",
    );
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw)
      m.set(k[0], {
        t: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
      });
    cursor = raw[raw.length - 1][0] + 60000;
  }
  return m;
}

type Candle = {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

function wilderAtrSeries(
  candlesAsc: Candle[],
  period: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (candlesAsc.length < period + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      p = candlesAsc[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close),
      ),
    );
  }
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  out.set(candlesAsc[period].t, atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out.set(candlesAsc[i + 1].t, atr);
  }
  return out;
}

function smaAtrSeries(
  candlesAsc: Candle[],
  period: number,
): Map<number, number> {
  const out = new Map<number, number>();
  const trs: number[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      p = candlesAsc[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close),
      ),
    );
  }
  for (let i = period - 1; i < trs.length; i++) {
    const slice = trs.slice(i - period + 1, i + 1);
    out.set(candlesAsc[i + 1].t, slice.reduce((s, x) => s + x, 0) / period);
  }
  return out;
}

function emaAtrSeries(
  candlesAsc: Candle[],
  period: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (candlesAsc.length < 2) return out;
  const alpha = 2 / (period + 1);
  const trs: { t: number; tr: number }[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      p = candlesAsc[i - 1];
    trs.push({
      t: c.t,
      tr: Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close),
      ),
    });
  }
  let ema = trs[0].tr;
  out.set(trs[0].t, ema);
  for (let i = 1; i < trs.length; i++) {
    ema = alpha * trs[i].tr + (1 - alpha) * ema;
    out.set(trs[i].t, ema);
  }
  return out;
}

function directionalTrV1(
  candlesAsc: Candle[],
): { t: number; downTr: number; upTr: number }[] {
  const out: { t: number; downTr: number; upTr: number }[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      p = candlesAsc[i - 1];
    out.push({
      t: c.t,
      downTr: Math.max(0, p.close - c.low),
      upTr: Math.max(0, c.high - p.close),
    });
  }
  return out;
}
function directionalTrV2(
  candlesAsc: Candle[],
): { t: number; downTr: number; upTr: number }[] {
  const out: { t: number; downTr: number; upTr: number }[] = [];
  for (let i = 1; i < candlesAsc.length; i++) {
    const c = candlesAsc[i],
      p = candlesAsc[i - 1];
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    out.push({ t: c.t, downTr: minusDM, upTr: plusDM });
  }
  return out;
}
function emaOfSeries(
  series: { t: number; v: number }[],
  period: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (series.length === 0) return out;
  const alpha = 2 / (period + 1);
  let ema = series[0].v;
  out.set(series[0].t, ema);
  for (let i = 1; i < series.length; i++) {
    ema = alpha * series[i].v + (1 - alpha) * ema;
    out.set(series[i].t, ema);
  }
  return out;
}

function lookupCausal(
  seriesMap: Map<number, number>,
  ms: number,
): number | null {
  let t = Math.floor(ms / 60000) * 60000 - 60000;
  for (let i = 0; i < 400; i++) {
    if (seriesMap.has(t)) return seriesMap.get(t)!;
    t -= 60000;
  }
  return null;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGO_OWN_DB || "liquidation_detector");
  const col = db.collection("liq_raw_events");

  const earliest = Math.min(...BURSTS.map((b) => Date.parse(b.startIso)));
  const latest = Math.max(...BURSTS.map((b) => Date.parse(b.endIso)));
  const klines = await fetchKlines(
    SYMBOL,
    earliest - 8 * 3600000,
    latest + 60000,
  );
  const candlesAsc = Array.from(klines.values()).sort((a, b) => a.t - b.t);
  console.log(
    "Fetched " +
      candlesAsc.length +
      " 1m candles, " +
      new Date(candlesAsc[0]?.t ?? 0).toISOString() +
      " to " +
      new Date(candlesAsc[candlesAsc.length - 1]?.t ?? 0).toISOString() +
      "\n",
  );

  const wilder14 = wilderAtrSeries(candlesAsc, 14);
  const sma14 = smaAtrSeries(candlesAsc, 14);
  const ema5 = emaAtrSeries(candlesAsc, 5);
  const ema7 = emaAtrSeries(candlesAsc, 7);
  const ema10 = emaAtrSeries(candlesAsc, 10);
  const ema14 = emaAtrSeries(candlesAsc, 14);
  const wilder240 = wilderAtrSeries(candlesAsc, 240);

  const dtrV1 = directionalTrV1(candlesAsc);
  const dtrV2 = directionalTrV2(candlesAsc);
  const downAtrV1 = emaOfSeries(
    dtrV1.map((d) => ({ t: d.t, v: d.downTr })),
    14,
  );
  const upAtrV1 = emaOfSeries(
    dtrV1.map((d) => ({ t: d.t, v: d.upTr })),
    14,
  );
  const downAtrV2 = emaOfSeries(
    dtrV2.map((d) => ({ t: d.t, v: d.downTr })),
    14,
  );
  const upAtrV2 = emaOfSeries(
    dtrV2.map((d) => ({ t: d.t, v: d.upTr })),
    14,
  );

  for (const b of BURSTS) {
    const startTs = Date.parse(b.startIso),
      endTs = Date.parse(b.endIso);
    console.log("=".repeat(150));
    console.log(b.label + " (" + b.startIso + " -> " + b.endIso + ")");
    console.log("=".repeat(150));

    console.log(
      "\n--- METHOD COMPARISON (causal value as of burst START vs END) ---",
    );
    const methods: [string, Map<number, number>][] = [
      ["Wilder14", wilder14],
      ["SMA14", sma14],
      ["EMA5", ema5],
      ["EMA7", ema7],
      ["EMA10", ema10],
      ["EMA14", ema14],
      ["Wilder240(production common-horizon)", wilder240],
    ];
    for (const [name, series] of methods) {
      const startV = lookupCausal(series, startTs),
        endV = lookupCausal(series, endTs);
      const changePct =
        startV !== null && endV !== null && startV > 0
          ? ((endV - startV) / startV) * 100
          : null;
      console.log(
        "  " +
          name.padEnd(38) +
          " start=" +
          (startV?.toFixed(4) ?? "n/a") +
          "  end=" +
          (endV?.toFixed(4) ?? "n/a") +
          "  change=" +
          fmtPct(changePct),
      );
    }

    console.log(
      "\n--- DIRECTIONAL ATR (EMA14), TWO CANDIDATE DEFINITIONS COMPARED ---",
    );
    for (const [name, downSeries, upSeries] of [
      ["v1 (prior-close-referenced)", downAtrV1, upAtrV1],
      ["v2 (Wilder +DM/-DM from ADX)", downAtrV2, upAtrV2],
    ] as [string, Map<number, number>, Map<number, number>][]) {
      const downStart = lookupCausal(downSeries, startTs),
        downEnd = lookupCausal(downSeries, endTs);
      const upStart = lookupCausal(upSeries, startTs),
        upEnd = lookupCausal(upSeries, endTs);
      const downChangePct =
        downStart !== null && downEnd !== null && downStart > 0
          ? ((downEnd - downStart) / downStart) * 100
          : null;
      const upChangePct =
        upStart !== null && upEnd !== null && upStart > 0
          ? ((upEnd - upStart) / upStart) * 100
          : null;
      console.log("  " + name + ":");
      console.log(
        "    DownATR  start=" +
          (downStart?.toFixed(4) ?? "n/a") +
          "  end=" +
          (downEnd?.toFixed(4) ?? "n/a") +
          "  change=" +
          fmtPct(downChangePct),
      );
      console.log(
        "    UpATR    start=" +
          (upStart?.toFixed(4) ?? "n/a") +
          "  end=" +
          (upEnd?.toFixed(4) ?? "n/a") +
          "  change=" +
          fmtPct(upChangePct),
      );
      const wilderStart = lookupCausal(wilder14, startTs);
      if (downStart !== null && upStart !== null && wilderStart !== null)
        console.log(
          "    sanity check at start: DownATR+UpATR=" +
            (downStart + upStart).toFixed(4) +
            " vs ordinary Wilder14 ATR=" +
            wilderStart.toFixed(4) +
            " (ratio=" +
            ((downStart + upStart) / wilderStart).toFixed(3) +
            ")",
        );
    }

    console.log(
      "\n--- ATR EVOLUTION THROUGH " +
        b.label +
        " (every closed 1m candle inside the burst) ---",
    );
    console.log(
      "timestamp | Wilder14 | EMA14 | DownATR(v1) | UpATR(v1) | DownATR(v2) | UpATR(v2) | %chg from burst start (Wilder14)",
    );
    const wilderAtBurstStart = lookupCausal(wilder14, startTs);
    for (let t = Math.floor(startTs / 60000) * 60000; t <= endTs; t += 60000) {
      const w = lookupCausal(wilder14, t),
        e = lookupCausal(ema14, t);
      const dv1 = lookupCausal(downAtrV1, t),
        uv1 = lookupCausal(upAtrV1, t);
      const dv2 = lookupCausal(downAtrV2, t),
        uv2 = lookupCausal(upAtrV2, t);
      const pctFromStart =
        w !== null && wilderAtBurstStart !== null && wilderAtBurstStart > 0
          ? ((w - wilderAtBurstStart) / wilderAtBurstStart) * 100
          : null;
      console.log(
        fmtClock(t) +
          " | " +
          (w?.toFixed(4) ?? "n/a") +
          " | " +
          (e?.toFixed(4) ?? "n/a") +
          " | " +
          (dv1?.toFixed(4) ?? "n/a") +
          " | " +
          (uv1?.toFixed(4) ?? "n/a") +
          " | " +
          (dv2?.toFixed(4) ?? "n/a") +
          " | " +
          (uv2?.toFixed(4) ?? "n/a") +
          " | " +
          fmtPct(pctFromStart),
      );
    }
    console.log("");
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(
    OUTPUT_DIR,
    "atr-method-comparison-" + Date.now() + ".json",
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        symbol: SYMBOL,
        victim: VICTIM,
        note: "No 1-minute candle high/low used to describe price between two liquidation events. ATR values use only fully-closed past candles, looked up causally per timestamp.",
        bursts: BURSTS,
      },
      null,
      2,
    ),
  );
  console.log("Summary metadata: " + outPath);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
