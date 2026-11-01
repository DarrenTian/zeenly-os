import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import { type Database } from "./db";
import { applyMigrations } from "./db/migrate";
import { MIGRATIONS } from "./db/migrations";
import * as schema from "./db/schema";
import { health } from "./health";
import { createTestDb } from "./test-db";

describe("health", () => {
  it("is ok on a migrated database", async () => {
    expect(await health(await createTestDb())).toEqual({
      ok: true,
      schema: "current",
    });
  });

  it("isn't while the database lacks migrations, and names them", async () => {
    const db = drizzle(new PGlite(), { schema });
    await applyMigrations(db, MIGRATIONS.slice(0, 1));
    expect(await health(db)).toEqual({
      ok: false,
      schema: "behind",
      missing: MIGRATIONS.slice(1).map((m) => m.tag),
    });
  });

  it("isn't when the database doesn't answer, without repeating the driver's message", async () => {
    const broken = {
      execute: () =>
        Promise.reject(
          Object.assign(new Error("connect to postgres://u:secret@h failed"), {
            code: "ECONNREFUSED",
          }),
        ),
    } as unknown as Database;
    const result = await health(broken);
    expect(result).toEqual({
      ok: false,
      schema: "unknown",
      error: "The database didn't answer (ECONNREFUSED)",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
