import { mkdirSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env";

import { applyMigrations, schemaStatus, type SchemaStatus } from "./migrate";
import { MIGRATIONS } from "./migrations";
import * as schema from "./schema";

/** Any Drizzle Postgres database with our schema: a server, the embedded one, or PGlite in tests. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type { KernelMigration, SchemaStatus } from "./migrate";

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
    // `prepare: false` keeps us compatible with transaction poolers;
    // `onnotice`: "already exists, skipping" from every migration check is noise.
    const client = postgres(DATABASE_URL, {
      prepare: false,
      onnotice: () => {},
    });
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

// One connection per process, kept on globalThis: a bundler (Next.js
// compiles this package once per route) can load this module more than
// once, and two copies would each open the embedded database, which allows
// one opener and would show each other stale rows.
const shared = globalThis as { __zeenlyOsDb?: Connection };

function connection(): Connection {
  return (shared.__zeenlyOsDb ??= connect());
}

/** Lazily connects on first use, so importing this module never needs env vars. */
export function db(): Database {
  return connection().db;
}

/** Which database this is, for the first-run message and the status line. */
export function databaseInfo(): DatabaseInfo {
  return connection().info;
}

/**
 * Applies the migrations `database` hasn't had yet, from the ones compiled
 * into the kernel, under a lock so processes starting together migrate it
 * once. The server calls it as it starts (unless
 * ZEENLY_OS_MIGRATE_ON_START=off), and `zeenly-os migrate` runs it on its
 * own. Returns the migrations it applied.
 */
export async function migrateDb(database: Database = db()): Promise<string[]> {
  return applyMigrations(database, MIGRATIONS);
}

/** Whether `database` has every migration this kernel carries. */
export async function checkSchema(
  database: Database = db(),
): Promise<SchemaStatus> {
  return schemaStatus(database, MIGRATIONS);
}

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
