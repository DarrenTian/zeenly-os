import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import * as schema from "./db/schema";

/**
 * A fresh in-memory Postgres with every migration applied. Exported as
 * `@zeenly-os/core/testing` for other packages' tests.
 */
export async function createTestDb() {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  return db;
}
