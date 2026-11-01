import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import type { Database } from ".";
import { applyMigrations, schemaStatus } from "./migrate";
import { MIGRATIONS } from "./migrations";
import * as schema from "./schema";

const fresh = (): Database => drizzlePglite(new PGlite(), { schema });

async function appliedCount(database: Database): Promise<number> {
  const result = (await database.execute(
    sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
  )) as unknown as { rows?: { n: number }[] } & { n: number }[];
  return (result.rows ?? result)[0].n;
}

describe("migrating", () => {
  it("applies every migration once and says which", async () => {
    const db = fresh();
    expect(await applyMigrations(db, MIGRATIONS)).toEqual(
      MIGRATIONS.map((m) => m.tag),
    );
    expect(await applyMigrations(db, MIGRATIONS)).toEqual([]);
    expect(await appliedCount(db)).toBe(MIGRATIONS.length);
  });

  it("picks up where a database left off", async () => {
    const db = fresh();
    await applyMigrations(db, MIGRATIONS.slice(0, 1));
    expect(await applyMigrations(db, MIGRATIONS)).toEqual(
      MIGRATIONS.slice(1).map((m) => m.tag),
    );
  });

  it("migrates once when two callers start together", async () => {
    const db = fresh();
    const [a, b] = await Promise.all([
      applyMigrations(db, MIGRATIONS),
      applyMigrations(db, MIGRATIONS),
    ]);
    expect([...a, ...b]).toEqual(MIGRATIONS.map((m) => m.tag));
    expect(await appliedCount(db)).toBe(MIGRATIONS.length);
  });
});

describe("schema status", () => {
  it("is behind on a database never migrated, with everything missing", async () => {
    expect(await schemaStatus(fresh(), MIGRATIONS)).toEqual({
      state: "behind",
      missing: MIGRATIONS.map((m) => m.tag),
    });
  });

  it("is behind by what a database hasn't had", async () => {
    const db = fresh();
    await applyMigrations(db, MIGRATIONS.slice(0, 1));
    expect(await schemaStatus(db, MIGRATIONS)).toEqual({
      state: "behind",
      missing: MIGRATIONS.slice(1).map((m) => m.tag),
    });
  });

  it("is current once migrated", async () => {
    const db = fresh();
    await applyMigrations(db, MIGRATIONS);
    expect(await schemaStatus(db, MIGRATIONS)).toEqual({ state: "current" });
  });

  it("is ahead when a newer kernel has migrated it", async () => {
    const db = fresh();
    await applyMigrations(db, MIGRATIONS);
    expect(await schemaStatus(db, MIGRATIONS.slice(0, 1))).toEqual({
      state: "ahead",
    });
  });
});

// The lock matters on a real server, where two processes hold two
// connections; CI has one, a laptop usually doesn't.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("migrating on a Postgres server", () => {
  it("migrates once when two processes start together", async () => {
    const admin = postgres(url!, { max: 1 });
    const name = `migrate_test_${Date.now()}`;
    await admin.unsafe(`create database ${name}`);
    const target = new URL(url!);
    target.pathname = `/${name}`;
    const clients = [0, 1].map(() =>
      postgres(target.toString(), { max: 1, onnotice: () => {} }),
    );
    try {
      const [one, two] = clients.map((c) =>
        drizzlePostgres(c, { schema }),
      ) as Database[];
      const [a, b] = await Promise.all([
        applyMigrations(one, MIGRATIONS),
        applyMigrations(two, MIGRATIONS),
      ]);
      expect([...a, ...b].sort()).toEqual(MIGRATIONS.map((m) => m.tag).sort());
      expect(await appliedCount(one)).toBe(MIGRATIONS.length);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
      await admin.unsafe(`drop database ${name}`);
      await admin.end();
    }
  });
});
