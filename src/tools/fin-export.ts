/**
 * FIN EXPORT — read-only data export for the 4H-wall + market-structure SHORT backtest (research only).
 *
 *   npx tsx src/tools/fin-export.ts
 *   npx tsx src/tools/fin-export.ts --user karo --from 2025-04-01 --to 2026-10-15
 *
 * What it does (ONLY GET requests, nothing is changed anywhere — no orders, no leverage/margin changes, no DB access):
 *   public  /fapi/v1/klines            trade candles 1d / 4h / 1h      -> klines_1d.csv, klines_4h.csv, klines_1h.csv
 *   public  /fapi/v1/markPriceKlines   mark price 1h (liquidation uses MARK price) -> mark_1h.csv
 *   public  /fapi/v1/fundingRate       funding history                 -> funding.csv
 *   signed  /fapi/v1/leverageBracket   maintenance margin tiers (CURRENT only; Binance has no history) -> leverage_brackets.json
 *   signed  /fapi/v1/commissionRate    the user's maker / taker fee per symbol                        -> commission_rates.json
 * The signed calls use the Binance key of a user from users.config.json (--user, default: the first user with
 * binance.enabled=true). The key is only used to sign these two GET requests; it is never printed or written to a file.
 *
 * Output: ./fin_export_<UTC stamp>/ + fin_export_<UTC stamp>.tar.gz   -> send the .tar.gz back.
 * --from / --to  UTC dates (default 2025-04-01 .. 2026-10-15, --to exclusive). Only CLOSED candles are written.
 */
import { createHmac } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import axios from "axios";

const BASE = process.env.FIN_EXPORT_BASE ?? "https://fapi.binance.com";
const SYMBOLS = [
  "ADA",
  "ALGO",
  "AVAX",
  "BCH",
  "BNB",
  "DOGE",
  "DOT",
  "ENA",
  "HBAR",
  "HYPE",
  "LINK",
  "LTC",
  "NEAR",
  "ONDO",
  "SOL",
  "STRK",
  "SUI",
  "UNI",
  "WLD",
  "XLM",
  "XRP",
  "XTZ",
  "ZEC",
].map((c) => `${c}USDT`);
const STEP: Record<string, number> = {
  "1d": 86_400_000,
  "4h": 14_400_000,
  "1h": 3_600_000,
};

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const iso = (ms: number) =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Keys {
  apiKey: string;
  apiSecret: string;
  userId: string;
}

function loadKeys(): Keys | null {
  const path =
    process.env.USERS_CONFIG_PATH ?? `${process.cwd()}/users.config.json`;
  if (!existsSync(path)) {
    console.log(
      `users.config.json not found at ${path} -> only public data will be exported`,
    );
    return null;
  }
  const cfg = JSON.parse(readFileSync(path, "utf8")) as {
    users?: Array<Record<string, any>>;
  };
  const want = arg("user");
  const u = (cfg.users ?? []).find(
    (x) =>
      x?.binance?.enabled === true &&
      x.binance.apiKey &&
      x.binance.apiSecret &&
      (!want || String(x.userId).toLowerCase() === want.toLowerCase()),
  );
  if (!u) {
    console.log(
      `no user ${want ? `"${want}" ` : ""}with binance.enabled=true and keys -> only public data will be exported`,
    );
    return null;
  }
  return {
    apiKey: u.binance.apiKey,
    apiSecret: u.binance.apiSecret,
    userId: String(u.userId),
  };
}

async function get(
  path: string,
  params: Record<string, string | number>,
  keys?: Keys,
): Promise<any> {
  const q = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
  );
  const headers: Record<string, string> = {};
  if (keys) {
    q.set("timestamp", String(Date.now()));
    q.set("recvWindow", "10000");
    q.set(
      "signature",
      createHmac("sha256", keys.apiSecret).update(q.toString()).digest("hex"),
    );
    headers["X-MBX-APIKEY"] = keys.apiKey;
  }
  for (let k = 0; ; k++) {
    try {
      return (
        await axios.get(`${BASE}${path}?${q.toString()}`, {
          headers,
          timeout: 30_000,
        })
      ).data;
    } catch (e: any) {
      const st = e?.response?.status;
      if (st === 418 || st === 429) {
        await sleep(
          (Number(e.response.headers["retry-after"]) || 30) * 1000 + 1000,
        );
        continue;
      }
      if (keys && (st === 401 || st === 403))
        throw new Error(
          `signed request ${path} refused (${st}) - check the key permissions`,
        );
      if (k >= 5)
        throw new Error(`${path} ${params.symbol ?? ""}: ${e?.message ?? e}`);
      await sleep(2000 * (k + 1));
    }
  }
}

async function klines(
  path: string,
  sym: string,
  itv: string,
  s: number,
  e: number,
  now: number,
): Promise<any[][]> {
  const out = new Map<number, any[]>();
  let cur = s;
  while (cur < e) {
    const rows: any[][] = await get(path, {
      symbol: sym,
      interval: itv,
      startTime: cur,
      endTime: e - 1,
      limit: 1500,
    });
    if (!rows.length) break;
    for (const k of rows) {
      const o = Number(k[0]),
        c = Number(k[6]);
      if (o >= e || c >= now) continue; // never an open candle
      out.set(o, k);
    }
    const nxt = Number(rows[rows.length - 1][0]) + STEP[itv];
    if (nxt <= cur) break;
    cur = nxt;
    await sleep(250);
  }
  return [...out.keys()].sort((a, b) => a - b).map((o) => out.get(o)!);
}

function gaps(rows: any[][], itv: string, s: number, e: number, now: number) {
  const step = STEP[itv],
    have = new Set(rows.map((r) => Number(r[0]))),
    miss: string[] = [];
  let expected = 0;
  for (let m = s; m < Math.min(e, Math.floor(now / step) * step); m += step) {
    expected++;
    if (!have.has(m)) miss.push(iso(m));
  }
  return {
    expected,
    got: rows.length,
    missing: miss.length,
    missingFirst: miss.slice(0, 10),
  };
}

async function main() {
  const from = Date.parse(`${arg("from", "2025-04-01")}T00:00:00Z`),
    to = Date.parse(`${arg("to", "2026-10-15")}T00:00:00Z`);
  const now = Date.now();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const dir = `fin_export_${stamp}`;
  mkdirSync(dir, { recursive: true });
  const report: Record<string, any> = {
    createdUtc: iso(now),
    from: iso(from),
    toExclusive: iso(to),
    symbols: {},
  };
  for (const s of SYMBOLS) report.symbols[s] = {};

  for (const itv of ["1d", "4h", "1h"]) {
    const lines = [
      "symbol,interval,open_time_utc,close_time_utc,open_ms,open,high,low,close,volume,quote_volume,trades,taker_buy_base,taker_buy_quote",
    ];
    for (const s of SYMBOLS) {
      const rows = await klines("/fapi/v1/klines", s, itv, from, to, now);
      for (const k of rows)
        lines.push(
          [
            s,
            itv,
            iso(Number(k[0])),
            iso(Number(k[6]) + 1),
            k[0],
            k[1],
            k[2],
            k[3],
            k[4],
            k[5],
            k[7],
            k[8],
            k[9],
            k[10],
          ].join(","),
        );
      report.symbols[s][`trade_${itv}`] = gaps(rows, itv, from, to, now);
      console.log(
        `${s.padEnd(10)} trade ${itv}: ${rows.length} rows, missing ${report.symbols[s][`trade_${itv}`].missing}`,
      );
    }
    writeFileSync(`${dir}/klines_${itv}.csv`, lines.join("\n") + "\n");
  }

  const mark = [
    "symbol,interval,open_time_utc,close_time_utc,open_ms,open,high,low,close",
  ];
  for (const s of SYMBOLS) {
    const rows = await klines(
      "/fapi/v1/markPriceKlines",
      s,
      "1h",
      from,
      to,
      now,
    );
    for (const k of rows)
      mark.push(
        [
          s,
          "1h",
          iso(Number(k[0])),
          iso(Number(k[6]) + 1),
          k[0],
          k[1],
          k[2],
          k[3],
          k[4],
        ].join(","),
      );
    report.symbols[s].mark_1h = gaps(rows, "1h", from, to, now);
    console.log(
      `${s.padEnd(10)} mark 1h: ${rows.length} rows, missing ${report.symbols[s].mark_1h.missing}`,
    );
  }
  writeFileSync(`${dir}/mark_1h.csv`, mark.join("\n") + "\n");

  const fund = ["symbol,funding_time_utc,funding_ms,funding_rate,mark_price"];
  for (const s of SYMBOLS) {
    const seen = new Map<number, any>();
    let cur = from;
    while (cur < to) {
      const rows: any[] = await get("/fapi/v1/fundingRate", {
        symbol: s,
        startTime: cur,
        endTime: to - 1,
        limit: 1000,
      });
      if (!rows.length) break;
      for (const r of rows) seen.set(Number(r.fundingTime), r);
      const nxt = Number(rows[rows.length - 1].fundingTime) + 1;
      if (nxt <= cur || rows.length < 1000) break;
      cur = nxt;
      await sleep(250);
    }
    const ts = [...seen.keys()].sort((a, b) => a - b);
    for (const t of ts)
      fund.push(
        [
          s,
          iso(t),
          t,
          seen.get(t).fundingRate,
          seen.get(t).markPrice ?? "",
        ].join(","),
      );
    const iv = ts.slice(1).map((t, i) => Math.round((t - ts[i]) / 3_600_000));
    report.symbols[s].funding = {
      n: ts.length,
      first: ts.length ? iso(ts[0]) : null,
      intervalsH: [...new Set(iv)].sort((a, b) => a - b),
    };
    console.log(
      `${s.padEnd(10)} funding: ${ts.length} rows, intervals ${report.symbols[s].funding.intervalsH.join("/")} h`,
    );
  }
  writeFileSync(`${dir}/funding.csv`, fund.join("\n") + "\n");

  const keys = loadKeys();
  report.signedData = false;
  if (keys) {
    const br = (await get("/fapi/v1/leverageBracket", {}, keys)) as any[];
    writeFileSync(
      `${dir}/leverage_brackets.json`,
      JSON.stringify(
        br.filter((b) => SYMBOLS.includes(b.symbol)),
        null,
        1,
      ),
    );
    const cr: Record<string, any> = {};
    for (const s of SYMBOLS) {
      cr[s] = await get("/fapi/v1/commissionRate", { symbol: s }, keys);
      await sleep(200);
    }
    writeFileSync(`${dir}/commission_rates.json`, JSON.stringify(cr, null, 1));
    report.signedData = true;
    report.signedDataUser = keys.userId;
    console.log(
      `brackets + commission rates exported with the key of user "${keys.userId}" (current values only)`,
    );
  }
  report.summary = {
    missingTrade: SYMBOLS.reduce(
      (a, s) =>
        a +
        ["1d", "4h", "1h"].reduce(
          (b, i) => b + report.symbols[s][`trade_${i}`].missing,
          0,
        ),
      0,
    ),
    missingMark: SYMBOLS.reduce(
      (a, s) => a + report.symbols[s].mark_1h.missing,
      0,
    ),
    fundingRows: SYMBOLS.reduce((a, s) => a + report.symbols[s].funding.n, 0),
  };
  writeFileSync(`${dir}/integrity.json`, JSON.stringify(report, null, 1));
  execSync(`tar -czf ${dir}.tar.gz ${dir}`);
  console.log(
    `\nSUMMARY ${JSON.stringify(report.summary)}\nSend this file back: ${process.cwd()}/${dir}.tar.gz`,
  );
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
