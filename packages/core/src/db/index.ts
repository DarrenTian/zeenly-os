import { mkdirSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { MigrationMeta } from "drizzle-orm/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env";

import { MIGRATIONS } from "./migrations";
import * as schema from "./schema";

/** Any Drizzle Postgres database with our schema: a server, the embedded one, or PGlite in tests. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The database in use: a Postgres server, or the embedded one on disk. */
export type DatabaseInfo = {
  kind: "postgres" | "embedded";
  /** The server, without its password, or the directory. */
  where: string;
};

type Connection = { db: Database; info: DatabaseInfo };

/**
 * With `DATABASE_URL`, a Postgres server. Without, an embedded Postgres
 * (PGlite) in `ZEENLY_OS_DATA/db`, so a fresh install needs no database,
 * no account and no settings.
 */
function connect(): Connection {
  const { DATABASE_URL, ZEENLY_OS_DATA } = env();
  if (DATABASE_URL) {
    // `prepare: false` keeps us compatible with transaction poolers.
    const client = postgres(DATABASE_URL, { prepare: false });
    return {
      db: drizzlePostgres(client, { schema }),
      info: { kind: "postgres", where: redact(DATABASE_URL) },
    };
  }
  const dir = `${ZEENLY_OS_DATA}/db`;
  mkdirSync(dir, { recursive: true });
  return {
    db: drizzlePglite(new PGlite(dir), { schema }),
    info: { kind: "embedded", where: dir },
  };
}

let instance: Connection | undefined;

/** Lazily connects on first use, so importing this module never needs env vars. */
export function db(): Database {
  return (instance ??= connect()).db;
}

/** Which database this is, for the first-run message and the status line. */
export function databaseInfo(): DatabaseInfo {
  return (instance ??= connect()).info;
}

/**
 * Applies the migrations `database` hasn't had yet, from the ones compiled
 * into the kernel. The app and the CLI call it as they start, so a new
 * install, or an upgrade, needs no separate step.
 */
export async function migrateDb(database: Database = db()): Promise<void> {
  // What drizzle's own migrate() does after reading the folder we don't have.
  // `dialect` and `session` are on every PgDatabase but marked internal, so
  // the types don't show them.
  const { dialect, session } = database as unknown as Migrator;
  await dialect.migrate(MIGRATIONS, session, { migrationsFolder: "bundled" });
}

type Migrator = {
  dialect: {
    migrate(
      migrations: MigrationMeta[],
      session: unknown,
      config: { migrationsFolder: string },
    ): Promise<void>;
  };
  session: unknown;
};

function redact(url: string): string {
  try {
    const u = new URL(url);
    u.password = "";
    u.username = "";
    return u.toString();
  } catch {
    return "postgres";
  }
}
