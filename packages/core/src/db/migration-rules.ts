/**
 * The rule that lets the previous kernel keep running while a new one
 * migrates (a deploy, several servers, a rollback): a migration only adds
 * (tables, nullable columns, indexes), so the previous kernel still runs on
 * a migrated database. What takes something away (a drop, a rename, a type
 * change, a new NOT NULL) waits for a later release, once no running
 * version needs what it removes, and says so: its first line is `-- contract`.
 * `scripts/check-migrations.ts` runs this in CI.
 */

/** The migrations before this rule; 0001 drops `units.charter`. */
const BEFORE_RULE = 2;

const TAKES_AWAY: { pattern: RegExp; what: string }[] = [
  { pattern: /\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA|VIEW)\b/i, what: "drops" },
  { pattern: /\bRENAME\b/i, what: "renames" },
  {
    pattern: /\bALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i,
    what: "changes a type",
  },
  { pattern: /\bSET\s+NOT\s+NULL\b/i, what: "sets NOT NULL" },
];

export type MigrationFile = {
  idx: number;
  tag: string;
  /** The journal's timestamp, which drizzle orders migrations by. */
  when: number;
  sql: string;
};

/** What's wrong with the migrations, one line each; empty when nothing is. */
export function checkMigrations(files: readonly MigrationFile[]): string[] {
  const problems: string[] = [];
  for (const [i, file] of files.entries()) {
    const previous = files[i - 1];
    // A database skips any migration older than its newest one, silently.
    if (previous && file.when <= previous.when) {
      problems.push(
        `${file.tag}: its timestamp is not after ${previous.tag}'s, so databases that have ${previous.tag} would skip it; regenerate it.`,
      );
    }
    if (file.idx < BEFORE_RULE) continue;
    if (/^\s*--\s*contract\b/i.test(file.sql)) continue;
    const sql = withoutComments(file.sql);
    for (const { pattern, what } of TAKES_AWAY) {
      if (pattern.test(sql)) {
        problems.push(
          `${file.tag} ${what}: the previous kernel, still running during an upgrade, would break. Only add in this release; take away in a later one, with \`-- contract\` as its first line.`,
        );
      }
    }
  }
  return problems;
}

function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}
