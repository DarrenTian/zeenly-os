import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .transform(dropClientOnlyParams),
});

export type Env = z.infer<typeof schema>;

/**
 * Validates server env vars. Throws listing every missing or invalid key.
 *
 * Vercel's Neon integration may name the connection string with a prefix
 * (`STORAGE_DATABASE_URL`); it's used when `DATABASE_URL` isn't set.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse({
    ...source,
    DATABASE_URL: source.DATABASE_URL || source.STORAGE_DATABASE_URL,
  });
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${problems}`);
  }
  return result.data;
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
