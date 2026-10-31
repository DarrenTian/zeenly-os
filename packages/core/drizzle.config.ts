import { existsSync } from "node:fs";

import { defineConfig } from "drizzle-kit";

// One .env at the repo root serves every app and this package.
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
