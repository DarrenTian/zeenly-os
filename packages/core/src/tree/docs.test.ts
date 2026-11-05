import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import type { Actor } from "./actors";
import { unitView } from "./agenda";
import {
  DocConflictError,
  getUnitDoc,
  latestDocBodies,
  listUnitDocs,
  saveUnitDoc,
} from "./docs";
import { Forbidden } from "./errors";
import { listEvents } from "./events";
import { createUnit, deleteUnit, updateUnit } from "./units";

const FOUNDER: Actor = { kind: "human", id: "founder" };
const OTHER: Actor = { kind: "human", id: "someone" };
const MKT: Actor = { kind: "unit", id: "marketing" };

async function tree() {
  const db = await createTestDb();
  await createUnit(
    {
      id: "company",
      name: "Company",
      summary: "root",
      charter: "The whole company",
    },
    FOUNDER,
    {},
    db,
  );
  await createUnit(
    { id: "marketing", parentId: "company", name: "Marketing", summary: "x" },
    FOUNDER,
    {},
    db,
  );
  return db;
}

describe("a unit's documents", () => {
  it("are versioned: each save on the latest adds one, the same text adds none, a stale base conflicts", async () => {
    const db = await tree();
    expect(await listUnitDocs("marketing", db)).toEqual([]);
    const handbook = {
      unit: "marketing",
      name: "handbook",
      body: "One post, one language",
      reason: "First draft",
    };
    await saveUnitDoc({ ...handbook, baseVersion: 0 }, MKT, {}, db);
    // The same text again adds nothing, and leaves no change event.
    const before = (await listEvents({ unit: "marketing" }, db)).length;
    expect(
      (await saveUnitDoc({ ...handbook, baseVersion: 1 }, MKT, {}, db)).version,
    ).toBe(1);
    const after = await listEvents({ unit: "marketing" }, db);
    expect(after.length - before).toBe(1);
    expect(after[0].what).toBe("doc.unchanged");

    await saveUnitDoc(
      {
        ...handbook,
        body: "Write replies by hand",
        baseVersion: 1,
        reason: "Add a line",
      },
      FOUNDER,
      {},
      db,
    );
    await expect(
      saveUnitDoc({ ...handbook, body: "y", baseVersion: 1 }, MKT, {}, db),
    ).rejects.toThrow(DocConflictError);
    await expect(
      saveUnitDoc({ ...handbook, body: "y", baseVersion: 1 }, MKT, {}, db),
    ).rejects.toThrow(/version 2 now/);
    expect(
      (
        await getUnitDoc(
          { unit: "marketing", name: "handbook", version: 1 },
          db,
        )
      )?.body,
    ).toBe("One post, one language");
    expect(
      (await getUnitDoc({ unit: "marketing", name: "handbook" }, db))?.body,
    ).toBe("Write replies by hand");
    expect(
      (await unitView("marketing", db)).docs.map((d) => [
        d.name,
        d.version,
        d.author,
      ]),
    ).toEqual([["handbook", 2, "human:founder"]]);
    // A conflict rolls back: no version, no event.
    expect(
      (await listEvents({ unit: "marketing" }, db)).filter(
        (e) => e.what === "doc.saved",
      ),
    ).toHaveLength(2);
  });

  it("refuse an empty body, a missing reason or a bad name, and belong to a real unit", async () => {
    const db = await tree();
    const base = { unit: "marketing", baseVersion: 0 };
    await expect(
      saveUnitDoc(
        { ...base, name: "handbook", body: " ", reason: "r" },
        MKT,
        {},
        db,
      ),
    ).rejects.toThrow(/empty/);
    await expect(
      saveUnitDoc(
        { ...base, name: "handbook", body: "x", reason: " " },
        MKT,
        {},
        db,
      ),
    ).rejects.toThrow(/reason/);
    await expect(
      saveUnitDoc(
        { ...base, name: "Hand Book", body: "x", reason: "r" },
        MKT,
        {},
        db,
      ),
    ).rejects.toThrow(/name is/);
    await expect(
      saveUnitDoc(
        { ...base, unit: "nope", name: "handbook", body: "x", reason: "r" },
        FOUNDER,
        {},
        db,
      ),
    ).rejects.toThrow(/No unit "nope"/);
    expect(await getUnitDoc({ unit: "marketing", name: "handbook" }, db)).toBe(
      null,
    );
  });

  it("leave the charter and guidelines to the unit's person", async () => {
    const db = await tree();
    for (const name of ["charter", "guidelines"]) {
      await expect(
        saveUnitDoc(
          { unit: "marketing", name, body: "x", baseVersion: 0, reason: "r" },
          MKT,
          {},
          db,
        ),
      ).rejects.toThrow(Forbidden);
      await expect(
        saveUnitDoc(
          { unit: "marketing", name, body: "x", baseVersion: 0, reason: "r" },
          OTHER,
          {},
          db,
        ),
      ).rejects.toThrow(/Only marketing's person/);
    }
    await saveUnitDoc(
      {
        unit: "marketing",
        name: "charter",
        body: "Owns what we say outside",
        baseVersion: 0,
        reason: "Set the charter",
      },
      FOUNDER,
      {},
      db,
    );
    expect((await unitView("marketing", db)).charter).toBe(
      "Owns what we say outside",
    );
    expect(Object.fromEntries(await latestDocBodies("charter", db))).toEqual({
      company: "The whole company",
      marketing: "Owns what we say outside",
    });
  });
});

describe("deleting a unit", () => {
  it("is refused once it has units below it or a history of its own", async () => {
    const db = await tree();
    await expect(deleteUnit("company", FOUNDER, {}, db)).rejects.toThrow(
      /Move the units under/,
    );
    await saveUnitDoc(
      {
        unit: "marketing",
        name: "notes",
        body: "x",
        baseVersion: 0,
        reason: "r",
      },
      MKT,
      {},
      db,
    );
    // Moved to the root, it keeps a person: the one who moved it.
    const moved = await updateUnit(
      "marketing",
      { parentId: null },
      FOUNDER,
      {},
      db,
    );
    expect(moved.owner).toBe("founder");
    await expect(deleteUnit("marketing", FOUNDER, {}, db)).rejects.toThrow(
      /has a history/,
    );
    // company has a charter, which is history too.
    await expect(deleteUnit("company", FOUNDER, {}, db)).rejects.toThrow(
      /has a history/,
    );
    await createUnit({ id: "empty", name: "x", summary: "x" }, FOUNDER, {}, db);
    await deleteUnit("empty", FOUNDER, {}, db);
    expect(
      (await listEvents({ unit: "empty" }, db)).map((e) => e.what),
    ).toEqual(["unit.deleted", "unit.created"]);
  });
});
