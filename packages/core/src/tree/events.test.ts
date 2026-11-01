import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import { migrateDb } from "../db";
import { applyMigrations } from "../db/migrate";
import { MIGRATIONS } from "../db/migrations";
import * as schema from "../db/schema";

import { createTestDb } from "../test-db";
import type { Actor } from "./actors";
import { SchemaBehind } from "./errors";
import { issueDirective, translateDirective } from "./directives";
import { listEvents, write } from "./events";
import { addTask } from "./tasks";
import { createUnit, listUnits } from "./units";

const FOUNDER: Actor = { kind: "human", id: "founder" };
const ENG: Actor = { kind: "unit", id: "eng" };
const T0 = new Date("2026-10-31T09:00:00Z");

describe("events", () => {
  it("record every change with who made it, what it was about and what it served", async () => {
    const db = await createTestDb();
    await createUnit(
      { id: "company", name: "Company", summary: "公司" },
      FOUNDER,
      { now: T0 },
      db,
    );
    await createUnit(
      { id: "eng", parentId: "company", name: "工程", summary: "x" },
      FOUNDER,
      { now: T0 },
      db,
    );
    const d = await issueDirective(
      { from: "company", to: ["eng"], title: "x", doneWhen: "y" },
      FOUNDER,
      { now: T0 },
      db,
    );
    await translateDirective(
      { directive: d.id, unit: "eng", translation: "z" },
      ENG,
      { now: T0 },
      db,
    );
    const t = await addTask(
      { unit: "eng", title: "do", directive: d.id },
      ENG,
      { now: T0 },
      db,
    );

    const eng = await listEvents({ unit: "eng" }, db);
    expect(
      eng.map((e) => [e.what, `${e.actorKind}:${e.actorId}`, e.onKind, e.why]),
    ).toEqual([
      ["task.added", "unit:eng", "task", `directive:${d.id}`],
      ["directive.translated", "unit:eng", "assignment", `directive:${d.id}`],
      ["unit.created", "human:founder", "unit", null],
    ]);
    expect(eng[0].onId).toBe(String(t.id));
    expect(eng[0].at).toEqual(T0);
    expect((eng[1].before as { state: string }).state).toBe("new");
    expect((eng[1].after as { state: string }).state).toBe("proposed");

    const all = await listEvents({}, db);
    expect(all.map((e) => e.what)).toEqual([
      "task.added",
      "directive.translated",
      "directive.issued",
      "unit.created",
      "unit.created",
    ]);
    expect(
      (await listEvents({ before: all[1].id, limit: 2 }, db)).map(
        (e) => e.what,
      ),
    ).toEqual(["directive.issued", "unit.created"]);
  });

  it("write a change and its event together, or neither", async () => {
    const db = await createTestDb();
    await createUnit(
      { id: "company", name: "Company", summary: "公司" },
      FOUNDER,
      {},
      db,
    );
    await expect(
      write(
        db,
        FOUNDER,
        async () => {
          throw new Error("boom");
        },
        () => ({ what: "x", on: { kind: "x", id: 1 } }),
      ),
    ).rejects.toThrow("boom");
    expect((await listEvents({}, db)).map((e) => e.what)).toEqual([
      "unit.created",
    ]);
    // A change `apply` makes is kept only with its event.
    await expect(
      write(
        db,
        FOUNDER,
        async (tx) => {
          await createUnit(
            { id: "ghost", name: "x", summary: "x" },
            FOUNDER,
            {},
            tx,
          );
          throw new Error("undo");
        },
        () => ({ what: "x", on: { kind: "x", id: 1 } }),
      ),
    ).rejects.toThrow("undo");
    expect((await listUnits(db)).map((u) => u.id)).toEqual(["company"]);
  });
});

describe("writing on a database behind the code", () => {
  it("is refused until it's migrated, while reading carries on", async () => {
    const db = drizzle(new PGlite(), { schema });
    await applyMigrations(db, MIGRATIONS.slice(0, 1));
    await expect(
      createUnit(
        { id: "company", name: "Company", summary: "x" },
        FOUNDER,
        { now: T0 },
        db,
      ),
    ).rejects.toThrow(SchemaBehind);
    expect(await listUnits(db)).toEqual([]);
    await migrateDb(db);
    await createUnit(
      { id: "company", name: "Company", summary: "x" },
      FOUNDER,
      { now: T0 },
      db,
    );
    expect((await listUnits(db)).map((u) => u.id)).toEqual(["company"]);
  });

  it("goes ahead on a database a newer kernel has migrated", async () => {
    const db = await createTestDb();
    await db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('newer', ${Date.now() * 2})`,
    );
    await createUnit(
      { id: "company", name: "Company", summary: "x" },
      FOUNDER,
      { now: T0 },
      db,
    );
    expect((await listUnits(db)).map((u) => u.id)).toEqual(["company"]);
  });
});
