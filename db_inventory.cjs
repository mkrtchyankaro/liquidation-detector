#!/usr/bin/env node
/* READ-ONLY inventory of our Mongo databases + Binance data freshness (2026-10-17).
   Uses only: listCollections, listIndexes, collStats/dbStats (read commands), estimatedDocumentCount, find(...).sort().limit(1), distinct.
   Writes nothing to any database. Never prints the connection string or any key.
   Usage (from the project folder that has .env and node_modules):   node /path/to/db_inventory.cjs --project .
   Output: db_inventory_<UTC>.txt and .json in the current folder. */
const path = require("path"),
  fs = require("fs");
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const P = path.resolve(arg("--project", "."));
require(path.join(P, "node_modules", "dotenv")).config({
  path: path.join(P, ".env"),
});
const { MongoClient } = require(path.join(P, "node_modules", "mongodb"));
const COINS = [
  "ADA",
  "ALGO",
  "AVAX",
  "BCH",
  "BNB",
  "BTC",
  "DOGE",
  "DOT",
  "ENA",
  "ETH",
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
].map((c) => c + "USDT");
const TIME_FIELDS = [
  "timestamp",
  "ts",
  "eventTimeDate",
  "time",
  "minute",
  "createdAt",
  "openTime",
  "t",
];
const out = { run_utc: new Date().toISOString(), databases: {}, binance: {} };
const lines = [];
const say = (s) => {
  lines.push(s);
  console.log(s);
};
const toMs = (v) =>
  v instanceof Date
    ? v.getTime()
    : typeof v === "number"
      ? v < 1e11
        ? v * 1000
        : v
      : typeof v === "string" && !isNaN(Date.parse(v))
        ? Date.parse(v)
        : null;
const iso = (ms) =>
  ms == null ? "-" : new Date(ms).toISOString().slice(0, 19).replace("T", " ");
(async () => {
  const cli = new MongoClient(process.env.MONGO_URI, {
    readPreference: "secondaryPreferred",
    appName: "liqmap-inventory-readonly",
    maxPoolSize: 2,
  });
  await cli.connect();
  const names = [
    ...new Set([
      process.env.MONGO_OWN_DB || "liquidation_detector",
      process.env.MONGO_SHARED_DB || process.env.MONGO_DB || "liqwatch_bot",
    ]),
  ];
  for (const dbn of names) {
    const db = cli.db(dbn);
    const D = { collections: {} };
    out.databases[dbn] = D;
    try {
      const st = await db.command({ dbStats: 1, scale: 1048576 });
      D.dataSizeMB = st.dataSize;
      D.storageMB = st.storageSize;
      D.indexMB = st.indexSize;
    } catch (e) {
      D.dbStatsError = String(e.message || e);
    }
    say(
      `\n=== DATABASE ${dbn}  data ${D.dataSizeMB ?? "?"} MB, storage ${D.storageMB ?? "?"} MB, indexes ${D.indexMB ?? "?"} MB`,
    );
    let colls = [];
    try {
      colls = await db.listCollections({}, { nameOnly: true }).toArray();
    } catch (e) {
      say(`  listCollections failed: ${e.message}`);
    }
    for (const { name } of colls.sort((a, b) => a.name.localeCompare(b.name))) {
      const c = db.collection(name);
      const C = {};
      D.collections[name] = C;
      try {
        C.count_est = await c.estimatedDocumentCount();
      } catch (e) {
        C.count_est = null;
      }
      try {
        const s = await db.command({ collStats: name, scale: 1048576 });
        C.sizeMB = s.size;
        C.storageMB = s.storageSize;
      } catch (e) {}
      try {
        C.indexes = (await c.listIndexes().toArray()).map((ix) => ({
          name: ix.name,
          key: ix.key,
          ttl_days:
            ix.expireAfterSeconds != null
              ? +(ix.expireAfterSeconds / 86400).toFixed(3)
              : null,
        }));
      } catch (e) {
        C.indexes = [];
      }
      const sample = await c
        .find({}, { sort: { $natural: -1 } })
        .limit(1)
        .toArray()
        .catch(() => []);
      C.fields = sample[0] ? Object.keys(sample[0]).slice(0, 40) : [];
      const tf = TIME_FIELDS.find(
        (f) => sample[0] && sample[0][f] != null && toMs(sample[0][f]) != null,
      );
      C.time_field = tf || null;
      if (tf) {
        const first = await c
          .find({ [tf]: { $ne: null } }, { projection: { [tf]: 1 } })
          .sort({ [tf]: 1 })
          .limit(1)
          .maxTimeMS(60000)
          .toArray()
          .catch(() => []);
        const last = await c
          .find({ [tf]: { $ne: null } }, { projection: { [tf]: 1 } })
          .sort({ [tf]: -1 })
          .limit(1)
          .maxTimeMS(60000)
          .toArray()
          .catch(() => []);
        C.first = first[0] ? iso(toMs(first[0][tf])) : null;
        C.last = last[0] ? iso(toMs(last[0][tf])) : null;
        C.span_days =
          first[0] && last[0]
            ? +((toMs(last[0][tf]) - toMs(first[0][tf])) / 864e5).toFixed(2)
            : null;
      }
      const ttl =
        (C.indexes || [])
          .filter((i) => i.ttl_days != null)
          .map((i) => `${i.name}=${i.ttl_days}d`)
          .join(",") || "none";
      say(
        `  ${name.padEnd(40)} docs~${String(C.count_est).padStart(10)}  ${String(C.sizeMB ?? "?").padStart(6)} MB  TTL ${ttl}  time=${tf || "-"}  ${C.first || "-"} -> ${C.last || "-"} (${C.span_days ?? "-"} d)`,
      );
      // per-symbol coverage for collections that have a symbol field and a time field
      if (tf && C.fields.includes("symbol")) {
        C.per_symbol = {};
        for (const s of COINS) {
          const f = await c
            .find({ symbol: s }, { projection: { [tf]: 1 } })
            .sort({ [tf]: 1 })
            .limit(1)
            .maxTimeMS(30000)
            .toArray()
            .catch(() => []);
          const l = await c
            .find({ symbol: s }, { projection: { [tf]: 1 } })
            .sort({ [tf]: -1 })
            .limit(1)
            .maxTimeMS(30000)
            .toArray()
            .catch(() => []);
          C.per_symbol[s] = {
            first: f[0] ? iso(toMs(f[0][tf])) : null,
            last: l[0] ? iso(toMs(l[0][tf])) : null,
          };
        }
        const miss = COINS.filter((s) => !C.per_symbol[s].first);
        say(
          `      symbols with data: ${COINS.length - miss.length}/25${miss.length ? "  MISSING: " + miss.join(",") : ""}`,
        );
        const firsts = COINS.map((s) => C.per_symbol[s].first)
          .filter(Boolean)
          .sort();
        if (firsts.length)
          say(
            `      earliest first ${firsts[0]}, latest first ${firsts[firsts.length - 1]}`,
          );
      }
    }
  }
  await cli.close();
  // Binance freshness (public endpoints, no key)
  const now = Date.now();
  for (const s of ["BTCUSDT", "SOLUSDT", "HBARUSDT"]) {
    try {
      const oi = await (
        await fetch(
          `https://fapi.binance.com/futures/data/openInterestHist?symbol=${s}&period=5m&limit=3`,
        )
      ).json();
      const kl = await (
        await fetch(
          `https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=5m&limit=2`,
        )
      ).json();
      const lastOi = oi.length ? +oi[oi.length - 1].timestamp : null;
      const lastK = kl.length ? +kl[kl.length - 2][0] : null;
      out.binance[s] = {
        now: iso(now),
        last_oi_ts: iso(lastOi),
        oi_lag_min: lastOi ? +((now - lastOi) / 60000).toFixed(1) : null,
        last_closed_kline_open: iso(lastK),
      };
      say(
        `\nBinance ${s}: now ${iso(now)} | last 5m OI point ${iso(lastOi)} (lag ${out.binance[s].oi_lag_min} min) | last closed 5m kline opened ${iso(lastK)}`,
      );
    } catch (e) {
      say(`Binance ${s}: ${e.message}`);
    }
  }
  for (const d of [1, 2]) {
    // official archive: is yesterday's / day-before's metrics file there?
    const day = new Date(now - d * 864e5).toISOString().slice(0, 10);
    const url = `https://data.binance.vision/data/futures/um/daily/metrics/SOLUSDT/SOLUSDT-metrics-${day}.zip`;
    try {
      const r = await fetch(url, { method: "HEAD" });
      say(`Binance archive metrics SOLUSDT ${day}: HTTP ${r.status}`);
      out.binance[`archive_${day}`] = r.status;
    } catch (e) {
      say(`archive ${day}: ${e.message}`);
    }
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  fs.writeFileSync(`db_inventory_${stamp}Z.json`, JSON.stringify(out, null, 1));
  fs.writeFileSync(`db_inventory_${stamp}Z.txt`, lines.join("\n"));
  console.log(
    `\nwritten db_inventory_${stamp}Z.txt / .json (no secrets inside)`,
  );
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
