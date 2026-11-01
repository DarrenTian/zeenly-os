import { describe, expect, it } from "vitest";

import { checkMigrations, type MigrationFile } from "./migration-rules";

const BASE: MigrationFile[] = [
  { idx: 0, tag: "0000_tree", when: 1, sql: "CREATE TABLE a (id int);" },
  { idx: 1, tag: "0001_old", when: 2, sql: 'ALTER TABLE "a" DROP COLUMN "x";' },
];
const next = (sql: string, when = 3): MigrationFile[] => [
  ...BASE,
  { idx: 2, tag: "0002_new", when, sql },
];

describe("migration rules", () => {
  it("let a migration add tables, nullable columns and indexes", () => {
    expect(
      checkMigrations(
        next(
          'CREATE TABLE "b" (id int);\nALTER TABLE "a" ADD COLUMN "y" text;\nCREATE INDEX "i" ON "a" ("y");',
        ),
      ),
    ).toEqual([]);
  });

  it("leave the migrations from before the rule alone", () => {
    expect(checkMigrations(BASE)).toEqual([]);
  });

  it.each([
    ['ALTER TABLE "a" DROP COLUMN "y";', "drops"],
    ['DROP TABLE "b";', "drops"],
    ['ALTER TABLE "a" RENAME COLUMN "y" TO "z";', "renames"],
    [
      'ALTER TABLE "a" ALTER COLUMN "y" SET DATA TYPE integer;',
      "changes a type",
    ],
    ['ALTER TABLE "a" ALTER COLUMN "y" SET NOT NULL;', "sets NOT NULL"],
  ])("refuse one that takes away: %s", (sql, what) => {
    const problems = checkMigrations(next(sql));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`0002_new ${what}`);
  });

  it("let a migration take away when it says it's a contract", () => {
    expect(
      checkMigrations(next('-- contract\nALTER TABLE "a" DROP COLUMN "y";')),
    ).toEqual([]);
  });

  it("don't count a comment that mentions a drop", () => {
    expect(
      checkMigrations(
        next(
          '-- we will DROP COLUMN y later\nALTER TABLE "a" ADD COLUMN "z" text;',
        ),
      ),
    ).toEqual([]);
  });

  it("refuse a migration dated before the one it follows", () => {
    const problems = checkMigrations(next('CREATE TABLE "b" (id int);', 2));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("would skip it");
  });
});
