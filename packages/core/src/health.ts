/**
 * Whether this server can do its work: the database answers and has every
 * migration the code needs. For a deploy to check before it moves on, and
 * for a monitor. It says nothing about the company, so it needs no token.
 */

import { checkSchema, db as defaultDb, type Database } from "./db";

export type Health =
  | { ok: true; schema: "current" | "ahead" }
  | { ok: false; schema: "behind"; missing: string[] }
  | { ok: false; schema: "unknown"; error: string };

export async function health(
  database: Database = defaultDb(),
): Promise<Health> {
  try {
    const status = await checkSchema(database);
    return status.state === "behind"
      ? { ok: false, schema: "behind", missing: status.missing }
      : { ok: true, schema: status.state };
  } catch (err) {
    // The connection string can sit in a driver's message; say only what failed.
    const code = (err as { code?: string }).code;
    return {
      ok: false,
      schema: "unknown",
      error: `The database didn't answer${code ? ` (${code})` : ""}`,
    };
  }
}
