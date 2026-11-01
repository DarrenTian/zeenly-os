/**
 * Migrating the database, and knowing whether it has been.
 *
 * Several processes can start on one database at once (serverless cold
 * starts, a deploy job beside a running server), so migrating takes a lock
 * first. Which migrations a database has had is drizzle's own record,
 * `drizzle.__drizzle_migrations`, so databases migrated before this module
 * existed carry on where they were.
 */

import { sql } from "drizzle-orm";
import type { MigrationMeta } from "drizzle-orm/migrator";

import type { Database } from ".";

/** A migration as the kernel carries it: drizzle's, with its file's name. */
export type KernelMigration = MigrationMeta & { tag: string };

// Any fixed number: every process migrating this kernel's schema agrees on it.
const LOCK = 7_244_018_313;

/**
 * Applies the migrations `database` hasn't had, all in one transaction that
 * first takes a transaction-level advisory lock: a second process waits,
 * then finds nothing left to do. A transaction-level lock, unlike a session
 * one, stays on the connection the transaction holds, so it works through
 * a pool. Returns the tags it applied.
 */
export async function applyMigrations(
  database: Database,
  migrations: readonly KernelMigration[],
): Promise<string[]> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    await tx.execute(sql`create schema if not exists drizzle`);
    await tx.execute(sql`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);
    const last = await lastApplied(tx);
    const applied: string[] = [];
    // Like drizzle's own migrator: anything newer than the last one applied.
    for (const m of migrations) {
      if (last !== null && m.folderMillis <= last) continue;
      for (const statement of m.sql) await tx.execute(sql.raw(statement));
      await tx.execute(
        sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`,
      );
      applied.push(m.tag);
    }
    return applied;
  });
}

/**
 * Where a database stands against the code: `current`; `behind`, with the
 * migrations it still needs; or `ahead`, migrated by a newer kernel while
 * this one still runs, which the expand-then-contract rule keeps safe.
 */
export type SchemaStatus =
  | { state: "current" }
  | { state: "behind"; missing: string[] }
  | { state: "ahead" };

export async function schemaStatus(
  database: Database,
  migrations: readonly KernelMigration[],
): Promise<SchemaStatus> {
  const last = await lastApplied(database);
  const missing = migrations
    .filter((m) => last === null || m.folderMillis > last)
    .map((m) => m.tag);
  if (missing.length > 0) return { state: "behind", missing };
  const newest = migrations.at(-1)?.folderMillis ?? 0;
  return last !== null && last > newest
    ? { state: "ahead" }
    : { state: "current" };
}

/** The newest applied migration's timestamp, or null on a database never migrated. */
async function lastApplied(database: Database): Promise<number | null> {
  const [exists] = await rows<{ table: string | null }>(
    database,
    sql`select to_regclass('drizzle.__drizzle_migrations')::text as table`,
  );
  if (!exists?.table) return null;
  const [row] = await rows<{ created_at: string | number | null }>(
    database,
    sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
  );
  return row?.created_at == null ? null : Number(row.created_at);
}

/** `execute`'s rows: postgres.js returns an array, PGlite `{ rows }`. */
async function rows<T>(
  database: Database,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = (await database.execute(query)) as unknown;
  return Array.isArray(result)
    ? (result as T[])
    : ((result as { rows: T[] }).rows ?? []);
}
