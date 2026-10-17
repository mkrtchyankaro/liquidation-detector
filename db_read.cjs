#!/usr/bin/env node
/* READ-ONLY reader for liqmap. Prints JSON lines to stdout; writes nothing to the DB; never prints the connection string.
   node db_read.cjs --project /path/to/liquidation-detector --symbols SOLUSDT,BTCUSDT --from <ms> --to <ms>
   -> one line per minute_bars row: {"s":sym,"t":ms,"c":close,"p":polls,"oi":oiLast,"L":longLiqUsd,"S":shortLiqUsd} ; last line {"done":n} */
const path = require("path");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const P = path.resolve(arg("--project", "."));
require(path.join(P, "node_modules", "dotenv")).config({ path: path.join(P, ".env") });
const { MongoClient } = require(path.join(P, "node_modules", "mongodb"));
(async () => {
  const syms = arg("--symbols", "").split(",").filter(Boolean); const from = +arg("--from"), to = +arg("--to");
  const cli = new MongoClient(process.env.MONGO_URI, { readPreference: "secondaryPreferred", appName: "liqmap-readonly", maxPoolSize: 2 });
  await cli.connect(); const db = cli.db(process.env.MONGO_OWN_DB || "liquidation_detector"); let n = 0;
  for (const s of syms) {
    const cur = db.collection("minute_bars").find({ symbol: s, ts: { $gte: new Date(from), $lt: new Date(to) } },
      { projection: { _id: 0, ts: 1, close: 1, polls: 1, oiLast: 1, longLiqUsd: 1, shortLiqUsd: 1 } }).sort({ ts: 1 }).maxTimeMS(120000);
    for await (const d of cur) {
      process.stdout.write(JSON.stringify({ s, t: new Date(d.ts).getTime(), c: d.close, p: d.polls || 0, oi: d.oiLast, L: d.longLiqUsd || 0, S: d.shortLiqUsd || 0 }) + "\n"); n++;
    }
  }
  await cli.close(); process.stdout.write(JSON.stringify({ done: n }) + "\n");
})().catch(e => { process.stderr.write("DB_READ_FAILED: " + (e && e.message ? e.message.replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "<uri>") : e) + "\n"); process.exit(2); });
