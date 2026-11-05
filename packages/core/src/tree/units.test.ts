import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import type { Actor } from "./actors";
import { getUnitDoc } from "./docs";
import { Forbidden } from "./errors";
import {
  ancestors,
  createUnit,
  descendants,
  listUnits,
  personOf,
  TreeError,
  updateUnit,
} from "./units";

const FOUNDER: Actor = { kind: "human", id: "founder" };
const OTHER: Actor = { kind: "human", id: "someone" };
const AGENT: Actor = { kind: "unit", id: "eng" };

describe("units", () => {
  it("grows a tree with no fixed root, owners inherited from above", async () => {
    const db = await createTestDb();
    // A technical founder may start with nothing but engineering.
    await createUnit(
      { id: "engineering", name: "Engineering", summary: "Builds the product" },
      FOUNDER,
      {},
      db,
    );
    await createUnit(
      {
        id: "frontend",
        parentId: "engineering",
        name: "Frontend",
        summary: "Pages",
      },
      FOUNDER,
      {},
      db,
    );
    // Later the company grows above it.
    await createUnit(
      { id: "company", name: "Company", summary: "The company" },
      FOUNDER,
      {},
      db,
    );
    await updateUnit(
      "engineering",
      { parentId: "company", owner: null },
      FOUNDER,
      {},
      db,
    );

    const all = await listUnits(db);
    expect(ancestors(all, "frontend").map((u) => u.id)).toEqual([
      "engineering",
      "company",
    ]);
    expect(descendants(all, "company").map((u) => u.id)).toEqual([
      "engineering",
      "frontend",
    ]);
    // A root's owner is whoever created it; the units below inherit it.
    expect(personOf(all, "frontend")).toBe("founder");
    expect(all.find((u) => u.id === "frontend")?.mode).toBe("steer");
  });

  it("keeps the charter as the unit's first document", async () => {
    const db = await createTestDb();
    await createUnit(
      {
        id: "eng",
        name: "Engineering",
        summary: "x",
        charter: "## Owns\nCode",
      },
      FOUNDER,
      {},
      db,
    );
    const charter = await getUnitDoc({ unit: "eng", name: "charter" }, db);
    expect([charter?.version, charter?.body, charter?.author]).toEqual([
      1,
      "## Owns\nCode",
      "human:founder",
    ]);
  });

  it("refuses bad ids, duplicates, unknown parents and cycles", async () => {
    const db = await createTestDb();
    await createUnit(
      { id: "company", name: "Company", summary: "The company" },
      FOUNDER,
      {},
      db,
    );
    await createUnit(
      { id: "eng", parentId: "company", name: "Engineering", summary: "x" },
      FOUNDER,
      {},
      db,
    );
    await expect(
      createUnit({ id: "Eng", name: "x", summary: "x" }, FOUNDER, {}, db),
    ).rejects.toThrow(TreeError);
    await expect(
      createUnit({ id: "eng", name: "x", summary: "x" }, FOUNDER, {}, db),
    ).rejects.toThrow(/already/);
    await expect(
      createUnit(
        { id: "ux", parentId: "nope", name: "x", summary: "x" },
        FOUNDER,
        {},
        db,
      ),
    ).rejects.toThrow(/No unit "nope"/);
    await expect(
      updateUnit("company", { parentId: "eng" }, FOUNDER, {}, db),
    ).rejects.toThrow(/own subtree/);
  });

  it("lets only a person shape the tree, and only under units they steer", async () => {
    const db = await createTestDb();
    await createUnit(
      { id: "company", name: "Company", summary: "The company" },
      FOUNDER,
      {},
      db,
    );
    await expect(
      createUnit(
        { id: "eng", parentId: "company", name: "x", summary: "x" },
        AGENT,
        {},
        db,
      ),
    ).rejects.toThrow(Forbidden);
    await expect(
      createUnit(
        { id: "eng", parentId: "company", name: "x", summary: "x" },
        OTHER,
        {},
        db,
      ),
    ).rejects.toThrow(/Only company's person adds units under it/);
    // Anyone may start a tree of their own, and then steers it.
    await createUnit({ id: "acme", name: "Acme", summary: "x" }, OTHER, {}, db);
    expect(personOf(await listUnits(db), "acme")).toBe("someone");
    await expect(
      updateUnit("acme", { name: "y" }, FOUNDER, {}, db),
    ).rejects.toThrow(/Only acme's person changes it/);
  });
});
