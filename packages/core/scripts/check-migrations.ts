/**
 * CI's check that migrations keep the rule in src/db/migration-rules.ts:
 * in order, and only adding unless marked `-- contract`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { checkMigrations } from "../src/db/migration-rules";

const root = fileURLToPath(new URL("..", import.meta.url));
const journal = JSON.parse(
  readFileSync(`${root}/drizzle/meta/_journal.json`, "utf8"),
) as { entries: { idx: number; tag: string; when: number }[] };
const problems = checkMigrations(
  journal.entries.map((e) => ({
    ...e,
    sql: readFileSync(`${root}/drizzle/${e.tag}.sql`, "utf8"),
  })),
);
for (const p of problems) console.error(p);
if (problems.length > 0) process.exit(1);
console.log(`${journal.entries.length} migrations keep the rule`);
