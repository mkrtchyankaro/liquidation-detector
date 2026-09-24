import { MongoClient, type Db } from "mongodb";
import { childLogger } from "../logging/logger";

const log = childLogger({ mod: "mongo" });

/** One MongoDB connection to the bot's own database. */
export class Mongo {
  private client: MongoClient | null = null;
  private database: Db | null = null;

  constructor(private readonly uri: string, private readonly dbName: string) {}

  async connect(): Promise<Db> {
    if (this.database) return this.database;
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 15_000 });
    await this.client.connect();
    this.database = this.client.db(this.dbName);
    await this.database.command({ ping: 1 });
    log.info(`connected to mongo db=${this.dbName}`);
    return this.database;
  }

  /** The connected Db, or null before connect()/after close(). */
  db = async (): Promise<Db | null> => this.database;

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.database = null;
  }
}
