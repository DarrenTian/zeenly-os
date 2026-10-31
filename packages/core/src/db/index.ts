import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";

import { env } from "../env";

import * as schema from "./schema";

/** Any Drizzle Postgres database with our schema: the real one, or PGlite in tests. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

function connect() {
  // `prepare: false` keeps us compatible with Supabase's transaction pooler.
  const client = postgres(env().DATABASE_URL, { prepare: false });
  return drizzle(client, { schema });
}

let instance: ReturnType<typeof connect> | undefined;

/** Lazily connects on first use, so importing this module never needs env vars. */
export function db() {
  instance ??= connect();
  return instance;
}
