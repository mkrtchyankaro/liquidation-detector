/**
 * ORDER-BOOK SNAPSHOT EXPORT (Johnny, Oct 9 2026). READ-ONLY: it only READS our MongoDB (v10_book) and writes files
 * under reports/; it changes nothing in the DB, the collector or the bot. No Binance calls.
 * v10_book = one REST depth snapshot per coin per 15m close (since Oct 4, TTL 90 days): $ of bids / asks within 1% and
 * 2% of the mid, and (since Oct 5) the 3 biggest 0.1%-wide slices per side within 3% of the mid.
 *
 *   npx tsx src/tools/book-export.ts --symbols SOLUSDT,LINKUSDT
 * writes reports/book-<SYMBOL>.jsonl.gz (one snapshot per line, every field as stored) and packs them into
 * reports/book-export.tgz
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { execFileSync } from "child_process";
import { MongoClient } from "mongodb";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI not set");
  const syms = arg("symbols", "SOLUSDT,LINKUSDT")
    .toUpperCase()
    .split(",")
    .filter(Boolean);
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const col = client
      .db(process.env.MONGO_OWN_DB ?? "liquidation_detector")
      .collection("v10_book");
    fs.mkdirSync("reports", { recursive: true });
    const files: string[] = [];
    for (const sym of syms) {
      const lines: string[] = [];
      // the {symbol, candleEnd} unique index serves this sort
      for await (const d of col
        .find({ symbol: sym }, { projection: { _id: 0 } })
        .sort({ candleEnd: 1 }))
        lines.push(JSON.stringify(d));
      const f = `book-${sym}.jsonl.gz`;
      fs.writeFileSync(
        path.join("reports", f),
        zlib.gzipSync(lines.join("\n") + "\n"),
      );
      files.push(f);
      console.log(
        `${sym}: ${lines.length} snapshots${lines.length ? ` · ${JSON.parse(lines[0]).candleEnd} → ${JSON.parse(lines[lines.length - 1]).candleEnd}` : ""}`,
      );
    }
    execFileSync("tar", [
      "czf",
      path.join("reports", "book-export.tgz"),
      "-C",
      "reports",
      ...files,
    ]);
    console.log("pack: reports/book-export.tgz");
  } finally {
    await client.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
