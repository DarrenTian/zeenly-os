import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const schema = z.object({
  /** A Postgres to use instead of the embedded database. */
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .transform(dropClientOnlyParams)
    .optional(),
  /** Where the embedded database, logs and settings live. */
  ZEENLY_OS_DATA: z.string().trim().min(1).optional(),
});

export type Env = {
  DATABASE_URL: string | undefined;
  ZEENLY_OS_DATA: string;
};

/**
 * Reads the few settings there are. Nothing is required: without
 * `DATABASE_URL` the kernel keeps its data in an embedded database under
 * `ZEENLY_OS_DATA`, `~/.zeenly-os` by default. Throws listing every invalid
 * key.
 *
 * Vercel's Neon integration may name the connection string with a prefix
 * (`STORAGE_DATABASE_URL`); it's used when `DATABASE_URL` isn't set.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse({
    DATABASE_URL:
      source.DATABASE_URL || source.STORAGE_DATABASE_URL || undefined,
    ZEENLY_OS_DATA: source.ZEENLY_OS_DATA || undefined,
  });
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${problems}`);
  }
  return {
    DATABASE_URL: result.data.DATABASE_URL,
    ZEENLY_OS_DATA: result.data.ZEENLY_OS_DATA ?? join(homedir(), ".zeenly-os"),
  };
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/**
 * libpq options that only the client understands. Neon adds
 * `channel_binding=require` to its URLs; postgres.js would send it to the
 * server as a startup parameter, which the server rejects.
 */
const CLIENT_ONLY_PARAMS = ["channel_binding"];

function dropClientOnlyParams(value: string): string {
  const url = new URL(value);
  for (const name of CLIENT_ONLY_PARAMS) url.searchParams.delete(name);
  return url.toString();
}
