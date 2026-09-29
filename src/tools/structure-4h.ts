/**
 * PHASE 1 -- 4h STRUCTURE INSPECTOR (Johnny, Sep 29 2026). Read-only: fresh Binance USDT-M 4h klines, no DB.
 * Prints what the algorithm KNEW at a moment (default: now): trend, protected level, active zones, and every
 * structure event of the reporting period -- with exact candle times (UTC, and Yerevan = UTC+4) to find on the
 * Binance chart. No charts, no Pine, no entries, no P&L. Rules: src/research/structure4h.ts.
 *
 *   npx tsx src/tools/structure-4h.ts                          (configured symbols, last 1 month, as of now)
 *   npx tsx src/tools/structure-4h.ts --months 2
 *   npx tsx src/tools/structure-4h.ts --months 3 --symbols ADA,ETH
 *   npx tsx src/tools/structure-4h.ts --asof 2026-09-20T12:00 --months 1     (what it knew then; UTC)
 * Options (defaults in brackets):
 *   --months N         reporting period = the N x 30 days before asOf [1]
 *   --asof TIME        ISO time, read as UTC when no zone is given [now]; only 4h candles CLOSED by then are used
 *   --warmup-days D    older candles loaded before the period, for ATR / pivots / zones [60]
 *   --symbols A,B      [users.config.json v9.symbols, else .env SYMBOLS, else the 9 V9 coins]
 *   --L 2 --R 2        pivot sides
 *   --min-prom 1.0     meaningful pivot: prominence >= this x ATR
 *   --merge-atr 0.25   merge zones closer than this x ATR
 *   --min-width-atr 0.1  minimum zone height, x ATR
 *   --max-age-bars 180 zone expiry (4h bars)      --max-touches 0 (0 = off)
 *   --pl A|B           protected level rule [A]  --break close|wick [close]
 *   --all-pivots       also list pivots that failed the prominence filter
 */
import "dotenv/config";
import * as fs from "fs";
import axios from "axios";
import {
  DEFAULT_STRUCTURE,
  H4,
  runStructure,
  type Candle4h,
  type Pivot,
  type StructureResult,
  type TrendEvent,
  type Zone,
} from "../research/structure4h";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DAY = 86_400_000;
const nowMs = Date.now();
const asOfArg = arg("asof", "");
const asOfRaw = asOfArg
  ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(asOfArg) ? asOfArg : `${asOfArg}Z`)
  : nowMs;
if (!Number.isFinite(asOfRaw))
  throw new Error(
    `--asof "${asOfArg}" is not a valid time (example: 2026-09-20T12:00)`,
  );
const ASOF = Math.min(asOfRaw, nowMs);
const MONTHS = Number(arg("months", "1")),
  WARMUP_DAYS = Number(arg("warmup-days", "60"));
const SETTINGS = {
  ...DEFAULT_STRUCTURE,
  L: Number(arg("L", String(DEFAULT_STRUCTURE.L))),
  R: Number(arg("R", String(DEFAULT_STRUCTURE.R))),
  minProminenceAtr: Number(
    arg("min-prom", String(DEFAULT_STRUCTURE.minProminenceAtr)),
  ),
  mergeAtr: Number(arg("merge-atr", String(DEFAULT_STRUCTURE.mergeAtr))),
  minWidthAtr: Number(
    arg("min-width-atr", String(DEFAULT_STRUCTURE.minWidthAtr)),
  ),
  maxAgeBars: Number(arg("max-age-bars", String(DEFAULT_STRUCTURE.maxAgeBars))),
  maxTouches: Number(arg("max-touches", String(DEFAULT_STRUCTURE.maxTouches))),
  protectedRule:
    arg("pl", "A").toUpperCase() === "B"
      ? ("PL-B" as const)
      : ("PL-A" as const),
  breakRule:
    arg("break", "close").toLowerCase() === "wick"
      ? ("WICK" as const)
      : ("CLOSE" as const),
};
const ALL_PIVOTS = argv.includes("--all-pivots");
const http = axios.create({
  baseURL: process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com",
  timeout: 20_000,
});

// ---- time / number formatting: UTC first, Yerevan (UTC+4) in brackets ----
const iso = (ms: number): string => new Date(ms).toISOString();
const utc = (ms: number): string =>
  `${iso(ms).slice(0, 10)} ${iso(ms).slice(11, 16)} UTC`;
const yvn = (ms: number): string => {
  const s = iso(ms + 4 * 3_600_000);
  return s.slice(0, 10) === iso(ms).slice(0, 10)
    ? `${s.slice(11, 16)} Yerevan`
    : `${s.slice(5, 10)} ${s.slice(11, 16)} Yerevan`;
};
const at = (ms: number): string => `${utc(ms)} (${yvn(ms)})`;
const candle = (openTime: number): string =>
  `4h candle ${utc(openTime).replace(" UTC", "")}-${iso(openTime + H4).slice(11, 16)} UTC (opens ${yvn(openTime)})`;
const fp = (v: number): string =>
  !Number.isFinite(v)
    ? "n/a"
    : v >= 1000
      ? v.toFixed(2)
      : v >= 10
        ? v.toFixed(3)
        : v >= 1
          ? v.toFixed(4)
          : v.toFixed(5);
const pct = (a: number, b: number): string =>
  `${a >= b ? "+" : ""}${((100 * (a - b)) / b).toFixed(2)}%`;

function symbols(): string[] {
  const s = arg("symbols", "");
  if (s)
    return s
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
      .map((x) => (x.endsWith("USDT") ? x : `${x}USDT`));
  try {
    const cfg = JSON.parse(
      fs.readFileSync(process.env.USERS_CONFIG ?? "users.config.json", "utf8"),
    ) as { v9?: { symbols?: string[] } };
    if (cfg.v9?.symbols?.length) return cfg.v9.symbols;
  } catch {
    /* next */
  }
  if (process.env.SYMBOLS)
    return process.env.SYMBOLS.split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
  return [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "DOGEUSDT",
    "ADAUSDT",
    "LINKUSDT",
    "AVAXUSDT",
    "SUIUSDT",
  ];
}

async function klines4h(
  symbol: string,
  from: number,
  to: number,
): Promise<Candle4h[]> {
  const out: Candle4h[] = [];
  for (let start = from, guard = 0; guard < 100 && start < to; guard++) {
    const res = await http.get<Array<[number, string, string, string, string]>>(
      "/fapi/v1/klines",
      {
        params: {
          symbol,
          interval: "4h",
          startTime: start,
          endTime: to,
          limit: 1500,
        },
      },
    );
    if (!res.data.length) break;
    for (const k of res.data)
      out.push({
        openTime: k[0],
        closeTime: k[0] + H4,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
      });
    const next = res.data[res.data.length - 1][0] + 1;
    if (next <= start) break;
    start = next;
    await new Promise((r) => setTimeout(r, 150));
  }
  // only candles CLOSED by asOf (and by now): an unfinished candle is never used
  const seen = new Set<number>();
  return out.filter(
    (k) =>
      k.closeTime <= to &&
      k.closeTime <= nowMs &&
      !seen.has(k.openTime) &&
      seen.add(k.openTime),
  );
}

function checkGaps(c: readonly Candle4h[]): string {
  let gaps = 0;
  for (let i = 1; i < c.length; i++)
    if (c[i].openTime - c[i - 1].openTime !== H4) gaps++;
  return gaps ? `${gaps} gap(s) in the 4h series!` : "no gaps";
}

const pivotLine = (p: Pivot): string =>
  `${p.kind} ${fp(p.price)} (body ${p.kind === "HIGH" ? "top" : "bottom"} ${fp(p.bodyEdge)}) on the ${candle(p.pivotTime)}; confirmed ${at(p.confirmedAt)}; prominence ${p.prominenceAtr.toFixed(2)} ATR`;

function zoneLine(
  z: Zone,
  price: number,
  byId: Map<string, Pivot>,
  reportFrom: number,
): string {
  const where =
    price > z.hi
      ? `${pct(z.hi, price)} below price`
      : price < z.lo
        ? `${pct(z.lo, price)} above price`
        : "price is inside";
  const src = z.sourcePivotIds
    .map((id) => byId.get(id))
    .filter((p): p is Pivot => !!p)
    .map((p) => `${p.kind} ${fp(p.price)} ${candle(p.pivotTime)}`)
    .join(" + ");
  const merges = z.updates
    .filter((u) => u.kind === "MERGED")
    .map((u) => `grew at ${utc(u.at)}`)
    .join(", ");
  const touches = z.touches.length
    ? z.touches
        .map((t) => `${utc(t.candleOpenTime).replace(" UTC", "")}`)
        .join(", ") + " UTC"
    : "none";
  return `${z.side.padEnd(10)} ${fp(z.lo)} - ${fp(z.hi)}  (${where})\n      from: ${src}\n      usable from ${at(z.createdAt)}${z.createdAt < reportFrom ? " [created in warm-up]" : ""}${merges ? `; ${merges}` : ""}\n      touches (candle open times): ${touches}`;
}

interface CoinReport {
  symbol: string;
  res: StructureResult;
  c: Candle4h[];
  reportFrom: number;
  byId: Map<string, Pivot>;
}

function printCoin(r: CoinReport): void {
  const { symbol, res, c, reportFrom, byId } = r;
  const last = c[c.length - 1],
    price = last.close;
  const inReport = c.filter((k) => k.openTime >= reportFrom);
  console.log(
    `\n================ ${symbol}  (Binance USDT-M perpetual, 4h) ================`,
  );
  console.log(
    `as of ${at(res.asOf)} = close of the last finished ${candle(last.openTime)}`,
  );
  console.log(
    `warm-up : ${utc(c[0].openTime)} -> ${utc(reportFrom)}  (${c.length - inReport.length} candles, used only to build pivots / ATR / zones)`,
  );
  console.log(
    `report  : ${utc(reportFrom)} -> ${utc(res.asOf)}  (${inReport.length} candles)  data: ${checkGaps(c)}`,
  );
  console.log(
    `last close ${fp(price)}   ATR(14) ${fp(res.atr)} (${((100 * res.atr) / price).toFixed(2)}% of price)`,
  );
  const p = res.protected;
  console.log(`\nTREND NOW: ${res.trend}  since ${at(res.trendSince)}`);
  const lastEv = [...res.events].reverse().find((e) => e.to === res.trend);
  if (lastEv && res.trend !== "NEUTRAL") {
    const q = lastEv.pivots;
    console.log(
      `  because (confirmed pivots): H1 ${fp(q.H1!.price)} -> H2 ${fp(q.H2!.price)}, L1 ${fp(q.L1!.price)} -> L2 ${fp(q.L2!.price)}`,
    );
  } else if (lastEv) console.log(`  because: ${lastEv.reason}`);
  if (p) {
    const pv = byId.get(p.pivotId)!;
    console.log(
      `  protected ${res.trend === "BULL" ? "LOW" : "HIGH"} (${SETTINGS.protectedRule}): ${fp(p.price)} = ${pv.kind} of the ${candle(pv.pivotTime)}, usable from ${at(p.confirmedAt)}`,
    );
    console.log(
      `  structure breaks if a 4h ${SETTINGS.breakRule === "CLOSE" ? "CLOSE" : "WICK"} goes ${res.trend === "BULL" ? "below" : "above"} ${fp(p.price)} (now ${pct(price, p.price)} from it)`,
    );
  }
  const active = res.zones
    .filter((z) => z.state === "ACTIVE")
    .sort(
      (a, b) =>
        Math.abs((a.lo + a.hi) / 2 - price) -
        Math.abs((b.lo + b.hi) / 2 - price),
    );
  console.log(
    `\nACTIVE ZONES at ${utc(res.asOf)} (nearest first, ${active.length}):`,
  );
  for (const z of active)
    console.log(`  ${zoneLine(z, price, byId, reportFrom)}`);
  if (!active.length) console.log("  none");
  // events in the reporting period
  type Ev = { t: number; s: string };
  const ev: Ev[] = [];
  for (const pv of res.pivots)
    if (pv.confirmedAt >= reportFrom && (pv.meaningful || ALL_PIVOTS))
      ev.push({
        t: pv.confirmedAt,
        s: `pivot ${pivotLine(pv)}${pv.meaningful ? "" : "  [below prominence filter: no zone, not used for trend]"}`,
      });
  for (const z of res.zones) {
    if (z.createdAt >= reportFrom)
      ev.push({
        t: z.createdAt,
        s: `zone ${z.side} ${fp(z.updates[0].lo)} - ${fp(z.updates[0].hi)} created`,
      });
    for (const u of z.updates)
      if (u.kind === "MERGED" && u.at >= reportFrom)
        ev.push({
          t: u.at,
          s: `zone ${z.side} grew to ${fp(u.lo)} - ${fp(u.hi)} (merged pivot ${u.pivotId.split(":").slice(1).join(" ")})`,
        });
    if (z.endedAt !== null && z.endedAt >= reportFrom)
      ev.push({
        t: z.endedAt,
        s: `zone ${z.side} ${fp(z.lo)} - ${fp(z.hi)} ${z.state}: ${z.endReason}`,
      });
  }
  for (const e of res.events)
    if (e.at >= reportFrom)
      ev.push({
        t: e.at,
        s: `TREND ${e.from} -> ${e.to}: ${e.reason}${e.protected ? `; protected ${fp(e.protected.price)} (${candle(e.protected.pivotTime)})` : ""}`,
      });
  console.log(`\nEVENTS in the report period (time = when it became known):`);
  for (const e of ev.sort((a, b) => a.t - b.t))
    console.log(`  ${at(e.t)}  ${e.s}`);
  if (!ev.length) console.log("  none");
}

function checks(reports: CoinReport[]): void {
  console.log(
    `\n\n================ CHECKS TO DO ON THE BINANCE CHART ================`,
  );
  console.log(
    "Open Binance Futures, the symbol's USDT perpetual, 4h, chart timezone UTC. Every time below is the candle's OPEN time.\n",
  );
  const describeState = (
    r: CoinReport,
    e: TrendEvent | null,
    label: string,
  ): void => {
    console.log(`--- ${label}: ${r.symbol} ---`);
    const q = e?.pivots ?? {};
    for (const k of ["H1", "H2", "L1", "L2"] as const) {
      const pv = q[k];
      if (pv) console.log(`  ${k}: ${pivotLine(pv)}`);
    }
    if (e)
      console.log(
        `  trend became ${e.to} at ${at(e.at)}${e.protected ? `; protected ${fp(e.protected.price)} from the ${candle(e.protected.pivotTime)}, usable from ${at(e.protected.confirmedAt)}` : ""}`,
      );
    const price = r.c[r.c.length - 1].close;
    const zs = r.res.zones
      .filter((z) => z.state === "ACTIVE")
      .sort(
        (a, b) =>
          Math.abs((a.lo + a.hi) / 2 - price) -
          Math.abs((b.lo + b.hi) / 2 - price),
      )
      .slice(0, 2);
    for (const z of zs)
      console.log(`  zone ${zoneLine(z, price, r.byId, r.reportFrom)}`);
    console.log("");
  };
  for (const want of ["BULL", "BEAR"] as const) {
    const now = reports.find((r) => r.res.trend === want);
    if (now) {
      describeState(
        now,
        [...now.res.events].reverse().find((e) => e.to === want) ?? null,
        `${want} NOW`,
      );
      continue;
    }
    const past = reports
      .flatMap((r) =>
        r.res.events
          .filter((e) => e.to === want && e.at >= r.reportFrom)
          .map((e) => ({ r, e })),
      )
      .sort((a, b) => b.e.at - a.e.at)[0];
    if (past)
      describeState(
        past.r,
        past.e,
        `${want} (earlier in the period, not any more)`,
      );
    else
      console.log(`--- ${want}: no ${want} case in the selected period ---\n`);
  }
  const brk = reports
    .flatMap((r) =>
      r.res.events
        .filter(
          (e) =>
            e.to === "NEUTRAL" &&
            e.at >= r.reportFrom &&
            e.reason.includes("protected"),
        )
        .map((e) => ({ r, e })),
    )
    .sort((a, b) => b.e.at - a.e.at)[0];
  if (brk) {
    const { r, e } = brk;
    const k = r.c.find((x) => x.closeTime === e.at)!;
    console.log(`--- STRUCTURE BREAK: ${r.symbol} ---`);
    console.log(
      `  was ${e.from}; protected ${fp(e.protected!.price)} from the ${candle(e.protected!.pivotTime)} (usable from ${at(e.protected!.confirmedAt)})`,
    );
    console.log(
      `  broken by the ${candle(k.openTime)}: open ${fp(k.open)} high ${fp(k.high)} low ${fp(k.low)} close ${fp(k.close)} -> ${e.reason}`,
    );
    console.log(`  known at ${at(e.at)}; trend -> NEUTRAL`);
  } else {
    const neutral = reports.find((r) => r.res.trend === "NEUTRAL");
    if (neutral)
      describeState(
        neutral,
        [...neutral.res.events].reverse()[0] ?? null,
        "NEUTRAL NOW",
      );
    else
      console.log(
        "--- no structure break and no NEUTRAL coin in the selected period ---",
      );
  }
}

async function main(): Promise<void> {
  const reportFrom = ASOF - MONTHS * 30 * DAY;
  const from = Math.floor((reportFrom - WARMUP_DAYS * DAY) / H4) * H4;
  console.log(
    `4h STRUCTURE (Phase 1)  as of ${at(ASOF)}${asOfArg ? "  [historical --asof]" : ""}; report = last ${MONTHS} x 30 days; warm-up ${WARMUP_DAYS} days`,
  );
  console.log(
    `rules: pivot L=${SETTINGS.L} R=${SETTINGS.R}, meaningful >= ${SETTINGS.minProminenceAtr} ATR, zones wick-to-body, merge <= ${SETTINGS.mergeAtr} ATR, min width ${SETTINGS.minWidthAtr} ATR, expiry ${SETTINGS.maxAgeBars} bars${SETTINGS.maxTouches ? ` / ${SETTINGS.maxTouches} touches` : ""}, ${SETTINGS.protectedRule}, BREAK-${SETTINGS.breakRule}, after a break -> NEUTRAL, no zone flip`,
  );
  console.log(
    "ATR(j) = mean of the last 14 true ranges (candle j included), TR = max(high, prev close) - min(low, prev close)",
  );
  const reports: CoinReport[] = [];
  for (const s of symbols()) {
    process.stderr.write(`${s} ...\n`);
    const c = await klines4h(s, from, ASOF);
    if (c.length < 40) {
      console.log(`\n${s}: not enough 4h candles (${c.length})`);
      continue;
    }
    const res = runStructure(s, c, SETTINGS);
    const r: CoinReport = {
      symbol: s,
      res,
      c,
      reportFrom,
      byId: new Map(res.pivots.map((p) => [p.id, p])),
    };
    reports.push(r);
    printCoin(r);
  }
  checks(reports);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
